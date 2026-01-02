import { FirestoreClient } from '../../firestore';
import { calculateELO, type MatchResult } from '../../utils/elo';
import { syncUserToLeaderboards } from '../../utils/leaderboard';

/**
 * Helper function to generate PGN string from moves array
 */
function generatePgn(moves: string[]): string {
  if (!moves || moves.length === 0) return '';

  let pgn = '';
  for (let i = 0; i < moves.length; i++) {
    if (i % 2 === 0) {
      pgn += `${Math.floor(i / 2) + 1}. ${moves[i]} `;
    } else {
      pgn += `${moves[i]} `;
    }
  }
  return pgn.trim();
}

interface MatchResultRequest {
  matchId: string;
  whitePlayerId: string;
  blackPlayerId: string;
  winner: 'white' | 'black' | 'draw';
  moves: string[]; // PGN moves
  fen: string; // Final position
  duration: number; // Match duration in seconds
  opening?: string; // Opening name
  openingId?: string; // Opening ID
  timeControl?: 'blitz' | 'rapid' | 'classical'; // Time control type
  rated?: boolean; // Whether match is rated
  reason?: 'checkmate' | 'resignation' | 'time' | 'draw_agreement' | 'stalemate' | 'insufficient_material' | 'threefold_repetition' | 'fifty_move_rule'; // Game ending reason
}

