/**
 * POST /api/progress/puzzle-trouble
 *
 * Records a Puzzle Trouble session result and updates the leaderboard with the high score.
 * This endpoint:
 * - Updates puzzleTroubleBest if the new score is higher
 * - Increments puzzleTroubleSessions count
 * - Syncs to the unified leaderboard collection
 */

import type { FirestoreClient } from '../../firestore';
import type { AuthenticatedUser } from '../../types';
import { syncUserToLeaderboard } from '../../utils/leaderboard';

interface PuzzleTroubleSubmitRequest {
  puzzlesSolved: number;
}

export async function handlePuzzleTroubleSubmit(
  request: Request,
  firestore: FirestoreClient,
  user: AuthenticatedUser
): Promise<Response> {
  try {
    const body = await request.json() as PuzzleTroubleSubmitRequest;

    // Validate input
    if (typeof body.puzzlesSolved !== 'number' || body.puzzlesSolved < 0) {
      return new Response(
        JSON.stringify({ error: 'Invalid puzzlesSolved value' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const userId = user.uid;
    const puzzlesSolved = body.puzzlesSolved;

    // Get current leaderboard entry
    const leaderboardPath = `leaderboard/${userId}`;
    const currentEntry = await firestore.getDocument(leaderboardPath);

    const currentBest = (currentEntry?.puzzleTroubleBest as number) || 0;
    const currentSessions = (currentEntry?.puzzleTroubleSessions as number) || 0;

    // Determine if this is a new high score
    const isNewHighScore = puzzlesSolved > currentBest;
    const newBest = isNewHighScore ? puzzlesSolved : currentBest;
    const newSessions = currentSessions + 1;

    // Update leaderboard using the centralized sync function
    await syncUserToLeaderboard(firestore, userId, {
      puzzleTroubleBest: newBest,
      puzzleTroubleSessions: newSessions,
    });

    console.log(`[PuzzleTrouble] Updated for ${userId}: best=${newBest}, sessions=${newSessions}, isNewHighScore=${isNewHighScore}`);

    return new Response(
      JSON.stringify({
        success: true,
        puzzleTroubleBest: newBest,
        puzzleTroubleSessions: newSessions,
        isNewHighScore,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error submitting Puzzle Trouble result:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error', message: String(error) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
