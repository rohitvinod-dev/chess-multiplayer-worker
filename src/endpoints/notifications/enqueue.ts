/**
 * POST /api/notifications/enqueue
 *
 * Enqueue a notification for sending.
 * Checks policies, personalizes content, and either sends immediately or schedules.
 *
 * Ported from: OpeningsTrainer/functions/notifications/index.js:enqueueNotification
 */

import type { FirestoreClient } from '../../firestore';
import type { AuthenticatedUser } from '../../types';
import type {
  EnqueueNotificationRequest,
  EnqueueNotificationResponse,
  UserNotificationPreferences,
} from '../../types/notifications';
import {
  getTrigger,
  getVariant,
  interpolateMessage,
} from '../../types/notifications';
import { checkPolicy } from '../../utils/policy-engine';
import { sendFCM } from '../../utils/fcm';
import { ApiError, ErrorCodes } from '../../types';

export async function handleEnqueueNotification(
  request: Request,
  firestore: FirestoreClient,
  user: AuthenticatedUser,
  env: { FIREBASE_PROJECT_ID: string; FIREBASE_SERVICE_ACCOUNT: string }
): Promise<Response> {
  try {
    const body = await request.json() as EnqueueNotificationRequest;
    const userId = body.userId || user.uid;
    const triggerId = body.triggerId;
    const metadata = body.metadata || {};
    const scheduleAt = body.scheduleAt ? new Date(body.scheduleAt) : new Date();

    if (!triggerId) {
      throw new ApiError(ErrorCodes.INVALID_ARGUMENT, 'triggerId is required');
    }

    const trigger = getTrigger(triggerId);
    if (!trigger) {
      throw new ApiError(ErrorCodes.INVALID_ARGUMENT, `Unknown trigger: ${triggerId}`);
    }

    // Load user preferences and profile
    const [userPrefsDoc, userProfileDoc] = await Promise.all([
      firestore.getDocument(`users/${userId}/preferences/notifications`),
      firestore.getDocument(`users/${userId}`),
    ]);

    const userPrefs: UserNotificationPreferences = userPrefsDoc || {
      enabled: true,
      categories: {
        streaks: true,
        achievements: true,
        engagement: true,
        social: true,
      },
    };

    // Run policy checks
    const policyResult = await checkPolicy(
      { userId, trigger, userPrefs, scheduledTime: scheduleAt },
      firestore
    );

    if (!policyResult.allowed) {
      // Log blocked notification
      const blockedEntry = {
        userId,
        triggerId: trigger.id,
        category: trigger.category,
        status: 'blocked',
        blockReason: policyResult.reason,
        scheduledAt: { _seconds: Math.floor(scheduleAt.getTime() / 1000), _nanoseconds: 0 },
        metadata: {
          ...metadata,
          isTransactional: trigger.isTransactional,
          priority: trigger.priority,
        },
        createdAt: { _seconds: Math.floor(Date.now() / 1000), _nanoseconds: 0 },
      };

      await firestore.setDocument(
        `notification_ledger/${Date.now()}_${userId}`,
        blockedEntry
      );

      return Response.json({
        enqueued: false,
        reason: policyResult.reason,
        details: policyResult,
      });
    }

    // Select variant (A/B testing)
    const variant = getVariant(trigger, body.variantId);
    if (!variant) {
      throw new ApiError(ErrorCodes.INTERNAL, 'No variant available for trigger');
    }

    // Load user data for interpolation
    const userData = {
      username: userProfileDoc?.username || 'there',
      streak: userProfileDoc?.currentStreak || 0,
      ...metadata,
    };

    // Interpolate message content
    const title = interpolateMessage(variant.title, userData);
    const body_text = interpolateMessage(variant.body, userData);
    const deepLink = interpolateMessage(variant.deepLink, userData);

    // Create notification ledger entry
    const now = new Date();
    const notificationId = `${Date.now()}_${userId}_${Math.random().toString(36).slice(2, 9)}`;

    const ledgerEntry = {
      userId,
      triggerId: trigger.id,
      category: trigger.category,
      templateId: variant.id,
      experimentVariant: variant.id,
      scheduledAt: { _seconds: Math.floor(scheduleAt.getTime() / 1000), _nanoseconds: 0 },
      status: 'scheduled',
      metadata: {
        ...metadata,
        isTransactional: trigger.isTransactional,
        priority: trigger.priority,
      },
      deepLink,
      title,
      body: body_text,
      createdAt: { _seconds: Math.floor(now.getTime() / 1000), _nanoseconds: 0 },
    };

    await firestore.setDocument(`notification_ledger/${notificationId}`, ledgerEntry);

    console.log(`Notification enqueued: ${notificationId} for user ${userId}`);

    // If immediate timing, send now
    if (trigger.timingStrategy === 'immediate') {
      await sendNotificationNow(
        notificationId,
        userId,
        trigger,
        title,
        body_text,
        deepLink,
        metadata,
        firestore,
        env.FIREBASE_PROJECT_ID
      );
    }

    const response: EnqueueNotificationResponse = {
      enqueued: true,
      notificationId,
      scheduledAt: scheduleAt.toISOString(),
      variant: variant.id,
    };

    return Response.json(response);
  } catch (error) {
    console.error('Error enqueueing notification:', error);
    if (error instanceof ApiError) {
      return Response.json(
        { error: error.message, code: error.code },
        { status: error.statusCode }
      );
    }
    return Response.json(
      { error: 'Internal server error', message: String(error) },
      { status: 500 }
    );
  }
}

/**
 * Send notification immediately
 */
async function sendNotificationNow(
  notificationId: string,
  userId: string,
  trigger: any,
  title: string,
  body: string,
  deepLink: string,
  metadata: Record<string, any>,
  firestore: FirestoreClient,
  projectId: string
): Promise<void> {
  try {
    // Get user's FCM token
    const userDoc = await firestore.getDocument(`users/${userId}`);
    const fcmToken = userDoc?.latestFcmToken;

    if (!fcmToken) {
      await firestore.updateDocument(`notification_ledger/${notificationId}`, {
        status: 'failed',
        failureReason: 'no_fcm_token',
        updatedAt: { _seconds: Math.floor(Date.now() / 1000), _nanoseconds: 0 },
      });
      return;
    }

    // Get OAuth2 access token (reuse from firestore client)
    const accessToken = await firestore.getAccessToken();

    // Send via FCM
    const result = await sendFCM({
      projectId,
      accessToken,
      fcmToken,
      title,
      body,
      deepLink,
      trigger,
      metadata,
      notificationId,
    });

    if (result.success) {
      console.log('FCM sent successfully:', result.messageId);

      // Update ledger
      await firestore.updateDocument(`notification_ledger/${notificationId}`, {
        status: 'sent',
        sentAt: { _seconds: Math.floor(Date.now() / 1000), _nanoseconds: 0 },
        fcmMessageId: result.messageId,
        updatedAt: { _seconds: Math.floor(Date.now() / 1000), _nanoseconds: 0 },
      });
    } else {
      console.error('FCM send failed:', result.error);

      // Update ledger with failure
      await firestore.updateDocument(`notification_ledger/${notificationId}`, {
        status: 'failed',
        failureReason: result.error,
        updatedAt: { _seconds: Math.floor(Date.now() / 1000), _nanoseconds: 0 },
      });
    }
  } catch (error) {
    console.error('Error sending notification:', error);

    // Update ledger with failure
    await firestore.updateDocument(`notification_ledger/${notificationId}`, {
      status: 'failed',
      failureReason: String(error),
      updatedAt: { _seconds: Math.floor(Date.now() / 1000), _nanoseconds: 0 },
    });
  }
}
