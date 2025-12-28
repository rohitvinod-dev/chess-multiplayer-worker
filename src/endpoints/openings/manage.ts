/**
 * Custom Openings Management Endpoint
 * Handles CRUD operations for user-created chess openings
 * POST /api/openings/manage
 */

import type { FirestoreClient } from '../../firestore';
import type { AuthenticatedUser } from '../../auth';
import {
  type OpeningsManageRequest,
  type OpeningsManageResponse,
  type CustomOpening,
  type CustomVariation,
  getUserLimits,
  validateOpeningName,
  validateVariationName,
  validateMoves,
} from '../../types/openings';
import { formatTimestamp } from '../../utils/mastery';

// Error codes
const ErrorCodes = {
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  RESOURCE_EXHAUSTED: 'RESOURCE_EXHAUSTED',
} as const;

class ApiError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

// ============ MAIN HANDLER ============

export async function handleManageOpenings(
  request: Request,
  firestore: FirestoreClient,
  user: AuthenticatedUser
): Promise<Response> {
  try {
    const body = (await request.json()) as OpeningsManageRequest;
    const userId = user.uid;

    // Route to appropriate handler based on action
    switch (body.action) {
      case 'createOpening':
        return await handleCreateOpening(firestore, userId, body);
      case 'renameOpening':
        return await handleRenameOpening(firestore, userId, body);
      case 'deleteOpening':
        return await handleDeleteOpening(firestore, userId, body);
      case 'createVariation':
        return await handleCreateVariation(firestore, userId, body);
      case 'updateVariation':
        return await handleUpdateVariation(firestore, userId, body);
      case 'deleteVariation':
        return await handleDeleteVariation(firestore, userId, body);
      default:
        throw new ApiError(ErrorCodes.INVALID_ARGUMENT, `Unknown action: ${(body as any).action}`);
    }
  } catch (error) {
    if (error instanceof ApiError) {
      return new Response(
        JSON.stringify({ success: false, message: error.message }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    console.error('Error in handleManageOpenings:', error);
    return new Response(
      JSON.stringify({ success: false, message: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// ============ CREATE OPENING ============

async function handleCreateOpening(
  firestore: FirestoreClient,
  userId: string,
  body: { name: string; description?: string; color: 'white' | 'black' }
): Promise<Response> {
  // Validate opening name
  const nameValidation = validateOpeningName(body.name);
  if (!nameValidation.valid) {
    throw new ApiError(ErrorCodes.INVALID_ARGUMENT, nameValidation.error!);
  }

  // Get user profile to check Pro status
  const userDoc = await firestore.getDocument(`users/${userId}`);
  const isPro = userDoc?.isPro || false;
  const limits = getUserLimits(isPro);

  // Check if user has reached max openings limit (query user subcollection)
  const existingOpenings = await firestore.queryDocuments(
    `users/${userId}/custom_openings`,
    []
  );

  if (existingOpenings.length >= limits.maxOpenings) {
    throw new ApiError(
      ErrorCodes.RESOURCE_EXHAUSTED,
      `You have reached the maximum of ${limits.maxOpenings} custom opening${limits.maxOpenings > 1 ? 's' : ''}. ${!isPro ? 'Upgrade to Pro for more!' : ''}`
    );
  }

  // Check for duplicate name
  const duplicateCheck = existingOpenings.find(
    (opening: any) => opening.name.toLowerCase() === body.name.toLowerCase()
  );
  if (duplicateCheck) {
    throw new ApiError(
      ErrorCodes.ALREADY_EXISTS,
      `An opening with the name "${body.name}" already exists`
    );
  }

  // Create new opening
  const now = formatTimestamp(new Date());
  const openingId = `opening_${Date.now()}`;

  const newOpening: any = {
    openingId: openingId,
    name: body.name.trim(),
    description: body.description?.trim(),
    color: body.color,
    createdAt: now,
    updatedAt: now,
    variationCount: 0,
  };

  // Write to user subcollection (path-based ownership)
  await firestore.setDocument(
    `users/${userId}/custom_openings/${openingId}`,
    newOpening
  );

  const response: OpeningsManageResponse = {
    success: true,
    message: 'Opening created successfully',
    data: { openingId, opening: newOpening },
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ============ RENAME OPENING ============

async function handleRenameOpening(
  firestore: FirestoreClient,
  userId: string,
  body: { openingId: string; newName: string }
): Promise<Response> {
  // Validate new name
  const nameValidation = validateOpeningName(body.newName);
  if (!nameValidation.valid) {
    throw new ApiError(ErrorCodes.INVALID_ARGUMENT, nameValidation.error!);
  }

  // Get opening and verify existence (ownership implicit in path)
  const opening = await firestore.getDocument(`users/${userId}/custom_openings/${body.openingId}`);
  if (!opening) {
    throw new ApiError(ErrorCodes.NOT_FOUND, 'Opening not found');
  }

  // Check for duplicate name (excluding current opening)
  const existingOpenings = await firestore.queryDocuments(
    `users/${userId}/custom_openings`,
    []
  );

  const duplicateCheck = existingOpenings.find(
    (o: any) => o.openingId !== body.openingId && o.name.toLowerCase() === body.newName.toLowerCase()
  );
  if (duplicateCheck) {
    throw new ApiError(
      ErrorCodes.ALREADY_EXISTS,
      `An opening with the name "${body.newName}" already exists`
    );
  }

  // Update opening name
  const now = formatTimestamp(new Date());
  await firestore.updateDocument(`users/${userId}/custom_openings/${body.openingId}`, {
    name: body.newName.trim(),
    updatedAt: now,
  });

  const response: OpeningsManageResponse = {
    success: true,
    message: 'Opening renamed successfully',
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ============ DELETE OPENING ============

async function handleDeleteOpening(
  firestore: FirestoreClient,
  userId: string,
  body: { openingId: string }
): Promise<Response> {
  // Get opening and verify existence (ownership implicit in path)
  const opening = await firestore.getDocument(`users/${userId}/custom_openings/${body.openingId}`);
  if (!opening) {
    throw new ApiError(ErrorCodes.NOT_FOUND, 'Opening not found');
  }

  // Get all variations for this opening (from nested subcollection)
  const variations = await firestore.queryDocuments(
    `users/${userId}/custom_openings/${body.openingId}/variations`,
    []
  );

  // Delete all variations in parallel (hard delete)
  await Promise.all(
    variations.map((variation: any) =>
      firestore.deleteDocument(
        `users/${userId}/custom_openings/${body.openingId}/variations/${variation.variationId}`
      )
    )
  );

  // Delete opening (hard delete)
  await firestore.deleteDocument(`users/${userId}/custom_openings/${body.openingId}`);

  const response: OpeningsManageResponse = {
    success: true,
    message: `Opening and ${variations.length} variation${variations.length !== 1 ? 's' : ''} deleted successfully`,
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ============ CREATE VARIATION ============

async function handleCreateVariation(
  firestore: FirestoreClient,
  userId: string,
  body: { openingId: string; name: string; moves: string[]; fen?: string }
): Promise<Response> {
  // Validate variation name
  const nameValidation = validateVariationName(body.name);
  if (!nameValidation.valid) {
    throw new ApiError(ErrorCodes.INVALID_ARGUMENT, nameValidation.error!);
  }

  // Get opening and verify existence (ownership implicit in path)
  const opening = await firestore.getDocument(`users/${userId}/custom_openings/${body.openingId}`);
  if (!opening) {
    throw new ApiError(ErrorCodes.NOT_FOUND, 'Opening not found');
  }

  // Get user profile to check Pro status
  const userDoc = await firestore.getDocument(`users/${userId}`);
  const isPro = userDoc?.isPro || false;
  const limits = getUserLimits(isPro);

  // Validate moves length
  const movesValidation = validateMoves(body.moves, limits.maxMovesPerVariation);
  if (!movesValidation.valid) {
    throw new ApiError(ErrorCodes.INVALID_ARGUMENT, movesValidation.error!);
  }

  // Check if opening has reached max variations limit (query nested subcollection)
  const existingVariations = await firestore.queryDocuments(
    `users/${userId}/custom_openings/${body.openingId}/variations`,
    []
  );

  if (existingVariations.length >= limits.maxVariationsPerOpening) {
    throw new ApiError(
      ErrorCodes.RESOURCE_EXHAUSTED,
      `This opening has reached the maximum of ${limits.maxVariationsPerOpening} variations. ${!isPro ? 'Upgrade to Pro for more!' : ''}`
    );
  }

  // Check for duplicate name within this opening
  const duplicateCheck = existingVariations.find(
    (variation: any) => variation.name.toLowerCase() === body.name.toLowerCase()
  );
  if (duplicateCheck) {
    throw new ApiError(
      ErrorCodes.ALREADY_EXISTS,
      `A variation with the name "${body.name}" already exists in this opening`
    );
  }

  // Create new variation
  const now = formatTimestamp(new Date());
  const variationId = `var_${Date.now()}`;

  const newVariation: any = {
    variationId: variationId,
    name: body.name.trim(),
    moves: body.moves,
    fen: body.fen,
    moveCount: body.moves.length,
    masteryLevel: 0,
    practiceCount: 0,
    accuracy: 0,
    createdAt: now,
    updatedAt: now,
  };

  // Write to nested subcollection (path includes opening ID)
  await firestore.setDocument(
    `users/${userId}/custom_openings/${body.openingId}/variations/${variationId}`,
    newVariation
  );

  // Update opening variation count
  await firestore.updateDocument(`users/${userId}/custom_openings/${body.openingId}`, {
    variationCount: existingVariations.length + 1,
    updatedAt: now,
  });

  const response: OpeningsManageResponse = {
    success: true,
    message: 'Variation created successfully',
    data: { variationId, variation: newVariation },
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ============ UPDATE VARIATION ============

async function handleUpdateVariation(
  firestore: FirestoreClient,
  userId: string,
  body: { variationId: string; name?: string; moves?: string[]; fen?: string }
): Promise<Response> {
  // Note: We need the opening ID to construct the path, but it's not in the request
  // We'll need to query all openings to find which one contains this variation
  // This is a limitation of the nested subcollection approach
  // Better: Include openingId in the request body (TODO: update API contract)

  // For now, we'll query all user's openings to find the variation
  const userOpenings = await firestore.queryDocuments(`users/${userId}/custom_openings`, []);

  let variationDoc: any = null;
  let openingId: string | null = null;

  for (const opening of userOpenings) {
    const variation = await firestore.getDocument(
      `users/${userId}/custom_openings/${opening.openingId}/variations/${body.variationId}`
    );
    if (variation) {
      variationDoc = variation;
      openingId = opening.openingId;
      break;
    }
  }

  if (!variationDoc || !openingId) {
    throw new ApiError(ErrorCodes.NOT_FOUND, 'Variation not found');
  }

  // Get user profile to check Pro status
  const userDoc = await firestore.getDocument(`users/${userId}`);
  const isPro = userDoc?.isPro || false;
  const limits = getUserLimits(isPro);

  const updates: any = {};

  // Validate and update name if provided
  if (body.name !== undefined) {
    const nameValidation = validateVariationName(body.name);
    if (!nameValidation.valid) {
      throw new ApiError(ErrorCodes.INVALID_ARGUMENT, nameValidation.error!);
    }

    // Check for duplicate name in the same opening
    const existingVariations = await firestore.queryDocuments(
      `users/${userId}/custom_openings/${openingId}/variations`,
      []
    );

    const duplicateCheck = existingVariations.find(
      (v: any) => v.variationId !== body.variationId && v.name.toLowerCase() === body.name!.toLowerCase()
    );
    if (duplicateCheck) {
      throw new ApiError(
        ErrorCodes.ALREADY_EXISTS,
        `A variation with the name "${body.name}" already exists in this opening`
      );
    }

    updates.name = body.name.trim();
  }

  // Validate and update moves if provided
  if (body.moves !== undefined) {
    const movesValidation = validateMoves(body.moves, limits.maxMovesPerVariation);
    if (!movesValidation.valid) {
      throw new ApiError(ErrorCodes.INVALID_ARGUMENT, movesValidation.error!);
    }
    updates.moves = body.moves;
    updates.moveCount = body.moves.length;
  }

  // Update FEN if provided
  if (body.fen !== undefined) {
    updates.fen = body.fen;
  }

  // Add updatedAt timestamp
  updates.updatedAt = formatTimestamp(new Date());

  // Update variation
  await firestore.updateDocument(
    `users/${userId}/custom_openings/${openingId}/variations/${body.variationId}`,
    updates
  );

  const response: OpeningsManageResponse = {
    success: true,
    message: 'Variation updated successfully',
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ============ DELETE VARIATION ============

async function handleDeleteVariation(
  firestore: FirestoreClient,
  userId: string,
  body: { variationId: string }
): Promise<Response> {
  // Find which opening contains this variation
  const userOpenings = await firestore.queryDocuments(`users/${userId}/custom_openings`, []);

  let variationDoc: any = null;
  let openingId: string | null = null;

  for (const opening of userOpenings) {
    const variation = await firestore.getDocument(
      `users/${userId}/custom_openings/${opening.openingId}/variations/${body.variationId}`
    );
    if (variation) {
      variationDoc = variation;
      openingId = opening.openingId;
      break;
    }
  }

  if (!variationDoc || !openingId) {
    throw new ApiError(ErrorCodes.NOT_FOUND, 'Variation not found');
  }

  // Delete variation (hard delete)
  await firestore.deleteDocument(
    `users/${userId}/custom_openings/${openingId}/variations/${body.variationId}`
  );

  // Update opening variation count
  const now = formatTimestamp(new Date());
  const existingVariations = await firestore.queryDocuments(
    `users/${userId}/custom_openings/${openingId}/variations`,
    []
  );

  await firestore.updateDocument(`users/${userId}/custom_openings/${openingId}`, {
    variationCount: existingVariations.length,
    updatedAt: now,
  });

  const response: OpeningsManageResponse = {
    success: true,
    message: 'Variation deleted successfully',
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
