/**
 * Unit tests for mastery calculation utilities
 *
 * These tests verify that the ported logic matches the original Firebase Functions behavior.
 */

import { describe, it, expect } from 'vitest';
import {
  clamp,
  sanitizeUsername,
  splitProgressKey,
  variationIdFromKey,
  openingIdFromKey,
  analyzeProgressMap,
  computeProgressStats,
  calculateStreak,
  startOfLocalDay,
} from '../../src/utils/mastery';

describe('Utility Functions', () => {
  describe('clamp', () => {
    it('should clamp value within min and max', () => {
      expect(clamp(5, 0, 10)).toBe(5);
      expect(clamp(-5, 0, 10)).toBe(0);
      expect(clamp(15, 0, 10)).toBe(10);
    });
  });

  describe('sanitizeUsername', () => {
    it('should sanitize valid usernames', () => {
      expect(sanitizeUsername('TestUser')).toBe('TestUser');
      expect(sanitizeUsername('test_user')).toBe('test_user');
      expect(sanitizeUsername('user.123')).toBe('user.123');
    });

    it('should replace invalid characters', () => {
      expect(sanitizeUsername('test@user')).toBe('test_user');
      expect(sanitizeUsername('user name')).toBe('user_name');
    });

    it('should truncate long usernames', () => {
      expect(sanitizeUsername('verylongusername123')).toBe('verylonguser');
    });

    it('should pad short usernames', () => {
      expect(sanitizeUsername('ab')).toBe('ab_');
      expect(sanitizeUsername('a')).toBe('a__');
    });

    it('should reject invalid inputs', () => {
      expect(sanitizeUsername(null)).toBeNull();
      expect(sanitizeUsername('')).toBeNull();
      expect(sanitizeUsername('   ')).toBeNull();
      expect(sanitizeUsername('no username')).toBeNull();
    });
  });

  describe('splitProgressKey', () => {
    it('should split progress key correctly', () => {
      expect(splitProgressKey('Sicilian_Najdorf_Main')).toEqual(['Sicilian', 'Najdorf', 'Main']);
      expect(splitProgressKey('FrenchDefense_Classical')).toEqual(['FrenchDefense', 'Classical']);
      expect(splitProgressKey('KingsIndian')).toEqual(['KingsIndian']);
    });

    it('should handle empty segments', () => {
      expect(splitProgressKey('Sicilian__Najdorf')).toEqual(['Sicilian', 'Najdorf']);
      expect(splitProgressKey('_Sicilian_')).toEqual(['Sicilian']);
    });
  });

  describe('variationIdFromKey', () => {
    it('should extract variation ID', () => {
      expect(variationIdFromKey('Sicilian_Najdorf_Main')).toBe('Sicilian_Najdorf');
      expect(variationIdFromKey('French_Classical')).toBe('French_Classical');
      expect(variationIdFromKey('KingsIndian')).toBe('KingsIndian');
    });
  });

  describe('openingIdFromKey', () => {
    it('should extract opening ID', () => {
      expect(openingIdFromKey('Sicilian_Najdorf_Main')).toBe('Sicilian');
      expect(openingIdFromKey('French_Classical')).toBe('French');
      expect(openingIdFromKey('KingsIndian')).toBe('KingsIndian');
    });
  });
});

describe('Progress Map Analysis', () => {
  it('should analyze empty progress map', () => {
    const analysis = analyzeProgressMap({});
    expect(analysis.totalKeys).toBe(0);
    expect(analysis.completedKeys).toBe(0);
    expect(analysis.overallMastery).toBe(0);
    expect(analysis.variationGroups.size).toBe(0);
    expect(analysis.openingGroups.size).toBe(0);
  });

  it('should analyze simple progress map', () => {
    const progressMap = {
      'Sicilian_Najdorf_Main': 3,
      'Sicilian_Najdorf_Sideline': 2,
      'French_Classical': 1,
    };

    const analysis = analyzeProgressMap(progressMap);
    expect(analysis.totalKeys).toBe(3);
    expect(analysis.completedKeys).toBe(1); // One at level 3
    expect(analysis.totalLevel).toBe(6); // 3 + 2 + 1
    expect(analysis.overallMastery).toBeCloseTo(6 / (3 * 3)); // 6 / 9 = 0.666...
    expect(analysis.variationGroups.size).toBe(2); // Sicilian_Najdorf, French_Classical
    expect(analysis.openingGroups.size).toBe(2); // Sicilian, French
  });

  it('should detect completed variations', () => {
    const progressMap = {
      'Sicilian_Najdorf_Main': 3,
      'Sicilian_Najdorf_Sideline': 3,
      'Sicilian_Dragon': 2,
    };

    const analysis = analyzeProgressMap(progressMap);
    expect(analysis.isVariationComplete('Sicilian_Najdorf')).toBe(true);
    expect(analysis.isVariationComplete('Sicilian_Dragon')).toBe(false);
  });

  it('should detect completed openings', () => {
    const progressMap = {
      'Sicilian_Najdorf': 3,
      'Sicilian_Dragon': 3,
      'French_Classical': 2,
    };

    const analysis = analyzeProgressMap(progressMap);
    expect(analysis.isOpeningComplete('Sicilian')).toBe(true);
    expect(analysis.isOpeningComplete('French')).toBe(false);
  });

  it('should identify strongest and weakest openings', () => {
    const progressMap = {
      'Sicilian_Najdorf': 3,
      'Sicilian_Dragon': 3,
      'French_Classical': 1,
      'French_Winawer': 0,
    };

    const analysis = analyzeProgressMap(progressMap);
    expect(analysis.strongestOpening).toBe('Sicilian');
    expect(analysis.weakestOpening).toBe('French');
  });
});

