/**
 * Achievements Sync Endpoint
 * Syncs user achievements to Firestore
 * POST /api/achievements/sync
 */

import type { FirestoreClient } from '../../firestore';
import type { AuthenticatedUser } from '../../auth';
import type {
  AchievementsSyncRequest,
  AchievementsSyncResponse,
  Achievement,
} from '../../types/openings';
import { formatTimestamp } from '../../utils/mastery';

// Error codes
const ErrorCodes = {
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  INTERNAL: 'INTERNAL',
} as const;

class ApiError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

// ============ MAIN HANDLER ============

export async function handleSyncAchievements(
  request: Request,
  firestore: FirestoreClient,
  user: AuthenticatedUser
): Promise<Response> {
  try {
    const body = await request.json() as any;
    const userId = user.uid;

    // Support both formats for backward compatibility:
    // 1. Firebase Functions format: { unlocked: ['id1', 'id2'] }
    // 2. New format: { achievements: [{id, category, ...}] }

    let achievementIds: string[] = [];

    if (body.unlocked && Array.isArray(body.unlocked)) {
      // Firebase Functions format (just IDs)
      achievementIds = body.unlocked;
    } else if (body.achievements && Array.isArray(body.achievements)) {
      // New format (full objects)
      achievementIds = body.achievements.map((a: any) => a.id);
    } else {
      throw new ApiError(
        ErrorCodes.INVALID_ARGUMENT,
        'Request must contain either "unlocked" or "achievements" array'
      );
    }

    // Validate IDs
    if (achievementIds.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        message: 'No achievements to sync',
        synced: 0
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    for (const id of achievementIds) {
      if (!id || typeof id !== 'string') {
        throw new ApiError(
          ErrorCodes.INVALID_ARGUMENT,
          'Each achievement ID must be a string'
        );
      }
    }

    // Sync achievements to Firestore (simple format - just mark as unlocked)
    const syncPromises = achievementIds.map((id) =>
      syncAchievementById(firestore, userId, id)
    );

    await Promise.all(syncPromises);

    // Update public profile with unlocked achievement IDs
    try {
      await updatePublicProfileAchievements(firestore, userId, achievementIds);
    } catch (error) {
      console.error('Error updating public profile achievements:', error);
      // Don't fail the entire sync if public profile update fails
    }

    const response: AchievementsSyncResponse = {
      success: true,
      message: `Successfully synced ${achievementIds.length} achievement${achievementIds.length !== 1 ? 's' : ''}`,
      synced: achievementIds.length,
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return new Response(
        JSON.stringify({ success: false, message: error.message }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    console.error('Error in handleSyncAchievements:', error);
    return new Response(
      JSON.stringify({ success: false, message: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// ============ HELPER FUNCTIONS ============

// Simple sync - just mark achievement as unlocked with timestamp
async function syncAchievementById(
  firestore: FirestoreClient,
  userId: string,
  achievementId: string
): Promise<void> {
  const achievementPath = `users/${userId}/achievements/${achievementId}`;

  // Simple format - just mark as unlocked with timestamp
  const now = formatTimestamp(new Date());
  const achievementData = {
    id: achievementId,
    unlockedAt: now,
    lastUpdated: now,
  };

  // Use setDocument to create or update
  await firestore.setDocument(achievementPath, achievementData);
}

// Full sync with all achievement details (for future use)
async function syncAchievement(
  firestore: FirestoreClient,
  userId: string,
  achievement: Achievement
): Promise<void> {
  const achievementPath = `users/${userId}/achievements/${achievement.id}`;

  // Prepare achievement data with CORRECT field names
  const achievementData: any = {
    id: achievement.id,
    category: achievement.category,
    title: achievement.title,
    description: achievement.description,
    iconUrl: achievement.iconUrl || null,
    progress: achievement.progress || 0, // 0-100 scale (STANDARDIZE)
    currentValue: achievement.progress || 0, // RESTORE current value
    targetValue: achievement.target || null, // RENAME from "target"
    lastUpdated: formatTimestamp(new Date()),
  };

  // Only include unlockedAt if the achievement is unlocked
  if (achievement.unlockedAt) {
    achievementData.unlockedAt = achievement.unlockedAt;
  }

  // Use setDocument to create or update
  await firestore.setDocument(achievementPath, achievementData);
}

// Update public profile with unlocked achievement IDs
async function updatePublicProfileAchievements(
  firestore: FirestoreClient,
  userId: string,
  achievementIds: string[]
): Promise<void> {
  const publicDataPath = `users/${userId}/public/data`;

  // Update public profile with unlocked achievement IDs and count
  await firestore.updateDocument(publicDataPath, {
    unlockedAchievementIds: achievementIds,
    unlockedAchievementCount: achievementIds.length,
    updatedAt: formatTimestamp(new Date()),
  });
}
