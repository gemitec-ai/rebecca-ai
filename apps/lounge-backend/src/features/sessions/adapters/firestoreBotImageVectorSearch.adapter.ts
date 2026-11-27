import { FieldValue, type Firestore } from '@google-cloud/firestore';
import { COLLECTIONS, type DbCollections } from '@rebecca/db';
import { AssetStatus } from '@rebecca/types';
import { loungeLogger, toSingleLineLog } from '../../../utils/logger';
import type {
  IBotImageAssetSearchPort,
  ILoungeEmbeddingPort,
  MatchedBotImageAsset,
} from '../ports/loungeAi.port';
import { computeCosineSimilarity } from '../repositories/loungeSession.repository';

/**
 * Vector candidate searcher querying `collections.images` (excluding recent session illustrations)
 * for Stage 2 of the 3-stage autonomous image-matching pipeline.
 */
export class FirestoreBotImageVectorSearchAdapter implements IBotImageAssetSearchPort {
  constructor(
    private readonly firestore: Firestore,
    private readonly collections: Pick<DbCollections, 'images'>,
    private readonly embeddingPort: ILoungeEmbeddingPort,
    private readonly similarityThreshold: number = 0.45,
    private readonly isEmulator: boolean = false,
  ) {}

  /** Returns top semantic illustration candidates above `similarityThreshold` not in `excludeAssetIds`. */
  public async findCandidateImages(
    searchQuery: string,
    excludeAssetIds: ReadonlySet<string>,
    limit = 3,
  ): Promise<MatchedBotImageAsset[]> {
    const queryVector = await this.embeddingPort.embedQuery(searchQuery.trim().slice(0, 300));
    if (queryVector.length === 0) {
      return [];
    }

    try {
      const snap = await this.firestore
        .collection(COLLECTIONS.IMAGES)
        .findNearest({
          vectorField: 'embedding',
          queryVector: FieldValue.vector(queryVector),
          limit: Math.min(100, Math.max(6, limit + excludeAssetIds.size)),
          distanceMeasure: 'COSINE',
          distanceResultField: 'vectorDistance',
        })
        .get();

      const results: MatchedBotImageAsset[] = [];
      for (const doc of snap.docs) {
        if (excludeAssetIds.has(doc.id)) {
          continue;
        }
        const raw = doc.data() as {
          readonly url?: unknown;
          readonly caption?: unknown;
          readonly status?: unknown;
          readonly vectorDistance?: unknown;
        };
        const status = typeof raw.status === 'string' ? raw.status.toUpperCase() : undefined;
        if (status !== AssetStatus.SUCCESS) {
          continue;
        }
        const imageUrl = typeof raw.url === 'string' ? raw.url.trim() : '';
        if (!imageUrl) {
          continue;
        }
        const distance = typeof raw.vectorDistance === 'number' ? raw.vectorDistance : 1;
        const similarity = 1 - distance;
        if (similarity >= this.similarityThreshold) {
          results.push({
            assetId: doc.id,
            imageUrl,
            caption: typeof raw.caption === 'string' ? raw.caption.trim() : '',
          });
          if (results.length >= limit) {
            break;
          }
        }
      }
      if (!snap.empty || !this.isEmulator) {
        return results;
      }
    } catch (err) {
      if (!this.isEmulator) {
        loungeLogger.warn('Bot image vector lookup failed cleanly (skipping illustration)', {
          reason: toSingleLineLog(err instanceof Error ? err.message : String(err)),
        });
        return [];
      }
    }

    // Emulator deterministic cosine similarity lookup
    const allSnap = await this.collections.images.limit(50).get();
    const ranked: Array<{ readonly item: MatchedBotImageAsset; readonly score: number }> = [];
    for (const doc of allSnap.docs) {
      if (excludeAssetIds.has(doc.id)) {
        continue;
      }
      const img = doc.data();
      const status = typeof img.status === 'string' ? img.status.toUpperCase() : undefined;
      if (status !== AssetStatus.SUCCESS) {
        continue;
      }
      if (!img.url || !Array.isArray(img.embedding) || img.embedding.length === 0) {
        continue;
      }
      const score = computeCosineSimilarity(queryVector, img.embedding);
      if (score >= this.similarityThreshold) {
        ranked.push({
          item: {
            assetId: doc.id,
            imageUrl: img.url,
            caption: typeof img.caption === 'string' ? img.caption.trim() : '',
          },
          score,
        });
      }
    }
    return ranked
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.item);
  }
}
