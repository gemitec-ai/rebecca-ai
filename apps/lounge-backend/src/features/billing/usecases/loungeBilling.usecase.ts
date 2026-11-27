import type {
  LoungeBillingCatalogDto,
  LoungeBillingOrdersResponseDto,
  LoungeBillingReceiptResponseDto,
  LoungeCreateCheckoutRequestDto,
  LoungeCreateCheckoutResponseDto,
  LoungeCreatePortalRequestDto,
  LoungeCreatePortalResponseDto,
  LoungeEuWithdrawalRequestDto,
  LoungeEuWithdrawalResponseDto,
  LoungeSubscriptionDetailResponseDto,
  LoungeVerifyCheckoutResponseDto,
} from '@rebecca/types';
import type { ResolvedClientGeo } from '../../../utils/clientGeo';
import {
  maskCheckoutSessionId,
  type LoungeBillingUseCaseConfig,
} from '../domain/loungeBilling.helpers';
import type { ILoungeStripeGatewayPort } from '../ports/loungeStripe.port';
import type { ILoungeBillingRepository } from '../repositories/loungeBilling.repository';
import { LoungeBillingCatalogUseCase } from './loungeBillingCatalog.usecase';
import { LoungeBillingCheckoutUseCase } from './loungeBillingCheckout.usecase';
import { LoungeBillingEuWithdrawalUseCase } from './loungeBillingEuWithdrawal.usecase';
import { LoungeBillingWebhookUseCase } from './loungeBillingWebhook.usecase';

export { maskCheckoutSessionId, type LoungeBillingUseCaseConfig };

/** Use case contract backing all 9 Private Lounge billing endpoints and Stripe webhook ingestion. */
export interface ILoungeBillingUseCase {
  /**
   * Returns server-locked multi-currency catalog entries and per-product eligibility.
   *
   * @throws LoungeForbiddenError When trusted Geo-IP headers are missing in strict mode (`GEO_UNAVAILABLE`).
   * @throws LoungeAuthError When caller profile is missing or inactive.
   */
  getCatalog(uid: string, clientGeo: ResolvedClientGeo): Promise<LoungeBillingCatalogDto>;
  /**
   * Creates a Stripe Hosted Checkout Session for a pre-created Customer.
   *
   * @throws LoungeValidationError When statutory checkboxes or product selection are invalid.
   * @throws LoungeForbiddenError When caller geo fails Phase 1/2 policy (`GEO_BLOCKED` / `GEO_UNAVAILABLE`).
   * @throws LoungeConflictError When product is Coming Soon, Trial already used, or Subscription already active.
   */
  createCheckoutSession(
    uid: string,
    request: LoungeCreateCheckoutRequestDto,
    clientGeo: ResolvedClientGeo,
    traceHeader?: string,
  ): Promise<LoungeCreateCheckoutResponseDto>;
  /**
   * Immediately verifies and atomically fulfills a completed Checkout Session after client redirect.
   *
   * @throws LoungeValidationError When `sessionId` format is invalid.
   * @throws LoungeAuthError When Checkout Session UID or customer mismatches authenticated user.
   */
  verifyCheckoutSession(
    uid: string,
    sessionId: string,
    traceHeader?: string,
  ): Promise<LoungeVerifyCheckoutResponseDto>;
  /**
   * Creates a single-use Stripe Customer Portal URL optionally deep-linked to cancellation/payment update.
   *
   * @throws LoungeNotFoundError When user lacks a Stripe Customer ID (`cus_...`).
   * @throws LoungeConflictError When cancellation flow is requested without an active subscription.
   */
  createPortalSession(
    uid: string,
    request: LoungeCreatePortalRequestDto,
  ): Promise<LoungeCreatePortalResponseDto>;
  /**
   * Returns synchronized subscription quota state, FIFO credit lots, and 14d expiration warnings.
   *
   * @throws LoungeForbiddenError When trusted Geo-IP headers are missing outside emulator mode.
   */
  getSubscriptionDetail(
    uid: string,
    options?: { readonly portalReturn?: boolean; readonly clientGeo?: ResolvedClientGeo },
  ): Promise<LoungeSubscriptionDetailResponseDto>;
  /**
   * Executes statutory Phase 2 EEA 14-day withdrawal with atomic pre-refund reservation and rollback protection.
   *
   * @throws LoungeForbiddenError When Phase 2 EEA withdrawal is disabled or caller is non-EEA.
   * @throws LoungeConflictError When 14d withdrawal window expired or turns have already been consumed.
   * @throws LoungeNotFoundError When target lot or subscription is missing or already revoked.
   */
  withdrawEuContract(
    uid: string,
    request: LoungeEuWithdrawalRequestDto,
    clientGeo: ResolvedClientGeo,
    traceHeader?: string,
  ): Promise<LoungeEuWithdrawalResponseDto>;
  /**
   * Returns cursor-paginated Stripe Charge history enriched with active/revoked credit lot balances.
   *
   * @throws LoungeValidationError When pagination bounds or cursor ID format are invalid.
   */
  listOrders(
    uid: string,
    query: { readonly limit: number; readonly startingAfter?: string },
  ): Promise<LoungeBillingOrdersResponseDto>;
  /**
   * Resolves an ownership-verified hosted Stripe receipt URL for a succeeded charge.
   *
   * @throws LoungeValidationError When `chargeId` format is invalid.
   * @throws LoungeNotFoundError When charge does not belong to user's customer or receipt is unavailable.
   */
  getOrderReceipt(uid: string, chargeId: string): Promise<LoungeBillingReceiptResponseDto>;
  /**
   * Verifies `stripe-signature` on raw request bytes and processes Stripe billing webhooks idempotently.
   *
   * @throws Error When `STRIPE_WEBHOOK_SECRET` is missing.
   * @throws LoungeAuthError When Stripe webhook signature verification fails.
   */
  handleStripeWebhook(
    rawBody: Buffer,
    signatureHeader: string,
    traceHeader?: string,
  ): Promise<{ readonly received: true; readonly ignored?: boolean }>;
}

