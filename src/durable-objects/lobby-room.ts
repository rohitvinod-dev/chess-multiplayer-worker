import { type Connection, Server, type WSMessage } from "partyserver";
import type { GameMode, PlayerColor } from "../shared";

/**
 * LobbyRoom Durable Object
 *
 * Manages a single lobby waiting room with WebSocket support.
 * Creator waits for opponent via WebSocket, gets real-time notifications.
 *
 * Cost efficiency: 1 WebSocket connection vs 150 HTTP polls
 * = 500x cheaper than short polling!
 */

interface LobbySettings {
  playerColor: string; // 'white' | 'black' | 'random'
  gameMode: GameMode;
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
  connection?: Connection;
  connectedAt: number;
}

interface LobbyState {
  lobbyId: string;
  creatorId: string;
  creator: LobbyParticipant;
  opponent?: LobbyParticipant;
  settings: LobbySettings;
  status: 'waiting' | 'matched' | 'cancelled';
  createdAt: number;
  gameRoomId?: string;
  webSocketUrl?: string;
}

interface LobbyRoomEnv {
  GAME_ROOM: DurableObjectNamespace;
  LOBBY_LIST: DurableObjectNamespace;
}

export class LobbyRoom extends Server<LobbyRoomEnv> {
  static options = { hibernate: true };

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

  // Timeout tracking - use alarms instead of setTimeout (survives hibernation)
  maxWaitTimeMs = 10 * 1000; // 10 seconds for testing (change to 5 * 60 * 1000 for production)

  // Grace period before cancelling on disconnect (prevents race conditions)
  disconnectGraceMs = 5000; // 5 seconds grace period
  disconnectTimeoutId?: ReturnType<typeof setTimeout>;

  async onStart() {
    console.log(`[LobbyRoom] Starting lobby room`);

    // Load persisted state if exists
    const stored = await this.ctx.storage.get<LobbyState>('state');
    if (stored) {
      this.lobbyId = stored.lobbyId;
      this.creatorId = stored.creatorId;
      this.creator = stored.creator;
      this.opponent = stored.opponent;
      this.settings = stored.settings;
      this.status = stored.status;
      this.createdAt = stored.createdAt;
      this.gameRoomId = stored.gameRoomId;
      this.gameWebSocketUrl = stored.webSocketUrl;

      console.log(`[LobbyRoom] Loaded state for lobby ${this.lobbyId}, status: ${this.status}`);

      // Check if lobby should have timed out while hibernating
      if (this.status === 'waiting') {
        const elapsed = Date.now() - this.createdAt;
        if (elapsed > this.maxWaitTimeMs) {
          console.log(`[LobbyRoom] Lobby ${this.lobbyId} expired during hibernation (${elapsed}ms)`);
          await this.cancelAndRemoveFromList('Lobby expired');
        }
      }
    }
  }

  /**
   * Durable Object alarm handler - fires when timeout expires
   * This survives hibernation unlike setTimeout!
   */
  async alarm() {
    console.log(`[LobbyRoom] ⏰ ALARM FIRED for lobby ${this.lobbyId}, status: ${this.status}, createdAt: ${this.createdAt}`);

    if (this.status !== 'waiting') {
      console.log(`[LobbyRoom] Ignoring alarm - lobby is ${this.status}`);
      return;
    }

    // Double-check elapsed time (alarm might have been delayed)
    const elapsed = Date.now() - this.createdAt;
    console.log(`[LobbyRoom] Elapsed time: ${elapsed}ms, max wait: ${this.maxWaitTimeMs}ms`);

    if (elapsed >= this.maxWaitTimeMs) {
      console.log(`[LobbyRoom] 🚫 Lobby ${this.lobbyId} timed out after ${elapsed}ms`);
      await this.cancelAndRemoveFromList('No opponent found - lobby timed out');
    } else {
      // Alarm fired early, set another alarm for remaining time
      const remaining = this.maxWaitTimeMs - elapsed;
      console.log(`[LobbyRoom] Alarm fired early, setting new alarm for ${remaining}ms`);
      await this.ctx.storage.setAlarm(Date.now() + remaining);
    }
  }

  /**
   * Check if lobby should be auto-cancelled due to timeout
   * Called as a fallback in case alarm doesn't fire
   */
  private async checkAndCancelIfExpired(): Promise<boolean> {
    if (this.status !== 'waiting') return false;

    const elapsed = Date.now() - this.createdAt;
    if (elapsed >= this.maxWaitTimeMs) {
      console.log(`[LobbyRoom] 🚫 Fallback timeout check - lobby ${this.lobbyId} expired (${elapsed}ms)`);
      await this.cancelAndRemoveFromList('No opponent found - lobby timed out');
      return true;
    }
    return false;
  }

