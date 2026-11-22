import type { LoungeRewardListResponseDto } from '@rebecca/types';
import { normalizePaginationLimit } from '../../../utils/errors';
import type { ILoungeRewardRepository } from '../repositories/loungeReward.repository';

/**
 * Use case contract for listing Private Lounge collectible illustration rewards.
 */
export interface ILoungeRewardUseCase {
  listRewards(
    uid: string,
    limit?: number,
    startAfterId?: string,
  ): Promise<LoungeRewardListResponseDto>;
}

/**
 * Orchestrates paginated retrieval of active persona illustration rewards for an authenticated user.
 */
export class LoungeRewardUseCase implements ILoungeRewardUseCase {
  constructor(private readonly rewardRepository: ILoungeRewardRepository) {}

  /** Retrieves paginated reward illustrations with strict `[1, 100]` limit clamping. */
  public async listRewards(
    uid: string,
    limit?: number,
    startAfterId?: string,
  ): Promise<LoungeRewardListResponseDto> {
    const safeLimit = normalizePaginationLimit(limit);
    return this.rewardRepository.listRewardsByUid(uid, safeLimit, startAfterId);
  }
}
