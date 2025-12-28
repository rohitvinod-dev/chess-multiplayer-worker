/**
 * POST /api/users/device
 *
 * Registers or updates FCM device token for push notifications.
 * Stores device info in subcollection for multi-device support.
 *
 * Ported from: OpeningsTrainer/functions/index.js:registerDevice
 */

import type { FirestoreClient } from '../../firestore';
import type { AuthenticatedUser, RegisterDeviceRequest } from '../../types';
import { ApiError, ErrorCodes } from '../../types';
import { formatTimestamp } from '../../utils/mastery';
import * as crypto from 'crypto';

/**
 * Hash token for device ID generation
 */
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function handleRegisterDevice(
  request: Request,
  firestore: FirestoreClient,
  user: AuthenticatedUser
): Promise<Response> {
  try {
    const body = await request.json() as RegisterDeviceRequest & {
      installationId?: string;
      appVersion?: string;
    };
    const now = new Date();

    const token = body.token?.trim() || '';
    const installationId = body.installationId?.trim() || '';

    if (!token && !installationId) {
      throw new ApiError(
        ErrorCodes.INVALID_ARGUMENT,
        'An FCM token or installation identifier is required.'
      );
    }

    const platform = body.platform?.trim() || 'unknown';
    const appVersion = body.appVersion?.trim() || null;

    // Generate device ID (prefer installationId, fallback to hashed token)
    const deviceId = installationId || hashToken(token).slice(0, 32);

    // Check if device already exists to preserve registeredAt timestamp
    const existingDevice = await firestore.getDocument(
      `users/${user.uid}/devices/${deviceId}`
    );

    // Update device document with standardized field names
    const deviceData: any = {
      fcmToken: token, // RENAMED from "token"
      installationId: installationId || null,
      platform,
      appVersion,
      lastSeenAt: formatTimestamp(now),
      registeredAt: existingDevice?.registeredAt || formatTimestamp(now),
      updatedAt: formatTimestamp(now),
      isActive: true,
    };

    await firestore.setDocument(
      `users/${user.uid}/devices/${deviceId}`,
      deviceData,
      { merge: true }
    );

    // Update user's latest FCM token
    const userUpdates: any = {
      updatedAt: formatTimestamp(now),
    };
    if (token) {
      userUpdates.latestFcmToken = token;
    }

    await firestore.setDocument(`users/${user.uid}`, userUpdates, { merge: true });

    return new Response(
      JSON.stringify({
        success: true,
        deviceId,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error registering device:', error);
    if (error instanceof ApiError) {
      return new Response(
        JSON.stringify({ error: error.message, code: error.code }),
        { status: error.statusCode, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify({ error: 'Internal server error', message: String(error) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
