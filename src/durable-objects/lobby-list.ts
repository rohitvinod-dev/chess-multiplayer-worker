import type { LobbyInfo } from '../types/lobby';

/**
 * LobbyList Durable Object
 *
 * Single global instance that tracks all active lobbies.
 * Provides fast lookups for lobby list screen.
 *
 * Cost optimization: Single instance means one DO per deployment,
 * not per lobby. All lobby list operations go through this one instance.
 */
export class LobbyList {
  private state: DurableObjectState;
  private lobbies: Map<string, LobbyInfo> = new Map();
  private initialized = false;

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
  }

  /**
   * Initialize lobby list from storage
   */
  private async initialize() {
    if (this.initialized) return;

    const stored = await this.state.storage.get<Map<string, LobbyInfo>>('lobbies');
    if (stored) {
      this.lobbies = new Map(stored);
    }

    this.initialized = true;
    console.log(`LobbyList initialized with ${this.lobbies.size} lobbies`);
  }

  /**
   * Add a new lobby to the list
   */
  async addLobby(lobby: LobbyInfo): Promise<void> {
    await this.initialize();

    this.lobbies.set(lobby.id, lobby);
    await this.persist();

    console.log(`Lobby ${lobby.id} added. Total lobbies: ${this.lobbies.size}`);
  }

  /**
   * Update existing lobby
   */
  async updateLobby(lobbyId: string, updates: Partial<LobbyInfo>): Promise<void> {
    await this.initialize();

    const existing = this.lobbies.get(lobbyId);
    if (!existing) {
      throw new Error(`Lobby ${lobbyId} not found`);
    }

    const updated = { ...existing, ...updates };
    this.lobbies.set(lobbyId, updated);
    await this.persist();

    console.log(`Lobby ${lobbyId} updated`);
  }

  /**
   * Remove a lobby from the list
   */
  async removeLobby(lobbyId: string): Promise<void> {
    await this.initialize();

    const deleted = this.lobbies.delete(lobbyId);
    if (deleted) {
      await this.persist();
      console.log(`Lobby ${lobbyId} removed. Total lobbies: ${this.lobbies.size}`);
    }
  }

  /**
   * Get all lobbies matching filter criteria
   */
  async getLobbies(filter?: {
    status?: 'waiting' | 'playing' | 'finished';
    includePrivate?: boolean;
  }): Promise<LobbyInfo[]> {
    await this.initialize();

    let lobbies = Array.from(this.lobbies.values());

    // Filter by status
    if (filter?.status) {
      lobbies = lobbies.filter(l => l.status === filter.status);
    }

    // Exclude private lobbies by default
    if (!filter?.includePrivate) {
      lobbies = lobbies.filter(l => !l.settings.isPrivate);
    }

    // Sort: waiting lobbies first, then by creation time (newest first)
    lobbies.sort((a, b) => {
      if (a.status === 'waiting' && b.status !== 'waiting') return -1;
      if (a.status !== 'waiting' && b.status === 'waiting') return 1;
      return b.createdAt - a.createdAt;
    });

    return lobbies;
  }

  /**
   * Get a specific lobby by ID
   */
  async getLobby(lobbyId: string): Promise<LobbyInfo | null> {
    await this.initialize();
    return this.lobbies.get(lobbyId) ?? null;
  }

  /**
   * Get lobby by private code
   */
  async getLobbyByCode(code: string): Promise<LobbyInfo | null> {
    await this.initialize();

    const lobby = Array.from(this.lobbies.values()).find(
      l => l.settings.isPrivate && l.settings.privateCode === code
    );

    return lobby ?? null;
  }

  /**
   * Add spectator to lobby
   */
  async addSpectator(lobbyId: string, spectatorId: string): Promise<void> {
    await this.initialize();

    const lobby = this.lobbies.get(lobbyId);
    if (!lobby) {
      throw new Error(`Lobby ${lobbyId} not found`);
    }

    if (!lobby.settings.allowSpectators) {
      throw new Error('Spectators not allowed in this lobby');
    }

    if (lobby.spectatorIds.includes(spectatorId)) {
      return; // Already spectating
    }

    if (lobby.spectatorIds.length >= lobby.settings.maxSpectators) {
      throw new Error('Lobby is full (max spectators reached)');
    }

    lobby.spectatorIds.push(spectatorId);
    lobby.spectatorCount = lobby.spectatorIds.length;

    this.lobbies.set(lobbyId, lobby);
    await this.persist();

    console.log(`Spectator ${spectatorId} added to lobby ${lobbyId}. Total: ${lobby.spectatorCount}`);
  }

  /**
   * Remove spectator from lobby
   */
  async removeSpectator(lobbyId: string, spectatorId: string): Promise<void> {
    await this.initialize();

    const lobby = this.lobbies.get(lobbyId);
    if (!lobby) {
      return; // Lobby doesn't exist, no-op
    }

    const index = lobby.spectatorIds.indexOf(spectatorId);
    if (index > -1) {
      lobby.spectatorIds.splice(index, 1);
      lobby.spectatorCount = lobby.spectatorIds.length;

      this.lobbies.set(lobbyId, lobby);
      await this.persist();

      console.log(`Spectator ${spectatorId} removed from lobby ${lobbyId}. Total: ${lobby.spectatorCount}`);
    }
  }

  /**
   * Clean up old finished lobbies (called periodically)
   */
  async cleanupFinishedLobbies(maxAgeMs: number = 30 * 60 * 1000): Promise<number> {
    await this.initialize();

    const now = Date.now();
    let removed = 0;

    for (const [id, lobby] of this.lobbies) {
      if (lobby.status === 'finished') {
        const age = now - (lobby.startedAt ?? lobby.createdAt);
        if (age > maxAgeMs) {
          this.lobbies.delete(id);
          removed++;
        }
      }
    }

    if (removed > 0) {
      await this.persist();
      console.log(`Cleaned up ${removed} finished lobbies`);
    }

    return removed;
  }

  /**
   * Persist to storage
   */
  private async persist(): Promise<void> {
    await this.state.storage.put('lobbies', Array.from(this.lobbies.entries()));
  }

  /**
   * Handle HTTP requests to this DO
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // GET /list - Get all lobbies
      if (path === '/list' && request.method === 'GET') {
        const status = url.searchParams.get('status') as 'waiting' | 'playing' | 'finished' | undefined;
        const includePrivate = url.searchParams.get('includePrivate') === 'true';

        const lobbies = await this.getLobbies({ status, includePrivate });

        return new Response(JSON.stringify({
          lobbies,
          total: lobbies.length,
        }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // GET /lobby/:id - Get specific lobby
      if (path.startsWith('/lobby/') && request.method === 'GET') {
        const lobbyId = path.split('/')[2];
        const lobby = await this.getLobby(lobbyId);

        if (!lobby) {
          return new Response('Lobby not found', { status: 404 });
        }

        return new Response(JSON.stringify(lobby), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // GET /code/:code - Get lobby by private code
      if (path.startsWith('/code/') && request.method === 'GET') {
        const code = path.split('/')[2];
        const lobby = await this.getLobbyByCode(code);

        if (!lobby) {
          return new Response('Lobby not found', { status: 404 });
        }

        return new Response(JSON.stringify(lobby), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // POST /add - Add lobby (internal use by worker)
      if (path === '/add' && request.method === 'POST') {
        const lobby = await request.json() as LobbyInfo;
        await this.addLobby(lobby);

        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // POST /update/:id - Update lobby
      if (path.startsWith('/update/') && request.method === 'POST') {
        const lobbyId = path.split('/')[2];
        const updates = await request.json() as Partial<LobbyInfo>;
        await this.updateLobby(lobbyId, updates);

        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // DELETE /remove/:id - Remove lobby
      if (path.startsWith('/remove/') && request.method === 'DELETE') {
        const lobbyId = path.split('/')[2];
        await this.removeLobby(lobbyId);

        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // POST /spectator/add - Add spectator
      if (path === '/spectator/add' && request.method === 'POST') {
        const { lobbyId, spectatorId } = await request.json() as { lobbyId: string; spectatorId: string };
        await this.addSpectator(lobbyId, spectatorId);

        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // POST /spectator/remove - Remove spectator
      if (path === '/spectator/remove' && request.method === 'POST') {
        const { lobbyId, spectatorId } = await request.json() as { lobbyId: string; spectatorId: string };
        await this.removeSpectator(lobbyId, spectatorId);

        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // POST /cleanup - Cleanup finished lobbies
      if (path === '/cleanup' && request.method === 'POST') {
        const maxAgeMs = parseInt(url.searchParams.get('maxAgeMs') ?? '1800000');
        const removed = await this.cleanupFinishedLobbies(maxAgeMs);

        return new Response(JSON.stringify({ removed }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('LobbyList error:', error);
      return new Response(JSON.stringify({
        error: error instanceof Error ? error.message : 'Internal error',
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
}
