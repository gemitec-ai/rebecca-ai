import type { LoungeGalleryListResponseDto, LoungePaginationQueryDto } from '@rebecca/types';
import { requireActiveLoungeUser } from '../../../domain/loungeAccessPolicy';
import { normalizePaginationQuery } from '../../../utils/errors';
import type { ILoungeAuthRepository } from '../../auth/repositories/loungeAuth.repository';
import {
  DEFAULT_LOUNGE_GALLERY_LIMIT,
  type ILoungeGalleryRepository,
} from '../repositories/loungeGallery.repository';

/**
 * Use case contract for retrieving unlocked Private Lounge Bot illustration gallery items.
 */
export interface ILoungeGalleryUseCase {
  /**
   * Lists paginated gallery items belonging to `uid`.
   *
   * @throws LoungeAuthError When user profile is missing (`401`) or suspended (`403`).
   * @throws LoungeValidationError When pagination bounds or cursor are invalid (`400`).
   */
  listGallery(
    uid: string,
    query?: LoungePaginationQueryDto,
  ): Promise<LoungeGalleryListResponseDto>;
}

/**
 * Orchestrates paginated retrieval of active persona Bot illustrations saved to a user's Gallery.
 */
export class LoungeGalleryUseCase implements ILoungeGalleryUseCase {
  constructor(
    private readonly galleryRepository: ILoungeGalleryRepository,
    private readonly authRepository: ILoungeAuthRepository,
  ) {}

  /**
   * Retrieves paginated gallery items using unified `page`, `[1, 100]` `limit` (default `12`),
   * and optional Firestore document `cursor` validation after verifying active account status.
   *
   * @throws LoungeAuthError When user profile is missing (`401`) or suspended (`403`).
   * @throws LoungeValidationError When cursor validation fails (`400`).
   */
  public async listGallery(
    uid: string,
    query?: LoungePaginationQueryDto,
  ): Promise<LoungeGalleryListResponseDto> {
    await requireActiveLoungeUser(this.authRepository, uid);
    const safeQuery = normalizePaginationQuery(query, DEFAULT_LOUNGE_GALLERY_LIMIT);
    return this.galleryRepository.listGalleryByUid(uid, safeQuery);
  }
}
