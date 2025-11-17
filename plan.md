# Chess Multiplayer Worker - Backend Implementation Plan

## Overview
Critical fixes for the chess matchmaking system including WebSocket connection management, queue persistence, ELO range expansion, and timeout adjustments.

**Status**: Ready for Implementation
**Created**: 2025-01-17
**Priority**: P0 Critical Bug Fix
**Estimated Time**: 3-5 days

---

## Problem Summary

### Current Issues
1. **Player 1 connects then immediately disconnects** - WebSocket connection not stable
2. **Player 2 never gets connection confirmation** - Synchronization failure between matched players
3. **Matchmaking timeout is 20 seconds** - Should be 30 seconds
4. **ELO range expansion not optimized** - Players not finding matches within expanded ranges
5. **In-memory queue lost on restart** - No persistence to Durable Object storage
6. **Race conditions** - Same player can enter queue multiple times

---

## Root Cause Analysis

### File: `src/server/index.ts` (MatchmakingQueue)

**Lines 285-434:**
```typescript
export class MatchmakingQueue extends DurableObject {
  private queue: QueueEntry[] = []; // IN-MEMORY ONLY - LOST ON RESTART

  // Rating range calculation (lines 314-329)
  let baseRange = 150;
  let ratingRangeExpansion = Math.floor(waitTimeSeconds / 5) * 50;
  if (waitTimeSeconds >= 18) {
    ratingRangeExpansion += 150; // Only extra 150 in last 2 seconds
  }
  const cappedRange = Math.min(range, 600);
}
```

**Issues:**
1. Queue is purely in-memory - no `this.state.storage` usage
2. Rating range expansion only considers entry player, not opponent's wait time
3. No cleanup mechanism for stale queue entries
4. No deduplication check for same player

### File: `src/server/game-room.ts` (GameRoom)

**Lines 161-196 - Connection Handling:**
```typescript
private handleDisconnect(playerId: string) {
  const player = this.gameState.players.get(playerId);
  if (player) {
    player.connected = false; // Marks disconnected
    // Sets 10-second abandonment timeout
  }
}
```

**Issues:**
1. No heartbeat/ping mechanism to verify connection
2. WebSocket close event may not fire reliably
3. No reconnection handling for temporary disconnects
4. Game state transitions not properly synchronized

---

## Implementation Plan

### Task 1: Increase Matchmaking Timeout to 30 Seconds

**File**: `src/server/index.ts`

```typescript
// Around line 402 - Update timeout constant
const MATCHMAKING_TIMEOUT_SECONDS = 30; // Was 20

// Update queue entry structure
interface QueueEntry {
  playerId: string;
  rating: number;
  gameMode: string;
  joinedAt: number;
  minRating: number;
  maxRating: number;
  expiresAt: number; // Added for cleanup
}

// In addToQueue method
async addToQueue(playerId: string, rating: number, gameMode: string): Promise<QueueResult> {
  const now = Date.now();
  const expiresAt = now + (MATCHMAKING_TIMEOUT_SECONDS * 1000);

  const entry: QueueEntry = {
    playerId,
    rating,
    gameMode,
    joinedAt: now,
    minRating: 0,
    maxRating: 0,
    expiresAt,
  };

  // ... rest of logic
}
```

### Task 2: Adjust ELO Range Expansion Algorithm

**File**: `src/server/index.ts`

```typescript
// Replace lines 314-329 with improved algorithm
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
```

### Task 3: Persist Queue to Durable Object Storage

**File**: `src/server/index.ts`