export async function handleMatchResult(
  request: Request,
  firestore: FirestoreClient
): Promise<Response> {
  try {
    const body = await request.json() as MatchResultRequest;

    // Validate request
    if (!body.matchId || !body.whitePlayerId || !body.blackPlayerId) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Fetch current ratings for both players
    const whiteProfile = await firestore.getDocument(
      `users/${body.whitePlayerId}/profile/ratings`
    );
    const blackProfile = await firestore.getDocument(
      `users/${body.blackPlayerId}/profile/ratings`
    );

    if (!whiteProfile || !blackProfile) {
      return new Response(
        JSON.stringify({ error: 'Player profile not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Prepare match result for ELO calculation
    const matchResult: MatchResult = {
      winner: body.winner,
      whitePlayer: {
        rating: whiteProfile.elo || 1200,
        gamesPlayed: whiteProfile.eloGamesPlayed || 0,
        isProvisional: (whiteProfile.eloGamesPlayed || 0) < 30,
      },
      blackPlayer: {
        rating: blackProfile.elo || 1200,
        gamesPlayed: blackProfile.eloGamesPlayed || 0,
        isProvisional: (blackProfile.eloGamesPlayed || 0) < 30,
      },
    };

    // Calculate new ELO ratings
    const eloUpdate = calculateELO(matchResult);

    // Get user info for leaderboard sync
    // Username is stored in users/{uid}/public/data, not users/{uid}
    const whiteUser = await firestore.getDocument(`users/${body.whitePlayerId}/public/data`);
    const blackUser = await firestore.getDocument(`users/${body.blackPlayerId}/public/data`);

    // Prepare batch write operations
    const now = Date.now();
    const pgn = generatePgn(body.moves);

    // Calculate match statistics
    const whiteWins = (whiteProfile.wins || 0) + (body.winner === 'white' ? 1 : 0);
    const whiteLosses = (whiteProfile.losses || 0) + (body.winner === 'black' ? 1 : 0);
    const whiteDraws = (whiteProfile.draws || 0) + (body.winner === 'draw' ? 1 : 0);
    const whiteTotalGames = whiteWins + whiteLosses + whiteDraws;

    const blackWins = (blackProfile.wins || 0) + (body.winner === 'black' ? 1 : 0);
    const blackLosses = (blackProfile.losses || 0) + (body.winner === 'white' ? 1 : 0);
    const blackDraws = (blackProfile.draws || 0) + (body.winner === 'draw' ? 1 : 0);
    const blackTotalGames = blackWins + blackLosses + blackDraws;

    const writes = [
      // Update white player's rating and match statistics
      {
        type: 'update' as const,
        path: `users/${body.whitePlayerId}/profile/ratings`,
        data: {
          elo: eloUpdate.white.newRating,
          eloGamesPlayed: eloUpdate.white.gamesPlayed,
          wins: whiteWins,
          losses: whiteLosses,
          draws: whiteDraws,
          totalGames: whiteTotalGames,
          lastMatchAt: now,
        },
      },
      // Update black player's rating and match statistics
      {
        type: 'update' as const,
        path: `users/${body.blackPlayerId}/profile/ratings`,
        data: {
          elo: eloUpdate.black.newRating,
          eloGamesPlayed: eloUpdate.black.gamesPlayed,
          wins: blackWins,
          losses: blackLosses,
          draws: blackDraws,
          totalGames: blackTotalGames,
          lastMatchAt: now,
        },
      },
      // Create white player's match history entry (from white's perspective)
      {
        type: 'set' as const,
        path: `users/${body.whitePlayerId}/matchHistory/${body.matchId}`,
        data: {
          matchId: body.matchId,
          opponent: {
            userId: body.blackPlayerId,
            username: blackUser?.username || 'Unknown',
            rating: eloUpdate.black.oldRating,
          },
          opening: body.opening || 'Unknown',
          openingId: body.openingId || null,
          timeControl: body.timeControl || 'blitz',
          rated: body.rated !== false,
          result: body.winner === 'white' ? 'win' : (body.winner === 'draw' ? 'draw' : 'loss'),
          reason: body.reason || 'unknown',
          playerRatingBefore: eloUpdate.white.oldRating,
          playerRatingAfter: eloUpdate.white.newRating,
          ratingChange: eloUpdate.white.change,
          opponentRatingBefore: eloUpdate.black.oldRating,
          opponentRatingAfter: eloUpdate.black.newRating,
          pgn: pgn,
          fen: body.fen,
          moves: body.moves,
          duration: body.duration,
          playedAt: now,
          createdAt: now,
        },
      },
      // Create black player's match history entry (from black's perspective)
      {
        type: 'set' as const,
        path: `users/${body.blackPlayerId}/matchHistory/${body.matchId}`,
        data: {
          matchId: body.matchId,
          opponent: {
            userId: body.whitePlayerId,
            username: whiteUser?.username || 'Unknown',
            rating: eloUpdate.white.oldRating,
          },
          opening: body.opening || 'Unknown',
          openingId: body.openingId || null,
          timeControl: body.timeControl || 'blitz',
          rated: body.rated !== false,
          result: body.winner === 'black' ? 'win' : (body.winner === 'draw' ? 'draw' : 'loss'),
          reason: body.reason || 'unknown',
          playerRatingBefore: eloUpdate.black.oldRating,
          playerRatingAfter: eloUpdate.black.newRating,
          ratingChange: eloUpdate.black.change,
          opponentRatingBefore: eloUpdate.white.oldRating,
          opponentRatingAfter: eloUpdate.white.newRating,
          pgn: pgn,
          fen: body.fen,
          moves: body.moves,
          duration: body.duration,
          playedAt: now,
          createdAt: now,
        },
      },
    ];

    // Execute batch write
    await firestore.batchWrite(writes);

    // Sync to leaderboards (using new leaderboard structure with full stats)
    await Promise.all([
      syncUserToLeaderboards(firestore, body.whitePlayerId, {
        username: whiteUser?.username,
        displayName: whiteUser?.displayName,
        photoUrl: whiteUser?.photoUrl,
        eloRating: eloUpdate.white.newRating,
        wins: whiteWins,
        losses: whiteLosses,
        draws: whiteDraws,
        totalGames: whiteTotalGames,
      }),
      syncUserToLeaderboards(firestore, body.blackPlayerId, {
        username: blackUser?.username,
        displayName: blackUser?.displayName,
        photoUrl: blackUser?.photoUrl,
        eloRating: eloUpdate.black.newRating,
        wins: blackWins,
        losses: blackLosses,
        draws: blackDraws,
        totalGames: blackTotalGames,
      }),
    ]);

    console.log(`Match result processed: ${body.matchId}`);
    console.log(`White: ${eloUpdate.white.oldRating} → ${eloUpdate.white.newRating} (${eloUpdate.white.change > 0 ? '+' : ''}${eloUpdate.white.change})`);
    console.log(`Black: ${eloUpdate.black.oldRating} → ${eloUpdate.black.newRating} (${eloUpdate.black.change > 0 ? '+' : ''}${eloUpdate.black.change})`);

    return new Response(
      JSON.stringify({
        success: true,
        white: {
          newRating: eloUpdate.white.newRating,
          change: eloUpdate.white.change,
        },
        black: {
          newRating: eloUpdate.black.newRating,
          change: eloUpdate.black.change,
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error processing match result:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error', message: String(error) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
