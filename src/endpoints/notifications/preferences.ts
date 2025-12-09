/**
 * POST /api/notifications/preferences
 *
 * Update user notification preferences.
 *
 * Ported from: OpeningsTrainer/functions/notifications/index.js:updateNotificationPreferences
 */

import type { FirestoreClient } from '../../firestore';
import type { AuthenticatedUser } from '../../types';
import type { UpdatePreferencesRequest, UserNotificationPreferences } from '../../types/notifications';
import { ApiError, ErrorCodes } from '../../types';

export async function handleUpdateNotificationPreferences(
  request: Request,
  firestore: FirestoreClient,
  user: AuthenticatedUser
): Promise<Response> {
  try {
    const body = await request.json() as UpdatePreferencesRequest;
    const userId = user.uid;

    // Load current preferences
    const prefsPath = `users/${userId}/preferences/notifications`;
    const currentPrefs = await firestore.getDocument(prefsPath) || {
      enabled: true,
      categories: {
        streaks: true,
        achievements: true,
        engagement: true,
        social: true,
      },
    };

    // Build updated preferences
    const updatedPrefs: UserNotificationPreferences = {
      ...currentPrefs,
    };

    // Update enabled state
    if (body.enabled !== undefined) {
      updatedPrefs.enabled = body.enabled;
    }

    // Update category preferences
    if (body.categories) {
      updatedPrefs.categories = {
        ...updatedPrefs.categories,
        ...body.categories,
      };
    }

    // Update temporary mute
    if (body.muteTemporarily !== undefined) {
      updatedPrefs.muteTemporarily = body.muteTemporarily;

      if (body.muteTemporarily && body.muteDurationHours) {
        const muteUntil = new Date();
        muteUntil.setHours(muteUntil.getHours() + body.muteDurationHours);
        updatedPrefs.muteUntil = muteUntil;
      } else {
        updatedPrefs.muteUntil = null;
      }
    }

    // Update quiet hours
    if (body.quietHoursEnabled !== undefined) {
      updatedPrefs.quietHoursEnabled = body.quietHoursEnabled;
    }

    if (body.quietHoursStart !== undefined) {
      if (body.quietHoursStart < 0 || body.quietHoursStart > 23) {
        throw new ApiError(ErrorCodes.INVALID_ARGUMENT, 'quietHoursStart must be between 0 and 23');
      }
      updatedPrefs.quietHoursStart = body.quietHoursStart;
    }

    if (body.quietHoursEnd !== undefined) {
      if (body.quietHoursEnd < 0 || body.quietHoursEnd > 23) {
        throw new ApiError(ErrorCodes.INVALID_ARGUMENT, 'quietHoursEnd must be between 0 and 23');
      }
      updatedPrefs.quietHoursEnd = body.quietHoursEnd;
    }

    // Update frequency preference
    if (body.frequency !== undefined) {
      if (!['fewer', 'normal', 'more'].includes(body.frequency)) {
        throw new ApiError(ErrorCodes.INVALID_ARGUMENT, 'frequency must be "fewer", "normal", or "more"');
      }
      updatedPrefs.frequency = body.frequency;
    }

    // Save to Firestore
    await firestore.setDocument(prefsPath, updatedPrefs);

    console.log(`Updated notification preferences for user ${userId}`);

    return Response.json({
      success: true,
      preferences: updatedPrefs,
    });
  } catch (error) {
    console.error('Error updating notification preferences:', error);
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
