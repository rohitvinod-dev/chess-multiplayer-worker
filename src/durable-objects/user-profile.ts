/**
 * UserProfile Durable Object
 *
 * Manages user state with strong consistency:
 * - Progress tracking (mastery levels, learn progress)
 * - Energy management
 * - Streak tracking
 * - Event deduplication via SQLite
 *
 * Each user gets their own instance of this Durable Object.
 */

import type {
  ProgressMap,
  ProgressType,
  ProgressEventPayload,
  RecordProgressEventRequest,
  UserProfile,
  EnergyState,
  StreakInfo,
  FirestoreDocument,
} from '../types';
import { POINTS_CONFIG, ENERGY_CONFIG, ApiError, ErrorCodes } from '../types';
import {
  analyzeProgressMap,
  computeProgressStats,
  computeCombinedProgressStats,
  variationIdFromKey,
  openingIdFromKey,
  clamp,
  toDateTime,
  startOfLocalDay,
  formatTimestamp,
  formatDateKey,
  getEnergyState,
  applyEnergyReward,
  serializeEnergyState,
  calculateStreak,
} from '../utils/mastery';
import type { ModeProgress } from '../utils/mastery';
import { FirestoreClient } from '../firestore';

interface Env {
  FIREBASE_PROJECT_ID: string;
  FIREBASE_SERVICE_ACCOUNT: string;
}

export class UserProfile {
  private state: DurableObjectState;
  private env: Env;
  private sql: SqlStorage;
  private userId: string | null;
  private firestore: FirestoreClient;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;

    // UserId will be set from the first request
    // We can't extract it from state.id because idFromName() hashes the input
    this.userId = null;

    // Initialize Firestore client
    this.firestore = new FirestoreClient({
      projectId: env.FIREBASE_PROJECT_ID,
      serviceAccount: env.FIREBASE_SERVICE_ACCOUNT,
    });

