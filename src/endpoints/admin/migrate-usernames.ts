/**
 * Username Migration Endpoint
 *
 * Migrates existing usernames to the new standard convention:
 * - Length: 3-25 characters
 * - Allowed: letters, numbers, underscores, hyphens (NO periods)
 * - Must start with letter or number
 * - Must end with letter or number
 * - Must contain at least one letter (no numbers-only)
 * - No consecutive special characters (-- or __)
 * - No profanity
 */

import type { Env } from '../../types';
import { FirestoreClient } from '../../firestore';
import { sanitizeUsername, validateUsername, USERNAME_CONSTRAINTS, deriveUsernameFromEmail, generateUniqueUsernameVariant } from '../../utils/mastery';
import { isUsernameAppropriate } from '../../utils/profanity-filter';

/**
 * Query ALL existing usernames from the database before processing
 * This prevents cross-batch conflicts during migration
 */
async function getAllTakenUsernames(firestore: FirestoreClient): Promise<Set<string>> {
  const taken = new Set<string>();
  let pageToken: string | undefined;

  console.log('Fetching all existing usernames for conflict detection...');

  do {
    const result = await firestore.listDocuments('users', {
      pageSize: 500,
      pageToken,
    });

    for (const doc of result.documents) {
      if (doc.data?.usernameLower) {
        taken.add(doc.data.usernameLower.toLowerCase());
      }
    }
    pageToken = result.nextPageToken;
  } while (pageToken);

  console.log(`Loaded ${taken.size} existing usernames for conflict detection`);
  return taken;
}

/**
 * Check for existing duplicate usernames in the database
 * Returns users grouped by their lowercase username
 */
async function findDuplicateUsernames(firestore: FirestoreClient): Promise<Map<string, Array<{ id: string; createdAt?: Date }>>> {
  const usernameToUsers = new Map<string, Array<{ id: string; createdAt?: Date }>>();
  let pageToken: string | undefined;

  do {
    const result = await firestore.listDocuments('users', {
      pageSize: 500,
      pageToken,
    });

    for (const doc of result.documents) {
      const usernameLower = doc.data?.usernameLower?.toLowerCase();
      if (usernameLower) {
        const existing = usernameToUsers.get(usernameLower) || [];
        existing.push({
          id: doc.id,
          createdAt: doc.data?.createdAt ? new Date(doc.data.createdAt) : undefined,
        });
        usernameToUsers.set(usernameLower, existing);
      }
    }
    pageToken = result.nextPageToken;
  } while (pageToken);

  // Filter to only duplicates (more than one user with same username)
  const duplicates = new Map<string, Array<{ id: string; createdAt?: Date }>>();
  for (const [username, users] of usernameToUsers) {
    if (users.length > 1) {
      // Sort by createdAt - oldest first (they keep the username)
      users.sort((a, b) => {
        if (!a.createdAt && !b.createdAt) return 0;
        if (!a.createdAt) return 1;
        if (!b.createdAt) return -1;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });
      duplicates.set(username, users);
    }
  }

  return duplicates;
}

interface UserDocument {
  username?: string;
  usernameLower?: string;
  email?: string;
  createdAt?: string;
}

interface MigrationResult {
  userId: string;
  oldUsername: string;
  newUsername: string | null;
  status: 'unchanged' | 'synced' | 'migrated' | 'migrated_from_email' | 'conflict' | 'invalid' | 'duplicate_fixed' | 'write_failed';
  source?: 'sanitized' | 'email_derived' | 'duplicate_suffix';
  error?: string;
  writeErrors?: string[];
}

interface MigrationReport {
  totalProcessed: number;
  unchanged: number;
  synced: number;
  migrated: number;
  migratedFromEmail: number;
  duplicatesFixed: number;
  conflicts: number;
  invalid: number;
  writeFailed: number;
  results: MigrationResult[];
  takenUsernames: Set<string>;
}

/**
 * Migrate a single username to the new format
 * Falls back to email-derived username if sanitization fails
 */
