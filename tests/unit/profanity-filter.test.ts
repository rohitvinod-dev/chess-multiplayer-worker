/**
 * Unit tests for profanity filter utility
 */

import { describe, it, expect } from 'vitest';
import {
  containsProfanity,
  isUsernameAppropriate,
  filterProfanity,
} from '../../src/utils/profanity-filter';

describe('Profanity Filter', () => {
  describe('containsProfanity', () => {
    it('should detect basic profanity', () => {
      expect(containsProfanity('fuck')).toBe(true);
      expect(containsProfanity('shit')).toBe(true);
      expect(containsProfanity('bitch')).toBe(true);
    });

    it('should detect profanity in context', () => {
      expect(containsProfanity('what the fuck')).toBe(true);
      expect(containsProfanity('holy shit')).toBe(true);
    });

    it('should detect l33t speak variations', () => {
      // After normalization and pattern matching
      expect(containsProfanity('fvck')).toBe(true); // v->u makes fuck
      expect(containsProfanity('sh1t')).toBe(true); // 1->i makes shit
      expect(containsProfanity('a55')).toBe(true);  // 5->s makes ass
      expect(containsProfanity('b1tch')).toBe(true); // 1->i makes bitch
    });

    it('should detect spaced out profanity', () => {
      expect(containsProfanity('f u c k')).toBe(true);
      expect(containsProfanity('s.h.i.t')).toBe(true);
      expect(containsProfanity('f-u-c-k')).toBe(true);
    });

    it('should not flag clean text', () => {
      expect(containsProfanity('hello world')).toBe(false);
      expect(containsProfanity('chess player')).toBe(false);
      expect(containsProfanity('checkmate')).toBe(false);
      expect(containsProfanity('GrandMaster2024')).toBe(false);
    });

    it('should not flag partial matches in clean words', () => {
      expect(containsProfanity('assassin')).toBe(false); // contains 'ass' but not as standalone
      expect(containsProfanity('class')).toBe(false);
      expect(containsProfanity('pass')).toBe(false);
    });
  });

  describe('isUsernameAppropriate', () => {
    it('should approve clean usernames', () => {
      expect(isUsernameAppropriate('ChessMaster')).toBe(true);
      expect(isUsernameAppropriate('Player123')).toBe(true);
      expect(isUsernameAppropriate('KingOfChess')).toBe(true);
      expect(isUsernameAppropriate('RookiePlayer')).toBe(true);
    });

    it('should reject standalone profane usernames', () => {
      // Note: Current implementation uses word boundaries, so standalone words are detected
      expect(isUsernameAppropriate('fuck')).toBe(false);
      expect(isUsernameAppropriate('shit')).toBe(false);
      expect(isUsernameAppropriate('dick')).toBe(false);
    });

    it('should reject profanity with separators', () => {
      // Words with underscores/hyphens still detected due to looser boundary matching
      expect(isUsernameAppropriate('fuck_player')).toBe(false);
      expect(isUsernameAppropriate('shit-master')).toBe(false);
    });
  });

  describe('filterProfanity', () => {
    it('should replace profanity with asterisks', () => {
      expect(filterProfanity('fuck you')).toBe('**** you');
      expect(filterProfanity('holy shit')).toBe('holy ****');
    });

    it('should preserve clean text', () => {
      expect(filterProfanity('hello world')).toBe('hello world');
      expect(filterProfanity('checkmate!')).toBe('checkmate!');
    });

    it('should handle multiple profane words', () => {
      const result = filterProfanity('fuck this shit');
      expect(result).not.toContain('fuck');
      expect(result).not.toContain('shit');
    });
  });
});
