/**
 * Direct Daily Streak Reminders (No Queue - Free Plan Compatible)
 *
 * Processes notifications directly without Cloudflare Queues.
 * Limited to 50 users per cron run to stay within CPU time limits.
 */

import type { FirestoreClient } from '../firestore';
import { TRIGGERS } from '../types/notifications';
import { checkPolicy } from '../utils/policy-engine';
import { sendFCM } from '../utils/fcm';

// Process up to 50 users per cron run (to stay within free tier CPU limits)
const MAX_USERS_PER_RUN = 50;

export async function sendStreakRemindersDirectly(
  firestore: FirestoreClient,
  env: { FIREBASE_PROJECT_ID: string; FIREBASE_SERVICE_ACCOUNT: string }
): Promise<{ processed: number; sent: number; blocked: number; errors: number }> {
  let processed = 0;
  let sent = 0;
  let blocked = 0;
  let errors = 0;

  console.log('[Cron-Direct] Starting daily streak reminders (direct processing)...');

  try {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const trigger = TRIGGERS.daily_streak_reminder;

    // Query users with active streaks (limited to avoid timeout)
    const users = await firestore.queryDocuments('users', [
      { field: 'currentStreak', op: 'GREATER_THAN_OR_EQUAL', value: 3 },
    ]);

    console.log(`[Cron-Direct] Found ${users.length} users with active streaks`);

    // Filter eligible users
    const eligibleUsers = users.filter((user: any) => {
      const lastTrainingDate = user.lastTrainingDate || '';
      return lastTrainingDate !== today && user.latestFcmToken;
    }).slice(0, MAX_USERS_PER_RUN);

    console.log(`[Cron-Direct] Processing ${eligibleUsers.length} eligible users...`);

    // Get access token once for all FCM calls
    const accessToken = await firestore.getAccessToken();

    // Process users sequentially to avoid rate limits
    for (const user of eligibleUsers) {
      try {
        const { _id: userId, username, currentStreak: streak, latestFcmToken: fcmToken } = user as any;

        // Load user preferences
        const userPrefs = await firestore.getDocument(
          `users/${userId}/preferences/notifications`
        );

        // Check if user has notifications enabled
        if (userPrefs?.enabled === false || userPrefs?.categories?.streaks === false) {
          console.log(`[Cron-Direct] User ${userId} has notifications disabled`);
          blocked++;
          processed++;
          continue;
        }

        // Check notification policy
        const policyCheck = await checkPolicy(
          {
            userId,
            trigger,
            scheduledTime: new Date(),
            userPreferences: userPrefs || { enabled: true },
          },
          firestore
        );

        if (!policyCheck.allowed) {
          console.log(`[Cron-Direct] Notification blocked for ${userId}: ${policyCheck.reason}`);
          blocked++;
          processed++;
          continue;
        }

        // Select random variant (A/B testing)
        const variant = trigger.variants[Math.floor(Math.random() * trigger.variants.length)];

        // Interpolate message
        const title = variant.title.replace(/\{(\w+)\}/g, (_, key) => {
          return key === 'streak' ? String(streak) : '';
        });
        const body = variant.body.replace(/\{(\w+)\}/g, (_, key) => {
          return key === 'streak' ? String(streak) : '';
        });

        // Create notification ledger entry
        const notificationId = `${Date.now()}_${userId}_${Math.random().toString(36).substr(2, 9)}`;
        const now = { _seconds: Math.floor(Date.now() / 1000), _nanoseconds: 0 };

        await firestore.setDocument(`notification_ledger/${notificationId}`, {
          userId,
          triggerId: trigger.id,
          category: trigger.category,
          templateId: variant.id,
          experimentVariant: variant.id,
          scheduledAt: now,
          status: 'scheduled',
          metadata: { streak, username: username || 'Player', isTransactional: trigger.isTransactional },
          deepLink: 'checkmatex://training',
          title,
          body,
          createdAt: now,
        });

        // Send via FCM
        const result = await sendFCM({
          projectId: env.FIREBASE_PROJECT_ID,
          accessToken,
          fcmToken,
          title,
          body,
          deepLink: 'checkmatex://training',
          trigger,
          metadata: { streak, username: username || 'Player' },
          notificationId,
        });

        if (result.success) {
          await firestore.updateDocument(`notification_ledger/${notificationId}`, {
            status: 'sent',
            sentAt: now,
            fcmMessageId: result.messageId,
          });

          console.log(`[Cron-Direct] Sent streak reminder to ${userId} (streak: ${streak})`);
          sent++;
        } else {
          await firestore.updateDocument(`notification_ledger/${notificationId}`, {
            status: 'failed',
            failureReason: result.error,
          });

          console.error(`[Cron-Direct] Failed to send to ${userId}: ${result.error}`);
          errors++;
        }

        processed++;
      } catch (error) {
        console.error(`[Cron-Direct] Error processing user:`, error);
        errors++;
        processed++;
      }
    }

    console.log(`[Cron-Direct] Daily reminders complete: ${processed} processed, ${sent} sent, ${blocked} blocked, ${errors} errors`);

    return { processed, sent, blocked, errors };
  } catch (error) {
    console.error('[Cron-Direct] Daily reminders failed:', error);
    return { processed, sent, blocked, errors };
  }
}

