import { FirestoreClient } from '../../firestore';
import { calculateELO, type MatchResult } from '../../utils/elo';
import { syncUserToLeaderboard } from '../../utils/leaderboard';

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

type TimeControl = 'bullet' | 'blitz' | 'rapid' | 'classical';

// New field names (preferred)
interface MatchResultRequest {
  matchId: string;
  whitePlayerId?: string;
  blackPlayerId?: string;
  winner?: 'white' | 'black' | 'draw';
  moves?: string[]; // PGN moves
  fen?: string; // Final position
  duration?: number; // Match duration in seconds
  opening?: string; // Opening name
  openingId?: string; // Opening ID
  timeControl?: TimeControl; // Time control type
  rated?: boolean; // Whether match is rated
  reason?: 'checkmate' | 'resignation' | 'time' | 'draw_agreement' | 'stalemate' | 'insufficient_material' | 'threefold_repetition' | 'fifty_move_rule'; // Game ending reason
  // Legacy field names (for backward compatibility with old Flutter clients)
  player1Id?: string;
  player2Id?: string;
  winnerId?: string | null;
  gameMode?: string;
}

/**
 * Get the ELO field names for a specific time control
 * Note: 'bullet' is treated as 'blitz' for rating purposes
 */
function getEloFieldsForMode(mode: TimeControl): {
  eloField: string;
  winsField: string;
  lossesField: string;
  drawsField: string;
  gamesField: string;
} {
  switch (mode) {
    case 'bullet':
    case 'blitz':
      return {
        eloField: 'blitzElo',
        winsField: 'blitzWins',
        lossesField: 'blitzLosses',
        drawsField: 'blitzDraws',
        gamesField: 'blitzGamesPlayed',
      };
    case 'rapid':
      return {
        eloField: 'rapidElo',
        winsField: 'rapidWins',
        lossesField: 'rapidLosses',
        drawsField: 'rapidDraws',
        gamesField: 'rapidGamesPlayed',
      };
    case 'classical':
      return {
        eloField: 'classicalElo',
        winsField: 'classicalWins',
        lossesField: 'classicalLosses',
        drawsField: 'classicalDraws',
        gamesField: 'classicalGamesPlayed',
      };
  }
}

