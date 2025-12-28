/**
 * Delete User Account Endpoint
 * Handles complete deletion of user data from Firestore
 *
 * POST /api/users/delete-account
 *
 * This endpoint must be called BEFORE deleting the Firebase Auth account
 * because it requires valid authentication to verify the user's identity.
 */

import type { FirestoreClient } from '../../firestore';
import type { AuthenticatedUser } from '../../types';

interface DeleteAccountResponse {
  success: boolean;
  deletedCollections: string[];
  errors?: string[];
  message: string;
}

export async function handleDeleteAccount(
  request: Request,
  firestore: FirestoreClient,
  user: AuthenticatedUser
): Promise<Response> {
  const userId = user.uid;
  console.log(`[DeleteAccount] Starting account deletion for user: ${userId}`);

  try {
    const deletedCollections: string[] = [];
    const errors: string[] = [];

    // ========================================
    // 1. DELETE SUBCOLLECTIONS
    // ========================================

    // Delete custom_openings (with nested variations)
    try {
      console.log(`[DeleteAccount] Deleting custom_openings for user: ${userId}`);
      const customOpenings = await firestore.queryDocuments(
        `users/${userId}/custom_openings`,
        []
      );

      for (const opening of customOpenings) {
        // Delete nested variations
        try {
          const variations = await firestore.queryDocuments(
            `users/${userId}/custom_openings/${opening._id}/variations`,
            []
          );

          for (const variation of variations) {
            await firestore.deleteDocument(
              `users/${userId}/custom_openings/${opening._id}/variations/${variation._id}`
            );
          }
        } catch (e) {
          // Variations subcollection might not exist
        }

        // Delete opening document
        await firestore.deleteDocument(
          `users/${userId}/custom_openings/${opening._id}`
        );
      }

      deletedCollections.push('custom_openings');
      console.log(`[DeleteAccount] Deleted ${customOpenings.length} custom openings`);
    } catch (error) {
      console.error(`[DeleteAccount] Error deleting custom_openings:`, error);
      errors.push(`custom_openings: ${error}`);
    }

    // Delete progress_openings
    try {
      console.log(`[DeleteAccount] Deleting progress_openings for user: ${userId}`);
      const progressOpenings = await firestore.queryDocuments(
        `users/${userId}/progress_openings`,
        []
      );

      for (const doc of progressOpenings) {
        await firestore.deleteDocument(`users/${userId}/progress_openings/${doc._id}`);
      }

      deletedCollections.push('progress_openings');
      console.log(`[DeleteAccount] Deleted ${progressOpenings.length} progress_openings`);
    } catch (error) {
      console.error(`[DeleteAccount] Error deleting progress_openings:`, error);
      errors.push(`progress_openings: ${error}`);
    }

    // Delete devices
    try {
      console.log(`[DeleteAccount] Deleting devices for user: ${userId}`);
      const devices = await firestore.queryDocuments(
        `users/${userId}/devices`,
        []
      );

      for (const doc of devices) {
        await firestore.deleteDocument(`users/${userId}/devices/${doc._id}`);
      }

      deletedCollections.push('devices');
      console.log(`[DeleteAccount] Deleted ${devices.length} devices`);
    } catch (error) {
      console.error(`[DeleteAccount] Error deleting devices:`, error);
      errors.push(`devices: ${error}`);
    }

    // Delete matchHistory (server-write only)
    try {
      console.log(`[DeleteAccount] Deleting matchHistory for user: ${userId}`);
      const matches = await firestore.queryDocuments(
        `users/${userId}/matchHistory`,
        []
      );

      for (const doc of matches) {
        await firestore.deleteDocument(`users/${userId}/matchHistory/${doc._id}`);
      }

      deletedCollections.push('matchHistory');
      console.log(`[DeleteAccount] Deleted ${matches.length} match history entries`);
    } catch (error) {
      console.error(`[DeleteAccount] Error deleting matchHistory:`, error);
      errors.push(`matchHistory: ${error}`);
    }

    // Delete achievements
    try {
      console.log(`[DeleteAccount] Deleting achievements for user: ${userId}`);
      const achievements = await firestore.queryDocuments(
        `users/${userId}/achievements`,
        []
      );

      for (const doc of achievements) {
        await firestore.deleteDocument(`users/${userId}/achievements/${doc._id}`);
      }

      deletedCollections.push('achievements');
      console.log(`[DeleteAccount] Deleted ${achievements.length} achievements`);
    } catch (error) {
      console.error(`[DeleteAccount] Error deleting achievements:`, error);
      errors.push(`achievements: ${error}`);
    }

    // Delete progress_events
    try {
      console.log(`[DeleteAccount] Deleting progress_events for user: ${userId}`);
      const events = await firestore.queryDocuments(
        `users/${userId}/progress_events`,
        []
      );

      for (const doc of events) {
        await firestore.deleteDocument(`users/${userId}/progress_events/${doc._id}`);
      }

      deletedCollections.push('progress_events');
      console.log(`[DeleteAccount] Deleted ${events.length} progress events`);
    } catch (error) {
      console.error(`[DeleteAccount] Error deleting progress_events:`, error);
      errors.push(`progress_events: ${error}`);
    }

    // Delete activity_log
    try {
      console.log(`[DeleteAccount] Deleting activity_log for user: ${userId}`);
      const activities = await firestore.queryDocuments(
        `users/${userId}/activity_log`,
        []
      );

      for (const doc of activities) {
        await firestore.deleteDocument(`users/${userId}/activity_log/${doc._id}`);
      }

      deletedCollections.push('activity_log');
      console.log(`[DeleteAccount] Deleted ${activities.length} activity log entries`);
    } catch (error) {
      console.error(`[DeleteAccount] Error deleting activity_log:`, error);
      errors.push(`activity_log: ${error}`);
    }

    // Delete public/data
    try {
      console.log(`[DeleteAccount] Deleting public data for user: ${userId}`);
      const publicDataPath = `users/${userId}/public/data`;
      const publicData = await firestore.getDocument(publicDataPath);

      if (publicData) {
        await firestore.deleteDocument(publicDataPath);
        deletedCollections.push('public/data');
        console.log(`[DeleteAccount] Deleted public data`);
      } else {
        console.log(`[DeleteAccount] No public data found, skipping`);
      }
    } catch (error) {
      console.error(`[DeleteAccount] Error deleting public/data:`, error);
      errors.push(`public/data: ${error}`);
    }

    // Delete profile/ratings (server-write only)
    try {
      console.log(`[DeleteAccount] Deleting profile ratings for user: ${userId}`);
      const ratingsPath = `users/${userId}/profile/ratings`;
      const ratings = await firestore.getDocument(ratingsPath);

      if (ratings) {
        await firestore.deleteDocument(ratingsPath);
        deletedCollections.push('profile/ratings');
        console.log(`[DeleteAccount] Deleted profile ratings`);
      } else {
        console.log(`[DeleteAccount] No profile ratings found, skipping`);
      }
    } catch (error) {
      console.error(`[DeleteAccount] Error deleting profile/ratings:`, error);
      errors.push(`profile/ratings: ${error}`);
    }

    // ========================================
    // 2. DELETE FROM LEADERBOARD COLLECTIONS
    // ========================================

    // Delete from legacy leaderboard
    try {
      console.log(`[DeleteAccount] Deleting from legacy leaderboard`);
      const legacyPath = `leaderboard/${userId}`;
      const legacy = await firestore.getDocument(legacyPath);

      if (legacy) {
        await firestore.deleteDocument(legacyPath);
        deletedCollections.push('leaderboard');
        console.log(`[DeleteAccount] Deleted legacy leaderboard entry`);
      } else {
        console.log(`[DeleteAccount] No legacy leaderboard entry found, skipping`);
      }
    } catch (error) {
      console.error(`[DeleteAccount] Error deleting legacy leaderboard:`, error);
      errors.push(`leaderboard: ${error}`);
    }

    // Delete from mastery leaderboard
    try {
      console.log(`[DeleteAccount] Deleting from mastery leaderboard`);
      const masteryPath = `leaderboards/mastery/players/${userId}`;
      const mastery = await firestore.getDocument(masteryPath);

      if (mastery) {
        await firestore.deleteDocument(masteryPath);
        deletedCollections.push('leaderboards/mastery');
        console.log(`[DeleteAccount] Deleted mastery leaderboard entry`);
      } else {
        console.log(`[DeleteAccount] No mastery leaderboard entry found, skipping`);
      }
    } catch (error) {
      console.error(`[DeleteAccount] Error deleting mastery leaderboard:`, error);
      errors.push(`leaderboards/mastery: ${error}`);
    }

    // Delete from streak leaderboard
    try {
      console.log(`[DeleteAccount] Deleting from streak leaderboard`);
      const streakPath = `leaderboards/streak/players/${userId}`;
      const streak = await firestore.getDocument(streakPath);

      if (streak) {
        await firestore.deleteDocument(streakPath);
        deletedCollections.push('leaderboards/streak');
        console.log(`[DeleteAccount] Deleted streak leaderboard entry`);
      } else {
        console.log(`[DeleteAccount] No streak leaderboard entry found, skipping`);
      }
    } catch (error) {
      console.error(`[DeleteAccount] Error deleting streak leaderboard:`, error);
      errors.push(`leaderboards/streak: ${error}`);
    }

    // Delete from ELO leaderboard
    try {
      console.log(`[DeleteAccount] Deleting from ELO leaderboard`);
      const eloPath = `leaderboards/elo/players/${userId}`;
      const elo = await firestore.getDocument(eloPath);

      if (elo) {
        await firestore.deleteDocument(eloPath);
        deletedCollections.push('leaderboards/elo');
        console.log(`[DeleteAccount] Deleted ELO leaderboard entry`);
      } else {
        console.log(`[DeleteAccount] No ELO leaderboard entry found, skipping`);
      }
    } catch (error) {
      console.error(`[DeleteAccount] Error deleting ELO leaderboard:`, error);
      errors.push(`leaderboards/elo: ${error}`);
    }

    // Delete from tactical leaderboard
    try {
      console.log(`[DeleteAccount] Deleting from tactical leaderboard`);
      const tacticalPath = `leaderboards/tactical/players/${userId}`;
      const tactical = await firestore.getDocument(tacticalPath);

      if (tactical) {
        await firestore.deleteDocument(tacticalPath);
        deletedCollections.push('leaderboards/tactical');
        console.log(`[DeleteAccount] Deleted tactical leaderboard entry`);
      } else {
        console.log(`[DeleteAccount] No tactical leaderboard entry found, skipping`);
      }
    } catch (error) {
      console.error(`[DeleteAccount] Error deleting tactical leaderboard:`, error);
      errors.push(`leaderboards/tactical: ${error}`);
    }

    // ========================================
    // 3. DELETE MAIN USER DOCUMENT (LAST)
    // ========================================

    try {
      console.log(`[DeleteAccount] Deleting main user document`);
      await firestore.deleteDocument(`users/${userId}`);
      deletedCollections.push('users');
      console.log(`[DeleteAccount] Deleted main user document`);
    } catch (error) {
      console.error(`[DeleteAccount] Error deleting main user document:`, error);
      errors.push(`users: ${error}`);
    }

    // ========================================
    // RESPONSE
    // ========================================

    const response: DeleteAccountResponse = {
      success: errors.length === 0,
      deletedCollections,
      message: errors.length === 0
        ? `Successfully deleted all user data for ${userId}`
        : `Deleted ${deletedCollections.length} collections with ${errors.length} errors`,
    };

    if (errors.length > 0) {
      response.errors = errors;
    }

    console.log(
      `[DeleteAccount] Completed for user ${userId}: ${deletedCollections.length} collections deleted, ${errors.length} errors`
    );

    return new Response(JSON.stringify(response), {
      status: errors.length === 0 ? 200 : 207, // 207 Multi-Status for partial success
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error(`[DeleteAccount] Fatal error:`, error);

    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        message: 'Failed to delete user account',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
