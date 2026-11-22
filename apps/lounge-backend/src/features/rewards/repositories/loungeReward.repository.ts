import type { DbCollections } from '@rebecca/db';
import type { LoungeReward, LoungeRewardListResponseDto } from '@rebecca/types';
import { LoungeNotImplementedError, normalizePaginationLimit } from '../../../utils/errors';

/**
 * Persistence boundary for isolated `lounge_rewards` user illustration records.
 */
export interface ILoungeRewardRepository {
  listRewardsByUid(
    uid: string,
    limit?: number,
    startAfterId?: string,
  ): Promise<LoungeRewardListResponseDto>;
  unlockReward(uid: string, rewardCode: string, sessionId: string): Promise<LoungeReward>;
}

/**
 * Firestore repository skeleton reading and unlocking `collections.loungeRewards`.
 */
export class LoungeRewardRepository implements ILoungeRewardRepository {
  constructor(private readonly collections: Pick<DbCollections, 'loungeRewards'>) {}

  /** Lists paginated illustration rewards earned or locked for `uid`. */
  public async listRewardsByUid(
    uid: string,
    limit?: number,
    startAfterId?: string,
  ): Promise<LoungeRewardListResponseDto> {
    const safeLimit = normalizePaginationLimit(limit);
    void this.collections.loungeRewards;
    void uid;
    void safeLimit;
    void startAfterId;
    throw new LoungeNotImplementedError('LoungeRewardRepository.listRewardsByUid');
  }

  /** Marks a specific Private Lounge reward illustration as unlocked for `uid`. */
  public async unlockReward(
    uid: string,
    rewardCode: string,
    sessionId: string,
  ): Promise<LoungeReward> {
    void this.collections.loungeRewards;
    void uid;
    void rewardCode;
    void sessionId;
    throw new LoungeNotImplementedError('LoungeRewardRepository.unlockReward');
  }
}
