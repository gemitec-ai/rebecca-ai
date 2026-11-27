import type { Firestore, Transaction } from '@google-cloud/firestore';
import { COLLECTIONS, assertLoungeRecordOwnedByUid, type DbCollections } from '@rebecca/db';
import type {
  LoungeCreditLotDoc,
  LoungeCurrency,
  LoungeProcessedEventDoc,
  LoungeProductId,
  LoungeQuotaLedgerDoc,
  LoungeSubscriptionDoc,
  LoungeSubscriptionStatus,
  LoungeSubscriptionTier,
  LoungeTrialGrantDoc,
  LoungeUserDoc,
} from '@rebecca/types';
import { LoungeAuthError, LoungeConflictError, LoungeNotFoundError } from '../../../utils/errors';
import {
  computeActiveTrialGrantHash,
  computeAllTrialGrantHashes,
  type TrialHmacKeyring,
} from '../../../utils/trialGrantHmac';
import {
  DAY_MS,
  EU_WITHDRAWAL_WINDOW_DAYS,
  buildProcessedEventDoc,
  filterActiveTrialGrants,
  resolveTargetStatusFromStripeSnapshot,
} from '../domain/loungeBilling.helpers';
import {
  LOUNGE_CREDIT_LOT_VALIDITY_DAYS,
  LOUNGE_PRODUCT_CATALOG_SPECS,
  computeTrialGrantRetainUntilIso,
} from '../domain/loungeCatalog.constants';
import {
  applySubscriptionTransition,
  createQuotaLedgerEntry,
  evaluateLazyQuotaState,
  summarizeActiveCreditLots,
} from '../domain/loungeQuota.engine';
import type {
  LoungeStripeCheckoutSession,
  LoungeStripeSubscriptionSnapshot,
} from '../ports/loungeStripe.port';

/** Transaction result returned when atomically fulfilling a completed Checkout Session. */
export type FulfillCheckoutTxOutcome =
  | { readonly kind: 'APPLIED'; readonly sub: LoungeSubscriptionDoc }
  | { readonly kind: 'UNPAID'; readonly sub: LoungeSubscriptionDoc }
  | { readonly kind: 'NOOP_ALREADY_PROCESSED'; readonly sub: LoungeSubscriptionDoc | null }
  | { readonly kind: 'NOOP_WITHDRAWN'; readonly sub: LoungeSubscriptionDoc | null }
  | { readonly kind: 'TRIAL_RACE_CONFLICT'; readonly sub: LoungeSubscriptionDoc };

/** Transaction outcome returned after pre-revoking a credit lot prior to external Stripe refund. */
export interface PreRevokedCreditLotTxResult {
  readonly previousLot: LoungeCreditLotDoc;
  readonly previousSub: LoungeSubscriptionDoc;
  readonly updatedSub: LoungeSubscriptionDoc;
  readonly paymentIntentId: string;
  readonly refundMinor: number;
  readonly revokedTurns: number;
}

/** Transaction outcome returned after pre-canceling a subscription prior to external Stripe refund. */
export interface PreCanceledSubscriptionTxResult {
  readonly previousSub: LoungeSubscriptionDoc;
  readonly updatedSub: LoungeSubscriptionDoc;
}

/** Outcome returned by webhook subscription lifecycle transactions. */
export type SubscriptionLifecycleTxOutcome =
  | 'ALREADY_PROCESSED'
  | 'SKIPPED_MISSING'
  | 'SKIPPED_STALE_SUB'
  | 'APPLIED';

/**
 * Persistence boundary encapsulating all Firestore reads, queries, and atomic transactions
 * for Private Lounge billing, Stripe idempotency, credit lots, trial grants, and EU withdrawals.
 */