    this.initializeDatabase();
  }

  /**
   * Initialize SQLite tables for event deduplication
   */
  private initializeDatabase(): void {
    // Progress events table for deduplication
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS progress_events (
        event_id TEXT PRIMARY KEY,
        processed_at INTEGER NOT NULL,
        variation_key TEXT NOT NULL,
        progress_type TEXT NOT NULL,
        previous_level INTEGER NOT NULL,
        new_level INTEGER NOT NULL,
        delta INTEGER NOT NULL,
        points_awarded INTEGER NOT NULL
      )
    `);

    // Index for cleanup
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_processed_at
      ON progress_events(processed_at)
    `);
  }

  /**
   * Check if event was already processed (deduplication)
   */
  private isEventProcessed(eventId: string): boolean {
    const result = this.sql.exec(
      `SELECT event_id FROM progress_events WHERE event_id = ?`,
      eventId
    );
    return result.toArray().length > 0;
  }

  /**
   * Record processed event for deduplication
   */
  private recordProcessedEvent(
    eventId: string,
    payload: Partial<ProgressEventPayload>
  ): void {
    this.sql.exec(
      `INSERT INTO progress_events
       (event_id, processed_at, variation_key, progress_type, previous_level, new_level, delta, points_awarded)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      eventId,
      Date.now(),
      payload.variationKey || '',
      payload.progressType || '',
      payload.previousLevel || 0,
      payload.newLevel || 0,
      payload.delta || 0,
      payload.pointsAwarded || 0
    );
  }

  /**
   * Cleanup old events (keep last 7 days)
   */
  private cleanupOldEvents(): void {
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    this.sql.exec(
      `DELETE FROM progress_events WHERE processed_at < ?`,
      sevenDaysAgo
    );
  }

  /**
   * Handle incoming requests
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      // Record progress event
      if (url.pathname === '/progress/record' && request.method === 'POST') {
        const body = await request.json() as RecordProgressEventRequest & { userId: string };
        // Set userId from request (first time initialization)
        if (!this.userId) {
          this.userId = body.userId;
        }
        const result = await this.recordProgress(body);
        return Response.json(result);
      }

      // Claim energy reward
      if (url.pathname === '/energy/claim' && request.method === 'POST') {
        const body = await request.json() as {
          source: 'dailyStreak';
          userId: string;
        };
        // Set userId from request (first time initialization)
        if (!this.userId) {
          this.userId = body.userId;
        }
        const result = await this.claimEnergyReward(body.source);
        return Response.json(result);
      }

      return Response.json({ error: 'Not found' }, { status: 404 });
    } catch (error) {
      console.error('UserProfile error:', error);
      if (error instanceof ApiError) {
        return Response.json(
          { error: error.message, code: error.code },
          { status: error.statusCode }
        );
      }
      return Response.json(
        { error: 'Internal server error', message: String(error) },
        { status: 500 }
      );
    }
  }

  /**
   * Record progress event
   * Port of recordProgressEvent from Firebase Functions
   * NOW SUPPORTS MODE-SPECIFIC TRACKING (focused vs explore)
   */
  private async recordProgress(data: RecordProgressEventRequest): Promise<any> {
    const { variationKey, progressType, newLevel, delta, eventId, mode, totalSystemLines } = data;
    const firestore = this.firestore;
    const userId = this.userId!; // Non-null assertion - we set this in fetch()

    // Log key request details for monitoring
    console.log(`[UserProfile] Recording ${progressType} progress for ${mode} mode: ${variationKey}`);

    // Validate inputs
    if (!variationKey || !variationKey.trim()) {
      throw new ApiError(ErrorCodes.INVALID_ARGUMENT, 'A variationKey is required.');
    }

    // Reject legacy hash-based keys (format: "var_xxxxxxxxxxxx") from old implementation
    // These should not be written to Firestore as they break opening name extraction
    if (variationKey.startsWith('var_')) {
      console.warn(`[UserProfile] Rejecting legacy hash-based variationKey: ${variationKey}`);
      throw new ApiError(
        ErrorCodes.INVALID_ARGUMENT,
        'Legacy hash-based variation keys are not supported. Please update your app.'
      );
    }

    if (!progressType || !['learn', 'mastery'].includes(progressType)) {
      throw new ApiError(
        ErrorCodes.INVALID_ARGUMENT,
        'progressType must be "learn" or "mastery".'
      );
    }

    // Default to focused mode for backward compatibility
    const trainingMode = mode || 'focused';

    // Check for duplicate event
    if (eventId) {
      this.cleanupOldEvents();
      if (this.isEventProcessed(eventId)) {
        console.log(`Event ${eventId} already processed, returning cached result`);
        const cached = this.sql.exec(
          `SELECT * FROM progress_events WHERE event_id = ?`,
          eventId
        ).toArray()[0];
        return {
          alreadyProcessed: true,
          event: cached,
        };
      }
    }

    const now = new Date();

    // Load user profile from Firestore
    const userData = await firestore.getDocument(`users/${userId}`);
    if (!userData) {
      console.error(`[UserProfile] User profile not found: ${userId}`);
      throw new ApiError(
        ErrorCodes.FAILED_PRECONDITION,
        'User profile does not exist yet.'
      );
    }

    // Read mode-specific progress data (CLEAN SCHEMA - prefixed fields)
    // Only 2 fields per mode: progressMap (mastery) and learnProgressMap (learn)
    // firstAttemptMap and openingProgress are REMOVED as they are redundant
    const progressMapKey = `${trainingMode}_progressMap`;
    const learnProgressMapKey = `${trainingMode}_learnProgressMap`;

    // DEBUG: Log what's coming from Firestore
    console.log(`[UserProfile] Raw ${learnProgressMapKey} from Firestore:`, JSON.stringify(userData[learnProgressMapKey] || {}));

    let progressMap: ProgressMap = { ...(userData[progressMapKey] || {}) };
    let learnProgressMap: ProgressMap = { ...(userData[learnProgressMapKey] || {}) };

    // BACKWARD COMPATIBILITY: If prefixed fields don't exist, try legacy fields
    if (Object.keys(progressMap).length === 0 && trainingMode === 'focused') {
      progressMap = { ...(userData.progressMap || {}) };
      learnProgressMap = { ...(userData.learnProgressMap || {}) };
      if (Object.keys(learnProgressMap).length > 0) {
        console.log(`[UserProfile] Using legacy fields, found ${Object.keys(learnProgressMap).length} entries`);
      }
    }

    // Filter out legacy hash-based keys (format: "var_xxxxxxxxxxxx") to prevent
    // them from corrupting opening name extraction and stats calculation
    progressMap = Object.fromEntries(
      Object.entries(progressMap).filter(([key]) => !key.startsWith('var_'))
    );
    learnProgressMap = Object.fromEntries(
      Object.entries(learnProgressMap).filter(([key]) => !key.startsWith('var_'))
    );

    console.log(`[UserProfile] After filtering: ${Object.keys(progressMap).length} mastery + ${Object.keys(learnProgressMap).length} learn entries`);
    console.log(`[UserProfile] Current learn entries:`, Object.keys(learnProgressMap));

    // Determine target map
    const targetMap = progressType === 'mastery' ? progressMap : learnProgressMap;
    const previousLevel = clamp(parseInt(String(targetMap[variationKey]), 10) || 0, 0, 3);

    console.log(`[UserProfile] Points Debug: variationKey=${variationKey}, progressType=${progressType}`);
    console.log(`[UserProfile] Points Debug: previousLevel=${previousLevel}, targetMap[key]=${targetMap[variationKey]}`);
    console.log(`[UserProfile] Points Debug: incoming delta=${delta}, newLevel=${newLevel}`);

    // Calculate delta
    let finalDelta: number;
    if (delta !== null && delta !== undefined) {
      if (Math.abs(delta) > 1) {
        throw new ApiError(ErrorCodes.INVALID_ARGUMENT, 'delta must be -1, 0, or 1.');
      }
      finalDelta = delta;
    } else if (newLevel !== null && newLevel !== undefined) {
      const requestedLevel = clamp(parseInt(String(newLevel), 10) || 0, 0, 3);
      finalDelta = requestedLevel - previousLevel;
    } else {
      throw new ApiError(
        ErrorCodes.INVALID_ARGUMENT,
        'Either newLevel or delta must be provided.'
      );
    }

    console.log(`[UserProfile] Points Debug: calculated finalDelta=${finalDelta}`);

    // No change - early return
    if (finalDelta === 0) {
      console.log(`[UserProfile] Points Debug: EARLY RETURN - no change (finalDelta=0)`);
      return {
        alreadyProcessed: true,
        payload: {
          variationKey,
          progressType,
          previousLevel,
          newLevel: previousLevel,
        },
      };
    }

    // Validate new level
    const finalNewLevel = previousLevel + finalDelta;
    if (finalNewLevel < 0 || finalNewLevel > 3) {
      throw new ApiError(
        ErrorCodes.INVALID_ARGUMENT,
        'Resulting level must be between 0 and 3.'
      );
    }

    // Analyze progress BEFORE update
    const oldMasteryAnalysis = analyzeProgressMap(progressMap);
    const oldLearnAnalysis = analyzeProgressMap(learnProgressMap);

    // Apply update
    targetMap[variationKey] = finalNewLevel;

    // Analyze progress AFTER update
    const newMasteryAnalysis = analyzeProgressMap(progressMap);
    const newLearnAnalysis = analyzeProgressMap(learnProgressMap);

    const variationId = variationIdFromKey(variationKey);
    const openingId = openingIdFromKey(variationKey);

    // Calculate points
    const config = POINTS_CONFIG[progressType];
    let pointsAwarded = 0;
    let variationBonusAwarded = false;
    let openingBonusAwarded = false;

    if (finalDelta > 0) {
      pointsAwarded += config.base * finalDelta;

      // Completion bonus
      if (finalNewLevel === 3) {
        pointsAwarded += config.completionBonus;
      }

      // Variation completion bonus
      const variationCompleteBefore =
        progressType === 'mastery'
          ? oldMasteryAnalysis.isVariationComplete(variationId)
          : oldLearnAnalysis.isVariationComplete(variationId);
      const variationCompleteAfter =
        progressType === 'mastery'
          ? newMasteryAnalysis.isVariationComplete(variationId)
          : newLearnAnalysis.isVariationComplete(variationId);
      if (!variationCompleteBefore && variationCompleteAfter) {
        variationBonusAwarded = true;
        pointsAwarded += config.variationBonus;
      }

      // Opening completion bonus
      const openingCompleteBefore =
        progressType === 'mastery'
          ? oldMasteryAnalysis.isOpeningComplete(openingId)
          : oldLearnAnalysis.isOpeningComplete(openingId);
      const openingCompleteAfter =
        progressType === 'mastery'
          ? newMasteryAnalysis.isOpeningComplete(openingId)
          : newLearnAnalysis.isOpeningComplete(openingId);
      if (!openingCompleteBefore && openingCompleteAfter) {
        openingBonusAwarded = true;
        pointsAwarded += config.openingBonus;
      }
    }

    console.log(`[UserProfile] Points Debug: finalNewLevel=${finalNewLevel}, pointsAwarded=${pointsAwarded}`);
    console.log(`[UserProfile] Points Debug: variationBonus=${variationBonusAwarded}, openingBonus=${openingBonusAwarded}`);

    // NOTE: firstAttemptMap removed - first attempt can be derived from progress level
    // (previousLevel === 0 && finalNewLevel > 0 means first attempt)

    // Build mode progress data for combined calculation
    // We need to read the OTHER mode's progress to compute combined stats
    // Also filter out legacy hash keys from the other mode's data
    const filterHashKeys = (map: ProgressMap): ProgressMap =>
      Object.fromEntries(Object.entries(map).filter(([key]) => !key.startsWith('var_')));

    const focusedMode: ModeProgress = trainingMode === 'focused'
      ? { progressMap, learnProgressMap }
      : {
          progressMap: filterHashKeys({ ...(userData.focused_progressMap || userData.progressMap || {}) }),
          learnProgressMap: filterHashKeys({ ...(userData.focused_learnProgressMap || userData.learnProgressMap || {}) }),
        };

    const exploreMode: ModeProgress = trainingMode === 'explore'
      ? { progressMap, learnProgressMap }
      : {
          progressMap: filterHashKeys({ ...(userData.explore_progressMap || {}) }),
          learnProgressMap: filterHashKeys({ ...(userData.explore_learnProgressMap || {}) }),
        };

    // Calculate COMBINED stats: 50% Focused + 50% Explore
    // totalSystemLines is REQUIRED for accurate percentage calculation
    // Use provided value, cached value, or fallback to 250 (total lines across 20 openings)
    const DEFAULT_TOTAL_SYSTEM_LINES = 250;
    const cachedValue = parseInt(String(userData.cachedTotalSystemLines), 10) || 0;
    const effectiveTotalLines = totalSystemLines || cachedValue || DEFAULT_TOTAL_SYSTEM_LINES;

    const stats = computeCombinedProgressStats(focusedMode, exploreMode, effectiveTotalLines);

    // CRITICAL FIX: Use updateMapKey to update ONLY the specific variation key
    // This prevents overwriting other openings' progress when updating one opening
    const targetMapField = progressType === 'mastery'
      ? `${trainingMode}_progressMap`
      : `${trainingMode}_learnProgressMap`;

    console.log(`[UserProfile] Updating ${targetMapField}["${variationKey}"] = ${finalNewLevel}`);

    // Update the specific key in the map (atomic, doesn't affect other keys)
    await firestore.updateMapKey(
      `users/${userId}`,
      targetMapField,
      variationKey,
      finalNewLevel
    );

    // Prepare other user updates (stats, points, etc.) - NOT the progress maps
    const userUpdates: any = {
      // COMPUTED stats - SINGLE SOURCE OF TRUTH (Flutter just reads these)
      masteredVariations: stats.masteredVariations,
      totalVariations: stats.totalVariations,
      openingsMasteredCount: stats.openingsMasteredCount,
      totalOpeningsCount: stats.totalOpeningsCount,
      overallMasteryPercentage: stats.overallMasteryPercentage,
      focusedMasteryPercentage: stats.focusedMasteryPercentage,
      exploreMasteryPercentage: stats.exploreMasteryPercentage,
      strongestOpening: stats.strongestOpening,
      weakestOpening: stats.weakestOpening,

      // Timestamp - ISO format for analytics readability
      updatedAt: formatTimestamp(now),
    };

    // Cache totalSystemLines for future calculations if provided
    // This ensures consistent mastery % even when Flutter doesn't send it
    if (totalSystemLines && totalSystemLines > 0) {
      userUpdates.cachedTotalSystemLines = totalSystemLines;
    }

    // NOTE: Backward compatibility writes REMOVED as of Dec 2025
    // Old clients should have been updated by now

    // Increment points
    if (finalDelta > 0) {
      const currentTotalPoints = parseInt(String(userData.totalPoints), 10) || 0;
      const currentMasteryPoints = parseInt(String(userData.masteryPoints), 10) || 0;
      const currentLearnPoints = parseInt(String(userData.learnPoints), 10) || 0;

      console.log(`[UserProfile] Points Debug: currentTotalPoints=${currentTotalPoints}, adding=${pointsAwarded}`);

      userUpdates.totalPoints = currentTotalPoints + pointsAwarded;
      if (progressType === 'learn') {
        userUpdates.learnPoints = currentLearnPoints + pointsAwarded;
      } else {
        userUpdates.masteryPoints = currentMasteryPoints + pointsAwarded;
      }

      console.log(`[UserProfile] Points Debug: newTotalPoints=${userUpdates.totalPoints}`);
    }

    // Handle streak (only on first completion of day)
    let streakInfo: StreakInfo | null = null;
    let energyGranted = 0;

    if (finalDelta > 0 && previousLevel === 0) {
      const lastSessionTimestamp = toDateTime(userData.lastSessionDate);
      const currentStreak = parseInt(String(userData.currentStreak), 10) || 0;

      streakInfo = calculateStreak(lastSessionTimestamp, currentStreak, now);

      userUpdates.currentStreak = streakInfo.currentStreak;
      userUpdates.lastSessionDate = formatTimestamp(startOfLocalDay(now));
      userUpdates.totalSessions = (parseInt(String(userData.totalSessions), 10) || 0) + 1;

      // Grant energy for daily streak
      if (streakInfo.shouldGrantDailyBonus) {
        const energyState = getEnergyState(userData.energy, now);
        const grantResult = applyEnergyReward(
          energyState,
          ENERGY_CONFIG.dailyStreakReward,
          'dailyStreak',
          now
        );
        energyGranted = grantResult.applied;
        userUpdates.energy = serializeEnergyState(grantResult.state);
      }
    }

    // Write to Firestore
    await firestore.updateDocument(`users/${userId}`, userUpdates);

    // Update leaderboard
    // Try multiple username fields in order of preference
    const username = userData.username || userData.displayName || userData.email?.split('@')[0] || 'Anonymous';

    const leaderboardUpdates: any = {
      username: username,
      masteredVariations: stats.masteredVariations,
      openingsMasteredCount: stats.openingsMasteredCount,
      overallMasteryPercentage: stats.overallMasteryPercentage,
      updatedAt: formatTimestamp(now),
    };

    if (streakInfo) {
      leaderboardUpdates.currentStreak = streakInfo.currentStreak;
      leaderboardUpdates.totalSessions = (parseInt(String(userData.totalSessions), 10) || 0) + 1;
    }
    if (pointsAwarded > 0) {
      const currentLeaderboardPoints = parseInt(String(userData.totalPoints), 10) || 0;
      leaderboardUpdates.totalPoints = currentLeaderboardPoints + pointsAwarded;
    }

    await firestore.setDocument(`leaderboard/${userId}`, leaderboardUpdates, { merge: true });

    // Update public/data with COMPUTED stats (not in main doc!)
    const publicDataUpdates: any = {
      username: username,
      // COMPUTED stats (from progressMap analysis) - SINGLE SOURCE OF TRUTH
      masteredVariations: stats.masteredVariations,
      totalVariations: stats.totalVariations,
      openingsMasteredCount: stats.openingsMasteredCount,
      totalOpeningsCount: stats.totalOpeningsCount,
      overallMasteryPercentage: stats.overallMasteryPercentage,
      focusedMasteryPercentage: stats.focusedMasteryPercentage,
      exploreMasteryPercentage: stats.exploreMasteryPercentage,
      strongestOpening: stats.strongestOpening,
      weakestOpening: stats.weakestOpening,
      // Points (copied from main doc)
      totalPoints: (parseInt(String(userData.totalPoints), 10) || 0) + pointsAwarded,
      learnPoints: userUpdates.learnPoints || userData.learnPoints || 0,
      masteryPoints: userUpdates.masteryPoints || userData.masteryPoints || 0,
      // Achievements (if available)
      unlockedAchievementIds: userData.unlocked_achievements || [],
      unlockedAchievementCount: (userData.unlocked_achievements || []).length,
      updatedAt: formatTimestamp(now),
    };

    if (streakInfo) {
      publicDataUpdates.currentStreak = streakInfo.currentStreak;
      publicDataUpdates.highestStreak = userData.highestStreak || streakInfo.currentStreak;
      publicDataUpdates.totalSessions = (parseInt(String(userData.totalSessions), 10) || 0) + 1;
    }

    await firestore.setDocument(`users/${userId}/public/data`, publicDataUpdates, { merge: true });

    // Update activity logs (for Activity Graph and Streak Calendar)
    // Only record activity when positive progress is made
    if (finalDelta > 0) {
      const dateKey = formatDateKey(startOfLocalDay(now));

      // 1. Update activity_log map in public/data (for Streak Calendar widget)
      // Uses updateMapKey to increment the count for today's date
      try {
        await firestore.updateMapKey(
          `users/${userId}/public/data`,
          'activity_log',
          dateKey,
          1 // Just set to 1; Flutter uses FieldValue.increment but REST API doesn't support it easily
        );
        console.log(`[UserProfile] Updated public/data.activity_log.${dateKey}`);
      } catch (e) {
        // Don't fail if activity_log update fails - it's not critical
        console.warn(`[UserProfile] Failed to update public/data.activity_log: ${e}`);
      }

      // 2. Write to activity_log subcollection (for Profile Activity Graph)
      // Each day gets a document with a count field
      try {
        // Use setDocument with merge to increment or create
        await firestore.setDocument(
          `users/${userId}/activity_log/${dateKey}`,
          {
            count: 1, // Simple count, will be merged/overwritten
            updatedAt: formatTimestamp(now)
          },
          { merge: true }
        );
        console.log(`[UserProfile] Updated activity_log/${dateKey} document`);
      } catch (e) {
        // Don't fail if activity_log document update fails - it's not critical
        console.warn(`[UserProfile] Failed to update activity_log document: ${e}`);
      }
    }

    // Record event for deduplication
    if (eventId) {
      const payload: Partial<ProgressEventPayload> = {
        variationKey,
        progressType,
        previousLevel,
        newLevel: finalNewLevel,
        delta: finalDelta,
        pointsAwarded,
        variationBonusAwarded,
        openingBonusAwarded,
      };
      this.recordProcessedEvent(eventId, payload);
    }

    // Calculate final totalPoints for GPGS sync
    const finalTotalPoints = (parseInt(String(userData.totalPoints), 10) || 0) + pointsAwarded;

    console.log(`[UserProfile] Points Debug: RETURNING finalTotalPoints=${finalTotalPoints}, pointsAwarded=${pointsAwarded}`);

    return {
      alreadyProcessed: false,
      variationKey,
      progressType,
      previousLevel,
      newLevel: finalNewLevel,
      delta: finalDelta,
      pointsAwarded,
      variationBonusAwarded,
      openingBonusAwarded,
      stats,
      energyGranted,
      totalPoints: finalTotalPoints, // Include for GPGS leaderboard sync
    };
  }

  /**
   * Claim energy reward
   * Port of claimEnergyReward from Firebase Functions
   */
  private async claimEnergyReward(source: string): Promise<any> {
    const firestore = this.firestore;
    const userId = this.userId!; // Non-null assertion - we set this in fetch()
    if (source !== 'dailyStreak') {
      throw new ApiError(
        ErrorCodes.INVALID_ARGUMENT,
        'Only dailyStreak rewards are supported at this time.'
      );
    }

    const now = new Date();

    // Load user profile
    const userData = await firestore.getDocument(`users/${userId}`);
    if (!userData) {
      throw new ApiError(
        ErrorCodes.FAILED_PRECONDITION,
        'User profile does not exist yet.'
      );
    }

    const energyState = getEnergyState(userData.energy, now);
    const grantResult = applyEnergyReward(
      energyState,
      ENERGY_CONFIG.dailyStreakReward,
      'dailyStreak',
      now
    );

    // Update Firestore
    await firestore.updateDocument(`users/${userId}`, {
      energy: serializeEnergyState(grantResult.state),
      updatedAt: formatTimestamp(now),
    });

    return {
      applied: grantResult.applied,
      current: grantResult.state.current,
      max: grantResult.state.max,
      dailyEarned: grantResult.state.dailyEarned,
    };
  }
}
