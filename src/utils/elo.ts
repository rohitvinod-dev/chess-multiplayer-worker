/**
 * ELO Rating System Implementation for Cloudflare Workers
 * Ported from OpeningsTrainer/functions/elo.js
 * Standard ELO calculation following FIDE/Chess.com/Lichess standards
 */

export interface ELORating {
  rating: number;
  gamesPlayed: number;
  isProvisional: boolean;
}

export interface MatchResult {
  winner: 'white' | 'black' | 'draw';
  whitePlayer: ELORating;
  blackPlayer: ELORating;
}

export interface ELOUpdate {
  white: {
    oldRating: number;
    newRating: number;
    change: number;
    gamesPlayed: number;
    isProvisional: boolean;
  };
  black: {
    oldRating: number;
    newRating: number;
    change: number;
    gamesPlayed: number;
    isProvisional: boolean;
  };
}

/**
 * Calculate expected score for a player
 * @param playerRating - Current player rating
 * @param opponentRating - Opponent's rating
 * @returns Expected score (probability of winning, 0-1)
 */
function expectedScore(playerRating: number, opponentRating: number): number {
  return 1 / (1 + Math.pow(10, (opponentRating - playerRating) / 400));
}

/**
 * Get K-factor based on rating and games played
 * - Provisional players (< 30 games): K = 40
 * - Rating < 2100: K = 32
 * - Rating >= 2100 and < 2400: K = 24
 * - Rating >= 2400: K = 16
 */
function getKFactor(rating: number, gamesPlayed: number, isProvisional: boolean): number {
  // Provisional period: First 30 games use K=40 for faster rating adjustment
  if (isProvisional || gamesPlayed < 30) {
    return 40; // High volatility for new players
  }

  // Below 2100: K=32 (most players)
  if (rating < 2100) {
    return 32;
  }

  // 2100-2400: K=24 (strong players)
  if (rating < 2400) {
    return 24;
  }

  // Above 2400: K=16 (elite players, slower rating changes)
  return 16;
}

/**
 * Calculate new ELO ratings for both players after a match
 * @param result - Match result including player ratings and winner
 * @returns ELO updates for both players
 */
export function calculateELO(result: MatchResult): ELOUpdate {
  const { whitePlayer, blackPlayer, winner } = result;

  // Actual scores based on match result
  const whiteScore = winner === 'white' ? 1 : winner === 'draw' ? 0.5 : 0;
  const blackScore = winner === 'black' ? 1 : winner === 'draw' ? 0.5 : 0;

  // Expected scores (probability of winning)
  const whiteExpected = expectedScore(whitePlayer.rating, blackPlayer.rating);
  const blackExpected = expectedScore(blackPlayer.rating, whitePlayer.rating);

  // K-factors for both players
  const whiteK = getKFactor(
    whitePlayer.rating,
    whitePlayer.gamesPlayed,
    whitePlayer.isProvisional
  );
  const blackK = getKFactor(
    blackPlayer.rating,
    blackPlayer.gamesPlayed,
    blackPlayer.isProvisional
  );

  // Calculate rating changes
  const whiteChange = Math.round(whiteK * (whiteScore - whiteExpected));
  const blackChange = Math.round(blackK * (blackScore - blackExpected));

  // Calculate new ratings (minimum 100)
  const whiteNewRating = Math.max(100, whitePlayer.rating + whiteChange);
  const blackNewRating = Math.max(100, blackPlayer.rating + blackChange);

  // Update games played
  const whiteGamesPlayed = whitePlayer.gamesPlayed + 1;
  const blackGamesPlayed = blackPlayer.gamesPlayed + 1;

  // Check if still provisional (< 30 games)
  const whiteProvisional = whiteGamesPlayed < 30;
  const blackProvisional = blackGamesPlayed < 30;

  return {
    white: {
      oldRating: whitePlayer.rating,
      newRating: whiteNewRating,
      change: whiteChange,
      gamesPlayed: whiteGamesPlayed,
      isProvisional: whiteProvisional,
    },
    black: {
      oldRating: blackPlayer.rating,
      newRating: blackNewRating,
      change: blackChange,
      gamesPlayed: blackGamesPlayed,
      isProvisional: blackProvisional,
    },
  };
}

/**
 * Validate ELO rating is within reasonable bounds
 * @param elo - ELO rating to validate
 * @returns True if valid (between 100 and 4000)
 */
export function isValidElo(elo: number): boolean {
  return elo >= 100 && elo <= 4000 && Number.isFinite(elo);
}