export async function sendLastChanceRemindersDirectly(
  firestore: FirestoreClient,
  env: { FIREBASE_PROJECT_ID: string; FIREBASE_SERVICE_ACCOUNT: string }
): Promise<{ processed: number; sent: number; blocked: number; errors: number }> {
  let processed = 0;
  let sent = 0;
  let blocked = 0;
  let errors = 0;

  console.log('[Cron-Direct] Starting last-chance streak reminders (direct processing)...');

  try {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const trigger = TRIGGERS.last_chance_streak_save;

    // Query users with active streaks (limited to avoid timeout)
    const users = await firestore.queryDocuments('users', [
      { field: 'currentStreak', op: 'GREATER_THAN_OR_EQUAL', value: 3 },
    ]);

    console.log(`[Cron-Direct] Found ${users.length} users with active streaks`);

    // Filter eligible users (haven't trained today, have FCM token)
    const eligibleUsers = users.filter((user: any) => {
      const lastTrainingDate = user.lastTrainingDate || '';
      return lastTrainingDate !== today && user.latestFcmToken;
    }).slice(0, MAX_USERS_PER_RUN);

    console.log(`[Cron-Direct] Processing ${eligibleUsers.length} eligible users for last-chance...`);

    // Get access token once for all FCM calls
    const accessToken = await firestore.getAccessToken();

    // Process users sequentially
    for (const user of eligibleUsers) {
      try {
        const { _id: userId, username, currentStreak: streak, latestFcmToken: fcmToken } = user as any;

        // Load user preferences
        const userPrefs = await firestore.getDocument(
          `users/${userId}/preferences/notifications`
        );

        // Check if user has notifications enabled
        if (userPrefs?.enabled === false || userPrefs?.categories?.streaks === false) {
          console.log(`[Cron-Direct] User ${userId} has notifications disabled`);
          blocked++;
          processed++;
          continue;
        }

        // For last-chance, we bypass normal cooldown checks (isTransactional = true)
        // But still check daily caps and quiet hours
        const policyCheck = await checkPolicy(
          {
            userId,
            trigger,
            scheduledTime: new Date(),
            userPreferences: userPrefs || { enabled: true },
          },
          firestore
        );

        if (!policyCheck.allowed) {
          console.log(`[Cron-Direct] Last-chance blocked for ${userId}: ${policyCheck.reason}`);
          blocked++;
          processed++;
          continue;
        }

        // Select random variant
        const variant = trigger.variants[Math.floor(Math.random() * trigger.variants.length)];

        // Interpolate message
        const title = variant.title.replace(/\{(\w+)\}/g, (_, key) => {
          return key === 'streak' ? String(streak) : '';
        });
        const body = variant.body.replace(/\{(\w+)\}/g, (_, key) => {
          return key === 'streak' ? String(streak) : '';
        });

        // Create notification ledger entry
        const notificationId = `${Date.now()}_${userId}_${Math.random().toString(36).substr(2, 9)}`;
        const now = { _seconds: Math.floor(Date.now() / 1000), _nanoseconds: 0 };

        await firestore.setDocument(`notification_ledger/${notificationId}`, {
          userId,
          triggerId: trigger.id,
          category: trigger.category,
          templateId: variant.id,
          experimentVariant: variant.id,
          scheduledAt: now,
          status: 'scheduled',
          metadata: { streak, username: username || 'Player', isTransactional: trigger.isTransactional },
          deepLink: 'checkmatex://training',
          title,
          body,
          createdAt: now,
        });

        // Send via FCM
        const result = await sendFCM({
          projectId: env.FIREBASE_PROJECT_ID,
          accessToken,
          fcmToken,
          title,
          body,
          deepLink: 'checkmatex://training',
          trigger,
          metadata: { streak, username: username || 'Player' },
          notificationId,
        });

        if (result.success) {
          await firestore.updateDocument(`notification_ledger/${notificationId}`, {
            status: 'sent',
            sentAt: now,
            fcmMessageId: result.messageId,
          });

          console.log(`[Cron-Direct] Sent last-chance reminder to ${userId} (streak: ${streak})`);
          sent++;
        } else {
          await firestore.updateDocument(`notification_ledger/${notificationId}`, {
            status: 'failed',
            failureReason: result.error,
          });

          console.error(`[Cron-Direct] Failed to send last-chance to ${userId}: ${result.error}`);
          errors++;
        }

        processed++;
      } catch (error) {
        console.error(`[Cron-Direct] Error processing user for last-chance:`, error);
        errors++;
        processed++;
      }
    }

    console.log(`[Cron-Direct] Last-chance reminders complete: ${processed} processed, ${sent} sent, ${blocked} blocked, ${errors} errors`);

    return { processed, sent, blocked, errors };
  } catch (error) {
    console.error('[Cron-Direct] Last-chance reminders failed:', error);
    return { processed, sent, blocked, errors };
  }
}

