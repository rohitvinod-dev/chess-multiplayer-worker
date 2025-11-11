import {
  type Connection,
  Server,
  type WSMessage,
} from "partyserver";

import type {
  GameMode,
  PlayerColor,
  GameStatus,
  Move,
  GameState,
  PlayerInfo,
  Clock,
  GameMessage,
} from "../shared";

interface PlayerSession {
  id: string;
  displayName: string;
  rating: number;
  isProvisional: boolean;
  color: PlayerColor;
  connection?: Connection;
  lastSeen: number;
  connected: boolean;
}

// Define Env type for GameRoom
interface GameRoomEnv {
  GAME_ROOM: DurableObjectNamespace;
  MATCHMAKING_QUEUE: DurableObjectNamespace;
  ASSETS: Fetcher;
}

export class GameRoom extends Server<GameRoomEnv> {
  static options = { hibernate: true };

  // Game configuration
  gameMode: GameMode = "blitz";
  gameStatus: GameStatus = "waiting";
  stateVersion: number = 0;

  // Players
  players: Map<string, PlayerSession> = new Map();

  // Game state
  gameState: GameState = {
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    moves: [],
  };

  clock: Clock = {
    white: { remaining: 180000, increment: 1000 },
    black: { remaining: 180000, increment: 1000 },
    lastUpdate: Date.now(),
    currentTurn: "white",
  };

  // Timers
  clockIntervalId?: number;
  abandonmentTimeoutId?: number;
  moveTimeoutId?: number;

  onStart() {
    // Game state initialized with defaults
    // No async loading in onStart for PartyKit Server
  }

  onConnect(connection: Connection, ctx: any) {
    const playerId = ctx.request.headers.get("x-player-id");
    const displayName = ctx.request.headers.get("x-display-name");
    const rating = parseInt(ctx.request.headers.get("x-rating") || "1200");
    const isProvisional =
      ctx.request.headers.get("x-is-provisional") === "true";

    if (!playerId) {
      connection.close(1002, "Missing player ID");
      return;
    }

    const playerColor =
      this.players.size === 0 ? "white" : "black";

    const session: PlayerSession = {
      id: playerId,
      displayName: displayName || `Player-${playerId.slice(0, 6)}`,
      rating,
      isProvisional,
      color: playerColor,
      connection,
      lastSeen: Date.now(),
      connected: true,
    };

    this.players.set(playerId, session);

    // If both players connected, start the game
    if (this.players.size === 2) {
      this.startGame();
    }

    // Send ready message to connected player
    const otherPlayer = Array.from(this.players.values()).find(
      (p) => p.id !== playerId && p.connected
    );

    if (otherPlayer) {
      this.sendReadyMessage(session, otherPlayer);
    }
  }

  onMessage(connection: Connection, message: WSMessage) {
    try {
      const data = JSON.parse(message as string) as any;

      if (data.type === "ping") {
        connection.send(JSON.stringify({ type: "pong" }));
        return;
      }

      // Cast to GameMessage after handling ping
      const gameMessage = data as GameMessage;

      // Find which player sent this message
      let sendingPlayer: PlayerSession | undefined;
      for (const player of this.players.values()) {
        if (player.connection === connection) {
          sendingPlayer = player;
          break;
        }
      }

      if (!sendingPlayer) {
        connection.close(1002, "Player not found");
        return;
      }

      sendingPlayer.lastSeen = Date.now();
      sendingPlayer.connected = true;

      switch (gameMessage.type) {
        case "move":
          this.handleMove(sendingPlayer, (gameMessage as any).move);
          break;
        case "resign":
          this.handleResign(sendingPlayer);
          break;
        case "chat":
          this.handleChat(
            sendingPlayer,
            (gameMessage as any).message
          );
          break;
      }
    } catch (error) {
      console.error("Error handling message:", error);
    }
  }

