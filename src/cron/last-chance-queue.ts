/**
 * SCALABLE Last-Chance Streak Saver Cron Job (Queue-Based)
 * Runs at 9 PM UTC daily (3 hours before midnight)
 *
 * This lightweight cron job enqueues users at risk of losing their streaks.
 * The actual notification sending is handled by the queue consumer in parallel batches.
 *
 * Scalability: Can handle MILLIONS of users!
 */

import type { FirestoreClient } from '../firestore';
import { TRIGGERS } from '../types/notifications';
import { checkPolicy } from '../utils/policy-engine';
import { sendFCM } from '../utils/fcm';

// ============ LIGHTWEIGHT CRON JOB (Enqueue Only) ============

export async function enqueueLastChanceReminders(
  firestore: FirestoreClient,
  lastChanceQueue: Queue
): Promise<{
  success: boolean;
  enqueued: number;
  duration: number;
}> {
  const startTime = Date.now();
  let enqueued = 0;

  console.log('[Cron] Starting last-chance streak savers enqueue...');

  try {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    // Query users with active streaks (NO LIMIT!)
    const users = await firestore.queryDocuments('users', [
      { field: 'currentStreak', op: 'GREATER_THAN_OR_EQUAL', value: 3 },
    ]);

    console.log(`[Cron] Found ${users.length} users with active streaks`);

    // Filter and prepare queue messages
    const messages: QueueMessage[] = [];

    for (const user of users) {
      const lastTrainingDate = user.lastTrainingDate || '';

      // CRITICAL: Only enqueue users who STILL haven't trained today
      if (lastTrainingDate !== today) {
        messages.push({
          body: {
            userId: user.id,
            username: user.username || 'Player',
            streak: user.currentStreak || 0,
            fcmToken: user.latestFcmToken,
            lastTrainingDate,
          },
        });
      }
    }

    console.log(`[Cron] ${messages.length} users at risk of losing streaks`);

    // Send to queue in batches of 1000
    for (let i = 0; i < messages.length; i += 1000) {
      const batch = messages.slice(i, i + 1000);
      await lastChanceQueue.sendBatch(batch);
      enqueued += batch.length;

      console.log(`[Cron] Enqueued ${enqueued}/${messages.length} users...`);
    }

    const duration = Date.now() - startTime;

    console.log(`[Cron] Last-chance reminders enqueue complete:`);
    console.log(`  - Total enqueued: ${enqueued} users`);
    console.log(`  - Duration: ${duration}ms`);

    return {
      success: true,
      enqueued,
      duration,
    };
  } catch (error) {
    console.error('[Cron] Last-chance enqueue failed:', error);
    return {
      success: false,
      enqueued,
      duration: Date.now() - startTime,
    };
  }
}

// ============ QUEUE MESSAGE TYPES ============

interface QueueMessage {
  body: {
    userId: string;
    username: string;
    streak: number;
    fcmToken?: string;
    lastTrainingDate: string;
  };
}

// ============ QUEUE CONSUMER (Actual Notification Processing) ============

export async function processLastChanceBatch(
  batch: MessageBatch<QueueMessage['body']>,
  firestore: FirestoreClient,
  env: { FIREBASE_PROJECT_ID: string }
): Promise<{ processed: number; sent: number; blocked: number; errors: number }> {
  let processed = 0;
  let sent = 0;
  let blocked = 0;
  let errors = 0;

  console.log(`[Queue] Processing last-chance batch of ${batch.messages.length} users...`);

  const trigger = TRIGGERS.last_chance_streak_save;

  // Process all messages in parallel
  await Promise.all(
    batch.messages.map(async (message) => {
      try {
        const { userId, username, streak, fcmToken } = message.body;

        // Load user preferences
        const userPrefs = await firestore.getDocument(
          `users/${userId}/preferences/notifications`
        );

        // Check if user has notifications enabled
        if (userPrefs?.enabled === false || userPrefs?.categories?.streaks === false) {
          console.log(`[Queue] User ${userId} has notifications disabled`);
          blocked++;
          message.ack();
          return;
        }

        // Check if already notified today (deduplication)
        const alreadyNotified = await checkIfNotifiedToday(firestore, userId);
        if (alreadyNotified) {
          console.log(`[Queue] User ${userId} already notified today`);
          blocked++;
          message.ack();
          return;
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
          console.log(`[Queue] Notification blocked for ${userId}: ${policyCheck.reason}`);
          blocked++;
          message.ack();
          return;
        }

        // Use single variant (no A/B testing for urgent notifications)
        const variant = trigger.variants[0];

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
          metadata: { streak, username, isLastChance: true, isTransactional: trigger.isTransactional },
          deepLink: 'checkmatex://training',
          title,
          body,
          createdAt: now,
        });

        // Send via FCM if token available
        if (fcmToken) {
          const accessToken = await firestore.getAccessToken();

          const result = await sendFCM({
            projectId: env.FIREBASE_PROJECT_ID,
            accessToken,
            fcmToken,
            title,
            body,
            deepLink: 'checkmatex://training',
            trigger,
            metadata: { streak, username, isLastChance: true },
            notificationId,
          });

          if (result.success) {
            await firestore.updateDocument(`notification_ledger/${notificationId}`, {
              status: 'sent',
              sentAt: now,
              fcmMessageId: result.messageId,
            });

            console.log(`[Queue] 🔥 URGENT: Sent last-chance to ${userId} (${streak}-day streak at risk!)`);
            sent++;
          } else {
            await firestore.updateDocument(`notification_ledger/${notificationId}`, {
              status: 'failed',
              failureReason: result.error,
            });

            console.error(`[Queue] Failed to send last-chance to ${userId}: ${result.error}`);
            errors++;
          }
        } else {
          await firestore.updateDocument(`notification_ledger/${notificationId}`, {
            status: 'failed',
            failureReason: 'no_fcm_token',
          });

          errors++;
        }

        processed++;
        message.ack(); // Mark as successfully processed
      } catch (error) {
        console.error(`[Queue] Error processing user:`, error);
        errors++;
        message.retry(); // Retry up to 3 times
      }
    })
  );

  console.log(`[Queue] Batch complete: ${processed} processed, ${sent} sent, ${blocked} blocked, ${errors} errors`);

  return { processed, sent, blocked, errors };
}

// ============ HELPER FUNCTIONS ============

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
    console.error('[Queue] Error checking notifications:', error);
    return false; // If error, assume not notified (err on side of sending)
  }
}
