import {
  toPublicLoungeSubscription,
  type LoungeCreateCheckoutRequestDto,
  type LoungeCreateCheckoutResponseDto,
  type LoungeCreatePortalRequestDto,
  type LoungeCreatePortalResponseDto,
  type LoungeSubscriptionDoc,
  type LoungeVerifyCheckoutResponseDto,
} from '@rebecca/types';
import {
  assertGeoEligibleForPhase,
  type ResolvedClientGeo,
} from '../../../utils/clientGeo';
import {
  LoungeAuthError,
  LoungeConflictError,
  LoungeNotFoundError,
  LoungeValidationError,
} from '../../../utils/errors';
import { loungeLogger } from '../../../utils/logger';
import {
  PURCHASABLE_PRODUCT_IDS,
  SESSION_ID_PATTERN,
  buildEmptySubscription,
  buildProcessedEventDoc,
  evaluateTrialEligibility,
  maskCheckoutSessionId,
  requireActiveUserAndSubscription,
  resolveBillingCurrency,
  type LoungeBillingUseCaseConfig,
} from '../domain/loungeBilling.helpers';
import { LOUNGE_PRODUCT_CATALOG_SPECS } from '../domain/loungeCatalog.constants';
import type {
  ILoungeStripeGatewayPort,
  LoungeStripeCheckoutSession,
} from '../ports/loungeStripe.port';
import type { ILoungeBillingRepository } from '../repositories/loungeBilling.repository';
import {
  parseAndValidateCreateCheckoutRequest,
  parseAndValidatePortalRequest,
} from '../validators/loungeBilling.validator';

/**
 * Use case handling Stripe Checkout Session creation, Customer Portal session deep-linking,
 * synchronous checkout verification, and shared idempotent checkout fulfillment.
 */
export class LoungeBillingCheckoutUseCase {
  constructor(
    private readonly billingRepository: ILoungeBillingRepository,
    private readonly stripeGateway: ILoungeStripeGatewayPort,
    private readonly config: LoungeBillingUseCaseConfig,
  ) {}

  /** Creates a Stripe Checkout Session for a pre-created Customer (`POST /billing/checkout`). */
  public async createCheckoutSession(
    uid: string,
    request: LoungeCreateCheckoutRequestDto,
    clientGeo: ResolvedClientGeo,
    traceHeader?: string,
  ): Promise<LoungeCreateCheckoutResponseDto> {
    const validated = parseAndValidateCreateCheckoutRequest(request);
    const { user, sub } = await requireActiveUserAndSubscription(this.billingRepository, uid);

    assertGeoEligibleForPhase(
      clientGeo,
      {
        phase2EeaEnabled: this.config.phase2EeaEnabled,
        allowDefaultGeoFallback: this.config.allowDefaultGeoFallback,
      },
      user.isEeaResident,
    );

    const isEeaResident = Boolean(user.isEeaResident || clientGeo.isEeaResident);
    const countryCode = user.countryCode ?? clientGeo.countryCode;
    const { currency } = resolveBillingCurrency(
      user.preferredCurrency,
      sub.billingCurrency,
      clientGeo,
    );
    const spec = LOUNGE_PRODUCT_CATALOG_SPECS[currency][validated.productId];
    const priceId = this.config.stripePriceIds[currency][validated.productId]?.trim();
    if (this.stripeGateway.isConfigured === false || !priceId) {
      throw new LoungeConflictError('This plan or ticket is currently in preparation', {
        code: 'COMING_SOON',
      });
    }

    if (validated.productId === 'TRIAL_TICKET_100') {
      const eligibility = await evaluateTrialEligibility(
        this.billingRepository,
        this.config.trialHmacKeyring,
        user.xUserId,
        sub,
        Date.now(),
      );
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

    const { customerId } = await this.stripeGateway.ensureCustomer({
      existingCustomerId: sub.stripeCustomerId,
      uid,
      xHandle: user.xHandle,
      countryCode,
    });

    if (sub.stripeCustomerId !== customerId || !sub.billingCurrency || !user.preferredCurrency) {
      await this.billingRepository.saveCustomerAndCurrencyIfMissing({
        uid,
        customerId,
        currency,
        countryCode,
        isEeaResident,
        nowIso: new Date().toISOString(),
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
      enableInvoiceCreation:
        this.config.phase2EeaEnabled && isEeaResident && spec.mode === 'payment',
      submitMessage,
      metadata,
    });

    const sessionIdMasked = maskCheckoutSessionId(session.id);
    loungeLogger.info(
      'Created Private Lounge Stripe Checkout Session',
      {
        uid,
        productId: validated.productId,
        currency,
        sessionIdMasked,
      },
      traceHeader,
    );

    return {
      checkoutUrl: session.url,
      sessionIdMasked,
    };
  }

  /**
   * Immediately verifies a completed Checkout Session after redirect (`POST /billing/checkout/verify`)
   * using the same atomic grant & trial race-refund transaction as the webhook handler.
   */
  public async verifyCheckoutSession(
    uid: string,
    sessionId: string,
    traceHeader?: string,
  ): Promise<LoungeVerifyCheckoutResponseDto> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new LoungeValidationError('Invalid Stripe Checkout Session ID');
    }
    const { sub } = await requireActiveUserAndSubscription(this.billingRepository, uid);
    const session = await this.stripeGateway.retrieveCheckoutSession(sessionId);

    if (session.metadata['uid'] !== uid) {
      throw new LoungeAuthError(403, 'Checkout session does not belong to authenticated user');
    }
    if (!sub.stripeCustomerId || !session.customerId || session.customerId !== sub.stripeCustomerId) {
      throw new LoungeAuthError(403, 'Checkout session customer mismatch');
    }
    if (session.paymentStatus === 'unpaid') {
      return {
        subscription: toPublicLoungeSubscription(sub),
        verified: false,
      };
    }

    const granted = await this.fulfillCheckoutSession(session, undefined, traceHeader);
    return {
      subscription: toPublicLoungeSubscription(granted.subscription),
      verified: granted.applied,
      ...(granted.autoRefundedConflict ? { autoRefundedConflict: true } : {}),
    };
  }

