/**
 * Leaderboard Sync Utilities
 * Handles updating all 4 leaderboard types when user data changes
 *
 * Leaderboard Types:
 * 1. ELO - Multiplayer chess ratings
 * 2. Tactical - Puzzle solving ratings
 * 3. Mastery - Opening mastery percentage
 * 4. Streak - Consecutive practice days
 */

import type { FirestoreClient } from '../firestore';
import type { LeaderboardType } from '../types/openings';

// ============ LEADERBOARD SYNC FUNCTIONS ============

/**
 * Updates all applicable leaderboards for a user
 */
export async function syncUserToLeaderboards(
  firestore: FirestoreClient,
  userId: string,
  updates: {
    username?: string;
    displayName?: string;
    photoUrl?: string;
    // ELO data
    eloRating?: number;
    wins?: number;
    losses?: number;
    draws?: number;
    totalGames?: number;
    // Tactical data
    tacticalRating?: number;
    puzzlesSolved?: number;
    accuracy?: number;
    // Mastery data
    overallMasteryPercentage?: number;
    masteredVariations?: number;
    totalVariations?: number;
    openingsMasteredCount?: number;
    totalOpeningsCount?: number;
    // Streak data
    currentStreak?: number;
    highestStreak?: number;
    totalSessions?: number;
    lastSessionDate?: number;
  }
): Promise<void> {
  const promises: Promise<void>[] = [];

  // 1. Sync to ELO leaderboard if ELO rating provided
  if (updates.eloRating !== undefined) {
    promises.push(
      syncToEloLeaderboard(firestore, userId, {
        username: updates.username,
        displayName: updates.displayName,
        photoUrl: updates.photoUrl,
        eloRating: updates.eloRating,
        wins: updates.wins,
        losses: updates.losses,
        draws: updates.draws,
        totalGames: updates.totalGames,
      })
    );
  }

  // 2. Sync to Tactical leaderboard if tactical rating provided
  if (updates.tacticalRating !== undefined) {
    promises.push(
      syncToTacticalLeaderboard(firestore, userId, {
        username: updates.username,
        displayName: updates.displayName,
        photoUrl: updates.photoUrl,
        tacticalRating: updates.tacticalRating,
        puzzlesSolved: updates.puzzlesSolved,
        accuracy: updates.accuracy,
      })
    );
  }

  // 3. Sync to Mastery leaderboard if mastery data provided
  if (updates.overallMasteryPercentage !== undefined) {
    promises.push(
      syncToMasteryLeaderboard(firestore, userId, {
        username: updates.username,
        displayName: updates.displayName,
        photoUrl: updates.photoUrl,
        overallMasteryPercentage: updates.overallMasteryPercentage,
        masteredVariations: updates.masteredVariations,
        totalVariations: updates.totalVariations,
        openingsMasteredCount: updates.openingsMasteredCount,
        totalOpeningsCount: updates.totalOpeningsCount,
      })
    );
  }

  // 4. Sync to Streak leaderboard if streak data provided
  if (updates.currentStreak !== undefined) {
    promises.push(
      syncToStreakLeaderboard(firestore, userId, {
        username: updates.username,
        displayName: updates.displayName,
        photoUrl: updates.photoUrl,
        currentStreak: updates.currentStreak,
        highestStreak: updates.highestStreak,
        totalSessions: updates.totalSessions,
        lastSessionDate: updates.lastSessionDate,
      })
    );
  }

  await Promise.all(promises);
}

// ============ INDIVIDUAL LEADERBOARD SYNC FUNCTIONS ============

/**
 * Sync to ELO leaderboard
 */
async function syncToEloLeaderboard(
  firestore: FirestoreClient,
  userId: string,
  data: {
    username?: string;
    displayName?: string;
    photoUrl?: string;
    eloRating: number;
    wins?: number;
    losses?: number;
    draws?: number;
    totalGames?: number;
  }
): Promise<void> {
  const entryPath = `leaderboards/elo/players/${userId}`;
  const existingEntry = await firestore.getDocument(entryPath);

  const entryData: any = {
    userId,
    username: data.username || existingEntry?.username || 'Unknown',
    displayName: data.displayName || existingEntry?.displayName || data.username || 'Unknown',
    photoUrl: data.photoUrl || existingEntry?.photoUrl || null,
    eloRating: data.eloRating,
    rank: null, // Computed by cron job
    wins: data.wins !== undefined ? data.wins : (existingEntry?.wins || 0),
    losses: data.losses !== undefined ? data.losses : (existingEntry?.losses || 0),
    draws: data.draws !== undefined ? data.draws : (existingEntry?.draws || 0),
    totalGames: data.totalGames !== undefined ? data.totalGames : (existingEntry?.totalGames || 0),
    updatedAt: { _seconds: Math.floor(Date.now() / 1000), _nanoseconds: 0 },
  };

  await firestore.setDocument(entryPath, entryData, { merge: true });
}

/**
 * Sync to Tactical leaderboard
 */
async function syncToTacticalLeaderboard(
  firestore: FirestoreClient,
  userId: string,
  data: {
    username?: string;
    displayName?: string;
    photoUrl?: string;
    tacticalRating: number;
    puzzlesSolved?: number;
    accuracy?: number;
  }
): Promise<void> {
  const entryPath = `leaderboards/tactical/players/${userId}`;
  const existingEntry = await firestore.getDocument(entryPath);

  const entryData: any = {
    userId,
    username: data.username || existingEntry?.username || 'Unknown',
    displayName: data.displayName || existingEntry?.displayName || data.username || 'Unknown',
    photoUrl: data.photoUrl || existingEntry?.photoUrl || null,
    tacticalRating: data.tacticalRating,
    rank: null, // Computed by cron job
    puzzlesSolved: data.puzzlesSolved !== undefined ? data.puzzlesSolved : (existingEntry?.puzzlesSolved || 0),
    accuracy: data.accuracy !== undefined ? data.accuracy : (existingEntry?.accuracy || 0),
    updatedAt: { _seconds: Math.floor(Date.now() / 1000), _nanoseconds: 0 },
  };

  await firestore.setDocument(entryPath, entryData, { merge: true });
}