describe('Progress Stats Computation', () => {
  it('should compute stats with mastery only', () => {
    const progressMap = {
      'Sicilian_Najdorf': 3,
      'Sicilian_Dragon': 2,
      'French_Classical': 1,
    };

    const masteryAnalysis = analyzeProgressMap(progressMap);
    const stats = computeProgressStats(masteryAnalysis);

    expect(stats.masteredVariations).toBe(1); // Sicilian_Najdorf at 3
    expect(stats.totalVariations).toBe(3);
    expect(stats.openingsMasteredCount).toBe(0); // No opening fully mastered
    expect(stats.totalOpeningsCount).toBe(2);
    expect(stats.overallMasteryPercentage).toBeCloseTo(66.67, 1);
  });

  it('should compute stats with 50-50 weighting', () => {
    const masteryMap = {
      'Sicilian_Najdorf': 3,
      'French_Classical': 2,
    };

    const learnMap = {
      'Sicilian_Najdorf': 2,
      'French_Classical': 3,
    };

    const masteryAnalysis = analyzeProgressMap(masteryMap);
    const learnAnalysis = analyzeProgressMap(learnMap);
    const stats = computeProgressStats(masteryAnalysis, learnAnalysis);

    // Mastery: (3 + 2) / 6 = 0.8333 = 83.33%
    // Learn: (2 + 3) / 6 = 0.8333 = 83.33%
    // Overall: (83.33 * 0.5) + (83.33 * 0.5) = 83.33%
    expect(stats.overallMasteryPercentage).toBeCloseTo(83.33, 1);
  });

  it('should compute different 50-50 weighted averages', () => {
    const masteryMap = {
      'Sicilian_Najdorf': 3,
    };

    const learnMap = {
      'Sicilian_Najdorf': 1,
    };

    const masteryAnalysis = analyzeProgressMap(masteryMap);
    const learnAnalysis = analyzeProgressMap(learnMap);
    const stats = computeProgressStats(masteryAnalysis, learnAnalysis);

    // Mastery: 3 / 3 = 1.0 = 100%
    // Learn: 1 / 3 = 0.333 = 33.33%
    // Overall: (100 * 0.5) + (33.33 * 0.5) = 66.67%
    expect(stats.overallMasteryPercentage).toBeCloseTo(66.67, 1);
  });
});

describe('Streak Calculations', () => {
  it('should start streak for first session', () => {
    const result = calculateStreak(null, 0, new Date('2025-12-04T10:00:00Z'));
    expect(result.currentStreak).toBe(1);
    expect(result.shouldGrantDailyBonus).toBe(true);
  });

  it('should increment streak for consecutive days', () => {
    const lastSession = new Date('2025-12-03T10:00:00Z');
    const now = new Date('2025-12-04T10:00:00Z');
    const result = calculateStreak(lastSession, 5, now);
    expect(result.currentStreak).toBe(6);
    expect(result.shouldGrantDailyBonus).toBe(true);
  });

  it('should maintain streak for same day', () => {
    const lastSession = new Date('2025-12-04T09:00:00Z');
    const now = new Date('2025-12-04T15:00:00Z');
    const result = calculateStreak(lastSession, 5, now);
    expect(result.currentStreak).toBe(5);
    expect(result.shouldGrantDailyBonus).toBe(false);
  });

  it('should reset streak for missed days', () => {
    const lastSession = new Date('2025-12-01T10:00:00Z');
    const now = new Date('2025-12-04T10:00:00Z');
    const result = calculateStreak(lastSession, 10, now);
    expect(result.currentStreak).toBe(1);
    expect(result.shouldGrantDailyBonus).toBe(true);
  });
});

describe('Date Utilities', () => {
  it('should get start of local day', () => {
    const date = new Date('2025-12-04T15:30:45.123Z');
    const startOfDay = startOfLocalDay(date);
    expect(startOfDay.getHours()).toBe(0);
    expect(startOfDay.getMinutes()).toBe(0);
    expect(startOfDay.getSeconds()).toBe(0);
    expect(startOfDay.getMilliseconds()).toBe(0);
  });
});