```typescript
export class MatchmakingQueue extends DurableObject {
  private queue: QueueEntry[] = [];
  private queueLoaded: boolean = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  // Load queue from storage on initialization
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

  // Persist queue after changes
  private async saveQueue(): Promise<void> {
    await this.state.storage.put('queue', this.queue);
    console.log(`MatchmakingQueue: Saved ${this.queue.length} entries to storage`);
  }

  async addToQueue(playerId: string, rating: number, gameMode: string): Promise<QueueResult> {
    await this.loadQueue();

    // Clean up expired entries first
    await this.cleanupExpiredEntries();

    // Check for duplicate entry
    const existingIndex = this.queue.findIndex(e => e.playerId === playerId);
    if (existingIndex !== -1) {
      // Remove old entry, will add fresh one
      this.queue.splice(existingIndex, 1);
      console.log(`MatchmakingQueue: Removed duplicate entry for player ${playerId}`);
    }

    // Create new entry
    const now = Date.now();
    const entry: QueueEntry = {
      playerId,
      rating,
      gameMode,
      joinedAt: now,
      minRating: 0,
      maxRating: 0,
      expiresAt: now + (MATCHMAKING_TIMEOUT_SECONDS * 1000),
    };

    // Calculate initial rating range
    const range = this.calculateRatingRange(entry);
    entry.minRating = range.min;
    entry.maxRating = range.max;

    // Try to find a match
    const match = await this.findMatch(entry);

    if (match) {
      // Match found - remove opponent from queue
      this.queue = this.queue.filter(e => e.playerId !== match.playerId);
      await this.saveQueue();

      return {
        matched: true,
        opponentId: match.playerId,
        opponentRating: match.rating,
        gameRoomId: this.generateGameRoomId(playerId, match.playerId),
      };
    }

    // No match - add to queue
    this.queue.push(entry);
    await this.saveQueue();

    return {
      matched: false,
      queuePosition: this.queue.length,
      estimatedWait: MATCHMAKING_TIMEOUT_SECONDS,
    };
  }

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
    const sortedIds = [player1, player2].sort().join('_');
    const timestamp = Date.now().toString(36);
    return `game_${sortedIds}_${timestamp}`;
  }
}

interface QueueResult {
  matched: boolean;
  opponentId?: string;
  opponentRating?: number;
  gameRoomId?: string;
  queuePosition?: number;
  estimatedWait?: number;
}
```

### Task 4: Fix Bidirectional Rating Range Matching

**File**: `src/server/index.ts`

```typescript
// Replace lines 335-344 with improved matching
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
```

### Task 5: Fix WebSocket Connection Synchronization

**File**: `src/server/game-room.ts`

