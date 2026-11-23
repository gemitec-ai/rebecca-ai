import { COLLECTIONS, assertLoungeRecordOwnedByUid, type DbCollections } from '@rebecca/db';
import type {
  LoungeGalleryItem,
  LoungeGalleryListResponseDto,
  LoungePaginationQueryDto,
} from '@rebecca/types';
import { LoungeNotImplementedError, normalizePaginationQuery } from '../../../utils/errors';

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
 * Firestore repository skeleton reading and unlocking `collections.loungeGallery`
 * with strict per-user tenant ownership guards.
 */
export class LoungeGalleryRepository implements ILoungeGalleryRepository {
  constructor(private readonly collections: Pick<DbCollections, 'loungeGallery'>) {}

  /** Lists paginated Bot illustration gallery items for `uid` using the unified pagination contract. */
  public async listGalleryByUid(
    uid: string,
    query?: LoungePaginationQueryDto,
  ): Promise<LoungeGalleryListResponseDto> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_GALLERY);
    const safeQuery = normalizePaginationQuery(query);
    void this.collections.loungeGallery;
    void safeQuery;
    throw new LoungeNotImplementedError('LoungeGalleryRepository.listGalleryByUid');
  }

  /** Persists a Bot illustration asset displayed during chat into the user's Gallery idempotently. */
  public async unlockGalleryItem(
    uid: string,
    assetId: string,
    imageUrl: string,
    sessionId: string,
  ): Promise<LoungeGalleryItem> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_GALLERY);
    void this.collections.loungeGallery;
    void assetId;
    void imageUrl;
    void sessionId;
    throw new LoungeNotImplementedError('LoungeGalleryRepository.unlockGalleryItem');
  }

  /** Permanently deletes all unlocked gallery items owned by `uid`. */
  public async deleteAllUserGalleryItems(uid: string): Promise<void> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_GALLERY);
    void this.collections.loungeGallery;
    throw new LoungeNotImplementedError('LoungeGalleryRepository.deleteAllUserGalleryItems');
  }
}
