import type { Firestore } from '@google-cloud/firestore';
import {
  COLLECTIONS,
  assertLoungeRecordOwnedByUid,
  createUserScopedLoungeDb,
  type DbCollections,
} from '@rebecca/db';
import {
  toPublicLoungeSubscription,
  type LoungeCreditLotDoc,
  type LoungeSubscription,
  type LoungeSubscriptionDoc,
} from '@rebecca/types';
import { DEFAULT_LOUNGE_TIMEZONE } from '../../../config/loungeConfig';
import { deleteQueryInBatches } from '../../../utils/firestoreBatch';
import {
  LoungeQuotaEngine,
  type LoungeTurnReservationReceipt,
} from '../../billing/domain/loungeQuota.engine';

/**
 * Persistence boundary for isolated `lounge_subscriptions`, credit lots, and quota ledger documents.
 */
export interface ILoungeAccountRepository {
  getSubscriptionByUid(uid: string): Promise<LoungeSubscription | null>;
  getSubscriptionDocByUid?(uid: string): Promise<LoungeSubscriptionDoc | null>;
  listActiveCreditLotsByUid?(uid: string): Promise<LoungeCreditLotDoc[]>;
  reserveTurnForSession?(uid: string, referenceId: string): Promise<LoungeTurnReservationReceipt>;
  compensateTurnForSession?(receipt: LoungeTurnReservationReceipt): Promise<void>;
  incrementDailySearchCount?(uid: string): Promise<void>;
  decrementRemainingTurns(uid: string): Promise<LoungeSubscription>;
  deleteSubscription(uid: string): Promise<void>;
}

/**
 * Firestore repository managing `lounge_subscriptions`, FIFO `lounge_credit_lots`,
 * lazy midnight quota resets, and 180-day TTL `lounge_quota_ledger` records.
 */
export class LoungeAccountRepository implements ILoungeAccountRepository {
  private readonly quotaEngine: LoungeQuotaEngine;

  constructor(
    private readonly firestore: Firestore,
    private readonly collections: Pick<
      DbCollections,
      'loungeUsers' | 'loungeSubscriptions' | 'loungeCreditLots' | 'loungeQuotaLedger'
    >,
  ) {
    this.quotaEngine = new LoungeQuotaEngine(firestore, collections);
  }

  private async resolveUserTimezone(uid: string): Promise<string> {
    const userSnap = await this.collections.loungeUsers.doc(uid).get();
    return userSnap.data()?.timezone ?? DEFAULT_LOUNGE_TIMEZONE;
  }

  /** Retrieves public subscription + lazily synchronized daily/lot remaining turns for `uid`. */
  public async getSubscriptionByUid(uid: string): Promise<LoungeSubscription | null> {
    const doc = await this.getSubscriptionDocByUid(uid);
    return doc ? toPublicLoungeSubscription(doc) : null;
  }

  /** Retrieves full server `LoungeSubscriptionDoc` (after lazy reset/expiry) including Stripe IDs. */
  public async getSubscriptionDocByUid(uid: string): Promise<LoungeSubscriptionDoc | null> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_SUBSCRIPTIONS);
    const timezone = await this.resolveUserTimezone(uid);
    const synced = await this.quotaEngine.syncLazyState(uid, timezone);
    if (!synced) {
      return null;
    }
    return assertLoungeRecordOwnedByUid(
      synced.subscription,
      uid,
      COLLECTIONS.LOUNGE_SUBSCRIPTIONS,
    );
  }

  /** Lists non-expired `ACTIVE` credit lots ordered FIFO (`expiresAt ASC`) for `uid`. */
  public async listActiveCreditLotsByUid(uid: string): Promise<LoungeCreditLotDoc[]> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_CREDIT_LOTS);
    const timezone = await this.resolveUserTimezone(uid);
    const synced = await this.quotaEngine.syncLazyState(uid, timezone);
    return synced ? synced.activeLots : [];
  }

  /** Atomically reserves 1 chat turn (daily quota first, FIFO active lot second). */
  public async reserveTurnForSession(
    uid: string,
    referenceId: string,
  ): Promise<LoungeTurnReservationReceipt> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_SUBSCRIPTIONS);
    const timezone = await this.resolveUserTimezone(uid);
    return this.quotaEngine.reserveTurn(uid, timezone, referenceId);
  }

  /** Conditionally refunds a reserved turn after an upstream AI or storage failure. */
  public async compensateTurnForSession(receipt: LoungeTurnReservationReceipt): Promise<void> {
    assertLoungeRecordOwnedByUid({ uid: receipt.uid }, receipt.uid, COLLECTIONS.LOUNGE_SUBSCRIPTIONS);
    await this.quotaEngine.compensateTurn(receipt);
  }

  /** Atomically increments daily search_web grounding counter for cost-guard enforcement. */
  public async incrementDailySearchCount(uid: string): Promise<void> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_SUBSCRIPTIONS);
    const subRef = this.collections.loungeSubscriptions.doc(uid);
    await this.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(subRef);
      const existing = snap.data();
      if (!snap.exists || !existing) {
        return;
      }
      tx.set(subRef, {
        ...existing,
        todaysSearchCount: (existing.todaysSearchCount ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      });
    });
  }

  /** Atomically decrements remaining quota by 1 turn via the hybrid quota engine. */
  public async decrementRemainingTurns(uid: string): Promise<LoungeSubscription> {
    const receipt = await this.reserveTurnForSession(uid, `turn_${Date.now()}`);
    return receipt.subscription;
  }

  /**
   * Permanently deletes the caller's credit lots, quota ledger audit rows, and `lounge_subscriptions` doc.
   * Uses chunked `<= 450` batches to prevent exceeding Firestore batch commit limits.
   */
  public async deleteSubscription(uid: string): Promise<void> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_SUBSCRIPTIONS);
    const scoped = createUserScopedLoungeDb(
      this.collections as Parameters<typeof createUserScopedLoungeDb>[0],
      uid,
    );
    await deleteQueryInBatches(this.firestore, scoped.creditLotsQuery());
    await deleteQueryInBatches(this.firestore, scoped.quotaLedgerQuery());
    await scoped.subscriptionDoc().delete();
  }
}