export interface ILoungeBillingRepository {
  /** Reads `lounge_users/{uid}` and `lounge_subscriptions/{uid}` in parallel. */
  getUserAndSubscription(uid: string): Promise<{
    readonly user: LoungeUserDoc | null;
    readonly subscription: LoungeSubscriptionDoc | null;
  }>;
  /** Reads `lounge_subscriptions/{uid}` or returns `null`. */
  getSubscriptionByUid(uid: string): Promise<LoungeSubscriptionDoc | null>;
  /** Reads non-expired `lounge_trial_grants` across key-rotated HMAC digests. */
  findActiveTrialGrants(hashes: readonly string[], nowMs: number): Promise<LoungeTrialGrantDoc[]>;
  /** Resolves UID from `lounge_subscriptions` via `stripeCustomerId` or fallback `stripeSubscriptionId`. */
  findUidByStripeCustomerOrSubscription(
    customerId?: string,
    subscriptionId?: string,
  ): Promise<string | null>;
  /** Reads ownership-verified credit lots indexed by Stripe PaymentIntent IDs (`<= 30`). */
  findCreditLotsByPaymentIntents(
    uid: string,
    paymentIntentIds: readonly string[],
  ): Promise<Map<string, LoungeCreditLotDoc>>;
  /** Looks up the first credit lot matching `paymentIntentId`. */
  findCreditLotByPaymentIntent(paymentIntentId: string): Promise<LoungeCreditLotDoc | null>;
  /** Lists up to `limit` quota ledger records belonging to `uid`. */
  listRecentQuotaLedger(uid: string, limit: number): Promise<LoungeQuotaLedgerDoc[]>;
  /** Returns whether Stripe webhook `eventId` was already persisted in `lounge_processed_events`. */
  hasProcessedEvent(eventId: string): Promise<boolean>;
  /** Persists a processed Stripe webhook marker in `lounge_processed_events`. */
  recordProcessedEvent(doc: LoungeProcessedEventDoc): Promise<void>;
  /** Atomically binds `stripeCustomerId` and locked currency/residency if unset on subscription or user. */
  saveCustomerAndCurrencyIfMissing(params: {
    readonly uid: string;
    readonly customerId: string;
    readonly currency: LoungeCurrency;
    readonly countryCode: string;
    readonly isEeaResident: boolean;
    readonly nowIso: string;
  }): Promise<void>;
  /** Atomically applies lazy quota rollover and expired lot cleanup, returning updated subscription and active lots. */
  syncLazySubscriptionState(
    uid: string,
    userTimezone: string,
  ): Promise<{
    readonly subscription: LoungeSubscriptionDoc;
    readonly activeLots: LoungeCreditLotDoc[];
  }>;
  /** Applies a Stripe Subscription snapshot returned during `?portal_return=1` hydration. */
  applyStripeSubscriptionSnapshot(params: {
    readonly uid: string;
    readonly snapshot: LoungeStripeSubscriptionSnapshot;
    readonly userTimezone: string;
    readonly now: Date;
  }): Promise<void>;
  /** Atomically fulfills a Checkout Session (subscription or one-time credit lot) with idempotency & trial race detection. */
  fulfillCheckoutSessionTx(params: {
    readonly uid: string;
    readonly productId: Exclude<LoungeProductId, 'WELCOME_BONUS_20'>;
    readonly session: LoungeStripeCheckoutSession;
    readonly stripeSubSnapshot: LoungeStripeSubscriptionSnapshot | null;
    readonly trialHmacKeyring: TrialHmacKeyring;
    readonly webhookEvent?: { readonly id: string; readonly type: string };
    readonly now: Date;
  }): Promise<FulfillCheckoutTxOutcome>;
  /** Pre-revokes an unconsumed paid credit lot inside a 14-day EU withdrawal transaction prior to Stripe refund. */
  preRevokeCreditLotForEuWithdrawalTx(params: {
    readonly uid: string;
    readonly lotId: string;
    readonly now: Date;
  }): Promise<PreRevokedCreditLotTxResult>;
  /** Restores a pre-revoked credit lot and subscription snapshot if external Stripe refund fails. */
  rollbackCreditLotRevocationTx(
    uid: string,
    previousLot: LoungeCreditLotDoc,
    previousSub: LoungeSubscriptionDoc,
  ): Promise<void>;
  /** Pre-cancels an active STANDARD subscription inside an EU withdrawal transaction prior to Stripe cancellation. */
  preCancelSubscriptionForEuWithdrawalTx(params: {
    readonly uid: string;
    readonly expectedSubId: string;
    readonly userTimezone: string;
    readonly now: Date;
  }): Promise<PreCanceledSubscriptionTxResult>;
  /** Restores subscription snapshot if external Stripe cancellation fails during EU withdrawal. */
  rollbackSubscriptionCancellationTx(uid: string, previousSub: LoungeSubscriptionDoc): Promise<void>;
  /** Idempotently processes `invoice.paid` webhook transition in a transaction. */
  applyInvoicePaidWebhookTx(params: {
    readonly uid: string;
    readonly eventId: string;
    readonly eventType: string;
    readonly invoiceId: string;
    readonly stripeSub: LoungeStripeSubscriptionSnapshot;
    readonly now: Date;
  }): Promise<boolean>;
  /** Idempotently processes subscription lifecycle webhooks (`updated` / `deleted` / `payment_failed`). */
  applySubscriptionLifecycleWebhookTx(params: {
    readonly uid: string;
    readonly eventId: string;
    readonly eventType: string;
    readonly stripeSub: LoungeStripeSubscriptionSnapshot;
    readonly targetStatus: LoungeSubscriptionStatus;
    readonly now: Date;
  }): Promise<SubscriptionLifecycleTxOutcome>;
  /** Idempotently revokes credit lots and optionally applies `SUSPENDED` + `DISPUTE_BLOCKED` on chargebacks. */
  applyRefundOrDisputeClawbackTx(params: {
    readonly eventId: string;
    readonly eventType: string;
    readonly uid: string;
    readonly lotId: string | undefined;
    readonly referenceId: string;
    readonly isDispute: boolean;
    readonly trialHmacKeyring: TrialHmacKeyring;
    readonly now: Date;
  }): Promise<void>;
  /** Idempotently downgrades subscription to `FREE / CANCELED` on matching invoice refund. */
  applySubscriptionRefundDowngradeTx(params: {
    readonly eventId: string;
    readonly eventType: string;
    readonly uid: string;
    readonly invoiceId: string;
    readonly now: Date;
  }): Promise<void>;
}

/**
 * Firestore implementation backing `ILoungeBillingRepository`.
 */
export class FirestoreLoungeBillingRepository implements ILoungeBillingRepository {
  constructor(
    private readonly firestore: Firestore,
    private readonly collections: Pick<
      DbCollections,
      | 'loungeUsers'
      | 'loungeSubscriptions'
      | 'loungeCreditLots'
      | 'loungeQuotaLedger'
      | 'loungeProcessedEvents'
      | 'loungeTrialGrants'
    >,
  ) {}

  private commitSubscriptionTransition(
    tx: Transaction,
    uid: string,
    transitioned: {
      readonly subscription: LoungeSubscriptionDoc;
      readonly expiredLots: ReadonlyArray<LoungeCreditLotDoc>;
      readonly ledgerEntries: ReadonlyArray<LoungeQuotaLedgerDoc>;
    },
  ): void {
    tx.set(this.collections.loungeSubscriptions.doc(uid), transitioned.subscription);
    for (const exp of transitioned.expiredLots) {
      tx.set(this.collections.loungeCreditLots.doc(exp.id), exp);
    }
    for (const entry of transitioned.ledgerEntries) {
      tx.set(this.collections.loungeQuotaLedger.doc(entry.id), entry);
    }
  }

  public async getUserAndSubscription(uid: string): Promise<{
    readonly user: LoungeUserDoc | null;
    readonly subscription: LoungeSubscriptionDoc | null;
  }> {
    const [userSnap, subSnap] = await Promise.all([
      this.collections.loungeUsers.doc(uid).get(),
      this.collections.loungeSubscriptions.doc(uid).get(),
    ]);
    return {
      user: userSnap.exists ? (userSnap.data() ?? null) : null,
      subscription: subSnap.exists ? (subSnap.data() ?? null) : null,
    };
  }

