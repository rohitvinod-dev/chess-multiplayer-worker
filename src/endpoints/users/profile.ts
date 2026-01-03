/**
 * POST /api/users/profile
 *
 * Ensures user profile exists and updates it with provided data.
 * Creates profile on first call, updates on subsequent calls.
 * Also syncs username to leaderboard.
 *
 * Ported from: OpeningsTrainer/functions/index.js:ensureUserProfile
 */

import type { FirestoreClient } from '../../firestore';
import type { AuthenticatedUser, EnsureUserProfileRequest } from '../../types';
import { ApiError, ErrorCodes } from '../../types';
import { sanitizeUsername, formatTimestamp } from '../../utils/mastery';

export async function handleEnsureUserProfile(
  request: Request,
  firestore: FirestoreClient,
  user: AuthenticatedUser
): Promise<Response> {
  try {
    const body = await request.json() as EnsureUserProfileRequest;
    const now = new Date();

    // Validate and sanitize username
    let requestedUsername: string | null = null;
    if (body.username) {
      requestedUsername = sanitizeUsername(body.username);
      if (requestedUsername) {
        // Check username availability
        const existingUsers = await firestore.queryDocuments('users', [
          { field: 'usernameLower', op: 'EQUAL', value: requestedUsername.toLowerCase() },
        ]);
        if (existingUsers.length > 0) {
          const existingDoc = existingUsers[0];
          if (existingDoc._id !== user.uid) {
            throw new ApiError(
              ErrorCodes.ALREADY_EXISTS,
              'This username is already taken.'
            );
          }
        }
      }
    }

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
    // Never treat a failed read as a new user to prevent data loss
    const isNewUser = existingData === null || existingData === undefined;

    // CRITICAL: Log if we're about to create a profile for safety
    if (isNewUser) {
      console.log('Creating NEW user profile for', user.uid);
    } else {
      console.log('Updating EXISTING user profile for', user.uid);
      // Safety check: warn if existing user has progress data
      if (existingData.progressMap || existingData.learnProgressMap) {
        console.log('User has existing progress data - preserving it');
      }
    }

    // Prepare user profile updates
    const payload: any = {
      updatedAt: formatTimestamp(now),
    };

    // ONLY set these fields for genuinely new users
    // NEVER overwrite createdAt for existing users!
    if (isNewUser) {
      payload.createdAt = formatTimestamp(now);
      payload.isPro = false;
      payload.totalPoints = 0;
      payload.learnPoints = 0;
      payload.masteryPoints = 0;
      payload.currentStreak = 0;
      payload.totalSessions = 0;
    }

    if (requestedUsername) {
      payload.username = requestedUsername;
      payload.usernameLower = requestedUsername.toLowerCase();
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
      // Basic validation: 2 uppercase letters
      if (/^[A-Z]{2}$/.test(countryCode)) {
        payload.countryCode = countryCode;
      }
    }

    // Update user profile
    await firestore.setDocument(`users/${user.uid}`, payload, { merge: true });

    // Sync to leaderboard
    const leaderboardPayload: any = {
      username: requestedUsername || existingData.username || 'Anonymous',
      totalPoints: existingData.totalPoints || 0,
      masteryPoints: existingData.masteryPoints || 0,
      learnPoints: existingData.learnPoints || 0,
      masteredVariations: existingData.masteredVariations || 0,
      openingsMasteredCount: existingData.openingsMasteredCount || 0,
      overallMasteryPercentage: existingData.overallMasteryPercentage || 0,
      currentStreak: existingData.currentStreak || 0,
      totalSessions: existingData.totalSessions || 0,
      updatedAt: formatTimestamp(now),
    };

    // Include countryCode if set
    const countryCode = payload.countryCode || existingData.countryCode;
    if (countryCode) {
      leaderboardPayload.countryCode = countryCode;
    }

    await firestore.setDocument(`leaderboard/${user.uid}`, leaderboardPayload, { merge: true });

    return new Response(
      JSON.stringify({
        success: true,
        username: requestedUsername,
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