```typescript
export class GameRoom extends DurableObject {
  private gameState: GameState;
  private connections: Map<string, WebSocket> = new Map();
  private heartbeatTimers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private lastPingTimes: Map<string, number> = new Map();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.gameState = this.initializeGameState();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/websocket') {
      return this.handleWebSocketUpgrade(request);
    }

    if (url.pathname === '/join') {
      return this.handleJoinGame(request);
    }

    return new Response('Not found', { status: 404 });
  }

  private handleWebSocketUpgrade(request: Request): Response {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 400 });
    }

    const playerId = new URL(request.url).searchParams.get('playerId');
    if (!playerId) {
      return new Response('Missing playerId', { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept the WebSocket connection
    server.accept();

    // Store connection
    this.connections.set(playerId, server);
    this.lastPingTimes.set(playerId, Date.now());

    // Set up event handlers
    server.addEventListener('message', (event) => {
      this.handleMessage(playerId, event.data as string);
    });

    server.addEventListener('close', () => {
      this.handleDisconnect(playerId);
    });

    server.addEventListener('error', (error) => {
      console.error(`GameRoom: WebSocket error for ${playerId}:`, error);
      this.handleDisconnect(playerId);
    });

    // Start heartbeat monitoring
    this.startHeartbeat(playerId);

    // Mark player as connected
    const player = this.gameState.players.get(playerId);
    if (player) {
      player.connected = true;

      // Notify opponent of connection
      this.notifyOpponentOfConnection(playerId);

      // Send game state to newly connected player
      this.sendGameState(playerId);
    }

    console.log(`GameRoom: Player ${playerId} connected via WebSocket`);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private startHeartbeat(playerId: string): void {
    // Clear existing timer if any
    const existingTimer = this.heartbeatTimers.get(playerId);
    if (existingTimer) {
      clearInterval(existingTimer);
    }

    // Send ping every 10 seconds
    const timer = setInterval(() => {
      const ws = this.connections.get(playerId);
      if (ws && ws.readyState === WebSocket.READY_STATE_OPEN) {
        ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));

        // Check if player responded to last ping
        const lastPing = this.lastPingTimes.get(playerId) || 0;
        const now = Date.now();

        if (now - lastPing > 30000) {
          // No pong received in 30 seconds - consider disconnected
          console.log(`GameRoom: Player ${playerId} unresponsive, disconnecting`);
          this.handleDisconnect(playerId);
        }
      }
    }, 10000);

    this.heartbeatTimers.set(playerId, timer);
  }

  private handleMessage(playerId: string, data: string): void {
    try {
      const message = JSON.parse(data);

      // Update last ping time for any message received
      this.lastPingTimes.set(playerId, Date.now());

      switch (message.type) {
        case 'pong':
          // Heartbeat response
          console.log(`GameRoom: Received pong from ${playerId}`);
          break;

        case 'move':
          this.handleMove(playerId, message);
          break;

        case 'resign':
          this.handleResign(playerId);
          break;

        case 'chat':
          this.handleChat(playerId, message.content);
          break;

        case 'ready':
          this.handlePlayerReady(playerId);
          break;

        default:
          console.log(`GameRoom: Unknown message type: ${message.type}`);
      }
    } catch (error) {
      console.error(`GameRoom: Error parsing message from ${playerId}:`, error);
    }
  }

  private notifyOpponentOfConnection(playerId: string): void {
    // Find opponent
    for (const [id, player] of this.gameState.players) {
      if (id !== playerId && player.connected) {
        const ws = this.connections.get(id);
        if (ws && ws.readyState === WebSocket.READY_STATE_OPEN) {
          ws.send(JSON.stringify({
            type: 'opponent_connected',
            playerId,
            timestamp: Date.now(),
          }));
        }
      }
    }
  }

  private sendGameState(playerId: string): void {
    const ws = this.connections.get(playerId);
    if (!ws || ws.readyState !== WebSocket.READY_STATE_OPEN) return;

    // Send current game state
    ws.send(JSON.stringify({
      type: 'game_state',
      state: this.serializeGameState(),
      timestamp: Date.now(),
    }));
  }

  private handleDisconnect(playerId: string): void {
    console.log(`GameRoom: Player ${playerId} disconnected`);

    // Clean up heartbeat timer
    const timer = this.heartbeatTimers.get(playerId);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(playerId);
    }

    // Remove connection
    this.connections.delete(playerId);
    this.lastPingTimes.delete(playerId);

    // Mark player as disconnected
    const player = this.gameState.players.get(playerId);
    if (player) {
      player.connected = false;

      // Notify opponent
      this.notifyOpponentOfDisconnection(playerId);

      // Start abandonment timer (10 seconds)
      setTimeout(() => {
        if (!player.connected) {
          console.log(`GameRoom: Player ${playerId} abandoned game`);
          this.handleAbandonment(playerId);
        }
      }, 10000);
    }
  }

  private notifyOpponentOfDisconnection(playerId: string): void {
    for (const [id, player] of this.gameState.players) {
      if (id !== playerId && player.connected) {
        const ws = this.connections.get(id);
        if (ws && ws.readyState === WebSocket.READY_STATE_OPEN) {
          ws.send(JSON.stringify({
            type: 'opponent_disconnected',
            playerId,
            reconnectTimeout: 10000, // 10 seconds to reconnect
            timestamp: Date.now(),
          }));
        }
      }
    }
  }

  private serializeGameState(): object {
    return {
      fen: this.gameState.fen,
      players: Array.from(this.gameState.players.entries()).map(([id, p]) => ({
        id,
        color: p.color,
        rating: p.rating,
        connected: p.connected,
        timeRemaining: p.timeRemaining,
      })),
      currentTurn: this.gameState.currentTurn,
      moveHistory: this.gameState.moveHistory,
      gameStatus: this.gameState.status,
    };
  }
}

interface PlayerState {
  id: string;
  color: 'white' | 'black';
  rating: number;
  connected: boolean;
  timeRemaining: number;
}

interface GameState {
  fen: string;
  players: Map<string, PlayerState>;
  currentTurn: 'white' | 'black';
  moveHistory: string[];
  status: 'waiting' | 'in_progress' | 'completed' | 'abandoned';
}
```

### Task 6: Add Game Room Initialization and Player Join

**File**: `src/server/game-room.ts`