  public async getSubscriptionByUid(uid: string): Promise<LoungeSubscriptionDoc | null> {
    const subSnap = await this.collections.loungeSubscriptions.doc(uid).get();
    return subSnap.exists ? (subSnap.data() ?? null) : null;
  }

  public async findActiveTrialGrants(
    hashes: readonly string[],
    nowMs: number,
  ): Promise<LoungeTrialGrantDoc[]> {
    const snaps = await Promise.all(
      hashes.map((hash) => this.collections.loungeTrialGrants.doc(hash).get()),
    );
    return filterActiveTrialGrants(
      snaps.filter((s) => s.exists).map((s) => s.data()),
      nowMs,
    );
  }

  public async findUidByStripeCustomerOrSubscription(
    customerId?: string,
    subscriptionId?: string,
  ): Promise<string | null> {
    if (customerId) {
      const snap = await this.collections.loungeSubscriptions
        .where('stripeCustomerId', '==', customerId)
        .limit(1)
        .get();
      if (!snap.empty) {
        return snap.docs[0].id;
      }
    }
    if (subscriptionId) {
      const snap = await this.collections.loungeSubscriptions
        .where('stripeSubscriptionId', '==', subscriptionId)
        .limit(1)
        .get();
      if (!snap.empty) {
        return snap.docs[0].id;
      }
    }
    return null;
  }

  public async findCreditLotsByPaymentIntents(
    uid: string,
    paymentIntentIds: readonly string[],
  ): Promise<Map<string, LoungeCreditLotDoc>> {
    const lotByPi = new Map<string, LoungeCreditLotDoc>();
    if (paymentIntentIds.length === 0) {
      return lotByPi;
    }
    const lotsSnap = await this.collections.loungeCreditLots
      .where('uid', '==', uid)
      .where('stripePaymentIntentId', 'in', paymentIntentIds.slice(0, 30))
      .get();
    for (const doc of lotsSnap.docs) {
      const lot = assertLoungeRecordOwnedByUid(
        doc.data(),
        uid,
        COLLECTIONS.LOUNGE_CREDIT_LOTS,
      );
      if (lot.stripePaymentIntentId) {
        lotByPi.set(lot.stripePaymentIntentId, lot);
      }
    }
    return lotByPi;
  }

  public async findCreditLotByPaymentIntent(
    paymentIntentId: string,
  ): Promise<LoungeCreditLotDoc | null> {
    const lotSnap = await this.collections.loungeCreditLots
      .where('stripePaymentIntentId', '==', paymentIntentId)
      .limit(1)
      .get();
    return lotSnap.empty ? null : lotSnap.docs[0].data();
  }

  public async listRecentQuotaLedger(
    uid: string,
    limit: number,
  ): Promise<LoungeQuotaLedgerDoc[]> {
    const ledgerSnap = await this.collections.loungeQuotaLedger
      .where('uid', '==', uid)
      .limit(limit)
      .get();
    return ledgerSnap.docs.map((d) => d.data());
  }

  public async hasProcessedEvent(eventId: string): Promise<boolean> {
    const existingEventSnap = await this.collections.loungeProcessedEvents.doc(eventId).get();
    return existingEventSnap.exists;
  }

  public async recordProcessedEvent(doc: LoungeProcessedEventDoc): Promise<void> {
    await this.collections.loungeProcessedEvents.doc(doc.eventId).set(doc);
  }

  public async saveCustomerAndCurrencyIfMissing(params: {
    readonly uid: string;
    readonly customerId: string;
    readonly currency: LoungeCurrency;
    readonly countryCode: string;
    readonly isEeaResident: boolean;
    readonly nowIso: string;
  }): Promise<void> {
    await this.firestore.runTransaction(async (tx: Transaction) => {
      const [latestSubSnap, latestUserSnap] = await Promise.all([
        tx.get(this.collections.loungeSubscriptions.doc(params.uid)),
        tx.get(this.collections.loungeUsers.doc(params.uid)),
      ]);
      const latestSub = latestSubSnap.data();
      if (latestSubSnap.exists && latestSub) {
        tx.set(this.collections.loungeSubscriptions.doc(params.uid), {
          ...latestSub,
          stripeCustomerId: params.customerId,
          billingCurrency: latestSub.billingCurrency ?? params.currency,
          updatedAt: params.nowIso,
        });
      }
      const latestUser = latestUserSnap.data();
      if (latestUserSnap.exists && latestUser && !latestUser.preferredCurrency) {
        tx.set(this.collections.loungeUsers.doc(params.uid), {
          ...latestUser,
          countryCode: params.countryCode,
          isEeaResident: params.isEeaResident,
          preferredCurrency: params.currency,
          updatedAt: params.nowIso,
        });
      }
    });
  }

  public async syncLazySubscriptionState(
    uid: string,
    userTimezone: string,
  ): Promise<{
    readonly subscription: LoungeSubscriptionDoc;
    readonly activeLots: LoungeCreditLotDoc[];
  }> {
    return this.firestore.runTransaction(async (tx: Transaction) => {
      const subRef = this.collections.loungeSubscriptions.doc(uid);
      const lotsSnap = await tx.get(
        this.collections.loungeCreditLots.where('uid', '==', uid).where('status', '==', 'ACTIVE'),
      );
      const subSnap = await tx.get(subRef);
      const currentSub = subSnap.data();
      if (!subSnap.exists || !currentSub) {
        throw new LoungeNotFoundError(`Lounge subscription for "${uid}" missing`);
      }
      const evaluation = evaluateLazyQuotaState(
        currentSub,
        lotsSnap.docs.map((d) => d.data()),
        userTimezone,
      );
      if (evaluation.mutated) {
        this.commitSubscriptionTransition(tx, uid, evaluation);
      }
      return { subscription: evaluation.subscription, activeLots: evaluation.activeLots };
    });
  }

