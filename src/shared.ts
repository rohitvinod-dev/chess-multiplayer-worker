// ============ CHAT TYPES ============
export type ChatMessage = {
  id: string;
  content: string;
  user: string;
  role: "user" | "assistant";
};

export type Message =
  | {
      type: "add";
      id: string;
      content: string;
      user: string;
      role: "user" | "assistant";
    }
  | {
      type: "update";
      id: string;
      content: string;
      user: string;
      role: "user" | "assistant";
    }
  | {
      type: "all";
      messages: ChatMessage[];
    };

// ============ GAME TYPES ============
export type GameMode = "blitz" | "rapid" | "classical";

export type PlayerColor = "white" | "black";

export type GameStatus = "waiting" | "ready" | "playing" | "finished";

export type GameResult = "white_win" | "black_win" | "draw" | "abandoned";

export type Move = {
  from: string; // e.g., "e2"
  to: string; // e.g., "e4"
  promotion?: string; // e.g., "q"
};

export type GameState = {
  fen: string;
  moves: Array<{
    move: Move;
    timestamp: number;
  }>;
  result?: GameResult;
  resultReason?: string;
};

export type PlayerInfo = {
  id: string;
  displayName: string;
  rating: number;
  isProvisional: boolean;
};

export type Clock = {
  white: {
    remaining: number; // milliseconds
    increment: number; // milliseconds
  };
  black: {
    remaining: number;
    increment: number;
  };
  lastUpdate: number; // timestamp
  currentTurn: PlayerColor;
};

export type GameMessage =
  | {
      type: "ready";
      gameState: GameState;
      clock: Clock;
      playerInfo: PlayerInfo;
      opponentId: string;
      opponentDisplayName: string;
      opponentRating: number;
      opponentIsProvisional: boolean;
    }
  | {
      type: "state";
      gameState: GameState;
      stateVersion: number;
    }
  | {
      type: "move";
      move: Move;
      gameState: GameState;
      clock: Clock;
      stateVersion: number;
    }
  | {
      type: "ack";
      stateVersion: number;
      acknowledged: boolean;
      error?: string;
    }
  | {
      type: "resign";
      resignedBy: string;
    }
  | {
      type: "clock_update";
      clock: Clock;
    }
  | {
      type: "opponent_status";
      connected: boolean;
      lastSeen: number;
    }
  | {
      type: "chat";
      playerId: string;
      displayName: string;
      message: string;
      timestamp: number;
    }
  | {
      type: "system";
      message: string;
      code: string;
    }
  | {
      type: "error";
      code: string;
      message: string;
    }
  | {
      type: "pong";
    };

export const names = [
  "Alice",
  "Bob",
  "Charlie",
  "David",
  "Eve",
  "Frank",
  "Grace",
  "Heidi",
  "Ivan",
  "Judy",
  "Kevin",
  "Linda",
  "Mallory",
  "Nancy",
  "Oscar",
  "Peggy",
  "Quentin",
  "Randy",
  "Steve",
  "Trent",
  "Ursula",
  "Victor",
  "Walter",
  "Xavier",
  "Yvonne",
  "Zoe",
];
