/**
 * Firestore Schema Type Definitions
 * Defines the structure of documents stored in Firestore
 * RESTORED SCHEMA: User subcollections with path-based security
 */

import type { Timestamp as FirebaseTimestamp } from 'firebase-admin/firestore';

// ============ MATCH HISTORY (Per-User Subcollection) ============

/**
 * Match history document (stored in users/{uid}/matchHistory/{matchId})
 * Represents one player's view of a match
 */
export interface MatchHistoryDocument {
  matchId: string;
  opponent: {
    userId: string;
    username: string;
    rating: number;
  };

  // Game details
  opening: string;
  openingId?: string;
  timeControl: 'blitz' | 'rapid' | 'classical';
  rated: boolean;

  // Result (from this player's perspective)
  result: 'win' | 'loss' | 'draw';
  reason:
    | 'checkmate'
    | 'resignation'
    | 'time'
    | 'draw_agreement'
    | 'stalemate'
    | 'insufficient_material'
    | 'threefold_repetition'
    | 'fifty_move_rule'
    | 'abandon'
    | 'unknown';

  // Ratings
  playerRatingBefore: number;
  playerRatingAfter: number;
  ratingChange: number; // Can be negative
  opponentRatingBefore: number;
  opponentRatingAfter: number;

  // Game data
  pgn?: string; // Full PGN string
  fen?: string; // Final position
  moves?: string[]; // Move list
  duration: number; // Match duration in seconds

  // Timestamps
  playedAt: FirebaseTimestamp;
  createdAt: FirebaseTimestamp;
}

// ============ LEADERBOARDS (Global, Server-Write-Only) ============

/**
 * Base leaderboard player fields
 */
interface BaseLeaderboardPlayer {
  userId: string;
  username: string;
  displayName?: string;
  photoUrl?: string;
  rank: number | null; // Computed by cron job
  updatedAt: FirebaseTimestamp;
}

/**
 * Unified leaderboard document (leaderboard/{uid})
 * Contains all leaderboard data: ELO, Tactical, Mastery, and Streak
 */
export interface UnifiedLeaderboardPlayer extends BaseLeaderboardPlayer {
  // ELO data
  eloRating: number;
  wins: number;
  losses: number;
  draws: number;
  totalGamesPlayed: number;
  provisionalGames: number;

  // Tactical data
  tacticalRating: number;
  puzzlesSolved: number;

  // Mastery data
  overallMasteryPercentage: number;
  masteredVariations: number;
  totalVariations: number;
  openingsMasteredCount: number;
  totalOpeningsCount: number;
  totalPoints: number;
  masteryPoints: number;
  learnPoints: number;

  // Streak data
  currentStreak: number;
  highestStreak: number;
  totalSessions: number;
}

/**
 * @deprecated Use UnifiedLeaderboardPlayer instead - legacy interface kept for compatibility
 */
export interface EloLeaderboardPlayer extends BaseLeaderboardPlayer {
  eloRating: number;
  wins: number;
  losses: number;
  draws: number;
  totalGames: number;
}

/**
 * @deprecated Use UnifiedLeaderboardPlayer instead - legacy interface kept for compatibility
 */
export interface TacticalLeaderboardPlayer extends BaseLeaderboardPlayer {
  tacticalRating: number;
  puzzlesSolved: number;
  accuracy: number;
}

/**
 * @deprecated Use UnifiedLeaderboardPlayer instead - legacy interface kept for compatibility
 */
export interface MasteryLeaderboardPlayer extends BaseLeaderboardPlayer {
  overallMasteryPercentage: number;
  masteredVariations: number;
  totalVariations: number;
  openingsMasteredCount: number;
  totalOpeningsCount: number;
}

/**
 * @deprecated Use UnifiedLeaderboardPlayer instead - legacy interface kept for compatibility
 */
export interface StreakLeaderboardPlayer extends BaseLeaderboardPlayer {
  currentStreak: number; // Current consecutive days
  highestStreak: number; // Best streak ever
  totalSessions: number; // Total training sessions
  lastSessionDate: FirebaseTimestamp; // Last activity
}