export async function handleMatchResult(
  request: Request,
  firestore: FirestoreClient
): Promise<Response> {
  try {
    const body = await request.json() as MatchResultRequest;

    // Map legacy field names to new names (backward compatibility)
    // player1Id -> whitePlayerId, player2Id -> blackPlayerId
    const whitePlayerId = body.whitePlayerId || body.player1Id;
    const blackPlayerId = body.blackPlayerId || body.player2Id;

    // Map winnerId to winner ('white' | 'black' | 'draw')
    let winner: 'white' | 'black' | 'draw' = body.winner || 'draw';
    if (!body.winner && body.winnerId !== undefined) {
      if (body.winnerId === null) {
        winner = 'draw';
      } else if (body.winnerId === whitePlayerId) {
        winner = 'white';
      } else {
        winner = 'black';
      }
    }

    // Map gameMode to timeControl
    let timeControlRaw = body.timeControl || body.gameMode || 'blitz';
    // Normalize bullet to blitz
    if (timeControlRaw === 'bullet') {
      timeControlRaw = 'blitz';
    }

    // Validate request
    if (!body.matchId || !whitePlayerId || !blackPlayerId) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Validate timeControl is a valid value
    const validTimeControls = ['blitz', 'rapid', 'classical'];
    const timeControl: TimeControl = validTimeControls.includes(timeControlRaw)
      ? timeControlRaw as TimeControl
      : 'blitz';
    const modeFields = getEloFieldsForMode(timeControl);

    // Fetch current ratings and leaderboard entries for both players
    const [whiteProfile, blackProfile, whiteLeaderboard, blackLeaderboard] = await Promise.all([
      firestore.getDocument(`users/${whitePlayerId}/profile/ratings`),
      firestore.getDocument(`users/${blackPlayerId}/profile/ratings`),
      firestore.getDocument(`leaderboard/${whitePlayerId}`),
      firestore.getDocument(`leaderboard/${blackPlayerId}`),
    ]);

    if (!whiteProfile || !blackProfile) {
      return new Response(
        JSON.stringify({ error: 'Player profile not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Get per-mode ELO (from leaderboard which has the per-mode fields)
    const whiteCurrentElo = (whiteLeaderboard?.[modeFields.eloField] as number) || 1200;
    const blackCurrentElo = (blackLeaderboard?.[modeFields.eloField] as number) || 1200;
    const whiteGamesInMode = (whiteLeaderboard?.[modeFields.gamesField] as number) || 0;
    const blackGamesInMode = (blackLeaderboard?.[modeFields.gamesField] as number) || 0;

    // Prepare match result for ELO calculation
    const matchResult: MatchResult = {
      winner: winner,
      whitePlayer: {
        rating: whiteCurrentElo,
        gamesPlayed: whiteGamesInMode,
        isProvisional: whiteGamesInMode < 30,
      },
      blackPlayer: {
        rating: blackCurrentElo,
        gamesPlayed: blackGamesInMode,
        isProvisional: blackGamesInMode < 30,
      },
    };

    // Calculate new ELO ratings
    const eloUpdate = calculateELO(matchResult);

    // Get user info for leaderboard sync
    const [whiteUser, blackUser] = await Promise.all([
      firestore.getDocument(`users/${whitePlayerId}/public/data`),
      firestore.getDocument(`users/${blackPlayerId}/public/data`),
    ]);

    // Prepare batch write operations
    const now = Date.now();
    const pgn = generatePgn(body.moves);

    // Calculate per-mode stats
    const whiteModeWins = ((whiteLeaderboard?.[modeFields.winsField] as number) || 0) + (winner === 'white' ? 1 : 0);
    const whiteModeLosses = ((whiteLeaderboard?.[modeFields.lossesField] as number) || 0) + (winner === 'black' ? 1 : 0);
    const whiteModeDraws = ((whiteLeaderboard?.[modeFields.drawsField] as number) || 0) + (winner === 'draw' ? 1 : 0);
    const whiteModeGames = whiteModeWins + whiteModeLosses + whiteModeDraws;

    const blackModeWins = ((blackLeaderboard?.[modeFields.winsField] as number) || 0) + (winner === 'black' ? 1 : 0);
    const blackModeLosses = ((blackLeaderboard?.[modeFields.lossesField] as number) || 0) + (winner === 'white' ? 1 : 0);
    const blackModeDraws = ((blackLeaderboard?.[modeFields.drawsField] as number) || 0) + (winner === 'draw' ? 1 : 0);
    const blackModeGames = blackModeWins + blackModeLosses + blackModeDraws;

    // Calculate total stats across all modes (legacy fields)
    const whiteTotalWins = (whiteProfile.wins || 0) + (winner === 'white' ? 1 : 0);
    const whiteTotalLosses = (whiteProfile.losses || 0) + (winner === 'black' ? 1 : 0);
    const whiteTotalDraws = (whiteProfile.draws || 0) + (winner === 'draw' ? 1 : 0);
    const whiteTotalGames = whiteTotalWins + whiteTotalLosses + whiteTotalDraws;

    const blackTotalWins = (blackProfile.wins || 0) + (winner === 'black' ? 1 : 0);
    const blackTotalLosses = (blackProfile.losses || 0) + (winner === 'white' ? 1 : 0);
    const blackTotalDraws = (blackProfile.draws || 0) + (winner === 'draw' ? 1 : 0);
    const blackTotalGames = blackTotalWins + blackTotalLosses + blackTotalDraws;

    // Calculate bestElo (max of all modes after update)
    const whiteBlitzElo = timeControl === 'blitz' ? eloUpdate.white.newRating : ((whiteLeaderboard?.blitzElo as number) || 1200);
    const whiteRapidElo = timeControl === 'rapid' ? eloUpdate.white.newRating : ((whiteLeaderboard?.rapidElo as number) || 1200);
    const whiteClassicalElo = timeControl === 'classical' ? eloUpdate.white.newRating : ((whiteLeaderboard?.classicalElo as number) || 1200);
    const whiteBestElo = Math.max(whiteBlitzElo, whiteRapidElo, whiteClassicalElo);

    const blackBlitzElo = timeControl === 'blitz' ? eloUpdate.black.newRating : ((blackLeaderboard?.blitzElo as number) || 1200);
    const blackRapidElo = timeControl === 'rapid' ? eloUpdate.black.newRating : ((blackLeaderboard?.rapidElo as number) || 1200);
    const blackClassicalElo = timeControl === 'classical' ? eloUpdate.black.newRating : ((blackLeaderboard?.classicalElo as number) || 1200);
    const blackBestElo = Math.max(blackBlitzElo, blackRapidElo, blackClassicalElo);

    const writes = [
      // Update white player's rating and match statistics (legacy profile)
      {
        type: 'update' as const,
        path: `users/${whitePlayerId}/profile/ratings`,
        data: {
          elo: eloUpdate.white.newRating, // Legacy single ELO field
          eloGamesPlayed: (whiteProfile.eloGamesPlayed || 0) + 1,
          wins: whiteTotalWins,
          losses: whiteTotalLosses,
          draws: whiteTotalDraws,
          totalGames: whiteTotalGames,
          lastMatchAt: now,
        },
      },
      // Update black player's rating and match statistics (legacy profile)
      {
        type: 'update' as const,
        path: `users/${blackPlayerId}/profile/ratings`,
        data: {
          elo: eloUpdate.black.newRating, // Legacy single ELO field
          eloGamesPlayed: (blackProfile.eloGamesPlayed || 0) + 1,
          wins: blackTotalWins,
          losses: blackTotalLosses,
          draws: blackTotalDraws,
          totalGames: blackTotalGames,
          lastMatchAt: now,
        },
      },
      // Create white player's match history entry
      {
        type: 'set' as const,
        path: `users/${whitePlayerId}/matchHistory/${body.matchId}`,
        data: {
          matchId: body.matchId,
          opponent: {
            userId: blackPlayerId,
            username: blackUser?.username || 'Unknown',
            rating: eloUpdate.black.oldRating,
          },
          opening: body.opening || 'Unknown',
          openingId: body.openingId || null,
          timeControl: timeControl,
          rated: body.rated !== false,
          result: winner === 'white' ? 'win' : (winner === 'draw' ? 'draw' : 'loss'),
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
      // Create black player's match history entry
      {
        type: 'set' as const,
        path: `users/${blackPlayerId}/matchHistory/${body.matchId}`,
        data: {
          matchId: body.matchId,
          opponent: {
            userId: whitePlayerId,
            username: whiteUser?.username || 'Unknown',
            rating: eloUpdate.white.oldRating,
          },
          opening: body.opening || 'Unknown',
          openingId: body.openingId || null,
          timeControl: timeControl,
          rated: body.rated !== false,
          result: winner === 'black' ? 'win' : (winner === 'draw' ? 'draw' : 'loss'),
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

    // Build per-mode leaderboard update for white player
    const whiteLeaderboardUpdate: any = {
      username: whiteUser?.username,
      displayName: whiteUser?.displayName,
      photoUrl: whiteUser?.photoUrl,
      countryCode: whiteUser?.countryCode || whiteLeaderboard?.countryCode,
      // Per-mode ELO
      [modeFields.eloField]: eloUpdate.white.newRating,
      [modeFields.winsField]: whiteModeWins,
      [modeFields.lossesField]: whiteModeLosses,
      [modeFields.drawsField]: whiteModeDraws,
      [modeFields.gamesField]: whiteModeGames,
      // Best ELO
      bestElo: whiteBestElo,
      // Legacy fields
      eloRating: eloUpdate.white.newRating,
      wins: whiteTotalWins,
      losses: whiteTotalLosses,
      draws: whiteTotalDraws,
      totalGamesPlayed: whiteTotalGames,
    };

    // Build per-mode leaderboard update for black player
    const blackLeaderboardUpdate: any = {
      username: blackUser?.username,
      displayName: blackUser?.displayName,
      photoUrl: blackUser?.photoUrl,
      countryCode: blackUser?.countryCode || blackLeaderboard?.countryCode,
      // Per-mode ELO
      [modeFields.eloField]: eloUpdate.black.newRating,
      [modeFields.winsField]: blackModeWins,
      [modeFields.lossesField]: blackModeLosses,
      [modeFields.drawsField]: blackModeDraws,
      [modeFields.gamesField]: blackModeGames,
      // Best ELO
      bestElo: blackBestElo,
      // Legacy fields
      eloRating: eloUpdate.black.newRating,
      wins: blackTotalWins,
      losses: blackTotalLosses,
      draws: blackTotalDraws,
      totalGamesPlayed: blackTotalGames,
    };

    // Sync to leaderboards with per-mode data
    await Promise.all([
      syncUserToLeaderboard(firestore, whitePlayerId, whiteLeaderboardUpdate),
      syncUserToLeaderboard(firestore, blackPlayerId, blackLeaderboardUpdate),
    ]);

    console.log(`[${timeControl.toUpperCase()}] Match result processed: ${body.matchId}`);
    console.log(`White: ${eloUpdate.white.oldRating} → ${eloUpdate.white.newRating} (${eloUpdate.white.change > 0 ? '+' : ''}${eloUpdate.white.change})`);
    console.log(`Black: ${eloUpdate.black.oldRating} → ${eloUpdate.black.newRating} (${eloUpdate.black.change > 0 ? '+' : ''}${eloUpdate.black.change})`);

    return new Response(
      JSON.stringify({
        success: true,
        timeControl: timeControl,
        white: {
          newRating: eloUpdate.white.newRating,
          change: eloUpdate.white.change,
          bestElo: whiteBestElo,
        },
        black: {
          newRating: eloUpdate.black.newRating,
          change: eloUpdate.black.change,
          bestElo: blackBestElo,
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