```typescript
private async handleJoinGame(request: Request): Promise<Response> {
  const body = await request.json() as JoinGameRequest;
  const { playerId, rating, color } = body;

  // Check if game is full
  if (this.gameState.players.size >= 2) {
    return new Response(JSON.stringify({ error: 'Game is full' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Assign color if not specified
  let assignedColor: 'white' | 'black';
  if (color) {
    assignedColor = color;
  } else if (this.gameState.players.size === 0) {
    assignedColor = 'white';
  } else {
    // Second player gets opposite color
    const existingPlayer = Array.from(this.gameState.players.values())[0];
    assignedColor = existingPlayer.color === 'white' ? 'black' : 'white';
  }

  // Add player to game
  this.gameState.players.set(playerId, {
    id: playerId,
    color: assignedColor,
    rating,
    connected: false, // Will be set to true when WebSocket connects
    timeRemaining: this.getInitialTime(),
  });

  // Check if game can start
  if (this.gameState.players.size === 2) {
    this.gameState.status = 'waiting'; // Waiting for both WebSocket connections
  }

  // Generate WebSocket URL
  const wsUrl = `${this.getWebSocketBaseUrl()}/websocket?playerId=${playerId}`;

  return new Response(JSON.stringify({
    success: true,
    playerId,
    color: assignedColor,
    webSocketUrl: wsUrl,
    gameStatus: this.gameState.status,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

private handlePlayerReady(playerId: string): void {
  const player = this.gameState.players.get(playerId);
  if (!player) return;

  // Check if both players are connected and ready
  const allConnected = Array.from(this.gameState.players.values())
    .every(p => p.connected);

  if (allConnected && this.gameState.players.size === 2 && this.gameState.status === 'waiting') {
    this.gameState.status = 'in_progress';

    // Notify both players game is starting
    this.broadcastToAll({
      type: 'game_start',
      state: this.serializeGameState(),
      timestamp: Date.now(),
    });

    console.log('GameRoom: Game started, both players connected');
  }
}

private broadcastToAll(message: object): void {
  const messageStr = JSON.stringify(message);

  for (const [playerId, ws] of this.connections) {
    if (ws.readyState === WebSocket.READY_STATE_OPEN) {
      ws.send(messageStr);
    }
  }
}

private getInitialTime(): number {
  // Default: 10 minutes in milliseconds
  return 10 * 60 * 1000;
}

private getWebSocketBaseUrl(): string {
  // This should be configured based on environment
  return 'wss://your-worker.your-account.workers.dev';
}

interface JoinGameRequest {
  playerId: string;
  rating: number;
  color?: 'white' | 'black';
}
```

### Task 7: Add Queue Status Polling Endpoint

**File**: `src/server/index.ts`

```typescript
// Add to MatchmakingQueue class
async fetch(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'POST' && url.pathname === '/join') {
    return this.handleJoinQueue(request);
  }

  if (request.method === 'GET' && url.pathname === '/status') {
    return this.handleStatusCheck(request);
  }

  if (request.method === 'POST' && url.pathname === '/leave') {
    return this.handleLeaveQueue(request);
  }

  return new Response('Not found', { status: 404 });
}

private async handleJoinQueue(request: Request): Promise<Response> {
  const body = await request.json() as JoinQueueRequest;
  const { playerId, rating, gameMode } = body;

  const result = await this.addToQueue(playerId, rating, gameMode);

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

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
  await this.cleanupExpiredEntries();

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

  // Try to find match with updated ranges
  const match = this.findMatch(entry);

  if (match) {
    // Match found!
    this.queue = this.queue.filter(e =>
      e.playerId !== playerId && e.playerId !== match.playerId
    );
    await this.saveQueue();

    return new Response(JSON.stringify({
      inQueue: false,
      matched: true,
      opponentId: match.playerId,
      opponentRating: match.rating,
      gameRoomId: this.generateGameRoomId(playerId, match.playerId),
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

interface JoinQueueRequest {
  playerId: string;
  rating: number;
  gameMode: string;
}
```

---

## Testing Plan

### Unit Tests

1. **Rating Range Calculation**
   - 0 seconds wait: range = ±150
   - 10 seconds wait: range = ±150
   - 15 seconds wait: range = ±200
   - 20 seconds wait: range = ±250
   - 25 seconds wait: range = ±400
   - 30 seconds wait: range = ±600

2. **Queue Persistence**
   - Add entry, verify it's in storage
   - Restart Durable Object, verify queue loads from storage
   - Expired entries are cleaned up on load

3. **Bidirectional Matching**
   - Player A (1200) waits 5s, Player B (1400) waits 5s: NO MATCH (range ±150)
   - Player A (1200) waits 20s, Player B (1400) waits 20s: MATCH (range ±250)
   - Player A (1200) waits 5s, Player B (1300) waits 5s: MATCH (range ±150)

4. **Deduplication**
   - Same player joins twice: only one entry in queue

### Integration Tests

1. **Full Matchmaking Flow**
   ```
   1. Player A joins queue (rating: 1200)
   2. Player A polls status - inQueue: true
   3. Player B joins queue (rating: 1250)
   4. Player B receives match immediately
   5. Player A polls status - matched: true, same gameRoomId
   6. Both players join GameRoom
   7. Both establish WebSocket connections
   8. Both receive game_start message
   ```

