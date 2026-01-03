// ============ CHAT TYPES ============
export type ChatRole = "user" | "admin" | "moderator" | "system";

export type ChatMessage = {
  id: string;
  content: string;
  user: string; // display name (legacy, kept for compatibility)
  userId: string;
  displayName: string;
  role: ChatRole;
  timestamp: number; // Unix timestamp in milliseconds
  metadata?: {
    isPinned?: boolean;
    pinnedAt?: number;
    pinnedBy?: string;
    isAnnouncement?: boolean;
    announcementExpiresAt?: number;
    [key: string]: unknown;
  };
};

// Ban/mute info for users
export type BanInfo = {
  oderId: string;
  oderedBy: string;
  displayName: string;
  reason?: string;
  bannedAt: number;
  expiresAt?: number; // undefined = permanent, timestamp = temporary
  type: "ban" | "mute"; // ban = can't see/send, mute = can see but can't send
};

// Admin action result broadcast to clients
export type AdminActionResult = {
  success: boolean;
  action: string;
  targetUserId?: string;
  messageId?: string;
  error?: string;
  performedBy: string;
  timestamp: number;
};

export type Message =
  | {
      type: "add";
      id: string;
      content: string;
      user: string;
      userId: string;
      displayName: string;
      role: ChatRole;
      timestamp: number;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "update";
      id: string;
      content: string;
      user: string;
      userId: string;
      displayName: string;
      role: ChatRole;
      timestamp: number;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "delete";
      id: string;
      deletedBy?: string; // Admin who deleted (if admin action)
    }
  | {
      type: "init"; // Initial messages on connect
      messages: ChatMessage[];
      pinnedMessages?: ChatMessage[];
      userBanStatus?: { isBanned: boolean; isMuted: boolean; expiresAt?: number; reason?: string };
    }
  | {
      type: "all"; // Legacy alias for init
      messages: ChatMessage[];
    }
  // ===== ADMIN ACTIONS =====
  | {
      type: "admin_delete"; // Admin deletes any message
      messageId: string;
      adminUserId: string;
    }
  | {
      type: "admin_ban"; // Ban a user (can't see or send)
      targetUserId: string;
      reason?: string;
      duration?: number; // minutes, undefined = permanent
      adminUserId: string;
    }
  | {
      type: "admin_unban"; // Unban a user
      targetUserId: string;
      adminUserId: string;
    }
  | {
      type: "admin_mute"; // Mute a user (can see but can't send)
      targetUserId: string;
      reason?: string;
      duration?: number; // minutes, undefined = permanent
      adminUserId: string;
    }
  | {
      type: "admin_unmute"; // Unmute a user
      targetUserId: string;
      adminUserId: string;
    }
  | {
      type: "admin_pin"; // Pin a message
      messageId: string;
      adminUserId: string;
    }
  | {
      type: "admin_unpin"; // Unpin a message
      messageId: string;
      adminUserId: string;
    }
  | {
      type: "admin_announce"; // Create an announcement
      content: string;
      duration?: number; // hours, undefined = permanent
      adminUserId: string;
    }
  // ===== ADMIN ACTION RESULTS (broadcast to clients) =====
  | {
      type: "user_banned";
      targetUserId: string;
      targetDisplayName: string;
      reason?: string;
      expiresAt?: number;
      bannedBy: string;
    }
  | {
      type: "user_unbanned";
      targetUserId: string;
      unbannedBy: string;
    }
  | {
      type: "user_muted";
      targetUserId: string;
      targetDisplayName: string;
      reason?: string;
      expiresAt?: number;
      mutedBy: string;
    }
  | {
      type: "user_unmuted";
      targetUserId: string;
      unmutedBy: string;
    }
  | {
      type: "message_pinned";
      message: ChatMessage;
      pinnedBy: string;
    }
  | {
      type: "message_unpinned";
      messageId: string;
      unpinnedBy: string;
    }
  | {
      type: "announcement";
      message: ChatMessage;
    }
  | {
      type: "error";
      code: string;
      message: string;
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