// ============ CUSTOM OPENINGS (User Subcollections) ============

/**
 * Custom opening document (users/{uid}/custom_openings/{openingId})
 */
export interface CustomOpeningDocument {
  openingId: string;
  name: string;
  description?: string;
  color: 'white' | 'black';
  createdAt: FirebaseTimestamp;
  updatedAt: FirebaseTimestamp;
  variationCount: number;
  // REMOVED: userId (redundant with path)
  // REMOVED: isActive (use hard delete instead)
}

/**
 * Custom variation document (users/{uid}/custom_openings/{openingId}/variations/{variationId})
 */
export interface CustomVariationDocument {
  variationId: string;
  name: string;
  moves: string[];
  fen?: string;
  moveCount: number;

  // Progress tracking
  masteryLevel: number; // 0-3
  practiceCount: number;
  accuracy?: number;

  createdAt: FirebaseTimestamp;
  updatedAt: FirebaseTimestamp;
  // REMOVED: userId (redundant with path)
  // REMOVED: openingId (redundant with path)
  // REMOVED: isActive (use hard delete instead)
}

// ============ USER PROFILE (Subcollections) ============

/**
 * User profile ratings document (users/{uid}/profile/ratings)
 */
export interface UserProfileRatings {
  // ELO Rating
  eloRating: number; // Renamed from "elo" for consistency
  eloGamesPlayed: number;
  eloProvisional: boolean; // < 30 games
  eloKFactor: number; // 32 or 16

  // Tactical Rating
  tacticalRating: number;
  tacticalGamesPlayed: number;
  tacticalProvisional: boolean;

  // Match Record
  wins: number;
  losses: number;
  draws: number;
  totalGames: number;

  // Win Rate
  winRate: number; // Percentage

  // Last Match
  lastMatchDate?: FirebaseTimestamp;

  // Metadata
  createdAt: FirebaseTimestamp;
  updatedAt: FirebaseTimestamp;
}

/**
 * User device document (users/{uid}/devices/{deviceId})
 */
export interface DeviceDocument {
  fcmToken: string; // Renamed from "token"
  installationId: string | null;
  platform: 'android' | 'ios' | 'web' | 'unknown';
  appVersion: string | null;
  lastSeenAt: FirebaseTimestamp;
  registeredAt: FirebaseTimestamp;
  updatedAt: FirebaseTimestamp;
  isActive: boolean;
}

/**
 * Notification preferences document (users/{uid}/preferences/notifications)
 */
export interface NotificationPreferences {
  enabled: boolean;
  categories: {
    streaks: boolean;
    achievements: boolean;
    engagement: boolean;
    social: boolean;
  };
  muteTemporarily: boolean;
  muteUntil: Date | null;
  quietHoursEnabled: boolean;
  quietHoursStart: number; // 0-23
  quietHoursEnd: number; // 0-23
  frequency: 'fewer' | 'normal' | 'more';
}

/**
 * Public profile data (users/{uid}/public/data)
 */
export interface PublicProfileData {
  // Identity
  username: string;
  displayName?: string;
  photoUrl?: string; // Renamed from photoURL for consistency
  createdAt: FirebaseTimestamp;

  // Mastery Stats
  masteredVariations: number;
  totalVariations: number;
  openingsMasteredCount: number;
  totalOpeningsCount: number;
  overallMasteryPercentage: number;
  strongestOpening?: string;
  weakestOpening?: string;

  // Activity Stats
  totalSessions: number;
  currentStreak: number;
  highestStreak: number;

  // Points
  totalPoints: number;
  learnPoints: number;
  masteryPoints: number;

  // Achievements
  unlockedAchievementIds: string[];
  unlockedAchievementCount: number;

  // Activity Heatmap (embedded map, not subcollection)
  activity_log: {
    [date: string]: number; // "2025-12-08": 5
  };