2. **WebSocket Connection Stability**
   ```
   1. Player connects via WebSocket
   2. Server starts heartbeat (ping every 10s)
   3. Client responds with pong
   4. Connection stays alive for duration of game
   5. On disconnect, opponent is notified
   6. 10-second reconnect window before abandonment
   ```

3. **Queue Timeout**
   ```
   1. Player joins queue at T=0
   2. Status check at T=15s: inQueue: true, expiresIn: 15
   3. Status check at T=25s: inQueue: true, expiresIn: 5
   4. Status check at T=31s: inQueue: false (expired)
   ```

### Manual Testing

1. **Two-Device Test**
   - Open app on Device A, start matchmaking
   - Open app on Device B, start matchmaking
   - Both should connect within 10 seconds (if ratings close)
   - Verify game starts and both see opponent

2. **Network Interruption**
   - During game, toggle airplane mode on Device A
   - Device B should see "Opponent disconnected"
   - Toggle airplane mode off within 10 seconds
   - Device A should reconnect, game continues

3. **Long Wait Matching**
   - Device A (rating 1200) starts matchmaking
   - Wait 20 seconds
   - Device B (rating 1500) starts matchmaking
   - Should match due to expanded range (±400+)

---

## Deployment Checklist

1. **Pre-deployment**
   - [ ] All unit tests passing
   - [ ] Integration tests passing
   - [ ] Code review completed
   - [ ] No console.error statements left
   - [ ] Performance profiling done

2. **Deployment**
   - [ ] Deploy to staging environment first
   - [ ] Test with real devices in staging
   - [ ] Monitor Durable Object storage usage
   - [ ] Check WebSocket connection stability
   - [ ] Verify queue persistence across restarts

3. **Post-deployment**
   - [ ] Monitor error logs for 24 hours
   - [ ] Check matchmaking success rate
   - [ ] Verify no memory leaks
   - [ ] Monitor WebSocket connection durations
   - [ ] Track average queue wait times

---

## Rollback Plan

If issues are discovered after deployment:

1. **Immediate Rollback**
   - Revert to previous worker version via Cloudflare dashboard
   - Clear Durable Object storage if corrupted

2. **Data Migration**
   - Queue data should be safe to lose (transient)
   - Game state in progress will be lost (acceptable for critical bugs)

3. **Communication**
   - Notify users of temporary maintenance
   - Disable matchmaking in Flutter app temporarily

---

## Performance Considerations

1. **Durable Object Storage**
   - Queue entries: ~100 bytes each
   - Max queue size: ~1000 entries (100KB)
   - Storage reads: Once per minute (cleanup)
   - Storage writes: Once per join/leave/match

2. **WebSocket Connections**
   - Max concurrent games: Limited by DO instances
   - Heartbeat interval: 10 seconds (balance between overhead and responsiveness)
   - Message size: ~500 bytes average

3. **Matchmaking Latency**
   - Queue scan: O(n) where n = queue size
   - Expected: <10ms for 100 entries
   - Worst case: <100ms for 1000 entries

---

## Success Criteria

### Issue 8 - Matchmaking Fixes

- [ ] Both players successfully establish WebSocket connection
- [ ] No immediate disconnection after matching
- [ ] Player 2 receives confirmation of match
- [ ] Timeout increased to 30 seconds
- [ ] ELO ranges expand correctly: ±150 -> ±250 -> ±400 -> ±600
- [ ] Queue persists across Durable Object restarts
- [ ] No duplicate queue entries for same player
- [ ] Heartbeat keeps connections alive
- [ ] Game state properly synchronized between players
- [ ] Abandonment detected after 10-second disconnect

---

## Files Modified

1. **src/server/index.ts**
   - MatchmakingQueue class enhancements
   - Queue persistence to storage
   - Improved rating range calculation
   - Status polling endpoint
   - Leave queue endpoint

2. **src/server/game-room.ts**
   - WebSocket connection handling
   - Heartbeat/ping mechanism
   - Player synchronization
   - Game state management
   - Disconnect handling

3. **wrangler.toml** (if needed)
   - Durable Object bindings
   - Environment variables

---

**Last Updated**: 2025-01-17
**Status**: Ready for Implementation
**Total Estimated Time**: 3-5 days
