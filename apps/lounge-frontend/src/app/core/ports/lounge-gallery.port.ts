import type { LoungeGalleryListResponseDto } from '@rebecca/types';

/**
 * Hexagonal port abstracting the Private Lounge Bot illustration Gallery.
 */
export abstract class LoungeGalleryPort {
  /** Fetches paginated Bot illustrations unlocked during conversations for the current user. */
  public abstract listGallery(
    limit?: number,
    startAfterId?: string,
  ): Promise<LoungeGalleryListResponseDto>;
}
