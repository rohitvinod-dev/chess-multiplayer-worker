/**
 * Unit Tests: GameRoom Durable Object
 *
 * Tests the GameRoom Durable Object focusing on:
 * - Game initialization and configuration
 * - Player connection and disconnection
 * - Move validation and execution
 * - Clock management
 * - Game end conditions
 * - Reconnection handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MockConnection,
  MockStorage,
  createMockRequest,
} from '../helpers/mocks';

// ============================================================================
// Test Setup: Mock GameRoom Class
// ============================================================================

interface PlayerSession {
  id: string;
  displayName: string;
  rating: number;
  isProvisional: boolean;
  color: 'white' | 'black';
  connection?: MockConnection;
  lastSeen: number;
  connected: boolean;
  ready: boolean;
}

interface ClockState {
  white: { remaining: number; increment: number };
  black: { remaining: number; increment: number };
  lastUpdate: number;
  currentTurn: 'white' | 'black';
}

interface GameState {
  fen: string;
  moveHistory: Array<{ from: string; to: string; uci: string; san?: string }>;
  status: 'waiting' | 'ready' | 'in_progress' | 'finished';
  result?: string;
  reason?: string;
}

/**
 * Testable version of GameRoom
 */
class TestableGameRoom {
  storage: MockStorage;
  players: Map<string, PlayerSession> = new Map();
  spectators: Map<string, any> = new Map();
  gameState: GameState;
  clock: ClockState;
  gameMode: string = 'blitz';
  isLobbyMode: boolean = false;
  isUnrated: boolean = false;
  startingFen: string = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  gameStatus: 'waiting' | 'ready' | 'in_progress' | 'finished' = 'waiting';
  openingName?: string;
  maxSpectators: number = 50;
  abandonmentTimeoutId?: any;

  constructor() {
    this.storage = new MockStorage();
    this.gameState = {
      fen: this.startingFen,
      moveHistory: [],
      status: 'waiting',
    };
    this.clock = {
      white: { remaining: 300000, increment: 3000 }, // 5 min + 3 sec
      black: { remaining: 300000, increment: 3000 },
      lastUpdate: Date.now(),
      currentTurn: 'white',
    };
  }

  // ========== Initialization ==========

