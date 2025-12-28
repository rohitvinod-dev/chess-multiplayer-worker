/**
 * Unit Tests: LobbyRoom Durable Object
 *
 * Tests the LobbyRoom Durable Object in isolation, focusing on:
 * - Lobby initialization and state management
 * - Join flow and race condition handling
 * - Timeout and alarm handling
 * - WebSocket message handling
 * - Cleanup and cancellation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MockConnection,
  MockStorage,
  MockDurableObjectNamespace,
  createMockRequest,
  createMockGameRoom,
  createMockLobbyList,
} from '../helpers/mocks';

// ============================================================================
// Test Setup: Mock LobbyRoom Class
// ============================================================================

interface LobbySettings {
  playerColor: string;
  gameMode: string;
  isPrivate: boolean;
  allowSpectators: boolean;
  maxSpectators: number;
  openingId?: string;
  openingName?: string;
  openingFen?: string;
}

interface LobbyParticipant {
  id: string;
  displayName: string;
  rating: number;
  isProvisional: boolean;
  connection?: MockConnection;
  connectedAt: number;
}

/**
 * Testable version of LobbyRoom that doesn't extend Server
 * This allows us to test the core logic without partyserver dependencies
 */
class TestableLobbyRoom {
  // Storage
  storage: MockStorage;
  env: any;

  // Lobby state
  lobbyId: string = '';
  creatorId: string = '';
  creator?: LobbyParticipant;
  opponent?: LobbyParticipant;
  settings: LobbySettings = {
    playerColor: 'random',
    gameMode: 'blitz',
    isPrivate: false,
    allowSpectators: true,
    maxSpectators: 50,
  };
  status: 'waiting' | 'matched' | 'cancelled' = 'waiting';
  createdAt: number = Date.now();
  gameRoomId?: string;
  gameWebSocketUrl?: string;

  maxWaitTimeMs = 10 * 1000; // 10 seconds for testing

  constructor(env: any) {
    this.storage = new MockStorage();
    this.env = env;
  }

  // ========== Initialization ==========

