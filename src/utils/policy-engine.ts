/**
 * Notification Policy Engine
 *
 * Implements:
 * - Frequency caps (daily limits)
 * - Quiet hours enforcement
 * - Cooldown periods between notifications
 * - Category-based opt-outs
 * - Temporary mute handling
 *
 * Ported from: OpeningsTrainer/functions/notifications/policyEngine.js
 */

import type {
  PolicyCheckParams,
  PolicyCheckResult,
  UserNotificationPreferences,
  NotificationTrigger,
} from '../types/notifications';
import { POLICY_CONFIG } from '../types/notifications';
import type { FirestoreClient } from '../firestore';

/**
 * Check if notification sending is allowed based on all policy rules
 */
export async function checkPolicy(
  params: PolicyCheckParams,
  firestore: FirestoreClient
): Promise<PolicyCheckResult> {
  const { userId, trigger, userPrefs, scheduledTime } = params;

  // 1. Check global opt-out
  if (!userPrefs.enabled) {
    return {
      allowed: false,
      reason: 'notifications_disabled',
    };
  }

  // 2. Check temporary mute
  if (userPrefs.muteTemporarily && userPrefs.muteUntil) {
    if (scheduledTime < userPrefs.muteUntil) {
      return {
        allowed: false,
        reason: 'temporarily_muted',
      };
    }
  }

  // 3. Check category opt-out
  const categoryEnabled = userPrefs.categories[trigger.category] ?? true;
  if (!categoryEnabled) {
    return {
      allowed: false,
      reason: `category_disabled_${trigger.category}`,
    };
  }

  // 4. Check quiet hours
  const quietHoursResult = checkQuietHours(scheduledTime, userPrefs);
  if (!quietHoursResult.allowed) {
    return quietHoursResult;
  }

  // 5. Check daily caps
  const dailyCapResult = await checkDailyCaps(userId, trigger, userPrefs, firestore);
  if (!dailyCapResult.allowed) {
    return dailyCapResult;
  }

  // 6. Check cooldowns
  const cooldownResult = await checkCooldown(userId, trigger, userPrefs, firestore);
  if (!cooldownResult.allowed) {
    return cooldownResult;
  }

  // All checks passed
  return {
    allowed: true,
  };
}

/**
 * Check if scheduled time falls within quiet hours
 */
function checkQuietHours(
  scheduledTime: Date,
  userPrefs: UserNotificationPreferences
): PolicyCheckResult {
  if (!userPrefs.quietHoursEnabled) {
    return { allowed: true };
  }

  const hour = scheduledTime.getHours();
  const quietStart = userPrefs.quietHoursStart ?? POLICY_CONFIG.DEFAULT_QUIET_START;
  const quietEnd = userPrefs.quietHoursEnd ?? POLICY_CONFIG.DEFAULT_QUIET_END;

  let inQuietHours = false;

  if (quietStart < quietEnd) {
    // Normal case: 22:00 - 8:00
    inQuietHours = hour >= quietStart || hour < quietEnd;
  } else {
    // Wraps around midnight: 8:00 - 22:00 (inverted)
    inQuietHours = hour >= quietStart && hour < quietEnd;
  }

  if (inQuietHours) {
    return {
      allowed: false,
      reason: 'quiet_hours',
      details: { hour, quietStart, quietEnd },
    };
  }

  return { allowed: true };
}

/**
 * Check daily notification caps
 */