  onClose(connection: Connection) {
    // Mark player as disconnected
    for (const player of this.players.values()) {
      if (player.connection === connection) {
        player.connected = false;
        player.connection = undefined;

        // Notify other player
        const otherPlayer = Array.from(this.players.values()).find(
          (p) => p.id !== player.id
        );
        if (otherPlayer?.connection) {
          otherPlayer.connection.send(
            JSON.stringify({
              type: "opponent_status",
              connected: false,
              lastSeen: Date.now(),
            } as GameMessage)
          );
        }

        // If game is active and player disconnects for 10 seconds, abandon
        if (this.gameStatus === "playing") {
          this.abandonmentTimeoutId = setTimeout(() => {
            if (!player.connected) {
              this.endGame(
                player.color === "white" ? "black_win" : "white_win",
                "opponent_abandoned"
              );
            }
          }, 10000) as unknown as number;
        }
        break;
      }
    }
  }

  private startGame() {
    this.gameStatus = "ready";
    const players = Array.from(this.players.values());

    if (players.length !== 2) return;

    // Set clock based on game mode
    this.setClock(this.gameMode);

    // Start clock interval
    this.startClockInterval();

    // Send ready message to both players
    const [white, black] = players.sort(
      (a) => (a.color === "white" ? -1 : 1)
    );

    this.sendReadyMessage(white, black);
    this.sendReadyMessage(black, white);

    this.gameStatus = "playing";
  }

  private handleMove(player: PlayerSession, move: Move) {
    if (this.gameStatus !== "playing") {
      player.connection?.send(
        JSON.stringify({
          type: "error",
          code: "game_not_playing",
          message: "Game is not currently playing",
        } as GameMessage)
      );
      return;
    }

    // Verify it's player's turn
    const isWhiteTurn = this.clock.currentTurn === "white";
    if (player.color !== this.clock.currentTurn) {
      player.connection?.send(
        JSON.stringify({
          type: "error",
          code: "not_your_turn",
          message: "It is not your turn",
        } as GameMessage)
      );
      return;
    }

    // Add move to game state
    this.gameState.moves.push({
      move,
      timestamp: Date.now(),
    });

    this.stateVersion++;

    // Update FEN (simplified - just update turn for now)
    const lastMoveIndex = this.gameState.moves.length - 1;
    this.gameState.fen = this.updateFen(move, isWhiteTurn);

    // Switch turn
    this.clock.currentTurn = isWhiteTurn ? "black" : "white";
    this.clock.lastUpdate = Date.now();

    // Apply increment
    if (isWhiteTurn) {
      this.clock.white.remaining += this.clock.white.increment;
    } else {
      this.clock.black.remaining += this.clock.black.increment;
    }

    // Save state
    this.saveGameState();

    // Send move to both players
    const moveMessage: GameMessage = {
      type: "move",
      move,
      gameState: this.gameState,
      clock: this.clock,
      stateVersion: this.stateVersion,
    };

    for (const p of this.players.values()) {
      if (p.connected && p.connection) {
        p.connection.send(JSON.stringify(moveMessage));
      }
    }

    // Check for game end conditions
    this.checkGameEnd();
  }

  private handleResign(player: PlayerSession) {
    if (this.gameStatus !== "playing") return;

    const result =
      player.color === "white" ? "black_win" : "white_win";
    this.endGame(result, "resignation");
  }

  private handleChat(player: PlayerSession, message: string) {
    const chatMessage: GameMessage = {
      type: "chat",
      playerId: player.id,
      displayName: player.displayName,
      message: message.slice(0, 500), // Limit message length
      timestamp: Date.now(),
    };

    for (const p of this.players.values()) {
      if (p.connected && p.connection) {
        p.connection.send(JSON.stringify(chatMessage));
      }
    }
  }

  private startClockInterval() {
    const intervalMs = 100; // Update every 100ms
    this.clockIntervalId = setInterval(() => {
      if (this.gameStatus !== "playing") return;

      const now = Date.now();
      const elapsed = now - this.clock.lastUpdate;

      if (this.clock.currentTurn === "white") {
        this.clock.white.remaining -= elapsed;
        if (this.clock.white.remaining <= 0) {
          this.endGame("black_win", "timeout");
        }
      } else {
        this.clock.black.remaining -= elapsed;
        if (this.clock.black.remaining <= 0) {
          this.endGame("white_win", "timeout");
        }
      }

      this.clock.lastUpdate = now;

      // Broadcast clock update
      const clockUpdate: GameMessage = {
        type: "clock_update",
        clock: this.clock,
      };

      for (const p of this.players.values()) {
        if (p.connected && p.connection) {
          p.connection.send(JSON.stringify(clockUpdate));
        }
      }
    }, intervalMs) as unknown as number;
  }