  /** Creates a single-use Stripe Customer Portal URL with `flow_data` deep-linking (`POST /billing/portal`). */
  public async createPortalSession(
    uid: string,
    request: LoungeCreatePortalRequestDto,
  ): Promise<LoungeCreatePortalResponseDto> {
    const validated = parseAndValidatePortalRequest(request);
    const { sub } = await requireActiveUserAndSubscription(this.billingRepository, uid);

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

  /** Shared idempotent fulfillment logic for Checkout Verify and `checkout.session.completed` webhook. */
  public async fulfillCheckoutSession(
    session: LoungeStripeCheckoutSession,
    webhookEvent?: { readonly id: string; readonly type: string },
    traceHeader?: string,
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
    const txOutcome = await this.billingRepository.fulfillCheckoutSessionTx({
      uid,
      productId,
      session,
      stripeSubSnapshot,
      trialHmacKeyring: this.config.trialHmacKeyring,
      webhookEvent,
      now,
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
        await this.billingRepository.recordProcessedEvent(
          buildProcessedEventDoc(webhookEvent.id, webhookEvent.type, uid, session.id, now),
        );
      }
      loungeLogger.warn(
        'Auto-refunded duplicate TRIAL_TICKET_100 checkout race',
        {
          uid,
          sessionIdMasked: maskCheckoutSessionId(session.id),
          ...(webhookEvent ? { eventId: webhookEvent.id } : {}),
        },
        traceHeader,
      );
      return {
        subscription: txOutcome.sub,
        applied: false,
        autoRefundedConflict: true,
      };
    }

    if (txOutcome.kind === 'NOOP_WITHDRAWN' || txOutcome.kind === 'NOOP_ALREADY_PROCESSED') {
      return {
        subscription: txOutcome.sub ?? buildEmptySubscription(uid, nowIso),
        applied: false,
        autoRefundedConflict: false,
      };
    }

    if (txOutcome.kind === 'APPLIED') {
      loungeLogger.info(
        'Fulfilled Private Lounge Checkout Session',
        {
          uid,
          productId,
          currency: session.currency,
          sessionIdMasked: maskCheckoutSessionId(session.id),
          ...(webhookEvent ? { eventId: webhookEvent.id } : {}),
        },
        traceHeader,
      );
    }

    return {
      subscription: txOutcome.sub,
      applied: txOutcome.kind === 'APPLIED',
      autoRefundedConflict: false,
    };
  }
}