  public async applyStripeSubscriptionSnapshot(params: {
    readonly uid: string;
    readonly snapshot: LoungeStripeSubscriptionSnapshot;
    readonly userTimezone: string;
    readonly now: Date;
  }): Promise<void> {
    const targetStatus = resolveTargetStatusFromStripeSnapshot(params.snapshot);
    const targetTier: LoungeSubscriptionTier =
      targetStatus === 'ACTIVE' || targetStatus === 'CANCELING' ? 'STANDARD' : 'FREE';

    await this.firestore.runTransaction(async (tx: Transaction) => {
      const subRef = this.collections.loungeSubscriptions.doc(params.uid);
      const [subSnap, lotsSnap] = await Promise.all([
        tx.get(subRef),
        tx.get(
          this.collections.loungeCreditLots
            .where('uid', '==', params.uid)
            .where('status', '==', 'ACTIVE'),
        ),
      ]);
      const currentSub = subSnap.data();
      if (!subSnap.exists || !currentSub) {
        return;
      }
      const transitioned = applySubscriptionTransition(
        currentSub,
        lotsSnap.docs.map((d) => d.data()),
        params.userTimezone,
        targetTier,
        targetStatus,
        params.now,
        {
          currentPeriodEnd: params.snapshot.currentPeriodEndIso,
          cancelAtPeriodEnd: params.snapshot.cancelAtPeriodEnd,
          ...(params.snapshot.scheduleId ? { stripeScheduleId: params.snapshot.scheduleId } : {}),
        },
      );
      this.commitSubscriptionTransition(tx, params.uid, transitioned);
    });
  }