  private setClock(gameMode: GameMode) {
    switch (gameMode) {
      case "blitz":
        this.clock.white = { remaining: 180000, increment: 1000 }; // 3+1
        this.clock.black = { remaining: 180000, increment: 1000 };
        break;
      case "rapid":
        this.clock.white = { remaining: 600000, increment: 5000 }; // 10+5
        this.clock.black = { remaining: 600000, increment: 5000 };
        break;
      case "classical":
        this.clock.white = { remaining: 1800000, increment: 15000 }; // 30+15
        this.clock.black = { remaining: 1800000, increment: 15000 };
        break;
    }
  }

  private updateFen(move: Move, isWhite: boolean): string {
    // Simplified FEN update - in production, use chess.js or similar
    // Just toggle the turn indicator for now
    const parts = this.gameState.fen.split(" ");
    parts[1] = isWhite ? "b" : "w"; // Toggle turn
    return parts.join(" ");
  }

  private checkGameEnd() {
    // Simplified check - in production, use chess.js to detect checkmate, stalemate
    // For now, just allow the game to continue until resignation or timeout
  }

  private endGame(result: string, reason: string) {
    if (this.gameStatus === "finished") return;

    this.gameStatus = "finished";
    this.gameState.result = result as any;
    this.gameState.resultReason = reason;

    // Stop timers
    if (this.clockIntervalId) clearInterval(this.clockIntervalId);
    if (this.abandonmentTimeoutId)
      clearTimeout(this.abandonmentTimeoutId);
    if (this.moveTimeoutId) clearTimeout(this.moveTimeoutId);

    // Save final state
    this.saveGameState();

    // Notify players
    const endMessage: GameMessage = {
      type: "system",
      message: `Game ended: ${result} (${reason})`,
      code: "game_ended",
    };

    for (const p of this.players.values()) {
      if (p.connected && p.connection) {
        p.connection.send(JSON.stringify(endMessage));
      }
    }

    // Send game state with result to both players
    const finalStateMessage: GameMessage = {
      type: "state",
      gameState: this.gameState,
      stateVersion: this.stateVersion,
    };

    for (const p of this.players.values()) {
      if (p.connected && p.connection) {
        p.connection.send(JSON.stringify(finalStateMessage));
      }
    }
  }

  private sendReadyMessage(
    player: PlayerSession,
    opponent: PlayerSession
  ) {
    if (!player.connection) return;

    const readyMessage: GameMessage = {
      type: "ready",
      gameState: this.gameState,
      clock: this.clock,
      playerInfo: {
        id: player.id,
        displayName: player.displayName,
        rating: player.rating,
        isProvisional: player.isProvisional,
      },
      opponentId: opponent.id,
      opponentDisplayName: opponent.displayName,
      opponentRating: opponent.rating,
      opponentIsProvisional: opponent.isProvisional,
    };

    player.connection.send(JSON.stringify(readyMessage));
  }

  private saveGameState() {
    // Save to Durable Objects storage
    this.ctx.storage.put("gameState", JSON.stringify({
      gameState: this.gameState,
      gameStatus: this.gameStatus,
      stateVersion: this.stateVersion,
      gameMode: this.gameMode,
      clock: this.clock,
      players: Array.from(this.players.entries()).map(([id, session]) => ({
        id,
        displayName: session.displayName,
        rating: session.rating,
        isProvisional: session.isProvisional,
        color: session.color,
      })),
      timestamp: Date.now(),
    }));
  }

  private async loadGameState() {
    // Load from storage if exists - note: this is called during onStart
    // For Durable Objects, we'd need to make this async or use sync storage
    // For now, we'll initialize with defaults
    // TODO: Implement proper async state loading
  }
}
