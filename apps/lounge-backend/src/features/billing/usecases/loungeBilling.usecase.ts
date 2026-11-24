import type { Firestore, Transaction } from '@google-cloud/firestore';
import { createUserScopedLoungeDb, type DbCollections } from '@rebecca/db';
import {
  toPublicLoungeSubscription,
  type LoungeBillingCatalogDto,
  type LoungeBillingOrderItemDto,
  type LoungeBillingOrdersResponseDto,
  type LoungeBillingProductDto,
  type LoungeBillingReceiptResponseDto,
  type LoungeCreateCheckoutRequestDto,
  type LoungeCreateCheckoutResponseDto,
  type LoungeCreatePortalRequestDto,
  type LoungeCreatePortalResponseDto,
  type LoungeCreditLotDoc,
  type LoungeCreditLotStatus,
  type LoungeCurrency,
  type LoungeEuWithdrawalRequestDto,
  type LoungeEuWithdrawalResponseDto,
  type LoungeOrderStatus,
  type LoungePortalFlow,
  type LoungeProcessedEventDoc,
  type LoungeProductId,
  type LoungeSubscription,
  type LoungeSubscriptionDetailResponseDto,
  type LoungeSubscriptionDoc,
  type LoungeSubscriptionStatus,
  type LoungeSubscriptionTier,
  type LoungeTrialGrantDoc,
  type LoungeVerifyCheckoutResponseDto,
} from '@rebecca/types';
import {
  DEFAULT_LOUNGE_TIMEZONE,
  LOUNGE_CREDIT_LOT_VALIDITY_DAYS,
  LOUNGE_PROCESSED_EVENT_TTL_DAYS,
  LOUNGE_PRODUCT_CATALOG_SPECS,
  LOUNGE_TRIAL_GRANT_RETENTION_DAYS,
  computeActiveTrialGrantHash,
  computeAllTrialGrantHashes,
  type LoungeRuntimeEnvironmentConfig,
  type ResolvedClientGeo,
} from '../../../config/loungeConfig';
import {
  LoungeAuthError,
  LoungeConflictError,
  LoungeHttpError,
  LoungeNotFoundError,
  LoungeValidationError,
} from '../../../utils/errors';
import { loungeLogger, sanitizeLogInput } from '../../../utils/logger';
import {
  applySubscriptionTransition,
  buildQuotaBreakdownAndWarning,
  createQuotaLedgerEntry,
  evaluateLazyQuotaState,
  summarizeActiveCreditLots,
} from '../domain/loungeQuota.engine';
import type {
  ILoungeStripeGatewayPort,
  LoungeStripeChargeRecord,
  LoungeStripeCheckoutSession,
} from '../ports/loungeStripe.port';

const SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_]{1,250}$/;
const CHARGE_ID_PATTERN = /^ch_[A-Za-z0-9_]{1,250}$/;
const STRIPE_RECEIPT_URL_PATTERN = /^https:\/\/(?:[a-z0-9-]+\.)*stripe\.com(?:\/|$)/i;
const DAY_MS = 24 * 60 * 60 * 1000;
const PURCHASABLE_PRODUCT_IDS: ReadonlyArray<Exclude<LoungeProductId, 'WELCOME_BONUS_20'>> = [
  'TRIAL_TICKET_100',
  'CHARGE_TICKET_100',
  'STANDARD_MONTHLY',
];
const PORTAL_FLOWS: readonly LoungePortalFlow[] = [
  'default',
  'payment_method_update',
  'subscription_cancel',
];

/** Redacts Checkout Session IDs in application logs to avoid exposing bearer-like session handles. */
export function maskCheckoutSessionId(sessionId: string): string {
  if (!sessionId || sessionId.length <= 10) {
    return '***';
  }
  return `${sessionId.slice(0, 6)}...${sessionId.slice(-4)}`;
}

/** Validates incoming Checkout creation payloads (unchecked ASCT Art. 12-6 checkboxes enforced `true`). */
export function parseAndValidateCreateCheckoutRequest(
  raw: unknown,
): LoungeCreateCheckoutRequestDto {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LoungeValidationError('Checkout payload must be a JSON object');
  }
  const body = raw as Record<string, unknown>;
  const rawProductId = body['productId'];
  const productId = PURCHASABLE_PRODUCT_IDS.find((id) => id === rawProductId);
  if (!productId) {
    throw new LoungeValidationError('Invalid or unsupported productId');
  }
  if (
    body['acceptedPurchaseDisclosure'] !== true ||
    body['acceptedAutoRenewalOptIn'] !== true ||
    body['confirmedAdultOrParentalConsent'] !== true
  ) {
    throw new LoungeValidationError(
      'All statutory pre-checkout disclosures and confirmations must be accepted',
    );
  }
  if (body['euDigitalWaiverAccepted'] !== undefined && typeof body['euDigitalWaiverAccepted'] !== 'boolean') {
    throw new LoungeValidationError('Field "euDigitalWaiverAccepted" must be a boolean');
  }
  return {
    productId,
    acceptedPurchaseDisclosure: true,
    acceptedAutoRenewalOptIn: true,
    confirmedAdultOrParentalConsent: true,
    ...(typeof body['euDigitalWaiverAccepted'] === 'boolean'
      ? { euDigitalWaiverAccepted: body['euDigitalWaiverAccepted'] }
      : {}),
  };
}

/** Validates `POST /billing/checkout/verify` request payload. */
export function parseAndValidateVerifyCheckoutRequest(raw: unknown): { readonly sessionId: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LoungeValidationError('Checkout verify payload must be a JSON object');
  }
  const sessionId = (raw as Record<string, unknown>)['sessionId'];
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId.trim())) {
    throw new LoungeValidationError('Field "sessionId" must be a valid Stripe Checkout Session ID');
  }
  return { sessionId: sessionId.trim() };
}

/** Validates `POST /billing/portal` deep-link flow selector. */
export function parseAndValidatePortalRequest(raw: unknown): LoungeCreatePortalRequestDto {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LoungeValidationError('Portal payload must be a JSON object');
  }
  const rawFlow = (raw as Record<string, unknown>)['flow'];
  const flow = PORTAL_FLOWS.find((f) => f === rawFlow);
  if (!flow) {
    throw new LoungeValidationError(
      'Field "flow" must be one of: default, payment_method_update, subscription_cancel',
    );
  }
  return { flow };
}

/** Validates Phase 2 EEA withdrawal payload (`POST /billing/eu-withdrawal`). */
export function parseAndValidateEuWithdrawalRequest(
  raw: unknown,
): LoungeEuWithdrawalRequestDto {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LoungeValidationError('EU withdrawal payload must be a JSON object');
  }
  const body = raw as Record<string, unknown>;
  const targetType =
    body['targetType'] === 'SUBSCRIPTION' || body['targetType'] === 'CREDIT_LOT'
      ? body['targetType']
      : null;
  if (!targetType) {
    throw new LoungeValidationError('Field "targetType" must be SUBSCRIPTION or CREDIT_LOT');
  }
  const targetId = typeof body['targetId'] === 'string' ? body['targetId'].trim() : '';
  if (!targetId) {
    throw new LoungeValidationError('Field "targetId" must be a non-empty identifier');
  }
  if (body['confirmedWithdrawal'] !== true) {
    throw new LoungeValidationError('Field "confirmedWithdrawal" must be true');
  }
  return {
    targetType,
    targetId,
    confirmedWithdrawal: true,
  };
}

