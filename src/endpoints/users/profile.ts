/**
 * POST /api/users/profile
 *
 * Ensures user profile exists and updates it with provided data.
 * Creates profile on first call, updates on subsequent calls.
 * Also syncs username to leaderboard.
 *
 * IMPORTANT: Uses usernames/{usernameLower} collection for atomic uniqueness.
 * This prevents race conditions where two users could claim the same username.
 *
 * Ported from: OpeningsTrainer/functions/index.js:ensureUserProfile
 */

import type { FirestoreClient } from '../../firestore';
import type { AuthenticatedUser, EnsureUserProfileRequest } from '../../types';
import { ApiError, ErrorCodes } from '../../types';
import {
  sanitizeUsername,
  validateUsername,
  deriveUsernameFromEmail,
  generateUniqueUsernameVariant,
  formatTimestamp,
  USERNAME_CONSTRAINTS,
} from '../../utils/mastery';

/**
 * Claim a username atomically using the usernames collection.
 * Returns true if successful, false if username is already taken.
 */
async function claimUsername(
  firestore: FirestoreClient,
  userId: string,
  username: string
): Promise<boolean> {
  const usernameLower = username.toLowerCase();

  try {
    // Check if username is already claimed
    const existing = await firestore.getDocument(`usernames/${usernameLower}`);

    if (existing) {
      // Username exists - check if it's owned by this user
      if (existing.uid === userId) {
        // Already owned by this user, update timestamp
        await firestore.setDocument(`usernames/${usernameLower}`, {
          uid: userId,
          username: username,
          updatedAt: formatTimestamp(new Date()),
        });
        return true;
      }
      // Owned by another user
      return false;
    }

    // Username not claimed - claim it
    await firestore.setDocument(`usernames/${usernameLower}`, {
      uid: userId,
      username: username,
      claimedAt: formatTimestamp(new Date()),
    });

    return true;
  } catch (error) {
    console.error('Error claiming username:', error);
    return false;
  }
}

/**
 * Release a username claim (when user changes username)
 */
async function releaseUsername(
  firestore: FirestoreClient,
  userId: string,
  usernameLower: string
): Promise<void> {
  try {
    const existing = await firestore.getDocument(`usernames/${usernameLower}`);
    if (existing && existing.uid === userId) {
      await firestore.deleteDocument(`usernames/${usernameLower}`);
    }
  } catch (error) {
    console.error('Error releasing username:', error);
    // Non-critical - continue
  }
}

/**
 * Ensure a unique username for a new user.
 * If the requested/derived username is taken, adds numeric suffix.
 */
