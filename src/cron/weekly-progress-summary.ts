/**
 * Weekly Progress Summary Cron Job
 * Runs every Sunday at 6 PM UTC
 *
 * Purpose: Send weekly progress summaries to users who:
 * - Have been active in the past week
 * - Have notifications enabled
 * - Have completed at least one training session
 *
 * Batch size: 500 users per run
 */

import type { FirestoreClient } from '../firestore';
import { TRIGGERS } from '../types/notifications';
import { checkPolicy } from '../utils/policy-engine';
import { sendFCM } from '../utils/fcm';

// ============ MAIN WEEKLY SUMMARY FUNCTION ============

export async function sendWeeklyProgressSummaries(
  firestore: FirestoreClient,
  env: { FIREBASE_PROJECT_ID: string }
): Promise<{
  success: boolean;
  sent: number;
  blocked: number;
  errors: number;
  duration: number;
}> {
  const startTime = Date.now();
  let sent = 0;
  let blocked = 0;
  let errors = 0;

  console.log('[Cron] Starting weekly progress summaries...');

  try {
    // Get users who were active this week
    const activeUsers = await getActiveUsersThisWeek(firestore);

    console.log(`[Cron] Found ${activeUsers.length} active users for weekly summary`);

    // Process in batches of 50
    const batchSize = 50;
    for (let i = 0; i < activeUsers.length; i += batchSize) {
      const batch = activeUsers.slice(i, i + batchSize);

      const results = await Promise.all(
        batch.map((user) => sendWeeklySummary(firestore, user, env))
      );

      // Count results
      for (const result of results) {
        if (result.sent) sent++;
        else if (result.blocked) blocked++;
        else if (result.error) errors++;
      }

      // Small delay between batches
      if (i + batchSize < activeUsers.length) {
        await delay(500);
      }
    }

    const duration = Date.now() - startTime;

    console.log(`[Cron] Weekly progress summaries complete:`);
    console.log(`  - Sent: ${sent}`);
    console.log(`  - Blocked by policy: ${blocked}`);
    console.log(`  - Errors: ${errors}`);
    console.log(`  - Duration: ${duration}ms`);

    return {
      success: true,
      sent,
      blocked,
      errors,
      duration,
    };
  } catch (error) {
    console.error('[Cron] Weekly progress summaries failed:', error);
    return {
      success: false,
      sent,
      blocked,
      errors: errors + 1,
      duration: Date.now() - startTime,
    };
  }
}

// ============ HELPER FUNCTIONS ============

interface ActiveUser {
  userId: string;
  username: string;
  weeklyStats: {
    sessions: number;
    moves: number;
    openingsTrained: number;
    streakDays: number;
    masteryGained: number;
  };
  fcmToken?: string;
}

async function getActiveUsersThisWeek(firestore: FirestoreClient): Promise<ActiveUser[]> {
  const now = new Date();
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const oneWeekAgoStr = oneWeekAgo.toISOString().split('T')[0];

  const activeUsers: ActiveUser[] = [];

  try {
    // Query users who have been active in the past week
    const users = await firestore.queryDocuments('users', [], {
      limit: 2000,
    });

    for (const user of users) {
      const lastSessionDate = user.lastSessionDate || user.lastTrainingDate || '';

      // Skip users who haven't been active this week
      if (!lastSessionDate || lastSessionDate < oneWeekAgoStr) continue;

      // Check if user has notifications enabled for progress
      const prefs = await firestore.getDocument(
        `users/${user.id}/preferences/notifications`
      );

      if (prefs?.enabled === false || prefs?.categories?.progress === false) {
        continue; // User opted out
      }

      // Get weekly stats from user profile or calculate from progress
      const weeklyStats = await calculateWeeklyStats(firestore, user.id, oneWeekAgo);

      // Only send to users who actually trained this week
      if (weeklyStats.sessions === 0) continue;

      activeUsers.push({
        userId: user.id,
        username: user.username || 'Player',
        weeklyStats,
        fcmToken: user.latestFcmToken,
      });
    }
  } catch (error) {
    console.error('[Cron] Error fetching active users:', error);
  }

  return activeUsers;
}

