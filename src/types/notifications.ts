/**
 * Notification system types
 * Simplified version of Firebase notification system for Cloudflare Workers
 */

export interface NotificationTrigger {
  id: string;
  category: 'streaks' | 'achievements' | 'engagement' | 'social' | 'win_back' | 'progress';
  isTransactional: boolean;
  priority: 'high' | 'normal';
  timingStrategy: 'immediate' | 'preferred_time_window' | 'before_midnight' | 'after_event';
  variants: NotificationVariant[];
}

export interface NotificationVariant {
  id: string;
  title: string;
  body: string;
  deepLink: string;
}

export interface UserNotificationPreferences {
  enabled: boolean;
  categories: {
    streaks?: boolean;
    achievements?: boolean;
    engagement?: boolean;
    social?: boolean;
    win_back?: boolean;
    progress?: boolean;
  };
  muteTemporarily?: boolean;
  muteUntil?: Date | null;
  quietHoursEnabled?: boolean;
  quietHoursStart?: number; // 0-23
  quietHoursEnd?: number; // 0-23
  frequency?: 'fewer' | 'normal' | 'more';
}

export interface PolicyCheckParams {
  userId: string;
  trigger: NotificationTrigger;
  userPrefs: UserNotificationPreferences;
  scheduledTime: Date;
}

export interface PolicyCheckResult {
  allowed: boolean;
  reason?: string;
  details?: any;
}

export interface NotificationLedgerEntry {
  userId: string;
  triggerId: string;
  category: string;
  templateId: string;
  experimentVariant: string;
  scheduledAt: Date;
  sentAt?: Date;
  status: 'scheduled' | 'sent' | 'failed' | 'blocked';
  failureReason?: string;
  blockReason?: string;
  metadata: Record<string, any>;
  deepLink: string;
  title: string;
  body: string;
  createdAt: Date;
}

export interface EnqueueNotificationRequest {
  userId?: string;
  triggerId: string;
  metadata?: Record<string, any>;
  scheduleAt?: string;
  variantId?: string;
}

export interface EnqueueNotificationResponse {
  enqueued: boolean;
  notificationId?: string;
  scheduledAt?: string;
  variant?: string;
  reason?: string;
  details?: any;
}

export interface UpdatePreferencesRequest {
  enabled?: boolean;
  categories?: {
    streaks?: boolean;
    achievements?: boolean;
    engagement?: boolean;
    social?: boolean;
    win_back?: boolean;
    progress?: boolean;
  };
  muteTemporarily?: boolean;
  muteDurationHours?: number;
  quietHoursEnabled?: boolean;
  quietHoursStart?: number;
  quietHoursEnd?: number;
  frequency?: 'fewer' | 'normal' | 'more';
}

export interface TrackNotificationOpenedRequest {
  notificationId: string;
  openedAt?: string;
}

// Policy configuration
export const POLICY_CONFIG = {
  MAX_TRANSACTIONAL_PER_DAY: 2,
  MAX_HABIT_PER_DAY: 1,
  MAX_TOTAL_PER_DAY: 2,
  MIN_COOLDOWN_BETWEEN_NOTIFICATIONS: 20, // hours
  FREQUENCY_MULTIPLIERS: {
    fewer: 0.5,
    normal: 1.0,
    more: 1.5,
  },
  DEFAULT_QUIET_START: 22, // 10 PM
  DEFAULT_QUIET_END: 8, // 8 AM
};

