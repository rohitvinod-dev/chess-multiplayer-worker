/**
 * Win-Back Notifications Cron Job
 * Runs daily at 10 AM UTC
 *
 * Purpose: Re-engage inactive users who:
 * - Haven't opened the app in 3, 7, or 14 days
 * - Have notifications enabled
 * - Haven't received a win-back notification recently
 *
 * Batch size: 500 users per run
 */

import type { FirestoreClient } from '../firestore';
import { TRIGGERS } from '../types/notifications';
import { checkPolicy } from '../utils/policy-engine';
import { sendFCM } from '../utils/fcm';

// ============ MAIN WIN-BACK FUNCTION ============

export async function sendWinBackNotifications(
  firestore: FirestoreClient,
  env: { FIREBASE_PROJECT_ID: string }
): Promise<{
  success: boolean;
  sent: number;
  blocked: number;
  errors: number;
  duration: number;
  breakdown: { day3: number; day7: number; day14: number };
}> {
  const startTime = Date.now();
  let sent = 0;
  let blocked = 0;
  let errors = 0;
  const breakdown = { day3: 0, day7: 0, day14: 0 };

  console.log('[Cron] Starting win-back notifications...');

  try {
    // Get inactive users in different tiers
    const inactiveUsers = await getInactiveUsers(firestore);

    console.log(`[Cron] Found inactive users: 3-day: ${inactiveUsers.day3.length}, 7-day: ${inactiveUsers.day7.length}, 14-day: ${inactiveUsers.day14.length}`);

    // Process each tier
    for (const tier of ['day3', 'day7', 'day14'] as const) {
      const users = inactiveUsers[tier];
      const triggerId = `win_back_${tier.replace('day', '')}_days`;
      const trigger = TRIGGERS[triggerId];

      if (!trigger) {
        console.error(`[Cron] Missing trigger: ${triggerId}`);
        continue;
      }

      // Process in batches of 50
      const batchSize = 50;
      for (let i = 0; i < users.length; i += batchSize) {
        const batch = users.slice(i, i + batchSize);

        const results = await Promise.all(
          batch.map((user) => sendWinBackNotification(firestore, user, trigger, env))
        );

        // Count results
        for (const result of results) {
          if (result.sent) {
            sent++;
            breakdown[tier]++;
          } else if (result.blocked) {
            blocked++;
          } else if (result.error) {
            errors++;
          }
        }

        // Small delay between batches
        if (i + batchSize < users.length) {
          await delay(500);
        }
      }
    }

    const duration = Date.now() - startTime;

    console.log(`[Cron] Win-back notifications complete:`);
    console.log(`  - Total sent: ${sent}`);
    console.log(`  - Breakdown: 3-day: ${breakdown.day3}, 7-day: ${breakdown.day7}, 14-day: ${breakdown.day14}`);
    console.log(`  - Blocked by policy: ${blocked}`);
    console.log(`  - Errors: ${errors}`);
    console.log(`  - Duration: ${duration}ms`);

    return {
      success: true,
      sent,
      blocked,
      errors,
      duration,
      breakdown,
    };
  } catch (error) {
    console.error('[Cron] Win-back notifications failed:', error);
    return {
      success: false,
      sent,
      blocked,
      errors: errors + 1,
      duration: Date.now() - startTime,
      breakdown,
    };
  }
}

// ============ HELPER FUNCTIONS ============

interface InactiveUser {
  userId: string;
  username: string;
  lastSessionDate: string; // YYYY-MM-DD
  daysSinceLastSession: number;
  fcmToken?: string;
}

interface InactiveUsersByTier {
  day3: InactiveUser[];
  day7: InactiveUser[];
  day14: InactiveUser[];
}

