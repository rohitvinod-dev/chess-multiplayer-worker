/**
 * Mastery Calculation Utilities
 * Ported from OpeningsTrainer/functions/index.js
 *
 * This module handles all progress tracking logic including:
 * - Progress map analysis (mastery levels 0-3)
 * - Variation and opening completion tracking
 * - 50-50 weighted scoring (learn mode vs mastery mode)
 * - Strongest/weakest opening detection
 */

import type {
  ProgressMap,
  ProgressAnalysis,
  ProgressStats,
  VariationGroup,
  OpeningGroup,
  EnergyState,
  EnergyRecord,
  EnergyRewardResult,
  FirestoreTimestamp,
} from '../types';
import { ENERGY_CONFIG } from '../types';

// ============ UTILITY FUNCTIONS ============

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function sanitizeUsername(raw?: string | null): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const sanitized = trimmed.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!sanitized) return null;
  if (sanitized.toLowerCase() === 'no username') return null;
  const truncated = sanitized.length > 12 ? sanitized.slice(0, 12) : sanitized;
  if (truncated.length < 3) {
    return `${truncated}${'_'.repeat(3 - truncated.length)}`;
  }
  return truncated;
}

/**
 * Split progress key into opening name and variation name.
 *
 * Key format: "OpeningName_VariationName"
 * Example: "Italian Game_Giuoco Piano" -> ["Italian Game", "Giuoco Piano"]
 * Example: "Sicilian Defense_Najdorf Variation" -> ["Sicilian Defense", "Najdorf Variation"]
 *
 * Note: Both opening and variation names can contain spaces, so we split on the FIRST underscore only.
 */
export function splitProgressKey(key: string): string[] {
  if (!key || typeof key !== 'string') return [];

  // Find the first underscore - this separates opening name from variation name
  const underscoreIndex = key.indexOf('_');
  if (underscoreIndex > 0 && underscoreIndex < key.length - 1) {
    const openingName = key.substring(0, underscoreIndex).trim();
    const variationName = key.substring(underscoreIndex + 1).trim();
    return [openingName, variationName].filter((s) => s.length > 0);
  }

  // No underscore found - return the whole key as opening name
  const trimmed = key.trim();
  return trimmed ? [trimmed] : [];
}

/**
 * Extract variation key from progress key.
 * For human-readable keys, this returns the full key since it's already the variation identifier.
 *
 * Example: "Italian Game_Giuoco Piano" -> "Italian Game_Giuoco Piano"
 */
export function variationIdFromKey(key: string): string {
  // For human-readable keys, the full key IS the variation identifier
  // This maintains uniqueness across openings
  if (!key || typeof key !== 'string') return key;
  return key.trim();
}

/**
 * Extract opening name from progress key.
 *
 * Example: "Italian Game_Giuoco Piano" -> "Italian Game"
 * Example: "Sicilian Defense_Najdorf Variation" -> "Sicilian Defense"
 */
export function openingIdFromKey(key: string): string {
  const segments = splitProgressKey(key);
  if (segments.length >= 1) {
    return segments[0];
  }
  return key;
}

/**
 * Extract variation name from progress key.
 *
 * Example: "Italian Game_Giuoco Piano" -> "Giuoco Piano"
 */
export function variationNameFromKey(key: string): string {
  const segments = splitProgressKey(key);
  if (segments.length >= 2) {
    return segments[1];
  }
  return key;
}

// ============ PROGRESS MAP ANALYSIS ============

/**
 * Analyze a progress map to compute stats about variations and openings
 *
 * This is the core mastery calculation function that:
 * - Sanitizes and validates progress levels (0-3)
 * - Groups progress by variation and opening
 * - Calculates completion metrics
 * - Identifies strongest/weakest openings
 *
 * @param rawMap - Raw progress map from Firestore
 * @returns Detailed analysis of progress state
 */
