/**
 * Firestore Schema Restoration Migration Script
 *
 * Migrates data from global collections to user subcollections:
 * 1. matchHistory (global) → users/{uid}/matchHistory (subcollection)
 * 2. custom_openings (global) → users/{uid}/custom_openings (subcollection)
 * 3. custom_variations (global) → users/{uid}/custom_openings/{id}/variations (nested)
 * 4. leaderboards/{type}/entries → leaderboards/{type}/players (rename + field updates)
 *
 * Usage:
 *   npm install firebase-admin @types/node
 *   npx tsx migrations/restore-subcollections.ts [--dry-run] [--skip-match-history] [--skip-openings] [--skip-leaderboards]
 */

import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

// ============ CONFIGURATION ============

const BATCH_SIZE = 500; // Firestore batch write limit
const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_MATCH_HISTORY = process.argv.includes('--skip-match-history');
const SKIP_OPENINGS = process.argv.includes('--skip-openings');
const SKIP_LEADERBOARDS = process.argv.includes('--skip-leaderboards');

// ============ INITIALIZATION ============

// Initialize Firebase Admin SDK
const serviceAccountPath = path.join(__dirname, 'service-account.json');

if (!fs.existsSync(serviceAccountPath)) {
  console.error('❌ Error: service-account.json not found!');
  console.error('Please download your Firebase service account key and save it as:');
  console.error('  checkmatex-worker/migrations/service-account.json');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccountPath),
});

const db = admin.firestore();

// ============ HELPER FUNCTIONS ============

function generatePgn(moves: string[]): string {
  if (!moves || moves.length === 0) return '';

  let pgn = '';
  for (let i = 0; i < moves.length; i++) {
    if (i % 2 === 0) {
      pgn += `${Math.floor(i / 2) + 1}. ${moves[i]} `;
    } else {
      pgn += `${moves[i]} `;
    }
  }
  return pgn.trim();
}

