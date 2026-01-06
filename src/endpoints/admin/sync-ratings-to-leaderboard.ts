/**
 * Sync Ratings to Leaderboard Endpoint
 *
 * Migrates ELO and Tactical ratings from users/{uid}/profile/ratings
 * to the unified leaderboard/{uid} collection.
 */

import type { Env } from '../../types';
import { FirestoreClient } from '../../firestore';

interface SyncResult {
  userId: string;
  eloRating?: number;
  tacticalRating?: number;
  puzzlesSolved?: number;
  status: 'synced' | 'skipped' | 'error';
  error?: string;
}

interface SyncReport {
  totalProcessed: number;
  synced: number;
  skipped: number;
  errors: number;
  nextPageToken?: string;
  results: SyncResult[];
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Handle ratings sync request
 *
 * Query params:
 * - dryRun=true: Only report what would change, don't apply
 * - limit=10: Max users to process per request (default 10, max 20 to stay within subrequest limits)
 * - pageToken: Continue from previous page
 * - syncAll=true: Sync all ratings including default values (default: only sync non-default)
 */
export async function handleSyncRatingsToLeaderboard(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === 'true';
  const syncAll = url.searchParams.get('syncAll') === 'true';
  // Keep batch size small to avoid subrequest limits (each user = 1 GET + 1 SET = 2 subrequests)
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10), 20);
  const pageToken = url.searchParams.get('pageToken') || undefined;

  const report: SyncReport = {
    totalProcessed: 0,
    synced: 0,
    skipped: 0,
    errors: 0,
    results: [],
  };

  try {
    const firestore = new FirestoreClient({
      projectId: env.FIREBASE_PROJECT_ID,
      serviceAccount: env.FIREBASE_SERVICE_ACCOUNT,
    });

    // Get users with pagination
    const usersResult = await firestore.listDocuments('users', {
      pageSize: limit,
      pageToken,
    });

    // Store next page token for continuation
    if (usersResult.nextPageToken) {
      report.nextPageToken = usersResult.nextPageToken;
    }

    for (const userDoc of usersResult.documents) {
      const userId = userDoc.id;
      report.totalProcessed++;

      try {
        // Small delay before each user to avoid hitting limits
        await delay(50);

        // Get ratings from profile/ratings subcollection
        const ratingsDoc = await firestore.getDocument(`users/${userId}/profile/ratings`);

        if (!ratingsDoc) {
          report.results.push({
            userId,
            status: 'skipped',
            error: 'No ratings document found',
          });
          report.skipped++;
          continue;
        }

        const eloRating = ratingsDoc.eloRating as number | undefined;
        const tacticalRating = ratingsDoc.tacticalRating as number | undefined;
        const puzzlesSolved = ratingsDoc.puzzlesSolved as number | undefined;
        const totalGamesPlayed = ratingsDoc.totalGamesPlayed as number | undefined;
        const wins = ratingsDoc.wins as number | undefined;
        const losses = ratingsDoc.losses as number | undefined;
        const draws = ratingsDoc.draws as number | undefined;
        const provisionalGames = ratingsDoc.provisionalGames as number | undefined;

        // Skip if no meaningful rating data (unless syncAll is true)
        const hasNonDefaultElo = eloRating && eloRating !== 1200;
        const hasNonDefaultTactical = tacticalRating && tacticalRating > 0;
        const hasPuzzlesSolved = puzzlesSolved && puzzlesSolved > 0;

        if (!syncAll && !hasNonDefaultElo && !hasNonDefaultTactical && !hasPuzzlesSolved) {
          report.results.push({
            userId,
            eloRating,
            tacticalRating,
            status: 'skipped',
            error: 'No meaningful rating data (default values)',
          });
          report.skipped++;
          continue;
        }

        // Update leaderboard with rating data
        if (!dryRun) {
          await delay(50); // Delay before write

          const updateData: Record<string, unknown> = {
            updatedAt: new Date().toISOString(),
          };

          if (eloRating !== undefined) {
            updateData.eloRating = eloRating;
          }
          if (tacticalRating !== undefined) {
            updateData.tacticalRating = tacticalRating;
          }
          if (puzzlesSolved !== undefined) {
            updateData.puzzlesSolved = puzzlesSolved;
          }
          if (totalGamesPlayed !== undefined) {
            updateData.totalGamesPlayed = totalGamesPlayed;
          }
          if (wins !== undefined) {
            updateData.wins = wins;
          }
          if (losses !== undefined) {
            updateData.losses = losses;
          }
          if (draws !== undefined) {
            updateData.draws = draws;
          }
          if (provisionalGames !== undefined) {
            updateData.provisionalGames = provisionalGames;
          }

          await firestore.setDocument(`leaderboard/${userId}`, updateData, { merge: true });
        }

        report.results.push({
          userId,
          eloRating,
          tacticalRating,
          puzzlesSolved,
          status: 'synced',
        });
        report.synced++;

      } catch (error) {
        report.results.push({
          userId,
          status: 'error',
          error: String(error),
        });
        report.errors++;
      }
    }

    return new Response(JSON.stringify({
      dryRun,
      syncAll,
      ...report,
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Sync ratings error:', error);
    return new Response(
      JSON.stringify({ error: 'Sync failed', details: String(error) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