export function analyzeProgressMap(rawMap: ProgressMap | null | undefined): ProgressAnalysis {
  const sanitizedMap: ProgressMap = {};
  const variationGroups = new Map<string, VariationGroup>();
  const openingGroups = new Map<string, OpeningGroup>();
  let completedKeys = 0;
  let totalLevel = 0;

  if (rawMap && typeof rawMap === 'object') {
    Object.entries(rawMap).forEach(([key, value]) => {
      if (!key) return;
      const level = clamp(parseInt(String(value), 10) || 0, 0, 3);
      sanitizedMap[key] = level;
      if (level >= 3) {
        completedKeys += 1;
      }
      totalLevel += level;

      // Track by variation
      const variationId = variationIdFromKey(key);
      let variationEntry = variationGroups.get(variationId);
      if (!variationEntry) {
        variationEntry = {
          keys: [],
          minLevel: 3,
          totalLevel: 0,
        };
        variationGroups.set(variationId, variationEntry);
      }
      variationEntry.keys.push(key);
      variationEntry.minLevel = Math.min(variationEntry.minLevel, level);
      variationEntry.totalLevel += level;

      // Track by opening
      const openingId = openingIdFromKey(key);
      let openingEntry = openingGroups.get(openingId);
      if (!openingEntry) {
        openingEntry = {
          keys: [],
          minLevel: 3,
          totalLevel: 0,
        };
        openingGroups.set(openingId, openingEntry);
      }
      openingEntry.keys.push(key);
      openingEntry.minLevel = Math.min(openingEntry.minLevel, level);
      openingEntry.totalLevel += level;
    });
  }

  // Find strongest and weakest openings
  let strongestOpening: string | null = null;
  let strongestValue = -Infinity;
  let weakestOpening: string | null = null;
  let weakestValue = Infinity;
  let masteredOpeningCount = 0;

  openingGroups.forEach((value, key) => {
    if (value.keys.length === 0) {
      return;
    }
    // Average progress: totalLevel / (keys * 3), clamped 0-1
    const average = value.totalLevel / (value.keys.length * 3);
    const boundedAverage = clamp(average, 0, 1);
    if (boundedAverage > strongestValue) {
      strongestValue = boundedAverage;
      strongestOpening = key;
    }
    if (boundedAverage < weakestValue) {
      weakestValue = boundedAverage;
      weakestOpening = key;
    }
    // Opening is "mastered" if all variations are at level 3
    if (value.minLevel === 3) {
      masteredOpeningCount += 1;
    }
  });

  // Count completed variations (all keys in variation at level 3)
  const variationCompletedCount = Array.from(variationGroups.values()).filter(
    (entry) => entry.keys.length > 0 && entry.minLevel === 3
  ).length;

  const totalKeys = Object.keys(sanitizedMap).length;
  const overallMastery = totalKeys === 0 ? 0 : totalLevel / (totalKeys * 3);

  return {
    map: sanitizedMap,
    variationGroups,
    openingGroups,
    totalKeys,
    completedKeys,
    totalLevel,
    variationCompletedCount,
    masteredOpeningCount,
    totalOpenings: openingGroups.size,
    strongestOpening,
    weakestOpening,
    overallMastery,
    isVariationComplete: (variationId: string) => {
      const entry = variationGroups.get(variationId);
      if (!entry || entry.keys.length === 0) return false;
      return entry.minLevel === 3;
    },
    isOpeningComplete: (openingId: string) => {
      const entry = openingGroups.get(openingId);
      if (!entry || entry.keys.length === 0) return false;
      return entry.minLevel === 3;
    },
  };
}

/**
 * Compute overall progress stats with 50-50 weighting between phases (legacy)
 *
 * @param masteryAnalysis - Analysis of mastery phase progress
 * @param learnAnalysis - Analysis of learn phase progress (optional)
 * @returns Aggregated progress statistics
 */
export function computeProgressStats(
  masteryAnalysis: ProgressAnalysis,
  learnAnalysis: ProgressAnalysis | null = null
): ProgressStats {
  // Calculate overall mastery as 50-50 weighted average of learn/mastery phases
  let overallMasteryPercentage: number;
  if (learnAnalysis) {
    const masteryPercent = masteryAnalysis.overallMastery * 100;
    const learnPercent = learnAnalysis.overallMastery * 100;
    overallMasteryPercentage = Number(
      ((masteryPercent * 0.5) + (learnPercent * 0.5)).toFixed(2)
    );
  } else {
    overallMasteryPercentage = Number(
      (masteryAnalysis.overallMastery * 100).toFixed(2)
    );
  }

  return {
    masteredVariations: masteryAnalysis.variationCompletedCount,
    totalVariations: masteryAnalysis.variationGroups.size,
    openingsMasteredCount: masteryAnalysis.masteredOpeningCount,
    totalOpeningsCount: masteryAnalysis.totalOpenings,
    overallMasteryPercentage,
    strongestOpening: masteryAnalysis.strongestOpening || 'N/A',
    weakestOpening: masteryAnalysis.weakestOpening || 'N/A',
  };
}

/**
 * Mode progress data for combined calculation
 */