async function ensureUniqueUsername(
  firestore: FirestoreClient,
  userId: string,
  baseUsername: string
): Promise<string | null> {
  // First, try to claim the base username
  if (await claimUsername(firestore, userId, baseUsername)) {
    return baseUsername;
  }

  // Username taken - try with numeric suffixes
  for (let i = 1; i <= 999; i++) {
    const suffix = i.toString();
    let candidate = baseUsername;

    // Ensure room for suffix
    if (candidate.length + suffix.length > USERNAME_CONSTRAINTS.maxLength) {
      candidate = candidate.slice(0, USERNAME_CONSTRAINTS.maxLength - suffix.length);
      candidate = candidate.replace(/[-_]+$/, '');
    }

    candidate = `${candidate}${suffix}`;

    const validation = validateUsername(candidate);
    if (validation.isValid && await claimUsername(firestore, userId, candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Derive a username for a new user from available sources
 */
function deriveDefaultUsername(
  email?: string | null,
  displayName?: string | null,
  userId?: string
): string {
  // Try email first
  const fromEmail = deriveUsernameFromEmail(email);
  if (fromEmail) return fromEmail;

  // Try display name
  if (displayName) {
    const sanitized = sanitizeUsername(displayName);
    if (sanitized && validateUsername(sanitized).isValid) {
      return sanitized;
    }
  }

  // Fallback to player_xxxxxx
  if (userId) {
    const fallback = `player_${userId.substring(0, 6)}`;
    const sanitized = sanitizeUsername(fallback);
    if (sanitized) return sanitized;
  }

  return 'player_new';
}

export async function handleEnsureUserProfile(
  request: Request,
  firestore: FirestoreClient,
  user: AuthenticatedUser
): Promise<Response> {
  try {
    const body = await request.json() as EnsureUserProfileRequest;
    const now = new Date();

    // Load existing user profile with proper error handling
    let existingData: any;
    try {
      existingData = await firestore.getDocument(`users/${user.uid}`);
    } catch (error) {
      console.error('CRITICAL: Failed to read user document for', user.uid, error);
      throw new ApiError(
        ErrorCodes.INTERNAL_ERROR,
        'Failed to load user profile. Please try again.'
      );
    }

    // CRITICAL FIX: Only treat as new user if document genuinely doesn't exist
    const isNewUser = existingData === null || existingData === undefined;

    // CRITICAL: Log for safety
    if (isNewUser) {
      console.log('Creating NEW user profile for', user.uid);
    } else {
      console.log('Updating EXISTING user profile for', user.uid);
      if (existingData.progressMap || existingData.learnProgressMap) {
        console.log('User has existing progress data - preserving it');
      }
    }

    // Handle username
    let finalUsername: string | null = null;
    const oldUsernameLower = existingData?.usernameLower;

    if (body.username) {
      // Explicit username provided - validate and claim
      const sanitized = sanitizeUsername(body.username);
      if (!sanitized) {
        throw new ApiError(
          ErrorCodes.VALIDATION_ERROR,
          'Invalid username format.'
        );
      }

      // Try to claim the username atomically
      const claimed = await claimUsername(firestore, user.uid, sanitized);
      if (!claimed) {
        throw new ApiError(
          ErrorCodes.ALREADY_EXISTS,
          'This username is already taken.'
        );
      }

      finalUsername = sanitized;

      // Release old username if changing
      if (oldUsernameLower && oldUsernameLower !== sanitized.toLowerCase()) {
        await releaseUsername(firestore, user.uid, oldUsernameLower);
      }
    } else if (isNewUser) {
      // New user without explicit username - derive and ensure unique
      const derivedBase = deriveDefaultUsername(body.email, body.displayName, user.uid);
      finalUsername = await ensureUniqueUsername(firestore, user.uid, derivedBase);

      if (!finalUsername) {
        // Last resort: use UID-based username
        const uidBased = `player_${user.uid.substring(0, 8)}`;
        finalUsername = await ensureUniqueUsername(firestore, user.uid, uidBased);
      }

      if (!finalUsername) {
        console.error('CRITICAL: Could not generate unique username for', user.uid);
        // Don't fail the request - just leave username null for now
      }
    }

    // Prepare user profile updates
    const payload: any = {
      updatedAt: formatTimestamp(now),
    };

    // ONLY set these fields for genuinely new users
    if (isNewUser) {
      payload.createdAt = formatTimestamp(now);
      payload.isPro = false;
      payload.totalPoints = 0;
      payload.learnPoints = 0;
      payload.masteryPoints = 0;
      payload.currentStreak = 0;
      payload.totalSessions = 0;
    }

    if (finalUsername) {
      payload.username = finalUsername;
      payload.usernameLower = finalUsername.toLowerCase();
    }

    if (body.email && typeof body.email === 'string' && body.email.trim()) {
      payload.email = body.email.trim();
    }

    if (body.emailVerified !== undefined) {
      payload.emailVerified = body.emailVerified;
    }

    if (body.displayName && typeof body.displayName === 'string' && body.displayName.trim()) {
      payload.displayName = body.displayName.trim();
    }

    if (body.photoURL && typeof body.photoURL === 'string' && body.photoURL.trim()) {
      payload.photoURL = body.photoURL.trim();
    }

    // Validate and set country code (ISO 3166-1 alpha-2 format)
    if (body.countryCode && typeof body.countryCode === 'string') {
      const countryCode = body.countryCode.trim().toUpperCase();
      if (/^[A-Z]{2}$/.test(countryCode)) {
        payload.countryCode = countryCode;
      }
    }

    // Update user profile
    await firestore.setDocument(`users/${user.uid}`, payload, { merge: true });

    // Sync to leaderboard
    const leaderboardUsername = finalUsername || existingData?.username || 'Anonymous';
    const leaderboardPayload: any = {
      username: leaderboardUsername,
      totalPoints: existingData?.totalPoints || 0,
      masteryPoints: existingData?.masteryPoints || 0,
      learnPoints: existingData?.learnPoints || 0,
      masteredVariations: existingData?.masteredVariations || 0,
      openingsMasteredCount: existingData?.openingsMasteredCount || 0,
      overallMasteryPercentage: existingData?.overallMasteryPercentage || 0,
      currentStreak: existingData?.currentStreak || 0,
      totalSessions: existingData?.totalSessions || 0,
      updatedAt: formatTimestamp(now),
    };

    // Include countryCode if set
    const countryCode = payload.countryCode || existingData?.countryCode;
    if (countryCode) {
      leaderboardPayload.countryCode = countryCode;
    }

    await firestore.setDocument(`leaderboard/${user.uid}`, leaderboardPayload, { merge: true });

    return new Response(
      JSON.stringify({
        success: true,
        username: finalUsername || existingData?.username,
        isNewUser,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error ensuring user profile:', error);
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
