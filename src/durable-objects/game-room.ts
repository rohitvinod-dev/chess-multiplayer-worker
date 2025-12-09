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
  ELORatingChange,
  MoveRecord,
  MatchHistoryData,
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
  ready: boolean; // Task 6: Track player ready state
}

interface SpectatorSession {
  id: string;
  displayName: string;
  connection: Connection;
  connectedAt: number;
}

// Task 5: Heartbeat configuration
const HEARTBEAT_INTERVAL_MS = 10000; // 10 seconds
const HEARTBEAT_TIMEOUT_MS = 30000; // 30 seconds without response = disconnect
const RECONNECT_TIMEOUT_MS = 10000; // 10 seconds to reconnect before abandonment

// Define Env type for GameRoom
interface GameRoomEnv {
  GameRoom: DurableObjectNamespace;
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

  // Spectators
  spectators: Map<string, SpectatorSession> = new Map();
  maxSpectators: number = 50;

  // Lobby mode
  isLobbyMode: boolean = false;
  isUnrated: boolean = false;
  openingName?: string;
  startingFen?: string;

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

  // Match history tracking
  matchStartTime?: number;
  moveHistory: MoveRecord[] = [];

  // Timers
  clockIntervalId?: number;
  abandonmentTimeoutId?: number;
  moveTimeoutId?: number;

  // Task 5: Heartbeat monitoring
  heartbeatIntervalId?: number;
  lastPingTimes: Map<string, number> = new Map();

  onStart() {
    // Game state initialized with defaults
    // No async loading in onStart for PartyKit Server

    // Task 5: Start heartbeat monitoring for all connected players
    this.startHeartbeatMonitoring();
  }

  onConnect(connection: Connection, ctx: any) {
    // Read player info from query parameters (WebSockets don't support custom headers)
    const url = new URL(ctx.request.url);
    const playerId = url.searchParams.get("playerId");
    const displayName = url.searchParams.get("displayName");
    const rating = parseInt(url.searchParams.get("rating") || "1200");
    const isProvisional = url.searchParams.get("isProvisional") === "true";
    const colorFromUrl = url.searchParams.get("color") as PlayerColor | null;
    const mode = url.searchParams.get("mode"); // 'lobby', 'spectator', or null for matchmaking

    // Lobby mode configuration
    if (mode === "lobby" || mode === "spectator") {
      this.isLobbyMode = true;
      this.isUnrated = url.searchParams.get("isUnrated") === "true";
      this.openingName = url.searchParams.get("openingName") || undefined;
      const openingFen = url.searchParams.get("openingFen");
      if (openingFen) {
        this.startingFen = openingFen;
        this.gameState.fen = openingFen; // Set initial position
      }
    }

    if (!playerId) {
      console.error("GameRoom: Missing playerId in connection");
      connection.close(1002, "Missing player ID");
      return;
    }

    // Handle spectator connection
    if (mode === "spectator") {
      if (this.spectators.size >= this.maxSpectators) {
        connection.close(1008, "Spectator limit reached");
        return;
      }

      const spectator: SpectatorSession = {
        id: playerId,
        displayName: displayName || `Spectator-${playerId.slice(0, 6)}`,
        connection,
        connectedAt: Date.now(),
      };

      this.spectators.set(playerId, spectator);
      console.log(`GameRoom: Spectator ${playerId} connected. Total spectators: ${this.spectators.size}`);

      // Send current game state to spectator
      this.sendGameStateToSpectator(playerId);
      return;
    }

    console.log(`GameRoom: Player ${playerId} attempting to connect with color ${colorFromUrl}`);

    // Task 5: Check if this is a reconnection
    const existingPlayer = this.players.get(playerId);
    const isReconnection = existingPlayer && !existingPlayer.connected;

    // Use color from URL if provided (from matchmaking), otherwise assign based on order
    const playerColor = colorFromUrl
      ? colorFromUrl
      : existingPlayer
      ? existingPlayer.color
      : this.players.size === 0 ? "white" : "black";

    const session: PlayerSession = {
      id: playerId,
      displayName: displayName || `Player-${playerId.slice(0, 6)}`,
      rating: existingPlayer?.rating || rating,
      isProvisional: existingPlayer?.isProvisional || isProvisional,
      color: playerColor,
      connection,
      lastSeen: Date.now(),
      connected: true,
      ready: existingPlayer?.ready || false, // Task 6: Initialize ready state
    };

    this.players.set(playerId, session);

    // Task 5: Track last ping time for heartbeat monitoring
    this.lastPingTimes.set(playerId, Date.now());

    console.log(`GameRoom: Player ${playerId} connected (reconnection: ${isReconnection})`);

    // Task 5: Notify opponent of connection
    this.notifyOpponentOfConnection(playerId);

    // Task 5 & 6: Send current game state to newly connected player
    this.sendGameStateToPlayer(playerId);

    // If both players connected, auto-start the game (works for both initial and reconnections)
    if (this.players.size === 2) {
      const allConnected = Array.from(this.players.values()).every(p => p.connected);
      if (allConnected && (this.gameStatus === "waiting" || this.gameStatus === "ready")) {
        console.log("GameRoom: Both players connected, auto-starting game (reconnection: " + isReconnection + ")");
        // Set all players as ready and start the game
        for (const player of this.players.values()) {
          player.ready = true;
        }
        this.startGame();
      }
    }

    // If reconnecting during a game, cancel abandonment timeout
    if (isReconnection && this.abandonmentTimeoutId) {
      clearTimeout(this.abandonmentTimeoutId);
      this.abandonmentTimeoutId = undefined;
      console.log(`GameRoom: Player ${playerId} reconnected, canceling abandonment`);
    }
  }

