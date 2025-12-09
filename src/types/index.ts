/**
 * Shared TypeScript types for CheckmateX Worker
 * Ported from Firebase Functions
 */

// ============ PROGRESS TRACKING TYPES ============

export type ProgressType = 'learn' | 'mastery';

export interface ProgressMap {
  [variationKey: string]: number; // 0-3, mastery level
}

export interface ProgressAnalysis {
  map: ProgressMap;
  variationGroups: Map<string, VariationGroup>;
  openingGroups: Map<string, OpeningGroup>;
  totalKeys: number;
  completedKeys: number;
  totalLevel: number;
  variationCompletedCount: number;
  masteredOpeningCount: number;
  totalOpenings: number;
  strongestOpening: string | null;
  weakestOpening: string | null;
  overallMastery: number; // 0-1
  isVariationComplete: (variationId: string) => boolean;
  isOpeningComplete: (openingId: string) => boolean;
}

export interface VariationGroup {
  keys: string[];
  minLevel: number;
  totalLevel: number;
}

export interface OpeningGroup {
  keys: string[];
  minLevel: number;
  totalLevel: number;
}

export interface ProgressStats {
  masteredVariations: number;
  totalVariations: number;
  openingsMasteredCount: number;
  totalOpeningsCount: number;
  overallMasteryPercentage: number; // 0-100
  strongestOpening: string;
  weakestOpening: string;
}

export interface ProgressEventPayload {
  variationKey: string;
  progressType: ProgressType;
  previousLevel: number;
  newLevel: number;
  delta: number;
  pointsAwarded: number;
  variationBonusAwarded: boolean;
  openingBonusAwarded: boolean;
  stats: ProgressStats;
  energyGranted?: number;
}

export type TrainingMode = 'focused' | 'explore';

export interface RecordProgressEventRequest {
  variationKey: string;
  progressType: ProgressType;
  newLevel?: number;
  delta?: number;
  eventId?: string;
  mode?: TrainingMode; // NEW: Training mode (focused vs explore)
}

export interface RecordProgressEventResponse {
  alreadyProcessed: boolean;
  variationKey?: string;
  progressType?: ProgressType;
  previousLevel?: number;
  newLevel?: number;
  delta?: number;
  pointsAwarded?: number;
  variationBonusAwarded?: boolean;
  openingBonusAwarded?: boolean;
  stats?: ProgressStats;
  energyGranted?: number;
  event?: Partial<ProgressEventPayload>;
}

// ============ ENERGY SYSTEM TYPES ============

export interface EnergyState {
  current: number;
  max: number;
  dailyEarned: number;
  dailyWindowStart: Date;
  lastDailyStreakClaimedAt: Date | null;
}

export interface EnergyRecord {
  current: number;
  max: number;
  dailyEarned: number;
  dailyWindowStart: FirestoreTimestamp | null;
  lastDailyStreakClaimedAt: FirestoreTimestamp | null;
}

export interface EnergyRewardResult {
  applied: number;
  state: EnergyState;
}

export interface ClaimEnergyRewardRequest {
  source: 'dailyStreak';
}

export interface ClaimEnergyRewardResponse {
  applied: number;
  current: number;
  max: number;
  dailyEarned: number;
}

// ============ USER PROFILE TYPES ============

export interface ModeProgressData {
  progressMap?: ProgressMap;          // Mastery progress per variation
  learnProgressMap?: ProgressMap;     // Learn progress per variation
  firstAttemptMap?: { [key: string]: boolean };
}

export interface UserProfile {
  uid: string;
  email?: string;
  emailVerified?: boolean;
  username?: string;
  usernameLower?: string;
  displayName?: string;
  photoURL?: string;

  // Mode-specific progress (NEW schema)
  focused?: ModeProgressData;
  explore?: ModeProgressData;

  // Legacy progress tracking (OLD schema - for backward compatibility)
  progressMap?: ProgressMap;
  learnProgressMap?: ProgressMap;
  firstAttemptMap?: { [key: string]: boolean };

  // Stats
  masteredVariations?: number;
  totalVariations?: number;
  openingsMasteredCount?: number;
  totalOpeningsCount?: number;
  overallMasteryPercentage?: number;
  strongestOpening?: string;
  weakestOpening?: string;

  // Points
  totalPoints?: number;
  masteryPoints?: number;
  learnPoints?: number;

  // Streak tracking
  currentStreak?: number;
  highestStreak?: number;
  lastSessionDate?: FirestoreTimestamp;
  totalSessions?: number;

  // Energy
  energy?: EnergyRecord;

  // Timestamps
  createdAt?: FirestoreTimestamp;
  updatedAt?: FirestoreTimestamp;
}

export interface EnsureUserProfileRequest {
  username?: string;
  email?: string;
  emailVerified?: boolean;
  displayName?: string;
  photoURL?: string;
}

export interface EnsureUserProfileResponse {
  success: boolean;
  username?: string;
}

// ============ DEVICE REGISTRATION TYPES ============

export interface RegisterDeviceRequest {
  token: string;
  platform: 'android' | 'ios' | 'web';
}

export interface RegisterDeviceResponse {
  success: boolean;
}

// ============ STREAK TYPES ============

export interface StreakInfo {
  shouldGrantDailyBonus: boolean;
  currentStreak: number;
}

// ============ CONFIGURATION TYPES ============

export interface PointsConfig {
  base: number;
  completionBonus: number;
  variationBonus: number;
  openingBonus: number;
}

export const POINTS_CONFIG: Record<ProgressType, PointsConfig> = {
  learn: {
    base: 50,
    completionBonus: 100,
    variationBonus: 200,
    openingBonus: 500,
  },
  mastery: {
    base: 20,
    completionBonus: 50,
    variationBonus: 100,
    openingBonus: 300,
  },
};

export interface EnergyConfig {
  maxEnergy: number;
  dailyEarnCap: number;
  dailyStreakReward: number;
}

export const ENERGY_CONFIG: EnergyConfig = {
  maxEnergy: 100,
  dailyEarnCap: 120,
  dailyStreakReward: 20,
};

// ============ FIRESTORE TYPES ============

export interface FirestoreTimestamp {
  _seconds: number;
  _nanoseconds: number;
}

export interface FirestoreDocument {
  [key: string]: any;
}

// ============ AUTHENTICATION TYPES ============

export interface AuthenticatedUser {
  uid: string;
  email?: string;
  email_verified?: boolean;
}

// ============ API ERROR TYPES ============

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// Error codes matching Firebase Functions
export const ErrorCodes = {
  UNAUTHENTICATED: 'unauthenticated',
  INVALID_ARGUMENT: 'invalid-argument',
  FAILED_PRECONDITION: 'failed-precondition',
  ALREADY_EXISTS: 'already-exists',
  NOT_FOUND: 'not-found',
  INTERNAL: 'internal',
} as const;

// ============ HELPER TYPE GUARDS ============

export function isProgressType(value: string): value is ProgressType {
  return value === 'learn' || value === 'mastery';
}

export function isValidLevel(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 3;
}

export function isValidDelta(value: number): boolean {
  return Number.isInteger(value) && Math.abs(value) <= 1;
}
