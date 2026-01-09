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
 * - (pageToken removed - now queries only users with games)
 */
export async function handleMigrateEloModes(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === 'true';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
  // pageToken removed - now queries only users with games

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

    // Query ONLY users who have played games (totalGamesPlayed > 0)
    // This is much more efficient than listing all users
    const usersWithGames = await firestore.queryDocuments('leaderboard', [
      { field: 'totalGamesPlayed', op: 'GREATER_THAN', value: 0 },
    ]);

    console.log(`[Migration] Found ${usersWithGames.length} users with games played`);

    // Process up to limit users
    for (const userData of usersWithGames.slice(0, limit)) {
      const userId = userData._id as string;
      report.totalProcessed++;

      try {
        await delay(50);

        const data = userData;

        // Check if already fully migrated
        // A user is fully migrated if:
        // 1. Has blitzElo AND
        // 2. Has blitzGamesPlayed that matches totalGamesPlayed (or is > 0 if totalGamesPlayed > 0)
        const hasBlitzElo = data.blitzElo !== undefined;
        const blitzGamesPlayed = (data.blitzGamesPlayed as number) || 0;
        const totalGamesPlayed = (data.totalGamesPlayed as number) || 0;
        const allModeGames = blitzGamesPlayed + ((data.rapidGamesPlayed as number) || 0) + ((data.classicalGamesPlayed as number) || 0);

        // Skip if fully migrated: has per-mode data that accounts for all games
        if (hasBlitzElo && (totalGamesPlayed === 0 || allModeGames >= totalGamesPlayed)) {
          report.results.push({
            userId,
            status: 'skipped',
            error: `Already migrated (blitzElo=${data.blitzElo}, blitzGames=${blitzGamesPlayed}, totalGames=${totalGamesPlayed})`,
          });
          report.skipped++;
          continue;
        }

        // Need migration if: totalGamesPlayed > 0 but per-mode games don't add up
        const needsMigration = totalGamesPlayed > 0 && allModeGames < totalGamesPlayed;
        if (!needsMigration) {
          report.results.push({
            userId,
            status: 'skipped',
            error: 'No games to migrate',
          });
          report.skipped++;
          continue;
        }

        // Calculate games that need to be migrated to blitz
        const gamesToMigrate = totalGamesPlayed - allModeGames;

        // Get current ELO values (or default)
        const currentElo = (data.eloRating as number) || DEFAULT_ELO;
        const existingBlitzElo = (data.blitzElo as number) || DEFAULT_ELO;
        const existingRapidElo = (data.rapidElo as number) || DEFAULT_ELO;
        const existingClassicalElo = (data.classicalElo as number) || DEFAULT_ELO;

        // For blitz ELO: use legacy ELO if we're migrating games to blitz
        // This fixes cases where blitzElo was set to default 1200 but legacy eloRating has the actual earned rating
        // If legacy ELO != default and existing blitz ELO == default, use legacy ELO
        const blitzElo = (currentElo !== DEFAULT_ELO && existingBlitzElo === DEFAULT_ELO)
          ? currentElo  // Use legacy ELO (it reflects actual performance)
          : existingBlitzElo;  // Keep existing if already modified from default
        const rapidElo = existingRapidElo;
        const classicalElo = existingClassicalElo;
        // Best ELO is the max
        const bestElo = Math.max(blitzElo, rapidElo, classicalElo);

        // Calculate per-mode stats: add missing games to blitz
        // (assuming legacy games were all blitz - most common mode)
        const existingBlitzWins = (data.blitzWins as number) || 0;
        const existingBlitzLosses = (data.blitzLosses as number) || 0;
        const existingBlitzDraws = (data.blitzDraws as number) || 0;

        // Calculate wins/losses/draws to migrate
        const legacyWins = (data.wins as number) || 0;
        const legacyLosses = (data.losses as number) || 0;
        const legacyDraws = (data.draws as number) || 0;

        // Add unmigrated games to blitz
        const newBlitzWins = Math.max(existingBlitzWins, legacyWins);
        const newBlitzLosses = Math.max(existingBlitzLosses, legacyLosses);
        const newBlitzDraws = Math.max(existingBlitzDraws, legacyDraws);
        const newBlitzGamesPlayed = newBlitzWins + newBlitzLosses + newBlitzDraws;

        console.log(`[Migration] User ${userId}: migrating ${gamesToMigrate} games to blitz (total=${totalGamesPlayed}, blitz=${blitzGamesPlayed})`);

        if (!dryRun) {
          await delay(50);

          await firestore.setDocument(`leaderboard/${userId}`, {
            // Per-mode ELO
            blitzElo,
            rapidElo,
            classicalElo,
            bestElo,
            // Per-mode stats - update blitz with migrated games
            blitzWins: newBlitzWins,
            blitzLosses: newBlitzLosses,
            blitzDraws: newBlitzDraws,
            blitzGamesPlayed: newBlitzGamesPlayed,
            // Rapid and Classical - keep existing or init to 0
            rapidWins: (data.rapidWins as number) || 0,
            rapidLosses: (data.rapidLosses as number) || 0,
            rapidDraws: (data.rapidDraws as number) || 0,
            rapidGamesPlayed: (data.rapidGamesPlayed as number) || 0,
            classicalWins: (data.classicalWins as number) || 0,
            classicalLosses: (data.classicalLosses as number) || 0,
            classicalDraws: (data.classicalDraws as number) || 0,
            classicalGamesPlayed: (data.classicalGamesPlayed as number) || 0,
            // Timestamp
            updatedAt: new Date().toISOString(),
            migratedAt: new Date().toISOString(),
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
          error: `Migrated: blitzGames ${blitzGamesPlayed} → ${newBlitzGamesPlayed}, wins ${existingBlitzWins} → ${newBlitzWins}, losses ${existingBlitzLosses} → ${newBlitzLosses}`,
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
