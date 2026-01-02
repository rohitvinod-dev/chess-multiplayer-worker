import {
  type Connection,
  Server,
  type WSMessage,
} from "partyserver";

import { FirestoreClient } from "../firestore";

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
const RECONNECT_TIMEOUT_MS = 60000; // 60 seconds (1 minute) to reconnect before abandonment

// Define Env type for GameRoom
interface GameRoomEnv {
  GameRoom: DurableObjectNamespace;
  MATCHMAKING_QUEUE: DurableObjectNamespace;
  LOBBY_LIST: DurableObjectNamespace;
  ASSETS: Fetcher;
  FIREBASE_PROJECT_ID: string;
  FIREBASE_SERVICE_ACCOUNT: string;
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
  lobbyId?: string; // Set when created from a lobby, used to cleanup lobby on game end
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

  /**
   * Override fetch to handle DO-to-DO HTTP calls before partyserver routing.
   * Partyserver expects namespace/room headers for WebSocket connections,
   * but we need to handle plain HTTP requests from LobbyRoom.
   */
  async fetch(request: Request): Promise<Response> {
    // Check if this is a DO-to-DO call (no partyserver headers)
    const hasPartyHeaders = request.headers.has('x-partykit-namespace') ||
                            request.headers.has('x-partykit-room');

    if (!hasPartyHeaders) {
      // Handle as plain HTTP request (DO-to-DO call)
      return this.handleHttpRequest(request);
    }

    // Delegate to partyserver for WebSocket handling
    return super.fetch(request);
  }

