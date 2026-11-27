import type {
  LoungeCurrency,
  LoungePortalFlow,
  LoungeProductId,
} from '@rebecca/types';
import type { IStripeCustomerWithdrawalCleanupPort } from '../../account/ports/stripeCustomerCleanup.port';

/** Normalized Stripe Checkout Session payload detached from raw Stripe SDK types. */
export interface LoungeStripeCheckoutSession {
  readonly id: string;
  readonly url: string;
  readonly customerId: string;
  readonly mode: 'payment' | 'subscription';
  readonly paymentStatus: 'paid' | 'unpaid' | 'no_payment_required';
  readonly paymentIntentId?: string;
  readonly paymentIntentCreatedIso: string;
  readonly subscriptionId?: string;
  readonly currency: LoungeCurrency;
  readonly amountTotal?: number;
  readonly metadata: Readonly<Record<string, string>>;
}

/** Normalized Stripe Subscription snapshot honoring SDK v23 `items.data[0].current_period_end`. */
export interface LoungeStripeSubscriptionSnapshot {
  readonly id: string;
  readonly customerId: string;
  readonly status:
    | 'active'
    | 'trialing'
    | 'past_due'
    | 'canceled'
    | 'unpaid'
    | 'incomplete'
    | 'incomplete_expired';
  readonly cancelAtPeriodEnd: boolean;
  readonly currentPeriodEndIso: string;
  readonly latestInvoiceId?: string;
  readonly scheduleId?: string;
  readonly currency?: LoungeCurrency;
}

/** Normalized Stripe Charge projection used for cursor-paginated order history and receipt retrieval. */
export interface LoungeStripeChargeRecord {
  readonly id: string;
  readonly customerId?: string;
  readonly status: 'succeeded' | 'pending' | 'failed';
  readonly amount: number;
  readonly amountRefunded: number;
  readonly refunded: boolean;
  readonly disputed: boolean;
  readonly currency: LoungeCurrency;
  readonly createdIso: string;
  readonly paymentIntentId?: string;
  readonly receiptUrl?: string;
  readonly metadata: Readonly<Record<string, string>>;
}

/** Normalized Invoice linkage returned via `stripe.invoicePayments.list` for refund attribution. */
export interface LoungeStripeResolvedInvoice {
  readonly id: string;
  readonly subscriptionId?: string;
  readonly periodEndIso?: string;
  readonly paymentIntentId?: string;
}

/** Input payload passed to create a Stripe Checkout Session via `ILoungeStripeGatewayPort`. */
export interface CreateLoungeStripeCheckoutInput {
  readonly customerId: string;
  readonly uid: string;
  readonly productId: Exclude<LoungeProductId, 'WELCOME_BONUS_20'>;
  readonly mode: 'payment' | 'subscription';
  readonly priceId: string;
  readonly currency: LoungeCurrency;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly allowPromotionCodes: boolean;
  readonly enableInvoiceCreation: boolean;
  readonly submitMessage: string;
  readonly metadata: Readonly<Record<string, string>>;
}

/** Normalized parsed Stripe webhook event. */
export interface LoungeStripeWebhookEvent {
  readonly id: string;
  readonly type: string;
  readonly dataObject: Readonly<Record<string, unknown>>;
}

/**
 * Hexagonal port encapsulating Stripe API (`stripe@^23.2.0`) calls so billing domain logic
 * stays test-key-enforced, mockable, and runnable hermetically against Firebase Emulators.
 */
export interface ILoungeStripeGatewayPort extends IStripeCustomerWithdrawalCleanupPort {
  /** Whether billing credentials and Price IDs are configured (`false` in Coming Soon mode). */
  readonly isConfigured?: boolean;
  /** Retrieves an active Stripe Customer or idempotently creates one for `uid`. */
  ensureCustomer(params: {
    readonly existingCustomerId?: string;
    readonly uid: string;
    readonly xHandle: string;
    readonly countryCode: string;
  }): Promise<{ readonly customerId: string }>;
  /** Creates a Stripe Hosted Checkout Session for the validated customer and Price ID. */
  createCheckoutSession(
    input: CreateLoungeStripeCheckoutInput,
  ): Promise<{ readonly id: string; readonly url: string }>;
  /**
   * Fetches and normalizes a Stripe Checkout Session expanded with payment/subscription handles.
   *
   * @throws LoungeNotFoundError When the Stripe Checkout Session does not exist.
   */
  retrieveCheckoutSession(sessionId: string): Promise<LoungeStripeCheckoutSession>;
  /** Creates a single-use Stripe Customer Portal session optionally deep-linked to a subscription flow. */
  createPortalSession(params: {
    readonly customerId: string;
    readonly returnUrl: string;
    readonly flow: LoungePortalFlow;
    readonly subscriptionId?: string;
    readonly configurationId?: string;
  }): Promise<{ readonly url: string }>;
  /**
   * Retrieves a Stripe Subscription snapshot honoring `items.data[0].current_period_end`.
   *
   * @throws LoungeNotFoundError When the Stripe Subscription does not exist.
   */
  retrieveSubscription(subscriptionId: string): Promise<LoungeStripeSubscriptionSnapshot>;
  /** Lists paginated Stripe Charges belonging to `customerId`. */
  listCharges(params: {
    readonly customerId: string;
    readonly limit: number;
    readonly startingAfter?: string;
  }): Promise<{ readonly charges: LoungeStripeChargeRecord[]; readonly hasMore: boolean }>;
  /**
   * Retrieves a single Stripe Charge by ID.
   *
   * @throws LoungeNotFoundError When the Stripe Charge does not exist.
   */
  retrieveCharge(chargeId: string): Promise<LoungeStripeChargeRecord>;
  /** Resolves the associated Invoice and Subscription linked to a Stripe PaymentIntent via `invoicePayments`. */
  resolveInvoiceByPaymentIntent(paymentIntentId: string): Promise<LoungeStripeResolvedInvoice | null>;
  /** Resolves the paid PaymentIntent linked to a Stripe Invoice via `invoicePayments`. */
  resolvePaymentIntentByInvoice(invoiceId: string): Promise<string | null>;
  /** Issues an idempotent full (or explicit minor-unit) Stripe refund for `paymentIntentId`. */
  createFullRefund(params: {
    readonly paymentIntentId: string;
    readonly idempotencyKey: string;
    readonly reason?: 'duplicate' | 'requested_by_customer' | 'fraudulent';
    readonly amountMinor?: number;
  }): Promise<{ readonly refundId: string }>;
  /** Cancels a Stripe Subscription immediately; ignores 404/resource_missing idempotently. */
  cancelSubscriptionImmediately(subscriptionId: string): Promise<void>;
  /**
   * Verifies webhook signature against raw request bytes and parses the normalized Stripe event.
   *
   * @throws LoungeAuthError When webhook signature verification fails.
   */
  constructWebhookEvent(
    rawBody: Buffer,
    signatureHeader: string,
    webhookSecret: string,
  ): LoungeStripeWebhookEvent;
}
