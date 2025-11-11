import {
  type Connection,
  Server,
  type WSMessage,
  routePartykitRequest,
} from "partyserver";

import type { ChatMessage, Message, GameMode } from "../shared";
export { GameRoom } from "./game-room";

// ============ TYPE DEFINITIONS ============
export interface Env {
  Chat: DurableObjectNamespace;
  GAME_ROOM: DurableObjectNamespace;
  MATCHMAKING_QUEUE: DurableObjectNamespace;
  ASSETS: Fetcher;
}

// ============ CHAT ROOM ============
export class Chat extends Server<Env> {
  static options = { hibernate: true };

  messages = [] as ChatMessage[];

  broadcastMessage(message: Message, exclude?: string[]) {
    this.broadcast(JSON.stringify(message), exclude);
  }

  onStart() {
    // create the messages table if it doesn't exist
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, user TEXT, role TEXT, content TEXT)`,
    );

    // load the messages from the database
    this.messages = this.ctx.storage.sql
      .exec(`SELECT * FROM messages`)
      .toArray() as ChatMessage[];
  }

  onConnect(connection: Connection) {
    connection.send(
      JSON.stringify({
        type: "all",
        messages: this.messages,
      } satisfies Message),
    );
  }

  saveMessage(message: ChatMessage) {
    const existingMessage = this.messages.find((m) => m.id === message.id);
    if (existingMessage) {
      this.messages = this.messages.map((m) => {
        if (m.id === message.id) {
          return message;
        }
        return m;
      });
    } else {
      this.messages.push(message);
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO messages (id, user, role, content) VALUES ('${
        message.id
      }', '${message.user}', '${message.role}', ${JSON.stringify(
        message.content,
      )}) ON CONFLICT (id) DO UPDATE SET content = ${JSON.stringify(
        message.content,
      )}`,
    );
  }

  onMessage(connection: Connection, message: WSMessage) {
    this.broadcast(message);

    const parsed = JSON.parse(message as string) as Message;
    if (parsed.type === "add" || parsed.type === "update") {
      this.saveMessage(parsed);
    }
  }
}

// ============ MATCHMAKING QUEUE ============
interface QueueEntry {
  playerId: string;
  displayName: string;
  rating: number;
  isProvisional: boolean;
  gameMode: GameMode;
  joinedAt: number;
  minRating: number;
  maxRating: number;
}

// ============ MAIN WORKER ============
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    // Route PartyKit requests (chat and games)
    const partykitResponse = await routePartykitRequest(request, {
      ...env,
    });
    if (partykitResponse) {
      return partykitResponse;
    }

    // ========== MATCHMAKING ENDPOINT ==========
    if (url.pathname === "/matchmake" && request.method === "POST") {
      return handleMatchmake(request, env);
    }

    // ========== HEALTH CHECK ==========
    if (url.pathname === "/health" && request.method === "GET") {
      return new Response(
        JSON.stringify({
          status: "ok",
          timestamp: Date.now(),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Fall back to static assets
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

// ========== MATCHMAKING HANDLER ==========
async function handleMatchmake(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = (await request.json()) as {
      playerId: string;
      displayName: string;
      rating: number;
      isProvisional: boolean;
      gameMode: GameMode;
      authToken: string;
    };

    const {
      playerId,
      displayName,
      rating,
      isProvisional,
      gameMode,
      authToken,
    } = body;

    // Validate required fields
    if (!playerId || !gameMode || !authToken) {
      return new Response(
        JSON.stringify({
          error: "Missing required fields",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Get matchmaking queue from Durable Object
    const queueNamespace = env.MATCHMAKING_QUEUE;
    const queueId = queueNamespace.idFromName("global-queue");
    const queueStub = queueNamespace.get(queueId);

    // Add player to queue
    const response = await queueStub.fetch(
      new Request("https://internal/queue/join", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          playerId,
          displayName,
          rating,
          isProvisional,
          gameMode,
          joinedAt: Date.now(),
        }),
      })
    );

    if (!response.ok) {
      return response;
    }

    const matchInfo = (await response.json()) as {
      matched: boolean;
      roomId?: string;
      color?: string;
      accessToken?: string;
      webSocketUrl?: string;
      queuePosition?: number;
      estimatedWait?: number;
    };

    return new Response(JSON.stringify(matchInfo), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error in matchmake:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
        message: String(error),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

// ========== MATCHMAKING QUEUE DURABLE OBJECT ==========
export class MatchmakingQueue {
  private state: DurableObjectState;
  private env: Env;
  private queue: QueueEntry[] = [];

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.queue = [];
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/queue/join" && request.method === "POST") {
      return this.handleJoinQueue(request);
    }

    if (url.pathname === "/queue/status" && request.method === "GET") {
      return this.handleQueueStatus();
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleJoinQueue(request: Request): Promise<Response> {
    const entry = (await request.json()) as QueueEntry;

    // Calculate rating range (expands over time)
    const waitTimeSeconds = (Date.now() - entry.joinedAt) / 1000;
    const ratingRangeExpansion = Math.floor(waitTimeSeconds / 15) * 50;
    const baseRange = 200;
    const range = baseRange + ratingRangeExpansion;

    entry.minRating = entry.rating - range;
    entry.maxRating = entry.rating + range;

    // Try to find a match
    const opponentIndex = this.queue.findIndex((opponent) => {
      if (opponent.gameMode !== entry.gameMode) return false;
      if (opponent.playerId === entry.playerId) return false;
      if (
        opponent.rating < entry.minRating ||
        opponent.rating > entry.maxRating
      )
        return false;
      return true;
    });

    if (opponentIndex !== -1) {
      // Match found!
      const opponent = this.queue[opponentIndex];
      this.queue.splice(opponentIndex, 1);

      // Create game room
      const gameRoomNamespace = this.env.GAME_ROOM;
      const roomId = `game-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const gameRoomId = gameRoomNamespace.idFromName(roomId);
      const gameRoomStub = gameRoomNamespace.get(gameRoomId);

      // Generate WebSocket URL
      const baseUrl = new URL(request.url).origin || "https://chess-multiplayer-worker.rohitvinod-dev.workers.dev";
      const webSocketUrl = `${baseUrl}/party/gameroom/${roomId}`;

      const accessToken = this.generateAccessToken(entry.playerId);

      return new Response(
        JSON.stringify({
          matched: true,
          roomId,
          color: Math.random() > 0.5 ? "white" : "black",
          accessToken,
          webSocketUrl,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    } else {
      // No match, add to queue
      this.queue.push(entry);

      return new Response(
        JSON.stringify({
          matched: false,
          queuePosition: this.queue.length,
          estimatedWait:
            30 - (Date.now() - entry.joinedAt) / 1000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  private handleQueueStatus(): Response {
    return new Response(
      JSON.stringify({
        queueSize: this.queue.length,
        players: this.queue.map((entry) => ({
          gameMode: entry.gameMode,
          rating: entry.rating,
          waitTime: Date.now() - entry.joinedAt,
        })),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  private generateAccessToken(playerId: string): string {
    // In production, use a proper JWT library
    const payload = {
      playerId,
      iat: Date.now(),
      exp: Date.now() + 3600000, // 1 hour
    };
    const jsonStr = JSON.stringify(payload);
    // Simple base64 encoding without Buffer
    return btoa(jsonStr);
  }
}

