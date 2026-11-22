import type { LoungeRewardListResponseDto } from '@rebecca/types';

/**
 * Hexagonal port abstracting collectible Private Lounge illustration rewards.
 */
export abstract class LoungeRewardPort {
  /** Fetches paginated illustration reward cards shared or locked for the current user. */
  public abstract listRewards(
    limit?: number,
    startAfterId?: string,
  ): Promise<LoungeRewardListResponseDto>;
}