  public async fulfillCheckoutSessionTx(params: {
    readonly uid: string;
    readonly productId: Exclude<LoungeProductId, 'WELCOME_BONUS_20'>;
    readonly session: LoungeStripeCheckoutSession;
    readonly stripeSubSnapshot: LoungeStripeSubscriptionSnapshot | null;
    readonly trialHmacKeyring: TrialHmacKeyring;
    readonly webhookEvent?: { readonly id: string; readonly type: string };
    readonly now: Date;
  }): Promise<FulfillCheckoutTxOutcome> {
    const { uid, productId, session, stripeSubSnapshot, trialHmacKeyring, webhookEvent, now } =
      params;
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    return this.firestore.runTransaction(async (tx: Transaction) => {
      const userRef = this.collections.loungeUsers.doc(uid);
      const subRef = this.collections.loungeSubscriptions.doc(uid);
      const eventRef = webhookEvent
        ? this.collections.loungeProcessedEvents.doc(webhookEvent.id)
        : null;

      const [userSnap, subSnap, eventSnap] = await Promise.all([
        tx.get(userRef),
        tx.get(subRef),
        eventRef ? tx.get(eventRef) : Promise.resolve(null),
      ]);

      const user = userSnap.data();
      const sub = subSnap.data();

      if (eventSnap?.exists) {
        return { kind: 'NOOP_ALREADY_PROCESSED', sub: sub ?? null };
      }
      if (!userSnap.exists || !user || user.status === 'DELETING' || !subSnap.exists || !sub) {
        if (eventRef && webhookEvent) {
          tx.set(eventRef, buildProcessedEventDoc(webhookEvent.id, webhookEvent.type, uid, session.id, now));
        }
        return { kind: 'NOOP_WITHDRAWN', sub: sub ?? null };
      }
      if (sub.stripeCustomerId && sub.stripeCustomerId !== session.customerId) {
        throw new LoungeAuthError(403, 'Checkout session customer does not match account customer');
      }

      const timezone = user.timezone;
      const currency: LoungeCurrency = session.currency;

      if (productId === 'STANDARD_MONTHLY') {
        if (
          !stripeSubSnapshot ||
          (stripeSubSnapshot.status !== 'active' && stripeSubSnapshot.status !== 'trialing')
        ) {
          if (eventRef && webhookEvent) {
            tx.set(
              eventRef,
              buildProcessedEventDoc(webhookEvent.id, webhookEvent.type, uid, session.id, now),
            );
          }
          return { kind: 'UNPAID', sub };
        }
        const lotsSnap = await tx.get(
          this.collections.loungeCreditLots.where('uid', '==', uid).where('status', '==', 'ACTIVE'),
        );
        const transitioned = applySubscriptionTransition(
          sub,
          lotsSnap.docs.map((d) => d.data()),
          timezone,
          'STANDARD',
          stripeSubSnapshot.cancelAtPeriodEnd ? 'CANCELING' : 'ACTIVE',
          now,
          {
            billingCurrency: sub.billingCurrency ?? currency,
            stripeCustomerId: session.customerId,
            stripeSubscriptionId: stripeSubSnapshot.id,
            ...(stripeSubSnapshot.scheduleId ? { stripeScheduleId: stripeSubSnapshot.scheduleId } : {}),
            ...(stripeSubSnapshot.latestInvoiceId
              ? { lastProcessedInvoiceId: stripeSubSnapshot.latestInvoiceId }
              : {}),
            currentPeriodEnd: stripeSubSnapshot.currentPeriodEndIso,
            cancelAtPeriodEnd: stripeSubSnapshot.cancelAtPeriodEnd,
          },
        );
        this.commitSubscriptionTransition(tx, uid, transitioned);
        if (eventRef && webhookEvent) {
          tx.set(
            eventRef,
            buildProcessedEventDoc(webhookEvent.id, webhookEvent.type, uid, session.id, now),
          );
        }
        return { kind: 'APPLIED', sub: transitioned.subscription };
      }

      const lotRef = this.collections.loungeCreditLots.doc(session.id);
      const lotSnap = await tx.get(lotRef);
      if (lotSnap.exists) {
        if (eventRef && webhookEvent) {
          tx.set(
            eventRef,
            buildProcessedEventDoc(webhookEvent.id, webhookEvent.type, uid, session.id, now),
          );
        }
        return { kind: 'NOOP_ALREADY_PROCESSED', sub };
      }

      const hashes =
        productId === 'TRIAL_TICKET_100'
          ? computeAllTrialGrantHashes(user.xUserId, trialHmacKeyring)
          : [];
      const grantSnaps =
        productId === 'TRIAL_TICKET_100'
          ? await Promise.all(
              hashes.map((h) => tx.get(this.collections.loungeTrialGrants.doc(h.hash))),
            )
          : [];
      const activeGrants = filterActiveTrialGrants(
        grantSnaps.filter((s) => s.exists).map((s) => s.data()),
        nowMs,
      );

      if (
        productId === 'TRIAL_TICKET_100' &&
        (sub.trialTicketUsed || activeGrants.some((g) => Boolean(g.trialTicketGrantedAt)))
      ) {
        return { kind: 'TRIAL_RACE_CONFLICT', sub };
      }

      const activeLotsSnap = await tx.get(
        this.collections.loungeCreditLots.where('uid', '==', uid).where('status', '==', 'ACTIVE'),
      );
      const lazy = evaluateLazyQuotaState(
        sub,
        activeLotsSnap.docs.map((d) => d.data()),
        timezone,
        now,
      );

      const spec = LOUNGE_PRODUCT_CATALOG_SPECS[currency][productId];
      const purchasedMs = Date.parse(session.paymentIntentCreatedIso);
      if (!Number.isFinite(purchasedMs)) {
        throw new Error(`Invalid Checkout Session purchase timestamp "${session.paymentIntentCreatedIso}"`);
      }
      const purchasedAtIso = new Date(purchasedMs).toISOString();
      const expiresAtIso = new Date(
        purchasedMs + LOUNGE_CREDIT_LOT_VALIDITY_DAYS * DAY_MS,
      ).toISOString();

      const newLot: LoungeCreditLotDoc = {
        id: session.id,
        uid,
        productId,
        isPaid: true,
        initialTurns: spec.grantedTurns,
        remainingTurns: spec.grantedTurns,
        currency,
        unitAmount: session.amountTotal ?? spec.unitAmountMinor,
        status: 'ACTIVE',
        ...(session.paymentIntentId ? { stripePaymentIntentId: session.paymentIntentId } : {}),
        purchasedAt: purchasedAtIso,
        expiresAt: expiresAtIso,
      };

      const nextActiveLots = [...lazy.activeLots, newLot];
      const summary = summarizeActiveCreditLots(nextActiveLots, nowMs);
      const nextTotal = lazy.subscription.dailyRemainingTurns + summary.purchasedRemainingTurns;

      const updatedSub: LoungeSubscriptionDoc = {
        ...lazy.subscription,
        billingCurrency: lazy.subscription.billingCurrency ?? currency,
        stripeCustomerId: session.customerId,
        purchasedRemainingTurns: summary.purchasedRemainingTurns,
        earliestLotExpiresAt: summary.earliestLotExpiresAt,
        remainingChatTurns: nextTotal,
        trialTicketUsed:
          productId === 'TRIAL_TICKET_100' ? true : lazy.subscription.trialTicketUsed,
        updatedAt: nowIso,
      };

      const grantLedger = createQuotaLedgerEntry({
        uid,
        deltaType: 'GRANT_LOT',
        deltaDaily: 0,
        deltaPurchased: spec.grantedTurns,
        balanceTotalAfter: nextTotal,
        lotId: newLot.id,
        referenceId: session.id,
        now,
      });

      tx.set(lotRef, newLot);
      this.commitSubscriptionTransition(tx, uid, {
        subscription: updatedSub,
        expiredLots: lazy.expiredLots,
        ledgerEntries: [...lazy.ledgerEntries, grantLedger],
      });

      if (productId === 'TRIAL_TICKET_100') {
        const activeHash = computeActiveTrialGrantHash(user.xUserId, trialHmacKeyring);
        const existingActiveSnap = grantSnaps.find((s) => s.id === activeHash.hash)?.data();
        const priorWelcomeAt = activeGrants.find((g) => Boolean(g.welcomeBonusGrantedAt))
          ?.welcomeBonusGrantedAt;
        const activeRetain =
          existingActiveSnap &&
          Number.isFinite(Date.parse(existingActiveSnap.retainUntil)) &&
          Date.parse(existingActiveSnap.retainUntil) > nowMs
            ? existingActiveSnap.retainUntil
            : computeTrialGrantRetainUntilIso(now);
        const grantDoc: LoungeTrialGrantDoc = {
          xUserIdHash: activeHash.hash,
          keyVersion: activeHash.keyVersion,
          riskStatus: existingActiveSnap?.riskStatus ?? 'OK',
          ...(priorWelcomeAt ? { welcomeBonusGrantedAt: priorWelcomeAt } : {}),
          trialTicketGrantedAt: nowIso,
          retainUntil: activeRetain,
        };
        tx.set(this.collections.loungeTrialGrants.doc(activeHash.hash), grantDoc);
      }

      if (eventRef && webhookEvent) {
        tx.set(
          eventRef,
          buildProcessedEventDoc(webhookEvent.id, webhookEvent.type, uid, session.id, now),
        );
      }

      return { kind: 'APPLIED', sub: updatedSub };
    });
  }

