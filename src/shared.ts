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

// ============ ELO RATING TYPES ============
export type ELORatingChange = {
  playerId: string;
  oldRating: number;
  newRating: number;
  change: number; // +/- value
  wasProvisional: boolean;
  isProvisional: boolean; // after update
};

// ============ MATCH HISTORY TYPES ============
export type MoveRecord = {
  uci: string;
  san?: string;
  timestamp: number;
  madeBy: PlayerColor;
};

// Match type to distinguish ranked vs friendly matches
export type MatchType = "ranked" | "friendly";

export type MatchHistoryData = {
  matchId: string;
  whitePlayer: {
    id: string;
    displayName: string;
    rating: number;
    isProvisional: boolean;
  };
  blackPlayer: {
    id: string;
    displayName: string;
    rating: number;
    isProvisional: boolean;
  };
  gameMode: GameMode;
  matchType: MatchType; // "ranked" for ELO-affecting matches, "friendly" for lobby matches
  result: GameResult;
  resultReason: string;
  moves: MoveRecord[];
  finalFen: string; // Final position FEN
  pgn?: string; // Optional PGN notation
  startedAt: number;
  endedAt: number;
  openingName?: string; // Optional: name of opening used (for lobby matches)
  eloChanges: {
    white: ELORatingChange;
    black: ELORatingChange;
  };
};

export type GameMessage =
  | {
      type: "ready";
      state?: {
        status: string;
        version: number;
        fen: string;
        moves: Array<{ move: Move; timestamp: number }>;
      };
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
      record: {
        uci: string;
        madeBy: string;
        fenAfter: string;
      };
      move?: Move;
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
      outcome?: string;
    }
  | {
      type: "clock_update";
      clock: Clock;
    }
  | {
      type: "opponent_status";
      opponentConnected: boolean;
      reconnectTimeout?: number;
      timestamp: number;
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
    }
  | {
      type: "game_ended";
      result: GameResult;
      resultReason: string;
      eloChanges: {
        white: ELORatingChange;
        black: ELORatingChange;
      };
      matchHistory: MatchHistoryData;
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