  /**
   * Handle HTTP requests (for DO-to-DO calls like lobby initialization)
   * This allows LobbyRoom to initialize GameRoom before players connect via WebSocket
   */
  private async handleHttpRequest(request: Request): Promise<Response> {
    let pathname: string;
    try {
      const url = new URL(request.url, 'https://localhost');
      pathname = url.pathname;
    } catch (e) {
      console.error(`[GameRoom] Failed to parse request URL: ${request.url}`, e);
      pathname = request.url;
    }

    console.log(`[GameRoom] HTTP request: ${request.method} ${pathname}`);

    // Initialize game room (called by LobbyRoom when match is ready)
    if (pathname === '/init' && request.method === 'POST') {
      return this.handleInit(request);
    }

    // Get game state
    if (pathname === '/state' && request.method === 'GET') {
      return new Response(JSON.stringify({
        gameStatus: this.gameStatus,
        gameMode: this.gameMode,
        isLobbyMode: this.isLobbyMode,
        isUnrated: this.isUnrated,
        players: Array.from(this.players.values()).map(p => ({
          id: p.id,
          displayName: p.displayName,
          color: p.color,
          connected: p.connected,
        })),
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found', { status: 404 });
  }

  /**
   * Initialize game room from LobbyRoom
   * Sets up players, game mode, and lobby-specific settings
   */
  private async handleInit(request: Request): Promise<Response> {
    try {
      const data = await request.json() as {
        gameMode: GameMode;
        isLobbyMode: boolean;
        isUnrated: boolean;
        lobbyId?: string;
        openingName?: string;
        startingFen?: string;
        players: {
          white?: { id: string; displayName: string; rating: number; isProvisional: boolean };
          black?: { id: string; displayName: string; rating: number; isProvisional: boolean };
        };
      };

      console.log(`[GameRoom] Initializing from lobby:`, JSON.stringify(data));

      // Set game configuration
      this.gameMode = data.gameMode;
      this.isLobbyMode = data.isLobbyMode;
      // Lobby matches are always unrated (friendly matches)
      this.isUnrated = true;
      this.lobbyId = data.lobbyId; // Store lobbyId for cleanup on game end
      this.openingName = data.openingName;

      if (data.startingFen) {
        this.startingFen = data.startingFen;
        this.gameState.fen = data.startingFen;
      }

      // Set clock based on game mode
      const clockSettings = this.getClockSettings(data.gameMode);
      this.clock = {
        white: { remaining: clockSettings.initial, increment: clockSettings.increment },
        black: { remaining: clockSettings.initial, increment: clockSettings.increment },
        lastUpdate: Date.now(),
        currentTurn: "white",
      };

      // Pre-register players (they'll connect via WebSocket later)
      if (data.players.white) {
        const white = data.players.white;
        this.players.set(white.id, {
          id: white.id,
          displayName: white.displayName,
          rating: white.rating,
          isProvisional: white.isProvisional,
          color: "white",
          lastSeen: Date.now(),
          connected: false,
          ready: false,
        });
      }

      if (data.players.black) {
        const black = data.players.black;
        this.players.set(black.id, {
          id: black.id,
          displayName: black.displayName,
          rating: black.rating,
          isProvisional: black.isProvisional,
          color: "black",
          lastSeen: Date.now(),
          connected: false,
          ready: false,
        });
      }

      this.gameStatus = "waiting";
      console.log(`[GameRoom] Initialized successfully. Players: ${this.players.size}, Mode: ${this.gameMode}, Unrated: ${this.isUnrated}`);

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('[GameRoom] Init error:', error);
      return new Response(JSON.stringify({ error: 'Failed to initialize game room' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  /**
   * Get clock settings based on game mode
   */
  private getClockSettings(mode: GameMode): { initial: number; increment: number } {
    switch (mode) {
      case "bullet":
        return { initial: 60000, increment: 0 }; // 1 minute
      case "blitz":
        return { initial: 180000, increment: 1000 }; // 3+1
      case "rapid":
        return { initial: 600000, increment: 5000 }; // 10+5
      case "classical":
        return { initial: 1800000, increment: 10000 }; // 30+10
      default:
        return { initial: 180000, increment: 1000 }; // Default to blitz
    }
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

      // Broadcast updated spectator count to all
      this.broadcastSpectatorCount();
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
    // VERSION MARKER: 2025-12-31 v3 - CRITICAL DEBUG LOGGING
    console.error(`🚨🚨🚨 GameRoom.onMessage ENTRY - gameStatus=${this.gameStatus}, partyId=${this.party?.id}`);
    console.log(`🚨 GameRoom.onMessage raw message: ${String(message).substring(0, 200)}`);

    try {
      const data = JSON.parse(message as string) as any;
      console.error(`🚨 GameRoom.onMessage parsed type=${data.type}, gameStatus=${this.gameStatus}`);

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
          console.log(`🚨 GameRoom: Handling move from ${sendingPlayer.id}`);
          this.handleMove(sendingPlayer, data);
          break;
        case "resign":
          console.error(`🚨 GameRoom: Handling RESIGN from ${sendingPlayer.id}`);
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
          console.log(`🚨 GameRoom: Handling ready from ${sendingPlayer.id}`);
          this.handlePlayerReady(sendingPlayer);
          break;
        // Handle client-reported game end (checkmate, stalemate, draw)
        case "game_end":
          console.error(`🚨 GameRoom: Handling GAME_END from ${sendingPlayer.id} - data=${JSON.stringify(data)}`);
          this.handleGameEndRequest(sendingPlayer, data);
          break;
        default:
          console.error(`🚨 GameRoom: UNHANDLED message type: ${gameMessage.type}`);
      }
    } catch (error) {
      console.error("Error handling message:", error);
    }
  }

  onClose(connection: Connection) {
    // VERSION MARKER: 2025-12-31 v3 - CRITICAL DEBUG LOGGING
    console.error(`🚨🚨🚨 GameRoom.onClose ENTRY - gameStatus=${this.gameStatus}, partyId=${this.party?.id}`);

    // Check if this is a spectator disconnection
    for (const [spectatorId, spectator] of this.spectators) {
      if (spectator.connection === connection) {
        this.spectators.delete(spectatorId);
        console.log(`GameRoom: Spectator ${spectatorId} disconnected. Total spectators: ${this.spectators.size}`);
        // Broadcast updated spectator count
        this.broadcastSpectatorCount();
        return; // Spectators don't affect game state
      }
    }

    // Mark player as disconnected
    for (const player of this.players.values()) {
      if (player.connection === connection) {
        player.connected = false;
        player.connection = undefined;

        console.log(`GameRoom: Player ${player.id} disconnected, gameStatus: ${this.gameStatus}`);

        // Task 5: Clean up ping tracking
        this.lastPingTimes.delete(player.id);

        // If game already ended (resignation, checkmate, etc.), don't send disconnect notification
        // This prevents showing "opponent left" when they actually resigned
        if (this.gameStatus === "finished") {
          console.log(`GameRoom: Game already finished, skipping disconnect notification`);
          break;
        }

        // Task 5: Notify opponent of disconnection with reconnect timeout
        this.notifyOpponentOfDisconnection(player.id);

        // Task 5: If game is active and player disconnects, start abandon timer
        if (this.gameStatus === "playing" || this.gameStatus === "ready") {
          console.error(`🚨 GameRoom: Starting abandonment timer for player ${player.id}`);
          this.abandonmentTimeoutId = setTimeout(() => {
            // Double check game hasn't ended and player hasn't reconnected
            console.error(`🚪🚪🚪 ABANDONMENT TIMER FIRED for player ${player.id}`);
            console.error(`🚪🚪🚪 connected=${player.connected}, gameStatus=${this.gameStatus}`);
            if (!player.connected && this.gameStatus !== "finished") {
              const result = player.color === "white" ? "black_win" : "white_win";
              console.error(`🚪🚪🚪 ABOUT TO CALL endGame("${result}", "opponent_abandoned") FROM ABANDON TIMER`);
              this.endGame(result, "opponent_abandoned");
              console.error(`🚪🚪🚪 endGame RETURNED from abandon timer`);
            } else {
              console.error(`🚪🚪🚪 Skipping endGame: connected=${player.connected}, gameStatus=${this.gameStatus}`);
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
    // IMPORTANT: Reset lastUpdate to now, otherwise the first clock tick will see
    // a huge elapsed time (from when the room was initialized until now)
    this.clock.lastUpdate = Date.now();
    this.clock.currentTurn = "white"; // Ensure white starts

    // Initialize match tracking
    this.matchStartTime = Date.now();
    this.moveHistory = [];

    // Start clock interval
    console.log(`GameRoom: Starting clock interval with white: ${this.clock.white.remaining}ms, black: ${this.clock.black.remaining}ms`);
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
    if (this.gameStatus !== "playing") {
      console.log(`GameRoom: Ignoring resign - game status is ${this.gameStatus}`);
      return;
    }

    console.log(`🔥 GameRoom: handleResign called by ${player.id} (${player.color})`);

    const result =
      player.color === "white" ? "black_win" : "white_win";

    // Immediately notify opponent of resignation (before game_ended)
    // This ensures the opponent's frontend knows it's a resignation, not abandonment
    const resignMessage: GameMessage = {
      type: "resign",
      resignedBy: player.color,
      outcome: player.color === "white" ? "black" : "white",
    };

    // Notify opponent with error handling
    try {
      for (const p of this.players.values()) {
        if (p && p.id && p.id !== player.id && p.connected && p.connection) {
          console.log(`GameRoom: Notifying ${p.id} of resignation by ${player.color}`);
          p.connection.send(JSON.stringify(resignMessage));
        }
      }
    } catch (error) {
      console.error(`GameRoom: Error notifying opponent of resignation:`, error);
      // Continue to endGame even if notification fails
    }

    console.error(`🏳️🏳️🏳️ handleResign ABOUT TO CALL endGame("${result}", "resignation")`);
    this.endGame(result, "resignation");
    console.error(`🏳️🏳️🏳️ handleResign - endGame RETURNED`);
  }

  /**
   * Handle client-reported game end (checkmate, stalemate, draw conditions)
   * The client (Flutter) detects these conditions using chess.dart library
   * and sends a game_end message to the server
   */
  private handleGameEndRequest(player: PlayerSession, data: any) {
    console.log(`GameRoom: >>> handleGameEndRequest received from player ${player.id} (${player.color})`);
    console.log(`GameRoom: >>> data: ${JSON.stringify(data)}`);

    if (this.gameStatus !== "playing") {
      console.log(`GameRoom: Ignoring game_end request - game status is ${this.gameStatus}`);
      return;
    }

    const { result, reason, fen } = data as {
      result: "white_win" | "black_win" | "draw";
      reason: string;
      fen?: string;
    };

    // Validate result and reason
    const validResults = ["white_win", "black_win", "draw"];
    const validReasons = ["checkmate", "stalemate", "insufficient_material", "threefold_repetition", "fifty_move_rule"];

    if (!validResults.includes(result)) {
      console.error(`GameRoom: Invalid game_end result: ${result}`);
      player.connection?.send(JSON.stringify({
        type: "error",
        code: "invalid_game_end",
        message: "Invalid game end result",
      }));
      return;
    }

    if (!validReasons.includes(reason)) {
      console.error(`GameRoom: Invalid game_end reason: ${reason}`);
      player.connection?.send(JSON.stringify({
        type: "error",
        code: "invalid_game_end",
        message: "Invalid game end reason",
      }));
      return;
    }

    // For checkmate, validate that the reporting player's color matches the result
    // The player whose turn it is when checkmate occurs is the one who LOST
    if (reason === "checkmate") {
      // The winner is the player who delivered checkmate (not their turn anymore)
      // So if white_win, it means black's king is in checkmate (black's turn when game ended)
      const expectedWinner = result === "white_win" ? "white" : "black";

      // Log but allow - trust the client's chess.dart library for validation
      console.log(`GameRoom: Checkmate reported by ${player.color}, result: ${result}, winner: ${expectedWinner}`);
    }

    // Update FEN if provided
    if (fen) {
      this.gameState.fen = fen;
    }

    console.error(`🎯🎯🎯 handleGameEndRequest: result=${result}, reason=${reason}`);
    console.error(`🎯🎯🎯 ABOUT TO CALL endGame("${result}", "${reason}") FROM CLIENT REQUEST`);
    this.endGame(result, reason);
    console.error(`🎯🎯🎯 handleGameEndRequest - endGame RETURNED`);
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
    let tickCount = 0;
    this.clockIntervalId = setInterval(() => {
      tickCount++;
      // Log every 50 ticks (5 seconds) to verify interval is running
      if (tickCount % 50 === 0) {
        console.error(`⏱️ CLOCK TICK #${tickCount}: gameStatus=${this.gameStatus}, white=${this.clock.white.remaining}ms, black=${this.clock.black.remaining}ms`);
      }
      if (this.gameStatus !== "playing") return;

      const now = Date.now();
      const elapsed = now - this.clock.lastUpdate;

      if (this.clock.currentTurn === "white") {
        this.clock.white.remaining -= elapsed;
        if (this.clock.white.remaining <= 0) {
          console.error(`⏱️⏱️⏱️ WHITE TIMEOUT DETECTED! remaining=${this.clock.white.remaining}ms, tickCount=${tickCount}`);
          console.error(`⏱️⏱️⏱️ ABOUT TO CALL endGame("black_win", "timeout") FROM CLOCK INTERVAL`);
          this.endGame("black_win", "timeout");
          console.error(`⏱️⏱️⏱️ endGame RETURNED from clock interval`);
          return; // Stop processing after game ends
        }
      } else {
        this.clock.black.remaining -= elapsed;
        if (this.clock.black.remaining <= 0) {
          console.error(`⏱️⏱️⏱️ BLACK TIMEOUT DETECTED! remaining=${this.clock.black.remaining}ms, tickCount=${tickCount}`);
          console.error(`⏱️⏱️⏱️ ABOUT TO CALL endGame("white_win", "timeout") FROM CLOCK INTERVAL`);
          this.endGame("white_win", "timeout");
          console.error(`⏱️⏱️⏱️ endGame RETURNED from clock interval`);
          return; // Stop processing after game ends
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
    // CRITICAL: Log immediately before any operations that could fail
    // VERSION MARKER: 2025-12-31 v4 - UNIQUE ID FOR EACH CALL
    const callId = Math.random().toString(36).substring(7);
    console.error(`╔════════════════════════════════════════════════════════════╗`);
    console.error(`║ 🔥🔥🔥 GameRoom.endGame CALLED [${callId}]                 ║`);
    console.error(`║ result=${result}, reason=${reason}                          ║`);
    console.error(`║ partyId=${this.party?.id}, gameStatus=${this.gameStatus}    ║`);
    console.error(`║ timestamp=${Date.now()}                                      ║`);
    console.error(`╚════════════════════════════════════════════════════════════╝`);
    console.error(`GameRoom: >>> endGame ENTRY [${callId}] - result=${result}, reason=${reason}, current gameStatus=${this.gameStatus}`);

    if (this.gameStatus === "finished") {
      console.error(`GameRoom: endGame skipped - already finished`);
      return;
    }

    // Set status immediately
    this.gameStatus = "finished";
    console.error(`GameRoom: Status set to finished - MATCH HISTORY WILL BE SAVED`);

    try {
      this.gameState.result = result as any;
      this.gameState.resultReason = reason;

      // Stop timers
      if (this.clockIntervalId) clearInterval(this.clockIntervalId);
      if (this.abandonmentTimeoutId) clearTimeout(this.abandonmentTimeoutId);
      if (this.moveTimeoutId) clearTimeout(this.moveTimeoutId);
      console.log(`GameRoom: Timers cleared`);
    } catch (e) {
      console.error(`GameRoom: Error clearing timers:`, e);
    }

    // Save final state (non-blocking, catch errors)
    try {
      this.saveGameState();
      console.log(`GameRoom: State saved`);
    } catch (e) {
      console.error(`GameRoom: Error saving state:`, e);
      // Continue - state save failure shouldn't prevent game_ended
    }

    // Get players safely
    let players: PlayerSession[] = [];
    let white: PlayerSession | undefined;
    let black: PlayerSession | undefined;
    
    try {
      players = this.players ? Array.from(this.players.values()) : [];
      white = players.find(p => p.color === "white");
      black = players.find(p => p.color === "black");
      console.log(`GameRoom: endGame called with result=${result}, reason=${reason}`);
      console.log(`GameRoom: Players in room: ${players.map(p => `${p.id}(${p.color})`).join(', ')}`);
    } catch (e) {
      console.error(`GameRoom: Error getting players:`, e);
      // players array is empty, will fall through to basic message handling
    }

    // Get room ID safely (this.party might be undefined in some edge cases)
    const roomId = this.party?.id || `room-${Date.now()}`;
    console.log(`GameRoom: Room ID for match history: ${roomId}`);

    // Even if players are missing, still send game_ended to connected players
    if (!white || !black) {
      console.error(`GameRoom: Missing players - white: ${!!white}, black: ${!!black}`);
      // Send basic game_ended message without ELO data
      try {
        const basicGameEndedMessage: GameMessage = {
          type: "game_ended",
          result: result as any,
          resultReason: reason,
          eloChanges: {
            white: { playerId: "", oldRating: 1200, newRating: 1200, change: 0, wasProvisional: true, isProvisional: true },
            black: { playerId: "", oldRating: 1200, newRating: 1200, change: 0, wasProvisional: true, isProvisional: true },
          },
          matchHistory: {
            matchId: roomId,
            whitePlayer: { id: white?.id || "", displayName: white?.displayName || "Unknown", rating: white?.rating || 1200, isProvisional: true },
            blackPlayer: { id: black?.id || "", displayName: black?.displayName || "Unknown", rating: black?.rating || 1200, isProvisional: true },
            gameMode: this.gameMode,
            matchType: this.isUnrated ? "friendly" : "ranked",
            result: result as any,
            resultReason: reason,
            moves: this.moveHistory || [],
            finalFen: this.gameState?.fen || "",
            pgn: "",
            startedAt: this.matchStartTime || Date.now(),
            endedAt: Date.now(),
            openingName: this.openingName,
            eloChanges: {
              white: { playerId: "", oldRating: 1200, newRating: 1200, change: 0, wasProvisional: true, isProvisional: true },
              black: { playerId: "", oldRating: 1200, newRating: 1200, change: 0, wasProvisional: true, isProvisional: true },
            },
          },
        };
        
        if (this.players) {
          for (const p of this.players.values()) {
            try {
              if (p.connected && p.connection) {
                console.log(`GameRoom: Sending basic game_ended to ${p.id} (${p.color})`);
                p.connection.send(JSON.stringify(basicGameEndedMessage));
              }
            } catch (sendError) {
              console.error(`GameRoom: Error sending basic game_ended to ${p.id}:`, sendError);
            }
          }
        }
      } catch (e) {
        console.error(`GameRoom: Error creating/sending basic game_ended message:`, e);
      }
      return;
    }

    // Calculate ELO changes (skip for friendly/unrated matches)
    let whiteChange = 0;
    let blackChange = 0;

    // Only calculate ELO for ranked matches
    if (!this.isUnrated) {
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
    } else {
      console.log(`GameRoom: Friendly match - no ELO changes applied`);
    }

    // Debug: Verify players and party still exist
    console.log(`GameRoom: Creating ELO objects - white: ${white?.id}, black: ${black?.id}, party: ${this.party?.id}`);

    // Defensive check - players might have been removed during async operations
    if (!white || !black) {
      console.error(`GameRoom: Players became undefined after check! white: ${!!white}, black: ${!!black}`);
      return;
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

    // Generate PGN from move history
    const pgn = this.generatePgn();

    // roomId already defined above
    console.log(`GameRoom: Creating match history with roomId: ${roomId}`);

    // Create match history data
    const matchHistory: MatchHistoryData = {
      matchId: roomId,
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
      matchType: this.isUnrated ? "friendly" : "ranked", // Distinguish lobby matches from ranked
      result: result as any,
      resultReason: reason,
      moves: this.moveHistory,
      finalFen: this.gameState.fen, // Final position
      pgn: pgn, // PGN notation
      startedAt: this.matchStartTime || Date.now(),
      endedAt: Date.now(),
      openingName: this.openingName, // Include opening name for lobby matches
      eloChanges: {
        white: whiteRatingChange,
        black: blackRatingChange,
      },
    };

    console.log(`GameRoom: Match ended - White: ${whiteChange >= 0 ? '+' : ''}${whiteChange}, Black: ${blackChange >= 0 ? '+' : ''}${blackChange}`);
    console.log(`GameRoom: ${this.moveHistory.length} moves recorded`);

    // ==================== SERVER-SIDE MATCH HISTORY SAVE ====================
    // Save match history to Firestore for BOTH players, regardless of connection state.
    // This guarantees persistence even if players disconnect before receiving game_ended.
    const saveMatchHistoryToFirestore = async () => {
      try {
        console.error(`📝 Starting server-side match history save for match ${roomId}`);

        const firestore = new FirestoreClient({
          projectId: this.env.FIREBASE_PROJECT_ID,
          serviceAccount: this.env.FIREBASE_SERVICE_ACCOUNT,
        });

        // Build efficient match data (shared between both player documents)
        const sharedMatchData = {
          matchId: roomId,
          // Players info
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
          // Result
          result: result, // 'white_win', 'black_win', or 'draw'
          reason: reason, // 'resignation', 'timeout', 'checkmate', 'stalemate', 'opponent_abandoned'
          // Rating changes
          whiteRatingChange: whiteRatingChange.change,
          blackRatingChange: blackRatingChange.change,
          // Game info
          gameMode: this.gameMode || 'blitz',
          matchType: this.isUnrated ? 'friendly' : 'ranked',
          startingFen: this.startingFen || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          finalFen: this.gameState.fen,
          openingName: this.openingName || null,
          // Moves with timestamps for replay
          moves: this.moveHistory.map(m => ({
            uci: m.uci,
            san: m.san,
            timestamp: m.timestamp,
            madeBy: m.madeBy,
          })),
          // Timestamps
          playedAt: new Date().toISOString(),
          gameStartedAt: this.matchStartTime || Date.now(),
          gameEndedAt: Date.now(),
        };

        // Save for white player
        if (white.id) {
          await firestore.setDocument(`users/${white.id}/matchHistory/${roomId}`, {
            ...sharedMatchData,
            playerColor: 'white',
            opponentId: black.id,
            opponentUsername: black.displayName,
            opponentElo: black.rating,
            playerResult: result === 'white_win' ? 'win' : result === 'black_win' ? 'loss' : 'draw',
            eloChange: whiteRatingChange.change,
            eloAfter: whiteRatingChange.newRating,
          });
          console.error(`✅ Match history saved for WHITE player ${white.id} (${white.displayName})`);
        }

        // Save for black player
        if (black.id) {
          await firestore.setDocument(`users/${black.id}/matchHistory/${roomId}`, {
            ...sharedMatchData,
            playerColor: 'black',
            opponentId: white.id,
            opponentUsername: white.displayName,
            opponentElo: white.rating,
            playerResult: result === 'black_win' ? 'win' : result === 'white_win' ? 'loss' : 'draw',
            eloChange: blackRatingChange.change,
            eloAfter: blackRatingChange.newRating,
          });
          console.error(`✅ Match history saved for BLACK player ${black.id} (${black.displayName})`);
        }

        console.error(`📝 Server-side match history save COMPLETE for match ${roomId}`);

        // ==================== UPDATE ELO RATINGS (RANKED MATCHES ONLY) ====================
        if (!this.isUnrated) {
          console.error(`📊 Updating ELO ratings for ranked match ${roomId}`);

          // Helper to update a player's rating
          const updatePlayerRating = async (
            playerId: string,
            playerName: string,
            newRating: number,
            isProvisional: boolean,
            isWin: boolean,
            isLoss: boolean,
            isDraw: boolean
          ) => {
            if (!playerId) return;

            const ratingsPath = `users/${playerId}/profile/ratings`;
            const leaderboardPath = `leaderboards/elo/players/${playerId}`;

            try {
              // First, get current stats
              const currentRatings = await firestore.getDocument(ratingsPath);
              const currentLeaderboard = await firestore.getDocument(leaderboardPath);

              const currentGamesPlayed = currentRatings?.gamesPlayed || currentLeaderboard?.totalGames || 0;
              const currentWins = currentRatings?.wins || currentLeaderboard?.wins || 0;
              const currentLosses = currentRatings?.losses || currentLeaderboard?.losses || 0;
              const currentDraws = currentRatings?.draws || currentLeaderboard?.draws || 0;

              const newGamesPlayed = currentGamesPlayed + 1;
              const newWins = isWin ? currentWins + 1 : currentWins;
              const newLosses = isLoss ? currentLosses + 1 : currentLosses;
              const newDraws = isDraw ? currentDraws + 1 : currentDraws;

              // Provisional status ends after 20 games
              const newIsProvisional = isProvisional && newGamesPlayed < 20;

              // Update user's ratings document
              // Field names must match Flutter's PlayerRating model
              await firestore.setDocument(ratingsPath, {
                eloRating: newRating,
                totalGamesPlayed: newGamesPlayed,
                provisionalGames: Math.min(newGamesPlayed, 30), // Cap at 30 for provisional period
                wins: newWins,
                losses: newLosses,
                draws: newDraws,
                // Keep isProvisional for backwards compatibility but Flutter uses provisionalGames
                isProvisional: newIsProvisional,
                // Use Date object so FirestoreClient encodes it as a Firestore Timestamp
                updatedAt: new Date(),
              }, { merge: true });
              console.error(`✅ Updated ratings for ${playerId}: ${newRating} ELO (${newGamesPlayed} games)`);

              // Update leaderboard entry
              await firestore.setDocument(leaderboardPath, {
                eloRating: newRating,
                totalGames: newGamesPlayed,
                wins: newWins,
                losses: newLosses,
                draws: newDraws,
                updatedAt: new Date(),
              }, { merge: true });
              console.error(`✅ Updated leaderboard for ${playerId}`);

            } catch (ratingError) {
              console.error(`❌ Failed to update rating for ${playerId}:`, ratingError);
            }
          };

          // Determine win/loss/draw for each player
          const whiteWon = result === 'white_win';
          const blackWon = result === 'black_win';
          const isDraw = result === 'draw';

          // Update both players' ratings
          await updatePlayerRating(
            white.id,
            white.displayName,
            whiteRatingChange.newRating,
            whiteRatingChange.isProvisional,
            whiteWon,
            blackWon,
            isDraw
          );

          await updatePlayerRating(
            black.id,
            black.displayName,
            blackRatingChange.newRating,
            blackRatingChange.isProvisional,
            blackWon,
            whiteWon,
            isDraw
          );

          console.error(`📊 ELO rating updates COMPLETE for match ${roomId}`);
        } else {
          console.error(`📊 Skipping ELO updates for friendly/unrated match ${roomId}`);
        }
        // ==================== END ELO RATING UPDATES ====================

      } catch (error) {
        console.error(`❌ Failed to save match history to Firestore:`, error);
      }
    };

    // Fire and forget - don't block endGame on Firestore write
    // Using ctx.waitUntil would be ideal but we're in a method, so we just fire-and-forget
    saveMatchHistoryToFirestore();
    // ==================== END SERVER-SIDE MATCH HISTORY SAVE ====================

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

    // Send game_ended to all players with error handling
    console.log(`GameRoom: >>> About to send game_ended to players`);
    for (const p of this.players.values()) {
      try {
        if (p.connected && p.connection) {
          console.log(`GameRoom: Sending game_ended to ${p.id} (${p.color}) - connected: ${p.connected}`);
          p.connection.send(JSON.stringify(gameEndedMessage));
          console.log(`GameRoom: >>> Successfully sent game_ended to ${p.id}`);
        } else {
          console.log(`GameRoom: Skipping game_ended for ${p.id} (${p.color}) - connected: ${p.connected}, hasConnection: ${!!p.connection}`);
        }
      } catch (sendError) {
        console.error(`GameRoom: Error sending game_ended to ${p.id}:`, sendError);
      }
    }

    // Also send legacy system message for backward compatibility
    const systemMessage: GameMessage = {
      type: "system",
      message: `Game ended: ${result} (${reason})`,
      code: "game_ended",
    };

    for (const p of this.players.values()) {
      try {
        if (p.connected && p.connection) {
          p.connection.send(JSON.stringify(systemMessage));
        }
      } catch (e) {
        console.error(`GameRoom: Error sending system message to ${p.id}:`, e);
      }
    }

    // Clean up lobby from LobbyList if this was a lobby game (fire-and-forget)
    console.error(`🏁🏁🏁 GameRoom.endGame LOBBY CLEANUP - isLobbyMode=${this.isLobbyMode}, lobbyId=${this.lobbyId}, timestamp=${Date.now()}`);
    if (this.isLobbyMode && this.lobbyId) {
      const lobbyIdToRemove = this.lobbyId;
      console.error(`🏁🏁🏁 GameRoom.endGame REMOVING LOBBY - lobbyId=${lobbyIdToRemove}`);
      (async () => {
        try {
          console.error(`🏁🏁🏁 ASYNC LOBBY CLEANUP: About to fetch DELETE for ${lobbyIdToRemove}`);
          const lobbyListId = this.env.LOBBY_LIST.idFromName('global');
          const lobbyListStub = this.env.LOBBY_LIST.get(lobbyListId);

          await lobbyListStub.fetch(new Request(`https://lobby-list/remove/${lobbyIdToRemove}`, {
            method: 'DELETE',
          }));
          console.error(`🏁🏁🏁 GameRoom: Lobby ${lobbyIdToRemove} removed from LobbyList after game end`);
        } catch (error) {
          console.error(`GameRoom: Failed to remove lobby ${lobbyIdToRemove} from LobbyList:`, error);
        }
      })();
    }

    console.error(`✅✅✅ GameRoom.endGame FUNCTION COMPLETE - gameStatus=${this.gameStatus}, timestamp=${Date.now()}`);
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

  /**
   * Generate PGN notation from move history
   */
  private generatePgn(): string {
    if (!this.moveHistory || this.moveHistory.length === 0) return '';

    let pgn = '';
    for (let i = 0; i < this.moveHistory.length; i++) {
      const move = this.moveHistory[i];
      // Use SAN notation if available, otherwise UCI
      const notation = move.san || move.uci;
      if (i % 2 === 0) {
        // White's move - add move number
        pgn += `${Math.floor(i / 2) + 1}. ${notation} `;
      } else {
        // Black's move
        pgn += `${notation} `;
      }
    }
    return pgn.trim();
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

  // Broadcast spectator count to all connected clients (players and spectators)
  private broadcastSpectatorCount(): void {
    const message = JSON.stringify({
      type: "spectator_count",
      count: this.spectators.size,
      timestamp: Date.now(),
    });

    // Send to players
    for (const player of this.players.values()) {
      if (player.connected && player.connection) {
        try {
          player.connection.send(message);
        } catch (error) {
          console.error(`GameRoom: Error sending spectator count to player ${player.id}:`, error);
        }
      }
    }

    // Send to spectators
    for (const spectator of this.spectators.values()) {
      if (spectator.connection) {
        try {
          spectator.connection.send(message);
        } catch (error) {
          console.error(`GameRoom: Error sending spectator count to spectator ${spectator.id}:`, error);
        }
      }
    }

    console.log(`GameRoom: Broadcast spectator count: ${this.spectators.size}`);
  }
}
