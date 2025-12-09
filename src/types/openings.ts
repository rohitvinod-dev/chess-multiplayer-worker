/**
 * Custom Openings Types
 * For user-created chess opening repertoires
 */

// ============ CUSTOM OPENINGS TYPES ============

export interface CustomOpening {
  id: string;
  userId: string;
  name: string;
  description?: string;
  color: 'white' | 'black';
  createdAt: FirestoreTimestamp;
  updatedAt?: FirestoreTimestamp;
  variationCount: number;
  isActive: boolean;
}

export interface CustomVariation {
  id: string;
  openingId: string;
  userId: string;
  name: string;
  moves: string[]; // PGN format moves
  fen?: string; // Position after moves
  createdAt: FirestoreTimestamp;
  updatedAt?: FirestoreTimestamp;
  moveCount: number;
  isActive: boolean;
}

export interface FirestoreTimestamp {
  _seconds: number;
  _nanoseconds: number;
}

// ============ PRO USER LIMITS ============

export const FREE_USER_LIMITS = {
  MAX_CUSTOM_OPENINGS: 1,
  MAX_VARIATIONS_PER_OPENING: 3,
  MAX_MOVES_PER_VARIATION: 10,
} as const;

export const PRO_USER_LIMITS = {
  MAX_CUSTOM_OPENINGS: 50,
  MAX_VARIATIONS_PER_OPENING: 100,
  MAX_MOVES_PER_VARIATION: 50,
} as const;

// ============ CRUD OPERATION TYPES ============

export type OpeningsAction =
  | 'createOpening'
  | 'renameOpening'
  | 'deleteOpening'
  | 'createVariation'
  | 'updateVariation'
  | 'deleteVariation';

// ============ REQUEST TYPES ============

export interface CreateOpeningRequest {
  action: 'createOpening';
  name: string;
  description?: string;
  color: 'white' | 'black';
}

export interface RenameOpeningRequest {
  action: 'renameOpening';
  openingId: string;
  newName: string;
}

export interface DeleteOpeningRequest {
  action: 'deleteOpening';
  openingId: string;
}

export interface CreateVariationRequest {
  action: 'createVariation';
  openingId: string;
  name: string;
  moves: string[];
  fen?: string;
}

export interface UpdateVariationRequest {
  action: 'updateVariation';
  variationId: string;
  name?: string;
  moves?: string[];
  fen?: string;
}

export interface DeleteVariationRequest {
  action: 'deleteVariation';
  variationId: string;
}

export type OpeningsManageRequest =
  | CreateOpeningRequest
  | RenameOpeningRequest
  | DeleteOpeningRequest
  | CreateVariationRequest
  | UpdateVariationRequest
  | DeleteVariationRequest;

// ============ RESPONSE TYPES ============

export interface OpeningsManageResponse {
  success: boolean;
  message: string;
  data?: {
    openingId?: string;
    variationId?: string;
    opening?: CustomOpening;
    variation?: CustomVariation;
  };
}

// ============ VALIDATION HELPERS ============

export interface UserLimits {
  maxOpenings: number;
  maxVariationsPerOpening: number;
  maxMovesPerVariation: number;
}

export function getUserLimits(isPro: boolean): UserLimits {
  return isPro
    ? {
        maxOpenings: PRO_USER_LIMITS.MAX_CUSTOM_OPENINGS,
        maxVariationsPerOpening: PRO_USER_LIMITS.MAX_VARIATIONS_PER_OPENING,
        maxMovesPerVariation: PRO_USER_LIMITS.MAX_MOVES_PER_VARIATION,
      }
    : {
        maxOpenings: FREE_USER_LIMITS.MAX_CUSTOM_OPENINGS,
        maxVariationsPerOpening: FREE_USER_LIMITS.MAX_VARIATIONS_PER_OPENING,
        maxMovesPerVariation: FREE_USER_LIMITS.MAX_MOVES_PER_VARIATION,
      };
}

// ============ VALIDATION FUNCTIONS ============

export function validateOpeningName(name: string): { valid: boolean; error?: string } {
  if (!name || name.trim().length === 0) {
    return { valid: false, error: 'Opening name cannot be empty' };
  }
  if (name.length > 100) {
    return { valid: false, error: 'Opening name cannot exceed 100 characters' };
  }
  // Only allow alphanumeric, spaces, hyphens, apostrophes
  if (!/^[a-zA-Z0-9\s\-']+$/.test(name)) {
    return { valid: false, error: 'Opening name contains invalid characters' };
  }
  return { valid: true };
}

export function validateVariationName(name: string): { valid: boolean; error?: string } {
  if (!name || name.trim().length === 0) {
    return { valid: false, error: 'Variation name cannot be empty' };
  }
  if (name.length > 100) {
    return { valid: false, error: 'Variation name cannot exceed 100 characters' };
  }
  // Only allow alphanumeric, spaces, hyphens, apostrophes
  if (!/^[a-zA-Z0-9\s\-']+$/.test(name)) {
    return { valid: false, error: 'Variation name contains invalid characters' };
  }
  return { valid: true };
}

export function validateMoves(
  moves: string[],
  maxMoves: number
): { valid: boolean; error?: string } {
  if (!moves || moves.length === 0) {
    return { valid: false, error: 'Moves array cannot be empty' };
  }
  if (moves.length > maxMoves) {
    return {
      valid: false,
      error: `Variation cannot exceed ${maxMoves} moves (you have ${moves.length})`,
    };
  }
  // Basic PGN move validation (simplified)
  for (const move of moves) {
    if (!/^[NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](=[NBRQ])?[+#]?$/.test(move) &&
        move !== 'O-O' && move !== 'O-O-O') {
      return { valid: false, error: `Invalid move format: ${move}` };
    }
  }
  return { valid: true };
}

// ============ ACHIEVEMENTS TYPES ============

export interface Achievement {
  id: string;
  category: string;
  title: string;
  description: string;
  iconUrl?: string;
  unlockedAt?: FirestoreTimestamp;
  progress?: number; // 0-100
  target?: number;
}

export interface AchievementsSyncRequest {
  achievements: Achievement[];
}

export interface AchievementsSyncResponse {
  success: boolean;
  message: string;
  synced: number;
}

// ============ LEADERBOARD TYPES ============

export interface LeaderboardEntry {
  userId: string;
  username: string;
  displayName?: string;
  photoUrl?: string;
  score: number; // Rating or tactical score
  rank: number;
  lastUpdated: FirestoreTimestamp;
}

export type LeaderboardType = 'elo' | 'tactical';

export interface LeaderboardUpdateRequest {
  userId: string;
  username: string;
  displayName?: string;
  photoUrl?: string;
  eloRating?: number;
  tacticalRating?: number;
}