  async handleInit(request: Request): Promise<Response> {
    try {
      const data = await request.json() as {
        lobbyId: string;
        creatorId: string;
        creatorDisplayName: string;
        creatorRating: number;
        isProvisional: boolean;
        settings: LobbySettings;
      };

      this.lobbyId = data.lobbyId;
      this.creatorId = data.creatorId;
      this.creator = {
        id: data.creatorId,
        displayName: data.creatorDisplayName,
        rating: data.creatorRating,
        isProvisional: data.isProvisional,
        connectedAt: Date.now(),
      };
      this.settings = data.settings;
      this.status = 'waiting';
      this.createdAt = Date.now();

      await this.persist();
      await this.storage.setAlarm(Date.now() + this.maxWaitTimeMs);

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: 'Failed to initialize lobby' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // ========== Join Flow ==========

  async handleJoin(request: Request): Promise<Response> {
    try {
      const data = await request.json() as {
        playerId: string;
        displayName: string;
        rating: number;
        isProvisional: boolean;
      };

      if (this.status !== 'waiting') {
        return new Response(JSON.stringify({ error: 'Lobby is not waiting' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Store opponent info
      this.opponent = {
        id: data.playerId,
        displayName: data.displayName,
        rating: data.rating,
        isProvisional: data.isProvisional,
        connectedAt: Date.now(),
      };

      // IMPORTANT: Set status to 'matched' IMMEDIATELY to prevent race condition
      this.status = 'matched';
      await this.persist();

      // Clear the timeout alarm since we're matching
      await this.storage.deleteAlarm();

      // Notify creator via WebSocket (if connected)
      if (this.creator?.connection) {
        this.creator.connection.send(JSON.stringify({
          type: 'opponent_joined',
          opponentName: data.displayName,
          opponent: {
            id: data.playerId,
            displayName: data.displayName,
            rating: data.rating,
            isProvisional: data.isProvisional,
          },
        }));
      }

      // Create game room
      await this.createGameRoom();

      // Notify creator that match is ready
      if (this.creator?.connection) {
        const creatorColor = this.determinePlayerColor(true);

        this.creator.connection.send(JSON.stringify({
          type: 'match_ready',
          roomId: this.gameRoomId,
          webSocketUrl: this.gameWebSocketUrl,
          playerColor: creatorColor,
          opponent: {
            id: this.opponent.id,
            displayName: this.opponent.displayName,
            rating: this.opponent.rating,
          },
        }));
      }

      // Return game info to joining player
      const opponentColor = this.determinePlayerColor(false);
      return new Response(JSON.stringify({
        success: true,
        roomId: this.gameRoomId,
        webSocketUrl: this.gameWebSocketUrl,
        playerColor: opponentColor,
        opponent: {
          id: this.creator!.id,
          displayName: this.creator!.displayName,
          rating: this.creator!.rating,
        },
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: 'Failed to join lobby' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // ========== WebSocket Handlers ==========

  async onConnect(connection: MockConnection, userId: string): Promise<void> {
    if (this.status === 'cancelled') {
      connection.send(JSON.stringify({
        type: 'lobby_cancelled',
        reason: 'Lobby has been cancelled',
      }));
      connection.close(1000, 'Lobby cancelled');
      return;
    }

    if (userId === this.creatorId && this.creator) {
      this.creator.connection = connection;
      this.sendStatusUpdate(connection);
    } else if (this.opponent && userId === this.opponent.id) {
      this.opponent.connection = connection;
    } else {
      connection.send(JSON.stringify({
        type: 'error',
        message: 'You are not part of this lobby',
      }));
      connection.close(1008, 'Unauthorized');
    }
  }

  async onClose(connection: MockConnection): Promise<void> {
    // If creator disconnects while waiting, cancel the lobby
    if (this.creator?.connection === connection && this.status === 'waiting') {
      await this.cancelAndRemoveFromList('Creator disconnected');
      this.creator.connection = undefined;
      return;
    }

    // Remove connection reference
    if (this.creator?.connection === connection) {
      this.creator.connection = undefined;
    }
    if (this.opponent?.connection === connection) {
      this.opponent.connection = undefined;
    }
  }

  // ========== Alarm (Timeout) ==========

  async alarm(): Promise<void> {
    if (this.status !== 'waiting') {
      return;
    }

    const elapsed = Date.now() - this.createdAt;
    if (elapsed >= this.maxWaitTimeMs) {
      await this.cancelAndRemoveFromList('No opponent found - lobby timed out');
    } else {
      const remaining = this.maxWaitTimeMs - elapsed;
      await this.storage.setAlarm(Date.now() + remaining);
    }
  }

  // ========== Helper Methods ==========

  private async createGameRoom(): Promise<void> {
    this.gameRoomId = 'game-' + Math.random().toString(36).slice(2);

    // Create GameRoom via Durable Object
    const gameRoomId = this.env.GAME_ROOM.idFromName(this.gameRoomId);
    const gameRoomStub = this.env.GAME_ROOM.get(gameRoomId);

    const creatorColor = this.determinePlayerColor(true);
    const opponentColor = creatorColor === 'white' ? 'black' : 'white';

    await gameRoomStub.fetch(new Request('https://game-room/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gameMode: this.settings.gameMode,
        isLobbyMode: true,
        isUnrated: true,
        players: {
          [creatorColor]: {
            id: this.creator!.id,
            displayName: this.creator!.displayName,
            rating: this.creator!.rating,
            isProvisional: this.creator!.isProvisional,
          },
          [opponentColor]: {
            id: this.opponent!.id,
            displayName: this.opponent!.displayName,
            rating: this.opponent!.rating,
            isProvisional: this.opponent!.isProvisional,
          },
        },
      }),
    }));

    this.gameWebSocketUrl = `wss://test.example.com/parties/game-room/${this.gameRoomId}`;
  }

  private determinePlayerColor(isCreator: boolean): 'white' | 'black' {
    const colorChoice = this.settings.playerColor;

    if (colorChoice === 'random') {
      // For testing, use deterministic random based on lobbyId
      const hash = this.lobbyId.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
      const creatorIsWhite = hash % 2 === 0;
      return isCreator
        ? (creatorIsWhite ? 'white' : 'black')
        : (creatorIsWhite ? 'black' : 'white');
    } else if (colorChoice === 'white') {
      return isCreator ? 'white' : 'black';
    } else {
      return isCreator ? 'black' : 'white';
    }
  }

  private sendStatusUpdate(connection: MockConnection): void {
    connection.send(JSON.stringify({
      type: 'waiting',
      status: this.status,
      createdAt: this.createdAt,
      settings: this.settings,
    }));
  }

  async cancelAndRemoveFromList(reason: string): Promise<void> {
    if (this.status === 'cancelled') {
      return;
    }

    this.status = 'cancelled';
    await this.persist();

    try {
      await this.storage.deleteAlarm();
    } catch (e) {
      // Alarm might already be cleared
    }

    // Notify creator and close connection
    if (this.creator?.connection) {
      this.creator.connection.send(JSON.stringify({
        type: 'lobby_cancelled',
        reason,
      }));
      this.creator.connection.close(1000, reason);
      this.creator.connection = undefined;
    }

    // Remove from LobbyList
    try {
      const lobbyListId = this.env.LOBBY_LIST.idFromName('global');
      const lobbyListStub = this.env.LOBBY_LIST.get(lobbyListId);
      await lobbyListStub.fetch(new Request(`https://lobby-list/remove/${this.lobbyId}`, {
        method: 'DELETE',
      }));
    } catch (error) {
      // Log error but don't fail
    }
  }

  private async persist(): Promise<void> {
    const state = {
      lobbyId: this.lobbyId,
      creatorId: this.creatorId,
      creator: this.creator ? {
        id: this.creator.id,
        displayName: this.creator.displayName,
        rating: this.creator.rating,
        isProvisional: this.creator.isProvisional,
        connectedAt: this.creator.connectedAt,
      } : undefined,
      opponent: this.opponent ? {
        id: this.opponent.id,
        displayName: this.opponent.displayName,
        rating: this.opponent.rating,
        isProvisional: this.opponent.isProvisional,
        connectedAt: this.opponent.connectedAt,
      } : undefined,
      settings: this.settings,
      status: this.status,
      createdAt: this.createdAt,
      gameRoomId: this.gameRoomId,
      webSocketUrl: this.gameWebSocketUrl,
    };

    await this.storage.put('state', state);
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('LobbyRoom Unit Tests', () => {
  let lobbyRoom: TestableLobbyRoom;
  let mockEnv: any;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));

    mockEnv = {
      GAME_ROOM: new MockDurableObjectNamespace((id) => createMockGameRoom(id)),
      LOBBY_LIST: new MockDurableObjectNamespace((id) => createMockLobbyList(id)),
    };

    lobbyRoom = new TestableLobbyRoom(mockEnv);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ==========================================================================
  // Initialization Tests
  // ==========================================================================

  describe('handleInit', () => {
    it('should initialize lobby with correct settings', async () => {
      const request = createMockRequest('/init', {
        lobbyId: 'lobby-123',
        creatorId: 'user-1',
        creatorDisplayName: 'Player1',
        creatorRating: 1500,
        isProvisional: false,
        settings: {
          playerColor: 'white',
          gameMode: 'blitz',
          isPrivate: false,
          allowSpectators: true,
          maxSpectators: 50,
        },
      });

      const response = await lobbyRoom.handleInit(request);
      const body = await response.json();

      expect(body.success).toBe(true);
      expect(lobbyRoom.lobbyId).toBe('lobby-123');
      expect(lobbyRoom.creatorId).toBe('user-1');
      expect(lobbyRoom.status).toBe('waiting');
      expect(lobbyRoom.creator?.displayName).toBe('Player1');
      expect(lobbyRoom.creator?.rating).toBe(1500);
    });

    it('should set timeout alarm on initialization', async () => {
      const request = createMockRequest('/init', {
        lobbyId: 'lobby-123',
        creatorId: 'user-1',
        creatorDisplayName: 'Player1',
        creatorRating: 1500,
        isProvisional: false,
        settings: {
          playerColor: 'random',
          gameMode: 'rapid',
          isPrivate: false,
          allowSpectators: true,
          maxSpectators: 50,
        },
      });

      await lobbyRoom.handleInit(request);

      const alarm = lobbyRoom.storage.getAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm).toBeGreaterThan(Date.now());
    });

    it('should persist state after initialization', async () => {
      const request = createMockRequest('/init', {
        lobbyId: 'lobby-456',
        creatorId: 'user-2',
        creatorDisplayName: 'Player2',
        creatorRating: 1200,
        isProvisional: true,
        settings: {
          playerColor: 'black',
          gameMode: 'bullet',
          isPrivate: true,
          allowSpectators: false,
          maxSpectators: 0,
        },
      });

      await lobbyRoom.handleInit(request);

      const state = await lobbyRoom.storage.get('state');
      expect(state).toBeDefined();
      expect((state as any).lobbyId).toBe('lobby-456');
      expect((state as any).settings.isPrivate).toBe(true);
    });
  });

  // ==========================================================================
  // Join Flow Tests
  // ==========================================================================

  describe('handleJoin', () => {
    beforeEach(async () => {
      // Initialize lobby first
      await lobbyRoom.handleInit(createMockRequest('/init', {
        lobbyId: 'lobby-123',
        creatorId: 'creator-1',
        creatorDisplayName: 'Creator',
        creatorRating: 1500,
        isProvisional: false,
        settings: {
          playerColor: 'random',
          gameMode: 'blitz',
          isPrivate: false,
          allowSpectators: true,
          maxSpectators: 50,
        },
      }));
    });

    it('should allow joining a waiting lobby', async () => {
      const request = createMockRequest('/join', {
        playerId: 'joiner-1',
        displayName: 'Joiner',
        rating: 1450,
        isProvisional: false,
      });

      const response = await lobbyRoom.handleJoin(request);
      const body = await response.json();

      expect(body.success).toBe(true);
      expect(body.roomId).toBeDefined();
      expect(body.webSocketUrl).toBeDefined();
      expect(body.playerColor).toMatch(/white|black/);
      expect(body.opponent.displayName).toBe('Creator');
    });

    it('should set status to matched BEFORE creating game room', async () => {
      let statusDuringGameCreate: string | undefined;

      // Override GameRoom to capture status during creation
      mockEnv.GAME_ROOM = new MockDurableObjectNamespace((id) => ({
        async fetch(request: Request) {
          statusDuringGameCreate = lobbyRoom.status;
          return new Response(JSON.stringify({ success: true }));
        },
      }));

      lobbyRoom = new TestableLobbyRoom(mockEnv);
      await lobbyRoom.handleInit(createMockRequest('/init', {
        lobbyId: 'lobby-123',
        creatorId: 'creator-1',
        creatorDisplayName: 'Creator',
        creatorRating: 1500,
        isProvisional: false,
        settings: {
          playerColor: 'random',
          gameMode: 'blitz',
          isPrivate: false,
          allowSpectators: true,
          maxSpectators: 50,
        },
      }));

      await lobbyRoom.handleJoin(createMockRequest('/join', {
        playerId: 'joiner-1',
        displayName: 'Joiner',
        rating: 1450,
        isProvisional: false,
      }));

      // Status should have been 'matched' during game room creation
      expect(statusDuringGameCreate).toBe('matched');
    });

    it('should clear alarm when matched', async () => {
      await lobbyRoom.handleJoin(createMockRequest('/join', {
        playerId: 'joiner-1',
        displayName: 'Joiner',
        rating: 1450,
        isProvisional: false,
      }));

      const alarm = lobbyRoom.storage.getAlarm();
      expect(alarm).toBeNull();
    });

    it('should notify creator via WebSocket when opponent joins', async () => {
      const creatorConn = new MockConnection('creator-1');
      await lobbyRoom.onConnect(creatorConn, 'creator-1');
      creatorConn.clearMessages(); // Clear 'waiting' message

      await lobbyRoom.handleJoin(createMockRequest('/join', {
        playerId: 'joiner-1',
        displayName: 'Joiner',
        rating: 1450,
        isProvisional: false,
      }));

      const opponentJoined = creatorConn.getMessagesByType('opponent_joined')[0];
      expect(opponentJoined).toBeDefined();
      expect(opponentJoined.opponent.displayName).toBe('Joiner');
      expect(opponentJoined.opponent.rating).toBe(1450);

      const matchReady = creatorConn.getMessagesByType('match_ready')[0];
      expect(matchReady).toBeDefined();
      expect(matchReady.roomId).toBeDefined();
      expect(matchReady.webSocketUrl).toBeDefined();
    });

    it('should reject joining if lobby is already matched', async () => {
      // First join succeeds
      await lobbyRoom.handleJoin(createMockRequest('/join', {
        playerId: 'joiner-1',
        displayName: 'Joiner1',
        rating: 1450,
        isProvisional: false,
      }));

      // Second join should fail
      const response = await lobbyRoom.handleJoin(createMockRequest('/join', {
        playerId: 'joiner-2',
        displayName: 'Joiner2',
        rating: 1400,
        isProvisional: false,
      }));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Lobby is not waiting');
    });

    it('should reject joining if lobby is cancelled', async () => {
      lobbyRoom.status = 'cancelled';

      const response = await lobbyRoom.handleJoin(createMockRequest('/join', {
        playerId: 'joiner-1',
        displayName: 'Joiner',
        rating: 1450,
        isProvisional: false,
      }));

      expect(response.status).toBe(400);
    });

    it('should assign colors based on creator preference (white)', async () => {
      lobbyRoom.settings.playerColor = 'white';

      const response = await lobbyRoom.handleJoin(createMockRequest('/join', {
        playerId: 'joiner-1',
        displayName: 'Joiner',
        rating: 1450,
        isProvisional: false,
      }));

      const body = await response.json();
      expect(body.playerColor).toBe('black'); // Joiner gets black if creator wants white
    });

    it('should assign colors based on creator preference (black)', async () => {
      lobbyRoom.settings.playerColor = 'black';

      const response = await lobbyRoom.handleJoin(createMockRequest('/join', {
        playerId: 'joiner-1',
        displayName: 'Joiner',
        rating: 1450,
        isProvisional: false,
      }));

      const body = await response.json();
      expect(body.playerColor).toBe('white'); // Joiner gets white if creator wants black
    });
  });

  // ==========================================================================
  // Race Condition Tests
  // ==========================================================================

  describe('Race Condition Prevention', () => {
    beforeEach(async () => {
      await lobbyRoom.handleInit(createMockRequest('/init', {
        lobbyId: 'lobby-race',
        creatorId: 'creator-1',
        creatorDisplayName: 'Creator',
        creatorRating: 1500,
        isProvisional: false,
        settings: {
          playerColor: 'random',
          gameMode: 'blitz',
          isPrivate: false,
          allowSpectators: true,
          maxSpectators: 50,
        },
      }));
    });

    it('should NOT cancel lobby if onClose fires after status becomes matched', async () => {
      const creatorConn = new MockConnection('creator-1');
      await lobbyRoom.onConnect(creatorConn, 'creator-1');

      // Join lobby (sets status to matched)
      await lobbyRoom.handleJoin(createMockRequest('/join', {
        playerId: 'joiner-1',
        displayName: 'Joiner',
        rating: 1450,
        isProvisional: false,
      }));

      // Simulate connection close AFTER match
      await lobbyRoom.onClose(creatorConn);

      // Lobby should still be matched, NOT cancelled
      expect(lobbyRoom.status).toBe('matched');
    });

    it('should handle simultaneous join attempts correctly', async () => {
      // Start two join requests "simultaneously"
      const join1Promise = lobbyRoom.handleJoin(createMockRequest('/join', {
        playerId: 'joiner-1',
        displayName: 'Joiner1',
        rating: 1450,
        isProvisional: false,
      }));

      // After first join, status should be 'matched'
      const response1 = await join1Promise;
      expect(lobbyRoom.status).toBe('matched');

      // Second join should fail
      const response2 = await lobbyRoom.handleJoin(createMockRequest('/join', {
        playerId: 'joiner-2',
        displayName: 'Joiner2',
        rating: 1400,
        isProvisional: false,
      }));

      expect(response1.status).toBe(200);
      expect(response2.status).toBe(400);
    });
  });

  // ==========================================================================
  // Timeout Tests
  // ==========================================================================

  describe('Timeout Handling', () => {
    beforeEach(async () => {
      await lobbyRoom.handleInit(createMockRequest('/init', {
        lobbyId: 'lobby-timeout',
        creatorId: 'creator-1',
        creatorDisplayName: 'Creator',
        creatorRating: 1500,
        isProvisional: false,
        settings: {
          playerColor: 'random',
          gameMode: 'blitz',
          isPrivate: false,
          allowSpectators: true,
          maxSpectators: 50,
        },
      }));
    });

    it('should cancel lobby when alarm fires after timeout', async () => {
      // Advance time past timeout
      vi.advanceTimersByTime(15 * 1000); // 15 seconds (past 10 second timeout)

      await lobbyRoom.alarm();

      expect(lobbyRoom.status).toBe('cancelled');
    });

    it('should notify creator when lobby times out', async () => {
      const creatorConn = new MockConnection('creator-1');
      await lobbyRoom.onConnect(creatorConn, 'creator-1');
      creatorConn.clearMessages();

      vi.advanceTimersByTime(15 * 1000);
      await lobbyRoom.alarm();

      const cancelMessage = creatorConn.getMessagesByType('lobby_cancelled')[0];
      expect(cancelMessage).toBeDefined();
      expect(cancelMessage.reason).toContain('timed out');
      expect(creatorConn.closed).toBe(true);
    });

    it('should NOT cancel if alarm fires but lobby is already matched', async () => {
      // Join first
      await lobbyRoom.handleJoin(createMockRequest('/join', {
        playerId: 'joiner-1',
        displayName: 'Joiner',
        rating: 1450,
        isProvisional: false,
      }));

      // Then alarm fires (shouldn't do anything)
      vi.advanceTimersByTime(15 * 1000);
      await lobbyRoom.alarm();

      expect(lobbyRoom.status).toBe('matched'); // Still matched
    });

    it('should reschedule alarm if fired early', async () => {
      // Advance time only halfway
      vi.advanceTimersByTime(5 * 1000); // 5 seconds

      await lobbyRoom.alarm();

      // Should still be waiting
      expect(lobbyRoom.status).toBe('waiting');

      // Should have set a new alarm
      const newAlarm = lobbyRoom.storage.getAlarm();
      expect(newAlarm).not.toBeNull();
    });
  });

  // ==========================================================================
  // WebSocket Handler Tests
  // ==========================================================================

  describe('WebSocket Handlers', () => {
    beforeEach(async () => {
      await lobbyRoom.handleInit(createMockRequest('/init', {
        lobbyId: 'lobby-ws',
        creatorId: 'creator-1',
        creatorDisplayName: 'Creator',
        creatorRating: 1500,
        isProvisional: false,
        settings: {
          playerColor: 'random',
          gameMode: 'blitz',
          isPrivate: false,
          allowSpectators: true,
          maxSpectators: 50,
        },
      }));
    });

    it('should accept creator connection', async () => {
      const creatorConn = new MockConnection('creator-1');
      await lobbyRoom.onConnect(creatorConn, 'creator-1');

      expect(lobbyRoom.creator?.connection).toBe(creatorConn);
      expect(creatorConn.closed).toBe(false);
    });

    it('should send waiting status to creator on connect', async () => {
      const creatorConn = new MockConnection('creator-1');
      await lobbyRoom.onConnect(creatorConn, 'creator-1');

      const waitingMessage = creatorConn.getMessagesByType('waiting')[0];
      expect(waitingMessage).toBeDefined();
      expect(waitingMessage.status).toBe('waiting');
    });

    it('should reject unknown user connections', async () => {
      const unknownConn = new MockConnection('unknown-user');
      await lobbyRoom.onConnect(unknownConn, 'unknown-user');

      const errorMessage = unknownConn.getMessagesByType('error')[0];
      expect(errorMessage).toBeDefined();
      expect(unknownConn.closed).toBe(true);
    });

    it('should cancel lobby when creator disconnects while waiting', async () => {
      const creatorConn = new MockConnection('creator-1');
      await lobbyRoom.onConnect(creatorConn, 'creator-1');

      await lobbyRoom.onClose(creatorConn);

      expect(lobbyRoom.status).toBe('cancelled');
    });

    it('should NOT cancel lobby when creator disconnects after match', async () => {
      const creatorConn = new MockConnection('creator-1');
      await lobbyRoom.onConnect(creatorConn, 'creator-1');

      // Match first
      await lobbyRoom.handleJoin(createMockRequest('/join', {
        playerId: 'joiner-1',
        displayName: 'Joiner',
        rating: 1450,
        isProvisional: false,
      }));

      // Then disconnect
      await lobbyRoom.onClose(creatorConn);

      expect(lobbyRoom.status).toBe('matched'); // Still matched
    });

    it('should handle cancelled lobby on new connection', async () => {
      lobbyRoom.status = 'cancelled';

      const conn = new MockConnection('creator-1');
      await lobbyRoom.onConnect(conn, 'creator-1');

      const cancelMessage = conn.getMessagesByType('lobby_cancelled')[0];
      expect(cancelMessage).toBeDefined();
      expect(conn.closed).toBe(true);
    });
  });

  // ==========================================================================
  // Cleanup Tests
  // ==========================================================================

  describe('Lobby Cleanup', () => {
    beforeEach(async () => {
      await lobbyRoom.handleInit(createMockRequest('/init', {
        lobbyId: 'lobby-cleanup',
        creatorId: 'creator-1',
        creatorDisplayName: 'Creator',
        creatorRating: 1500,
        isProvisional: false,
        settings: {
          playerColor: 'random',
          gameMode: 'blitz',
          isPrivate: false,
          allowSpectators: true,
          maxSpectators: 50,
        },
      }));
    });

    it('should remove lobby from LobbyList when cancelled', async () => {
      // First create the instance by accessing it through the namespace
      const lobbyListId = mockEnv.LOBBY_LIST.idFromName('global');
      await mockEnv.LOBBY_LIST.get(lobbyListId).fetch(
        new Request('https://test.example.com/list')
      );

      const lobbyList = mockEnv.LOBBY_LIST.getInstance('global');
      lobbyList.addLobby({ id: 'lobby-cleanup' });

      await lobbyRoom.cancelAndRemoveFromList('Test cancellation');

      const lobbies = lobbyList.getLobbies();
      expect(lobbies.has('lobby-cleanup')).toBe(false);
    });

    it('should only cancel once (idempotent)', async () => {
      const creatorConn = new MockConnection('creator-1');
      await lobbyRoom.onConnect(creatorConn, 'creator-1');

      await lobbyRoom.cancelAndRemoveFromList('First cancel');
      const messagesAfterFirst = creatorConn.messages.length;

      await lobbyRoom.cancelAndRemoveFromList('Second cancel');
      const messagesAfterSecond = creatorConn.messages.length;

      // Should not send another cancel message
      expect(messagesAfterSecond).toBe(messagesAfterFirst);
    });

    it('should clear alarm on cancellation', async () => {
      await lobbyRoom.cancelAndRemoveFromList('Test cancel');

      const alarm = lobbyRoom.storage.getAlarm();
      expect(alarm).toBeNull();
    });
  });
});
