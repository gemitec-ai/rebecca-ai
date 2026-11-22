import type { LoungeAccountSummaryDto, LoungePersonaBranding } from '@rebecca/types';
import { LoungeAuthError, LoungeNotFoundError } from '../../../utils/errors';
import type { ILoungeAuthRepository } from '../../auth/repositories/loungeAuth.repository';
import type { ILoungeRewardRepository } from '../../rewards/repositories/loungeReward.repository';
import type { ILoungeAccountRepository } from '../repositories/loungeAccount.repository';

/**
 * Use case contract for assembling authenticated account, quota, and sync summary state.
 */
export interface ILoungeAccountUseCase {
  getAccountSummary(uid: string): Promise<LoungeAccountSummaryDto>;
}

/**
 * Aggregates profile, subscription tier, remaining chat turns, and reward unlock progress.
 */
export class LoungeAccountUseCase implements ILoungeAccountUseCase {
  constructor(
    private readonly authRepository: ILoungeAuthRepository,
    private readonly accountRepository: ILoungeAccountRepository,
    private readonly rewardRepository: ILoungeRewardRepository,
    private readonly appVersion: string,
    private readonly personaBranding?: LoungePersonaBranding,
  ) {}

  /**
   * Builds the authenticated user's Sidebar/Account summary payload.
   *
   * @throws LoungeAuthError When the user profile does not exist or is suspended.
   * @throws LoungeNotFoundError When the subscription record is missing.
   */
  public async getAccountSummary(uid: string): Promise<LoungeAccountSummaryDto> {
    const user = await this.authRepository.findUserByUid(uid);
    if (!user) {
      throw new LoungeAuthError(401, 'Private Lounge user profile not found');
    }
    if (user.status !== 'ACTIVE') {
      throw new LoungeAuthError(403, 'Private Lounge account is suspended');
    }

    const subscription = await this.accountRepository.getSubscriptionByUid(uid);
    if (!subscription) {
      throw new LoungeNotFoundError('Lounge subscription record not found');
    }

    const rewardsPage = await this.rewardRepository.listRewardsByUid(uid, 100);
    return {
      user,
      subscription,
      ...(this.personaBranding ? { persona: this.personaBranding } : {}),
      publicXMemoryOneWayActive: true,
      unlockedRewardCount: rewardsPage.unlockedCount,
      totalRewardCount: rewardsPage.totalCount,
      appVersion: this.appVersion,
    };
  }
}
