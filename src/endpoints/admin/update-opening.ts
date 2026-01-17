/**
 * Admin Endpoint: Update Opening
 * POST /api/admin/update-opening
 *
 * Updates a global opening in Firestore and increments the openings version
 * for client-side cache invalidation.
 * Requires admin authentication via X-Admin-Secret header
 */

import type { Env } from '../../types';
import { FirestoreClient } from '../../firestore';
import { formatTimestamp } from '../../utils/mastery';

interface UpdateOpeningRequest {
  openingId: string;
  data: {
    name: string;
    variations: any[];
    eco?: string;
  };
}

/**
 * Increment the openings version number for client cache invalidation
 * Clients check this version on app start and refresh if it changed
 */
async function incrementOpeningsVersion(firestore: FirestoreClient): Promise<number> {
  const versionDoc = await firestore.getDocument('openings_metadata/version');
  const currentVersion = (versionDoc?.version as number) || 0;
  const newVersion = currentVersion + 1;

  await firestore.setDocument('openings_metadata/version', {
    version: newVersion,
    updatedAt: formatTimestamp(new Date()),
  }, { merge: false });

  return newVersion;
}

export async function handleUpdateOpening(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    // Create Firestore client
    const firestore = new FirestoreClient({
      projectId: env.FIREBASE_PROJECT_ID,
      serviceAccount: env.FIREBASE_SERVICE_ACCOUNT,
    });

    const body = await request.json() as UpdateOpeningRequest;

    if (!body.openingId || !body.data) {
      return new Response(
        JSON.stringify({ success: false, error: 'Missing openingId or data' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Prepare the document
    const openingDoc = {
      ...body.data,
      id: body.openingId,
      updatedAt: formatTimestamp(new Date()),
    };

    // Update Firestore
    await firestore.setDocument(`openings/${body.openingId}`, openingDoc, { merge: false });

    // Increment openings version for client cache invalidation
    const newVersion = await incrementOpeningsVersion(firestore);
    console.log(`Openings version incremented to ${newVersion}`);

    // Count variations
    const variationCount = body.data.variations?.length || 0;
    let subVariationCount = 0;
    for (const v of body.data.variations || []) {
      subVariationCount += (v.variations || []).length;
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Opening "${body.data.name}" updated successfully`,
        stats: {
          variations: variationCount,
          subVariations: subVariationCount,
        },
        openingsVersion: newVersion,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error updating opening:', error);
    return new Response(
      JSON.stringify({ success: false, error: String(error) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