export async function cleanupLeaderboardsDirectly(
  firestore: FirestoreClient
): Promise<{ processed: number; removed: number; errors: number }> {
  let processed = 0;
  let removed = 0;
  let errors = 0;

  console.log('[Cron-Direct] Starting leaderboard cleanup (direct processing)...');

  try {
    // Get all leaderboard entries
    const eloEntries = await firestore.queryDocuments('leaderboards/elo/players', []);
    const tacticalEntries = await firestore.queryDocuments('leaderboards/tactical/players', []);

    console.log(`[Cron-Direct] Found ${eloEntries.length} ELO entries, ${tacticalEntries.length} tactical entries`);

    // Check each entry against user existence
    for (const entry of eloEntries.slice(0, MAX_USERS_PER_RUN)) {
      try {
        const userId = (entry as any)._id;
        const userDoc = await firestore.getDocument(`users/${userId}`);

        if (!userDoc) {
          // User doesn't exist, remove from leaderboard
          await firestore.deleteDocument(`leaderboards/elo/players/${userId}`);
          console.log(`[Cron-Direct] Removed deleted user ${userId} from ELO leaderboard`);
          removed++;
        }
        processed++;
      } catch (error) {
        console.error(`[Cron-Direct] Error checking leaderboard entry:`, error);
        errors++;
        processed++;
      }
    }

    console.log(`[Cron-Direct] Leaderboard cleanup complete: ${processed} processed, ${removed} removed, ${errors} errors`);

    return { processed, removed, errors };
  } catch (error) {
    console.error('[Cron-Direct] Leaderboard cleanup failed:', error);
    return { processed, removed, errors };
  }
}
