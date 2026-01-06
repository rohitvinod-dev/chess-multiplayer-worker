/**
 * POST /api/admin/migrate-leaderboards
 *
 * Paginated migration to sync ELO/Tactical ratings from users/{uid}/profile/ratings
 * to the unified leaderboard/{uid} collection.
 *
 * Query params:
 * - limit: number of users to process per request (default: 10, max: 20)
 * - offset: starting index (default: 0)
 *
 * Call multiple times with increasing offset to process all users.
 */

import type { FirestoreClient } from '../../firestore';
import { formatTimestamp } from '../../utils/mastery';

interface MigrationStats {
  usersProcessed: number;
  ratingsFound: number;
  leaderboardEntriesUpdated: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  errors: string[];
}

export async function handleMigrateLeaderboards(
  request: Request,
  firestore: FirestoreClient,
  adminSecret: string
): Promise<Response> {
  // Simple auth check - require admin secret in header
  const authHeader = request.headers.get('X-Admin-Secret');
  if (authHeader !== adminSecret) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Parse query params for pagination
  const url = new URL(request.url);
  let limit = parseInt(url.searchParams.get('limit') || '10');
  let offset = parseInt(url.searchParams.get('offset') || '0');

  // Enforce limits to stay within Cloudflare subrequest limits
  // Each user requires ~3 subrequests (user doc, ratings doc, leaderboard write)
  if (limit > 20) limit = 20;
  if (limit < 1) limit = 10;
  if (offset < 0) offset = 0;

  const stats: MigrationStats = {
    usersProcessed: 0,
    ratingsFound: 0,
    leaderboardEntriesUpdated: 0,
    offset,
    limit,
    hasMore: false,
    errors: [],
  };

  try {
    console.log(`Starting leaderboard migration (offset: ${offset}, limit: ${limit})...`);

    // Step 1: Get users with pagination
    // Note: Firestore doesn't have native offset, so we fetch limit+1 to check if there's more
    const allUsers = await firestore.queryDocuments('users', []);
    const totalUsers = allUsers.length;

    // Slice the array for pagination
    const usersToProcess = allUsers.slice(offset, offset + limit);
    stats.hasMore = (offset + limit) < totalUsers;

    console.log(`Processing users ${offset} to ${offset + usersToProcess.length} of ${totalUsers}`);

    // Step 2: For each user, fetch their ratings and sync to leaderboard
    for (const user of usersToProcess) {
      const uid = user._id;
      if (!uid) continue;

      stats.usersProcessed++;

      try {
        // Fetch the user's ratings document
        const ratingsPath = `users/${uid}/profile/ratings`;
        const ratings = await firestore.getDocument(ratingsPath);

        // Fetch existing leaderboard entry
        const existingLeaderboard = await firestore.getDocument(`leaderboard/${uid}`);

        // Only process if user has ratings data OR already has a leaderboard entry
        if (!ratings && !existingLeaderboard) {
          continue;
        }

        if (ratings) {
          stats.ratingsFound++;
        }

        // Build the merged data
        const mergedData: any = {
          // User info from users document
          username: user.username || existingLeaderboard?.username || user.displayName || 'Unknown',
          displayName: user.displayName || existingLeaderboard?.displayName,
          countryCode: user.countryCode || existingLeaderboard?.countryCode,
          photoUrl: user.photoUrl || existingLeaderboard?.photoUrl,

          // ELO data from ratings document
          eloRating: ratings?.eloRating || existingLeaderboard?.eloRating,
          totalGamesPlayed: ratings?.totalGamesPlayed || existingLeaderboard?.totalGamesPlayed,
          provisionalGames: ratings?.provisionalGames || existingLeaderboard?.provisionalGames,
          wins: ratings?.wins || existingLeaderboard?.wins,
          losses: ratings?.losses || existingLeaderboard?.losses,
          draws: ratings?.draws || existingLeaderboard?.draws,

          // Tactical data from ratings document
          tacticalRating: ratings?.tacticalRating || existingLeaderboard?.tacticalRating,
          puzzlesSolved: ratings?.puzzlesSolved || existingLeaderboard?.puzzlesSolved,

          // Preserve existing mastery/streak data
          totalPoints: existingLeaderboard?.totalPoints,
          masteryPoints: existingLeaderboard?.masteryPoints,
          learnPoints: existingLeaderboard?.learnPoints,
          overallMasteryPercentage: existingLeaderboard?.overallMasteryPercentage,
          masteredVariations: existingLeaderboard?.masteredVariations,
          totalVariations: existingLeaderboard?.totalVariations,
          openingsMasteredCount: existingLeaderboard?.openingsMasteredCount,
          totalOpeningsCount: existingLeaderboard?.totalOpeningsCount,
          currentStreak: existingLeaderboard?.currentStreak,
          highestStreak: existingLeaderboard?.highestStreak,
          totalSessions: existingLeaderboard?.totalSessions,

          // Meta
          updatedAt: formatTimestamp(new Date()),
          migratedAt: formatTimestamp(new Date()),
        };

        // Remove undefined values - only keep fields that have data
        Object.keys(mergedData).forEach(key => {
          if (mergedData[key] === undefined || mergedData[key] === null) {
            delete mergedData[key];
          }
        });

        // Only update if we have meaningful data (at least username or rating)
        if (mergedData.username || mergedData.eloRating || mergedData.tacticalRating || mergedData.totalPoints) {
          await firestore.setDocument(`leaderboard/${uid}`, mergedData, { merge: true });
          stats.leaderboardEntriesUpdated++;
        }
      } catch (error) {
        const errorMsg = `Error processing user ${uid}: ${error}`;
        console.error(errorMsg);
        stats.errors.push(errorMsg);
      }
    }

    console.log('Migration batch completed!');
    console.log(`Users processed: ${stats.usersProcessed}`);
    console.log(`Ratings found: ${stats.ratingsFound}`);
    console.log(`Leaderboard entries updated: ${stats.leaderboardEntriesUpdated}`);
    console.log(`Has more: ${stats.hasMore}`);

    return new Response(
      JSON.stringify({
        success: true,
        message: stats.hasMore
          ? `Processed ${stats.usersProcessed} users. Call again with offset=${offset + limit} for next batch.`
          : 'Migration complete - all users processed!',
        stats,
        nextOffset: stats.hasMore ? offset + limit : null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Migration failed:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: String(error),
        stats,
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
