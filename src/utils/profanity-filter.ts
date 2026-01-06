/**
 * Profanity Filter Utility
 * Filters profanity with l33t speak detection for username validation
 *
 * Mirrors the Flutter implementation in content_filter.dart
 */

// Common profanity list (lowercase) - comprehensive but not exhaustive
// Using base words that will be expanded with l33t speak detection
const PROFANITY_WORDS: Set<string> = new Set([
  // Severe profanity
  'fuck', 'shit', 'ass', 'bitch', 'bastard', 'damn', 'crap',
  'dick', 'cock', 'pussy', 'cunt', 'whore', 'slut', 'fag',
  'faggot', 'nigger', 'nigga', 'retard', 'retarded',
  // Slurs and hate speech
  'kike', 'spic', 'chink', 'gook', 'wetback', 'beaner',
  'cracker', 'honky', 'tranny', 'dyke',
  // Sexual terms
  'porn', 'xxx', 'penis', 'vagina', 'boob', 'tits',
  'nude', 'naked', 'horny', 'orgasm', 'masturbate', 'ejaculate',
  // Drugs
  'cocaine', 'heroin', 'meth',
  // Violence
  'murder', 'rape', 'terrorist',
]);

// L33t speak substitutions
const LEET_SUBSTITUTIONS: Record<string, string[]> = {
  'a': ['4', '@', '^'],
  'b': ['8', '|3'],
  'c': ['(', '<', '{'],
  'e': ['3'],
  'g': ['6', '9'],
  'h': ['#', '|-|'],
  'i': ['1', '!', '|'],
  'l': ['1', '|', '7'],
  'o': ['0'],
  's': ['5', '$'],
  't': ['7', '+'],
  'u': ['v'],
  'z': ['2'],
};

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Generate regex pattern that matches l33t speak variations
 */
function generateLeetPattern(word: string): string {
  let pattern = '';

  for (const char of word.toLowerCase()) {
    const subs = LEET_SUBSTITUTIONS[char];
    if (subs && subs.length > 0) {
      const escaped = subs.map(s => escapeRegex(s)).join('|');
      pattern += `(?:${char}|${escaped})`;
    } else {
      pattern += escapeRegex(char);
    }
  }

  return pattern;
}

/**
 * Normalize text for profanity detection
 * Converts l33t speak to regular letters for simpler matching
 */
function normalizeLeetSpeak(text: string): string {
  let normalized = text.toLowerCase();

  // Simple character replacements
  normalized = normalized
    .replace(/4/g, 'a')
    .replace(/@/g, 'a')
    .replace(/8/g, 'b')
    .replace(/3/g, 'e')
    .replace(/6/g, 'g')
    .replace(/9/g, 'g')
    .replace(/1/g, 'i')
    .replace(/!/g, 'i')
    .replace(/\|/g, 'i')
    .replace(/0/g, 'o')
    .replace(/5/g, 's')
    .replace(/\$/g, 's')
    .replace(/7/g, 't')
    .replace(/\+/g, 't')
    .replace(/2/g, 'z');

  return normalized;
}

/**
 * Check if text contains profanity (including l33t speak variations)
 */
export function containsProfanity(text: string): boolean {
  const lower = text.toLowerCase();

  // First, normalize l33t speak to regular letters for better detection
  const normalized = normalizeLeetSpeak(text);

  for (const word of PROFANITY_WORDS) {
    // Check if the normalized text contains the profane word
    const normalizedRegex = new RegExp(`\\b${escapeRegex(word)}\\b`, 'i');
    if (normalizedRegex.test(normalized)) return true;

    // Also check original text with l33t pattern
    const pattern = generateLeetPattern(word);
    // Use looser boundary matching for l33t speak (numbers adjacent to words)
    const leetRegex = new RegExp(`(?:^|[^a-zA-Z])${pattern}(?:[^a-zA-Z]|$)`, 'i');
    if (leetRegex.test(lower)) return true;

    // Check spaced versions (e.g., "f u c k" or "f.u.c.k")
    if (word.length >= 3) {
      const spacedPattern = word.split('').join('[\\s._\\-*]+');
      const spacedRegex = new RegExp(`(?:^|[^a-zA-Z])${spacedPattern}(?:[^a-zA-Z]|$)`, 'i');
      if (spacedRegex.test(lower)) return true;
    }
  }

  return false;
}

/**
 * Check if username is appropriate (no profanity)
 */
export function isUsernameAppropriate(username: string): boolean {
  return !containsProfanity(username);
}

/**
 * Filter profanity from text (replace with asterisks)
 */
export function filterProfanity(text: string): string {
  let result = text;

  for (const word of PROFANITY_WORDS) {
    // Replace l33t variations
    const pattern = generateLeetPattern(word);
    const regex = new RegExp(`\\b${pattern}\\b`, 'gi');
    result = result.replace(regex, (match) => '*'.repeat(match.length));

    // Replace spaced versions
    if (word.length >= 3) {
      const spacedPattern = word.split('').join('[\\s._\\-*]+');
      const spacedRegex = new RegExp(`\\b${spacedPattern}\\b`, 'gi');
      result = result.replace(spacedRegex, (match) => '*'.repeat(match.length));
    }
  }

  return result;
}
