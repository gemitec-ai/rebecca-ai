import {
  toPublicLoungeSubscription,
  type LoungeBillingCatalogDto,
  type LoungeBillingOrderItemDto,
  type LoungeBillingOrdersResponseDto,
  type LoungeBillingProductDto,
  type LoungeBillingReceiptResponseDto,
  type LoungeSubscriptionDetailResponseDto,
} from '@rebecca/types';
import type { ResolvedClientGeo } from '../../../utils/clientGeo';
import { LoungeNotFoundError, LoungeValidationError } from '../../../utils/errors';
import { loungeLogger, toSingleLineLog } from '../../../utils/logger';
import {
  CHARGE_ID_PATTERN,
  PURCHASABLE_PRODUCT_IDS,
  STRIPE_RECEIPT_URL_PATTERN,
  assertTrustedBillingGeo,
  evaluateTrialEligibility,
  requireActiveUserAndSubscription,
  resolveBillingCurrency,
  resolveOrderStatusFromCharge,
  type LoungeBillingUseCaseConfig,
} from '../domain/loungeBilling.helpers';
import { LOUNGE_PRODUCT_CATALOG_SPECS } from '../domain/loungeCatalog.constants';
import { buildQuotaBreakdownAndWarning } from '../domain/loungeQuota.engine';
import type { ILoungeStripeGatewayPort } from '../ports/loungeStripe.port';
import type { ILoungeBillingRepository } from '../repositories/loungeBilling.repository';

/**
 * Use case handling read-only Private Lounge catalog, subscription quota projection,
 * cursor-paginated order history, and ownership-verified Stripe receipt retrieval.
 */
export class LoungeBillingCatalogUseCase {
  constructor(
    private readonly billingRepository: ILoungeBillingRepository,
    private readonly stripeGateway: ILoungeStripeGatewayPort,
    private readonly config: LoungeBillingUseCaseConfig,
  ) {}

  /** Returns server-locked multi-currency catalog and purchase eligibility (`GET /billing/catalog`). */
  public async getCatalog(
    uid: string,
    clientGeo: ResolvedClientGeo,
  ): Promise<LoungeBillingCatalogDto> {
    assertTrustedBillingGeo(this.config.allowDefaultGeoFallback, clientGeo);
    const { user, sub } = await requireActiveUserAndSubscription(this.billingRepository, uid);
    const { currency, currencyLocked } = resolveBillingCurrency(
      user.preferredCurrency,
      sub.billingCurrency,
      clientGeo,
    );
    const isEeaResident = Boolean(user.isEeaResident || clientGeo.isEeaResident);
    const countryCode = user.countryCode ?? clientGeo.countryCode;
    const geoBlocked = !this.config.phase2EeaEnabled && isEeaResident;

    const { eligible: trialEligible } = await evaluateTrialEligibility(
      this.billingRepository,
      this.config.trialHmacKeyring,
      user.xUserId,
      sub,
      Date.now(),
    );
    const subAlreadyActive =
      sub.status === 'ACTIVE' || sub.status === 'CANCELING' || sub.status === 'PAST_DUE';

    const specs = LOUNGE_PRODUCT_CATALOG_SPECS[currency];
    const gatewayConfigured = this.stripeGateway.isConfigured !== false;
    const products: LoungeBillingProductDto[] = PURCHASABLE_PRODUCT_IDS.map((productId) => {
      const spec = specs[productId];
      const configuredPriceId = this.config.stripePriceIds[currency][productId];
      const available = gatewayConfigured && Boolean(configuredPriceId?.trim());
      let ineligibleReason: LoungeBillingProductDto['ineligibleReason'];
      if (!available) {
        ineligibleReason = 'COMING_SOON';
      } else if (geoBlocked) {
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
        available,
        eligible: available && !ineligibleReason,
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

  /** Returns sanitized subscription status, FIFO lot breakdown, and 14d expiration warning (`GET /billing/subscription`). */
  public async getSubscriptionDetail(
    uid: string,
    options: { readonly portalReturn?: boolean; readonly clientGeo?: ResolvedClientGeo } = {},
  ): Promise<LoungeSubscriptionDetailResponseDto> {
    assertTrustedBillingGeo(this.config.allowDefaultGeoFallback, options.clientGeo);
    const { user, sub: existingSub } = await requireActiveUserAndSubscription(
      this.billingRepository,
      uid,
    );

    if (options.portalReturn && existingSub.stripeSubscriptionId) {
      try {
        const snapshot = await this.stripeGateway.retrieveSubscription(
          existingSub.stripeSubscriptionId,
        );
        await this.billingRepository.applyStripeSubscriptionSnapshot({
          uid,
          snapshot,
          userTimezone: user.timezone,
          now: new Date(),
        });
      } catch (err) {
        const safeReason = toSingleLineLog(err instanceof Error ? err.message : String(err));
        loungeLogger.warn('Single-shot portal_return Stripe sync failed cleanly (using Firestore state)', {
          reason: safeReason,
        });
      }
    }

    const synced = await this.billingRepository.syncLazySubscriptionState(uid, user.timezone);
    const publicSub = toPublicLoungeSubscription(synced.subscription);
    const { quotaBreakdown, expiringSoonWarning } = buildQuotaBreakdownAndWarning(
      publicSub,
      synced.activeLots,
      this.config.phase2EeaEnabled &&
        Boolean(user.isEeaResident || options.clientGeo?.isEeaResident),
    );

    return {
      subscription: publicSub,
      quotaBreakdown,
      ...(expiringSoonWarning ? { expiringSoonWarning } : {}),
    };
  }

  /** Queries Stripe Charges directly and joins `lounge_credit_lots` balances via `(uid, stripePaymentIntentId)`. */
  public async listOrders(
    uid: string,
    query: { readonly limit: number; readonly startingAfter?: string },
  ): Promise<LoungeBillingOrdersResponseDto> {
    const { sub } = await requireActiveUserAndSubscription(this.billingRepository, uid);
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

    const lotByPi = await this.billingRepository.findCreditLotsByPaymentIntents(uid, piIds);

    const orders: LoungeBillingOrderItemDto[] = charges.map((charge) => {
      const lot = charge.paymentIntentId ? lotByPi.get(charge.paymentIntentId) : undefined;
      const metaProduct = PURCHASABLE_PRODUCT_IDS.find((p) => p === charge.metadata['productId']);
      const productId = lot?.productId ?? metaProduct ?? 'UNKNOWN';
      const status = resolveOrderStatusFromCharge(charge, lot?.status);
      const safeLotProductId = productId === 'WELCOME_BONUS_20' ? 'UNKNOWN' : productId;

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

  /** Resolves an ownership-verified Stripe hosted receipt URL (`GET /billing/orders/:chargeId/receipt`). */
  public async getOrderReceipt(
    uid: string,
    chargeId: string,
  ): Promise<LoungeBillingReceiptResponseDto> {
    if (!CHARGE_ID_PATTERN.test(chargeId)) {
      throw new LoungeValidationError('Invalid Stripe Charge ID format');
    }
    const { sub } = await requireActiveUserAndSubscription(this.billingRepository, uid);
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
}