/** Validates bounded `[1, 30]` order listing pagination parameters (`GET /billing/orders`). */
export function parseOrdersQueryParams(rawQuery: Readonly<Record<string, unknown>>): {
  readonly limit: number;
  readonly startingAfter?: string;
} {
  const rawLimit = rawQuery['limit'];
  let limit = 20;
  if (rawLimit !== undefined && rawLimit !== null && rawLimit !== '') {
    if (Array.isArray(rawLimit) || (typeof rawLimit !== 'number' && typeof rawLimit !== 'string')) {
      throw new LoungeValidationError('Query parameter "limit" must be a positive integer');
    }
    const parsed = typeof rawLimit === 'number' ? rawLimit : Number(rawLimit);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
      throw new LoungeValidationError('Query parameter "limit" must be a positive integer');
    }
    limit = Math.min(parsed, 30);
  }

  const rawCursor = rawQuery['startingAfter'];
  let startingAfter: string | undefined;
  if (rawCursor !== undefined && rawCursor !== null && rawCursor !== '') {
    if (typeof rawCursor !== 'string' || !CHARGE_ID_PATTERN.test(rawCursor.trim())) {
      throw new LoungeValidationError('Query parameter "startingAfter" must be a Stripe Charge ID');
    }
    startingAfter = rawCursor.trim();
  }

  return { limit, ...(startingAfter ? { startingAfter } : {}) };
}

/** Use case contract backing all 9 Private Lounge billing endpoints and Stripe webhook ingestion. */
export interface ILoungeBillingUseCase {
  getCatalog(uid: string, clientGeo: ResolvedClientGeo): Promise<LoungeBillingCatalogDto>;
  createCheckoutSession(
    uid: string,
    request: LoungeCreateCheckoutRequestDto,
    clientGeo: ResolvedClientGeo,
  ): Promise<LoungeCreateCheckoutResponseDto>;
  verifyCheckoutSession(uid: string, sessionId: string): Promise<LoungeVerifyCheckoutResponseDto>;
  createPortalSession(uid: string, request: LoungeCreatePortalRequestDto): Promise<LoungeCreatePortalResponseDto>;
  getSubscriptionDetail(
    uid: string,
    options?: { readonly portalReturn?: boolean; readonly isEeaResident?: boolean },
  ): Promise<LoungeSubscriptionDetailResponseDto>;
  withdrawEuContract(
    uid: string,
    request: LoungeEuWithdrawalRequestDto,
    clientGeo: ResolvedClientGeo,
  ): Promise<LoungeEuWithdrawalResponseDto>;
  listOrders(
    uid: string,
    query: { readonly limit: number; readonly startingAfter?: string },
  ): Promise<LoungeBillingOrdersResponseDto>;
  getOrderReceipt(uid: string, chargeId: string): Promise<LoungeBillingReceiptResponseDto>;
  handleStripeWebhook(
    rawBody: Buffer,
    signatureHeader: string,
  ): Promise<{ readonly received: true; readonly ignored?: boolean }>;
}

/**
 * Coordinates Stripe Checkout, Customer Portal delegation, charge history queries,
 * hybrid quota granting, refund/dispute clawbacks, and Phase 2 EEA withdrawal.
 */
