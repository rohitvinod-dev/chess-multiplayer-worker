/**
 * Unit tests for mastery calculation utilities
 *
 * These tests verify that the ported logic matches the original Firebase Functions behavior.
 */

import { describe, it, expect } from 'vitest';
import {
  clamp,
  sanitizeUsername,
  validateUsername,
  USERNAME_CONSTRAINTS,
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

  describe('USERNAME_CONSTRAINTS', () => {
    it('should have correct length constraints', () => {
      expect(USERNAME_CONSTRAINTS.minLength).toBe(3);
      expect(USERNAME_CONSTRAINTS.maxLength).toBe(25);
    });
  });

  describe('validateUsername', () => {
    it('should validate valid usernames', () => {
      expect(validateUsername('TestUser').isValid).toBe(true);
      expect(validateUsername('test_user').isValid).toBe(true);
      expect(validateUsername('user-123').isValid).toBe(true);
      expect(validateUsername('Player1').isValid).toBe(true);
      expect(validateUsername('Chess_Master_2024').isValid).toBe(true);
    });

    it('should reject empty/null usernames', () => {
      expect(validateUsername(null).isValid).toBe(false);
      expect(validateUsername('').isValid).toBe(false);
      expect(validateUsername('   ').isValid).toBe(false);
    });

    it('should reject usernames with periods (Chess.com style)', () => {
      expect(validateUsername('user.123').isValid).toBe(false);
      expect(validateUsername('first.last').isValid).toBe(false);
    });

    it('should reject usernames that dont start with letter/number', () => {
      expect(validateUsername('_username').isValid).toBe(false);
      expect(validateUsername('-player').isValid).toBe(false);
    });

    it('should reject usernames that dont end with letter/number', () => {
      expect(validateUsername('username_').isValid).toBe(false);
      expect(validateUsername('player-').isValid).toBe(false);
    });

    it('should reject numbers-only usernames (Lichess rule)', () => {
      expect(validateUsername('123456').isValid).toBe(false);
      expect(validateUsername('999').isValid).toBe(false);
    });

    it('should reject consecutive special characters', () => {
      expect(validateUsername('user__name').isValid).toBe(false);
      expect(validateUsername('player--one').isValid).toBe(false);
      expect(validateUsername('test_-name').isValid).toBe(false);
    });

    it('should reject too short usernames', () => {
      expect(validateUsername('ab').isValid).toBe(false);
      expect(validateUsername('a').isValid).toBe(false);
    });

    it('should reject too long usernames', () => {
      expect(validateUsername('a'.repeat(26)).isValid).toBe(false);
      expect(validateUsername('username_that_is_way_too_long_for_system').isValid).toBe(false);
    });

    it('should reject reserved words', () => {
      expect(validateUsername('admin').isValid).toBe(false);
      expect(validateUsername('moderator').isValid).toBe(false);
      expect(validateUsername('system').isValid).toBe(false);
      expect(validateUsername('no username').isValid).toBe(false);
    });

    it('should reject standalone profanity', () => {
      // Profanity as standalone words are detected
      expect(validateUsername('fuck').isValid).toBe(false);
      expect(validateUsername('shit').isValid).toBe(false);
    });
  });

  describe('sanitizeUsername', () => {
    it('should preserve valid usernames', () => {
      expect(sanitizeUsername('TestUser')).toBe('TestUser');
      expect(sanitizeUsername('test_user')).toBe('test_user');
      expect(sanitizeUsername('user-123')).toBe('user-123');
    });

    it('should convert periods to underscores', () => {
      expect(sanitizeUsername('user.123')).toBe('user_123');
    });

    it('should replace invalid characters with underscores', () => {
      expect(sanitizeUsername('test@user')).toBe('test_user');
      expect(sanitizeUsername('user name')).toBe('user_name');
    });

    it('should remove leading special characters', () => {
      expect(sanitizeUsername('_username')).toBe('username');
      // After collapsing __ to _ and removing leading _, 'test' is 4 chars (>= minLength 3)
      expect(sanitizeUsername('__test')).toBe('test');
    });

    it('should remove trailing special characters', () => {
      expect(sanitizeUsername('username_')).toBe('username');
      expect(sanitizeUsername('player--')).toBe('player');
    });

    it('should collapse consecutive special characters', () => {
      expect(sanitizeUsername('user__name')).toBe('user_name');
      // After collapsing ___ to _, 'a_b' is 3 chars (== minLength 3), no padding needed
      expect(sanitizeUsername('a___b')).toBe('a_b');
    });

    it('should handle edge cases', () => {
      // Only special chars left after stripping - should pad with x
      expect(sanitizeUsername('___')).toBe(null);
    });

    it('should truncate to max length', () => {
      const longName = 'verylongusernamethatexceedsmaximumlength';
      const result = sanitizeUsername(longName);
      expect(result?.length).toBeLessThanOrEqual(USERNAME_CONSTRAINTS.maxLength);
    });

    it('should pad short usernames with x', () => {
      expect(sanitizeUsername('ab')).toBe('abx');
      expect(sanitizeUsername('a')).toBe('axx');
    });

    it('should prepend u for numbers-only', () => {
      expect(sanitizeUsername('123456')).toBe('u123456');
      expect(sanitizeUsername('999')).toBe('u999');
    });

    it('should reject inputs that cannot be sanitized', () => {
      expect(sanitizeUsername(null)).toBeNull();
      expect(sanitizeUsername('')).toBeNull();
      expect(sanitizeUsername('   ')).toBeNull();
      expect(sanitizeUsername('admin')).toBeNull();
      expect(sanitizeUsername('moderator')).toBeNull();
      expect(sanitizeUsername('system')).toBeNull();
    });
  });

  describe('splitProgressKey', () => {
    it('should split progress key on first underscore only', () => {
      // Note: The implementation splits on FIRST underscore only
      // Only when underscore is > 0 AND < length-1 (not at start or end)
      expect(splitProgressKey('Sicilian_Najdorf_Main')).toEqual(['Sicilian', 'Najdorf_Main']);
      expect(splitProgressKey('FrenchDefense_Classical')).toEqual(['FrenchDefense', 'Classical']);
      expect(splitProgressKey('KingsIndian')).toEqual(['KingsIndian']);
    });

    it('should handle edge cases', () => {
      expect(splitProgressKey('')).toEqual([]);
      // Underscore at position 0 - not split, returns whole string
      expect(splitProgressKey('_test')).toEqual(['_test']);
      // Underscore at last position - not split, returns whole string
      expect(splitProgressKey('test_')).toEqual(['test_']);
    });
  });

  describe('variationIdFromKey', () => {
    it('should return full key as variation ID', () => {
      // Note: variationIdFromKey returns the full key for uniqueness
      expect(variationIdFromKey('Sicilian_Najdorf_Main')).toBe('Sicilian_Najdorf_Main');
      expect(variationIdFromKey('French_Classical')).toBe('French_Classical');
      expect(variationIdFromKey('KingsIndian')).toBe('KingsIndian');
    });
  });

  describe('openingIdFromKey', () => {
    it('should extract opening name (first segment)', () => {
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
    // variationIdFromKey returns full key, so each key is its own variation
    expect(analysis.variationGroups.size).toBe(3);
    expect(analysis.openingGroups.size).toBe(2); // Sicilian, French
  });

  it('should detect completed variations', () => {
    const progressMap = {
      'Sicilian_Najdorf': 3,
      'Sicilian_Dragon': 2,
    };

    const analysis = analyzeProgressMap(progressMap);
    // variationIdFromKey returns full key
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