  public async preRevokeCreditLotForEuWithdrawalTx(params: {
    readonly uid: string;
    readonly lotId: string;
    readonly now: Date;
  }): Promise<PreRevokedCreditLotTxResult> {
    const { uid, lotId, now } = params;
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    return this.firestore.runTransaction(async (tx: Transaction) => {
      const lotRef = this.collections.loungeCreditLots.doc(lotId);
      const subRef = this.collections.loungeSubscriptions.doc(uid);
      const [lotSnap, txSubSnap, activeLotsSnap] = await Promise.all([
        tx.get(lotRef),
        tx.get(subRef),
        tx.get(
          this.collections.loungeCreditLots.where('uid', '==', uid).where('status', '==', 'ACTIVE'),
        ),
      ]);
      const lot = lotSnap.data();
      if (!lotSnap.exists || !lot || lot.uid !== uid || !lot.isPaid || lot.status !== 'ACTIVE') {
        throw new LoungeNotFoundError('Eligible paid credit lot not found');
      }
      const purchasedAtMs = Date.parse(lot.purchasedAt);
      if (!Number.isFinite(purchasedAtMs)) {
        throw new Error(`Paid credit lot "${lot.id}" has malformed purchasedAt timestamp`);
      }
      if (nowMs - purchasedAtMs > EU_WITHDRAWAL_WINDOW_DAYS * DAY_MS) {
        throw new LoungeConflictError('14-day withdrawal window expired');
      }
      if (lot.remainingTurns !== lot.initialTurns || lot.remainingTurns <= 0) {
        throw new LoungeConflictError('Credit lot has already been partially or fully consumed');
      }
      if (!lot.stripePaymentIntentId) {
        throw new Error(
          `Paid credit lot "${lot.id}" is missing stripePaymentIntentId for EU withdrawal refund`,
        );
      }
      const latestSub = txSubSnap.data();
      if (!txSubSnap.exists || !latestSub) {
        throw new LoungeNotFoundError(`Lounge subscription for "${uid}" missing`);
      }

      const revokedLot: LoungeCreditLotDoc = { ...lot, remainingTurns: 0, status: 'REVOKED' };
      const remainingActive = activeLotsSnap.docs
        .map((d) => (d.id === lot.id ? revokedLot : d.data()))
        .filter((l) => l.status === 'ACTIVE');
      const summary = summarizeActiveCreditLots(remainingActive, nowMs);
      const nextTotal = latestSub.dailyRemainingTurns + summary.purchasedRemainingTurns;
      const nextSub: LoungeSubscriptionDoc = {
        ...latestSub,
        purchasedRemainingTurns: summary.purchasedRemainingTurns,
        earliestLotExpiresAt: summary.earliestLotExpiresAt,
        remainingChatTurns: nextTotal,
        updatedAt: nowIso,
      };
      const ledger = createQuotaLedgerEntry({
        uid,
        deltaType: 'REFUND_CLAWBACK',
        deltaDaily: 0,
        deltaPurchased: -lot.remainingTurns,
        balanceTotalAfter: nextTotal,
        lotId: lot.id,
        referenceId: `eu_withdraw_${lot.id}`,
        now,
      });
      tx.set(lotRef, revokedLot);
      tx.set(subRef, nextSub);
      tx.set(this.collections.loungeQuotaLedger.doc(ledger.id), ledger);

      return {
        previousLot: lot,
        previousSub: latestSub,
        updatedSub: nextSub,
        paymentIntentId: lot.stripePaymentIntentId,
        refundMinor: lot.unitAmount,
        revokedTurns: lot.remainingTurns,
      };
    });
  }

  public async rollbackCreditLotRevocationTx(
    uid: string,
    previousLot: LoungeCreditLotDoc,
    previousSub: LoungeSubscriptionDoc,
  ): Promise<void> {
    await this.firestore.runTransaction(async (tx: Transaction) => {
      tx.set(this.collections.loungeCreditLots.doc(previousLot.id), previousLot);
      tx.set(this.collections.loungeSubscriptions.doc(uid), previousSub);
    });
  }

  public async preCancelSubscriptionForEuWithdrawalTx(params: {
    readonly uid: string;
    readonly expectedSubId: string;
    readonly userTimezone: string;
    readonly now: Date;
  }): Promise<PreCanceledSubscriptionTxResult> {
    const { uid, expectedSubId, userTimezone, now } = params;
    return this.firestore.runTransaction(async (tx: Transaction) => {
      const subRef = this.collections.loungeSubscriptions.doc(uid);
      const [txSubSnap, lotsSnap] = await Promise.all([
        tx.get(subRef),
        tx.get(
          this.collections.loungeCreditLots.where('uid', '==', uid).where('status', '==', 'ACTIVE'),
        ),
      ]);
      const latestSub = txSubSnap.data();
      if (
        !txSubSnap.exists ||
        !latestSub ||
        !latestSub.stripeSubscriptionId ||
        latestSub.stripeSubscriptionId !== expectedSubId ||
        latestSub.tier !== 'STANDARD' ||
        (latestSub.status !== 'ACTIVE' && latestSub.status !== 'CANCELING')
      ) {
        throw new LoungeNotFoundError('Matching active subscription not found for EEA withdrawal');
      }
      if (
        latestSub.todaysConsumedDailyTurns > 0 ||
        latestSub.dailyRemainingTurns < latestSub.dailyTurnQuota
      ) {
        throw new LoungeConflictError('Subscription daily turns have already been consumed');
      }
      const transitioned = applySubscriptionTransition(
        latestSub,
        lotsSnap.docs.map((d) => d.data()),
        userTimezone,
        'FREE',
        'CANCELED',
        now,
        { cancelAtPeriodEnd: false },
      );
      tx.set(subRef, transitioned.subscription);
      for (const l of transitioned.ledgerEntries) {
        tx.set(this.collections.loungeQuotaLedger.doc(l.id), l);
      }
      return {
        previousSub: latestSub,
        updatedSub: transitioned.subscription,
      };
    });
  }

  public async rollbackSubscriptionCancellationTx(
    uid: string,
    previousSub: LoungeSubscriptionDoc,
  ): Promise<void> {
    await this.firestore.runTransaction(async (tx: Transaction) => {
      tx.set(this.collections.loungeSubscriptions.doc(uid), previousSub);
    });
  }

