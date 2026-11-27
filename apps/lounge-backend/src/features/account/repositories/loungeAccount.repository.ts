import type { Firestore } from '@google-cloud/firestore';
import {
  COLLECTIONS,
  assertLoungeRecordOwnedByUid,
  createUserScopedLoungeAccountDb,
  type DbCollections,
} from '@rebecca/db';
import {
  toPublicLoungeSubscription,
  type LoungeCreditLotDoc,
  type LoungeSubscription,
  type LoungeSubscriptionDoc,
} from '@rebecca/types';
import { deleteQueryInBatches } from '../../../utils/firestoreBatch';
import { DEFAULT_LOUNGE_TIMEZONE } from '../../billing/domain/loungeCatalog.constants';
import {
  evaluateLazyQuotaState,
  type LoungeTurnReservationReceipt,
} from '../../billing/domain/loungeQuota.engine';
import {
  FirestoreLoungeQuotaRepository,
  type ILoungeQuotaRepository,
} from '../../billing/repositories/loungeQuota.repository';

/**
 * Persistence boundary for isolated `lounge_subscriptions`, credit lots, and quota ledger documents.
 */
export interface ILoungeAccountRepository {
  /** Retrieves public subscription DTO + lazily synced daily/lot turns for `uid`, or `null` if absent. */
  getSubscriptionByUid(uid: string): Promise<LoungeSubscription | null>;
  /** Retrieves full server subscription document + lazily synced daily/lot turns for `uid`, or `null` if absent. */
  getSubscriptionDocByUid(uid: string): Promise<LoungeSubscriptionDoc | null>;
  /** Lists non-expired `ACTIVE` credit lots ordered FIFO (`expiresAt ASC`) for `uid`. */
  listActiveCreditLotsByUid(uid: string): Promise<LoungeCreditLotDoc[]>;
  /**
   * Atomically reserves 1 chat turn (`DAILY` first, FIFO `ACTIVE` credit lot second).
   *
   * @throws LoungeNotFoundError When subscription record does not exist (`404`).
   * @throws LoungeQuotaExhaustedError When neither daily nor active lot balance remains (`429`).
   */
  reserveTurnForSession(uid: string, referenceId: string): Promise<LoungeTurnReservationReceipt>;
  /** Conditionally refunds a reserved turn after pre-commit AI or storage failures. */
  compensateTurnForSession(receipt: LoungeTurnReservationReceipt): Promise<void>;
  /** Atomically increments `todaysSearchCount` with lazy rollover reset and returns public subscription state. */
  incrementDailySearchCount(uid: string, now?: Date): Promise<LoungeSubscription | null>;
  /** Permanently deletes credit lots, quota ledger rows, and subscription document for `uid`. */
  deleteSubscription(uid: string): Promise<void>;
}

/**
 * Firestore repository managing `lounge_subscriptions`, FIFO `lounge_credit_lots`,
 * lazy midnight quota resets, and 180-day TTL `lounge_quota_ledger` records.
 */
export class LoungeAccountRepository implements ILoungeAccountRepository {
  private readonly quotaRepository: ILoungeQuotaRepository;

  constructor(
    private readonly firestore: Firestore,
    private readonly collections: Pick<
      DbCollections,
      'loungeUsers' | 'loungeSubscriptions' | 'loungeCreditLots' | 'loungeQuotaLedger'
    >,
  ) {
    this.quotaRepository = new FirestoreLoungeQuotaRepository(firestore, collections);
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
    const synced = await this.quotaRepository.syncLazyState(uid, timezone);
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
    const synced = await this.quotaRepository.syncLazyState(uid, timezone);
    return synced ? synced.activeLots : [];
  }

  /** Atomically reserves 1 chat turn (daily quota first, FIFO active lot second). */
  public async reserveTurnForSession(
    uid: string,
    referenceId: string,
  ): Promise<LoungeTurnReservationReceipt> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_SUBSCRIPTIONS);
    const timezone = await this.resolveUserTimezone(uid);
    return this.quotaRepository.reserveTurn(uid, timezone, referenceId);
  }

  /** Conditionally refunds a reserved turn after an upstream AI or storage failure. */
  public async compensateTurnForSession(receipt: LoungeTurnReservationReceipt): Promise<void> {
    assertLoungeRecordOwnedByUid({ uid: receipt.uid }, receipt.uid, COLLECTIONS.LOUNGE_SUBSCRIPTIONS);
    await this.quotaRepository.compensateTurn(receipt);
  }

  /** Atomically increments `todaysSearchCount` on `lounge_subscriptions` with lazy rollover reset. */
  public async incrementDailySearchCount(
    uid: string,
    now: Date = new Date(),
  ): Promise<LoungeSubscription | null> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_SUBSCRIPTIONS);
    const userRef = this.collections.loungeUsers.doc(uid);
    const subRef = this.collections.loungeSubscriptions.doc(uid);
    const lotsQuery = this.collections.loungeCreditLots
      .where('uid', '==', uid)
      .where('status', '==', 'ACTIVE');

    return this.firestore.runTransaction(async (tx) => {
      const [userSnap, subSnap, lotsSnap] = await Promise.all([
        tx.get(userRef),
        tx.get(subRef),
        tx.get(lotsQuery),
      ]);
      const existingSub = subSnap.data();
      if (!subSnap.exists || !existingSub) {
        return null;
      }
      const timezone = userSnap.data()?.timezone ?? DEFAULT_LOUNGE_TIMEZONE;
      const evaluated = evaluateLazyQuotaState(
        existingSub,
        lotsSnap.docs.map((d) => d.data()),
        timezone,
        now,
      );
      const nowIso = now.toISOString();
      const nextSub: LoungeSubscriptionDoc = {
        ...evaluated.subscription,
        todaysSearchCount: (evaluated.subscription.todaysSearchCount ?? 0) + 1,
        updatedAt: nowIso,
      };
      tx.set(subRef, nextSub);
      for (const expired of evaluated.expiredLots) {
        tx.set(this.collections.loungeCreditLots.doc(expired.id), expired);
      }
      for (const ledger of evaluated.ledgerEntries) {
        tx.set(this.collections.loungeQuotaLedger.doc(ledger.id), ledger);
      }
      return toPublicLoungeSubscription(nextSub);
    });
  }

  /**
   * Permanently deletes the caller's credit lots, quota ledger audit rows, and `lounge_subscriptions` doc.
   * Uses chunked `<= 450` batches to prevent exceeding Firestore batch commit limits.
   */
  public async deleteSubscription(uid: string): Promise<void> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_SUBSCRIPTIONS);
    const scoped = createUserScopedLoungeAccountDb(this.collections, uid);
    await deleteQueryInBatches(this.firestore, scoped.creditLotsQuery());
    await deleteQueryInBatches(this.firestore, scoped.quotaLedgerQuery());
    await scoped.subscriptionDoc().delete();
  }
}
