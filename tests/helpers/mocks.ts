/**
 * Test Helpers and Mock Utilities
 *
 * Provides mock implementations for Durable Objects, WebSocket connections,
 * and other infrastructure needed for testing multiplayer functionality.
 */

import { vi } from 'vitest';

// ============================================================================
// Mock WebSocket Connection
// ============================================================================

export interface MockMessage {
  type: string;
  [key: string]: any;
}

export class MockConnection {
  id: string;
  messages: MockMessage[] = [];
  closed: boolean = false;
  closeCode?: number;
  closeReason?: string;
  url: string;

  constructor(id: string = 'conn-' + Math.random().toString(36).slice(2)) {
    this.id = id;
    this.url = `wss://test.example.com?userId=${id}`;
  }

  send(message: string) {
    if (this.closed) {
      throw new Error('Connection is closed');
    }
    try {
      this.messages.push(JSON.parse(message));
    } catch {
      this.messages.push({ type: 'raw', data: message });
    }
  }

  close(code?: number, reason?: string) {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
  }

  getLastMessage(): MockMessage | undefined {
    return this.messages[this.messages.length - 1];
  }

  getMessagesByType(type: string): MockMessage[] {
    return this.messages.filter(m => m.type === type);
  }

  clearMessages() {
    this.messages = [];
  }
}

// ============================================================================
// Mock Durable Object Storage
// ============================================================================

export class MockStorage {
  private data: Map<string, any> = new Map();
  private alarm: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key);
  }

  async put(key: string, value: any): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarm = scheduledTime;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }

  getAlarm(): number | null {
    return this.alarm;
  }

  // Test helpers
  getAllData(): Map<string, any> {
    return new Map(this.data);
  }

  clear(): void {
    this.data.clear();
    this.alarm = null;
  }
}

// ============================================================================
// Mock Durable Object State
// ============================================================================

export class MockDurableObjectState {
  storage: MockStorage;
  id: DurableObjectId;

  constructor(id: string = 'test-do-id') {
    this.storage = new MockStorage();
    this.id = { toString: () => id } as DurableObjectId;
  }
}

// ============================================================================
// Mock Durable Object Namespace
// ============================================================================

export class MockDurableObjectNamespace {
  private instances: Map<string, any> = new Map();
  private factory: (id: string) => any;

  constructor(factory: (id: string) => any) {
    this.factory = factory;
  }

  idFromName(name: string): DurableObjectId {
    return { toString: () => `id-${name}` } as DurableObjectId;
  }

  get(id: DurableObjectId): DurableObjectStub {
    const idStr = id.toString();
    if (!this.instances.has(idStr)) {
      this.instances.set(idStr, this.factory(idStr));
    }
    const instance = this.instances.get(idStr)!;

    return {
      fetch: (request: Request) => instance.fetch(request),
    } as DurableObjectStub;
  }

  // Test helper
  getInstance(id: string): any {
    return this.instances.get(`id-${id}`);
  }
}

// ============================================================================
// Mock Request/Response Helpers
// ============================================================================

export function createMockRequest(
  path: string,
  body?: any,
  options: {
    method?: string;
    headers?: Record<string, string>;
    queryParams?: Record<string, string>;
  } = {}
): Request {
  const method = options.method || (body ? 'POST' : 'GET');
  let url = `https://test.example.com${path}`;

  if (options.queryParams) {
    const params = new URLSearchParams(options.queryParams);
    url += `?${params.toString()}`;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  return new Request(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function parseResponse<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

// ============================================================================
// Mock Environment
// ============================================================================

export interface MockEnv {
  GAME_ROOM: MockDurableObjectNamespace;
  LOBBY_LIST: MockDurableObjectNamespace;
  LOBBY_ROOM: MockDurableObjectNamespace;
  FIREBASE_PROJECT_ID: string;
  ENVIRONMENT: string;
}

export function createMockEnv(): MockEnv {
  return {
    GAME_ROOM: new MockDurableObjectNamespace((id) => createMockGameRoom(id)),
    LOBBY_LIST: new MockDurableObjectNamespace((id) => createMockLobbyList(id)),
    LOBBY_ROOM: new MockDurableObjectNamespace((id) => createMockLobbyRoom(id)),
    FIREBASE_PROJECT_ID: 'test-project',
    ENVIRONMENT: 'test',
  };
}

// ============================================================================
// Mock LobbyList Durable Object
// ============================================================================

export function createMockLobbyList(id: string = 'global') {
  const lobbies = new Map<string, any>();

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === '/list' && request.method === 'GET') {
        return new Response(JSON.stringify({
          lobbies: Array.from(lobbies.values()),
          total: lobbies.size,
        }), { headers: { 'Content-Type': 'application/json' } });
      }

      if (path === '/add' && request.method === 'POST') {
        const lobby = await request.json();
        lobbies.set(lobby.id, lobby);
        return new Response(JSON.stringify({ success: true }));
      }

      if (path.startsWith('/remove/') && request.method === 'DELETE') {
        const lobbyId = path.split('/')[2];
        lobbies.delete(lobbyId);
        return new Response(JSON.stringify({ success: true }));
      }

      return new Response('Not Found', { status: 404 });
    },

    // Test helpers
    getLobbies: () => lobbies,
    addLobby: (lobby: any) => lobbies.set(lobby.id, lobby),
    clear: () => lobbies.clear(),
  };
}