export interface ModeProgress {
  progressMap: ProgressMap;      // Mastery phase progress
  learnProgressMap: ProgressMap; // Learn phase progress
}

/**
 * Compute combined progress stats from both Focused and Explore modes
 *
 * Formula (when totalSystemLines is provided):
 * - Calculate total level across ALL progress maps in both modes
 * - Divide by (totalSystemLines × 3 × 2 × 2) for full 100%
 *   - ×3 for max level per line
 *   - ×2 for learn + mastery phases
 *   - ×2 for focused + explore modes
 *
 * Formula (legacy - when totalSystemLines is NOT provided):
 * - Focused Mode Progress = (learn + mastery) / 2 within focused mode
 * - Explore Mode Progress = (learn + mastery) / 2 within explore mode
 * - Overall = (Focused Mode × 50%) + (Explore Mode × 50%)
 *
 * 50-50 Weighting for Openings Mastered:
 * - totalOpeningsCount = totalSystemOpenings × 2 (one slot per mode)
 * - Each opening mastered in focused mode = 1 towards openingsMasteredCount
 * - Each opening mastered in explore mode = 1 towards openingsMasteredCount
 * - Example: If user masters 2 openings in focused, 0 in explore:
 *   openingsMasteredCount = 2, totalOpeningsCount = 40, percentage = 5%
 *
 * @param focusedMode - Progress data from Focused mode
 * @param exploreMode - Progress data from Explore mode
 * @param totalSystemLines - Total lines in the system (optional, for accurate %)
 * @param totalSystemOpenings - Total openings in the system (optional, default 20)
 * @returns Combined progress statistics
 */
export function computeCombinedProgressStats(
  focusedMode: ModeProgress | null,
  exploreMode: ModeProgress | null,
  totalSystemLines?: number,
  totalSystemOpenings: number = 20
): ProgressStats {
  // Analyze each mode's progress maps
  const focusedMasteryAnalysis = analyzeProgressMap(focusedMode?.progressMap);
  const focusedLearnAnalysis = analyzeProgressMap(focusedMode?.learnProgressMap);
  const exploreMasteryAnalysis = analyzeProgressMap(exploreMode?.progressMap);
  const exploreLearnAnalysis = analyzeProgressMap(exploreMode?.learnProgressMap);

  let overallMasteryPercentage: number;

  if (totalSystemLines && totalSystemLines > 0) {
    // NEW: Calculate based on total system lines
    // Total possible progress = totalSystemLines × 3 (max level) × 2 (learn+mastery) × 2 (focused+explore)
    const maxPossibleLevel = totalSystemLines * 3 * 2 * 2;

    // Sum all progress levels across all modes and phases
    const totalProgress =
      focusedMasteryAnalysis.totalLevel +
      focusedLearnAnalysis.totalLevel +
      exploreMasteryAnalysis.totalLevel +
      exploreLearnAnalysis.totalLevel;

    overallMasteryPercentage = Number(
      ((totalProgress / maxPossibleLevel) * 100).toFixed(2)
    );
  } else {
    // LEGACY: Calculate per-mode overall (50% learn + 50% mastery within each mode)
    const focusedOverall = (
      (focusedMasteryAnalysis.overallMastery * 0.5) +
      (focusedLearnAnalysis.overallMastery * 0.5)
    ) * 100;

    const exploreOverall = (
      (exploreMasteryAnalysis.overallMastery * 0.5) +
      (exploreLearnAnalysis.overallMastery * 0.5)
    ) * 100;

    // Combined: 50% Focused + 50% Explore
    overallMasteryPercentage = Number(
      ((focusedOverall * 0.5) + (exploreOverall * 0.5)).toFixed(2)
    );
  }

  // Combine mastered counts from both modes
  const allMasteryMaps = [focusedMasteryAnalysis, exploreMasteryAnalysis];
  const combinedMasteredVariations = allMasteryMaps.reduce(
    (sum, a) => sum + a.variationCompletedCount, 0
  );
  const combinedTotalVariations = allMasteryMaps.reduce(
    (sum, a) => sum + a.variationGroups.size, 0
  );

  // 50-50 WEIGHTING FOR OPENINGS:
  // - Each opening mastered in focused mode counts as 1
  // - Each opening mastered in explore mode counts as 1
  // - Total possible = totalSystemOpenings × 2 (both modes)
  const combinedMasteredOpenings = allMasteryMaps.reduce(
    (sum, a) => sum + a.masteredOpeningCount, 0
  );
  // FIXED: Use totalSystemOpenings × 2 instead of counting openings with progress
  // This ensures accurate percentage even when user has only partial progress
  const combinedTotalOpenings = totalSystemOpenings * 2;

  // Calculate mode-specific percentages
  // Each mode contributes 0-100% based on its progress out of totalSystemLines
  let focusedMasteryPercentage: number;
  let exploreMasteryPercentage: number;

  if (totalSystemLines && totalSystemLines > 0) {
    // NEW: Calculate based on total system lines for each mode
    // Each mode has: totalSystemLines × 3 (max level) × 2 (learn+mastery)
    const maxPerMode = totalSystemLines * 3 * 2;

    const focusedProgress = focusedMasteryAnalysis.totalLevel + focusedLearnAnalysis.totalLevel;
    const exploreProgress = exploreMasteryAnalysis.totalLevel + exploreLearnAnalysis.totalLevel;

    focusedMasteryPercentage = Number(((focusedProgress / maxPerMode) * 100).toFixed(2));
    exploreMasteryPercentage = Number(((exploreProgress / maxPerMode) * 100).toFixed(2));
  } else {
    // LEGACY: Calculate per-mode percentages using old formula
    focusedMasteryPercentage = Number((
      (focusedMasteryAnalysis.overallMastery * 0.5) +
      (focusedLearnAnalysis.overallMastery * 0.5)
    ) * 100).toFixed(2) as unknown as number;

    exploreMasteryPercentage = Number((
      (exploreMasteryAnalysis.overallMastery * 0.5) +
      (exploreLearnAnalysis.overallMastery * 0.5)
    ) * 100).toFixed(2) as unknown as number;
  }

  // Use focused mode for strongest/weakest (primary mode)
  const strongestOpening = focusedMasteryAnalysis.strongestOpening ||
    exploreMasteryAnalysis.strongestOpening || 'N/A';
  const weakestOpening = focusedMasteryAnalysis.weakestOpening ||
    exploreMasteryAnalysis.weakestOpening || 'N/A';

  return {
    masteredVariations: combinedMasteredVariations,
    totalVariations: combinedTotalVariations,
    openingsMasteredCount: combinedMasteredOpenings,
    totalOpeningsCount: combinedTotalOpenings,
    overallMasteryPercentage,
    focusedMasteryPercentage,
    exploreMasteryPercentage,
    strongestOpening,
    weakestOpening,
  };
}

