/**
 * POST /api/notifications/track
 *
 * Track notification interactions (opened, dismissed, etc.)
 * Used for analytics and A/B testing optimization.
 *
 * Ported from: OpeningsTrainer/functions/notifications/index.js:trackNotificationOpened
 */

import type { FirestoreClient } from '../../firestore';
import type { AuthenticatedUser } from '../../types';
import type { TrackNotificationOpenedRequest } from '../../types/notifications';
import { ApiError, ErrorCodes } from '../../types';

export async function handleTrackNotificationOpened(
  request: Request,
  firestore: FirestoreClient,
  user: AuthenticatedUser
): Promise<Response> {
  try {
    const body = await request.json() as TrackNotificationOpenedRequest;
    const userId = user.uid;
    const { notificationId, openedAt } = body;

    if (!notificationId) {
      throw new ApiError(ErrorCodes.INVALID_ARGUMENT, 'notificationId is required');
    }

    const openedTimestamp = openedAt ? new Date(openedAt) : new Date();

    // Update notification ledger entry
    const ledgerPath = `notification_ledger/${notificationId}`;
    const ledgerEntry = await firestore.getDocument(ledgerPath);

    if (!ledgerEntry) {
      console.warn(`Notification ledger entry not found: ${notificationId}`);
      // Don't throw error - notification may have been cleaned up
      return Response.json({
        success: true,
        message: 'Notification not found (may have been archived)',
      });
    }

    // Verify this notification belongs to the authenticated user
    if (ledgerEntry.userId !== userId) {
      throw new ApiError(ErrorCodes.PERMISSION_DENIED, 'Notification does not belong to authenticated user');
    }

    // Update with opened timestamp
    await firestore.updateDocument(ledgerPath, {
      openedAt: { _seconds: Math.floor(openedTimestamp.getTime() / 1000), _nanoseconds: 0 },
      updatedAt: { _seconds: Math.floor(Date.now() / 1000), _nanoseconds: 0 },
    });

    // Record analytics event (for A/B testing and optimization)
    const analyticsEntry = {
      userId,
      notificationId,
      triggerId: ledgerEntry.triggerId,
      category: ledgerEntry.category,
      templateId: ledgerEntry.templateId,
      experimentVariant: ledgerEntry.experimentVariant,
      sentAt: ledgerEntry.sentAt,
      openedAt: { _seconds: Math.floor(openedTimestamp.getTime() / 1000), _nanoseconds: 0 },
      timeBetweenSentAndOpened: ledgerEntry.sentAt
        ? Math.floor(openedTimestamp.getTime() / 1000) - ledgerEntry.sentAt._seconds
        : null,
      metadata: ledgerEntry.metadata || {},
      timestamp: { _seconds: Math.floor(Date.now() / 1000), _nanoseconds: 0 },
    };

    // Store in analytics collection
    await firestore.setDocument(
      `notification_analytics/${notificationId}`,
      analyticsEntry
    );

    console.log(`Tracked notification opened: ${notificationId} for user ${userId}`);

    return Response.json({
      success: true,
      notificationId,
      openedAt: openedTimestamp.toISOString(),
    });
  } catch (error) {
    console.error('Error tracking notification:', error);
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