  onMessage(connection: Connection, message: WSMessage) {
    try {
      const data = JSON.parse(message as string) as any;

      // Find which player sent this message first
      let sendingPlayer: PlayerSession | undefined;
      for (const player of this.players.values()) {
        if (player.connection === connection) {
          sendingPlayer = player;
          break;
        }
      }

      if (data.type === "ping") {
        connection.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
        // Task 5: Update last ping time
        if (sendingPlayer) {
          this.lastPingTimes.set(sendingPlayer.id, Date.now());
        }
        return;
      }

      // Task 5: Handle pong response for heartbeat
      if (data.type === "pong") {
        if (sendingPlayer) {
          this.lastPingTimes.set(sendingPlayer.id, Date.now());
          console.log(`GameRoom: Received pong from ${sendingPlayer.id}`);
        }
        return;
      }

      // Cast to GameMessage after handling ping/pong
      const gameMessage = data as GameMessage;

      if (!sendingPlayer) {
        connection.close(1002, "Player not found");
        return;
      }

      // Task 5: Update last seen and ping times for any message received
      sendingPlayer.lastSeen = Date.now();
      sendingPlayer.connected = true;
      this.lastPingTimes.set(sendingPlayer.id, Date.now());

      switch (gameMessage.type) {
        case "move":
          this.handleMove(sendingPlayer, data);
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
        // Task 6: Handle player ready message
        case "ready":
          this.handlePlayerReady(sendingPlayer);
          break;
      }
    } catch (error) {
      console.error("Error handling message:", error);
    }
  }