// ============ DATE UTILITIES ============

/**
 * Convert Firestore timestamp, ISO string, or Date to JavaScript Date
 * Supports:
 * - Date objects
 * - ISO strings (e.g., "2025-12-18T10:28:39.000Z")
 * - Legacy Firestore timestamps ({ _seconds, _nanoseconds })
 */
export function toDateTime(value: any): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  // Handle ISO string format
  if (typeof value === 'string') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
    return null;
  }
  // Handle legacy Firestore timestamp format
  if (typeof value === 'object' && '_seconds' in value) {
    return new Date(value._seconds * 1000);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

/**
 * Get start of local day (00:00:00 local time)
 */
export function startOfLocalDay(date: Date): Date {
  const local = new Date(date.getTime());
  local.setHours(0, 0, 0, 0);
  return local;
}

/**
 * Format date as YYYY-MM-DD for activity log keys
 * This matches the format used by Flutter's StreakService
 */
export function formatDateKey(date: Date): string {
  const year = date.getFullYear().toString();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Format a date to human-readable string
 * Example: "December 18, 2025 at 10:28:39 AM UTC+5:30"
 *
 * @param date - Date object or ISO string
 * @param timezone - Optional IANA timezone (default: 'Asia/Kolkata' for UTC+5:30)
 * @returns Human-readable date string
 */
export function formatTimestamp(date: Date | string, timezone: string = 'Asia/Kolkata'): string {
  const d = typeof date === 'string' ? new Date(date) : date;

  // Format with Intl.DateTimeFormat for consistent output
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'shortOffset',
  });

  const parts = formatter.formatToParts(d);
  const getPart = (type: string) => parts.find(p => p.type === type)?.value || '';

  // Build the formatted string: "December 18, 2025 at 10:28:39 AM UTC+5:30"
  return `${getPart('month')} ${getPart('day')}, ${getPart('year')} at ${getPart('hour')}:${getPart('minute')}:${getPart('second')} ${getPart('dayPeriod')} ${getPart('timeZoneName')}`;
}

/**
 * Serialize Date to Firestore timestamp format
 */
