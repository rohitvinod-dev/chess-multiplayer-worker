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
 * Split progress key into segments
 * Example: "Sicilian_Najdorf_Main" -> ["Sicilian", "Najdorf", "Main"]
 */
export function splitProgressKey(key: string): string[] {
  if (!key || typeof key !== 'string') return [];
  return key
    .split('_')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * Extract variation ID from progress key
 * Example: "Sicilian_Najdorf_Main" -> "Sicilian_Najdorf"
 */
export function variationIdFromKey(key: string): string {
  const segments = splitProgressKey(key);
  if (segments.length >= 2) {
    return `${segments[0]}_${segments[1]}`;
  }
  if (segments.length === 1) {
    return segments[0];
  }
  return key;
}

/**
 * Extract opening ID from progress key
 * Example: "Sicilian_Najdorf_Main" -> "Sicilian"
 */
export function openingIdFromKey(key: string): string {
  const segments = splitProgressKey(key);
  if (segments.length >= 1) {
    return segments[0];
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
 * Compute overall progress stats with 50-50 weighting between modes
 *
 * The overall mastery percentage is calculated as:
 * 50% Focused Mode (mastery) + 50% Explore Mode (learn)
 *
 * This balances proficiency (mastery) with breadth of exposure (learn).
 *
 * @param masteryAnalysis - Analysis of mastery mode progress
 * @param learnAnalysis - Analysis of learn mode progress (optional)
 * @returns Aggregated progress statistics
 */
export function computeProgressStats(
  masteryAnalysis: ProgressAnalysis,
  learnAnalysis: ProgressAnalysis | null = null
): ProgressStats {
  // Calculate overall mastery as 50-50 weighted average
  let overallMasteryPercentage: number;
  if (learnAnalysis) {
    const focusedMastery = masteryAnalysis.overallMastery * 100; // Focused/Mastery mode
    const exploreMastery = learnAnalysis.overallMastery * 100;   // Explore/Learn mode
    overallMasteryPercentage = Number(
      ((focusedMastery * 0.5) + (exploreMastery * 0.5)).toFixed(2)
    );
  } else {
    // Fallback to legacy behavior if learnAnalysis not provided
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

// ============ DATE UTILITIES ============

/**
 * Convert Firestore timestamp or Date to JavaScript Date
 */
export function toDateTime(value: any): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'object' && '_seconds' in value) {
    // Firestore timestamp
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