async function executeBatch(batch: admin.firestore.WriteBatch, description: string) {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would execute batch: ${description}`);
    return;
  }

  await batch.commit();
  console.log(`  ✅ Committed batch: ${description}`);
}

// ============ MIGRATION FUNCTIONS ============

/**
 * Migrate match history from global collection to user subcollections
 * Creates 2 documents per match (one for each player)
 */
async function migrateMatchHistory() {
  console.log('\n📊 Migrating Match History...');

  try {
    // Get all matches from global collection
    const globalMatches = await db.collection('matchHistory').get();

    if (globalMatches.empty) {
      console.log('  ℹ️  No matches found in global matchHistory collection');
      return { total: 0, migrated: 0, skipped: 0 };
    }

    console.log(`  Found ${globalMatches.size} matches to migrate`);

    let batch = db.batch();
    let batchCount = 0;
    let migratedCount = 0;
    let skippedCount = 0;

    for (const matchDoc of globalMatches.docs) {
      const match = matchDoc.data();
      const matchId = matchDoc.id;

      // Validate required fields
      if (!match.whitePlayerId || !match.blackPlayerId) {
        console.warn(`  ⚠️  Skipping match ${matchId}: missing player IDs`);
        skippedCount++;
        continue;
      }

      // Generate PGN if moves exist
      const pgn = match.moves ? generatePgn(match.moves) : '';

      // Create white player's match document
      const whiteMatchRef = db
        .collection('users').doc(match.whitePlayerId)
        .collection('matchHistory').doc(matchId);

      batch.set(whiteMatchRef, {
        matchId,
        opponent: {
          userId: match.blackPlayerId,
          username: match.blackUsername || 'Unknown',
          rating: match.blackOldRating || 1200,
        },
        opening: match.opening || 'Unknown',
        openingId: match.openingId || null,
        timeControl: match.timeControl || 'blitz',
        rated: match.rated !== false,
        result: match.winner === 'white' ? 'win' : (match.winner === 'draw' ? 'draw' : 'loss'),
        reason: match.reason || 'unknown',
        playerRatingBefore: match.whiteOldRating || 1200,
        playerRatingAfter: match.whiteNewRating || 1200,
        ratingChange: match.whiteRatingChange || 0,
        opponentRatingBefore: match.blackOldRating || 1200,
        opponentRatingAfter: match.blackNewRating || 1200,
        pgn: pgn,
        fen: match.finalFen || null,
        moves: match.moves || [],
        duration: match.duration || 0,
        playedAt: match.createdAt || admin.firestore.FieldValue.serverTimestamp(),
        createdAt: match.createdAt || admin.firestore.FieldValue.serverTimestamp(),
      });

      // Create black player's match document
      const blackMatchRef = db
        .collection('users').doc(match.blackPlayerId)
        .collection('matchHistory').doc(matchId);

      batch.set(blackMatchRef, {
        matchId,
        opponent: {
          userId: match.whitePlayerId,
          username: match.whiteUsername || 'Unknown',
          rating: match.whiteOldRating || 1200,
        },
        opening: match.opening || 'Unknown',
        openingId: match.openingId || null,
        timeControl: match.timeControl || 'blitz',
        rated: match.rated !== false,
        result: match.winner === 'black' ? 'win' : (match.winner === 'draw' ? 'draw' : 'loss'),
        reason: match.reason || 'unknown',
        playerRatingBefore: match.blackOldRating || 1200,
        playerRatingAfter: match.blackNewRating || 1200,
        ratingChange: match.blackRatingChange || 0,
        opponentRatingBefore: match.whiteOldRating || 1200,
        opponentRatingAfter: match.whiteNewRating || 1200,
        pgn: pgn,
        fen: match.finalFen || null,
        moves: match.moves || [],
        duration: match.duration || 0,
        playedAt: match.createdAt || admin.firestore.FieldValue.serverTimestamp(),
        createdAt: match.createdAt || admin.firestore.FieldValue.serverTimestamp(),
      });

      batchCount += 2;
      migratedCount += 2;

      // Commit batch every 500 operations
      if (batchCount >= BATCH_SIZE) {
        await executeBatch(batch, `${migratedCount / 2} matches`);
        batch = db.batch();
        batchCount = 0;
      }
    }

    // Commit remaining operations
    if (batchCount > 0) {
      await executeBatch(batch, `final ${batchCount / 2} matches`);
    }

    console.log(`  ✅ Match history migration complete!`);
    console.log(`     - Total matches: ${globalMatches.size}`);
    console.log(`     - Migrated: ${migratedCount / 2} matches (${migratedCount} documents)`);
    console.log(`     - Skipped: ${skippedCount}`);

    return { total: globalMatches.size, migrated: migratedCount / 2, skipped: skippedCount };
  } catch (error) {
    console.error('❌ Error migrating match history:', error);
    throw error;
  }
}

/**
 * Migrate custom openings and variations to user subcollections
 */
async function migrateCustomOpenings() {
  console.log('\n🎯 Migrating Custom Openings...');

  try {
    const globalOpenings = await db.collection('custom_openings').get();
    const globalVariations = await db.collection('custom_variations').get();

    console.log(`  Found ${globalOpenings.size} openings and ${globalVariations.size} variations`);

    if (globalOpenings.empty && globalVariations.empty) {
      console.log('  ℹ️  No custom openings or variations to migrate');
      return { openings: 0, variations: 0 };
    }

    let batch = db.batch();
    let batchCount = 0;
    let openingsCount = 0;
    let variationsCount = 0;

    // Migrate openings
    for (const openingDoc of globalOpenings.docs) {
      const opening = openingDoc.data();
      const userId = opening.userId;

      if (!userId) {
        console.warn(`  ⚠️  Skipping opening ${openingDoc.id}: no userId`);
        continue;
      }

      // Skip inactive openings
      if (opening.isActive === false) {
        continue;
      }

      const newRef = db
        .collection('users').doc(userId)
        .collection('custom_openings').doc(openingDoc.id);

      batch.set(newRef, {
        openingId: openingDoc.id,
        name: opening.name,
        description: opening.description || null,
        color: opening.color || 'white',
        createdAt: opening.createdAt || admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: opening.updatedAt || admin.firestore.FieldValue.serverTimestamp(),
        variationCount: opening.variationCount || 0,
      });

      batchCount++;
      openingsCount++;

      if (batchCount >= BATCH_SIZE) {
        await executeBatch(batch, `${openingsCount} openings`);
        batch = db.batch();
        batchCount = 0;
      }
    }

    // Migrate variations
    for (const varDoc of globalVariations.docs) {
      const variation = varDoc.data();
      const userId = variation.userId;
      const openingId = variation.openingId;

      if (!userId || !openingId) {
        console.warn(`  ⚠️  Skipping variation ${varDoc.id}: missing userId or openingId`);
        continue;
      }

      // Skip inactive variations
      if (variation.isActive === false) {
        continue;
      }

      const newRef = db
        .collection('users').doc(userId)
        .collection('custom_openings').doc(openingId)
        .collection('variations').doc(varDoc.id);

      batch.set(newRef, {
        variationId: varDoc.id,
        name: variation.name,
        moves: variation.moves || [],
        fen: variation.fen || null,
        moveCount: variation.moveCount || variation.moves?.length || 0,
        masteryLevel: 0,
        practiceCount: 0,
        accuracy: 0,
        createdAt: variation.createdAt || admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: variation.updatedAt || admin.firestore.FieldValue.serverTimestamp(),
      });

      batchCount++;
      variationsCount++;

      if (batchCount >= BATCH_SIZE) {
        await executeBatch(batch, `${variationsCount} variations`);
        batch = db.batch();
        batchCount = 0;
      }
    }

    // Commit remaining
    if (batchCount > 0) {
      await executeBatch(batch, `final batch`);
    }

    console.log(`  ✅ Custom openings migration complete!`);
    console.log(`     - Openings: ${openingsCount}`);
    console.log(`     - Variations: ${variationsCount}`);

    return { openings: openingsCount, variations: variationsCount };
  } catch (error) {
    console.error('❌ Error migrating custom openings:', error);
    throw error;
  }
}

/**
 * Migrate leaderboards: entries → players, score → eloRating/tacticalRating, etc.
 */
async function migrateLeaderboards() {
  console.log('\n🏆 Migrating Leaderboards...');

  try {
    let batch = db.batch();
    let batchCount = 0;
    let eloCount = 0;
    let tacticalCount = 0;
    let masteryCount = 0;
    let streakCount = 0;

    // 1. Migrate ELO leaderboard (entries → players)
    console.log('  Migrating ELO leaderboard...');
    const eloEntries = await db.collection('leaderboards').doc('elo').collection('entries').get();

    for (const entry of eloEntries.docs) {
      const data = entry.data();

      // Fetch user profile to get match statistics
      let profileData: any = {};
      try {
        const userProfile = await db.collection('users').doc(entry.id).collection('profile').doc('ratings').get();
        profileData = userProfile.data() || {};
      } catch (e) {
        console.warn(`  ⚠️  Could not fetch profile for user ${entry.id}`);
      }

      const newRef = db.collection('leaderboards').doc('elo').collection('players').doc(entry.id);

      batch.set(newRef, {
        userId: data.userId || entry.id,
        username: data.username || 'Unknown',
        displayName: data.displayName || data.username || 'Unknown',
        photoUrl: data.photoUrl || null,
        eloRating: data.score || data.eloRating || 1200,
        rank: null, // Will be recomputed by cron
        wins: profileData.wins || 0,
        losses: profileData.losses || 0,
        draws: profileData.draws || 0,
        totalGames: profileData.totalGames || 0,
        updatedAt: data.lastUpdated || data.updatedAt || admin.firestore.FieldValue.serverTimestamp(),
      });

      batchCount++;
      eloCount++;

      if (batchCount >= BATCH_SIZE) {
        await executeBatch(batch, `${eloCount} ELO entries`);
        batch = db.batch();
        batchCount = 0;
      }
    }

    // 2. Migrate Tactical leaderboard
    console.log('  Migrating Tactical leaderboard...');
    const tacticalEntries = await db.collection('leaderboards').doc('tactical').collection('entries').get();

    for (const entry of tacticalEntries.docs) {
      const data = entry.data();

      const newRef = db.collection('leaderboards').doc('tactical').collection('players').doc(entry.id);

      batch.set(newRef, {
        userId: data.userId || entry.id,
        username: data.username || 'Unknown',
        displayName: data.displayName || data.username || 'Unknown',
        photoUrl: data.photoUrl || null,
        tacticalRating: data.score || data.tacticalRating || 1200,
        rank: null,
        puzzlesSolved: data.puzzlesSolved || 0,
        accuracy: data.accuracy || 0,
        updatedAt: data.lastUpdated || data.updatedAt || admin.firestore.FieldValue.serverTimestamp(),
      });

      batchCount++;
      tacticalCount++;

      if (batchCount >= BATCH_SIZE) {
        await executeBatch(batch, `${tacticalCount} tactical entries`);
        batch = db.batch();
        batchCount = 0;
      }
    }

    // 3. Create Mastery leaderboard from legacy leaderboard collection
    console.log('  Creating Mastery leaderboard from legacy data...');
    const legacyLeaderboard = await db.collection('leaderboard').get();

    for (const entry of legacyLeaderboard.docs) {
      const data = entry.data();

      // Only create if has mastery data
      if (!data.overallMasteryPercentage && !data.masteredVariations) continue;

      const newRef = db.collection('leaderboards').doc('mastery').collection('players').doc(entry.id);

      batch.set(newRef, {
        userId: entry.id,
        username: data.username || 'Unknown',
        displayName: data.displayName || data.username || 'Unknown',
        photoUrl: data.photoUrl || null,
        overallMasteryPercentage: data.overallMasteryPercentage || 0,
        rank: null,
        masteredVariations: data.masteredVariations || 0,
        totalVariations: data.totalVariations || 0,
        openingsMasteredCount: data.openingsMasteredCount || 0,
        totalOpeningsCount: data.totalOpeningsCount || 0,
        updatedAt: data.updatedAt || admin.firestore.FieldValue.serverTimestamp(),
      });

      batchCount++;
      masteryCount++;

      if (batchCount >= BATCH_SIZE) {
        await executeBatch(batch, `${masteryCount} mastery entries`);
        batch = db.batch();
        batchCount = 0;
      }
    }

    // 4. Create Streak leaderboard from legacy leaderboard collection
    console.log('  Creating Streak leaderboard from legacy data...');
    for (const entry of legacyLeaderboard.docs) {
      const data = entry.data();

      // Only create if has streak data
      if (!data.currentStreak && !data.totalSessions) continue;

      const newRef = db.collection('leaderboards').doc('streak').collection('players').doc(entry.id);

      batch.set(newRef, {
        userId: entry.id,
        username: data.username || 'Unknown',
        displayName: data.displayName || data.username || 'Unknown',
        photoUrl: data.photoUrl || null,
        currentStreak: data.currentStreak || 0,
        rank: null,
        highestStreak: data.highestStreak || data.currentStreak || 0,
        totalSessions: data.totalSessions || 0,
        lastSessionDate: data.lastSessionDate || admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: data.updatedAt || admin.firestore.FieldValue.serverTimestamp(),
      });

      batchCount++;
      streakCount++;

      if (batchCount >= BATCH_SIZE) {
        await executeBatch(batch, `${streakCount} streak entries`);
        batch = db.batch();
        batchCount = 0;
      }
    }

    // Commit remaining
    if (batchCount > 0) {
      await executeBatch(batch, `final leaderboard batch`);
    }

    console.log(`  ✅ Leaderboards migration complete!`);
    console.log(`     - ELO: ${eloCount}`);
    console.log(`     - Tactical: ${tacticalCount}`);
    console.log(`     - Mastery: ${masteryCount}`);
    console.log(`     - Streak: ${streakCount}`);

    return { elo: eloCount, tactical: tacticalCount, mastery: masteryCount, streak: streakCount };
  } catch (error) {
    console.error('❌ Error migrating leaderboards:', error);
    throw error;
  }
}

// ============ MAIN EXECUTION ============

async function main() {
  console.log('🚀 Firestore Schema Restoration Migration');
  console.log('==========================================');

  if (DRY_RUN) {
    console.log('⚠️  DRY RUN MODE - No data will be written');
  }

  const results: any = {};

  try {
    // Migrate match history
    if (!SKIP_MATCH_HISTORY) {
      results.matchHistory = await migrateMatchHistory();
    } else {
      console.log('\n⏭️  Skipping match history migration');
    }

    // Migrate custom openings
    if (!SKIP_OPENINGS) {
      results.customOpenings = await migrateCustomOpenings();
    } else {
      console.log('\n⏭️  Skipping custom openings migration');
    }

    // Migrate leaderboards
    if (!SKIP_LEADERBOARDS) {
      results.leaderboards = await migrateLeaderboards();
    } else {
      console.log('\n⏭️  Skipping leaderboards migration');
    }

    console.log('\n✅ All migrations complete!');
    console.log('==========================================');
    console.log('Summary:');
    if (results.matchHistory) {
      console.log(`  Match History: ${results.matchHistory.migrated} matches migrated`);
    }
    if (results.customOpenings) {
      console.log(`  Custom Openings: ${results.customOpenings.openings} openings, ${results.customOpenings.variations} variations`);
    }
    if (results.leaderboards) {
      console.log(`  Leaderboards: ELO=${results.leaderboards.elo}, Tactical=${results.leaderboards.tactical}, Mastery=${results.leaderboards.mastery}, Streak=${results.leaderboards.streak}`);
    }

    if (DRY_RUN) {
      console.log('\n⚠️  This was a DRY RUN. Run without --dry-run to actually migrate data.');
    } else {
      console.log('\n📝 Note: Old global collections have NOT been deleted.');
      console.log('   After verifying the migration, you can delete:');
      console.log('   - matchHistory (global collection)');
      console.log('   - custom_openings (global collection)');
      console.log('   - custom_variations (global collection)');
      console.log('   - leaderboards/elo/entries (subcollection)');
      console.log('   - leaderboards/tactical/entries (subcollection)');
    }

  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
  }
}

// Run migration
main()
  .then(() => {
    console.log('\n✅ Migration script completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Migration script failed:', error);
    process.exit(1);
  });
