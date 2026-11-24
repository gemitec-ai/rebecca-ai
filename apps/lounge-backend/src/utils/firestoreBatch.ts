import type { Firestore, Query } from '@google-cloud/firestore';

/** Maximum Firestore batch operations per commit with safety headroom below the 500 hard limit. */
export const FIRESTORE_SAFE_BATCH_LIMIT = 450;

/**
 * Deletes every document matched by a scoped Firestore query in chunked WriteBatches (`<= 450` per commit).
 * Prevents memory spikes and Firestore 500-op WriteBatch limit errors during cascade account withdrawal.
 */
export async function deleteQueryInBatches<T>(
  firestore: Firestore,
  query: Query<T>,
  chunkSize: number = FIRESTORE_SAFE_BATCH_LIMIT,
): Promise<number> {
  const safeChunkSize = Math.max(1, Math.min(chunkSize, FIRESTORE_SAFE_BATCH_LIMIT));
  let deletedCount = 0;

  while (true) {
    const snapshot = await query.limit(safeChunkSize).get();
    if (snapshot.empty) {
      return deletedCount;
    }

    const batch = firestore.batch();
    for (const doc of snapshot.docs) {
      batch.delete(doc.ref);
    }
    await batch.commit();
    deletedCount += snapshot.size;

    if (snapshot.size < safeChunkSize) {
      return deletedCount;
    }
  }
}
