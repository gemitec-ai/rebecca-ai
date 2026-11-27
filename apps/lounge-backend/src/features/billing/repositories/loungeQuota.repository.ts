import type { Firestore, Transaction } from '@google-cloud/firestore';
import type { DbCollections } from '@rebecca/db';
import type { LoungeCreditLotDoc, LoungeSubscriptionDoc } from '@rebecca/types';
import { LoungeNotFoundError, LoungeQuotaExhaustedError } from '../../../utils/errors';
import {
  computeDailyTurnCompensation,
  computeLotTurnCompensation,
  computeTurnReservation,
  evaluateLazyQuotaState,
  needsLazyQuotaSync,
  summarizeActiveCreditLots,
  type LoungeTurnReservationReceipt,
} from '../domain/loungeQuota.engine';

/**
 * Persistence boundary for transactional lazy quota evaluation, atomic turn consumption,
 * and AI-failure compensation across `lounge_subscriptions`, `lounge_credit_lots`, and `lounge_quota_ledger`.
 */
export interface ILoungeQuotaRepository {
  /** Synchronizes lazy daily reset and intraday credit lot expiration for `uid`. */
  syncLazyState(
    uid: string,
    userTimezone: string,
    now?: Date,
  ): Promise<{
    readonly subscription: LoungeSubscriptionDoc;
    readonly activeLots: LoungeCreditLotDoc[];
  } | null>;
  /**
   * Atomically reserves 1 chat turn (`DAILY` first, FIFO `ACTIVE` credit lot second).
   *
   * @throws LoungeNotFoundError When subscription record does not exist (`404`).
   * @throws LoungeQuotaExhaustedError When neither daily nor active lot balance remains (`429`).
   */
  reserveTurn(
    uid: string,
    userTimezone: string,
    referenceId: string,
    now?: Date,
  ): Promise<LoungeTurnReservationReceipt>;
  /** Conditionally refunds a previously reserved turn when AI generation or persistence fails. */
  compensateTurn(receipt: LoungeTurnReservationReceipt, now?: Date): Promise<void>;
}

/**
 * Firestore transactional implementation of `ILoungeQuotaRepository` delegating all quota
 * arithmetic and rollover rules to the pure `loungeQuota.engine` domain module.
 */
export class FirestoreLoungeQuotaRepository implements ILoungeQuotaRepository {
  constructor(
    private readonly firestore: Firestore,
    private readonly collections: Pick<
      DbCollections,
      'loungeSubscriptions' | 'loungeCreditLots' | 'loungeQuotaLedger'
    >,
  ) {}

  /** Synchronizes lazy daily reset and intraday lot expirations for `uid` in a Firestore transaction. */
  public async syncLazyState(
    uid: string,
    userTimezone: string,
    now: Date = new Date(),
  ): Promise<{
    readonly subscription: LoungeSubscriptionDoc;
    readonly activeLots: LoungeCreditLotDoc[];
  } | null> {
    return this.firestore.runTransaction(async (tx: Transaction) => {
      const subRef = this.collections.loungeSubscriptions.doc(uid);
      const lotsQuery = this.collections.loungeCreditLots
        .where('uid', '==', uid)
        .where('status', '==', 'ACTIVE');

      const [subSnap, lotsSnap] = await Promise.all([tx.get(subRef), tx.get(lotsQuery)]);
      const currentSub = subSnap.data();
      if (!subSnap.exists || !currentSub) {
        return null;
      }

      const lots = lotsSnap.docs.map((d) => d.data());
      if (!needsLazyQuotaSync(currentSub, now)) {
        const summary = summarizeActiveCreditLots(lots, now.getTime());
        return { subscription: currentSub, activeLots: summary.activeLots };
      }

      const evaluation = evaluateLazyQuotaState(currentSub, lots, userTimezone, now);
      if (evaluation.mutated) {
        tx.set(subRef, evaluation.subscription);
        for (const expired of evaluation.expiredLots) {
          tx.set(this.collections.loungeCreditLots.doc(expired.id), expired);
        }
        for (const ledger of evaluation.ledgerEntries) {
          tx.set(this.collections.loungeQuotaLedger.doc(ledger.id), ledger);
        }
      }
      return { subscription: evaluation.subscription, activeLots: evaluation.activeLots };
    });
  }

