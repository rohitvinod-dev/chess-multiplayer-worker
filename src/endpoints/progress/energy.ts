/**
 * POST /api/progress/energy/claim
 *
 * Claim energy reward (e.g., daily streak bonus).
 *
 * Ported from: OpeningsTrainer/functions/index.js:claimEnergyReward
 */

import type { FirestoreClient } from '../../firestore';
import type { AuthenticatedUser, ClaimEnergyRewardRequest } from '../../types';
import { ApiError, ErrorCodes } from '../../types';

interface Env {
  USER_PROFILE: DurableObjectNamespace;
  FIREBASE_PROJECT_ID: string;
  FIREBASE_SERVICE_ACCOUNT: string;
}

export async function handleClaimEnergyReward(
  request: Request,
  firestore: FirestoreClient,
  user: AuthenticatedUser,
  env: Env
): Promise<Response> {
  try {
    const body = await request.json() as ClaimEnergyRewardRequest;

    // Get user's UserProfile Durable Object
    const userProfileNamespace = env.USER_PROFILE;
    const userProfileId = userProfileNamespace.idFromName(`user:${user.uid}`);
    const userProfileStub = userProfileNamespace.get(userProfileId);

    // Call the Durable Object
    const response = await userProfileStub.fetch(
      new Request('https://internal/energy/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...body,
          userId: user.uid, // Pass the actual Firebase UID
        }),
      })
    );

    const result = await response.json();

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error claiming energy reward:', error);
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