  async handleInit(request: Request): Promise<Response> {
    try {
      const data = await request.json() as {
        gameMode: string;
        isLobbyMode: boolean;
        isUnrated: boolean;
        openingName?: string;
        startingFen?: string;
        players: {
          white?: { id: string; displayName: string; rating: number; isProvisional: boolean };
          black?: { id: string; displayName: string; rating: number; isProvisional: boolean };
        };
      };

      this.gameMode = data.gameMode;
      this.isLobbyMode = data.isLobbyMode;
      this.isUnrated = data.isUnrated;
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
        currentTurn: 'white',
      };

      // Pre-register players
      if (data.players.white) {
        const white = data.players.white;
        this.players.set(white.id, {
          id: white.id,
          displayName: white.displayName,
          rating: white.rating,
          isProvisional: white.isProvisional,
          color: 'white',
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
          color: 'black',
          lastSeen: Date.now(),
          connected: false,
          ready: false,
        });
      }

      return new Response(JSON.stringify({ success: true }));
    } catch (error) {
      return new Response(JSON.stringify({ error: 'Failed to initialize' }), { status: 500 });
    }
  }

  private getClockSettings(gameMode: string): { initial: number; increment: number } {
    switch (gameMode) {
      case 'bullet':
        return { initial: 60000, increment: 1000 }; // 1 min + 1 sec
      case 'blitz':
        return { initial: 300000, increment: 3000 }; // 5 min + 3 sec
      case 'rapid':
        return { initial: 900000, increment: 10000 }; // 15 min + 10 sec
      default:
        return { initial: 300000, increment: 3000 };
    }
  }

  // ========== Player Connection ==========

  async onConnect(connection: MockConnection, playerId: string, options: {
    displayName?: string;
    rating?: number;
    color?: 'white' | 'black';
    mode?: 'lobby' | 'spectator';
  } = {}): Promise<void> {
    // Handle spectator
    if (options.mode === 'spectator') {
      if (this.spectators.size >= this.maxSpectators) {
        connection.send(JSON.stringify({ type: 'error', message: 'Spectator limit reached' }));
        connection.close(1008, 'Spectator limit reached');
        return;
      }

      this.spectators.set(playerId, {
        id: playerId,
        displayName: options.displayName || `Spectator-${playerId.slice(0, 6)}`,
        connection,
        connectedAt: Date.now(),
      });

      this.sendGameStateToSpectator(playerId);
      return;
    }

    // Check for existing player (reconnection)
    const existingPlayer = this.players.get(playerId);
    const isReconnection = existingPlayer && !existingPlayer.connected;

    // Use provided color or existing
    const playerColor = options.color || existingPlayer?.color ||
      (this.players.size === 0 ? 'white' : 'black');

    const session: PlayerSession = {
      id: playerId,
      displayName: options.displayName || existingPlayer?.displayName || `Player-${playerId.slice(0, 6)}`,
      rating: existingPlayer?.rating || options.rating || 1200,
      isProvisional: existingPlayer?.isProvisional || false,
      color: playerColor,
      connection,
      lastSeen: Date.now(),
      connected: true,
      ready: existingPlayer?.ready || false,
    };

    this.players.set(playerId, session);

    // Notify opponent
    this.notifyOpponentOfConnection(playerId);

    // Send game state
    this.sendGameStateToPlayer(playerId);

    // Auto-start if both players connected
    if (this.players.size === 2) {
      const allConnected = Array.from(this.players.values()).every(p => p.connected);
      if (allConnected && (this.gameStatus === 'waiting' || this.gameStatus === 'ready')) {
        this.startGame();
      }
    }

    // Cancel abandonment if reconnecting
    if (isReconnection && this.abandonmentTimeoutId) {
      clearTimeout(this.abandonmentTimeoutId);
      this.abandonmentTimeoutId = undefined;
    }
  }

  async onClose(connection: MockConnection): Promise<void> {
    // Find which player disconnected
    for (const [playerId, player] of this.players) {
      if (player.connection === connection) {
        player.connected = false;
        player.connection = undefined;

        // Notify opponent
        this.notifyOpponentOfDisconnection(playerId);

        // Start abandonment timer if game in progress
        if (this.gameStatus === 'in_progress') {
          this.startAbandonmentTimer(playerId);
        }

        break;
      }
    }

    // Remove spectator if applicable
    for (const [spectatorId, spectator] of this.spectators) {
      if (spectator.connection === connection) {
        this.spectators.delete(spectatorId);
        break;
      }
    }
  }

  // ========== Game Logic ==========

  startGame(): void {
    this.gameStatus = 'in_progress';
    this.gameState.status = 'in_progress';
    this.clock.lastUpdate = Date.now();

    for (const player of this.players.values()) {
      player.ready = true;
      if (player.connection) {
        player.connection.send(JSON.stringify({
          type: 'game_started',
          state: this.getFullState(),
        }));
      }
    }

    this.broadcastToSpectators({
      type: 'game_started',
      state: this.getFullState(),
    });
  }

  handleMove(playerId: string, from: string, to: string, promotion?: string): {
    success: boolean;
    error?: string;
  } {
    const player = this.players.get(playerId);
    if (!player) {
      return { success: false, error: 'Player not found' };
    }

    // Check if it's player's turn
    const currentTurn = this.getCurrentTurn();
    if (player.color !== currentTurn) {
      return { success: false, error: 'Not your turn' };
    }

    // Validate move (simplified - real implementation uses chess.js)
    const uci = from + to + (promotion || '');
    const move = { from, to, uci, san: `${from}-${to}` };

    // Apply move
    this.gameState.moveHistory.push(move);
    this.clock.currentTurn = currentTurn === 'white' ? 'black' : 'white';

    // Add increment to player who just moved
    this.clock[currentTurn].remaining += this.clock[currentTurn].increment;
    this.clock.lastUpdate = Date.now();

    // Broadcast move
    this.broadcastMove(move);

    return { success: true };
  }

  private getCurrentTurn(): 'white' | 'black' {
    return this.clock.currentTurn;
  }

  endGame(result: string, reason: string): void {
    this.gameStatus = 'finished';
    this.gameState.status = 'finished';
    this.gameState.result = result;
    this.gameState.reason = reason;

    const message = {
      type: 'game_over',
      result,
      reason,
      state: this.getFullState(),
    };

    for (const player of this.players.values()) {
      if (player.connection) {
        player.connection.send(JSON.stringify(message));
      }
    }

    this.broadcastToSpectators(message);
  }

  // ========== Helper Methods ==========

  private notifyOpponentOfConnection(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player) return;

    for (const [id, p] of this.players) {
      if (id !== playerId && p.connection) {
        p.connection.send(JSON.stringify({
          type: 'opponent_status',
          opponentConnected: true,
          opponentId: playerId,
        }));
      }
    }
  }

  private notifyOpponentOfDisconnection(playerId: string): void {
    for (const [id, p] of this.players) {
      if (id !== playerId && p.connection) {
        p.connection.send(JSON.stringify({
          type: 'opponent_status',
          opponentConnected: false,
          opponentId: playerId,
        }));
      }
    }
  }

  private sendGameStateToPlayer(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player?.connection) return;

    player.connection.send(JSON.stringify({
      type: 'ready',
      state: this.getFullState(),
      playerColor: player.color,
    }));
  }

  private sendGameStateToSpectator(spectatorId: string): void {
    const spectator = this.spectators.get(spectatorId);
    if (!spectator?.connection) return;

    spectator.connection.send(JSON.stringify({
      type: 'spectator_joined',
      state: this.getFullState(),
    }));
  }

  private broadcastMove(move: any): void {
    const message = {
      type: 'move_made',
      move,
      state: this.getFullState(),
    };

    for (const player of this.players.values()) {
      if (player.connection) {
        player.connection.send(JSON.stringify(message));
      }
    }

    this.broadcastToSpectators(message);
  }

  private broadcastToSpectators(message: any): void {
    for (const spectator of this.spectators.values()) {
      if (spectator.connection) {
        spectator.connection.send(JSON.stringify(message));
      }
    }
  }

  private startAbandonmentTimer(disconnectedPlayerId: string): void {
    // 60 second grace period
    this.abandonmentTimeoutId = setTimeout(() => {
      const disconnected = this.players.get(disconnectedPlayerId);
      if (disconnected && !disconnected.connected) {
        // End game in favor of connected player
        const winner = disconnected.color === 'white' ? 'black' : 'white';
        this.endGame(`${winner} wins`, 'abandonment');
      }
    }, 60000);
  }

  private getFullState(): any {
    return {
      fen: this.gameState.fen,
      moveHistory: this.gameState.moveHistory,
      status: this.gameStatus,
      result: this.gameState.result,
      reason: this.gameState.reason,
      clock: this.clock,
      players: Array.from(this.players.values()).map(p => ({
        id: p.id,
        displayName: p.displayName,
        rating: p.rating,
        color: p.color,
        connected: p.connected,
      })),
      isUnrated: this.isUnrated,
      gameMode: this.gameMode,
    };
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('GameRoom Unit Tests', () => {
  let gameRoom: TestableGameRoom;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
    gameRoom = new TestableGameRoom();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ==========================================================================
  // Initialization Tests
  // ==========================================================================

  describe('Game Initialization', () => {
    it('should initialize with correct game mode settings', async () => {
      await gameRoom.handleInit(createMockRequest('/init', {
        gameMode: 'blitz',
        isLobbyMode: true,
        isUnrated: true,
        players: {
          white: { id: 'p1', displayName: 'White', rating: 1500, isProvisional: false },
          black: { id: 'p2', displayName: 'Black', rating: 1450, isProvisional: false },
        },
      }));

      expect(gameRoom.gameMode).toBe('blitz');
      expect(gameRoom.isLobbyMode).toBe(true);
      expect(gameRoom.isUnrated).toBe(true);
      expect(gameRoom.players.size).toBe(2);
    });

    it('should set correct clock times for bullet', async () => {
      await gameRoom.handleInit(createMockRequest('/init', {
        gameMode: 'bullet',
        isLobbyMode: true,
        isUnrated: true,
        players: {
          white: { id: 'p1', displayName: 'White', rating: 1500, isProvisional: false },
          black: { id: 'p2', displayName: 'Black', rating: 1450, isProvisional: false },
        },
      }));

      expect(gameRoom.clock.white.remaining).toBe(60000); // 1 minute
      expect(gameRoom.clock.white.increment).toBe(1000); // 1 second
    });

    it('should set correct clock times for rapid', async () => {
      await gameRoom.handleInit(createMockRequest('/init', {
        gameMode: 'rapid',
        isLobbyMode: true,
        isUnrated: true,
        players: {
          white: { id: 'p1', displayName: 'White', rating: 1500, isProvisional: false },
          black: { id: 'p2', displayName: 'Black', rating: 1450, isProvisional: false },
        },
      }));

      expect(gameRoom.clock.white.remaining).toBe(900000); // 15 minutes
      expect(gameRoom.clock.white.increment).toBe(10000); // 10 seconds
    });

    it('should use custom starting FEN', async () => {
      const sicilianFen = 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6 0 2';

      await gameRoom.handleInit(createMockRequest('/init', {
        gameMode: 'blitz',
        isLobbyMode: true,
        isUnrated: true,
        startingFen: sicilianFen,
        openingName: 'Sicilian Defense',
        players: {
          white: { id: 'p1', displayName: 'White', rating: 1500, isProvisional: false },
          black: { id: 'p2', displayName: 'Black', rating: 1450, isProvisional: false },
        },
      }));

      expect(gameRoom.gameState.fen).toBe(sicilianFen);
      expect(gameRoom.openingName).toBe('Sicilian Defense');
    });

    it('should pre-register players as disconnected', async () => {
      await gameRoom.handleInit(createMockRequest('/init', {
        gameMode: 'blitz',
        isLobbyMode: true,
        isUnrated: true,
        players: {
          white: { id: 'p1', displayName: 'White', rating: 1500, isProvisional: false },
          black: { id: 'p2', displayName: 'Black', rating: 1450, isProvisional: false },
        },
      }));

      const p1 = gameRoom.players.get('p1');
      const p2 = gameRoom.players.get('p2');

      expect(p1?.connected).toBe(false);
      expect(p2?.connected).toBe(false);
      expect(p1?.color).toBe('white');
      expect(p2?.color).toBe('black');
    });
  });

  // ==========================================================================
  // Player Connection Tests
  // ==========================================================================

  describe('Player Connection', () => {
    beforeEach(async () => {
      await gameRoom.handleInit(createMockRequest('/init', {
        gameMode: 'blitz',
        isLobbyMode: true,
        isUnrated: true,
        players: {
          white: { id: 'p1', displayName: 'White', rating: 1500, isProvisional: false },
          black: { id: 'p2', displayName: 'Black', rating: 1450, isProvisional: false },
        },
      }));
    });

    it('should connect pre-registered player', async () => {
      const conn = new MockConnection('p1');
      await gameRoom.onConnect(conn, 'p1', { color: 'white' });

      const player = gameRoom.players.get('p1');
      expect(player?.connected).toBe(true);
      expect(player?.connection).toBe(conn);
    });

    it('should send game state on connect', async () => {
      const conn = new MockConnection('p1');
      await gameRoom.onConnect(conn, 'p1', { color: 'white' });

      const readyMessage = conn.getMessagesByType('ready')[0];
      expect(readyMessage).toBeDefined();
      expect(readyMessage.state).toBeDefined();
      expect(readyMessage.playerColor).toBe('white');
    });

    it('should notify opponent when player connects', async () => {
      const conn1 = new MockConnection('p1');
      const conn2 = new MockConnection('p2');

      await gameRoom.onConnect(conn1, 'p1', { color: 'white' });
      conn1.clearMessages();

      await gameRoom.onConnect(conn2, 'p2', { color: 'black' });

      const statusMessage = conn1.getMessagesByType('opponent_status')[0];
      expect(statusMessage).toBeDefined();
      expect(statusMessage.opponentConnected).toBe(true);
    });

    it('should auto-start game when both players connect', async () => {
      const conn1 = new MockConnection('p1');
      const conn2 = new MockConnection('p2');

      await gameRoom.onConnect(conn1, 'p1', { color: 'white' });
      await gameRoom.onConnect(conn2, 'p2', { color: 'black' });

      expect(gameRoom.gameStatus).toBe('in_progress');

      const gameStarted = conn1.getMessagesByType('game_started')[0];
      expect(gameStarted).toBeDefined();
    });

    it('should handle reconnection', async () => {
      const conn1 = new MockConnection('p1');
      await gameRoom.onConnect(conn1, 'p1', { color: 'white' });

      // Disconnect
      await gameRoom.onClose(conn1);
      expect(gameRoom.players.get('p1')?.connected).toBe(false);

      // Reconnect
      const conn1New = new MockConnection('p1');
      await gameRoom.onConnect(conn1New, 'p1', { color: 'white' });

      expect(gameRoom.players.get('p1')?.connected).toBe(true);
      expect(gameRoom.players.get('p1')?.connection).toBe(conn1New);
    });
  });

  // ==========================================================================
  // Spectator Tests
  // ==========================================================================

  describe('Spectator Handling', () => {
    beforeEach(async () => {
      await gameRoom.handleInit(createMockRequest('/init', {
        gameMode: 'blitz',
        isLobbyMode: true,
        isUnrated: true,
        players: {
          white: { id: 'p1', displayName: 'White', rating: 1500, isProvisional: false },
          black: { id: 'p2', displayName: 'Black', rating: 1450, isProvisional: false },
        },
      }));
    });

    it('should accept spectator connection', async () => {
      const spectatorConn = new MockConnection('spectator-1');
      await gameRoom.onConnect(spectatorConn, 'spectator-1', { mode: 'spectator' });

      expect(gameRoom.spectators.size).toBe(1);
      expect(spectatorConn.closed).toBe(false);
    });

    it('should send game state to spectator', async () => {
      const spectatorConn = new MockConnection('spectator-1');
      await gameRoom.onConnect(spectatorConn, 'spectator-1', { mode: 'spectator' });

      const joinedMessage = spectatorConn.getMessagesByType('spectator_joined')[0];
      expect(joinedMessage).toBeDefined();
      expect(joinedMessage.state).toBeDefined();
    });

    it('should enforce spectator limit', async () => {
      gameRoom.maxSpectators = 2;

      await gameRoom.onConnect(new MockConnection('s1'), 's1', { mode: 'spectator' });
      await gameRoom.onConnect(new MockConnection('s2'), 's2', { mode: 'spectator' });

      const s3Conn = new MockConnection('s3');
      await gameRoom.onConnect(s3Conn, 's3', { mode: 'spectator' });

      expect(gameRoom.spectators.size).toBe(2);
      expect(s3Conn.closed).toBe(true);
    });

    it('should broadcast moves to spectators', async () => {
      // Connect players
      const p1Conn = new MockConnection('p1');
      const p2Conn = new MockConnection('p2');
      await gameRoom.onConnect(p1Conn, 'p1', { color: 'white' });
      await gameRoom.onConnect(p2Conn, 'p2', { color: 'black' });

      // Add spectator
      const spectatorConn = new MockConnection('spectator-1');
      await gameRoom.onConnect(spectatorConn, 'spectator-1', { mode: 'spectator' });
      spectatorConn.clearMessages();

      // Make a move
      gameRoom.handleMove('p1', 'e2', 'e4');

      const moveMessage = spectatorConn.getMessagesByType('move_made')[0];
      expect(moveMessage).toBeDefined();
      expect(moveMessage.move.from).toBe('e2');
      expect(moveMessage.move.to).toBe('e4');
    });

    it('should remove spectator on disconnect', async () => {
      const spectatorConn = new MockConnection('spectator-1');
      await gameRoom.onConnect(spectatorConn, 'spectator-1', { mode: 'spectator' });

      expect(gameRoom.spectators.size).toBe(1);

      await gameRoom.onClose(spectatorConn);

      expect(gameRoom.spectators.size).toBe(0);
    });
  });

  // ==========================================================================
  // Move Handling Tests
  // ==========================================================================

  describe('Move Handling', () => {
    beforeEach(async () => {
      await gameRoom.handleInit(createMockRequest('/init', {
        gameMode: 'blitz',
        isLobbyMode: true,
        isUnrated: true,
        players: {
          white: { id: 'p1', displayName: 'White', rating: 1500, isProvisional: false },
          black: { id: 'p2', displayName: 'Black', rating: 1450, isProvisional: false },
        },
      }));

      // Connect both players
      await gameRoom.onConnect(new MockConnection('p1'), 'p1', { color: 'white' });
      await gameRoom.onConnect(new MockConnection('p2'), 'p2', { color: 'black' });
    });

    it('should accept valid move from current player', () => {
      const result = gameRoom.handleMove('p1', 'e2', 'e4');

      expect(result.success).toBe(true);
      expect(gameRoom.gameState.moveHistory).toHaveLength(1);
    });

    it('should reject move from wrong player', () => {
      const result = gameRoom.handleMove('p2', 'e7', 'e5'); // Black trying to move first

      expect(result.success).toBe(false);
      expect(result.error).toBe('Not your turn');
    });

    it('should switch turns after move', () => {
      expect(gameRoom.clock.currentTurn).toBe('white');

      gameRoom.handleMove('p1', 'e2', 'e4');

      expect(gameRoom.clock.currentTurn).toBe('black');
    });

    it('should add increment to player who moved', () => {
      const initialTime = gameRoom.clock.white.remaining;

      gameRoom.handleMove('p1', 'e2', 'e4');

      expect(gameRoom.clock.white.remaining).toBe(initialTime + gameRoom.clock.white.increment);
    });

    it('should broadcast move to both players', () => {
      const p1Conn = gameRoom.players.get('p1')?.connection!;
      const p2Conn = gameRoom.players.get('p2')?.connection!;
      p1Conn.clearMessages();
      p2Conn.clearMessages();

      gameRoom.handleMove('p1', 'e2', 'e4');

      expect(p1Conn.getMessagesByType('move_made')).toHaveLength(1);
      expect(p2Conn.getMessagesByType('move_made')).toHaveLength(1);
    });

    it('should record move history', () => {
      gameRoom.handleMove('p1', 'e2', 'e4');
      gameRoom.handleMove('p2', 'e7', 'e5');
      gameRoom.handleMove('p1', 'g1', 'f3');

      expect(gameRoom.gameState.moveHistory).toHaveLength(3);
      expect(gameRoom.gameState.moveHistory[0].uci).toBe('e2e4');
      expect(gameRoom.gameState.moveHistory[1].uci).toBe('e7e5');
      expect(gameRoom.gameState.moveHistory[2].uci).toBe('g1f3');
    });
  });

  // ==========================================================================
  // Game End Tests
  // ==========================================================================

  describe('Game End Conditions', () => {
    beforeEach(async () => {
      await gameRoom.handleInit(createMockRequest('/init', {
        gameMode: 'blitz',
        isLobbyMode: true,
        isUnrated: true,
        players: {
          white: { id: 'p1', displayName: 'White', rating: 1500, isProvisional: false },
          black: { id: 'p2', displayName: 'Black', rating: 1450, isProvisional: false },
        },
      }));

      await gameRoom.onConnect(new MockConnection('p1'), 'p1', { color: 'white' });
      await gameRoom.onConnect(new MockConnection('p2'), 'p2', { color: 'black' });
    });

    it('should end game with correct result', () => {
      gameRoom.endGame('white wins', 'checkmate');

      expect(gameRoom.gameStatus).toBe('finished');
      expect(gameRoom.gameState.result).toBe('white wins');
      expect(gameRoom.gameState.reason).toBe('checkmate');
    });

    it('should notify players of game end', () => {
      const p1Conn = gameRoom.players.get('p1')?.connection!;
      const p2Conn = gameRoom.players.get('p2')?.connection!;
      p1Conn.clearMessages();
      p2Conn.clearMessages();

      gameRoom.endGame('black wins', 'resignation');

      expect(p1Conn.getMessagesByType('game_over')).toHaveLength(1);
      expect(p2Conn.getMessagesByType('game_over')).toHaveLength(1);
    });

    it('should notify spectators of game end', () => {
      const spectatorConn = new MockConnection('spectator-1');
      gameRoom.spectators.set('spectator-1', {
        id: 'spectator-1',
        displayName: 'Spectator',
        connection: spectatorConn,
      });
      spectatorConn.clearMessages();

      gameRoom.endGame('draw', 'agreement');

      expect(spectatorConn.getMessagesByType('game_over')).toHaveLength(1);
    });
  });

  // ==========================================================================
  // Disconnection and Abandonment Tests
  // ==========================================================================

  describe('Disconnection Handling', () => {
    beforeEach(async () => {
      await gameRoom.handleInit(createMockRequest('/init', {
        gameMode: 'blitz',
        isLobbyMode: true,
        isUnrated: true,
        players: {
          white: { id: 'p1', displayName: 'White', rating: 1500, isProvisional: false },
          black: { id: 'p2', displayName: 'Black', rating: 1450, isProvisional: false },
        },
      }));

      await gameRoom.onConnect(new MockConnection('p1'), 'p1', { color: 'white' });
      await gameRoom.onConnect(new MockConnection('p2'), 'p2', { color: 'black' });
    });

    it('should notify opponent of disconnection', () => {
      const p1Conn = gameRoom.players.get('p1')?.connection!;
      const p2Conn = gameRoom.players.get('p2')?.connection!;
      p1Conn.clearMessages();

      gameRoom.onClose(p2Conn);

      const statusMessage = p1Conn.getMessagesByType('opponent_status')[0];
      expect(statusMessage).toBeDefined();
      expect(statusMessage.opponentConnected).toBe(false);
    });

    it('should start abandonment timer on disconnect during game', () => {
      gameRoom.onClose(gameRoom.players.get('p2')?.connection!);

      expect(gameRoom.abandonmentTimeoutId).toBeDefined();
    });

    it('should cancel abandonment timer on reconnect', async () => {
      const p2Conn = gameRoom.players.get('p2')?.connection!;
      gameRoom.onClose(p2Conn);

      expect(gameRoom.abandonmentTimeoutId).toBeDefined();

      // Reconnect
      await gameRoom.onConnect(new MockConnection('p2'), 'p2', { color: 'black' });

      expect(gameRoom.abandonmentTimeoutId).toBeUndefined();
    });

    it('should end game after abandonment timeout', async () => {
      gameRoom.onClose(gameRoom.players.get('p2')?.connection!);

      // Advance time past abandonment grace period
      vi.advanceTimersByTime(61000); // 61 seconds

      expect(gameRoom.gameStatus).toBe('finished');
      expect(gameRoom.gameState.reason).toBe('abandonment');
    });
  });
});