  /** Atomically reserves 1 chat turn (`DAILY` first, then FIFO `ACTIVE` credit lot) inside a transaction. */
  public async reserveTurn(
    uid: string,
    userTimezone: string,
    referenceId: string,
    now: Date = new Date(),
  ): Promise<LoungeTurnReservationReceipt> {
    return this.firestore.runTransaction(async (tx: Transaction) => {
      const subRef = this.collections.loungeSubscriptions.doc(uid);
      const lotsQuery = this.collections.loungeCreditLots
        .where('uid', '==', uid)
        .where('status', '==', 'ACTIVE');

      const [subSnap, lotsSnap] = await Promise.all([tx.get(subRef), tx.get(lotsQuery)]);
      const currentSub = subSnap.data();
      if (!subSnap.exists || !currentSub) {
        throw new LoungeNotFoundError(`Lounge subscription for user "${uid}" was not found`);
      }

      const computation = computeTurnReservation({
        uid,
        sub: currentSub,
        activeLots: lotsSnap.docs.map((d) => d.data()),
        userTimezone,
        referenceId,
        now,
      });

      for (const expired of computation.expiredLots) {
        tx.set(this.collections.loungeCreditLots.doc(expired.id), expired);
      }
      for (const ledger of computation.ledgerEntries) {
        tx.set(this.collections.loungeQuotaLedger.doc(ledger.id), ledger);
      }

      if (computation.kind === 'RESERVED') {
        if (computation.updatedLot) {
          tx.set(
            this.collections.loungeCreditLots.doc(computation.updatedLot.id),
            computation.updatedLot,
          );
        }
        tx.set(subRef, computation.subscription);
        return computation.receipt;
      }

      if (computation.mutated) {
        tx.set(subRef, computation.subscription);
      }
      throw new LoungeQuotaExhaustedError('Daily and purchased chat turn quota exhausted', {
        code: 'QUOTA_EXHAUSTED',
        meta: {
          nextDailyResetAt: computation.subscription.nextDailyResetAt,
        },
      });
    });
  }

  /** Conditionally refunds a previously reserved turn when AI generation or message persistence fails. */
  public async compensateTurn(
    receipt: LoungeTurnReservationReceipt,
    now: Date = new Date(),
  ): Promise<void> {
    await this.firestore.runTransaction(async (tx: Transaction) => {
      const subRef = this.collections.loungeSubscriptions.doc(receipt.uid);
      const subSnap = await tx.get(subRef);
      const currentSub = subSnap.data();
      if (!subSnap.exists || !currentSub) {
        return;
      }

      if (receipt.source === 'DAILY') {
        const result = computeDailyTurnCompensation({ sub: currentSub, receipt, now });
        if (!result) {
          return;
        }
        tx.set(subRef, result.subscription);
        tx.set(this.collections.loungeQuotaLedger.doc(result.ledgerEntry.id), result.ledgerEntry);
        return;
      }

      if (!receipt.lotId) {
        return;
      }
      const lotRef = this.collections.loungeCreditLots.doc(receipt.lotId);
      const activeQuery = this.collections.loungeCreditLots
        .where('uid', '==', receipt.uid)
        .where('status', '==', 'ACTIVE');
      const [lotSnap, activeSnap] = await Promise.all([tx.get(lotRef), tx.get(activeQuery)]);
      const currentLot = lotSnap.data();
      if (!lotSnap.exists || !currentLot) {
        return;
      }

      const result = computeLotTurnCompensation({
        sub: currentSub,
        targetLot: currentLot,
        activeLots: activeSnap.docs.map((d) => d.data()),
        receipt,
        now,
      });
      if (!result) {
        return;
      }

      tx.set(lotRef, result.updatedLot);
      tx.set(subRef, result.subscription);
      tx.set(this.collections.loungeQuotaLedger.doc(result.ledgerEntry.id), result.ledgerEntry);
    });
  }
}