/**
 * Thin billing coordinator composing focused Catalog, Checkout, EU Withdrawal, and Webhook use cases
 * while preserving the unified `ILoungeBillingUseCase` contract.
 */
export class LoungeBillingUseCase implements ILoungeBillingUseCase {
  private readonly catalogUseCase: LoungeBillingCatalogUseCase;
  private readonly checkoutUseCase: LoungeBillingCheckoutUseCase;
  private readonly euWithdrawalUseCase: LoungeBillingEuWithdrawalUseCase;
  private readonly webhookUseCase: LoungeBillingWebhookUseCase;

  constructor(
    billingRepository: ILoungeBillingRepository,
    stripeGateway: ILoungeStripeGatewayPort,
    config: LoungeBillingUseCaseConfig,
  ) {
    this.catalogUseCase = new LoungeBillingCatalogUseCase(billingRepository, stripeGateway, config);
    this.checkoutUseCase = new LoungeBillingCheckoutUseCase(
      billingRepository,
      stripeGateway,
      config,
    );
    this.euWithdrawalUseCase = new LoungeBillingEuWithdrawalUseCase(
      billingRepository,
      stripeGateway,
      config,
    );
    this.webhookUseCase = new LoungeBillingWebhookUseCase(
      billingRepository,
      stripeGateway,
      this.checkoutUseCase,
      config,
    );
  }

  public getCatalog(uid: string, clientGeo: ResolvedClientGeo): Promise<LoungeBillingCatalogDto> {
    return this.catalogUseCase.getCatalog(uid, clientGeo);
  }

  public createCheckoutSession(
    uid: string,
    request: LoungeCreateCheckoutRequestDto,
    clientGeo: ResolvedClientGeo,
    traceHeader?: string,
  ): Promise<LoungeCreateCheckoutResponseDto> {
    return this.checkoutUseCase.createCheckoutSession(uid, request, clientGeo, traceHeader);
  }

  public verifyCheckoutSession(
    uid: string,
    sessionId: string,
    traceHeader?: string,
  ): Promise<LoungeVerifyCheckoutResponseDto> {
    return this.checkoutUseCase.verifyCheckoutSession(uid, sessionId, traceHeader);
  }

  public createPortalSession(
    uid: string,
    request: LoungeCreatePortalRequestDto,
  ): Promise<LoungeCreatePortalResponseDto> {
    return this.checkoutUseCase.createPortalSession(uid, request);
  }

  public getSubscriptionDetail(
    uid: string,
    options?: { readonly portalReturn?: boolean; readonly clientGeo?: ResolvedClientGeo },
  ): Promise<LoungeSubscriptionDetailResponseDto> {
    return this.catalogUseCase.getSubscriptionDetail(uid, options);
  }

  public withdrawEuContract(
    uid: string,
    request: LoungeEuWithdrawalRequestDto,
    clientGeo: ResolvedClientGeo,
    traceHeader?: string,
  ): Promise<LoungeEuWithdrawalResponseDto> {
    return this.euWithdrawalUseCase.withdrawEuContract(uid, request, clientGeo, traceHeader);
  }

  public listOrders(
    uid: string,
    query: { readonly limit: number; readonly startingAfter?: string },
  ): Promise<LoungeBillingOrdersResponseDto> {
    return this.catalogUseCase.listOrders(uid, query);
  }

  public getOrderReceipt(uid: string, chargeId: string): Promise<LoungeBillingReceiptResponseDto> {
    return this.catalogUseCase.getOrderReceipt(uid, chargeId);
  }

  public handleStripeWebhook(
    rawBody: Buffer,
    signatureHeader: string,
    traceHeader?: string,
  ): Promise<{ readonly received: true; readonly ignored?: boolean }> {
    return this.webhookUseCase.handleStripeWebhook(rawBody, signatureHeader, traceHeader);
  }
}
