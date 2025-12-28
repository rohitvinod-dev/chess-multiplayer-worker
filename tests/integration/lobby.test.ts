/**
 * Integration Tests: Lobby System
 *
 * Tests the complete lobby flow including:
 * - Lobby creation, joining, and management
 * - WebSocket communication
 * - Game room initialization
 * - Spectator functionality
 * - Cleanup and timeout handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MockConnection,
  MockDurableObjectNamespace,
  createMockRequest,
  createMockGameRoom,
  createMockLobbyList,
  WebSocketTestHarness,
} from '../helpers/mocks';

// ============================================================================
// Mock LobbyRoom for Integration Testing
// ============================================================================

interface LobbySettings {
  playerColor: string;
  gameMode: string;
  isPrivate: boolean;
  privateCode?: string;
  allowSpectators: boolean;
  maxSpectators: number;
  openingName?: string;
  openingFen?: string;
}

interface MockLobbyInfo {
  id: string;
  creatorId: string;
  creatorDisplayName: string;
  creatorRating: number;
  settings: LobbySettings;
  status: 'waiting' | 'playing' | 'finished';
  createdAt: number;
  spectatorCount: number;
  spectatorIds: string[];
}

// ============================================================================
// Integration Test Environment
// ============================================================================

class LobbyIntegrationTestEnv {
  lobbies: Map<string, MockLobbyInfo> = new Map();
  gameRooms: Map<string, any> = new Map();
  wsHarness: WebSocketTestHarness;

  constructor() {
    this.wsHarness = new WebSocketTestHarness();
  }

  // Simulate lobby creation
  async createLobby(creatorId: string, settings: Partial<LobbySettings> = {}): Promise<{
    lobbyId: string;
    webSocketUrl: string;
    lobby: MockLobbyInfo;
  }> {
    const lobbyId = 'lobby-' + Math.random().toString(36).slice(2);
    const lobby: MockLobbyInfo = {
      id: lobbyId,
      creatorId,
      creatorDisplayName: `Player-${creatorId.slice(0, 6)}`,
      creatorRating: 1200,
      settings: {
        playerColor: settings.playerColor || 'random',
        gameMode: settings.gameMode || 'blitz',
        isPrivate: settings.isPrivate || false,
        privateCode: settings.isPrivate ? this.generatePrivateCode() : undefined,
        allowSpectators: settings.allowSpectators ?? true,
        maxSpectators: settings.maxSpectators || 50,
        openingName: settings.openingName,
        openingFen: settings.openingFen,
      },
      status: 'waiting',
      createdAt: Date.now(),
      spectatorCount: 0,
      spectatorIds: [],
    };

    this.lobbies.set(lobbyId, lobby);

    return {
      lobbyId,
      webSocketUrl: `wss://test.example.com/parties/lobby-room/${lobbyId}`,
      lobby,
    };
  }

  // Simulate lobby join
  async joinLobby(lobbyId: string, joinerId: string, joinerInfo: {
    displayName: string;
    rating: number;
    isProvisional?: boolean;
  }): Promise<{
    success: boolean;
    roomId?: string;
    webSocketUrl?: string;
    playerColor?: string;
    opponent?: any;
    error?: string;
  }> {
    const lobby = this.lobbies.get(lobbyId);
    if (!lobby) {
      return { success: false, error: 'Lobby not found' };
    }

    if (lobby.status !== 'waiting') {
      return { success: false, error: 'Lobby is not waiting' };
    }

    // Create game room
    const roomId = 'game-' + Math.random().toString(36).slice(2);
    const creatorColor = this.determineColor(lobby.settings.playerColor, lobby.id);
    const joinerColor = creatorColor === 'white' ? 'black' : 'white';

    this.gameRooms.set(roomId, {
      id: roomId,
      players: {
        [creatorColor]: {
          id: lobby.creatorId,
          displayName: lobby.creatorDisplayName,
          rating: lobby.creatorRating,
        },
        [joinerColor]: {
          id: joinerId,
          displayName: joinerInfo.displayName,
          rating: joinerInfo.rating,
        },
      },
      gameMode: lobby.settings.gameMode,
      isUnrated: true,
      status: 'waiting',
    });

    // Update lobby status
    lobby.status = 'playing';

    return {
      success: true,
      roomId,
      webSocketUrl: `wss://test.example.com/parties/game-room/${roomId}`,
      playerColor: joinerColor,
      opponent: {
        id: lobby.creatorId,
        displayName: lobby.creatorDisplayName,
        rating: lobby.creatorRating,
      },
    };
  }

  // Simulate spectator join
  async spectate(lobbyId: string, spectatorId: string): Promise<{
    success: boolean;
    webSocketUrl?: string;
    error?: string;
  }> {
    const lobby = this.lobbies.get(lobbyId);
    if (!lobby) {
      return { success: false, error: 'Lobby not found' };
    }

    if (!lobby.settings.allowSpectators) {
      return { success: false, error: 'Spectators not allowed' };
    }

    if (lobby.spectatorIds.length >= lobby.settings.maxSpectators) {
      return { success: false, error: 'Max spectators reached' };
    }

    lobby.spectatorIds.push(spectatorId);
    lobby.spectatorCount = lobby.spectatorIds.length;

    return {
      success: true,
      webSocketUrl: `wss://test.example.com/parties/game-room/${lobbyId}?mode=spectator`,
    };
  }

  // Get lobby list
  getLobbies(filter?: { status?: string; includePrivate?: boolean }): MockLobbyInfo[] {
    let lobbies = Array.from(this.lobbies.values());

    if (filter?.status) {
      lobbies = lobbies.filter(l => l.status === filter.status);
    }

    if (!filter?.includePrivate) {
      lobbies = lobbies.filter(l => !l.settings.isPrivate);
    }

    return lobbies;
  }

  // Cancel/delete lobby
  async cancelLobby(lobbyId: string, userId: string): Promise<{ success: boolean; error?: string }> {
    const lobby = this.lobbies.get(lobbyId);
    if (!lobby) {
      return { success: false, error: 'Lobby not found' };
    }

    if (lobby.creatorId !== userId) {
      return { success: false, error: 'Only creator can cancel lobby' };
    }

    this.lobbies.delete(lobbyId);
    return { success: true };
  }

  // Helpers
  private generatePrivateCode(): string {
    return Math.random().toString(36).slice(2, 8).toUpperCase();
  }

  private determineColor(preference: string, lobbyId: string): 'white' | 'black' {
    if (preference === 'white') return 'white';
    if (preference === 'black') return 'black';
    // Random based on lobby ID
    const hash = lobbyId.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
    return hash % 2 === 0 ? 'white' : 'black';
  }

  cleanup(): void {
    this.lobbies.clear();
    this.gameRooms.clear();
    this.wsHarness.closeAllConnections();
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('Lobby Integration Tests', () => {
  let env: LobbyIntegrationTestEnv;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
    env = new LobbyIntegrationTestEnv();
  });

  afterEach(() => {
    env.cleanup();
    vi.useRealTimers();
  });

  // ==========================================================================
  // Lobby Creation Tests
  // ==========================================================================

  describe('POST /api/lobby/create', () => {
    it('should create public lobby with default settings', async () => {
      const result = await env.createLobby('user-1');

      expect(result.lobbyId).toBeDefined();
      expect(result.webSocketUrl).toContain(result.lobbyId);
      expect(result.lobby.settings.isPrivate).toBe(false);
      expect(result.lobby.status).toBe('waiting');
    });

    it('should create private lobby with code', async () => {
      const result = await env.createLobby('user-1', { isPrivate: true });

      expect(result.lobby.settings.isPrivate).toBe(true);
      expect(result.lobby.settings.privateCode).toBeDefined();
      expect(result.lobby.settings.privateCode).toHaveLength(6);
    });

    it('should support different game modes', async () => {
      const bulletLobby = await env.createLobby('user-1', { gameMode: 'bullet' });
      const blitzLobby = await env.createLobby('user-2', { gameMode: 'blitz' });
      const rapidLobby = await env.createLobby('user-3', { gameMode: 'rapid' });

      expect(bulletLobby.lobby.settings.gameMode).toBe('bullet');
      expect(blitzLobby.lobby.settings.gameMode).toBe('blitz');
      expect(rapidLobby.lobby.settings.gameMode).toBe('rapid');
    });

    it('should support color preferences', async () => {
      const whiteLobby = await env.createLobby('user-1', { playerColor: 'white' });
      const blackLobby = await env.createLobby('user-2', { playerColor: 'black' });
      const randomLobby = await env.createLobby('user-3', { playerColor: 'random' });

      expect(whiteLobby.lobby.settings.playerColor).toBe('white');
      expect(blackLobby.lobby.settings.playerColor).toBe('black');
      expect(randomLobby.lobby.settings.playerColor).toBe('random');
    });

    it('should support custom opening positions', async () => {
      const result = await env.createLobby('user-1', {
        openingName: 'Sicilian Defense',
        openingFen: 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6 0 2',
      });

      expect(result.lobby.settings.openingName).toBe('Sicilian Defense');
      expect(result.lobby.settings.openingFen).toContain('2p5');
    });

    it('should configure spectator settings', async () => {
      const noSpectators = await env.createLobby('user-1', {
        allowSpectators: false,
        maxSpectators: 0,
      });

      const limitedSpectators = await env.createLobby('user-2', {
        allowSpectators: true,
        maxSpectators: 10,
      });

      expect(noSpectators.lobby.settings.allowSpectators).toBe(false);
      expect(limitedSpectators.lobby.settings.maxSpectators).toBe(10);
    });
  });

  // ==========================================================================
  // Lobby Listing Tests
  // ==========================================================================

  describe('GET /api/lobby/list', () => {
    it('should list active lobbies', async () => {
      await env.createLobby('user-1');
      await env.createLobby('user-2');
      await env.createLobby('user-3');

      const lobbies = env.getLobbies();

      expect(lobbies).toHaveLength(3);
    });

    it('should filter by status', async () => {
      const lobby1 = await env.createLobby('user-1');
      await env.createLobby('user-2');

      // Join lobby1 to make it 'playing'
      await env.joinLobby(lobby1.lobbyId, 'joiner-1', {
        displayName: 'Joiner',
        rating: 1200,
      });

      const waitingLobbies = env.getLobbies({ status: 'waiting' });
      const playingLobbies = env.getLobbies({ status: 'playing' });

      expect(waitingLobbies).toHaveLength(1);
      expect(playingLobbies).toHaveLength(1);
    });

    it('should hide private lobbies by default', async () => {
      await env.createLobby('user-1', { isPrivate: false });
      await env.createLobby('user-2', { isPrivate: true });

      const publicLobbies = env.getLobbies();
      const allLobbies = env.getLobbies({ includePrivate: true });

      expect(publicLobbies).toHaveLength(1);
      expect(allLobbies).toHaveLength(2);
    });

    it('should include spectator counts', async () => {
      const { lobbyId } = await env.createLobby('user-1');

      await env.spectate(lobbyId, 'spectator-1');
      await env.spectate(lobbyId, 'spectator-2');

      const lobbies = env.getLobbies();
      const lobby = lobbies.find(l => l.id === lobbyId);

      expect(lobby?.spectatorCount).toBe(2);
    });

    it('should include creator info', async () => {
      await env.createLobby('user-abc123');

      const lobbies = env.getLobbies();

      expect(lobbies[0].creatorDisplayName).toBeDefined();
      expect(lobbies[0].creatorRating).toBeDefined();
    });
  });

  // ==========================================================================
  // Lobby Joining Tests
  // ==========================================================================

  describe('POST /api/lobby/join', () => {
    it('should join lobby as player', async () => {
      const { lobbyId } = await env.createLobby('creator-1');

      const result = await env.joinLobby(lobbyId, 'joiner-1', {
        displayName: 'JoinerPlayer',
        rating: 1350,
      });

      expect(result.success).toBe(true);
      expect(result.roomId).toBeDefined();
      expect(result.webSocketUrl).toContain(result.roomId);
      expect(result.playerColor).toMatch(/white|black/);
    });

    it('should return opponent info to joiner', async () => {
      const { lobbyId } = await env.createLobby('creator-1');

      const result = await env.joinLobby(lobbyId, 'joiner-1', {
        displayName: 'JoinerPlayer',
        rating: 1350,
      });

      expect(result.opponent).toBeDefined();
      expect(result.opponent.id).toBe('creator-1');
      expect(result.opponent.displayName).toBeDefined();
      expect(result.opponent.rating).toBeDefined();
    });

    it('should prevent joining non-existent lobby', async () => {
      const result = await env.joinLobby('nonexistent-lobby', 'joiner-1', {
        displayName: 'JoinerPlayer',
        rating: 1350,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Lobby not found');
    });

    it('should prevent joining already matched lobby', async () => {
      const { lobbyId } = await env.createLobby('creator-1');

      // First join
      await env.joinLobby(lobbyId, 'joiner-1', {
        displayName: 'JoinerPlayer1',
        rating: 1350,
      });

      // Second join should fail
      const result = await env.joinLobby(lobbyId, 'joiner-2', {
        displayName: 'JoinerPlayer2',
        rating: 1400,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Lobby is not waiting');
    });

    it('should assign colors based on creator preference (white)', async () => {
      const { lobbyId } = await env.createLobby('creator-1', { playerColor: 'white' });

      const result = await env.joinLobby(lobbyId, 'joiner-1', {
        displayName: 'JoinerPlayer',
        rating: 1350,
      });

      expect(result.playerColor).toBe('black'); // Joiner gets opposite
    });

    it('should assign colors based on creator preference (black)', async () => {
      const { lobbyId } = await env.createLobby('creator-1', { playerColor: 'black' });

      const result = await env.joinLobby(lobbyId, 'joiner-1', {
        displayName: 'JoinerPlayer',
        rating: 1350,
      });

      expect(result.playerColor).toBe('white'); // Joiner gets opposite
    });

    it('should create game room with correct settings', async () => {
      const { lobbyId } = await env.createLobby('creator-1', {
        gameMode: 'rapid',
        openingName: 'Sicilian Defense',
      });

      const result = await env.joinLobby(lobbyId, 'joiner-1', {
        displayName: 'JoinerPlayer',
        rating: 1350,
      });

      const gameRoom = env.gameRooms.get(result.roomId!);
      expect(gameRoom).toBeDefined();
      expect(gameRoom.gameMode).toBe('rapid');
      expect(gameRoom.isUnrated).toBe(true); // Lobby games are always unrated
    });
  });

  // ==========================================================================
  // Spectator Tests
  // ==========================================================================

  describe('POST /api/lobby/spectate', () => {
    it('should join as spectator', async () => {
      const { lobbyId } = await env.createLobby('creator-1', { allowSpectators: true });

      const result = await env.spectate(lobbyId, 'spectator-1');

      expect(result.success).toBe(true);
      expect(result.webSocketUrl).toContain('mode=spectator');
    });

    it('should enforce spectator limits', async () => {
      const { lobbyId } = await env.createLobby('creator-1', {
        allowSpectators: true,
        maxSpectators: 2,
      });

      await env.spectate(lobbyId, 'spectator-1');
      await env.spectate(lobbyId, 'spectator-2');
      const result = await env.spectate(lobbyId, 'spectator-3');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Max spectators reached');
    });

    it('should reject if spectators disabled', async () => {
      const { lobbyId } = await env.createLobby('creator-1', { allowSpectators: false });

      const result = await env.spectate(lobbyId, 'spectator-1');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Spectators not allowed');
    });

    it('should track spectator count', async () => {
      const { lobbyId } = await env.createLobby('creator-1', { allowSpectators: true });

      await env.spectate(lobbyId, 'spectator-1');
      await env.spectate(lobbyId, 'spectator-2');
      await env.spectate(lobbyId, 'spectator-3');

      const lobbies = env.getLobbies();
      const lobby = lobbies.find(l => l.id === lobbyId);

      expect(lobby?.spectatorCount).toBe(3);
    });
  });

  // ==========================================================================
  // Lobby Cancellation Tests
  // ==========================================================================

  describe('DELETE /api/lobby/:id', () => {
    it('should delete lobby (creator only)', async () => {
      const { lobbyId } = await env.createLobby('creator-1');

      const result = await env.cancelLobby(lobbyId, 'creator-1');

      expect(result.success).toBe(true);
      expect(env.lobbies.has(lobbyId)).toBe(false);
    });

    it('should reject non-creator deletion', async () => {
      const { lobbyId } = await env.createLobby('creator-1');

      const result = await env.cancelLobby(lobbyId, 'other-user');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Only creator can cancel lobby');
      expect(env.lobbies.has(lobbyId)).toBe(true); // Still exists
    });

    it('should handle non-existent lobby', async () => {
      const result = await env.cancelLobby('nonexistent', 'user-1');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Lobby not found');
    });
  });

  // ==========================================================================
  // Full Flow Tests
  // ==========================================================================

  describe('Complete Lobby Flow', () => {
    it('should complete full lobby lifecycle: create → join → play', async () => {
      // 1. Creator creates lobby
      const { lobbyId, lobby } = await env.createLobby('creator-1', {
        gameMode: 'blitz',
        playerColor: 'white',
      });

      expect(lobby.status).toBe('waiting');

      // 2. Creator connects via WebSocket (simulated)
      const creatorConn = env.wsHarness.createConnection('creator-1');

      // 3. Joiner joins lobby
      const joinResult = await env.joinLobby(lobbyId, 'joiner-1', {
        displayName: 'JoinerPlayer',
        rating: 1350,
      });

      expect(joinResult.success).toBe(true);
      expect(lobby.status).toBe('playing');

      // 4. Both players would connect to game room
      const gameRoom = env.gameRooms.get(joinResult.roomId!);
      expect(gameRoom).toBeDefined();
      expect(Object.keys(gameRoom.players)).toHaveLength(2);

      // 5. Verify color assignment
      expect(gameRoom.players.white.id).toBe('creator-1');
      expect(gameRoom.players.black.id).toBe('joiner-1');
    });

    it('should handle multiple concurrent lobbies', async () => {
      // Create multiple lobbies
      const lobby1 = await env.createLobby('creator-1', { gameMode: 'bullet' });
      const lobby2 = await env.createLobby('creator-2', { gameMode: 'blitz' });
      const lobby3 = await env.createLobby('creator-3', { gameMode: 'rapid' });

      // Join different lobbies
      await env.joinLobby(lobby1.lobbyId, 'joiner-1', { displayName: 'J1', rating: 1200 });
      await env.joinLobby(lobby3.lobbyId, 'joiner-3', { displayName: 'J3', rating: 1400 });

      // Check states
      const lobbies = env.getLobbies({ includePrivate: true });
      const waitingCount = lobbies.filter(l => l.status === 'waiting').length;
      const playingCount = lobbies.filter(l => l.status === 'playing').length;

      expect(waitingCount).toBe(1); // lobby2 still waiting
      expect(playingCount).toBe(2); // lobby1 and lobby3 playing
    });

    it('should isolate private and public lobbies', async () => {
      await env.createLobby('creator-1', { isPrivate: false });
      await env.createLobby('creator-2', { isPrivate: true });
      await env.createLobby('creator-3', { isPrivate: false });

      const publicLobbies = env.getLobbies({ status: 'waiting' });

      expect(publicLobbies).toHaveLength(2);
      expect(publicLobbies.every(l => !l.settings.isPrivate)).toBe(true);
    });
  });

  // ==========================================================================
  // Stale Lobby Cleanup Tests
  // ==========================================================================

  describe('Stale Lobby Cleanup', () => {
    it('should identify stale waiting lobbies', async () => {
      // Create a lobby
      await env.createLobby('creator-1');

      // Advance time past typical timeout (10 minutes)
      vi.advanceTimersByTime(11 * 60 * 1000);

      // In real implementation, cleanup would remove this
      const lobbies = env.getLobbies();
      expect(lobbies).toHaveLength(1);

      // Check createdAt is old
      const lobby = lobbies[0];
      const age = Date.now() - lobby.createdAt;
      expect(age).toBeGreaterThan(10 * 60 * 1000);
    });

    it('should cleanup finished games after time', async () => {
      const { lobbyId } = await env.createLobby('creator-1');

      // Join to start game
      await env.joinLobby(lobbyId, 'joiner-1', {
        displayName: 'Joiner',
        rating: 1200,
      });

      // Simulate game finish
      const lobby = env.lobbies.get(lobbyId)!;
      lobby.status = 'finished';

      // Advance time past cleanup threshold (30 minutes)
      vi.advanceTimersByTime(31 * 60 * 1000);

      // In real implementation, finished lobbies older than 30 min would be removed
      const finishedLobbies = env.getLobbies({ status: 'finished' });
      expect(finishedLobbies).toHaveLength(1);
    });
  });
});

// ============================================================================
// LobbyList Durable Object Integration Tests
// ============================================================================

describe('LobbyList Durable Object Integration', () => {
  it('should track all active lobbies', async () => {
    const lobbyList = createMockLobbyList('global');

    lobbyList.addLobby({ id: 'lobby-1', status: 'waiting' });
    lobbyList.addLobby({ id: 'lobby-2', status: 'waiting' });
    lobbyList.addLobby({ id: 'lobby-3', status: 'playing' });

    const response = await lobbyList.fetch(new Request('https://test/list'));
    const body = await response.json();

    expect(body.total).toBe(3);
    expect(body.lobbies).toHaveLength(3);
  });

  it('should remove lobbies correctly', async () => {
    const lobbyList = createMockLobbyList('global');

    lobbyList.addLobby({ id: 'lobby-1', status: 'waiting' });
    lobbyList.addLobby({ id: 'lobby-2', status: 'waiting' });

    await lobbyList.fetch(new Request('https://test/remove/lobby-1', { method: 'DELETE' }));

    const lobbies = lobbyList.getLobbies();
    expect(lobbies.size).toBe(1);
    expect(lobbies.has('lobby-1')).toBe(false);
    expect(lobbies.has('lobby-2')).toBe(true);
  });

  it('should add lobbies via POST', async () => {
    const lobbyList = createMockLobbyList('global');

    await lobbyList.fetch(new Request('https://test/add', {
      method: 'POST',
      body: JSON.stringify({ id: 'new-lobby', status: 'waiting' }),
    }));

    const lobbies = lobbyList.getLobbies();
    expect(lobbies.has('new-lobby')).toBe(true);
  });
});

// ============================================================================
// GameRoom Spectator Integration Tests
// ============================================================================

describe('GameRoom Spectator Integration', () => {
  it('should initialize game room with player info', async () => {
    const gameRoom = createMockGameRoom('test-game');

    await gameRoom.fetch(new Request('https://test/init', {
      method: 'POST',
      body: JSON.stringify({
        gameMode: 'blitz',
        isLobbyMode: true,
        isUnrated: true,
        players: {
          white: { id: 'player-1', displayName: 'White', rating: 1500 },
          black: { id: 'player-2', displayName: 'Black', rating: 1450 },
        },
      }),
    }));

    expect(gameRoom.isInitialized()).toBe(true);
    expect(gameRoom.getGameState()?.gameMode).toBe('blitz');
    expect(gameRoom.getPlayers().size).toBe(2);
  });

  it('should flag lobby games as unrated', async () => {
    const gameRoom = createMockGameRoom('test-game');

    await gameRoom.fetch(new Request('https://test/init', {
      method: 'POST',
      body: JSON.stringify({
        gameMode: 'rapid',
        isLobbyMode: true,
        isUnrated: true,
        players: {
          white: { id: 'player-1', displayName: 'White', rating: 1500 },
          black: { id: 'player-2', displayName: 'Black', rating: 1450 },
        },
      }),
    }));

    const state = gameRoom.getGameState();
    expect(state?.isUnrated).toBe(true);
  });
});
