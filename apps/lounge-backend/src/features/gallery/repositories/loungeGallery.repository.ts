import type { Firestore, Transaction } from '@google-cloud/firestore';
import {
  COLLECTIONS,
  assertLoungeRecordOwnedByUid,
  createUserScopedLoungeDb,
  type DbCollections,
} from '@rebecca/db';
import {
  AssetStatus,
  type LoungeGalleryItem,
  type LoungeGalleryListResponseDto,
  type LoungePaginationQueryDto,
} from '@rebecca/types';
import { normalizePaginationQuery } from '../../../utils/errors';
import { deleteQueryInBatches } from '../../../utils/firestoreBatch';

/**
 * Persistence boundary for isolated `lounge_gallery` user illustration unlock records.
 */
export interface ILoungeGalleryRepository {
  listGalleryByUid(
    uid: string,
    query?: LoungePaginationQueryDto,
  ): Promise<LoungeGalleryListResponseDto>;
  unlockGalleryItem(
    uid: string,
    assetId: string,
    imageUrl: string,
    sessionId: string,
  ): Promise<LoungeGalleryItem>;
  deleteAllUserGalleryItems(uid: string): Promise<void>;
}

/**
 * Firestore repository managing unlocked `lounge_gallery` items scoped strictly to the caller UID
 * while aggregating catalog totals read-only from `collections.images`.
 */
export class LoungeGalleryRepository implements ILoungeGalleryRepository {
  constructor(
    private readonly firestore: Firestore,
    private readonly collections: Pick<
      DbCollections,
      | 'loungeUsers'
      | 'loungeSubscriptions'
      | 'loungeSessions'
      | 'loungeMessages'
      | 'loungeRagMemories'
      | 'loungeGallery'
      | 'loungeCreditLots'
      | 'loungeQuotaLedger'
      | 'images'
    >,
  ) {}

  /** Lists paginated Bot illustration gallery items for `uid` using the unified pagination contract. */
  public async listGalleryByUid(
    uid: string,
    query?: LoungePaginationQueryDto,
  ): Promise<LoungeGalleryListResponseDto> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_GALLERY);
    const safeQuery = normalizePaginationQuery(query, 12);
    const scoped = createUserScopedLoungeDb(this.collections, uid);

    const [allGallerySnap, catalogImagesSnap] = await Promise.all([
      scoped.galleryQuery().orderBy('unlocked', 'desc').get(),
      this.collections.images.limit(500).get(),
    ]);

    const items = allGallerySnap.docs
      .map((doc) => scoped.assertOwned(doc.data(), COLLECTIONS.LOUNGE_GALLERY))
      .sort((a, b) => {
        if (a.unlocked !== b.unlocked) {
          return a.unlocked ? -1 : 1;
        }
        return (b.unlockedAt ?? '').localeCompare(a.unlockedAt ?? '');
      });

    const unlockedCount = items.filter((item) => item.unlocked).length;
    const readyCatalogCount = catalogImagesSnap.docs.filter((docSnap) => {
      const status = docSnap.data().status;
      return (
        status !== AssetStatus.FAILED &&
        status !== AssetStatus.PROCESSING &&
        status !== AssetStatus.PENDING
      );
    }).length;
    const totalCount = Math.max(unlockedCount, readyCatalogCount, items.length);

    const totalItems = items.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / safeQuery.limit));
    const currentPage = Math.min(safeQuery.page, totalPages);
    const startIdx = (currentPage - 1) * safeQuery.limit;
    const pagedData = items.slice(startIdx, startIdx + safeQuery.limit);
    const hasMore = startIdx + pagedData.length < totalItems;
    const nextCursor =
      hasMore && pagedData.length > 0 ? pagedData[pagedData.length - 1].id : null;

    return {
      data: pagedData,
      meta: {
        totalItems,
        totalPages,
        currentPage,
        limit: safeQuery.limit,
        nextCursor,
        hasMore,
      },
      summary: {
        unlockedCount,
        totalCount,
      },
    };
  }

  /** Persists a Bot illustration asset displayed during chat into the user's Gallery idempotently. */
  public async unlockGalleryItem(
    uid: string,
    assetId: string,
    imageUrl: string,
    sessionId: string,
  ): Promise<LoungeGalleryItem> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_GALLERY);
    const scoped = createUserScopedLoungeDb(this.collections, uid);
    const docRef = scoped.galleryDoc(assetId);

    return this.firestore.runTransaction(async (tx: Transaction) => {
      const existingSnap = await tx.get(docRef);
      const existing = existingSnap.data();
      if (existingSnap.exists && existing && existing.unlocked) {
        return scoped.assertOwned(existing, COLLECTIONS.LOUNGE_GALLERY);
      }

      const item: LoungeGalleryItem = {
        id: `${uid}_${assetId}`,
        uid,
        assetId,
        imageUrl,
        unlocked: true,
        unlockedAt: existing?.unlockedAt ?? new Date().toISOString(),
        sourceSessionId: sessionId,
      };
      tx.set(docRef, item);
      return item;
    });
  }

  /** Permanently deletes all gallery items owned by `uid` in chunks (`<= 450`). */
  public async deleteAllUserGalleryItems(uid: string): Promise<void> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_GALLERY);
    const scoped = createUserScopedLoungeDb(this.collections, uid);
    await deleteQueryInBatches(this.firestore, scoped.galleryQuery());
  }
}