async function calculateWeeklyStats(
  firestore: FirestoreClient,
  userId: string,
  since: Date
): Promise<ActiveUser['weeklyStats']> {
  // Default stats
  const stats: ActiveUser['weeklyStats'] = {
    sessions: 0,
    moves: 0,
    openingsTrained: 0,
    streakDays: 0,
    masteryGained: 0,
  };

  try {
    // Try to get stats from user's weekly stats document
    const weeklyStatsDoc = await firestore.getDocument(`users/${userId}/stats/weekly`);

    if (weeklyStatsDoc) {
      stats.sessions = weeklyStatsDoc.sessionsThisWeek || 0;
      stats.moves = weeklyStatsDoc.movesThisWeek || 0;
      stats.openingsTrained = weeklyStatsDoc.openingsTrainedThisWeek || 0;
      stats.streakDays = weeklyStatsDoc.streakDaysThisWeek || 0;
      stats.masteryGained = weeklyStatsDoc.masteryGainedThisWeek || 0;
    } else {
      // Fallback: estimate from user profile
      const userProfile = await firestore.getDocument(`users/${userId}`);
      if (userProfile) {
        stats.sessions = Math.min(userProfile.totalSessions || 0, 7); // Cap at 7 for weekly
        stats.streakDays = Math.min(userProfile.currentStreak || 0, 7);
      }
    }
  } catch (error) {
    console.error(`[Cron] Error calculating weekly stats for ${userId}:`, error);
  }

  return stats;
}

async function sendWeeklySummary(
  firestore: FirestoreClient,
  user: ActiveUser,
  env: { FIREBASE_PROJECT_ID: string }
): Promise<{ sent?: boolean; blocked?: boolean; error?: boolean }> {
  try {
    const trigger = TRIGGERS.weekly_progress_summary;

    if (!trigger) {
      console.error('[Cron] Missing trigger: weekly_progress_summary');
      return { error: true };
    }

    // Load user preferences
    const userPrefs = await firestore.getDocument(
      `users/${user.userId}/preferences/notifications`
    );

    // Check notification policy
    const policyCheck = await checkPolicy(
      {
        userId: user.userId,
        trigger,
        scheduledTime: new Date(),
        userPreferences: userPrefs || { enabled: true },
      },
      firestore
    );

    if (!policyCheck.allowed) {
      console.log(
        `[Cron] Weekly summary blocked for ${user.userId}: ${policyCheck.reason}`
      );
      return { blocked: true };
    }

    // Select random variant (A/B testing)
    const variant = trigger.variants[Math.floor(Math.random() * trigger.variants.length)];

    // Interpolate message with stats
    const title = variant.title;
    const body = variant.body
      .replace('{sessions}', String(user.weeklyStats.sessions))
      .replace('{moves}', String(user.weeklyStats.moves))
      .replace('{openings}', String(user.weeklyStats.openingsTrained));

    // Create notification ledger entry
    const notificationId = `${Date.now()}_${user.userId}_${Math.random().toString(36).substr(2, 9)}`;
    const now = { _seconds: Math.floor(Date.now() / 1000), _nanoseconds: 0 };

    await firestore.setDocument(`notification_ledger/${notificationId}`, {
      userId: user.userId,
      triggerId: trigger.id,
      category: trigger.category,
      templateId: variant.id,
      experimentVariant: variant.id,
      scheduledAt: now,
      status: 'scheduled',
      metadata: {
        username: user.username,
        weeklyStats: user.weeklyStats,
      },
      deepLink: variant.deepLink,
      title,
      body,
      createdAt: now,
    });

    // Send via FCM if token available
    if (user.fcmToken) {
      const accessToken = await firestore.getAccessToken();

      const result = await sendFCM({
        projectId: env.FIREBASE_PROJECT_ID,
        accessToken,
        fcmToken: user.fcmToken,
        title,
        body,
        deepLink: variant.deepLink,
        trigger,
        metadata: { weeklyStats: user.weeklyStats },
        notificationId,
      });

      if (result.success) {
        // Update ledger with sent status
        await firestore.updateDocument(`notification_ledger/${notificationId}`, {
          status: 'sent',
          sentAt: now,
          fcmMessageId: result.messageId,
        });

        console.log(`[Cron] Sent weekly summary to ${user.userId} (${user.weeklyStats.sessions} sessions)`);
        return { sent: true };
      } else {
        // Update ledger with failed status
        await firestore.updateDocument(`notification_ledger/${notificationId}`, {
          status: 'failed',
          failureReason: result.error,
        });

        console.error(`[Cron] Failed to send weekly summary to ${user.userId}: ${result.error}`);
        return { error: true };
      }
    } else {
      // No FCM token
      await firestore.updateDocument(`notification_ledger/${notificationId}`, {
        status: 'failed',
        failureReason: 'no_fcm_token',
      });

      return { error: true };
    }
  } catch (error) {
    console.error(`[Cron] Error sending weekly summary to ${user.userId}:`, error);
    return { error: true };
  }
}

// ============ UTILITY FUNCTIONS ============

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
