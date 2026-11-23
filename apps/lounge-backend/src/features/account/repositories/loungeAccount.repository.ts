import { COLLECTIONS, assertLoungeRecordOwnedByUid, type DbCollections } from '@rebecca/db';
import type { LoungeSubscription } from '@rebecca/types';
import { LoungeNotImplementedError } from '../../../utils/errors';

/**
 * Persistence boundary for isolated `lounge_subscriptions` tier and quota documents.
 */
export interface ILoungeAccountRepository {
  getSubscriptionByUid(uid: string): Promise<LoungeSubscription | null>;
  decrementRemainingTurns(uid: string): Promise<LoungeSubscription>;
  deleteSubscription(uid: string): Promise<void>;
}

/**
 * Firestore repository skeleton reading and updating `collections.loungeSubscriptions`
 * with strict per-user tenant ownership guards.
 */
export class LoungeAccountRepository implements ILoungeAccountRepository {
  constructor(private readonly collections: Pick<DbCollections, 'loungeSubscriptions'>) {}

  /** Retrieves the active subscription tier and daily remaining turns for `uid`. */
  public async getSubscriptionByUid(uid: string): Promise<LoungeSubscription | null> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_SUBSCRIPTIONS);
    void this.collections.loungeSubscriptions;
    throw new LoungeNotImplementedError('LoungeAccountRepository.getSubscriptionByUid');
  }

  /** Atomically decrements `remainingChatTurns` by 1 after a successful reply turn. */
  public async decrementRemainingTurns(uid: string): Promise<LoungeSubscription> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_SUBSCRIPTIONS);
    void this.collections.loungeSubscriptions;
    throw new LoungeNotImplementedError('LoungeAccountRepository.decrementRemainingTurns');
  }

  /** Permanently deletes the isolated `lounge_subscriptions` document for `uid`. */
  public async deleteSubscription(uid: string): Promise<void> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_SUBSCRIPTIONS);
    void this.collections.loungeSubscriptions;
    throw new LoungeNotImplementedError('LoungeAccountRepository.deleteSubscription');
  }
}
