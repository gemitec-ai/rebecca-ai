import type { Firestore, Transaction } from '@google-cloud/firestore';
import {
  COLLECTIONS,
  assertLoungeRecordOwnedByUid,
  createUserScopedLoungeGalleryDb,
  type DbCollections,
} from '@rebecca/db';
import {
  AssetStatus,
  type LoungeGalleryItem,
  type LoungeGalleryListResponseDto,
  type LoungePaginationQueryDto,
} from '@rebecca/types';
import { LoungeValidationError, normalizePaginationQuery } from '../../../utils/errors';
import { deleteQueryInBatches } from '../../../utils/firestoreBatch';

/** Default page size applied consistently across Gallery controller, use case, and repository. */
export const DEFAULT_LOUNGE_GALLERY_LIMIT = 12;

/**
 * Persistence boundary for isolated `lounge_gallery` user illustration unlock records.
 */
export interface ILoungeGalleryRepository {
  /**
   * Lists paginated Bot illustration gallery items owned by `uid`.
   *
   * @throws LoungeValidationError When `query.cursor` is invalid or belongs to another user (`400`).
   */
  listGalleryByUid(
    uid: string,
    query?: LoungePaginationQueryDto,
  ): Promise<LoungeGalleryListResponseDto>;
  /**
   * Idempotently unlocks a Bot illustration for `uid` when `lounge_users/{uid}` is `ACTIVE`;
   * returns `null` without writing when the account is missing or no longer active.
   */
  unlockGalleryItem(
    uid: string,
    assetId: string,
    imageUrl: string,
    sessionId: string,
  ): Promise<LoungeGalleryItem | null>;
  /** Permanently deletes all gallery items owned by `uid` in chunked batches. */
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
      'loungeUsers' | 'loungeGallery' | 'images'
    >,
  ) {}

  /**
   * Lists paginated Bot illustration gallery items for `uid` using server-side cursor/offset pagination
   * and Firestore `.count()` aggregations over unlocked items and `AssetStatus.SUCCESS` catalog assets.
   *
   * @throws LoungeValidationError When an explicit `cursor` does not exist or belongs to another user (`400`).
   */
  public async listGalleryByUid(
    uid: string,
    query?: LoungePaginationQueryDto,
  ): Promise<LoungeGalleryListResponseDto> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_GALLERY);
    const safeQuery = normalizePaginationQuery(query, DEFAULT_LOUNGE_GALLERY_LIMIT);
    const scoped = createUserScopedLoungeGalleryDb(this.collections, uid);

    let galleryPageQuery = scoped
      .galleryQuery()
      .orderBy('unlocked', 'desc')
      .orderBy('__name__', 'desc');

    if (safeQuery.cursor) {
      const cursorSnap = await this.collections.loungeGallery.doc(safeQuery.cursor).get();
      if (!cursorSnap.exists || cursorSnap.data()?.uid !== uid) {
        throw new LoungeValidationError('Invalid gallery pagination cursor');
      }
      galleryPageQuery = galleryPageQuery.startAfter(cursorSnap);
    } else if (safeQuery.page > 1) {
      const offsetCount = (safeQuery.page - 1) * safeQuery.limit;
      galleryPageQuery = galleryPageQuery.offset(offsetCount);
    }

    const [totalSnap, unlockedCountSnap, readyCatalogCountSnap, pageSnap] = await Promise.all([
      scoped.galleryQuery().count().get(),
      scoped.galleryQuery().where('unlocked', '==', true).count().get(),
      this.collections.images.where('status', '==', AssetStatus.SUCCESS).count().get(),
      galleryPageQuery.limit(safeQuery.limit + 1).get(),
    ]);

    const totalItems = totalSnap.data().count;
    const unlockedCount = unlockedCountSnap.data().count;
    const readyCatalogCount = readyCatalogCountSnap.data().count;
    const totalCount = Math.max(unlockedCount, readyCatalogCount, totalItems);
    const totalPages = Math.max(1, Math.ceil(totalItems / safeQuery.limit));
    const currentPage = Math.min(safeQuery.page, totalPages);

    const hasMore = pageSnap.docs.length > safeQuery.limit;
    const pagedData = pageSnap.docs
      .slice(0, safeQuery.limit)
      .map((doc) => scoped.assertOwned(doc.data(), COLLECTIONS.LOUNGE_GALLERY));
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

  /**
   * Persists a Bot illustration asset displayed during chat into the user's Gallery idempotently
   * while verifying inside the transaction that `lounge_users/{uid}` still exists and is `ACTIVE`.
   */
  public async unlockGalleryItem(
    uid: string,
    assetId: string,
    imageUrl: string,
    sessionId: string,
  ): Promise<LoungeGalleryItem | null> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_GALLERY);
    const scoped = createUserScopedLoungeGalleryDb(this.collections, uid);
    const docRef = scoped.galleryDoc(assetId);

    return this.firestore.runTransaction(async (tx: Transaction) => {
      const [userSnap, existingSnap] = await Promise.all([
        tx.get(scoped.userDoc()),
        tx.get(docRef),
      ]);
      const userDoc = userSnap.data();
      if (!userSnap.exists || !userDoc || userDoc.status !== 'ACTIVE') {
        return null;
      }

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
    const scoped = createUserScopedLoungeGalleryDb(this.collections, uid);
    await deleteQueryInBatches(this.firestore, scoped.galleryQuery());
  }
}
