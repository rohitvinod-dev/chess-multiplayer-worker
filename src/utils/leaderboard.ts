/**
 * Leaderboard Sync Utilities
 *
 * Unified leaderboard structure at: leaderboard/{uid}
 *
 * Contains all leaderboard data in a single document:
 * - ELO rating and match stats
 * - Tactical rating and puzzle stats
 * - Mastery percentage and progress
 * - Streak data
 * - User info (username, countryCode, etc.)
 */

import type { FirestoreClient } from '../firestore';
import type { LeaderboardType } from '../types/openings';
import { formatTimestamp } from './mastery';

// Unified leaderboard collection path
const LEADERBOARD_PATH = 'leaderboard';

/**
 * Unified leaderboard entry structure
 */
export interface LeaderboardEntry {
  // User info
  username?: string;
  displayName?: string;
  photoUrl?: string;
  countryCode?: string;

  // ELO data
  eloRating?: number;
  wins?: number;
  losses?: number;
  draws?: number;
  totalGamesPlayed?: number;

  // Tactical data
  tacticalRating?: number;
  puzzlesSolved?: number;
  accuracy?: number;

  // Mastery data
  totalPoints?: number;
  masteryPoints?: number;
  learnPoints?: number;
  overallMasteryPercentage?: number;
  masteredVariations?: number;
  totalVariations?: number;
  openingsMasteredCount?: number;
  totalOpeningsCount?: number;

  // Streak data
  currentStreak?: number;
  highestStreak?: number;
  totalSessions?: number;
  lastSessionDate?: string;

  // Meta
  updatedAt?: string;
}

/**
 * Updates the unified leaderboard entry for a user
 *
 * Only updates fields that are provided - preserves existing data for other fields
 */
export async function syncUserToLeaderboard(
  firestore: FirestoreClient,
  userId: string,
  updates: Partial<LeaderboardEntry>
): Promise<void> {
  const entryPath = `${LEADERBOARD_PATH}/${userId}`;

  // Build the update payload - only include defined values
  const payload: any = {
    updatedAt: formatTimestamp(new Date()),
  };

  // User info
  if (updates.username !== undefined) payload.username = updates.username;
  if (updates.displayName !== undefined) payload.displayName = updates.displayName;
  if (updates.photoUrl !== undefined) payload.photoUrl = updates.photoUrl;
  if (updates.countryCode !== undefined) payload.countryCode = updates.countryCode;

  // ELO data
  if (updates.eloRating !== undefined) payload.eloRating = updates.eloRating;
  if (updates.wins !== undefined) payload.wins = updates.wins;
  if (updates.losses !== undefined) payload.losses = updates.losses;
  if (updates.draws !== undefined) payload.draws = updates.draws;
  if (updates.totalGamesPlayed !== undefined) payload.totalGamesPlayed = updates.totalGamesPlayed;

  // Tactical data
  if (updates.tacticalRating !== undefined) payload.tacticalRating = updates.tacticalRating;
  if (updates.puzzlesSolved !== undefined) payload.puzzlesSolved = updates.puzzlesSolved;
  if (updates.accuracy !== undefined) payload.accuracy = updates.accuracy;

  // Mastery data
  if (updates.totalPoints !== undefined) payload.totalPoints = updates.totalPoints;
  if (updates.masteryPoints !== undefined) payload.masteryPoints = updates.masteryPoints;
  if (updates.learnPoints !== undefined) payload.learnPoints = updates.learnPoints;
  if (updates.overallMasteryPercentage !== undefined) payload.overallMasteryPercentage = updates.overallMasteryPercentage;
  if (updates.masteredVariations !== undefined) payload.masteredVariations = updates.masteredVariations;
  if (updates.totalVariations !== undefined) payload.totalVariations = updates.totalVariations;
  if (updates.openingsMasteredCount !== undefined) payload.openingsMasteredCount = updates.openingsMasteredCount;
  if (updates.totalOpeningsCount !== undefined) payload.totalOpeningsCount = updates.totalOpeningsCount;

  // Streak data
  if (updates.currentStreak !== undefined) payload.currentStreak = updates.currentStreak;
  if (updates.highestStreak !== undefined) payload.highestStreak = updates.highestStreak;
  if (updates.totalSessions !== undefined) payload.totalSessions = updates.totalSessions;
  if (updates.lastSessionDate !== undefined) payload.lastSessionDate = updates.lastSessionDate;

  await firestore.setDocument(entryPath, payload, { merge: true });
}

/**
 * Legacy function - redirects to unified sync
 * @deprecated Use syncUserToLeaderboard instead
 */
