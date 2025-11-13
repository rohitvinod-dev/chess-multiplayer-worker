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
  STATS_TRACKER: DurableObjectNamespace;
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

    // ========== STATS ENDPOINTS ==========
    if (url.pathname === "/stats/online-players" && request.method === "GET") {
      return handleOnlinePlayersStats(env);
    }

    if (url.pathname === "/stats/games-24h" && request.method === "GET") {
      return handleGames24hStats(env);
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

// ========== STATS HANDLERS ==========
async function handleOnlinePlayersStats(env: Env): Promise<Response> {
  try {
    const statsNamespace = env.STATS_TRACKER;
    const statsId = statsNamespace.idFromName("global-stats");
    const statsStub = statsNamespace.get(statsId);

    const response = await statsStub.fetch(
      new Request("https://internal/stats/online-players", {
        method: "GET",
      })
    );

    return response;
  } catch (error) {
    console.error("Error fetching online players stats:", error);
    return new Response(
      JSON.stringify({ count: 0, error: String(error) }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      }
    );
  }
}

async function handleGames24hStats(env: Env): Promise<Response> {
  try {
    const statsNamespace = env.STATS_TRACKER;
    const statsId = statsNamespace.idFromName("global-stats");
    const statsStub = statsNamespace.get(statsId);

    const response = await statsStub.fetch(
      new Request("https://internal/stats/games-24h", {
        method: "GET",
      })
    );

    return response;
  } catch (error) {
    console.error("Error fetching games-24h stats:", error);
    return new Response(
      JSON.stringify({ count: 0, error: String(error) }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      }
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

    // Calculate rating range (expands over time, optimized for 20s timeout)
    const waitTimeSeconds = (Date.now() - entry.joinedAt) / 1000;

    // Base range: 150
    // Expands by 50 every 5 seconds
    // Extra aggressive expansion in final 2 seconds
    let baseRange = 150;
    let ratingRangeExpansion = Math.floor(waitTimeSeconds / 5) * 50;

    // Aggressive expansion in final 2 seconds (18s+)
    if (waitTimeSeconds >= 18) {
      ratingRangeExpansion += 150; // Add extra 150 in last 2 seconds
    }

    const range = baseRange + ratingRangeExpansion;
    // Cap at reasonable maximum to avoid absurd mismatches
    const cappedRange = Math.min(range, 600);

    entry.minRating = entry.rating - cappedRange;
    entry.maxRating = entry.rating + cappedRange;

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

      // Track game creation in stats
      try {
        const statsNamespace = this.env.STATS_TRACKER;
        const statsId = statsNamespace.idFromName("global-stats");
        const statsStub = statsNamespace.get(statsId);
        await statsStub.fetch(
          new Request("https://internal/stats/game-created", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ gameId: roomId }),
          })
        );
      } catch (error) {
        console.error("Failed to track game creation:", error);
        // Don't fail the match if stats tracking fails
      }

      // Generate WebSocket URL
      const baseUrl = new URL(request.url).origin || "https://chess-multiplayer-worker.rohitvinod-dev.workers.dev";
      const webSocketUrl = `${baseUrl}/party/gameroom/${roomId}`;

      const accessToken = this.generateAccessToken(entry.playerId);
      const playerColor = Math.random() > 0.5 ? "white" : "black";

      return new Response(
        JSON.stringify({
          matched: true,
          roomId,
          color: playerColor,
          opponentId: opponent.playerId,
          opponentDisplayName: opponent.displayName,
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

// ========== STATS TRACKER DURABLE OBJECT ==========
export class StatsTracker {
  private state: DurableObjectState;
  private env: Env;
  private sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sql = this.state.storage.sql;
    this.initializeDatabase();
  }

  private initializeDatabase() {
    // Table to track active connections (online players)
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS active_connections (
        connection_id TEXT PRIMARY KEY,
        player_id TEXT NOT NULL,
        connected_at INTEGER NOT NULL
      )`
    );

    // Table to track game creations
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS game_history (
        game_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )`
    );

    // Create index for faster 24h queries
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_game_created_at ON game_history(created_at)`
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const corsHeaders = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Get online players count
    if (url.pathname === "/stats/online-players" && request.method === "GET") {
      try {
        const result = this.sql.exec(
          `SELECT COUNT(DISTINCT player_id) as count FROM active_connections`
        );
        const count = result.toArray()[0]?.count || 0;

        return new Response(
          JSON.stringify({ count }),
          { status: 200, headers: corsHeaders }
        );
      } catch (error) {
        console.error("Error getting online players:", error);
        return new Response(
          JSON.stringify({ count: 0, error: String(error) }),
          { status: 200, headers: corsHeaders }
        );
      }
    }

    // Get games in last 24 hours
    if (url.pathname === "/stats/games-24h" && request.method === "GET") {
      try {
        const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);

        // Clean up old games (older than 48 hours) to prevent unlimited growth
        const twoDaysAgo = Date.now() - (48 * 60 * 60 * 1000);
        this.sql.exec(
          `DELETE FROM game_history WHERE created_at < ${twoDaysAgo}`
        );

        // Get count of games in last 24 hours
        const result = this.sql.exec(
          `SELECT COUNT(*) as count FROM game_history WHERE created_at >= ${oneDayAgo}`
        );
        const count = result.toArray()[0]?.count || 0;

        return new Response(
          JSON.stringify({ count }),
          { status: 200, headers: corsHeaders }
        );
      } catch (error) {
        console.error("Error getting games-24h:", error);
        return new Response(
          JSON.stringify({ count: 0, error: String(error) }),
          { status: 200, headers: corsHeaders }
        );
      }
    }

    // Track player connection
    if (url.pathname === "/stats/player-connected" && request.method === "POST") {
      try {
        const body = await request.json() as { playerId: string; connectionId: string };

        // Clean up stale connections (older than 5 minutes)
        const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
        this.sql.exec(
          `DELETE FROM active_connections WHERE connected_at < ${fiveMinutesAgo}`
        );

        // Add new connection
        this.sql.exec(
          `INSERT OR REPLACE INTO active_connections (connection_id, player_id, connected_at)
           VALUES ('${body.connectionId}', '${body.playerId}', ${Date.now()})`
        );

        return new Response(
          JSON.stringify({ success: true }),
          { status: 200, headers: corsHeaders }
        );
      } catch (error) {
        console.error("Error tracking player connection:", error);
        return new Response(
          JSON.stringify({ success: false, error: String(error) }),
          { status: 500, headers: corsHeaders }
        );
      }
    }

    // Track player disconnection
    if (url.pathname === "/stats/player-disconnected" && request.method === "POST") {
      try {
        const body = await request.json() as { connectionId: string };

        this.sql.exec(
          `DELETE FROM active_connections WHERE connection_id = '${body.connectionId}'`
        );

        return new Response(
          JSON.stringify({ success: true }),
          { status: 200, headers: corsHeaders }
        );
      } catch (error) {
        console.error("Error tracking player disconnection:", error);
        return new Response(
          JSON.stringify({ success: false, error: String(error) }),
          { status: 500, headers: corsHeaders }
        );
      }
    }

    // Track game creation
    if (url.pathname === "/stats/game-created" && request.method === "POST") {
      try {
        const body = await request.json() as { gameId: string };

        this.sql.exec(
          `INSERT OR IGNORE INTO game_history (game_id, created_at)
           VALUES ('${body.gameId}', ${Date.now()})`
        );

        return new Response(
          JSON.stringify({ success: true }),
          { status: 200, headers: corsHeaders }
        );
      } catch (error) {
        console.error("Error tracking game creation:", error);
        return new Response(
          JSON.stringify({ success: false, error: String(error) }),
          { status: 500, headers: corsHeaders }
        );
      }
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  }
}

