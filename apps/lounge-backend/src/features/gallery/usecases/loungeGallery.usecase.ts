import type { LoungeGalleryListResponseDto, LoungePaginationQueryDto } from '@rebecca/types';
import { LoungeAuthError, normalizePaginationQuery } from '../../../utils/errors';
import type { ILoungeAuthRepository } from '../../auth/repositories/loungeAuth.repository';
import type { ILoungeGalleryRepository } from '../repositories/loungeGallery.repository';

/**
 * Use case contract for retrieving unlocked Private Lounge Bot illustration gallery items.
 */
export interface ILoungeGalleryUseCase {
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
   * Retrieves paginated gallery items using unified `page`, `[1, 100]` `limit`, and optional `cursor` validation
   * after verifying active account status.
   *
   * @throws LoungeAuthError When user profile is missing (`401`) or suspended (`403`).
   */
  public async listGallery(
    uid: string,
    query?: LoungePaginationQueryDto,
  ): Promise<LoungeGalleryListResponseDto> {
    const user = await this.authRepository.findUserByUid(uid);
    if (!user) {
      throw new LoungeAuthError(401, 'Private Lounge user profile not found');
    }
    if (user.status !== 'ACTIVE') {
      throw new LoungeAuthError(403, 'Private Lounge account is suspended');
    }
    const safeQuery = normalizePaginationQuery(query);
    return this.galleryRepository.listGalleryByUid(uid, safeQuery);
  }
}