function migrateUsername(oldUsername: string, email?: string | null): string | null {
  // First, try direct validation - if already valid, no change needed
  const validation = validateUsername(oldUsername);
  if (validation.isValid) {
    return oldUsername;
  }

  // Try sanitization to auto-fix issues
  const sanitized = sanitizeUsername(oldUsername);
  if (sanitized && validateUsername(sanitized).isValid) {
    return sanitized;
  }

  // Fallback: derive username from email (Google account name)
  const emailDerived = deriveUsernameFromEmail(email);
  if (emailDerived) {
    return emailDerived;
  }

  return null;
}

/**
 * Handle username migration request
 *
 * Query params:
 * - dryRun=true: Only report what would change, don't apply
 * - limit=100: Max users to process (default 100, max 1000)
 * - startAfter=userId: Pagination cursor
 * - fixDuplicates=true: Also fix existing duplicate usernames
 * - syncAll=true: Sync ALL usernames to all collections (leaderboard, public/data, etc.)
 */
export async function handleMigrateUsernames(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === 'true';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 1000);
  const startAfter = url.searchParams.get('startAfter') || null;
  const fixDuplicates = url.searchParams.get('fixDuplicates') === 'true';
  const syncAll = url.searchParams.get('syncAll') === 'true';

  const report: MigrationReport = {
    totalProcessed: 0,
    unchanged: 0,
    synced: 0,
    migrated: 0,
    migratedFromEmail: 0,
    duplicatesFixed: 0,
    conflicts: 0,
    invalid: 0,
    writeFailed: 0,
    results: [],
    takenUsernames: new Set<string>(),
  };

  try {
    // Create Firestore client
    const firestore = new FirestoreClient({
      projectId: env.FIREBASE_PROJECT_ID,
      serviceAccount: env.FIREBASE_SERVICE_ACCOUNT,
    });

    // CRITICAL FIX: Load ALL existing usernames before processing ANY batch
    // This prevents cross-batch conflicts
    report.takenUsernames = await getAllTakenUsernames(firestore);

    // If fixDuplicates is enabled, find and fix existing duplicates first
    if (fixDuplicates) {
      const duplicates = await findDuplicateUsernames(firestore);
      console.log(`Found ${duplicates.size} duplicate username groups`);

      for (const [usernameLower, users] of duplicates) {
        // First user (oldest) keeps the username, others get suffix
        for (let i = 1; i < users.length; i++) {
          const user = users[i];
          const baseUsername = usernameLower; // Use the existing username as base
          const uniqueUsername = generateUniqueUsernameVariant(baseUsername, report.takenUsernames);

          if (uniqueUsername) {
            if (!dryRun) {
              await updateUserUsername(firestore, user.id, uniqueUsername);
            }
            report.takenUsernames.add(uniqueUsername.toLowerCase());
            report.results.push({
              userId: user.id,
              oldUsername: usernameLower,
              newUsername: uniqueUsername,
              status: 'duplicate_fixed',
              source: 'duplicate_suffix',
            });
            report.duplicatesFixed++;
          } else {
            report.results.push({
              userId: user.id,
              oldUsername: usernameLower,
              newUsername: null,
              status: 'conflict',
              error: 'Duplicate username, could not generate unique variant',
            });
            report.conflicts++;
          }
        }
      }
    }

    // Fetch users with pagination for main migration
    const usersResult = await firestore.listDocuments('users', {
      pageSize: limit,
      pageToken: startAfter || undefined,
    });

    const documents = usersResult.documents;

    // Second pass: migrate usernames
    for (const doc of documents) {
      const userId = doc.id;
      const oldUsername = doc.data?.username || '';
      const email = doc.data?.email || '';

      report.totalProcessed++;

      if (!oldUsername) {
        // No username - try to derive from email
        const emailDerived = deriveUsernameFromEmail(email);
        if (emailDerived) {
          // Check for conflicts with email-derived username
          const emailDerivedLower = emailDerived.toLowerCase();
          if (report.takenUsernames.has(emailDerivedLower)) {
            const uniqueUsername = generateUniqueUsernameVariant(emailDerived, report.takenUsernames);
            if (uniqueUsername) {
              if (!dryRun) {
                await updateUserUsername(firestore, userId, uniqueUsername);
              }
              report.takenUsernames.add(uniqueUsername.toLowerCase());
              report.results.push({
                userId,
                oldUsername: '',
                newUsername: uniqueUsername,
                status: 'migrated_from_email',
                source: 'email_derived',
              });
              report.migratedFromEmail++;
              continue;
            }
          } else {
            if (!dryRun) {
              await updateUserUsername(firestore, userId, emailDerived);
            }
            report.takenUsernames.add(emailDerivedLower);
            report.results.push({
              userId,
              oldUsername: '',
              newUsername: emailDerived,
              status: 'migrated_from_email',
              source: 'email_derived',
            });
            report.migratedFromEmail++;
            continue;
          }
        }

        report.results.push({
          userId,
          oldUsername: '',
          newUsername: null,
          status: 'invalid',
          error: 'No username found and could not derive from email',
        });
        report.invalid++;
        continue;
      }

      // Check profanity
      if (!isUsernameAppropriate(oldUsername)) {
        // Try sanitization first, then email fallback
        const sanitized = sanitizeUsername(oldUsername);
        if (!sanitized) {
          const emailDerived = deriveUsernameFromEmail(email);
          if (!emailDerived) {
            report.results.push({
              userId,
              oldUsername,
              newUsername: null,
              status: 'invalid',
              error: 'Contains inappropriate content and cannot be sanitized or derived from email',
            });
            report.invalid++;
            continue;
          }
        }
      }

      // Try to migrate (includes email fallback)
      const newUsername = migrateUsername(oldUsername, email);

      // Determine if the username was derived from email
      const wasFromEmail = newUsername &&
        sanitizeUsername(oldUsername) === null &&
        deriveUsernameFromEmail(email) === newUsername;

      if (newUsername === oldUsername) {
        // Already valid, no change needed to username itself
        // But if syncAll is enabled, sync to all collections anyway
        if (syncAll && !dryRun) {
          const writeResult = await syncUsernameToAllCollections(firestore, userId, oldUsername);
          if (writeResult.success) {
            report.synced++;
            report.results.push({
              userId,
              oldUsername,
              newUsername: oldUsername,
              status: 'synced',
            });
          } else {
            report.writeFailed++;
            report.results.push({
              userId,
              oldUsername,
              newUsername: oldUsername,
              status: 'write_failed',
              writeErrors: writeResult.errors,
            });
          }
        } else {
          report.unchanged++;
          report.results.push({
            userId,
            oldUsername,
            newUsername: oldUsername,
            status: 'unchanged',
          });
        }
        continue;
      }

      if (!newUsername) {
        report.results.push({
          userId,
          oldUsername,
          newUsername: null,
          status: 'invalid',
          error: 'Cannot be sanitized to valid format or derived from email',
        });
        report.invalid++;
        continue;
      }

      // Check for conflicts
      const newUsernameLower = newUsername.toLowerCase();
      if (report.takenUsernames.has(newUsernameLower) && newUsernameLower !== oldUsername.toLowerCase()) {
        // Try to generate unique variant
        const uniqueUsername = generateUniqueUsernameVariant(newUsername, report.takenUsernames);
        if (uniqueUsername) {
          if (!dryRun) {
            await updateUserUsername(firestore, userId, uniqueUsername);
          }
          report.takenUsernames.add(uniqueUsername.toLowerCase());
          report.results.push({
            userId,
            oldUsername,
            newUsername: uniqueUsername,
            status: wasFromEmail ? 'migrated_from_email' : 'migrated',
            source: wasFromEmail ? 'email_derived' : 'sanitized',
          });
          if (wasFromEmail) {
            report.migratedFromEmail++;
          } else {
            report.migrated++;
          }
        } else {
          report.results.push({
            userId,
            oldUsername,
            newUsername: null,
            status: 'conflict',
            error: `Conflict with existing username, could not generate unique variant`,
          });
          report.conflicts++;
        }
        continue;
      }

      // Apply migration
      if (!dryRun) {
        await updateUserUsername(firestore, userId, newUsername);
      }
      report.takenUsernames.add(newUsernameLower);
      report.results.push({
        userId,
        oldUsername,
        newUsername,
        status: wasFromEmail ? 'migrated_from_email' : 'migrated',
        source: wasFromEmail ? 'email_derived' : 'sanitized',
      });
      if (wasFromEmail) {
        report.migratedFromEmail++;
      } else {
        report.migrated++;
      }
    }

    // Prepare response (remove takenUsernames set for JSON serialization)
    const responseData = {
      dryRun,
      syncAll,
      totalProcessed: report.totalProcessed,
      unchanged: report.unchanged,
      synced: report.synced,
      migrated: report.migrated,
      migratedFromEmail: report.migratedFromEmail,
      duplicatesFixed: report.duplicatesFixed,
      conflicts: report.conflicts,
      invalid: report.invalid,
      writeFailed: report.writeFailed,
      nextPageToken: usersResult.nextPageToken || null,
      results: report.results,
    };

    return new Response(JSON.stringify(responseData, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Migration error:', error);
    return new Response(
      JSON.stringify({ error: 'Migration failed', details: String(error) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Sync username to all collections without updating the users document
 * Used when username is already valid but needs to be synced to leaderboards/public profile
 */
async function syncUsernameToAllCollections(firestore: FirestoreClient, userId: string, username: string): Promise<{ success: boolean; errors: string[] }> {
  return await updateLeaderboardUsername(firestore, userId, username);
}

/**
 * Update a user's username in Firestore
 */
async function updateUserUsername(firestore: FirestoreClient, userId: string, newUsername: string): Promise<void> {
  await firestore.setDocument(`users/${userId}`, {
    username: newUsername,
    usernameLower: newUsername.toLowerCase(),
    usernameUpdatedAt: new Date(),
    usernameMigratedFromLegacy: true,
  }, { merge: true });

  // Also update leaderboards
  await updateLeaderboardUsername(firestore, userId, newUsername);
}

/**
 * Small delay to avoid rate limiting
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Update username in ALL collections that store it
 * Throws on failure so caller can track failures properly
 */
async function updateLeaderboardUsername(firestore: FirestoreClient, userId: string, newUsername: string): Promise<{ success: boolean; errors: string[] }> {
  const usernameLower = newUsername.toLowerCase();
  const errors: string[] = [];

  // 1. Update usernames collection for atomic uniqueness checking
  try {
    // Check if this username is already claimed by someone else
    const existing = await firestore.getDocument(`usernames/${usernameLower}`);
    if (!existing || existing.uid === userId) {
      // Safe to claim/update
      await firestore.setDocument(`usernames/${usernameLower}`, {
        uid: userId,
        username: newUsername,
        claimedAt: existing?.claimedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      console.log(`Synced username '${newUsername}' to usernames collection for ${userId}`);
    } else {
      console.warn(`Username '${newUsername}' already claimed by ${existing.uid}, skipping usernames collection for ${userId}`);
    }
  } catch (error) {
    const msg = `Error updating usernames collection for ${userId}: ${error}`;
    console.error(msg);
    errors.push(msg);
  }

  // Small delay between writes to avoid rate limiting
  await delay(50);

  // 2. Update main training leaderboard (leaderboard/{userId})
  try {
    await firestore.setDocument(`leaderboard/${userId}`, {
      username: newUsername,
      usernameLower: usernameLower,
    }, { merge: true });
    console.log(`Synced username '${newUsername}' to leaderboard for ${userId}`);
  } catch (error) {
    const msg = `Error updating leaderboard for ${userId}: ${error}`;
    console.error(msg);
    errors.push(msg);
  }

  // Small delay between writes
  await delay(50);

  // 3. Update public profile (users/{userId}/public/data)
  try {
    await firestore.setDocument(`users/${userId}/public/data`, {
      username: newUsername,
    }, { merge: true });
    console.log(`Synced username '${newUsername}' to public profile for ${userId}`);
  } catch (error) {
    const msg = `Error updating public profile for ${userId}: ${error}`;
    console.error(msg);
    errors.push(msg);
  }

  return { success: errors.length === 0, errors };
}