  async onConnect(connection: Connection, ctx: any) {
    // Fallback timeout check in case alarm didn't fire
    if (await this.checkAndCancelIfExpired()) {
      connection.send(JSON.stringify({
        type: 'lobby_cancelled',
        reason: 'Lobby has expired',
      }));
      connection.close(1000, 'Lobby expired');
      return;
    }

    // Parse userId from the request URL (same pattern as GameRoom)
    // Note: ctx.request.url contains the full URL with query params
    let userId: string | null = null;
    try {
      const url = new URL(ctx.request.url);
      userId = url.searchParams.get('userId');
    } catch (e) {
      console.error(`[LobbyRoom] Failed to parse request URL:`, e);
      // Fallback: try connection.url
      try {
        const url = new URL(connection.url, 'https://localhost');
        userId = url.searchParams.get('userId');
      } catch (e2) {
        console.error(`[LobbyRoom] Failed to parse connection URL: ${connection.url}`, e2);
      }
    }
    console.log(`[LobbyRoom] User ${userId} connecting to lobby ${this.lobbyId}`);

    if (!userId) {
      connection.send(JSON.stringify({
        type: 'error',
        message: 'Missing userId parameter',
      }));
      connection.close(1008, 'Missing userId');
      return;
    }

    // Attach connection to creator or opponent
    if (userId === this.creatorId && this.creator) {
      this.creator.connection = connection;
      console.log(`[LobbyRoom] Creator ${userId} connected, status: ${this.status}`);

      // Cancel any pending disconnect timeout (creator reconnected)
      if (this.disconnectTimeoutId) {
        clearTimeout(this.disconnectTimeoutId);
        this.disconnectTimeoutId = undefined;
        console.log(`[LobbyRoom] Creator reconnected, cancelled disconnect timeout`);
      }

      // CRITICAL: If lobby is already matched, send match_ready to creator
      // This handles the case where creator's WebSocket was disconnected during matching
      if (this.status === 'matched' && this.gameRoomId && this.gameWebSocketUrl && this.opponent) {
        console.log(`[LobbyRoom] Creator reconnected after match - sending match_ready`);
        connection.send(JSON.stringify({
          type: 'match_ready',
          roomId: this.gameRoomId,
          webSocketUrl: this.gameWebSocketUrl,
          playerColor: this.creatorColor,
          opponent: {
            id: this.opponent.id,
            displayName: this.opponent.displayName,
            rating: this.opponent.rating,
          },
        }));
      } else {
        // Send current status (waiting)
        this.sendStatusUpdate(connection);
      }
    } else if (this.opponent && userId === this.opponent.id) {
      this.opponent.connection = connection;
      console.log(`[LobbyRoom] Opponent ${userId} connected`);
    } else {
      connection.send(JSON.stringify({
        type: 'error',
        message: 'You are not part of this lobby',
      }));
      connection.close(1008, 'Unauthorized');
    }
  }

  async onMessage(connection: Connection, message: WSMessage) {
    try {
      const data = typeof message === 'string' ? JSON.parse(message) : message;
      const type = data.type;

      console.log(`[LobbyRoom] Received message: ${type}`);

      switch (type) {
        case 'ping':
          // Check for timeout on each ping (every 30 seconds from client)
          if (await this.checkAndCancelIfExpired()) {
            connection.send(JSON.stringify({
              type: 'lobby_cancelled',
              reason: 'Lobby has expired',
            }));
            connection.close(1000, 'Lobby expired');
            return;
          }
          connection.send(JSON.stringify({ type: 'pong' }));
          break;

        case 'leave':
          await this.handleLeave(connection);
          break;

        default:
          console.log(`[LobbyRoom] Unknown message type: ${type}`);
      }
    } catch (error) {
      console.error('[LobbyRoom] Error processing message:', error);
      connection.send(JSON.stringify({
        type: 'error',
        message: 'Failed to process message',
      }));
    }
  }

