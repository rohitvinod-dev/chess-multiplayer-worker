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
  GameRoom: DurableObjectNamespace;
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
const MATCHMAKING_TIMEOUT_SECONDS = 30; // Task 1: Increased from 20 to 30 seconds

interface QueueEntry {
  playerId: string;
  displayName: string;
  rating: number;
  isProvisional: boolean;
  gameMode: GameMode;
  joinedAt: number;
  minRating: number;
  maxRating: number;
  expiresAt: number; // Task 1: Added for cleanup
  origin?: string; // Origin for WebSocket URL generation
}

interface PendingMatch {
  roomId: string;
  color: string;
  opponentId: string;
  opponentDisplayName: string;
  opponentRating: number;
  accessToken: string;
  webSocketUrl: string;
  createdAt: number;
  expiresAt: number;
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
      try {
        // Get queue info from matchmaking queue
        const queueNamespace = env.MATCHMAKING_QUEUE;
        const queueId = queueNamespace.idFromName("global-queue");
        const queueStub = queueNamespace.get(queueId);

        const queueResponse = await queueStub.fetch(
          new Request("https://internal/queue/info", {
            method: "GET",
          })
        );

        if (queueResponse.ok) {
          const queueData = (await queueResponse.json()) as { queueSize: number };
          return new Response(
            JSON.stringify({
              status: "ok",
              timestamp: Date.now(),
              waiting: queueData.queueSize || 0,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
      } catch (error) {
        console.error("Error fetching queue info:", error);
      }

      // Fallback if queue info unavailable
      return new Response(
        JSON.stringify({
          status: "ok",
          timestamp: Date.now(),
          waiting: 0,
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

// ========== HELPER FUNCTIONS ==========
function getCanonicalOrigin(requestUrl: string): string {
  try {
    const url = new URL(requestUrl);

    // Handle internal Cloudflare routing or invalid hosts
    if (url.hostname === 'internal' || url.hostname === 'localhost' || url.port === '0') {
      return 'https://chess-multiplayer-worker.rohitvinod-dev.workers.dev';
    }

    // Remove default or invalid ports
    const protocol = url.protocol;
    const hostname = url.hostname;
    const port = url.port;

    if (port === '' || port === '0' ||
        (protocol === 'https:' && port === '443') ||
        (protocol === 'http:' && port === '80')) {
      return `${protocol}//${hostname}`;
    }

    // Keep non-standard ports (for development)
    return `${protocol}//${hostname}:${port}`;
  } catch (e) {
    console.error('Failed to parse request URL:', e);
    return 'https://chess-multiplayer-worker.rohitvinod-dev.workers.dev';
  }
}

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

    // Add player to queue - pass the real origin for WebSocket URL generation
    // Use sanitized origin to avoid port :0 from internal Cloudflare routing
    const realOrigin = getCanonicalOrigin(request.url);
    console.log('Extracted origin:', realOrigin, 'from request URL:', request.url);
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
          origin: realOrigin, // Pass the real origin for WebSocket URL generation
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
  private queueLoaded: boolean = false; // Task 3: Track if queue loaded from storage
  private pendingMatches: Map<string, PendingMatch> = new Map(); // Store pending matches for both players
  private pendingMatchesLoaded: boolean = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.queue = [];
    this.pendingMatches = new Map();
  }

  // Task 3: Load queue from storage on initialization
  private async loadQueue(): Promise<void> {
    if (this.queueLoaded) return;

    const stored = await this.state.storage.get<QueueEntry[]>('queue');
    if (stored) {
      // Filter out expired entries on load
      const now = Date.now();
      this.queue = stored.filter(entry => entry.expiresAt > now);
    } else {
      this.queue = [];
    }

    this.queueLoaded = true;
    console.log(`MatchmakingQueue: Loaded ${this.queue.length} entries from storage`);
  }

  // Task 3: Persist queue after changes
  private async saveQueue(): Promise<void> {
    await this.state.storage.put('queue', this.queue);
    console.log(`MatchmakingQueue: Saved ${this.queue.length} entries to storage`);
  }

  // Load pending matches from storage
  private async loadPendingMatches(): Promise<void> {
    if (this.pendingMatchesLoaded) return;

    const stored = await this.state.storage.get<Array<[string, PendingMatch]>>('pendingMatches');
    if (stored) {
      // Filter out expired pending matches
      const now = Date.now();
      this.pendingMatches = new Map(
        stored.filter(([_, match]) => match.expiresAt > now)
      );
    } else {
      this.pendingMatches = new Map();
    }

    this.pendingMatchesLoaded = true;
    console.log(`MatchmakingQueue: Loaded ${this.pendingMatches.size} pending matches from storage`);
  }

  // Persist pending matches after changes
  private async savePendingMatches(): Promise<void> {
    await this.state.storage.put('pendingMatches', Array.from(this.pendingMatches.entries()));
    console.log(`MatchmakingQueue: Saved ${this.pendingMatches.size} pending matches to storage`);
  }

  // Clean up expired pending matches
  private async cleanupExpiredPendingMatches(): Promise<void> {
    const now = Date.now();
    const initialCount = this.pendingMatches.size;

    for (const [playerId, match] of this.pendingMatches.entries()) {
      if (match.expiresAt <= now) {
        this.pendingMatches.delete(playerId);
      }
    }

    const removedCount = initialCount - this.pendingMatches.size;
    if (removedCount > 0) {
      console.log(`MatchmakingQueue: Cleaned up ${removedCount} expired pending matches`);
      await this.savePendingMatches();
    }
  }

  // Task 2: Improved rating range calculation algorithm for 30-second timeout
  private calculateRatingRange(entry: QueueEntry): { min: number; max: number } {
    const waitTimeSeconds = (Date.now() - entry.joinedAt) / 1000;

    // More aggressive expansion over 30 seconds
    let range: number;

    if (waitTimeSeconds < 10) {
      // First 10 seconds: ±150 (tight matching)
      range = 150;
    } else if (waitTimeSeconds < 20) {
      // 10-20 seconds: ±150 to ±250
      range = 150 + ((waitTimeSeconds - 10) * 10);
    } else if (waitTimeSeconds < 25) {
      // 20-25 seconds: ±250 to ±400
      range = 250 + ((waitTimeSeconds - 20) * 30);
    } else {
      // 25-30 seconds: ±400 to ±600 (any match)
      range = 400 + ((waitTimeSeconds - 25) * 40);
    }

    // Cap at 600
    const cappedRange = Math.min(range, 600);

    return {
      min: entry.rating - cappedRange,
      max: entry.rating + cappedRange,
    };
  }

  // Task 4: Fix bidirectional rating range matching
  private findMatch(entry: QueueEntry): QueueEntry | null {
    // Recalculate rating range for entry (time-based expansion)
    const entryRange = this.calculateRatingRange(entry);
    entry.minRating = entryRange.min;
    entry.maxRating = entryRange.max;

    for (const opponent of this.queue) {
      // Skip if different game mode
      if (opponent.gameMode !== entry.gameMode) continue;

      // Skip if same player
      if (opponent.playerId === entry.playerId) continue;

      // Recalculate opponent's rating range based on their wait time
      const opponentRange = this.calculateRatingRange(opponent);
      opponent.minRating = opponentRange.min;
      opponent.maxRating = opponentRange.max;

      // BIDIRECTIONAL CHECK: Both players must be within each other's range
      const entryAcceptsOpponent =
        opponent.rating >= entry.minRating &&
        opponent.rating <= entry.maxRating;

      const opponentAcceptsEntry =
        entry.rating >= opponent.minRating &&
        entry.rating <= opponent.maxRating;

      if (entryAcceptsOpponent && opponentAcceptsEntry) {
        console.log(`MatchmakingQueue: Match found!`);
        console.log(`  Player ${entry.playerId} (${entry.rating}) range: [${entry.minRating}, ${entry.maxRating}]`);
        console.log(`  Player ${opponent.playerId} (${opponent.rating}) range: [${opponent.minRating}, ${opponent.maxRating}]`);
        return opponent;
      }
    }

    console.log(`MatchmakingQueue: No match found for player ${entry.playerId} (${entry.rating})`);
    return null;
  }

  // Task 3: Cleanup expired entries
  private async cleanupExpiredEntries(): Promise<void> {
    const now = Date.now();
    const initialCount = this.queue.length;

    this.queue = this.queue.filter(entry => entry.expiresAt > now);

    const removedCount = initialCount - this.queue.length;
    if (removedCount > 0) {
      console.log(`MatchmakingQueue: Cleaned up ${removedCount} expired entries`);
      await this.saveQueue();
    }
  }

  private generateGameRoomId(player1: string, player2: string): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2, 9);
    return `game-${timestamp}-${random}`;
  }

  private buildWebSocketUrl(origin: string, roomId: string, playerInfo: {
    playerId: string;
    displayName: string;
    rating: number;
    isProvisional: boolean;
    color: string;
  }): string {
    let cleanOrigin = origin;

    try {
      const url = new URL(origin);

      // Reject internal/invalid hostnames
      if (url.hostname === 'internal' || url.hostname === 'localhost' || url.port === '0') {
        cleanOrigin = 'https://chess-multiplayer-worker.rohitvinod-dev.workers.dev';
      }

      // Remove port if it's :0 or default
      if (url.port === '0' || url.port === '443' || url.port === '80') {
        cleanOrigin = `${url.protocol}//${url.hostname}`;
      }
    } catch (e) {
      // If origin is malformed, use canonical URL
      console.error('Invalid origin provided:', origin, e);
      cleanOrigin = 'https://chess-multiplayer-worker.rohitvinod-dev.workers.dev';
    }

    // Convert to WebSocket protocol
    const wsBaseUrl = cleanOrigin
      .replace(/^https:/, 'wss:')
      .replace(/^http:/, 'ws:');

    // Construct full WebSocket URL with query parameters
    // PartyServer converts binding names to kebab-case: GameRoom -> game-room
    const wsUrl = `${wsBaseUrl}/parties/game-room/${roomId}?` +
      `playerId=${encodeURIComponent(playerInfo.playerId)}` +
      `&displayName=${encodeURIComponent(playerInfo.displayName)}` +
      `&rating=${playerInfo.rating}` +
      `&isProvisional=${playerInfo.isProvisional}` +
      `&color=${playerInfo.color}`;

    // Final validation: ensure URL doesn't contain :0
    if (wsUrl.includes(':0/') || wsUrl.includes(':0?')) {
      throw new Error(`Invalid WebSocket URL generated: ${wsUrl}`);
    }

    console.log(`Generated WebSocket URL: ${wsUrl}`);
    return wsUrl;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/queue/join" && request.method === "POST") {
      return this.handleJoinQueue(request);
    }

    // Task 7: Queue status polling endpoint
    if (url.pathname === "/queue/status" && request.method === "GET") {
      return this.handleStatusCheck(request);
    }

    // Task 7: Leave queue endpoint
    if (url.pathname === "/queue/leave" && request.method === "POST") {
      return this.handleLeaveQueue(request);
    }

    // Legacy queue status endpoint
    if (url.pathname === "/queue/info" && request.method === "GET") {
      return this.handleQueueInfo();
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleJoinQueue(request: Request): Promise<Response> {
    await this.loadQueue();
    await this.loadPendingMatches();

    // Clean up expired entries first
    await this.cleanupExpiredEntries();
    await this.cleanupExpiredPendingMatches();

    const body = (await request.json()) as {
      playerId: string;
      displayName: string;
      rating: number;
      isProvisional: boolean;
      gameMode: GameMode;
      joinedAt: number;
      origin?: string; // Origin from the main worker for WebSocket URL generation
    };

    // CRITICAL FIX: Check if this player has a pending match first
    const pendingMatch = this.pendingMatches.get(body.playerId);
    if (pendingMatch) {
      console.log(`MatchmakingQueue: Player ${body.playerId} has pending match, returning it`);
      // Remove the pending match so they can't get it again
      this.pendingMatches.delete(body.playerId);
      await this.savePendingMatches();

      return new Response(
        JSON.stringify({
          matched: true,
          roomId: pendingMatch.roomId,
          color: pendingMatch.color,
          opponentId: pendingMatch.opponentId,
          opponentDisplayName: pendingMatch.opponentDisplayName,
          opponentRating: pendingMatch.opponentRating,
          accessToken: pendingMatch.accessToken,
          webSocketUrl: pendingMatch.webSocketUrl,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Task 3: Check for duplicate entry (deduplication)
    const existingIndex = this.queue.findIndex(e => e.playerId === body.playerId);
    if (existingIndex !== -1) {
      // Remove old entry, will add fresh one
      this.queue.splice(existingIndex, 1);
      console.log(`MatchmakingQueue: Removed duplicate entry for player ${body.playerId}`);
    }

    // Create new entry with expiration
    const now = Date.now();
    const entry: QueueEntry = {
      playerId: body.playerId,
      displayName: body.displayName,
      rating: body.rating,
      isProvisional: body.isProvisional,
      gameMode: body.gameMode,
      joinedAt: body.joinedAt || now,
      minRating: 0,
      maxRating: 0,
      expiresAt: now + (MATCHMAKING_TIMEOUT_SECONDS * 1000), // Task 1: 30 second timeout
      origin: body.origin, // Store the origin for WebSocket URL generation
    };

    // Calculate initial rating range
    const range = this.calculateRatingRange(entry);
    entry.minRating = range.min;
    entry.maxRating = range.max;

    // Task 4: Try to find a match with bidirectional check
    const match = this.findMatch(entry);

    if (match) {
      // Match found - remove opponent from queue
      this.queue = this.queue.filter(e => e.playerId !== match.playerId);
      await this.saveQueue();

      // Create game room
      const roomId = this.generateGameRoomId(entry.playerId, match.playerId);

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

      // Randomly assign colors
      const playerColor = Math.random() > 0.5 ? "white" : "black";
      const opponentColor = playerColor === "white" ? "black" : "white";

      // Generate access tokens for both players
      const playerAccessToken = this.generateAccessToken(entry.playerId);
      const opponentAccessToken = this.generateAccessToken(match.playerId);

      // Generate WebSocket URLs using sanitized origin
      const playerWsUrl = this.buildWebSocketUrl(
        body.origin || "https://chess-multiplayer-worker.rohitvinod-dev.workers.dev",
        roomId,
        {
          playerId: entry.playerId,
          displayName: entry.displayName,
          rating: entry.rating,
          isProvisional: entry.isProvisional,
          color: playerColor,
        }
      );

      const opponentWsUrl = this.buildWebSocketUrl(
        body.origin || "https://chess-multiplayer-worker.rohitvinod-dev.workers.dev",
        roomId,
        {
          playerId: match.playerId,
          displayName: match.displayName,
          rating: match.rating,
          isProvisional: match.isProvisional,
          color: opponentColor,
        }
      );

      // CRITICAL FIX: Store pending match for the OPPONENT (who is still in queue and polling)
      // This ensures when they poll next, they get the match info
      const matchExpiresAt = now + (60 * 1000); // Expire in 60 seconds

      const opponentPendingMatch: PendingMatch = {
        roomId,
        color: opponentColor,
        opponentId: entry.playerId,
        opponentDisplayName: entry.displayName,
        opponentRating: entry.rating,
        accessToken: opponentAccessToken,
        webSocketUrl: opponentWsUrl,
        createdAt: now,
        expiresAt: matchExpiresAt,
      };

      this.pendingMatches.set(match.playerId, opponentPendingMatch);
      await this.savePendingMatches();

      console.log(`MatchmakingQueue: Created match ${roomId}`);
      console.log(`  Player ${entry.playerId} gets color: ${playerColor} (immediate response)`);
      console.log(`  Player ${match.playerId} gets color: ${opponentColor} (pending match stored)`);
      console.log(`  Player WebSocket URL: ${playerWsUrl}`);
      console.log(`  Opponent WebSocket URL: ${opponentWsUrl}`);

      // Return match info to the current player (entry)
      return new Response(
        JSON.stringify({
          matched: true,
          roomId,
          color: playerColor,
          opponentId: match.playerId,
          opponentDisplayName: match.displayName,
          opponentRating: match.rating,
          accessToken: playerAccessToken,
          webSocketUrl: playerWsUrl,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // No match - add to queue
    this.queue.push(entry);
    await this.saveQueue();

    return new Response(
      JSON.stringify({
        matched: false,
        queuePosition: this.queue.length,
        estimatedWait: MATCHMAKING_TIMEOUT_SECONDS,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // Task 7: Status check endpoint with match retry
  private async handleStatusCheck(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const playerId = url.searchParams.get('playerId');

    if (!playerId) {
      return new Response(JSON.stringify({ error: 'Missing playerId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    await this.loadQueue();
    await this.loadPendingMatches();
    await this.cleanupExpiredEntries();
    await this.cleanupExpiredPendingMatches();

    // Check if player is still in queue
    const entry = this.queue.find(e => e.playerId === playerId);

    if (!entry) {
      return new Response(JSON.stringify({
        inQueue: false,
        message: 'Player not in queue',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Try to find match with updated ranges (time has passed, ranges may have expanded)
    const match = this.findMatch(entry);

    if (match) {
      // Match found!
      this.queue = this.queue.filter(e =>
        e.playerId !== playerId && e.playerId !== match.playerId
      );
      await this.saveQueue();

      const roomId = this.generateGameRoomId(playerId, match.playerId);
      const now = Date.now();

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
      }

      // Randomly assign colors
      const playerColor = Math.random() > 0.5 ? "white" : "black";
      const opponentColor = playerColor === "white" ? "black" : "white";

      // Generate access tokens for both players
      const playerAccessToken = this.generateAccessToken(playerId);
      const opponentAccessToken = this.generateAccessToken(match.playerId);

      // Generate WebSocket URLs using sanitized origin
      const playerWsUrl = this.buildWebSocketUrl(
        entry.origin || "https://chess-multiplayer-worker.rohitvinod-dev.workers.dev",
        roomId,
        {
          playerId: playerId,
          displayName: entry.displayName,
          rating: entry.rating,
          isProvisional: entry.isProvisional,
          color: playerColor,
        }
      );

      const opponentWsUrl = this.buildWebSocketUrl(
        entry.origin || "https://chess-multiplayer-worker.rohitvinod-dev.workers.dev",
        roomId,
        {
          playerId: match.playerId,
          displayName: match.displayName,
          rating: match.rating,
          isProvisional: match.isProvisional,
          color: opponentColor,
        }
      );

      // Store pending match for opponent
      const matchExpiresAt = now + (60 * 1000);
      const opponentPendingMatch: PendingMatch = {
        roomId,
        color: opponentColor,
        opponentId: playerId,
        opponentDisplayName: entry.displayName,
        opponentRating: entry.rating,
        accessToken: opponentAccessToken,
        webSocketUrl: opponentWsUrl,
        createdAt: now,
        expiresAt: matchExpiresAt,
      };

      this.pendingMatches.set(match.playerId, opponentPendingMatch);
      await this.savePendingMatches();

      return new Response(JSON.stringify({
        inQueue: false,
        matched: true,
        roomId,
        color: playerColor,
        opponentId: match.playerId,
        opponentDisplayName: match.displayName,
        opponentRating: match.rating,
        accessToken: playerAccessToken,
        webSocketUrl: playerWsUrl,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Still waiting
    const waitTime = (Date.now() - entry.joinedAt) / 1000;
    const range = this.calculateRatingRange(entry);

    return new Response(JSON.stringify({
      inQueue: true,
      matched: false,
      queuePosition: this.queue.indexOf(entry) + 1,
      totalInQueue: this.queue.length,
      waitTimeSeconds: Math.floor(waitTime),
      currentRatingRange: range,
      expiresIn: Math.floor((entry.expiresAt - Date.now()) / 1000),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Task 7: Leave queue endpoint
  private async handleLeaveQueue(request: Request): Promise<Response> {
    const body = await request.json() as { playerId: string };

    await this.loadQueue();

    const initialLength = this.queue.length;
    this.queue = this.queue.filter(e => e.playerId !== body.playerId);

    if (this.queue.length < initialLength) {
      await this.saveQueue();
      console.log(`MatchmakingQueue: Player ${body.playerId} left queue`);
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleQueueInfo(): Promise<Response> {
    await this.loadQueue();
    await this.cleanupExpiredEntries();

    return new Response(
      JSON.stringify({
        queueSize: this.queue.length,
        players: this.queue.map((entry) => ({
          gameMode: entry.gameMode,
          rating: entry.rating,
          waitTime: Date.now() - entry.joinedAt,
          expiresIn: Math.floor((entry.expiresAt - Date.now()) / 1000),
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

