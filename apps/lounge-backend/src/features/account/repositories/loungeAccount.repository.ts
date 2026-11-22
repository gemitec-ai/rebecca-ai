import type { DbCollections } from '@rebecca/db';
import type { LoungeSubscription } from '@rebecca/types';
import { LoungeNotImplementedError } from '../../../utils/errors';

/**
 * Persistence boundary for isolated `lounge_subscriptions` tier and quota documents.
 */
export interface ILoungeAccountRepository {
  getSubscriptionByUid(uid: string): Promise<LoungeSubscription | null>;
  decrementRemainingTurns(uid: string): Promise<LoungeSubscription>;
}

/**
 * Firestore repository skeleton reading and updating `collections.loungeSubscriptions`.
 */
export class LoungeAccountRepository implements ILoungeAccountRepository {
  constructor(private readonly collections: Pick<DbCollections, 'loungeSubscriptions'>) {}

  /** Retrieves the active subscription tier and daily remaining turns for `uid`. */
  public async getSubscriptionByUid(uid: string): Promise<LoungeSubscription | null> {
    void this.collections.loungeSubscriptions;
    void uid;
    throw new LoungeNotImplementedError('LoungeAccountRepository.getSubscriptionByUid');
  }

  /** Atomically decrements `remainingChatTurns` by 1 after a successful reply turn. */
  public async decrementRemainingTurns(uid: string): Promise<LoungeSubscription> {
    void this.collections.loungeSubscriptions;
    void uid;
    throw new LoungeNotImplementedError('LoungeAccountRepository.decrementRemainingTurns');
  }
}