  async onClose(connection: Connection) {
    console.log(`[LobbyRoom] Connection closed for lobby ${this.lobbyId}, status: ${this.status}`);

    // If creator disconnects while waiting, start grace period before cancelling
    // This prevents race conditions when joiner is joining at the same moment
    if (this.creator?.connection === connection && this.status === 'waiting') {
      console.log(`[LobbyRoom] Creator disconnected, starting ${this.disconnectGraceMs}ms grace period before cancelling`);
      this.creator.connection = undefined;

      // Clear any existing timeout
      if (this.disconnectTimeoutId) {
        clearTimeout(this.disconnectTimeoutId);
      }

      // Start grace period - only cancel if still waiting after grace period
      this.disconnectTimeoutId = setTimeout(async () => {
        // Re-check status after grace period (might have been matched in the meantime)
        if (this.status === 'waiting' && !this.creator?.connection) {
          console.log(`[LobbyRoom] Grace period expired, cancelling lobby ${this.lobbyId}`);
          await this.cancelAndRemoveFromList('Creator disconnected');
        } else {
          console.log(`[LobbyRoom] Grace period expired but status is ${this.status}, not cancelling`);
        }
      }, this.disconnectGraceMs);
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

  async onRequest(request: Request): Promise<Response> {
    // Parse URL with fallback base for relative paths
    let pathname: string;
    try {
      const url = new URL(request.url, 'https://localhost');
      pathname = url.pathname;
    } catch (e) {
      console.error(`[LobbyRoom] Failed to parse request URL: ${request.url}`, e);
      pathname = request.url; // Use raw URL as fallback
    }

    console.log(`[LobbyRoom] HTTP request: ${request.method} ${pathname}`);

    // Initialize lobby (called by create endpoint)
    if (pathname === '/init' && request.method === 'POST') {
      return this.handleInit(request);
    }

    // Opponent joins lobby (called by join endpoint)
    if (pathname === '/join' && request.method === 'POST') {
      return this.handleJoin(request);
    }

    // Get lobby state
    if (pathname === '/state' && request.method === 'GET') {
      return this.handleGetState();
    }

    // Cancel lobby
    if (pathname === '/cancel' && request.method === 'POST') {
      return this.handleCancel();
    }

    return new Response('Not Found', { status: 404 });
  }

  private async handleInit(request: Request): Promise<Response> {
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

      // Set alarm for auto-timeout (survives hibernation!)
      const alarmTime = Date.now() + this.maxWaitTimeMs;
      await this.ctx.storage.setAlarm(alarmTime);
      console.log(`[LobbyRoom] Initialized lobby ${this.lobbyId}, alarm set for ${new Date(alarmTime).toISOString()}`);

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('[LobbyRoom] Init error:', error);
      return new Response(JSON.stringify({ error: 'Failed to initialize lobby' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // Store the determined colors once (to avoid random being called multiple times)
  private creatorColor?: PlayerColor;
  private opponentColor?: PlayerColor;

  private async handleJoin(request: Request): Promise<Response> {
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

      // CRITICAL FIX: Determine colors ONCE and cache them
      // This prevents the random color assignment from giving different results
      // when called multiple times during the join flow
      this.assignPlayerColors();

      // IMPORTANT: Set status to 'matched' IMMEDIATELY to prevent race condition
      // If we set it after createGameRoom(), the onClose handler might fire
      // during the async operation and cancel the lobby
      this.status = 'matched';
      await this.persist();

      // Cancel any pending disconnect timeout (we're matching now!)
      if (this.disconnectTimeoutId) {
        clearTimeout(this.disconnectTimeoutId);
        this.disconnectTimeoutId = undefined;
        console.log(`[LobbyRoom] Cancelled disconnect timeout (matching)`);
      }

      // Clear the timeout alarm since we're matching
      try {
        await this.ctx.storage.deleteAlarm();
        console.log(`[LobbyRoom] Cleared alarm for lobby ${this.lobbyId} (matching)`);
      } catch (e) {
        // Alarm might already be cleared
      }

      // Notify creator via WebSocket that opponent joined
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

      // Create game room first (sets gameRoomId and webSocketUrl)
      await this.createGameRoom();

      // Now update LobbyList status to 'playing' with game room info
      // (Must be AFTER createGameRoom so gameRoomId/webSocketUrl are set)
      try {
        const lobbyListId = this.env.LOBBY_LIST.idFromName('global');
        const lobbyListStub = this.env.LOBBY_LIST.get(lobbyListId);

        // Prepare player info based on colors
        const isCreatorWhite = this.creatorColor === 'white';
        const updatePayload: Record<string, unknown> = {
          status: 'playing',
          startedAt: Date.now(),
          gameRoomId: this.gameRoomId,
          webSocketUrl: this.gameWebSocketUrl,
        };

        // Add player info
        if (isCreatorWhite) {
          updatePayload.whitePlayerId = this.creator?.id;
          updatePayload.whiteDisplayName = this.creator?.displayName;
          updatePayload.whiteRating = this.creator?.rating;
          updatePayload.blackPlayerId = this.opponent?.id;
          updatePayload.blackDisplayName = this.opponent?.displayName;
          updatePayload.blackRating = this.opponent?.rating;
        } else {
          updatePayload.blackPlayerId = this.creator?.id;
          updatePayload.blackDisplayName = this.creator?.displayName;
          updatePayload.blackRating = this.creator?.rating;
          updatePayload.whitePlayerId = this.opponent?.id;
          updatePayload.whiteDisplayName = this.opponent?.displayName;
          updatePayload.whiteRating = this.opponent?.rating;
        }

        await lobbyListStub.fetch(new Request(`https://lobby-list/update/${this.lobbyId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updatePayload),
        }));
        console.log(`[LobbyRoom] Lobby ${this.lobbyId} updated to 'playing' in LobbyList (spectators can join)`);
      } catch (e) {
        console.error(`[LobbyRoom] Failed to update LobbyList status:`, e);
      }

      // Notify creator that match is ready
      if (this.creator?.connection) {
        this.creator.connection.send(JSON.stringify({
          type: 'match_ready',
          roomId: this.gameRoomId,
          webSocketUrl: this.gameWebSocketUrl,
          playerColor: this.creatorColor,
          opponent: {
            id: this.opponent.id,
            displayName: this.opponent.displayName,
            rating: this.opponent.rating,
          },
        }));
        console.log(`[LobbyRoom] Sent match_ready to creator with color: ${this.creatorColor}`);
      }

      console.log(`[LobbyRoom] Opponent joined, game room created: ${this.gameRoomId}, creator: ${this.creatorColor}, opponent: ${this.opponentColor}`);

      // Return game info to joining player (use cached color)
      return new Response(JSON.stringify({
        success: true,
        roomId: this.gameRoomId,
        webSocketUrl: this.gameWebSocketUrl,
        playerColor: this.opponentColor,
        opponent: {
          id: this.creator!.id,
          displayName: this.creator!.displayName,
          rating: this.creator!.rating,
        },
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('[LobbyRoom] Join error:', error);
      return new Response(JSON.stringify({ error: 'Failed to join lobby' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  private async handleGetState(): Promise<Response> {
    const state: LobbyState = {
      lobbyId: this.lobbyId,
      creatorId: this.creatorId,
      creator: this.creator!,
      opponent: this.opponent,
      settings: this.settings,
      status: this.status,
      createdAt: this.createdAt,
      gameRoomId: this.gameRoomId,
      webSocketUrl: this.gameWebSocketUrl,
    };

    return new Response(JSON.stringify(state), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleCancel(): Promise<Response> {
    await this.cancelAndRemoveFromList('Cancelled by creator');

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Cancel lobby and remove from global LobbyList
   */
  private async cancelAndRemoveFromList(reason: string): Promise<void> {
    if (this.status === 'cancelled') {
      return; // Already cancelled
    }

    this.status = 'cancelled';
    await this.persist();

    // Clear the timeout alarm
    try {
      await this.ctx.storage.deleteAlarm();
      console.log(`[LobbyRoom] Cleared alarm for lobby ${this.lobbyId} (cancelled)`);
    } catch (e) {
      // Alarm might already be cleared or not set
    }

    // Notify creator and close their connection
    if (this.creator?.connection) {
      this.creator.connection.send(JSON.stringify({
        type: 'lobby_cancelled',
        reason,
      }));
      // Close the WebSocket connection so client's onDone handler fires
      try {
        this.creator.connection.close(1000, reason);
      } catch (e) {
        console.error('[LobbyRoom] Error closing creator connection:', e);
      }
      this.creator.connection = undefined;
    }

    // Remove from global LobbyList
    try {
      const lobbyListId = this.env.LOBBY_LIST.idFromName('global');
      const lobbyListStub = this.env.LOBBY_LIST.get(lobbyListId);

      await lobbyListStub.fetch(new Request(`https://lobby-list/remove/${this.lobbyId}`, {
        method: 'DELETE',
      }));
      console.log(`[LobbyRoom] Lobby ${this.lobbyId} removed from LobbyList`);
    } catch (error) {
      console.error('[LobbyRoom] Failed to remove from LobbyList:', error);
    }

    console.log(`[LobbyRoom] Lobby ${this.lobbyId} cancelled: ${reason}`);
  }

  private async handleLeave(connection: Connection): Promise<void> {
    // Creator is leaving - cancel the lobby
    if (this.creator?.connection === connection) {
      await this.handleCancel();
    }
  }

  private sendStatusUpdate(connection: Connection): void {
    connection.send(JSON.stringify({
      type: 'waiting',
      status: this.status,
      createdAt: this.createdAt,
      settings: this.settings,
    }));
  }

  private async createGameRoom(): Promise<void> {
    // Generate unique game room ID
    this.gameRoomId = crypto.randomUUID();

    // Create GameRoom Durable Object
    const gameRoomId = this.env.GAME_ROOM.idFromName(this.gameRoomId);
    const gameRoomStub = this.env.GAME_ROOM.get(gameRoomId);

    // Use cached colors (must be assigned before calling this method!)
    if (!this.creatorColor || !this.opponentColor) {
      throw new Error('Colors not assigned before createGameRoom');
    }

    // Initialize game room with cached colors
    const initRequest = {
      gameMode: this.settings.gameMode,
      isLobbyMode: true,
      isUnrated: false,
      lobbyId: this.lobbyId, // Pass lobbyId so GameRoom can clean up lobby on game end
      openingName: this.settings.openingName,
      startingFen: this.settings.openingFen,
      players: {
        [this.creatorColor]: {
          id: this.creator!.id,
          displayName: this.creator!.displayName,
          rating: this.creator!.rating,
          isProvisional: this.creator!.isProvisional,
        },
        [this.opponentColor]: {
          id: this.opponent!.id,
          displayName: this.opponent!.displayName,
          rating: this.opponent!.rating,
          isProvisional: this.opponent!.isProvisional,
        },
      },
    };

    console.log(`[LobbyRoom] Initializing GameRoom with colors: creator=${this.creatorColor}, opponent=${this.opponentColor}`);

    await gameRoomStub.fetch(new Request(`https://game-room/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initRequest),
    }));

    // Store WebSocket URL - use production URL as fallback
    const host = this.ctx.url?.host || 'checkmatex-worker-production.rohitvinod-dev.workers.dev';
    this.gameWebSocketUrl = `wss://${host}/parties/game-room/${this.gameRoomId}`;

    console.log(`[LobbyRoom] Game room created: ${this.gameRoomId}`);
  }

  /**
   * Assign player colors ONCE and cache them.
   * This must be called before createGameRoom or sending match_ready.
   */
  private assignPlayerColors(): void {
    const colorChoice = this.settings.playerColor;

    if (colorChoice === 'random') {
      // Random assignment - only called once!
      const creatorIsWhite = Math.random() < 0.5;
      this.creatorColor = creatorIsWhite ? 'white' : 'black';
      this.opponentColor = creatorIsWhite ? 'black' : 'white';
    } else if (colorChoice === 'white') {
      this.creatorColor = 'white';
      this.opponentColor = 'black';
    } else {
      this.creatorColor = 'black';
      this.opponentColor = 'white';
    }

    console.log(`[LobbyRoom] Colors assigned: creator=${this.creatorColor}, opponent=${this.opponentColor}`);
  }

  /**
   * @deprecated Use assignPlayerColors() and access this.creatorColor/this.opponentColor instead
   */
  private determinePlayerColor(isCreator: boolean): PlayerColor {
    // Fallback for any legacy code - but colors should already be assigned
    if (this.creatorColor && this.opponentColor) {
      return isCreator ? this.creatorColor : this.opponentColor;
    }

    // Legacy behavior (should not be reached)
    const colorChoice = this.settings.playerColor;

    if (colorChoice === 'random') {
      const creatorIsWhite = Math.random() < 0.5;
      return isCreator
        ? (creatorIsWhite ? 'white' : 'black')
        : (creatorIsWhite ? 'black' : 'white');
    } else if (colorChoice === 'white') {
      return isCreator ? 'white' : 'black';
    } else {
      return isCreator ? 'black' : 'white';
    }
  }

  private async persist(): Promise<void> {
    // Exclude WebSocket connections from serialization (they can't be serialized)
    const creatorForStorage = this.creator ? {
      id: this.creator.id,
      displayName: this.creator.displayName,
      rating: this.creator.rating,
      isProvisional: this.creator.isProvisional,
      connectedAt: this.creator.connectedAt,
      // connection is excluded - WebSocket objects cannot be serialized
    } : undefined;

    const opponentForStorage = this.opponent ? {
      id: this.opponent.id,
      displayName: this.opponent.displayName,
      rating: this.opponent.rating,
      isProvisional: this.opponent.isProvisional,
      connectedAt: this.opponent.connectedAt,
      // connection is excluded - WebSocket objects cannot be serialized
    } : undefined;

    const state: LobbyState = {
      lobbyId: this.lobbyId,
      creatorId: this.creatorId,
      creator: creatorForStorage as LobbyParticipant,
      opponent: opponentForStorage,
      settings: this.settings,
      status: this.status,
      createdAt: this.createdAt,
      gameRoomId: this.gameRoomId,
      webSocketUrl: this.gameWebSocketUrl,
    };

    await this.ctx.storage.put('state', state);
  }
}