  public async applyInvoicePaidWebhookTx(params: {
    readonly uid: string;
    readonly eventId: string;
    readonly eventType: string;
    readonly invoiceId: string;
    readonly stripeSub: LoungeStripeSubscriptionSnapshot;
    readonly now: Date;
  }): Promise<boolean> {
    const { uid, eventId, eventType, invoiceId, stripeSub, now } = params;
    return this.firestore.runTransaction(async (tx: Transaction) => {
      const eventRef = this.collections.loungeProcessedEvents.doc(eventId);
      const userRef = this.collections.loungeUsers.doc(uid);
      const subRef = this.collections.loungeSubscriptions.doc(uid);
      const [eventSnap, userSnap, subSnap, lotsSnap] = await Promise.all([
        tx.get(eventRef),
        tx.get(userRef),
        tx.get(subRef),
        tx.get(
          this.collections.loungeCreditLots.where('uid', '==', uid).where('status', '==', 'ACTIVE'),
        ),
      ]);

      if (eventSnap.exists) {
        return false;
      }
      const user = userSnap.data();
      const sub = subSnap.data();
      if (!userSnap.exists || !user || user.status === 'DELETING' || !subSnap.exists || !sub) {
        tx.set(eventRef, buildProcessedEventDoc(eventId, eventType, uid, invoiceId, now));
        return false;
      }

      const isMatchingSub = !sub.stripeSubscriptionId || sub.stripeSubscriptionId === stripeSub.id;
      const incomingPeriodMs = Date.parse(stripeSub.currentPeriodEndIso);
      const currentPeriodMs = Date.parse(sub.currentPeriodEnd);
      const isNewerOrEqualPeriod =
        !Number.isFinite(currentPeriodMs) || incomingPeriodMs >= currentPeriodMs;

      if (!isMatchingSub || !isNewerOrEqualPeriod || sub.lastProcessedInvoiceId === invoiceId) {
        tx.set(eventRef, buildProcessedEventDoc(eventId, eventType, uid, invoiceId, now));
        return false;
      }

      const transitioned = applySubscriptionTransition(
        sub,
        lotsSnap.docs.map((d) => d.data()),
        user.timezone,
        'STANDARD',
        stripeSub.cancelAtPeriodEnd ? 'CANCELING' : 'ACTIVE',
        now,
        {
          stripeCustomerId: stripeSub.customerId,
          stripeSubscriptionId: stripeSub.id,
          lastProcessedInvoiceId: invoiceId,
          currentPeriodEnd: stripeSub.currentPeriodEndIso,
          cancelAtPeriodEnd: stripeSub.cancelAtPeriodEnd,
        },
      );
      this.commitSubscriptionTransition(tx, uid, transitioned);
      tx.set(eventRef, buildProcessedEventDoc(eventId, eventType, uid, invoiceId, now));
      return true;
    });
  }

  public async applySubscriptionLifecycleWebhookTx(params: {
    readonly uid: string;
    readonly eventId: string;
    readonly eventType: string;
    readonly stripeSub: LoungeStripeSubscriptionSnapshot;
    readonly targetStatus: LoungeSubscriptionStatus;
    readonly now: Date;
  }): Promise<SubscriptionLifecycleTxOutcome> {
    const { uid, eventId, eventType, stripeSub, targetStatus, now } = params;
    const targetTier: LoungeSubscriptionTier =
      targetStatus === 'ACTIVE' || targetStatus === 'CANCELING' ? 'STANDARD' : 'FREE';

    return this.firestore.runTransaction(async (tx: Transaction) => {
      const eventRef = this.collections.loungeProcessedEvents.doc(eventId);
      const userRef = this.collections.loungeUsers.doc(uid);
      const subRef = this.collections.loungeSubscriptions.doc(uid);
      const [eventSnap, userSnap, subSnap, lotsSnap] = await Promise.all([
        tx.get(eventRef),
        tx.get(userRef),
        tx.get(subRef),
        tx.get(
          this.collections.loungeCreditLots.where('uid', '==', uid).where('status', '==', 'ACTIVE'),
        ),
      ]);

      if (eventSnap.exists) {
        return 'ALREADY_PROCESSED';
      }
      const user = userSnap.data();
      const sub = subSnap.data();
      if (!userSnap.exists || !user || user.status === 'DELETING' || !subSnap.exists || !sub) {
        tx.set(eventRef, buildProcessedEventDoc(eventId, eventType, uid, stripeSub.id, now));
        return 'SKIPPED_MISSING';
      }
      if (sub.stripeSubscriptionId && sub.stripeSubscriptionId !== stripeSub.id) {
        tx.set(eventRef, buildProcessedEventDoc(eventId, eventType, uid, stripeSub.id, now));
        return 'SKIPPED_STALE_SUB';
      }

      const transitioned = applySubscriptionTransition(
        sub,
        lotsSnap.docs.map((d) => d.data()),
        user.timezone,
        targetTier,
        targetStatus,
        now,
        {
          currentPeriodEnd: stripeSub.currentPeriodEndIso,
          cancelAtPeriodEnd: targetStatus === 'CANCELING',
        },
      );
      this.commitSubscriptionTransition(tx, uid, transitioned);
      tx.set(eventRef, buildProcessedEventDoc(eventId, eventType, uid, stripeSub.id, now));
      return 'APPLIED';
    });
  }

