/**
 * Last Chance Streak Saver Cron Job
 * Runs at 9 PM UTC daily (3 hours before midnight UTC)
 *
 * Purpose: Send urgent reminders to users who:
 * - Have an active streak (3+ days)
 * - STILL haven't trained today
 * - Haven't received a notification today
 * - Have notifications enabled
 *
 * This is a high-priority, transactional notification that bypasses cooldowns
 *
 * Batch size: 1000 users per run
 */

import type { FirestoreClient } from '../firestore';
import { TRIGGERS } from '../types/notifications';
import { checkPolicy } from '../utils/policy-engine';
import { sendFCM } from '../utils/fcm';

// ============ MAIN LAST-CHANCE FUNCTION ============

export async function sendLastChanceStreakSavers(
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

  console.log('[Cron] Starting last-chance streak savers...');

  try {
    // Get users who still haven't trained today and have active streaks
    const eligibleUsers = await getLastChanceUsers(firestore);

    console.log(`[Cron] Found ${eligibleUsers.length} users at risk of losing streaks`);

    // Process in batches of 100
    const batchSize = 100;
    for (let i = 0; i < eligibleUsers.length; i += batchSize) {
      const batch = eligibleUsers.slice(i, i + batchSize);

      const results = await Promise.all(
        batch.map((user) => sendLastChanceNotification(firestore, user, env))
      );

      // Count results
      for (const result of results) {
        if (result.sent) sent++;
        else if (result.blocked) blocked++;
        else if (result.error) errors++;
      }

      // Small delay between batches
      if (i + batchSize < eligibleUsers.length) {
        await delay(1000);
      }
    }

    const duration = Date.now() - startTime;

    console.log(`[Cron] Last-chance notifications complete:`);
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
    console.error('[Cron] Last-chance reminders failed:', error);
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

interface LastChanceUser {
  userId: string;
  username: string;
  streak: number;
  lastTrainingDate: string; // YYYY-MM-DD
  fcmToken?: string;
}

async function getLastChanceUsers(firestore: FirestoreClient): Promise<LastChanceUser[]> {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const eligibleUsers: LastChanceUser[] = [];

  try {
    // Query users with streaks >= 3
    const users = await firestore.queryDocuments('users', [
      { field: 'currentStreak', op: 'GREATER_THAN_OR_EQUAL', value: 3 },
    ], {
      limit: 1000,
    });

    for (const user of users) {
      const lastTrainingDate = user.lastTrainingDate || '';

      // CRITICAL: Only target users who STILL haven't trained today
      if (lastTrainingDate !== today) {
        // Check if user has notifications enabled
        const prefs = await firestore.getDocument(
          `users/${user.id}/preferences/notifications`
        );

        if (prefs?.enabled !== false && prefs?.categories?.streaks !== false) {
          // Check if they already received a notification today
          // (avoid spamming if they got the morning reminder)
          const alreadyNotified = await checkIfNotifiedToday(firestore, user.id);

          if (!alreadyNotified) {
            eligibleUsers.push({
              userId: user.id,
              username: user.username || 'Player',
              streak: user.currentStreak || 0,
              lastTrainingDate,
              fcmToken: user.latestFcmToken,
            });
          }
        }
      }
    }
  } catch (error) {
    console.error('[Cron] Error fetching last-chance users:', error);
  }

  return eligibleUsers;
}

async function checkIfNotifiedToday(
  firestore: FirestoreClient,
  userId: string
): Promise<boolean> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayStartSeconds = Math.floor(todayStart.getTime() / 1000);

  try {
    const notifications = await firestore.queryDocuments('notification_ledger', [
      { field: 'userId', op: 'EQUAL', value: userId },
      { field: 'sentAt._seconds', op: 'GREATER_THAN_OR_EQUAL', value: todayStartSeconds },
      { field: 'status', op: 'EQUAL', value: 'sent' },
    ]);

    return notifications.length > 0;
  } catch (error) {
    console.error('[Cron] Error checking notifications:', error);
    return false; // If error, assume not notified (err on side of sending)
  }
}

async function sendLastChanceNotification(
  firestore: FirestoreClient,
  user: LastChanceUser,
  env: { FIREBASE_PROJECT_ID: string }
): Promise<{ sent?: boolean; blocked?: boolean; error?: boolean }> {
  try {
    const trigger = TRIGGERS.last_chance_streak_save;

    // Load user preferences
    const userPrefs = await firestore.getDocument(
      `users/${user.userId}/preferences/notifications`
    );

    // Check notification policy
    // Note: This is a transactional notification, so it should bypass cooldowns
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
        `[Cron] Last-chance notification blocked for ${user.userId}: ${policyCheck.reason}`
      );
      return { blocked: true };
    }

    // Use the single variant (no A/B testing for urgent notifications)
    const variant = trigger.variants[0];

    // Interpolate message
    const title = variant.title.replace(/\{(\w+)\}/g, (_, key) => {
      return key === 'streak' ? String(user.streak) : '';
    });
    const body = variant.body.replace(/\{(\w+)\}/g, (_, key) => {
      return key === 'streak' ? String(user.streak) : '';
    });

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
      metadata: { streak: user.streak, username: user.username, isLastChance: true },
      deepLink: 'checkmatex://training',
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
        deepLink: 'checkmatex://training',
        trigger,
        metadata: { streak: user.streak, username: user.username, isLastChance: true },
        notificationId,
      });

      if (result.success) {
        // Update ledger
        await firestore.updateDocument(`notification_ledger/${notificationId}`, {
          status: 'sent',
          sentAt: now,
          fcmMessageId: result.messageId,
        });

        console.log(
          `[Cron] 🔥 URGENT: Sent last-chance reminder to ${user.userId} (${user.streak}-day streak at risk!)`
        );
        return { sent: true };
      } else {
        // Update ledger with failure
        await firestore.updateDocument(`notification_ledger/${notificationId}`, {
          status: 'failed',
          failureReason: result.error,
        });

        console.error(`[Cron] Failed to send last-chance to ${user.userId}: ${result.error}`);
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
    console.error(`[Cron] Error sending last-chance to ${user.userId}:`, error);
    return { error: true };
  }
}

// ============ UTILITY FUNCTIONS ============

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate hours until UTC midnight
 * Useful for showing "X hours left" in notification
 */
export function getHoursUntilMidnightUTC(): number {
  const now = new Date();
  const midnight = new Date();
  midnight.setUTCHours(24, 0, 0, 0);
  const hoursLeft = (midnight.getTime() - now.getTime()) / (1000 * 60 * 60);
  return Math.ceil(hoursLeft);
}