/**
 * Sync to Mastery leaderboard
 */
async function syncToMasteryLeaderboard(
  firestore: FirestoreClient,
  userId: string,
  data: {
    username?: string;
    displayName?: string;
    photoUrl?: string;
    overallMasteryPercentage: number;
    masteredVariations?: number;
    totalVariations?: number;
    openingsMasteredCount?: number;
    totalOpeningsCount?: number;
  }
): Promise<void> {
  const entryPath = `leaderboards/mastery/players/${userId}`;
  const existingEntry = await firestore.getDocument(entryPath);

  const entryData: any = {
    userId,
    username: data.username || existingEntry?.username || 'Unknown',
    displayName: data.displayName || existingEntry?.displayName || data.username || 'Unknown',
    photoUrl: data.photoUrl || existingEntry?.photoUrl || null,
    overallMasteryPercentage: data.overallMasteryPercentage,
    rank: null, // Computed by cron job
    masteredVariations: data.masteredVariations !== undefined ? data.masteredVariations : (existingEntry?.masteredVariations || 0),
    totalVariations: data.totalVariations !== undefined ? data.totalVariations : (existingEntry?.totalVariations || 0),
    openingsMasteredCount: data.openingsMasteredCount !== undefined ? data.openingsMasteredCount : (existingEntry?.openingsMasteredCount || 0),
    totalOpeningsCount: data.totalOpeningsCount !== undefined ? data.totalOpeningsCount : (existingEntry?.totalOpeningsCount || 0),
    updatedAt: { _seconds: Math.floor(Date.now() / 1000), _nanoseconds: 0 },
  };

  await firestore.setDocument(entryPath, entryData, { merge: true });
}

/**
 * Sync to Streak leaderboard
 */
async function syncToStreakLeaderboard(
  firestore: FirestoreClient,
  userId: string,
  data: {
    username?: string;
    displayName?: string;
    photoUrl?: string;
    currentStreak: number;
    highestStreak?: number;
    totalSessions?: number;
    lastSessionDate?: number;
  }
): Promise<void> {
  const entryPath = `leaderboards/streak/players/${userId}`;
  const existingEntry = await firestore.getDocument(entryPath);

  const entryData: any = {
    userId,
    username: data.username || existingEntry?.username || 'Unknown',
    displayName: data.displayName || existingEntry?.displayName || data.username || 'Unknown',
    photoUrl: data.photoUrl || existingEntry?.photoUrl || null,
    currentStreak: data.currentStreak,
    rank: null, // Computed by cron job
    highestStreak: data.highestStreak !== undefined ? data.highestStreak : (existingEntry?.highestStreak || data.currentStreak || 0),
    totalSessions: data.totalSessions !== undefined ? data.totalSessions : (existingEntry?.totalSessions || 0),
    lastSessionDate: data.lastSessionDate !== undefined
      ? { _seconds: Math.floor(data.lastSessionDate / 1000), _nanoseconds: 0 }
      : (existingEntry?.lastSessionDate || { _seconds: Math.floor(Date.now() / 1000), _nanoseconds: 0 }),
    updatedAt: { _seconds: Math.floor(Date.now() / 1000), _nanoseconds: 0 },
  };

  await firestore.setDocument(entryPath, entryData, { merge: true });
}

// ============ LEADERBOARD MANAGEMENT FUNCTIONS ============

/**
 * Removes a user from all leaderboards (for account deletion)
 */
export async function removeUserFromLeaderboards(
  firestore: FirestoreClient,
  userId: string
): Promise<void> {
  const promises = [
    firestore.deleteDocument(`leaderboards/elo/players/${userId}`).catch(() => {
      // Ignore if doesn't exist
    }),
    firestore.deleteDocument(`leaderboards/tactical/players/${userId}`).catch(() => {
      // Ignore if doesn't exist
    }),
    firestore.deleteDocument(`leaderboards/mastery/players/${userId}`).catch(() => {
      // Ignore if doesn't exist
    }),
    firestore.deleteDocument(`leaderboards/streak/players/${userId}`).catch(() => {
      // Ignore if doesn't exist
    }),
  ];

  await Promise.all(promises);
}

/**
 * Gets top N users from a leaderboard
 */
export async function getTopLeaderboardEntries(
  firestore: FirestoreClient,
  leaderboardType: LeaderboardType,
  limit: number = 100
): Promise<any[]> {
  const collectionPath = `leaderboards/${leaderboardType}/players`;

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
  const entries = await firestore.queryDocuments(collectionPath, [], {
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
  const collectionPath = `leaderboards/${leaderboardType}/players`;

  // Get user's entry
  const userEntry = await firestore.getDocument(`${collectionPath}/${userId}`);
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

  const userScore = userEntry[ratingField];

  // Count entries with higher scores
  const higherScoreEntries = await firestore.queryDocuments(collectionPath, [
    { field: ratingField, op: 'GREATER_THAN', value: userScore },
  ]);

  const rank = higherScoreEntries.length + 1;

  // Get total entries (could be cached)
  const allEntries = await firestore.queryDocuments(collectionPath, []);
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