// Trigger definitions (simplified from Firebase)
export const TRIGGERS: Record<string, NotificationTrigger> = {
  daily_streak_reminder: {
    id: 'daily_streak_reminder',
    category: 'streaks',
    isTransactional: false,
    priority: 'normal',
    timingStrategy: 'preferred_time_window',
    variants: [
      {
        id: 'variant_a_friendly',
        title: '🔥 Keep your streak alive!',
        body: 'Practice today to maintain your {streak}-day streak',
        deepLink: '/train',
      },
      {
        id: 'variant_b_motivational',
        title: "Don't break the chain! 🔗",
        body: '{streak} days and counting. Train now!',
        deepLink: '/train',
      },
    ],
  },
  last_chance_streak_save: {
    id: 'last_chance_streak_save',
    category: 'streaks',
    isTransactional: true,
    priority: 'high',
    timingStrategy: 'before_midnight',
    variants: [
      {
        id: 'variant_a_urgent',
        title: '⚠️ Last chance to save your streak!',
        body: '{streak} days at risk. Train now before midnight!',
        deepLink: '/train?urgent=true',
      },
    ],
  },
  achievement_unlocked: {
    id: 'achievement_unlocked',
    category: 'achievements',
    isTransactional: true,
    priority: 'high',
    timingStrategy: 'immediate',
    variants: [
      {
        id: 'variant_a_celebration',
        title: '🏆 Achievement Unlocked!',
        body: 'You earned "{achievement_name}"!',
        deepLink: '/profile/achievements',
      },
    ],
  },
  session_incomplete: {
    id: 'session_incomplete',
    category: 'engagement',
    isTransactional: false,
    priority: 'normal',
    timingStrategy: 'after_event',
    variants: [
      {
        id: 'variant_a_resume',
        title: 'Ready to continue? 👋',
        body: 'You left off at {opening_name}. Resume now!',
        deepLink: '/train?resume=true',
      },
    ],
  },
  // Win-back notifications for inactive users (3-7 days)
  win_back_3_days: {
    id: 'win_back_3_days',
    category: 'win_back',
    isTransactional: false,
    priority: 'normal',
    timingStrategy: 'preferred_time_window',
    variants: [
      {
        id: 'variant_a_miss_you',
        title: 'We miss you! 👋',
        body: 'Your chess openings are waiting. Come back and train!',
        deepLink: '/train',
      },
      {
        id: 'variant_b_challenge',
        title: 'Ready for a challenge? ♟️',
        body: "It's been a few days. Test your memory!",
        deepLink: '/train',
      },
    ],
  },
  win_back_7_days: {
    id: 'win_back_7_days',
    category: 'win_back',
    isTransactional: false,
    priority: 'normal',
    timingStrategy: 'preferred_time_window',
    variants: [
      {
        id: 'variant_a_comeback',
        title: 'Time to make a comeback! 🚀',
        body: "A week away? Let's get back on track!",
        deepLink: '/train',
      },
      {
        id: 'variant_b_new_content',
        title: "What's new in CheckmateX? 🆕",
        body: 'Come back and discover new features!',
        deepLink: '/train',
      },
    ],
  },
  win_back_14_days: {
    id: 'win_back_14_days',
    category: 'win_back',
    isTransactional: false,
    priority: 'normal',
    timingStrategy: 'preferred_time_window',
    variants: [
      {
        id: 'variant_a_fresh_start',
        title: 'Fresh start? ✨',
        body: '2 weeks is nothing. Your openings knowledge is still there!',
        deepLink: '/train',
      },
    ],
  },
  // Weekly progress summary
  weekly_progress_summary: {
    id: 'weekly_progress_summary',
    category: 'progress',
    isTransactional: false,
    priority: 'normal',
    timingStrategy: 'preferred_time_window',
    variants: [
      {
        id: 'variant_a_stats',
        title: '📊 Your Weekly Progress',
        body: '{sessions} sessions, {moves} moves practiced. Keep it up!',
        deepLink: '/profile',
      },
      {
        id: 'variant_b_motivational',
        title: 'Week in Review 🏆',
        body: "You've trained {sessions} times this week. Great job!",
        deepLink: '/profile',
      },
    ],
  },
};

export function getTrigger(triggerId: string): NotificationTrigger | null {
  return TRIGGERS[triggerId] || null;
}

export function getVariant(trigger: NotificationTrigger, variantId?: string): NotificationVariant | null {
  if (variantId) {
    return trigger.variants.find(v => v.id === variantId) || null;
  }
  return getRandomVariant(trigger);
}

export function getRandomVariant(trigger: NotificationTrigger): NotificationVariant | null {
  if (trigger.variants.length === 0) return null;
  const randomIndex = Math.floor(Math.random() * trigger.variants.length);
  return trigger.variants[randomIndex];
}

/**
 * Interpolate variables in message template
 * Example: "Your {streak}-day streak" with {streak: 5} => "Your 5-day streak"
 */
export function interpolateMessage(template: string, data: Record<string, any>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    return data[key]?.toString() || match;
  });
}