async function checkDailyCaps(
  userId: string,
  trigger: NotificationTrigger,
  userPrefs: UserNotificationPreferences,
  firestore: FirestoreClient
): Promise<PolicyCheckResult> {
  const today = getStartOfDay(new Date());
  const todaySeconds = Math.floor(today.getTime() / 1000);

  // Query notification ledger for today's sent notifications
  const todaysNotifications = await firestore.queryDocuments('notification_ledger', [
    { field: 'userId', op: 'EQUAL', value: userId },
    { field: 'sentAt._seconds', op: 'GREATER_THAN_OR_EQUAL', value: todaySeconds },
    { field: 'status', op: 'EQUAL', value: 'sent' },
  ]);

  // Count by category
  const transactionalCount = todaysNotifications.filter(
    (n: any) => n.metadata?.isTransactional === true
  ).length;
  const habitCount = todaysNotifications.filter(
    (n: any) => n.category === 'streaks'
  ).length;
  const totalCount = todaysNotifications.length;

  // Apply frequency multiplier
  const frequencyMultiplier = POLICY_CONFIG.FREQUENCY_MULTIPLIERS[userPrefs.frequency || 'normal'];
  const adjustedMaxTotal = Math.floor(POLICY_CONFIG.MAX_TOTAL_PER_DAY * frequencyMultiplier);

  // Check caps
  if (trigger.isTransactional && transactionalCount >= POLICY_CONFIG.MAX_TRANSACTIONAL_PER_DAY) {
    return {
      allowed: false,
      reason: 'daily_cap_transactional',
      details: { count: transactionalCount, max: POLICY_CONFIG.MAX_TRANSACTIONAL_PER_DAY },
    };
  }

  if (trigger.category === 'streaks' && habitCount >= POLICY_CONFIG.MAX_HABIT_PER_DAY) {
    return {
      allowed: false,
      reason: 'daily_cap_habit',
      details: { count: habitCount, max: POLICY_CONFIG.MAX_HABIT_PER_DAY },
    };
  }

  if (totalCount >= adjustedMaxTotal) {
    return {
      allowed: false,
      reason: 'daily_cap_total',
      details: { count: totalCount, max: adjustedMaxTotal },
    };
  }

  return { allowed: true };
}

/**
 * Check cooldown period between notifications
 */
async function checkCooldown(
  userId: string,
  trigger: NotificationTrigger,
  userPrefs: UserNotificationPreferences,
  firestore: FirestoreClient
): Promise<PolicyCheckResult> {
  // Transactional notifications (achievements, level-ups) bypass cooldown
  if (trigger.isTransactional) {
    return { allowed: true };
  }

  const frequencyMultiplier = POLICY_CONFIG.FREQUENCY_MULTIPLIERS[userPrefs.frequency || 'normal'];
  const cooldownHours = POLICY_CONFIG.MIN_COOLDOWN_BETWEEN_NOTIFICATIONS / frequencyMultiplier;
  const cooldownMs = cooldownHours * 60 * 60 * 1000;
  const cutoffTime = new Date(Date.now() - cooldownMs);
  const cutoffSeconds = Math.floor(cutoffTime.getTime() / 1000);

  // Query for recent non-transactional notifications
  const recentNotifications = await firestore.queryDocuments('notification_ledger', [
    { field: 'userId', op: 'EQUAL', value: userId },
    { field: 'sentAt._seconds', op: 'GREATER_THAN_OR_EQUAL', value: cutoffSeconds },
    { field: 'status', op: 'EQUAL', value: 'sent' },
  ]);

  const recentNonTransactional = recentNotifications.filter(
    (n: any) => n.metadata?.isTransactional !== true
  );

  if (recentNonTransactional.length > 0) {
    return {
      allowed: false,
      reason: 'cooldown_active',
      details: {
        cooldownHours,
        lastSentAt: recentNonTransactional[0].sentAt,
      },
    };
  }

  return { allowed: true };
}

/**
 * Get start of day (midnight) for a given date
 */
function getStartOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Record that a notification was sent (for policy tracking)
 */
export async function recordNotificationSent(
  userId: string,
  trigger: NotificationTrigger,
  firestore: FirestoreClient
): Promise<void> {
  // This is tracked via notification_ledger updates
  // No additional record needed here
  console.log(`Policy: Recorded sent notification for user ${userId}, trigger ${trigger.id}`);
}