export function serializeDate(date: Date | null): FirestoreTimestamp | null {
  if (!date) return null;
  return {
    _seconds: Math.floor(date.getTime() / 1000),
    _nanoseconds: 0,
  };
}

// ============ ENERGY SYSTEM ============

/**
 * Get energy state from Firestore record
 * Validates and clamps all values to safe ranges
 */
export function getEnergyState(record: EnergyRecord | null | undefined, now: Date): EnergyState {
  const base: EnergyState = {
    current: ENERGY_CONFIG.maxEnergy,
    max: ENERGY_CONFIG.maxEnergy,
    dailyEarned: 0,
    dailyWindowStart: startOfLocalDay(now),
    lastDailyStreakClaimedAt: null,
  };

  if (!record || typeof record !== 'object') {
    return base;
  }

  const state = { ...base };
  state.current = clamp(
    parseInt(String(record.current), 10) || state.current,
    0,
    ENERGY_CONFIG.maxEnergy
  );
  state.max = clamp(parseInt(String(record.max), 10) || ENERGY_CONFIG.maxEnergy, 1, 300);
  state.dailyEarned = clamp(parseInt(String(record.dailyEarned), 10) || 0, 0, 10000);
  state.dailyWindowStart = toDateTime(record.dailyWindowStart) || startOfLocalDay(now);
  state.lastDailyStreakClaimedAt = toDateTime(record.lastDailyStreakClaimedAt);

  return state;
}

/**
 * Ensure daily window is current (reset earned counter if new day)
 */
export function ensureDailyWindow(state: EnergyState, now: Date): void {
  const windowStart = startOfLocalDay(now);
  if (!state.dailyWindowStart || state.dailyWindowStart.getTime() !== windowStart.getTime()) {
    state.dailyWindowStart = windowStart;
    state.dailyEarned = 0;
  }
}

/**
 * Apply energy reward with daily cap and max energy limits
 */
export function applyEnergyReward(
  state: EnergyState,
  amount: number,
  reason: string,
  now: Date
): EnergyRewardResult {
  ensureDailyWindow(state, now);
  const remainingCap = Math.max(0, ENERGY_CONFIG.dailyEarnCap - state.dailyEarned);
  let applied = Math.min(amount, remainingCap);
  const availableSpace = Math.max(0, state.max - state.current);
  applied = Math.min(applied, availableSpace);

  if (applied <= 0) {
    return { applied: 0, state };
  }

  state.current = clamp(state.current + applied, 0, state.max);
  state.dailyEarned = clamp(state.dailyEarned + applied, 0, 10000);

  if (reason === 'dailyStreak') {
    state.lastDailyStreakClaimedAt = now;
  }

  return { applied, state };
}

/**
 * Serialize energy state for Firestore storage
 */
export function serializeEnergyState(state: EnergyState): EnergyRecord {
  return {
    current: state.current,
    max: state.max,
    dailyEarned: state.dailyEarned,
    dailyWindowStart: serializeDate(state.dailyWindowStart),
    lastDailyStreakClaimedAt: serializeDate(state.lastDailyStreakClaimedAt),
  };
}

// ============ STREAK CALCULATIONS ============

/**
 * Calculate streak information for a training session
 *
 * @param lastSessionTimestamp - Last session date from user profile
 * @param currentStreak - Current streak count
 * @param now - Current timestamp
 * @returns Streak info with updated count and daily bonus eligibility
 */
export function calculateStreak(
  lastSessionTimestamp: Date | null,
  currentStreak: number,
  now: Date
): { currentStreak: number; shouldGrantDailyBonus: boolean } {
  const todayDate = startOfLocalDay(now);
  let newStreak = currentStreak;
  let shouldGrantDailyBonus = false;

  if (!lastSessionTimestamp) {
    // First session ever
    newStreak = 1;
    shouldGrantDailyBonus = true;
  } else {
    const lastDate = startOfLocalDay(lastSessionTimestamp);
    const diffDays = Math.floor((todayDate.getTime() - lastDate.getTime()) / (24 * 60 * 60 * 1000));

    if (diffDays === 0) {
      // Same day, streak unchanged, no bonus
    } else if (diffDays === 1) {
      // Consecutive day
      newStreak += 1;
      shouldGrantDailyBonus = true;
    } else if (diffDays > 1) {
      // Streak broken
      newStreak = 1;
      shouldGrantDailyBonus = true;
    }
  }

  return { currentStreak: newStreak, shouldGrantDailyBonus };
}