export class LoungeBillingUseCase implements ILoungeBillingUseCase {
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
    private readonly stripeGateway: ILoungeStripeGatewayPort,
    private readonly config: LoungeRuntimeEnvironmentConfig,
  ) {}

  private async checkTrialEligibilityInDb(
    xUserId: string,
    sub: LoungeSubscriptionDoc | null,
  ): Promise<{ readonly eligible: boolean; readonly disputeBlocked: boolean }> {
    if (sub?.trialTicketUsed) {
      return { eligible: false, disputeBlocked: false };
    }
    const hashes = computeAllTrialGrantHashes(xUserId, this.config.trialHmacKeyring);
    const refs = hashes.map((h) => this.collections.loungeTrialGrants.doc(h.hash));
    const snaps = refs.length > 0 ? await this.firestore.getAll(...refs) : [];
    const grants = snaps
      .filter((s) => s.exists)
      .map((s) => s.data())
      .filter((g): g is LoungeTrialGrantDoc => g !== undefined);

    const disputeBlocked = grants.some((g) => g.riskStatus === 'DISPUTE_BLOCKED');
    const trialUsed = grants.some((g) => Boolean(g.trialTicketGrantedAt));
    return {
      eligible: !disputeBlocked && !trialUsed,
      disputeBlocked,
    };
  }

  private async requireActiveUserAndSub(uid: string) {
    const [userSnap, subSnap] = await Promise.all([
      this.collections.loungeUsers.doc(uid).get(),
      this.collections.loungeSubscriptions.doc(uid).get(),
    ]);
    const user = userSnap.data();
    if (!userSnap.exists || !user) {
      throw new LoungeAuthError(401, 'Private Lounge user profile not found');
    }
    if (user.status !== 'ACTIVE') {
      throw new LoungeAuthError(403, 'Private Lounge account is not active');
    }
    const sub = subSnap.data();
    if (!subSnap.exists || !sub) {
      throw new LoungeNotFoundError(`Lounge subscription for "${uid}" was not found`);
    }
    return { user, sub };
  }

  private resolveCurrency(
    userPreferred: LoungeCurrency | undefined,
    subCurrency: LoungeCurrency | undefined,
    clientGeo: ResolvedClientGeo,
  ): { readonly currency: LoungeCurrency; readonly currencyLocked: boolean } {
    const locked = subCurrency ?? userPreferred;
    return {
      currency: locked ?? clientGeo.currency,
      currencyLocked: Boolean(subCurrency),
    };
  }

  /** Returns server-locked multi-currency catalog and purchase eligibility (`GET /billing/catalog`). */
  public async getCatalog(
    uid: string,
    clientGeo: ResolvedClientGeo,
  ): Promise<LoungeBillingCatalogDto> {
    const { user, sub } = await this.requireActiveUserAndSub(uid);
    const { currency, currencyLocked } = this.resolveCurrency(
      user.preferredCurrency,
      sub.billingCurrency,
      clientGeo,
    );
    const isEeaResident = user.isEeaResident ?? clientGeo.isEeaResident;
    const countryCode = user.countryCode ?? clientGeo.countryCode;
    const geoBlocked = !this.config.phase2EeaEnabled && isEeaResident;

    const { eligible: trialEligible } = await this.checkTrialEligibilityInDb(user.xUserId, sub);
    const subAlreadyActive =
      sub.status === 'ACTIVE' || sub.status === 'CANCELING' || sub.status === 'PAST_DUE';

    const specs = LOUNGE_PRODUCT_CATALOG_SPECS[currency];
    const products: LoungeBillingProductDto[] = PURCHASABLE_PRODUCT_IDS.map((productId) => {
      const spec = specs[productId];
      let ineligibleReason: LoungeBillingProductDto['ineligibleReason'];
      if (geoBlocked) {
        ineligibleReason = 'GEO_BLOCKED';
      } else if (productId === 'TRIAL_TICKET_100' && !trialEligible) {
        ineligibleReason = 'TRIAL_ALREADY_USED';
      } else if (productId === 'STANDARD_MONTHLY' && subAlreadyActive) {
        ineligibleReason = 'SUBSCRIPTION_ALREADY_ACTIVE';
      }
      return {
        productId,
        mode: spec.mode,
        currency,
        unitAmountMinor: spec.unitAmountMinor,
        formattedPrice: spec.formattedPrice,
        grantedTurns: spec.grantedTurns,
        validityDays: spec.validityDays,
        taxInclusive: spec.taxInclusive,
        promotionCodesAllowed: spec.promotionCodesAllowed,
        eligible: !ineligibleReason,
        ...(ineligibleReason ? { ineligibleReason } : {}),
      };
    });

    return {
      currency,
      currencyLocked,
      countryCode,
      isEeaResident,
      phase2EeaEnabled: this.config.phase2EeaEnabled,
      trialEligible: !geoBlocked && trialEligible,
      subscriptionStatus: sub.status,
      products,
    };
  }

  /** Creates a Stripe Checkout Session for a pre-created Customer (`POST /billing/checkout`). */
  public async createCheckoutSession(
    uid: string,
    request: LoungeCreateCheckoutRequestDto,
    clientGeo: ResolvedClientGeo,
  ): Promise<LoungeCreateCheckoutResponseDto> {
    const validated = parseAndValidateCreateCheckoutRequest(request);
    const { user, sub } = await this.requireActiveUserAndSub(uid);

    const isEeaResident = user.isEeaResident ?? clientGeo.isEeaResident;
    const countryCode = user.countryCode ?? clientGeo.countryCode;
    if (!this.config.phase2EeaEnabled && isEeaResident) {
      throw new LoungeHttpError(403, 'Purchases are not currently enabled for EEA/UK/CH regions', {
        code: 'GEO_BLOCKED',
      });
    }

    if (validated.productId === 'TRIAL_TICKET_100') {
      const eligibility = await this.checkTrialEligibilityInDb(user.xUserId, sub);
      if (eligibility.disputeBlocked) {
        throw new LoungeAuthError(403, 'Purchases restricted due to prior payment dispute', {
          code: 'DISPUTE_BLOCKED',
        });
      }
      if (!eligibility.eligible) {
        throw new LoungeConflictError('One-time trial ticket has already been purchased', {
          code: 'TRIAL_ALREADY_USED',
        });
      }
    }

    if (
      validated.productId === 'STANDARD_MONTHLY' &&
      (sub.status === 'ACTIVE' || sub.status === 'CANCELING' || sub.status === 'PAST_DUE')
    ) {
      throw new LoungeConflictError(
        'An active or pending subscription already exists; manage it via Customer Portal',
        { code: 'SUBSCRIPTION_ALREADY_ACTIVE' },
      );
    }

    const { currency } = this.resolveCurrency(user.preferredCurrency, sub.billingCurrency, clientGeo);
    const spec = LOUNGE_PRODUCT_CATALOG_SPECS[currency][validated.productId];
    const priceId = this.config.stripePriceIds[currency][validated.productId];

    const { customerId } = await this.stripeGateway.ensureCustomer({
      existingCustomerId: sub.stripeCustomerId,
      uid,
      xHandle: user.xHandle,
      countryCode,
    });

    if (sub.stripeCustomerId !== customerId || !sub.billingCurrency || !user.preferredCurrency) {
      const nowIso = new Date().toISOString();
      await this.firestore.runTransaction(async (tx: Transaction) => {
        const [latestSubSnap, latestUserSnap] = await Promise.all([
          tx.get(this.collections.loungeSubscriptions.doc(uid)),
          tx.get(this.collections.loungeUsers.doc(uid)),
        ]);
        const latestSub = latestSubSnap.data();
        if (latestSubSnap.exists && latestSub) {
          tx.set(this.collections.loungeSubscriptions.doc(uid), {
            ...latestSub,
            stripeCustomerId: customerId,
            billingCurrency: latestSub.billingCurrency ?? currency,
            updatedAt: nowIso,
          });
        }
        const latestUser = latestUserSnap.data();
        if (latestUserSnap.exists && latestUser && !latestUser.preferredCurrency) {
          tx.set(this.collections.loungeUsers.doc(uid), {
            ...latestUser,
            countryCode,
            isEeaResident,
            preferredCurrency: currency,
            updatedAt: nowIso,
          });
        }
      });
    }

    const nowIso = new Date().toISOString();
    const metadata: Record<string, string> = {
      uid,
      productId: validated.productId,
      currency,
      consentVersionAtCheckout: String(user.disclaimerConsent.disclaimerVersion),
      caAutoRenewalOptInAt: nowIso,
      ...(validated.euDigitalWaiverAccepted ? { euWithdrawalWaivedAt: nowIso } : {}),
    };

    const submitMessage =
      validated.productId === 'STANDARD_MONTHLY'
        ? 'Monthly subscription auto-renews until canceled in Customer Portal.'
        : 'One-time credit lot valid for 180 days from payment confirmation.';

    const session = await this.stripeGateway.createCheckoutSession({
      customerId,
      uid,
      productId: validated.productId,
      mode: spec.mode,
      priceId,
      currency,
      successUrl: `${this.config.loungePublicOrigin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${this.config.loungePublicOrigin}/?checkout=cancel`,
      allowPromotionCodes: validated.productId === 'CHARGE_TICKET_100',
      enableInvoiceCreation: this.config.phase2EeaEnabled && isEeaResident && spec.mode === 'payment',
      submitMessage,
      metadata,
    });

    return {
      checkoutUrl: session.url,
      sessionIdMasked: maskCheckoutSessionId(session.id),
    };
  }

  /**
   * Immediately verifies a completed Checkout Session after redirect (`POST /billing/checkout/verify`)
   * using the same atomic grant & trial race-refund transaction as the webhook handler.
   */
  public async verifyCheckoutSession(
    uid: string,
    sessionId: string,
  ): Promise<LoungeVerifyCheckoutResponseDto> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new LoungeValidationError('Invalid Stripe Checkout Session ID');
    }
    const { user, sub } = await this.requireActiveUserAndSub(uid);
    const session = await this.stripeGateway.retrieveCheckoutSession(sessionId);

    if (session.metadata['uid'] && session.metadata['uid'] !== uid) {
      throw new LoungeAuthError(403, 'Checkout session does not belong to authenticated user');
    }
    if (sub.stripeCustomerId && session.customerId && session.customerId !== sub.stripeCustomerId) {
      throw new LoungeAuthError(403, 'Checkout session customer mismatch');
    }
    if (session.paymentStatus === 'unpaid') {
      return {
        subscription: toPublicLoungeSubscription(sub),
        verified: false,
      };
    }

    const granted = await this.fulfillCheckoutSession(session, user.timezone);
    return {
      subscription: toPublicLoungeSubscription(granted.subscription),
      verified: granted.applied,
      ...(granted.autoRefundedConflict ? { autoRefundedConflict: true } : {}),
    };
  }

  /** Shared idempotent fulfillment logic for Checkout Verify and `checkout.session.completed` webhook. */
  private async fulfillCheckoutSession(
    session: LoungeStripeCheckoutSession,
    fallbackTimezone: string = DEFAULT_LOUNGE_TIMEZONE,
    webhookEvent?: { readonly id: string; readonly type: string },
  ): Promise<{
    readonly subscription: LoungeSubscriptionDoc;
    readonly applied: boolean;
    readonly autoRefundedConflict: boolean;
  }> {
    const uid = session.metadata['uid'];
    const rawProductId = session.metadata['productId'];
    const productId = PURCHASABLE_PRODUCT_IDS.find((p) => p === rawProductId);
    if (!uid || !productId) {
      throw new LoungeValidationError('Checkout session missing required uid/productId metadata');
    }

    const stripeSubSnapshot =
      session.mode === 'subscription' && session.subscriptionId
        ? await this.stripeGateway.retrieveSubscription(session.subscriptionId)
        : null;

    const now = new Date();
    const nowIso = now.toISOString();
    const allHashesCache = new Map<string, ReturnType<typeof computeAllTrialGrantHashes>>();

    const txOutcome = await this.firestore.runTransaction(async (tx: Transaction) => {
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
        return { kind: 'NOOP_ALREADY_PROCESSED' as const, sub: sub ?? null };
      }
      if (!userSnap.exists || !user || user.status === 'DELETING' || !subSnap.exists || !sub) {
        if (eventRef && webhookEvent) {
          tx.set(eventRef, this.buildProcessedEventDoc(webhookEvent.id, webhookEvent.type, uid, session.id, now));
        }
        return { kind: 'NOOP_WITHDRAWN' as const, sub: sub ?? null };
      }

      const timezone = user.timezone || fallbackTimezone;
      const currency: LoungeCurrency =
        session.currency ?? sub.billingCurrency ?? user.preferredCurrency ?? 'JPY';

      if (productId === 'STANDARD_MONTHLY') {
        if (!stripeSubSnapshot) {
          return { kind: 'UNPAID' as const, sub };
        }
        const lotsSnap = await tx.get(
          this.collections.loungeCreditLots.where('uid', '==', uid).where('status', '==', 'ACTIVE'),
        );
        const lots = lotsSnap.docs.map((d) => d.data());
        const transitioned = applySubscriptionTransition(
          sub,
          lots,
          timezone,
          'STANDARD',
          stripeSubSnapshot.cancelAtPeriodEnd ? 'CANCELING' : 'ACTIVE',
          now,
          {
            billingCurrency: sub.billingCurrency ?? currency,
            stripeCustomerId: session.customerId || sub.stripeCustomerId,
            stripeSubscriptionId: stripeSubSnapshot.id,
            ...(stripeSubSnapshot.scheduleId ? { stripeScheduleId: stripeSubSnapshot.scheduleId } : {}),
            ...(stripeSubSnapshot.latestInvoiceId
              ? { lastProcessedInvoiceId: stripeSubSnapshot.latestInvoiceId }
              : {}),
            currentPeriodEnd: stripeSubSnapshot.currentPeriodEndIso,
            cancelAtPeriodEnd: stripeSubSnapshot.cancelAtPeriodEnd,
          },
        );
        tx.set(subRef, transitioned.subscription);
        for (const exp of transitioned.expiredLots) {
          tx.set(this.collections.loungeCreditLots.doc(exp.id), exp);
        }
        for (const entry of transitioned.ledgerEntries) {
          tx.set(this.collections.loungeQuotaLedger.doc(entry.id), entry);
        }
        if (eventRef && webhookEvent) {
          tx.set(
            eventRef,
            this.buildProcessedEventDoc(webhookEvent.id, webhookEvent.type, uid, session.id, now),
          );
        }
        return { kind: 'APPLIED' as const, sub: transitioned.subscription };
      }

      // One-time credit lot (TRIAL_TICKET_100 or CHARGE_TICKET_100)
      const lotRef = this.collections.loungeCreditLots.doc(session.id);
      const lotSnap = await tx.get(lotRef);
      if (lotSnap.exists) {
        if (eventRef && webhookEvent) {
          tx.set(
            eventRef,
            this.buildProcessedEventDoc(webhookEvent.id, webhookEvent.type, uid, session.id, now),
          );
        }
        return { kind: 'NOOP_ALREADY_PROCESSED' as const, sub };
      }

      const hashes =
        allHashesCache.get(user.xUserId) ??
        computeAllTrialGrantHashes(user.xUserId, this.config.trialHmacKeyring);
      allHashesCache.set(user.xUserId, hashes);

      const grantSnaps =
        productId === 'TRIAL_TICKET_100'
          ? await Promise.all(
              hashes.map((h) => tx.get(this.collections.loungeTrialGrants.doc(h.hash))),
            )
          : [];
      const existingGrants = grantSnaps
        .filter((s) => s.exists)
        .map((s) => s.data())
        .filter((g): g is LoungeTrialGrantDoc => g !== undefined);

      if (
        productId === 'TRIAL_TICKET_100' &&
        (sub.trialTicketUsed || existingGrants.some((g) => Boolean(g.trialTicketGrantedAt)))
      ) {
        return { kind: 'TRIAL_RACE_CONFLICT' as const, sub };
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
      const safePurchasedDate = Number.isFinite(purchasedMs) ? new Date(purchasedMs) : now;
      const purchasedAtIso = safePurchasedDate.toISOString();
      const expiresAtIso = new Date(
        safePurchasedDate.getTime() + LOUNGE_CREDIT_LOT_VALIDITY_DAYS * DAY_MS,
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
      const summary = summarizeActiveCreditLots(nextActiveLots, now.getTime());
      const nextTotal = lazy.subscription.dailyRemainingTurns + summary.purchasedRemainingTurns;

      const updatedSub: LoungeSubscriptionDoc = {
        ...lazy.subscription,
        billingCurrency: lazy.subscription.billingCurrency ?? currency,
        stripeCustomerId: session.customerId || lazy.subscription.stripeCustomerId,
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
      tx.set(subRef, updatedSub);
      for (const exp of lazy.expiredLots) {
        tx.set(this.collections.loungeCreditLots.doc(exp.id), exp);
      }
      for (const l of [...lazy.ledgerEntries, grantLedger]) {
        tx.set(this.collections.loungeQuotaLedger.doc(l.id), l);
      }

      if (productId === 'TRIAL_TICKET_100') {
        const activeHash = computeActiveTrialGrantHash(user.xUserId, this.config.trialHmacKeyring);
        const existingActiveSnap = grantSnaps.find((s) => s.id === activeHash.hash)?.data();
        const grantDoc: LoungeTrialGrantDoc = {
          xUserIdHash: activeHash.hash,
          keyVersion: activeHash.keyVersion,
          riskStatus: existingActiveSnap?.riskStatus ?? 'OK',
          ...(existingGrants.find((g) => Boolean(g.welcomeBonusGrantedAt))?.welcomeBonusGrantedAt
            ? {
                welcomeBonusGrantedAt: existingGrants.find((g) => Boolean(g.welcomeBonusGrantedAt))
                  ?.welcomeBonusGrantedAt,
              }
            : {}),
          trialTicketGrantedAt: nowIso,
          retainUntil:
            existingActiveSnap?.retainUntil ??
            new Date(now.getTime() + LOUNGE_TRIAL_GRANT_RETENTION_DAYS * DAY_MS).toISOString(),
        };
        tx.set(this.collections.loungeTrialGrants.doc(activeHash.hash), grantDoc);
      }

      if (eventRef && webhookEvent) {
        tx.set(
          eventRef,
          this.buildProcessedEventDoc(webhookEvent.id, webhookEvent.type, uid, session.id, now),
        );
      }

      return { kind: 'APPLIED' as const, sub: updatedSub };
    });

    if (txOutcome.kind === 'TRIAL_RACE_CONFLICT') {
      if (session.paymentIntentId) {
        await this.stripeGateway.createFullRefund({
          paymentIntentId: session.paymentIntentId,
          idempotencyKey: `trial_conflict_refund_${session.id}`,
          reason: 'duplicate',
        });
      }
      if (webhookEvent) {
        await this.collections.loungeProcessedEvents
          .doc(webhookEvent.id)
          .set(this.buildProcessedEventDoc(webhookEvent.id, webhookEvent.type, uid, session.id, now));
      }
      return {
        subscription: txOutcome.sub,
        applied: false,
        autoRefundedConflict: true,
      };
    }

    if (txOutcome.kind === 'NOOP_WITHDRAWN' || txOutcome.kind === 'NOOP_ALREADY_PROCESSED') {
      const safeSub = txOutcome.sub ?? this.buildEmptySubscription(uid, nowIso);
      return {
        subscription: safeSub,
        applied: false,
        autoRefundedConflict: false,
      };
    }

    return {
      subscription: txOutcome.sub,
      applied: txOutcome.kind === 'APPLIED',
      autoRefundedConflict: false,
    };
  }

  /** Creates a single-use Stripe Customer Portal URL with `flow_data` deep-linking (`POST /billing/portal`). */
  public async createPortalSession(
    uid: string,
    request: LoungeCreatePortalRequestDto,
  ): Promise<LoungeCreatePortalResponseDto> {
    const validated = parseAndValidatePortalRequest(request);
    const { sub } = await this.requireActiveUserAndSub(uid);

    if (!sub.stripeCustomerId?.startsWith('cus_')) {
      throw new LoungeNotFoundError('No Stripe customer record exists yet for this account');
    }
    if (
      validated.flow === 'subscription_cancel' &&
      (!sub.stripeSubscriptionId ||
        (sub.status !== 'ACTIVE' && sub.status !== 'PAST_DUE'))
    ) {
      throw new LoungeConflictError('No active or past-due subscription eligible for cancellation');
    }

    const created = await this.stripeGateway.createPortalSession({
      customerId: sub.stripeCustomerId,
      returnUrl: `${this.config.loungePublicOrigin}/?portal_return=1`,
      flow: validated.flow,
      subscriptionId: sub.stripeSubscriptionId,
      configurationId: this.config.stripePortalConfigurationId,
    });
    return { portalUrl: created.url };
  }

  /** Returns sanitized subscription status, FIFO lot breakdown, and 14d expiration warning (`GET /billing/subscription`). */
  public async getSubscriptionDetail(
    uid: string,
    options: { readonly portalReturn?: boolean; readonly isEeaResident?: boolean } = {},
  ): Promise<LoungeSubscriptionDetailResponseDto> {
    const { user, sub: existingSub } = await this.requireActiveUserAndSub(uid);

    // On ?portal_return=1 refresh subscription status once from Stripe before projecting DTO (zero polling)
    if (options.portalReturn && existingSub.stripeSubscriptionId) {
      try {
        const snapshot = await this.stripeGateway.retrieveSubscription(
          existingSub.stripeSubscriptionId,
        );
        await this.syncSubscriptionSnapshotTx(uid, snapshot, user.timezone);
      } catch (err) {
        loungeLogger.warn('Single-shot portal_return Stripe sync failed cleanly (using Firestore state)', {
          reason: sanitizeLogInput(err instanceof Error ? err.message : String(err)),
        });
      }
    }

    const synced = await this.firestore.runTransaction(async (tx: Transaction) => {
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
        user.timezone,
      );
      if (evaluation.mutated) {
        tx.set(subRef, evaluation.subscription);
        for (const exp of evaluation.expiredLots) {
          tx.set(this.collections.loungeCreditLots.doc(exp.id), exp);
        }
        for (const l of evaluation.ledgerEntries) {
          tx.set(this.collections.loungeQuotaLedger.doc(l.id), l);
        }
      }
      return { sub: evaluation.subscription, activeLots: evaluation.activeLots };
    });

    const publicSub = toPublicLoungeSubscription(synced.sub);
    const { quotaBreakdown, expiringSoonWarning } = buildQuotaBreakdownAndWarning(
      publicSub,
      synced.activeLots,
      this.config.phase2EeaEnabled && (user.isEeaResident ?? options.isEeaResident ?? false),
    );

    return {
      subscription: publicSub,
      quotaBreakdown,
      ...(expiringSoonWarning ? { expiringSoonWarning } : {}),
    };
  }

  /** Phase 2 EEA statutory 14-day electronic withdrawal (`POST /billing/eu-withdrawal`). */
  public async withdrawEuContract(
    uid: string,
    request: LoungeEuWithdrawalRequestDto,
    clientGeo: ResolvedClientGeo,
  ): Promise<LoungeEuWithdrawalResponseDto> {
    const validated = parseAndValidateEuWithdrawalRequest(request);
    const { user, sub } = await this.requireActiveUserAndSub(uid);
    const isEea = user.isEeaResident ?? clientGeo.isEeaResident;

    if (!this.config.phase2EeaEnabled || !isEea) {
      throw new LoungeHttpError(403, 'Statutory EEA withdrawal is only enabled in Phase 2 EEA regions', {
        code: 'EU_WITHDRAWAL_UNAVAILABLE',
      });
    }

    const now = new Date();
    const currency: LoungeCurrency = sub.billingCurrency ?? user.preferredCurrency ?? 'USD';

    if (validated.targetType === 'CREDIT_LOT') {
      const lotSnap = await this.collections.loungeCreditLots.doc(validated.targetId).get();
      const lot = lotSnap.data();
      if (!lotSnap.exists || !lot || lot.uid !== uid || !lot.isPaid) {
        throw new LoungeNotFoundError('Eligible paid credit lot not found');
      }
      if (now.getTime() - Date.parse(lot.purchasedAt) > 14 * DAY_MS || lot.remainingTurns <= 0) {
        throw new LoungeConflictError('14-day withdrawal window expired or credit lot exhausted');
      }
      const refundMinor = Math.max(
        1,
        Math.round((lot.unitAmount * lot.remainingTurns) / lot.initialTurns),
      );
      if (lot.stripePaymentIntentId) {
        await this.stripeGateway.createFullRefund({
          paymentIntentId: lot.stripePaymentIntentId,
          idempotencyKey: `eu_withdraw_lot_${lot.id}`,
          reason: 'requested_by_customer',
          amountMinor: refundMinor,
        });
      }
      const revokedTurns = lot.remainingTurns;
      const updatedSub = await this.firestore.runTransaction(async (tx: Transaction) => {
        const subRef = this.collections.loungeSubscriptions.doc(uid);
        const [txSubSnap, activeLotsSnap] = await Promise.all([
          tx.get(subRef),
          tx.get(this.collections.loungeCreditLots.where('uid', '==', uid).where('status', '==', 'ACTIVE')),
        ]);
        const latestSub = txSubSnap.data() ?? sub;
        const revokedLot: LoungeCreditLotDoc = { ...lot, remainingTurns: 0, status: 'REVOKED' };
        const remainingActive = activeLotsSnap.docs
          .map((d) => (d.id === lot.id ? revokedLot : d.data()))
          .filter((l) => l.status === 'ACTIVE');
        const summary = summarizeActiveCreditLots(remainingActive, now.getTime());
        const nextTotal = latestSub.dailyRemainingTurns + summary.purchasedRemainingTurns;
        const nextSub: LoungeSubscriptionDoc = {
          ...latestSub,
          purchasedRemainingTurns: summary.purchasedRemainingTurns,
          earliestLotExpiresAt: summary.earliestLotExpiresAt,
          remainingChatTurns: nextTotal,
          updatedAt: now.toISOString(),
        };
        tx.set(this.collections.loungeCreditLots.doc(lot.id), revokedLot);
        tx.set(subRef, nextSub);
        const ledger = createQuotaLedgerEntry({
          uid,
          deltaType: 'REFUND_CLAWBACK',
          deltaDaily: 0,
          deltaPurchased: -revokedTurns,
          balanceTotalAfter: nextTotal,
          lotId: lot.id,
          referenceId: `eu_withdraw_${lot.id}`,
          now,
        });
        tx.set(this.collections.loungeQuotaLedger.doc(ledger.id), ledger);
        return nextSub;
      });

      return {
        withdrawnAt: now.toISOString(),
        refundedAmountMinor: refundMinor,
        currency,
        revokedTurns,
        receiptEmailDispatched: true,
        subscription: toPublicLoungeSubscription(updatedSub),
      };
    }

    if (!sub.stripeSubscriptionId || sub.stripeSubscriptionId !== validated.targetId) {
      throw new LoungeNotFoundError('Matching active subscription not found for EEA withdrawal');
    }
    await this.stripeGateway.cancelSubscriptionImmediately(sub.stripeSubscriptionId);
    const updatedSub = await this.firestore.runTransaction(async (tx: Transaction) => {
      const subRef = this.collections.loungeSubscriptions.doc(uid);
      const lotsSnap = await tx.get(
        this.collections.loungeCreditLots.where('uid', '==', uid).where('status', '==', 'ACTIVE'),
      );
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
      return transitioned.subscription;
    });

    return {
      withdrawnAt: now.toISOString(),
      refundedAmountMinor: LOUNGE_PRODUCT_CATALOG_SPECS[currency].STANDARD_MONTHLY.unitAmountMinor,
      currency,
      revokedTurns: Math.max(0, sub.dailyRemainingTurns - updatedSub.dailyRemainingTurns),
      receiptEmailDispatched: true,
      subscription: toPublicLoungeSubscription(updatedSub),
    };
  }

  /** Queries Stripe Charges directly and joins `lounge_credit_lots` balances via `(uid, stripePaymentIntentId)`. */
  public async listOrders(
    uid: string,
    query: { readonly limit: number; readonly startingAfter?: string },
  ): Promise<LoungeBillingOrdersResponseDto> {
    const { sub } = await this.requireActiveUserAndSub(uid);
    if (!sub.stripeCustomerId?.startsWith('cus_')) {
      return { orders: [], nextCursor: null, hasMore: false };
    }

    const { charges, hasMore } = await this.stripeGateway.listCharges({
      customerId: sub.stripeCustomerId,
      limit: query.limit,
      startingAfter: query.startingAfter,
    });

    if (charges.length === 0) {
      return { orders: [], nextCursor: null, hasMore: false };
    }

    const piIds = Array.from(
      new Set(
        charges
          .map((c) => c.paymentIntentId)
          .filter((pi): pi is string => typeof pi === 'string' && pi.length > 0),
      ),
    ).slice(0, 30);

    const lotByPi = new Map<string, LoungeCreditLotDoc>();
    if (piIds.length > 0) {
      const scoped = createUserScopedLoungeDb(
        this.collections as Parameters<typeof createUserScopedLoungeDb>[0],
        uid,
      );
      const lotsSnap = await scoped
        .creditLotsQuery()
        .where('stripePaymentIntentId', 'in', piIds)
        .get();
      for (const doc of lotsSnap.docs) {
        const lot = doc.data();
        if (lot.stripePaymentIntentId) {
          lotByPi.set(lot.stripePaymentIntentId, lot);
        }
      }
    }

    const orders: LoungeBillingOrderItemDto[] = charges.map((charge) => {
      const lot = charge.paymentIntentId ? lotByPi.get(charge.paymentIntentId) : undefined;
      const metaProduct = PURCHASABLE_PRODUCT_IDS.find((p) => p === charge.metadata['productId']);
      const productId = lot?.productId ?? metaProduct ?? 'UNKNOWN';
      const status = resolveOrderStatusFromCharge(charge, lot?.status);
      const safeLotProductId =
        productId === 'WELCOME_BONUS_20' ? 'UNKNOWN' : productId;

      return {
        chargeId: charge.id,
        productId: safeLotProductId,
        status,
        amountMinor: charge.amount,
        refundedAmountMinor: charge.amountRefunded,
        currency: charge.currency,
        createdAt: charge.createdIso,
        receiptAvailable:
          charge.status === 'succeeded' &&
          typeof charge.receiptUrl === 'string' &&
          STRIPE_RECEIPT_URL_PATTERN.test(charge.receiptUrl),
        ...(lot
          ? {
              remainingTurns: lot.remainingTurns,
              initialTurns: lot.initialTurns,
              lotStatus: lot.status,
              expiresAt: lot.expiresAt,
            }
          : {}),
      };
    });

    const nextCursor = hasMore && orders.length > 0 ? orders[orders.length - 1].chargeId : null;
    return { orders, nextCursor, hasMore };
  }

  /**
   * Resolves an ownership-verified Stripe hosted receipt URL (`GET /billing/orders/:chargeId/receipt`).
   * Rejects missing `cus_...` customer ownership immediately to prevent shared-account cross-tenant access.
   */
  public async getOrderReceipt(
    uid: string,
    chargeId: string,
  ): Promise<LoungeBillingReceiptResponseDto> {
    if (!CHARGE_ID_PATTERN.test(chargeId)) {
      throw new LoungeValidationError('Invalid Stripe Charge ID format');
    }
    const { sub } = await this.requireActiveUserAndSub(uid);
    if (!sub.stripeCustomerId?.startsWith('cus_')) {
      throw new LoungeNotFoundError('No Stripe customer account associated with user');
    }

    const charge = await this.stripeGateway.retrieveCharge(chargeId);
    if (charge.customerId !== sub.stripeCustomerId || charge.status !== 'succeeded') {
      throw new LoungeNotFoundError('Order charge not found for authenticated account');
    }
    if (!charge.receiptUrl || !STRIPE_RECEIPT_URL_PATTERN.test(charge.receiptUrl)) {
      throw new LoungeNotFoundError('Receipt URL is not available for this order');
    }
    return { receiptUrl: charge.receiptUrl };
  }

  /**
   * Verifies `stripe-signature` on raw request Buffer and processes all 7 billing webhook events idempotently.
   */
  public async handleStripeWebhook(
    rawBody: Buffer,
    signatureHeader: string,
  ): Promise<{ readonly received: true; readonly ignored?: boolean }> {
    const secret =
      this.config.stripeWebhookSecret ??
      (this.config.isProd ? undefined : 'whsec_local_test_fallback');
    if (!secret) {
      throw new Error('STRIPE_WEBHOOK_SECRET is required in production');
    }

    const event = this.stripeGateway.constructWebhookEvent(rawBody, signatureHeader, secret);
    const now = new Date();

    const existingEventSnap = await this.collections.loungeProcessedEvents.doc(event.id).get();
    if (existingEventSnap.exists) {
      return { received: true, ignored: true };
    }

    if (event.type === 'checkout.session.completed') {
      const sessionId = typeof event.dataObject['id'] === 'string' ? event.dataObject['id'] : '';
      if (!SESSION_ID_PATTERN.test(sessionId)) {
        return { received: true, ignored: true };
      }
      const session = await this.stripeGateway.retrieveCheckoutSession(sessionId);
      if (session.paymentStatus === 'unpaid') {
        return { received: true, ignored: true };
      }
      await this.fulfillCheckoutSession(session, DEFAULT_LOUNGE_TIMEZONE, {
        id: event.id,
        type: event.type,
      });
      return { received: true };
    }

    if (event.type === 'invoice.paid') {
      const invoiceId = typeof event.dataObject['id'] === 'string' ? event.dataObject['id'] : '';
      const subId = extractSubscriptionIdFromInvoiceObj(event.dataObject);
      if (!invoiceId || !subId) {
        return { received: true, ignored: true };
      }
      const stripeSub = await this.stripeGateway.retrieveSubscription(subId);
      if (stripeSub.status !== 'active' && stripeSub.status !== 'trialing') {
        return { received: true, ignored: true };
      }
      await this.handleInvoicePaidTx(event.id, event.type, invoiceId, stripeSub, now);
      return { received: true };
    }

    if (event.type === 'invoice.payment_failed') {
      const subId = extractSubscriptionIdFromInvoiceObj(event.dataObject);
      if (!subId) {
        return { received: true, ignored: true };
      }
      const stripeSub = await this.stripeGateway.retrieveSubscription(subId);
      await this.handleSubscriptionLifecycleTx(event.id, event.type, stripeSub, 'PAST_DUE', now);
      return { received: true };
    }

    if (
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted'
    ) {
      const subId = typeof event.dataObject['id'] === 'string' ? event.dataObject['id'] : '';
      if (!subId) {
        return { received: true, ignored: true };
      }
      const stripeSub = await this.stripeGateway.retrieveSubscription(subId);
      const targetStatus: LoungeSubscriptionStatus =
        event.type === 'customer.subscription.deleted' ||
        stripeSub.status === 'canceled' ||
        stripeSub.status === 'unpaid' ||
        stripeSub.status === 'incomplete_expired'
          ? 'CANCELED'
          : stripeSub.status === 'past_due'
            ? 'PAST_DUE'
            : stripeSub.cancelAtPeriodEnd
              ? 'CANCELING'
              : 'ACTIVE';
      await this.handleSubscriptionLifecycleTx(
        event.id,
        event.type,
        stripeSub,
        targetStatus,
        now,
      );
      return { received: true };
    }

    if (event.type === 'charge.refunded') {
      await this.handleChargeRefundedWebhook(event.id, event.type, event.dataObject, now);
      return { received: true };
    }

    if (event.type === 'charge.dispute.created') {
      await this.handleChargeDisputeCreatedWebhook(event.id, event.type, event.dataObject, now);
      return { received: true };
    }

    return { received: true, ignored: true };
  }

  private async findUidByStripeCustomerOrSubscription(
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

  private async syncSubscriptionSnapshotTx(
    uid: string,
    snapshot: Awaited<ReturnType<ILoungeStripeGatewayPort['retrieveSubscription']>>,
    timezone: string,
  ): Promise<void> {
    const now = new Date();
    const targetStatus: LoungeSubscriptionStatus =
      snapshot.status === 'canceled' ||
      snapshot.status === 'unpaid' ||
      snapshot.status === 'incomplete_expired'
        ? 'CANCELED'
        : snapshot.status === 'past_due'
          ? 'PAST_DUE'
          : snapshot.cancelAtPeriodEnd
            ? 'CANCELING'
            : 'ACTIVE';
    const targetTier: LoungeSubscriptionTier =
      targetStatus === 'ACTIVE' || targetStatus === 'CANCELING' ? 'STANDARD' : 'FREE';

    await this.firestore.runTransaction(async (tx: Transaction) => {
      const subRef = this.collections.loungeSubscriptions.doc(uid);
      const [subSnap, lotsSnap] = await Promise.all([
        tx.get(subRef),
        tx.get(this.collections.loungeCreditLots.where('uid', '==', uid).where('status', '==', 'ACTIVE')),
      ]);
      const currentSub = subSnap.data();
      if (!subSnap.exists || !currentSub) {
        return;
      }
      const transitioned = applySubscriptionTransition(
        currentSub,
        lotsSnap.docs.map((d) => d.data()),
        timezone,
        targetTier,
        targetStatus,
        now,
        {
          currentPeriodEnd: snapshot.currentPeriodEndIso,
          cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
          ...(snapshot.scheduleId ? { stripeScheduleId: snapshot.scheduleId } : {}),
        },
      );
      tx.set(subRef, transitioned.subscription);
      for (const exp of transitioned.expiredLots) {
        tx.set(this.collections.loungeCreditLots.doc(exp.id), exp);
      }
      for (const l of transitioned.ledgerEntries) {
        tx.set(this.collections.loungeQuotaLedger.doc(l.id), l);
      }
    });
  }

  private async handleInvoicePaidTx(
    eventId: string,
    eventType: string,
    invoiceId: string,
    stripeSub: Awaited<ReturnType<ILoungeStripeGatewayPort['retrieveSubscription']>>,
    now: Date,
  ): Promise<void> {
    const uid = await this.findUidByStripeCustomerOrSubscription(stripeSub.customerId, stripeSub.id);
    if (!uid) {
      await this.collections.loungeProcessedEvents
        .doc(eventId)
        .set(this.buildProcessedEventDoc(eventId, eventType, undefined, invoiceId, now));
      return;
    }

    await this.firestore.runTransaction(async (tx: Transaction) => {
      const eventRef = this.collections.loungeProcessedEvents.doc(eventId);
      const userRef = this.collections.loungeUsers.doc(uid);
      const subRef = this.collections.loungeSubscriptions.doc(uid);
      const [eventSnap, userSnap, subSnap, lotsSnap] = await Promise.all([
        tx.get(eventRef),
        tx.get(userRef),
        tx.get(subRef),
        tx.get(this.collections.loungeCreditLots.where('uid', '==', uid).where('status', '==', 'ACTIVE')),
      ]);

      if (eventSnap.exists) {
        return;
      }
      const user = userSnap.data();
      const sub = subSnap.data();
      if (!userSnap.exists || !user || user.status === 'DELETING' || !subSnap.exists || !sub) {
        tx.set(eventRef, this.buildProcessedEventDoc(eventId, eventType, uid, invoiceId, now));
        return;
      }

      const isMatchingSub = !sub.stripeSubscriptionId || sub.stripeSubscriptionId === stripeSub.id;
      const incomingPeriodMs = Date.parse(stripeSub.currentPeriodEndIso);
      const currentPeriodMs = Date.parse(sub.currentPeriodEnd);
      const isNewerOrEqualPeriod =
        !Number.isFinite(currentPeriodMs) || incomingPeriodMs >= currentPeriodMs;

      if (!isMatchingSub || !isNewerOrEqualPeriod || sub.lastProcessedInvoiceId === invoiceId) {
        tx.set(eventRef, this.buildProcessedEventDoc(eventId, eventType, uid, invoiceId, now));
        return;
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
      tx.set(subRef, transitioned.subscription);
      for (const exp of transitioned.expiredLots) {
        tx.set(this.collections.loungeCreditLots.doc(exp.id), exp);
      }
      for (const l of transitioned.ledgerEntries) {
        tx.set(this.collections.loungeQuotaLedger.doc(l.id), l);
      }
      tx.set(eventRef, this.buildProcessedEventDoc(eventId, eventType, uid, invoiceId, now));
    });
  }

  private async handleSubscriptionLifecycleTx(
    eventId: string,
    eventType: string,
    stripeSub: Awaited<ReturnType<ILoungeStripeGatewayPort['retrieveSubscription']>>,
    targetStatus: LoungeSubscriptionStatus,
    now: Date,
  ): Promise<void> {
    const uid = await this.findUidByStripeCustomerOrSubscription(stripeSub.customerId, stripeSub.id);
    if (!uid) {
      await this.collections.loungeProcessedEvents
        .doc(eventId)
        .set(this.buildProcessedEventDoc(eventId, eventType, undefined, stripeSub.id, now));
      return;
    }

    const targetTier: LoungeSubscriptionTier =
      targetStatus === 'ACTIVE' || targetStatus === 'CANCELING' ? 'STANDARD' : 'FREE';

    await this.firestore.runTransaction(async (tx: Transaction) => {
      const eventRef = this.collections.loungeProcessedEvents.doc(eventId);
      const userRef = this.collections.loungeUsers.doc(uid);
      const subRef = this.collections.loungeSubscriptions.doc(uid);
      const [eventSnap, userSnap, subSnap, lotsSnap] = await Promise.all([
        tx.get(eventRef),
        tx.get(userRef),
        tx.get(subRef),
        tx.get(this.collections.loungeCreditLots.where('uid', '==', uid).where('status', '==', 'ACTIVE')),
      ]);

      if (eventSnap.exists) {
        return;
      }
      const user = userSnap.data();
      const sub = subSnap.data();
      if (!userSnap.exists || !user || user.status === 'DELETING' || !subSnap.exists || !sub) {
        tx.set(eventRef, this.buildProcessedEventDoc(eventId, eventType, uid, stripeSub.id, now));
        return;
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
      tx.set(subRef, transitioned.subscription);
      for (const exp of transitioned.expiredLots) {
        tx.set(this.collections.loungeCreditLots.doc(exp.id), exp);
      }
      for (const l of transitioned.ledgerEntries) {
        tx.set(this.collections.loungeQuotaLedger.doc(l.id), l);
      }
      tx.set(eventRef, this.buildProcessedEventDoc(eventId, eventType, uid, stripeSub.id, now));
    });
  }

  private async handleChargeRefundedWebhook(
    eventId: string,
    eventType: string,
    chargeObj: Readonly<Record<string, unknown>>,
    now: Date,
  ): Promise<void> {
    const paymentIntentId = readStripeId(chargeObj['payment_intent']);
    const customerId = readStripeId(chargeObj['customer']);
    const amountRefunded =
      typeof chargeObj['amount_refunded'] === 'number' ? chargeObj['amount_refunded'] : 0;
    const amountCaptured =
      typeof chargeObj['amount_captured'] === 'number'
        ? chargeObj['amount_captured']
        : typeof chargeObj['amount'] === 'number'
          ? chargeObj['amount']
          : 0;

    if (amountCaptured <= 0 || amountRefunded < amountCaptured) {
      loungeLogger.warn('Received partial Stripe refund event; skipping auto-revocation', {
        eventId,
        amountRefunded,
        amountCaptured,
      });
      await this.collections.loungeProcessedEvents
        .doc(eventId)
        .set(this.buildProcessedEventDoc(eventId, eventType, undefined, paymentIntentId, now));
      return;
    }

    if (paymentIntentId) {
      const lotQuerySnap = await this.collections.loungeCreditLots
        .where('stripePaymentIntentId', '==', paymentIntentId)
        .limit(1)
        .get();
      if (!lotQuerySnap.empty) {
        const targetLot = lotQuerySnap.docs[0].data();
        await this.revokeLotOnRefundOrDisputeTx(
          eventId,
          eventType,
          targetLot.uid,
          targetLot.id,
          paymentIntentId,
          false,
          now,
        );
        return;
      }

      // Subscription charge refund: verify invoice match against lastProcessedInvoiceId to protect cross-month refunds
      const resolvedInv = await this.stripeGateway.resolveInvoiceByPaymentIntent(paymentIntentId);
      const uid = await this.findUidByStripeCustomerOrSubscription(
        customerId,
        resolvedInv?.subscriptionId,
      );
      if (uid && resolvedInv?.subscriptionId) {
        const subSnap = await this.collections.loungeSubscriptions.doc(uid).get();
        const currentSub = subSnap.data();
        if (
          currentSub &&
          currentSub.lastProcessedInvoiceId === resolvedInv.id &&
          currentSub.stripeSubscriptionId === resolvedInv.subscriptionId
        ) {
          await this.stripeGateway.cancelSubscriptionImmediately(resolvedInv.subscriptionId);
          await this.downgradeSubscriptionOnRefundTx(eventId, eventType, uid, resolvedInv.id, now);
          return;
        }
      }
    }

    await this.collections.loungeProcessedEvents
      .doc(eventId)
      .set(this.buildProcessedEventDoc(eventId, eventType, undefined, paymentIntentId ?? customerId, now));
  }

  private async handleChargeDisputeCreatedWebhook(
    eventId: string,
    eventType: string,
    disputeObj: Readonly<Record<string, unknown>>,
    now: Date,
  ): Promise<void> {
    const paymentIntentId = readStripeId(disputeObj['payment_intent']);
    let targetUid: string | null = null;
    let targetLotId: string | undefined;

    if (paymentIntentId) {
      const lotSnap = await this.collections.loungeCreditLots
        .where('stripePaymentIntentId', '==', paymentIntentId)
        .limit(1)
        .get();
      if (!lotSnap.empty) {
        targetUid = lotSnap.docs[0].data().uid;
        targetLotId = lotSnap.docs[0].id;
      } else {
        const inv = await this.stripeGateway.resolveInvoiceByPaymentIntent(paymentIntentId);
        targetUid = await this.findUidByStripeCustomerOrSubscription(undefined, inv?.subscriptionId);
      }
    }

    if (!targetUid) {
      await this.collections.loungeProcessedEvents
        .doc(eventId)
        .set(this.buildProcessedEventDoc(eventId, eventType, undefined, paymentIntentId, now));
      return;
    }

    const subSnap = await this.collections.loungeSubscriptions.doc(targetUid).get();
    const sub = subSnap.data();
    if (sub?.stripeSubscriptionId) {
      await this.stripeGateway.cancelSubscriptionImmediately(sub.stripeSubscriptionId);
    }

    await this.revokeLotOnRefundOrDisputeTx(
      eventId,
      eventType,
      targetUid,
      targetLotId,
      paymentIntentId ?? eventId,
      true,
      now,
    );
  }

  private async revokeLotOnRefundOrDisputeTx(
    eventId: string,
    eventType: string,
    uid: string,
    lotId: string | undefined,
    referenceId: string,
    isDispute: boolean,
    now: Date,
  ): Promise<void> {
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
        tx.get(this.collections.loungeCreditLots.where('uid', '==', uid).where('status', '==', 'ACTIVE')),
      ]);

      if (eventSnap.exists) {
        return;
      }
      const user = userSnap.data();
      const sub = subSnap.data();
      if (!userSnap.exists || !user || user.status === 'DELETING' || !subSnap.exists || !sub) {
        tx.set(eventRef, this.buildProcessedEventDoc(eventId, eventType, uid, referenceId, now));
        return;
      }

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

      if (isDispute) {
        tx.set(userRef, { ...user, status: 'SUSPENDED', updatedAt: nowIso });
        const activeHash = computeActiveTrialGrantHash(user.xUserId, this.config.trialHmacKeyring);
        tx.set(this.collections.loungeTrialGrants.doc(activeHash.hash), {
          xUserIdHash: activeHash.hash,
          keyVersion: activeHash.keyVersion,
          riskStatus: 'DISPUTE_BLOCKED',
          retainUntil: new Date(now.getTime() + LOUNGE_TRIAL_GRANT_RETENTION_DAYS * DAY_MS).toISOString(),
        });
      }

      tx.set(eventRef, this.buildProcessedEventDoc(eventId, eventType, uid, referenceId, now));
    });
  }

  private async downgradeSubscriptionOnRefundTx(
    eventId: string,
    eventType: string,
    uid: string,
    invoiceId: string,
    now: Date,
  ): Promise<void> {
    await this.firestore.runTransaction(async (tx: Transaction) => {
      const eventRef = this.collections.loungeProcessedEvents.doc(eventId);
      const userRef = this.collections.loungeUsers.doc(uid);
      const subRef = this.collections.loungeSubscriptions.doc(uid);
      const [eventSnap, userSnap, subSnap, lotsSnap] = await Promise.all([
        tx.get(eventRef),
        tx.get(userRef),
        tx.get(subRef),
        tx.get(this.collections.loungeCreditLots.where('uid', '==', uid).where('status', '==', 'ACTIVE')),
      ]);

      if (eventSnap.exists) {
        return;
      }
      const user = userSnap.data();
      const sub = subSnap.data();
      if (!userSnap.exists || !user || user.status === 'DELETING' || !subSnap.exists || !sub) {
        tx.set(eventRef, this.buildProcessedEventDoc(eventId, eventType, uid, invoiceId, now));
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
      tx.set(eventRef, this.buildProcessedEventDoc(eventId, eventType, uid, invoiceId, now));
    });
  }

  private buildProcessedEventDoc(
    eventId: string,
    eventType: string,
    uid: string | undefined,
    targetId: string | undefined,
    now: Date,
  ): LoungeProcessedEventDoc {
    return {
      eventId,
      eventType,
      ...(uid ? { uid } : {}),
      ...(targetId ? { targetId } : {}),
      processedAt: now.toISOString(),
      expireAt: new Date(now.getTime() + LOUNGE_PROCESSED_EVENT_TTL_DAYS * DAY_MS).toISOString(),
    };
  }

  private buildEmptySubscription(uid: string, nowIso: string): LoungeSubscriptionDoc {
    return {
      uid,
      tier: 'FREE',
      status: 'CANCELED',
      dailyTurnQuota: 5,
      dailyRemainingTurns: 0,
      purchasedRemainingTurns: 0,
      remainingChatTurns: 0,
      earliestLotExpiresAt: null,
      lastDailyResetAt: nowIso,
      lastQuotaResetTimezone: DEFAULT_LOUNGE_TIMEZONE,
      nextDailyResetAt: nowIso,
      currentPeriodEnd: nowIso,
      trialTicketUsed: false,
      cancelAtPeriodEnd: false,
      todaysConsumedDailyTurns: 0,
      updatedAt: nowIso,
    };
  }
}