  // Profile Customization
  bio?: string;
  title?: string;
  badges?: string[];

  // Metadata
  updatedAt: FirebaseTimestamp;
}

/**
 * Achievement document (users/{uid}/achievements/{achievementId})
 */
export interface AchievementDocument {
  id: string;
  unlockedAt: FirebaseTimestamp;
  progress: number; // 0-100 scale
  currentValue?: number;
  targetValue?: number; // Renamed from "target"

  // Optional metadata (Worker can write, Flutter ignores)
  category?: string;
  title?: string;
  description?: string;
  iconUrl?: string;
  lastUpdated?: FirebaseTimestamp;
}

// ============ USER ROOT DOCUMENT ============

/**
 * Energy system structure
 */
export interface EnergySystem {
  current: number; // 0-100
  max: number; // 100
  dailyEarned: number; // 0-120
  lastRefillTime: FirebaseTimestamp; // Renamed from dailyWindowStart
  // REMOVED: dailyWindowStart (replaced by lastRefillTime)
  // REMOVED: lastDailyStreakClaimedAt (track in separate claim endpoint)
}

/**
 * Main user document (users/{uid})
 */
export interface UserDocument {
  // Basic info
  uid: string;
  username: string;
  usernameLower: string; // For case-insensitive uniqueness checks
  displayName?: string;
  email: string;
  emailVerified: boolean;
  photoUrl?: string; // Renamed from photoURL

  // Energy system
  energy: EnergySystem;

  // Points (standardized field names)
  dailyPoints: number; // Renamed from L_points_daily
  weeklyPoints: number; // Renamed from L_points_weekly
  monthlyPoints: number; // Renamed from L_points_monthly
  allTimePoints: number; // Renamed from L_points_all

  // Ranks
  masteryRank?: number; // Standardized from masteryRank/userRank
  activityRank?: number; // Standardized from activityRank/activityUserRank
  activityPoints: number; // Standardized from activityScore/activityPoints

  // Account status
  isPro: boolean;
  deleted: boolean; // Soft delete flag
  isActive: boolean; // Account status

  // Latest FCM token (for backwards compatibility)
  latestFcmToken?: string;

  // Timestamps
  createdAt: FirebaseTimestamp;
  updatedAt: FirebaseTimestamp;
}

// ============ NOTIFICATION LEDGER (Global, Audit Trail) ============

/**
 * Notification ledger document (notification_ledger/{notificationId})
 */
export interface NotificationLedger {
  userId: string;
  triggerId: string;
  category: string;
  templateId?: string;
  experimentVariant?: string; // A/B testing

  status: 'scheduled' | 'sent' | 'failed' | 'blocked';
  scheduledAt: FirebaseTimestamp;
  sentAt?: FirebaseTimestamp;

  failureReason?: string;
  blockReason?: string; // Policy enforcement

  deepLink: string;
  title: string;
  body: string;
  metadata: Record<string, any>;

  fcmMessageId?: string;
  createdAt: FirebaseTimestamp;
  updatedAt?: FirebaseTimestamp;
}

// ============ HELPER TYPES ============

/**
 * Firestore Timestamp type for convenience
 */
export type Timestamp = FirebaseTimestamp;

/**
 * Common field for server timestamps
 */
export interface TimestampFields {
  _seconds: number;
  _nanoseconds: number;
}

/**
 * Leaderboard type union
 */
export type LeaderboardType = 'elo' | 'tactical' | 'mastery' | 'streak';

/**
 * Time control type
 */
export type TimeControl = 'blitz' | 'rapid' | 'classical';

/**
 * Match result type
 */
export type MatchResult = 'win' | 'loss' | 'draw';

/**
 * Game end reason
 */
export type GameEndReason =
  | 'checkmate'
  | 'resignation'
  | 'time'
  | 'draw_agreement'
  | 'stalemate'
  | 'insufficient_material'
  | 'threefold_repetition'
  | 'fifty_move_rule'
  | 'abandon'
  | 'unknown';
