/**
 * Firebase Cloud Messaging HTTP v1 API Client
 *
 * Since Cloudflare Workers don't have Firebase Admin SDK,
 * we use the FCM HTTP v1 API directly with OAuth2 authentication.
 *
 * Reference: https://firebase.google.com/docs/cloud-messaging/send-message
 */

import type { NotificationTrigger } from '../types/notifications';

interface FCMMessage {
  token: string;
  notification?: {
    title: string;
    body: string;
  };
  data?: Record<string, string>;
  android?: {
    priority: 'high' | 'normal';
    notification?: {
      channelId: string;
      sound: string;
    };
  };
  apns?: {
    payload: {
      aps: {
        sound: string;
        badge?: number;
      };
    };
  };
}

interface FCMResponse {
  name?: string; // Message ID on success
  error?: {
    code: number;
    message: string;
    status: string;
  };
}

/**
 * Send FCM notification using HTTP v1 API
 *
 * This requires a valid OAuth2 access token from the service account.
 * The access token is obtained using the same method as Firestore client.
 */
export async function sendFCM(
  params: {
    projectId: string;
    accessToken: string;
    fcmToken: string;
    title: string;
    body: string;
    deepLink: string;
    trigger: NotificationTrigger;
    metadata: Record<string, any>;
    notificationId: string;
  }
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const {
    projectId,
    accessToken,
    fcmToken,
    title,
    body,
    deepLink,
    trigger,
    metadata,
    notificationId,
  } = params;

  // Build FCM message
  const message: FCMMessage = {
    token: fcmToken,
    notification: {
      title,
      body,
    },
    data: {
      notificationId,
      type: trigger.category,
      triggerId: trigger.id,
      deepLink: deepLink || '',
      ...convertMetadataToStrings(metadata),
    },
    android: {
      priority: trigger.priority === 'high' ? 'high' : 'normal',
      notification: {
        channelId: 'fcm_default_channel',
        sound: 'default',
      },
    },
    apns: {
      payload: {
        aps: {
          sound: 'default',
          badge: 1,
        },
      },
    },
  };

  try {
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message }),
      }
    );

    const result: FCMResponse = await response.json();

    if (!response.ok) {
      console.error('FCM error:', result.error);
      return {
        success: false,
        error: result.error?.message || 'Unknown FCM error',
      };
    }

    return {
      success: true,
      messageId: result.name,
    };
  } catch (error) {
    console.error('FCM send error:', error);
    return {
      success: false,
      error: String(error),
    };
  }
}

/**
 * Convert metadata to string values (FCM data payload requires strings)
 */
function convertMetadataToStrings(metadata: Record<string, any>): Record<string, string> {
  const stringMetadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== null && value !== undefined) {
      stringMetadata[key] = String(value);
    }
  }
  return stringMetadata;
}

/**
 * Batch send notifications (useful for future queue consumer)
 */
export async function sendFCMBatch(
  params: {
    projectId: string;
    accessToken: string;
    messages: Array<{
      fcmToken: string;
      title: string;
      body: string;
      deepLink: string;
      trigger: NotificationTrigger;
      metadata: Record<string, any>;
      notificationId: string;
    }>;
  }
): Promise<Array<{ success: boolean; messageId?: string; error?: string }>> {
  const { projectId, accessToken, messages } = params;

  // Send in parallel (FCM doesn't have a true batch API for v1)
  const results = await Promise.all(
    messages.map((msg) =>
      sendFCM({
        projectId,
        accessToken,
        fcmToken: msg.fcmToken,
        title: msg.title,
        body: msg.body,
        deepLink: msg.deepLink,
        trigger: msg.trigger,
        metadata: msg.metadata,
        notificationId: msg.notificationId,
      })
    )
  );

  return results;
}