function readStripeId(raw: unknown): string | undefined {
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.trim();
  }
  if (typeof raw === 'object' && raw !== null && 'id' in raw) {
    const id = (raw as { readonly id?: unknown }).id;
    return typeof id === 'string' && id.trim().length > 0 ? id.trim() : undefined;
  }
  return undefined;
}

function extractSubscriptionIdFromInvoiceObj(
  invoiceObj: Readonly<Record<string, unknown>>,
): string | undefined {
  const parent = invoiceObj['parent'];
  if (typeof parent === 'object' && parent !== null && 'subscription_details' in parent) {
    const subDetails = (parent as { readonly subscription_details?: unknown }).subscription_details;
    if (typeof subDetails === 'object' && subDetails !== null && 'subscription' in subDetails) {
      const subId = readStripeId((subDetails as { readonly subscription?: unknown }).subscription);
      if (subId) {
        return subId;
      }
    }
  }
  return readStripeId(invoiceObj['subscription']);
}

function resolveOrderStatusFromCharge(
  charge: LoungeStripeChargeRecord,
  lotStatus?: LoungeCreditLotStatus,
): LoungeOrderStatus {
  if (charge.disputed || lotStatus === 'REVOKED') {
    return 'DISPUTED';
  }
  if (charge.refunded || (charge.amount > 0 && charge.amountRefunded >= charge.amount)) {
    return 'REFUNDED';
  }
  if (charge.amountRefunded > 0) {
    return 'PARTIAL_REFUNDED';
  }
  if (charge.status === 'failed') {
    return 'FAILED';
  }
  if (charge.status === 'pending') {
    return 'PENDING';
  }
  return 'COMPLETED';
}

export type { LoungeSubscription };
