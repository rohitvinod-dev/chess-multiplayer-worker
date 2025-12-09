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

  // Timeout tracking
  timeoutId?: number;
  maxWaitTimeMs = 5 * 60 * 1000; // 5 minutes

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
    }

    // Start timeout timer
    this.startTimeoutTimer();
  }

  async onConnect(connection: Connection) {
    const userId = new URL(connection.url).searchParams.get('userId');
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
      console.log(`[LobbyRoom] Creator ${userId} connected`);

      // Send current status
      this.sendStatusUpdate(connection);
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
    console.log(`[LobbyRoom] Connection closed`);

    // Remove connection reference
    if (this.creator?.connection === connection) {
      this.creator.connection = undefined;
    }
    if (this.opponent?.connection === connection) {
      this.opponent.connection = undefined;
    }
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

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

      console.log(`[LobbyRoom] Initialized lobby ${this.lobbyId}`);

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

      // Notify creator via WebSocket
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

      // Update status
      this.status = 'matched';
      await this.persist();

      // Notify creator that match is ready
      if (this.creator?.connection) {
        const creatorColor = this.determinePlayerColor(true);
        const opponentColor = creatorColor === 'white' ? 'black' : 'white';

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

      // Clear timeout timer
      if (this.timeoutId) {
        clearTimeout(this.timeoutId);
        this.timeoutId = undefined;
      }

      console.log(`[LobbyRoom] Opponent joined, game room created: ${this.gameRoomId}`);

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
    this.status = 'cancelled';
    await this.persist();

    // Notify creator
    if (this.creator?.connection) {
      this.creator.connection.send(JSON.stringify({
        type: 'lobby_cancelled',
        reason: 'Cancelled by creator',
      }));
    }

    // Clear timeout
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = undefined;
    }

    console.log(`[LobbyRoom] Lobby cancelled`);

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
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
    const gameRoomId = this.ctx.env.GAME_ROOM.idFromName(this.gameRoomId);
    const gameRoomStub = this.ctx.env.GAME_ROOM.get(gameRoomId);

    // Determine colors
    const creatorColor = this.determinePlayerColor(true);
    const opponentColor = creatorColor === 'white' ? 'black' : 'white';

    // Initialize game room
    const initRequest = {
      gameMode: this.settings.gameMode,
      isLobbyMode: true,
      isUnrated: false,
      openingName: this.settings.openingName,
      startingFen: this.settings.openingFen,
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
    };

    await gameRoomStub.fetch(new Request(`https://game-room/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initRequest),
    }));

    // Store WebSocket URL
    this.gameWebSocketUrl = `wss://${this.ctx.url.host}/api/game/${this.gameRoomId}/ws`;

    console.log(`[LobbyRoom] Game room created: ${this.gameRoomId}`);
  }

  private determinePlayerColor(isCreator: boolean): PlayerColor {
    const colorChoice = this.settings.playerColor;

    if (colorChoice === 'random') {
      // Random assignment
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

  private startTimeoutTimer(): void {
    this.timeoutId = setTimeout(() => {
      this.handleTimeout();
    }, this.maxWaitTimeMs) as unknown as number;

    console.log(`[LobbyRoom] Timeout timer started (${this.maxWaitTimeMs}ms)`);
  }

  private async handleTimeout(): Promise<void> {
    if (this.status !== 'waiting') {
      return; // Already matched or cancelled
    }

    console.log(`[LobbyRoom] Lobby timed out after ${this.maxWaitTimeMs}ms`);

    this.status = 'cancelled';
    await this.persist();

    // Notify creator
    if (this.creator?.connection) {
      this.creator.connection.send(JSON.stringify({
        type: 'lobby_cancelled',
        reason: 'No opponent found within 5 minutes',
      }));
    }

    // Update LobbyList to remove this lobby
    try {
      const lobbyListId = this.ctx.env.LOBBY_LIST.idFromName('global');
      const lobbyListStub = this.ctx.env.LOBBY_LIST.get(lobbyListId);

      await lobbyListStub.fetch(new Request(`https://lobby-list/remove/${this.lobbyId}`, {
        method: 'POST',
      }));
    } catch (error) {
      console.error('[LobbyRoom] Failed to remove from LobbyList:', error);
    }
  }

  private async persist(): Promise<void> {
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

    await this.ctx.storage.put('state', state);
  }
}
