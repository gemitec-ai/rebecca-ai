import type { DbCollections } from '@rebecca/db';
import type { LoungeGalleryItem, LoungeGalleryListResponseDto } from '@rebecca/types';
import { LoungeNotImplementedError, normalizePaginationLimit } from '../../../utils/errors';

/**
 * Persistence boundary for isolated `lounge_gallery` user illustration unlock records.
 */
export interface ILoungeGalleryRepository {
  listGalleryByUid(
    uid: string,
    limit?: number,
    startAfterId?: string,
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
 * Firestore repository skeleton reading and unlocking `collections.loungeGallery`.
 */
export class LoungeGalleryRepository implements ILoungeGalleryRepository {
  constructor(private readonly collections: Pick<DbCollections, 'loungeGallery'>) {}

  /** Lists paginated Bot illustration gallery items for `uid`. */
  public async listGalleryByUid(
    uid: string,
    limit?: number,
    startAfterId?: string,
  ): Promise<LoungeGalleryListResponseDto> {
    const safeLimit = normalizePaginationLimit(limit);
    void this.collections.loungeGallery;
    void uid;
    void safeLimit;
    void startAfterId;
    throw new LoungeNotImplementedError('LoungeGalleryRepository.listGalleryByUid');
  }

  /** Persists a Bot illustration asset displayed during chat into the user's Gallery idempotently. */
  public async unlockGalleryItem(
    uid: string,
    assetId: string,
    imageUrl: string,
    sessionId: string,
  ): Promise<LoungeGalleryItem> {
    void this.collections.loungeGallery;
    void uid;
    void assetId;
    void imageUrl;
    void sessionId;
    throw new LoungeNotImplementedError('LoungeGalleryRepository.unlockGalleryItem');
  }

  /** Permanently deletes all unlocked gallery items owned by `uid`. */
  public async deleteAllUserGalleryItems(uid: string): Promise<void> {
    void this.collections.loungeGallery;
    void uid;
    throw new LoungeNotImplementedError('LoungeGalleryRepository.deleteAllUserGalleryItems');
  }
}
