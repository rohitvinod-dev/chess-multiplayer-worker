/**
 * SCALABLE Leaderboard Cleanup Cron Job (Queue-Based)
 * Runs at 2 AM UTC daily
 *
 * This lightweight cron job enqueues leaderboard entries for cleanup processing.
 * The actual cleanup is handled by the queue consumer in parallel batches.
 *
 * Scalability: Can handle MILLIONS of leaderboard entries!
 */

import type { FirestoreClient } from '../firestore';

// ============ LIGHTWEIGHT CRON JOB (Enqueue Only) ============

export async function enqueueLeaderboardCleanup(
  firestore: FirestoreClient,
  cleanupQueue: Queue
): Promise<{
  success: boolean;
  enqueued: number;
  duration: number;
}> {
  const startTime = Date.now();
  let totalEnqueued = 0;

  console.log('[Cron] Starting leaderboard cleanup enqueue...');

  try {
    // Enqueue both ELO and Tactical leaderboards
    const [eloEnqueued, tacticalEnqueued] = await Promise.all([
      enqueueLeaderboardEntries(firestore, cleanupQueue, 'elo'),
      enqueueLeaderboardEntries(firestore, cleanupQueue, 'tactical'),
    ]);

    totalEnqueued = eloEnqueued + tacticalEnqueued;

    const duration = Date.now() - startTime;

    console.log(`[Cron] Leaderboard cleanup enqueue complete:`);
    console.log(`  - ELO: ${eloEnqueued} entries enqueued`);
    console.log(`  - Tactical: ${tacticalEnqueued} entries enqueued`);
    console.log(`  - Total: ${totalEnqueued} entries enqueued`);
    console.log(`  - Duration: ${duration}ms`);

    return {
      success: true,
      enqueued: totalEnqueued,
      duration,
    };
  } catch (error) {
    console.error('[Cron] Leaderboard cleanup enqueue failed:', error);
    return {
      success: false,
      enqueued: totalEnqueued,
      duration: Date.now() - startTime,
    };
  }
}

// ============ HELPER FUNCTIONS ============

async function enqueueLeaderboardEntries(
  firestore: FirestoreClient,
  cleanupQueue: Queue,
  leaderboardType: 'elo' | 'tactical'
): Promise<number> {
  const collectionPath = `leaderboards/${leaderboardType}/entries`;
  let enqueued = 0;

  try {
    // Get ALL leaderboard entries (no limit!)
    // This is now safe because we're just enqueuing, not processing
    const entries = await firestore.queryDocuments(collectionPath, []);

    console.log(`[Cron] Found ${entries.length} ${leaderboardType} leaderboard entries to check`);

    // Prepare queue messages
    const messages: QueueMessage[] = entries.map((entry) => ({
      body: {
        leaderboardType,
        userId: entry.userId,
        collectionPath,
      },
    }));

    // Send to queue in batches of 1000 (Cloudflare limit)
    for (let i = 0; i < messages.length; i += 1000) {
      const batch = messages.slice(i, i + 1000);
      await cleanupQueue.sendBatch(batch);
      enqueued += batch.length;

      console.log(`[Cron] Enqueued ${enqueued}/${messages.length} ${leaderboardType} entries...`);
    }

    console.log(`[Cron] ✓ Enqueued all ${enqueued} ${leaderboardType} entries`);
  } catch (error) {
    console.error(`[Cron] Error enqueuing ${leaderboardType} entries:`, error);
  }

  return enqueued;
}

// ============ QUEUE MESSAGE TYPES ============

interface QueueMessage {
  body: {
    leaderboardType: 'elo' | 'tactical';
    userId: string;
    collectionPath: string;
  };
}

// ============ QUEUE CONSUMER (Actual Cleanup Processing) ============

export async function processCleanupBatch(
  batch: MessageBatch<QueueMessage['body']>,
  firestore: FirestoreClient
): Promise<{ processed: number; cleaned: number; errors: number }> {
  let processed = 0;
  let cleaned = 0;
  let errors = 0;

  console.log(`[Queue] Processing cleanup batch of ${batch.messages.length} entries...`);

  // Process all messages in parallel
  await Promise.all(
    batch.messages.map(async (message) => {
      try {
        const { leaderboardType, userId, collectionPath } = message.body;

        // Check if user exists and is active
        const userDoc = await firestore.getDocument(`users/${userId}`);

        if (!userDoc || userDoc.deleted === true || userDoc.isActive === false) {
          // User is deleted or inactive, remove from leaderboard
          await firestore.deleteDocument(`${collectionPath}/${userId}`);

          console.log(`[Queue] ✓ Removed deleted user ${userId} from ${leaderboardType} leaderboard`);
          cleaned++;
        }

        processed++;
        message.ack(); // Mark as successfully processed
      } catch (error) {
        console.error(`[Queue] Error processing entry:`, error);
        errors++;
        message.retry(); // Retry up to 3 times (configured in wrangler.toml)
      }
    })
  );

  console.log(`[Queue] Batch complete: ${processed} processed, ${cleaned} cleaned, ${errors} errors`);

  return { processed, cleaned, errors };
}
