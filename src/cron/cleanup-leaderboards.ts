/**
 * Daily Leaderboard Cleanup Cron Job
 * Runs at 2 AM UTC daily
 *
 * Purpose: Remove deleted/inactive users from leaderboards
 * Batch size: 500 users per run to avoid timeouts
 */

import type { FirestoreClient } from '../firestore';
import type { LeaderboardType } from '../types/openings';

// ============ MAIN CLEANUP FUNCTION ============

export async function cleanupLeaderboards(firestore: FirestoreClient): Promise<{
  success: boolean;
  cleaned: number;
  errors: number;
  duration: number;
}> {
  const startTime = Date.now();
  let totalCleaned = 0;
  let totalErrors = 0;

  console.log('[Cron] Starting daily leaderboard cleanup...');

  try {
    // Clean both ELO and Tactical leaderboards
    const [eloResult, tacticalResult] = await Promise.all([
      cleanupSingleLeaderboard(firestore, 'elo'),
      cleanupSingleLeaderboard(firestore, 'tactical'),
    ]);

    totalCleaned = eloResult.cleaned + tacticalResult.cleaned;
    totalErrors = eloResult.errors + tacticalResult.errors;

    const duration = Date.now() - startTime;

    console.log(`[Cron] Leaderboard cleanup complete:`);
    console.log(`  - ELO: ${eloResult.cleaned} cleaned, ${eloResult.errors} errors`);
    console.log(`  - Tactical: ${tacticalResult.cleaned} cleaned, ${tacticalResult.errors} errors`);
    console.log(`  - Duration: ${duration}ms`);

    return {
      success: true,
      cleaned: totalCleaned,
      errors: totalErrors,
      duration,
    };
  } catch (error) {
    console.error('[Cron] Leaderboard cleanup failed:', error);
    return {
      success: false,
      cleaned: totalCleaned,
      errors: totalErrors + 1,
      duration: Date.now() - startTime,
    };
  }
}

// ============ HELPER FUNCTIONS ============

async function cleanupSingleLeaderboard(
  firestore: FirestoreClient,
  leaderboardType: LeaderboardType
): Promise<{ cleaned: number; errors: number }> {
  const collectionPath = `leaderboards/${leaderboardType}/entries`;
  let cleaned = 0;
  let errors = 0;

  try {
    // Get all leaderboard entries (limit to 500 per run to avoid timeouts)
    const entries = await firestore.queryDocuments(collectionPath, [], {
      limit: 500,
    });

    console.log(`[Cron] Checking ${entries.length} ${leaderboardType} leaderboard entries...`);

    // Check each entry to see if user still exists and is active
    const deletePromises: Promise<void>[] = [];

    for (const entry of entries) {
      const userId = entry.userId;

      // Check if user exists and is not deleted
      const userDoc = await firestore.getDocument(`users/${userId}`);

      if (!userDoc || userDoc.deleted === true || userDoc.isActive === false) {
        // User is deleted or inactive, remove from leaderboard
        console.log(`[Cron] Removing deleted user ${userId} from ${leaderboardType} leaderboard`);

        deletePromises.push(
          firestore
            .deleteDocument(`${collectionPath}/${userId}`)
            .then(() => {
              cleaned++;
            })
            .catch((error) => {
              console.error(`[Cron] Error deleting ${userId} from ${leaderboardType}:`, error);
              errors++;
            })
        );
      }
    }

    // Execute all deletes in parallel
    await Promise.all(deletePromises);
  } catch (error) {
    console.error(`[Cron] Error cleaning ${leaderboardType} leaderboard:`, error);
    errors++;
  }

  return { cleaned, errors };
}

// ============ ADDITIONAL CLEANUP UTILITIES ============

/**
 * Remove stale entries (users who haven't played in 365 days)
 * Optional - can be called separately if needed
 */
export async function cleanupStaleEntries(
  firestore: FirestoreClient,
  daysInactive: number = 365
): Promise<{ cleaned: number; errors: number }> {
  const cutoffTime = Date.now() - daysInactive * 24 * 60 * 60 * 1000;
  const cutoffSeconds = Math.floor(cutoffTime / 1000);

  let cleaned = 0;
  let errors = 0;

  const leaderboardTypes: LeaderboardType[] = ['elo', 'tactical'];

  for (const leaderboardType of leaderboardTypes) {
    try {
      const collectionPath = `leaderboards/${leaderboardType}/entries`;
      const entries = await firestore.queryDocuments(collectionPath, [], {
        limit: 500,
      });

      const deletePromises: Promise<void>[] = [];

      for (const entry of entries) {
        const lastUpdatedSeconds = entry.lastUpdated?._seconds || 0;

        if (lastUpdatedSeconds < cutoffSeconds) {
          console.log(
            `[Cron] Removing stale user ${entry.userId} from ${leaderboardType} (${daysInactive} days inactive)`
          );

          deletePromises.push(
            firestore
              .deleteDocument(`${collectionPath}/${entry.userId}`)
              .then(() => {
                cleaned++;
              })
              .catch((error) => {
                console.error(`[Cron] Error deleting stale entry:`, error);
                errors++;
              })
          );
        }
      }

      await Promise.all(deletePromises);
    } catch (error) {
      console.error(`[Cron] Error cleaning stale ${leaderboardType} entries:`, error);
      errors++;
    }
  }

  console.log(`[Cron] Stale cleanup: ${cleaned} removed, ${errors} errors`);
  return { cleaned, errors };
}