// ============================================================================
// Mock GameRoom Durable Object
// ============================================================================

export function createMockGameRoom(id: string = 'test-game') {
  let initialized = false;
  let gameState: any = null;
  const players = new Map<string, any>();

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === '/init' && request.method === 'POST') {
        const data = await request.json();
        initialized = true;
        gameState = {
          gameMode: data.gameMode,
          isLobbyMode: data.isLobbyMode,
          isUnrated: data.isUnrated,
        };

        // Register players
        if (data.players?.white) {
          players.set(data.players.white.id, { ...data.players.white, color: 'white' });
        }
        if (data.players?.black) {
          players.set(data.players.black.id, { ...data.players.black, color: 'black' });
        }

        return new Response(JSON.stringify({ success: true }));
      }

      if (path === '/state' && request.method === 'GET') {
        return new Response(JSON.stringify({
          initialized,
          gameState,
          players: Array.from(players.values()),
        }));
      }

      return new Response('Not Found', { status: 404 });
    },

    // Test helpers
    isInitialized: () => initialized,
    getGameState: () => gameState,
    getPlayers: () => players,
  };
}

// ============================================================================
// Mock LobbyRoom (Simplified for Testing)
// ============================================================================

export function createMockLobbyRoom(id: string = 'test-lobby') {
  const state = new MockDurableObjectState(id);

  return {
    state,
    lobbyId: id,
    status: 'waiting' as 'waiting' | 'matched' | 'cancelled',
    creator: null as any,
    opponent: null as any,
    createdAt: Date.now(),

    async fetch(request: Request): Promise<Response> {
      // Simplified mock - real tests will use the actual LobbyRoom class
      return new Response('OK');
    },
  };
}

// ============================================================================
// Time Control Helpers
// ============================================================================

export function advanceTime(ms: number): void {
  vi.advanceTimersByTime(ms);
}

export function setCurrentTime(date: Date): void {
  vi.setSystemTime(date);
}

// ============================================================================
// WebSocket Test Helpers
// ============================================================================

export class WebSocketTestHarness {
  connections: MockConnection[] = [];

  createConnection(userId: string): MockConnection {
    const conn = new MockConnection(userId);
    this.connections.push(conn);
    return conn;
  }

  simulateMessage(connection: MockConnection, message: any): void {
    // This would be used with the actual DO to simulate incoming messages
    connection.messages.push(message);
  }

  closeAllConnections(): void {
    this.connections.forEach(conn => {
      if (!conn.closed) {
        conn.close(1000, 'Test cleanup');
      }
    });
  }

  getConnectionById(userId: string): MockConnection | undefined {
    return this.connections.find(c => c.id === userId);
  }
}

// ============================================================================
// Assertion Helpers
// ============================================================================

export function expectMessageOfType(
  connection: MockConnection,
  type: string,
  timeout: number = 1000
): MockMessage {
  const message = connection.getMessagesByType(type)[0];
  if (!message) {
    throw new Error(`Expected message of type '${type}' but none found. Messages: ${JSON.stringify(connection.messages)}`);
  }
  return message;
}

export function expectNoMessageOfType(connection: MockConnection, type: string): void {
  const messages = connection.getMessagesByType(type);
  if (messages.length > 0) {
    throw new Error(`Expected no message of type '${type}' but found: ${JSON.stringify(messages)}`);
  }
}
