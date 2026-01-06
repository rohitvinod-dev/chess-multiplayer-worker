/**
 * Migrate ELO to Per-Mode Structure
 *
 * Converts single eloRating to per-mode ELO ratings:
 * - blitzElo: Current eloRating (since test users played blitz)
 * - rapidElo: 1200 (default)
 * - classicalElo: 1200 (default)
 * - bestElo: max of all three
 * - puzzleRushBest: 0 (fresh start for high score system)
 */

import type { Env } from '../../types';
import { FirestoreClient } from '../../firestore';

interface MigrationResult {
  userId: string;
  oldEloRating?: number;
  newBlitzElo?: number;
  newRapidElo?: number;
  newClassicalElo?: number;
  newBestElo?: number;
  status: 'migrated' | 'skipped' | 'error';
  error?: string;
}

interface MigrationReport {
  totalProcessed: number;
  migrated: number;
  skipped: number;
  errors: number;
  nextPageToken?: string;
  results: MigrationResult[];
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const DEFAULT_ELO = 1200;

/**
 * Handle ELO mode migration request
 *
 * Query params:
 * - dryRun=true: Only report what would change, don't apply
 * - limit=10: Max users to process per request (default 10)
 * - pageToken: Continue from previous page
 */
export async function handleMigrateEloModes(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === 'true';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10), 20);
  const pageToken = url.searchParams.get('pageToken') || undefined;

  const report: MigrationReport = {
    totalProcessed: 0,
    migrated: 0,
    skipped: 0,
    errors: 0,
    results: [],
  };

  try {
    const firestore = new FirestoreClient({
      projectId: env.FIREBASE_PROJECT_ID,
      serviceAccount: env.FIREBASE_SERVICE_ACCOUNT,
    });

    // Get leaderboard documents with pagination
    const leaderboardResult = await firestore.listDocuments('leaderboard', {
      pageSize: limit,
      pageToken,
    });

    if (leaderboardResult.nextPageToken) {
      report.nextPageToken = leaderboardResult.nextPageToken;
    }

    for (const doc of leaderboardResult.documents) {
      const userId = doc.id;
      report.totalProcessed++;

      try {
        await delay(50);

        const data = doc.data;

        // Check if already migrated (has blitzElo field)
        if (data.blitzElo !== undefined) {
          report.results.push({
            userId,
            status: 'skipped',
            error: 'Already migrated (blitzElo exists)',
          });
          report.skipped++;
          continue;
        }

        // Get current ELO (or default)
        const currentElo = (data.eloRating as number) || DEFAULT_ELO;

        // Set blitz to current ELO (test users played blitz)
        const blitzElo = currentElo;
        // Set rapid and classical to default
        const rapidElo = DEFAULT_ELO;
        const classicalElo = DEFAULT_ELO;
        // Best ELO is the max
        const bestElo = Math.max(blitzElo, rapidElo, classicalElo);

        if (!dryRun) {
          await delay(50);

          await firestore.setDocument(`leaderboard/${userId}`, {
            // Per-mode ELO
            blitzElo,
            rapidElo,
            classicalElo,
            bestElo,
            // Per-mode stats (initialize)
            blitzWins: data.wins || 0,
            blitzLosses: data.losses || 0,
            blitzDraws: data.draws || 0,
            blitzGamesPlayed: data.totalGamesPlayed || 0,
            rapidWins: 0,
            rapidLosses: 0,
            rapidDraws: 0,
            rapidGamesPlayed: 0,
            classicalWins: 0,
            classicalLosses: 0,
            classicalDraws: 0,
            classicalGamesPlayed: 0,
            // Puzzle Rush (fresh start)
            puzzleRushBest: 0,
            puzzleRushSessions: 0,
            // Keep legacy fields for backward compat
            // eloRating, tacticalRating, etc. remain
            updatedAt: new Date().toISOString(),
          }, { merge: true });
        }

        report.results.push({
          userId,
          oldEloRating: currentElo,
          newBlitzElo: blitzElo,
          newRapidElo: rapidElo,
          newClassicalElo: classicalElo,
          newBestElo: bestElo,
          status: 'migrated',
        });
        report.migrated++;

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
      ...report,
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Migrate ELO modes error:', error);
    return new Response(
      JSON.stringify({ error: 'Migration failed', details: String(error) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