  public async applyRefundOrDisputeClawbackTx(params: {
    readonly eventId: string;
    readonly eventType: string;
    readonly uid: string;
    readonly lotId: string | undefined;
    readonly referenceId: string;
    readonly isDispute: boolean;
    readonly trialHmacKeyring: TrialHmacKeyring;
    readonly now: Date;
  }): Promise<void> {
    const { eventId, eventType, uid, lotId, referenceId, isDispute, trialHmacKeyring, now } =
      params;
    const nowIso = now.toISOString();

    await this.firestore.runTransaction(async (tx: Transaction) => {
      const eventRef = this.collections.loungeProcessedEvents.doc(eventId);
      const userRef = this.collections.loungeUsers.doc(uid);
      const subRef = this.collections.loungeSubscriptions.doc(uid);
      const lotRef = lotId ? this.collections.loungeCreditLots.doc(lotId) : null;

      const [eventSnap, userSnap, subSnap, lotSnap, activeLotsSnap] = await Promise.all([
        tx.get(eventRef),
        tx.get(userRef),
        tx.get(subRef),
        lotRef ? tx.get(lotRef) : Promise.resolve(null),
        tx.get(
          this.collections.loungeCreditLots.where('uid', '==', uid).where('status', '==', 'ACTIVE'),
        ),
      ]);

      if (eventSnap.exists) {
        return;
      }
      const user = userSnap.data();
      const sub = subSnap.data();
      if (!userSnap.exists || !user || user.status === 'DELETING' || !subSnap.exists || !sub) {
        tx.set(eventRef, buildProcessedEventDoc(eventId, eventType, uid, referenceId, now));
        return;
      }

      const activeHash = isDispute
        ? computeActiveTrialGrantHash(user.xUserId, trialHmacKeyring)
        : null;
      const grantRef = activeHash ? this.collections.loungeTrialGrants.doc(activeHash.hash) : null;
      const existingGrantSnap = grantRef ? await tx.get(grantRef) : null;

      let activeLots = activeLotsSnap.docs.map((d) => d.data());
      let revokedTurns = 0;
      const targetLot = lotSnap?.data();
      if (lotRef && lotSnap?.exists && targetLot && targetLot.status !== 'REVOKED') {
        revokedTurns = targetLot.remainingTurns;
        const updatedLot: LoungeCreditLotDoc = {
          ...targetLot,
          remainingTurns: 0,
          status: 'REVOKED',
        };
        tx.set(lotRef, updatedLot);
        activeLots = activeLots.filter((l) => l.id !== updatedLot.id);
      }

      const summary = summarizeActiveCreditLots(activeLots, now.getTime());
      const targetTier: LoungeSubscriptionTier = isDispute ? 'FREE' : sub.tier;
      const targetStatus: LoungeSubscriptionStatus = isDispute ? 'CANCELED' : sub.status;
      const transitioned = applySubscriptionTransition(
        {
          ...sub,
          purchasedRemainingTurns: summary.purchasedRemainingTurns,
          earliestLotExpiresAt: summary.earliestLotExpiresAt,
          remainingChatTurns: sub.dailyRemainingTurns + summary.purchasedRemainingTurns,
        },
        activeLots,
        user.timezone,
        targetTier,
        targetStatus,
        now,
        isDispute ? { cancelAtPeriodEnd: false } : {},
      );

      tx.set(subRef, transitioned.subscription);
      const clawbackLedger = createQuotaLedgerEntry({
        uid,
        deltaType: 'REFUND_CLAWBACK',
        deltaDaily: 0,
        deltaPurchased: -revokedTurns,
        balanceTotalAfter: transitioned.subscription.remainingChatTurns,
        ...(lotId ? { lotId } : {}),
        referenceId,
        now,
      });
      tx.set(this.collections.loungeQuotaLedger.doc(clawbackLedger.id), clawbackLedger);

      if (isDispute && activeHash && grantRef) {
        tx.set(userRef, { ...user, status: 'SUSPENDED', updatedAt: nowIso });
        const existingGrant = existingGrantSnap?.exists ? existingGrantSnap.data() : undefined;
        const defaultRetainUntil = computeTrialGrantRetainUntilIso(now);
        const existingRetainMs = existingGrant ? Date.parse(existingGrant.retainUntil) : Number.NaN;
        const retainUntil =
          existingGrant &&
          Number.isFinite(existingRetainMs) &&
          existingRetainMs > Date.parse(defaultRetainUntil)
            ? existingGrant.retainUntil
            : defaultRetainUntil;
        tx.set(grantRef, {
          xUserIdHash: activeHash.hash,
          keyVersion: activeHash.keyVersion,
          riskStatus: 'DISPUTE_BLOCKED',
          ...(existingGrant?.welcomeBonusGrantedAt
            ? { welcomeBonusGrantedAt: existingGrant.welcomeBonusGrantedAt }
            : {}),
          ...(existingGrant?.trialTicketGrantedAt
            ? { trialTicketGrantedAt: existingGrant.trialTicketGrantedAt }
            : {}),
          retainUntil,
        });
      }

      tx.set(eventRef, buildProcessedEventDoc(eventId, eventType, uid, referenceId, now));
    });
  }

  public async applySubscriptionRefundDowngradeTx(params: {
    readonly eventId: string;
    readonly eventType: string;
    readonly uid: string;
    readonly invoiceId: string;
    readonly now: Date;
  }): Promise<void> {
    const { eventId, eventType, uid, invoiceId, now } = params;
    await this.firestore.runTransaction(async (tx: Transaction) => {
      const eventRef = this.collections.loungeProcessedEvents.doc(eventId);
      const userRef = this.collections.loungeUsers.doc(uid);
      const subRef = this.collections.loungeSubscriptions.doc(uid);
      const [eventSnap, userSnap, subSnap, lotsSnap] = await Promise.all([
        tx.get(eventRef),
        tx.get(userRef),
        tx.get(subRef),
        tx.get(
          this.collections.loungeCreditLots.where('uid', '==', uid).where('status', '==', 'ACTIVE'),
        ),
      ]);

      if (eventSnap.exists) {
        return;
      }
      const user = userSnap.data();
      const sub = subSnap.data();
      if (!userSnap.exists || !user || user.status === 'DELETING' || !subSnap.exists || !sub) {
        tx.set(eventRef, buildProcessedEventDoc(eventId, eventType, uid, invoiceId, now));
        return;
      }
      const transitioned = applySubscriptionTransition(
        sub,
        lotsSnap.docs.map((d) => d.data()),
        user.timezone,
        'FREE',
        'CANCELED',
        now,
        { cancelAtPeriodEnd: false },
      );
      tx.set(subRef, transitioned.subscription);
      for (const l of transitioned.ledgerEntries) {
        tx.set(this.collections.loungeQuotaLedger.doc(l.id), l);
      }
      tx.set(eventRef, buildProcessedEventDoc(eventId, eventType, uid, invoiceId, now));
    });
  }
}