export async function syncUserToLeaderboards(
  firestore: FirestoreClient,
  userId: string,
  updates: {
    username?: string;
    displayName?: string;
    photoUrl?: string;
    countryCode?: string;
    eloRating?: number;
    wins?: number;
    losses?: number;
    draws?: number;
    totalGames?: number;
    tacticalRating?: number;
    puzzlesSolved?: number;
    accuracy?: number;
    overallMasteryPercentage?: number;
    masteredVariations?: number;
    totalVariations?: number;
    openingsMasteredCount?: number;
    totalOpeningsCount?: number;
    currentStreak?: number;
    highestStreak?: number;
    totalSessions?: number;
    lastSessionDate?: number;
  }
): Promise<void> {
  // Map to unified structure
  const entry: Partial<LeaderboardEntry> = {
    username: updates.username,
    displayName: updates.displayName,
    photoUrl: updates.photoUrl,
    countryCode: updates.countryCode,
    eloRating: updates.eloRating,
    wins: updates.wins,
    losses: updates.losses,
    draws: updates.draws,
    totalGamesPlayed: updates.totalGames,
    tacticalRating: updates.tacticalRating,
    puzzlesSolved: updates.puzzlesSolved,
    accuracy: updates.accuracy,
    overallMasteryPercentage: updates.overallMasteryPercentage,
    masteredVariations: updates.masteredVariations,
    totalVariations: updates.totalVariations,
    openingsMasteredCount: updates.openingsMasteredCount,
    totalOpeningsCount: updates.totalOpeningsCount,
    currentStreak: updates.currentStreak,
    highestStreak: updates.highestStreak,
    totalSessions: updates.totalSessions,
    lastSessionDate: updates.lastSessionDate ? new Date(updates.lastSessionDate).toISOString() : undefined,
  };

  await syncUserToLeaderboard(firestore, userId, entry);
}

/**
 * Removes a user from the leaderboard (for account deletion)
 */
export async function removeUserFromLeaderboards(
  firestore: FirestoreClient,
  userId: string
): Promise<void> {
  await firestore.deleteDocument(`${LEADERBOARD_PATH}/${userId}`).catch(() => {
    // Ignore if doesn't exist
  });
}

/**
 * Gets top N users from the leaderboard sorted by a specific field
 */
export async function getTopLeaderboardEntries(
  firestore: FirestoreClient,
  leaderboardType: LeaderboardType,
  limit: number = 100
): Promise<any[]> {
  // Determine sort field based on leaderboard type
  let sortField = 'eloRating';
  switch (leaderboardType) {
    case 'elo':
      sortField = 'eloRating';
      break;
    case 'tactical':
      sortField = 'tacticalRating';
      break;
    case 'mastery':
      sortField = 'overallMasteryPercentage';
      break;
    case 'streak':
      sortField = 'currentStreak';
      break;
  }

  // Query with orderBy rating/score descending
  const entries = await firestore.queryDocuments(LEADERBOARD_PATH, [], {
    orderBy: { field: sortField, direction: 'DESCENDING' },
    limit,
  });

  // Add rank to each entry
  return entries.map((entry: any, index: number) => ({
    ...entry,
    rank: index + 1,
  }));
}

/**
 * Gets a user's rank on a specific leaderboard
 */
export async function getUserRank(
  firestore: FirestoreClient,
  leaderboardType: LeaderboardType,
  userId: string
): Promise<{ rank: number; total: number; entry: any } | null> {
  // Get user's entry
  const userEntry = await firestore.getDocument(`${LEADERBOARD_PATH}/${userId}`);
  if (!userEntry) {
    return null;
  }

  // Determine rating field based on leaderboard type
  let ratingField = 'eloRating';
  switch (leaderboardType) {
    case 'elo':
      ratingField = 'eloRating';
      break;
    case 'tactical':
      ratingField = 'tacticalRating';
      break;
    case 'mastery':
      ratingField = 'overallMasteryPercentage';
      break;
    case 'streak':
      ratingField = 'currentStreak';
      break;
  }

  const userScore = userEntry[ratingField] || 0;

  // Count entries with higher scores
  const higherScoreEntries = await firestore.queryDocuments(LEADERBOARD_PATH, [
    { field: ratingField, op: 'GREATER_THAN', value: userScore },
  ]);

  const rank = higherScoreEntries.length + 1;

  // Get total entries (could be cached)
  const allEntries = await firestore.queryDocuments(LEADERBOARD_PATH, []);
  const total = allEntries.length;

  return {
    rank,
    total,
    entry: {
      ...userEntry,
      rank,
    },
  };
}

/**
 * Gets a user's leaderboard entry
 */
export async function getUserLeaderboardEntry(
  firestore: FirestoreClient,
  userId: string
): Promise<LeaderboardEntry | null> {
  const entry = await firestore.getDocument(`${LEADERBOARD_PATH}/${userId}`);
  return entry as LeaderboardEntry | null;
}