async function getInactiveUsers(firestore: FirestoreClient): Promise<InactiveUsersByTier> {
  const now = new Date();
  const today = now.toISOString().split('T')[0];

  // Calculate date thresholds
  const day3Date = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const day7Date = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const day14Date = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const day21Date = new Date(now.getTime() - 21 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const result: InactiveUsersByTier = {
    day3: [],
    day7: [],
    day14: [],
  };

  try {
    // Query users who have been inactive (lastSessionDate is older)
    // We'll fetch all users and filter client-side for flexibility
    const users = await firestore.queryDocuments('users', [], {
      limit: 2000, // Reasonable limit per cron run
    });

    for (const user of users) {
      const lastSessionDate = user.lastSessionDate || user.lastTrainingDate || '';

      // Skip users who were active today or recently
      if (!lastSessionDate || lastSessionDate >= today) continue;

      // Calculate days since last session
      const lastDate = new Date(lastSessionDate);
      const daysSince = Math.floor((now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));

      // Check if user has notifications enabled and hasn't received win-back recently
      const prefs = await firestore.getDocument(
        `users/${user.id}/preferences/notifications`
      );

      if (prefs?.enabled === false || prefs?.categories?.win_back === false) {
        continue; // User opted out
      }

      // Check if they already received a win-back notification in the last 7 days
      const alreadyNotified = await checkWinBackCooldown(firestore, user.id);
      if (alreadyNotified) continue;

      const inactiveUser: InactiveUser = {
        userId: user.id,
        username: user.username || 'Player',
        lastSessionDate,
        daysSinceLastSession: daysSince,
        fcmToken: user.latestFcmToken,
      };

      // Categorize by inactivity tier (exact day matching for targeted messaging)
      if (daysSince === 3) {
        result.day3.push(inactiveUser);
      } else if (daysSince === 7) {
        result.day7.push(inactiveUser);
      } else if (daysSince === 14) {
        result.day14.push(inactiveUser);
      }
    }
  } catch (error) {
    console.error('[Cron] Error fetching inactive users:', error);
  }

  return result;
}

async function checkWinBackCooldown(
  firestore: FirestoreClient,
  userId: string
): Promise<boolean> {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const sevenDaysAgoSeconds = Math.floor(sevenDaysAgo.getTime() / 1000);

  try {
    const notifications = await firestore.queryDocuments('notification_ledger', [
      { field: 'userId', op: 'EQUAL', value: userId },
      { field: 'category', op: 'EQUAL', value: 'win_back' },
      { field: 'sentAt._seconds', op: 'GREATER_THAN_OR_EQUAL', value: sevenDaysAgoSeconds },
      { field: 'status', op: 'EQUAL', value: 'sent' },
    ]);

    return notifications.length > 0;
  } catch (error) {
    // If error, allow notification (err on side of engagement)
    return false;
  }
}

async function sendWinBackNotification(
  firestore: FirestoreClient,
  user: InactiveUser,
  trigger: typeof TRIGGERS[string],
  env: { FIREBASE_PROJECT_ID: string }
): Promise<{ sent?: boolean; blocked?: boolean; error?: boolean }> {
  try {
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
        `[Cron] Win-back notification blocked for ${user.userId}: ${policyCheck.reason}`
      );
      return { blocked: true };
    }

    // Select random variant (A/B testing)
    const variant = trigger.variants[Math.floor(Math.random() * trigger.variants.length)];

    // Interpolate message
    const title = variant.title;
    const body = variant.body;

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
        daysSinceLastSession: user.daysSinceLastSession,
        username: user.username,
        lastSessionDate: user.lastSessionDate,
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
        metadata: { daysSinceLastSession: user.daysSinceLastSession },
        notificationId,
      });

      if (result.success) {
        // Update ledger with sent status
        await firestore.updateDocument(`notification_ledger/${notificationId}`, {
          status: 'sent',
          sentAt: now,
          fcmMessageId: result.messageId,
        });

        console.log(`[Cron] Sent win-back to ${user.userId} (${user.daysSinceLastSession} days inactive)`);
        return { sent: true };
      } else {
        // Update ledger with failed status
        await firestore.updateDocument(`notification_ledger/${notificationId}`, {
          status: 'failed',
          failureReason: result.error,
        });

        console.error(`[Cron] Failed to send win-back to ${user.userId}: ${result.error}`);
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
    console.error(`[Cron] Error sending win-back to ${user.userId}:`, error);
    return { error: true };
  }
}

// ============ UTILITY FUNCTIONS ============

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