  onClose(connection: Connection) {
    // Check if this is a spectator disconnection
    for (const [spectatorId, spectator] of this.spectators) {
      if (spectator.connection === connection) {
        this.spectators.delete(spectatorId);
        console.log(`GameRoom: Spectator ${spectatorId} disconnected. Total spectators: ${this.spectators.size}`);
        return; // Spectators don't affect game state
      }
    }

    // Mark player as disconnected
    for (const player of this.players.values()) {
      if (player.connection === connection) {
        player.connected = false;
        player.connection = undefined;

        console.log(`GameRoom: Player ${player.id} disconnected`);

        // Task 5: Clean up ping tracking
        this.lastPingTimes.delete(player.id);

        // Task 5: Notify opponent of disconnection with reconnect timeout
        this.notifyOpponentOfDisconnection(player.id);

        // Task 5: If game is active and player disconnects for 10 seconds, abandon
        if (this.gameStatus === "playing" || this.gameStatus === "ready") {
          this.abandonmentTimeoutId = setTimeout(() => {
            if (!player.connected) {
              console.log(`GameRoom: Player ${player.id} abandoned game`);
              this.endGame(
                player.color === "white" ? "black_win" : "white_win",
                "opponent_abandoned"
              );
            }
          }, RECONNECT_TIMEOUT_MS) as unknown as number;
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

    // Initialize match tracking
    this.matchStartTime = Date.now();
    this.moveHistory = [];

    // Start clock interval
    this.startClockInterval();

    // Send ready message to both players
    const [white, black] = players.sort(
      (a) => (a.color === "white" ? -1 : 1)
    );

    this.sendReadyMessage(white, black);
    this.sendReadyMessage(black, white);

    this.gameStatus = "playing";
    console.log(`GameRoom: Game started at ${this.matchStartTime}`);
  }

  private handleMove(player: PlayerSession, data: any) {
    const messageId = data.messageId;
    const uciMove = data.move as string; // UCI format: "e2e4" or "e7e8q"
    const fenAfter = data.fenAfter as string | undefined;

    // Parse UCI move into Move object
    let move: Move;
    try {
      if (uciMove.length < 4) {
        throw new Error("Invalid UCI move length");
      }
      move = {
        from: uciMove.substring(0, 2),
        to: uciMove.substring(2, 4),
        promotion: uciMove.length > 4 ? uciMove.substring(4) : undefined,
      };
    } catch (e) {
      player.connection?.send(
        JSON.stringify({
          type: "error",
          code: "invalid_move_format",
          message: "Invalid move format",
        } as GameMessage)
      );
      return;
    }

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
    const moveTimestamp = Date.now();
    this.gameState.moves.push({
      move,
      timestamp: moveTimestamp,
    });

    // Record move in match history with SAN
    this.moveHistory.push({
      uci: uciMove,
      san: data.san as string | undefined,
      timestamp: moveTimestamp,
      madeBy: player.color,
    });

    this.stateVersion++;

    // Update FEN - use client's FEN if provided, otherwise use simple update
    if (fenAfter) {
      this.gameState.fen = fenAfter;
    } else {
      this.gameState.fen = this.updateFen(move, isWhiteTurn);
    }

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

    // Send ACK to the player who made the move
    if (messageId && player.connection) {
      player.connection.send(
        JSON.stringify({
          type: "ack",
          messageId,
          success: true,
          stateVersion: this.stateVersion,
        })
      );
    }

    // Broadcast move to both players and spectators
    const moveMessage = {
      type: "move",
      record: {
        uci: uciMove,
        madeBy: player.color,
        fenAfter: this.gameState.fen,
      },
      gameState: this.gameState,
      clock: this.clock,
      stateVersion: this.stateVersion,
    };

    const totalRecipients = this.players.size + this.spectators.size;
    console.log(`GameRoom: Broadcasting move ${uciMove} by ${player.color} to ${totalRecipients} recipients`);

    // Send to players
    for (const p of this.players.values()) {
      if (p.connected && p.connection) {
        p.connection.send(JSON.stringify(moveMessage));
        console.log(`GameRoom: Sent move to player ${p.id} (${p.color})`);
      }
    }

    // Send to spectators
    for (const spectator of this.spectators.values()) {
      if (spectator.connection) {
        spectator.connection.send(JSON.stringify(moveMessage));
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
      playerId: player.color, // Send color instead of ID for easier identification
      displayName: player.displayName,
      message: message.slice(0, 500), // Limit message length
      timestamp: Date.now(),
    };

    console.log(`GameRoom: Chat from ${player.displayName} (${player.color}): ${message.slice(0, 50)}`);

    // Broadcast to both players
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

      // Send to players
      for (const p of this.players.values()) {
        if (p.connected && p.connection) {
          p.connection.send(JSON.stringify(clockUpdate));
        }
      }

      // Send to spectators
      for (const spectator of this.spectators.values()) {
        if (spectator.connection) {
          spectator.connection.send(JSON.stringify(clockUpdate));
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

  private calculateELO(
    winnerRating: number,
    loserRating: number,
    winnerProvisional: boolean,
    loserProvisional: boolean,
    isDraw: boolean = false
  ): { winnerChange: number; loserChange: number } {
    // K-factor: 40 for provisional players (first 20 games), 20 for established players
    const winnerK = winnerProvisional ? 40 : 20;
    const loserK = loserProvisional ? 40 : 20;

    // Expected score calculation (Elo formula)
    const expectedWinner = 1 / (1 + Math.pow(10, (loserRating - winnerRating) / 400));
    const expectedLoser = 1 / (1 + Math.pow(10, (winnerRating - loserRating) / 400));

    // Actual score: 1 for win, 0.5 for draw, 0 for loss
    const winnerScore = isDraw ? 0.5 : 1;
    const loserScore = isDraw ? 0.5 : 0;

    // Calculate rating changes
    const winnerChange = Math.round(winnerK * (winnerScore - expectedWinner));
    const loserChange = Math.round(loserK * (loserScore - expectedLoser));

    return { winnerChange, loserChange };
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

    // Get players
    const players = Array.from(this.players.values());
    const white = players.find(p => p.color === "white");
    const black = players.find(p => p.color === "black");

    if (!white || !black) {
      console.error("GameRoom: Cannot calculate ELO - missing players");
      return;
    }

    // Calculate ELO changes
    let whiteChange = 0;
    let blackChange = 0;

    if (result === "white_win") {
      const changes = this.calculateELO(
        white.rating,
        black.rating,
        white.isProvisional,
        black.isProvisional,
        false
      );
      whiteChange = changes.winnerChange;
      blackChange = changes.loserChange;
    } else if (result === "black_win") {
      const changes = this.calculateELO(
        black.rating,
        white.rating,
        black.isProvisional,
        white.isProvisional,
        false
      );
      blackChange = changes.winnerChange;
      whiteChange = changes.loserChange;
    } else if (result === "draw") {
      const changes = this.calculateELO(
        white.rating,
        black.rating,
        white.isProvisional,
        black.isProvisional,
        true
      );
      whiteChange = changes.winnerChange;
      blackChange = changes.loserChange;
    }

    // Create ELO rating change objects
    const whiteRatingChange: ELORatingChange = {
      playerId: white.id,
      oldRating: white.rating,
      newRating: white.rating + whiteChange,
      change: whiteChange,
      wasProvisional: white.isProvisional,
      // Provisional status ends after 20 games (approx. 20 moves recorded means complete game)
      isProvisional: white.isProvisional && this.moveHistory.length < 20,
    };

    const blackRatingChange: ELORatingChange = {
      playerId: black.id,
      oldRating: black.rating,
      newRating: black.rating + blackChange,
      change: blackChange,
      wasProvisional: black.isProvisional,
      isProvisional: black.isProvisional && this.moveHistory.length < 20,
    };

    // Create match history data
    const matchHistory: MatchHistoryData = {
      matchId: this.party.id,
      whitePlayer: {
        id: white.id,
        displayName: white.displayName,
        rating: white.rating,
        isProvisional: white.isProvisional,
      },
      blackPlayer: {
        id: black.id,
        displayName: black.displayName,
        rating: black.rating,
        isProvisional: black.isProvisional,
      },
      gameMode: this.gameMode,
      result: result as any,
      resultReason: reason,
      moves: this.moveHistory,
      startedAt: this.matchStartTime || Date.now(),
      endedAt: Date.now(),
      eloChanges: {
        white: whiteRatingChange,
        black: blackRatingChange,
      },
    };

    console.log(`GameRoom: Match ended - White: ${whiteChange >= 0 ? '+' : ''}${whiteChange}, Black: ${blackChange >= 0 ? '+' : ''}${blackChange}`);
    console.log(`GameRoom: ${this.moveHistory.length} moves recorded`);

    // Send game_ended message with ELO changes and match history to both players
    const gameEndedMessage: GameMessage = {
      type: "game_ended",
      result: result as any,
      resultReason: reason,
      eloChanges: {
        white: whiteRatingChange,
        black: blackRatingChange,
      },
      matchHistory,
    };

    for (const p of this.players.values()) {
      if (p.connected && p.connection) {
        p.connection.send(JSON.stringify(gameEndedMessage));
      }
    }

    // Also send legacy system message for backward compatibility
    const systemMessage: GameMessage = {
      type: "system",
      message: `Game ended: ${result} (${reason})`,
      code: "game_ended",
    };

    for (const p of this.players.values()) {
      if (p.connected && p.connection) {
        p.connection.send(JSON.stringify(systemMessage));
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
      state: {
        status: this.gameStatus,
        version: this.stateVersion,
        fen: this.gameState.fen,
        moves: this.gameState.moves,
      },
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

  // ============ TASK 5: WEBSOCKET CONNECTION SYNCHRONIZATION ============

  // Task 5: Start heartbeat monitoring for all connected players
  private startHeartbeatMonitoring(): void {
    // Clear existing timer if any
    if (this.heartbeatIntervalId) {
      clearInterval(this.heartbeatIntervalId);
    }

    // Send ping to all connected players every HEARTBEAT_INTERVAL_MS
    this.heartbeatIntervalId = setInterval(() => {
      const now = Date.now();

      for (const [playerId, player] of this.players) {
        if (!player.connected || !player.connection) continue;

        // Send ping
        try {
          player.connection.send(JSON.stringify({
            type: "ping",
            timestamp: now,
          }));
        } catch (error) {
          console.error(`GameRoom: Error sending ping to ${playerId}:`, error);
        }

        // Check if player responded to last ping
        const lastPing = this.lastPingTimes.get(playerId) || 0;
        if (now - lastPing > HEARTBEAT_TIMEOUT_MS) {
          // No pong received in 30 seconds - consider disconnected
          console.log(`GameRoom: Player ${playerId} unresponsive (no response in ${HEARTBEAT_TIMEOUT_MS}ms)`);
          // Force disconnect
          if (player.connection) {
            player.connection.close(1001, "Heartbeat timeout");
          }
        }
      }
    }, HEARTBEAT_INTERVAL_MS) as unknown as number;

    console.log("GameRoom: Heartbeat monitoring started");
  }

  // Task 5: Notify opponent when a player connects
  private notifyOpponentOfConnection(playerId: string): void {
    for (const [id, player] of this.players) {
      if (id !== playerId && player.connected && player.connection) {
        try {
          player.connection.send(JSON.stringify({
            type: "opponent_status",
            opponentConnected: true,
            timestamp: Date.now(),
          }));
          console.log(`GameRoom: Notified ${id} that ${playerId} connected`);
        } catch (error) {
          console.error(`GameRoom: Error notifying ${id} of connection:`, error);
        }
      }
    }
  }

  // Task 5: Notify opponent when a player disconnects
  private notifyOpponentOfDisconnection(playerId: string): void {
    for (const [id, player] of this.players) {
      if (id !== playerId && player.connected && player.connection) {
        try {
          player.connection.send(JSON.stringify({
            type: "opponent_status",
            opponentConnected: false,
            reconnectTimeout: RECONNECT_TIMEOUT_MS,
            timestamp: Date.now(),
          }));
          console.log(`GameRoom: Notified ${id} that ${playerId} disconnected`);
        } catch (error) {
          console.error(`GameRoom: Error notifying ${id} of disconnection:`, error);
        }
      }
    }
  }

  // Task 5 & 6: Send current game state to a specific player
  private sendGameStateToPlayer(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player || !player.connected || !player.connection) return;

    // Find opponent
    const opponent = Array.from(this.players.values()).find(p => p.id !== playerId);

    if (opponent) {
      // Send full game state with opponent info
      const stateMessage: GameMessage = {
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

      try {
        player.connection.send(JSON.stringify(stateMessage));
        console.log(`GameRoom: Sent game state to ${playerId}`);
      } catch (error) {
        console.error(`GameRoom: Error sending game state to ${playerId}:`, error);
      }
    } else {
      // No opponent yet, send waiting message
      try {
        player.connection.send(JSON.stringify({
          type: "waiting",
          message: "Waiting for opponent to connect",
          timestamp: Date.now(),
        }));
        console.log(`GameRoom: Sent waiting message to ${playerId}`);
      } catch (error) {
        console.error(`GameRoom: Error sending waiting message to ${playerId}:`, error);
      }
    }
  }

  // ============ TASK 6: PLAYER READY HANDLING ============

  // Task 6: Handle player ready message
  private handlePlayerReady(player: PlayerSession): void {
    player.ready = true;
    console.log(`GameRoom: Player ${player.id} is ready`);

    // Check if both players are connected and ready
    const allPlayersReady = Array.from(this.players.values())
      .every(p => p.connected && p.ready);

    if (allPlayersReady && this.players.size === 2) {
      if (this.gameStatus === "waiting" || this.gameStatus === "ready") {
        this.gameStatus = "playing";
        this.clock.lastUpdate = Date.now();

        // Start clock interval if not already started
        if (!this.clockIntervalId) {
          this.startClockInterval();
        }

        // Notify both players game is starting
        this.broadcastGameStart();

        console.log("GameRoom: Game started, both players connected and ready");
      }
    } else {
      // Notify opponent that this player is ready
      for (const [id, p] of this.players) {
        if (id !== player.id && p.connected && p.connection) {
          try {
            p.connection.send(JSON.stringify({
              type: "opponent_ready",
              playerId: player.id,
              timestamp: Date.now(),
            }));
          } catch (error) {
            console.error(`GameRoom: Error notifying ${id} of ready:`, error);
          }
        }
      }
    }
  }

  // Task 6: Broadcast game start to all players
  private broadcastGameStart(): void {
    const startMessage = {
      type: "game_start",
      gameState: this.gameState,
      clock: this.clock,
      stateVersion: this.stateVersion,
      timestamp: Date.now(),
    };

    const messageStr = JSON.stringify(startMessage);

    for (const player of this.players.values()) {
      if (player.connected && player.connection) {
        try {
          player.connection.send(messageStr);
          console.log(`GameRoom: Sent game_start to ${player.id}`);
        } catch (error) {
          console.error(`GameRoom: Error sending game_start to ${player.id}:`, error);
        }
      }
    }

    // Also send to spectators
    for (const spectator of this.spectators.values()) {
      if (spectator.connection) {
        try {
          spectator.connection.send(messageStr);
        } catch (error) {
          console.error(`GameRoom: Error sending game_start to spectator ${spectator.id}:`, error);
        }
      }
    }
  }

  // Send current game state to spectator
  private sendGameStateToSpectator(spectatorId: string): void {
    const spectator = this.spectators.get(spectatorId);
    if (!spectator || !spectator.connection) return;

    const players = Array.from(this.players.values());
    const white = players.find(p => p.color === 'white');
    const black = players.find(p => p.color === 'black');

    const stateMessage = {
      type: "spectator_state",
      gameState: this.gameState,
      clock: this.clock,
      stateVersion: this.stateVersion,
      status: this.gameStatus,
      whitePlayer: white ? {
        displayName: white.displayName,
        rating: white.rating,
        connected: white.connected,
      } : null,
      blackPlayer: black ? {
        displayName: black.displayName,
        rating: black.rating,
        connected: black.connected,
      } : null,
      spectatorCount: this.spectators.size,
      isUnrated: this.isUnrated,
      openingName: this.openingName,
    };

    try {
      spectator.connection.send(JSON.stringify(stateMessage));
      console.log(`GameRoom: Sent game state to spectator ${spectatorId}`);
    } catch (error) {
      console.error(`GameRoom: Error sending game state to spectator ${spectatorId}:`, error);
    }
  }
}
