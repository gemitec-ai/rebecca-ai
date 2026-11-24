import crypto from 'node:crypto';
import type {
  LoungeCurrency,
  LoungePortalFlow,
  LoungeProductId,
} from '@rebecca/types';
import { LoungeAuthError } from '../../../utils/errors';

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
  readonly currency?: LoungeCurrency;
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
export interface ILoungeStripeGatewayPort {
  ensureCustomer(params: {
    readonly existingCustomerId?: string;
    readonly uid: string;
    readonly xHandle: string;
    readonly countryCode: string;
  }): Promise<{ readonly customerId: string }>;
  createCheckoutSession(
    input: CreateLoungeStripeCheckoutInput,
  ): Promise<{ readonly id: string; readonly url: string }>;
  retrieveCheckoutSession(sessionId: string): Promise<LoungeStripeCheckoutSession>;
  createPortalSession(params: {
    readonly customerId: string;
    readonly returnUrl: string;
    readonly flow: LoungePortalFlow;
    readonly subscriptionId?: string;
    readonly configurationId?: string;
  }): Promise<{ readonly url: string }>;
  retrieveSubscription(subscriptionId: string): Promise<LoungeStripeSubscriptionSnapshot>;
  listCharges(params: {
    readonly customerId: string;
    readonly limit: number;
    readonly startingAfter?: string;
  }): Promise<{ readonly charges: LoungeStripeChargeRecord[]; readonly hasMore: boolean }>;
  retrieveCharge(chargeId: string): Promise<LoungeStripeChargeRecord>;
  resolveInvoiceByPaymentIntent(paymentIntentId: string): Promise<LoungeStripeResolvedInvoice | null>;
  createFullRefund(params: {
    readonly paymentIntentId: string;
    readonly idempotencyKey: string;
    readonly reason?: 'duplicate' | 'requested_by_customer' | 'fraudulent';
    readonly amountMinor?: number;
  }): Promise<{ readonly refundId: string }>;
  cancelSubscriptionImmediately(subscriptionId: string): Promise<void>;
  cancelAndDeleteCustomer(customerId: string): Promise<void>;
  constructWebhookEvent(
    rawBody: Buffer,
    signatureHeader: string,
    webhookSecret: string,
  ): LoungeStripeWebhookEvent;
}

/**
 * Deterministic non-production Stripe test gateway used ONLY when `STRIPE_SECRET_KEY` is omitted
 * in local development or automated E2E suites (`NODE_ENV !== 'production'`).
 */
export class LocalTestStripeGatewayAdapter implements ILoungeStripeGatewayPort {
  private readonly sessions = new Map<string, LoungeStripeCheckoutSession>();
  private readonly subscriptions = new Map<string, LoungeStripeSubscriptionSnapshot>();
  private readonly chargesByCustomer = new Map<string, LoungeStripeChargeRecord[]>();
  private readonly deletedCustomers = new Set<string>();
  public readonly forceFailures = {
    cancelAndDeleteCustomer: false,
    refund: false,
  };

  constructor(private readonly publicOrigin: string = 'http://localhost:4300') {}

  /** Exposes synthetic customer IDs for E2E webhook simulation in local/test runs. */
  public seedTestSubscriptionState(sub: LoungeStripeSubscriptionSnapshot): void {
    this.subscriptions.set(sub.id, sub);
  }

  public async ensureCustomer(params: {
    readonly existingCustomerId?: string;
    readonly uid: string;
    readonly xHandle: string;
    readonly countryCode: string;
  }): Promise<{ readonly customerId: string }> {
    if (params.existingCustomerId && !this.deletedCustomers.has(params.existingCustomerId)) {
      return { customerId: params.existingCustomerId };
    }
    const safeUid = params.uid.replace(/[^A-Za-z0-9]/g, '').slice(0, 18) || 'local';
    return { customerId: `cus_test_${safeUid}_${crypto.randomUUID().slice(0, 6)}` };
  }

  public async createCheckoutSession(
    input: CreateLoungeStripeCheckoutInput,
  ): Promise<{ readonly id: string; readonly url: string }> {
    const id = `cs_test_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const now = new Date();
    const nowIso = now.toISOString();
    const periodEndIso = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const piId = `pi_test_${id.slice(8, 22)}`;
    const chId = `ch_test_${id.slice(8, 22)}`;
    const subId = input.mode === 'subscription' ? `sub_test_${id.slice(8, 20)}` : undefined;
    const amountMinor =
      input.currency === 'JPY'
        ? input.productId === 'TRIAL_TICKET_100'
          ? 200
          : input.productId === 'CHARGE_TICKET_100'
            ? 500
            : 1400
        : input.productId === 'TRIAL_TICKET_100'
          ? 150
          : input.productId === 'CHARGE_TICKET_100'
            ? 350
            : 950;

    if (subId) {
      this.subscriptions.set(subId, {
        id: subId,
        customerId: input.customerId,
        status: 'active',
        cancelAtPeriodEnd: false,
        currentPeriodEndIso: periodEndIso,
        latestInvoiceId: `in_test_${id.slice(8, 20)}`,
        currency: input.currency,
      });
    }

    const charge: LoungeStripeChargeRecord = {
      id: chId,
      customerId: input.customerId,
      status: 'succeeded',
      amount: amountMinor,
      amountRefunded: 0,
      refunded: false,
      disputed: false,
      currency: input.currency,
      createdIso: nowIso,
      paymentIntentId: piId,
      receiptUrl: `https://pay.stripe.com/receipts/test/${chId}`,
      metadata: { ...input.metadata },
    };
    const existingCharges = this.chargesByCustomer.get(input.customerId) ?? [];
    this.chargesByCustomer.set(input.customerId, [charge, ...existingCharges]);

    const session: LoungeStripeCheckoutSession = {
      id,
      url: `${this.publicOrigin}/?checkout=success&session_id=${encodeURIComponent(id)}`,
      customerId: input.customerId,
      mode: input.mode,
      paymentStatus: 'paid',
      paymentIntentId: piId,
      paymentIntentCreatedIso: nowIso,
      ...(subId ? { subscriptionId: subId } : {}),
      currency: input.currency,
      amountTotal: amountMinor,
      metadata: { ...input.metadata },
    };
    this.sessions.set(id, session);
    return { id, url: session.url };
  }

  public async retrieveCheckoutSession(sessionId: string): Promise<LoungeStripeCheckoutSession> {
    const found = this.sessions.get(sessionId);
    if (!found) {
      throw new Error(`Synthetic Checkout Session "${sessionId}" not found`);
    }
    return found;
  }

  public async createPortalSession(params: {
    readonly customerId: string;
    readonly returnUrl: string;
    readonly flow: LoungePortalFlow;
    readonly subscriptionId?: string;
    readonly configurationId?: string;
  }): Promise<{ readonly url: string }> {
    const separator = params.returnUrl.includes('?') ? '&' : '?';
    return {
      url: `${params.returnUrl}${separator}portal_flow=${encodeURIComponent(params.flow)}`,
    };
  }

  public async retrieveSubscription(
    subscriptionId: string,
  ): Promise<LoungeStripeSubscriptionSnapshot> {
    const found = this.subscriptions.get(subscriptionId);
    if (!found) {
      throw new Error(`Synthetic Subscription "${subscriptionId}" not found`);
    }
    return found;
  }

  public async listCharges(params: {
    readonly customerId: string;
    readonly limit: number;
    readonly startingAfter?: string;
  }): Promise<{ readonly charges: LoungeStripeChargeRecord[]; readonly hasMore: boolean }> {
    const all = this.chargesByCustomer.get(params.customerId) ?? [];
    let startIdx = 0;
    if (params.startingAfter) {
      const idx = all.findIndex((c) => c.id === params.startingAfter);
      if (idx !== -1) {
        startIdx = idx + 1;
      }
    }
    const slice = all.slice(startIdx, startIdx + params.limit);
    return {
      charges: slice,
      hasMore: startIdx + slice.length < all.length,
    };
  }

  public async retrieveCharge(chargeId: string): Promise<LoungeStripeChargeRecord> {
    for (const list of this.chargesByCustomer.values()) {
      const match = list.find((c) => c.id === chargeId);
      if (match) {
        return match;
      }
    }
    throw new Error(`Synthetic Charge "${chargeId}" not found`);
  }

  public async resolveInvoiceByPaymentIntent(
    paymentIntentId: string,
  ): Promise<LoungeStripeResolvedInvoice | null> {
    for (const sub of this.subscriptions.values()) {
      if (sub.latestInvoiceId) {
        return {
          id: sub.latestInvoiceId,
          subscriptionId: sub.id,
          periodEndIso: sub.currentPeriodEndIso,
        };
      }
    }
    void paymentIntentId;
    return null;
  }

  public async createFullRefund(params: {
    readonly paymentIntentId: string;
    readonly idempotencyKey: string;
    readonly reason?: 'duplicate' | 'requested_by_customer' | 'fraudulent';
    readonly amountMinor?: number;
  }): Promise<{ readonly refundId: string }> {
    if (this.forceFailures.refund) {
      throw new Error('Forced synthetic refund failure');
    }
    for (const [cusId, charges] of this.chargesByCustomer.entries()) {
      const updated = charges.map((c) =>
        c.paymentIntentId === params.paymentIntentId
          ? {
              ...c,
              refunded: true,
              amountRefunded: params.amountMinor ?? c.amount,
            }
          : c,
      );
      this.chargesByCustomer.set(cusId, updated);
    }
    return { refundId: `re_test_${crypto.randomUUID().slice(0, 12)}` };
  }

  public async cancelSubscriptionImmediately(subscriptionId: string): Promise<void> {
    const sub = this.subscriptions.get(subscriptionId);
    if (sub) {
      this.subscriptions.set(subscriptionId, { ...sub, status: 'canceled', cancelAtPeriodEnd: false });
    }
  }

  public async cancelAndDeleteCustomer(customerId: string): Promise<void> {
    if (this.forceFailures.cancelAndDeleteCustomer) {
      throw new Error('Forced Stripe withdrawal cancellation failure');
    }
    for (const [id, sub] of this.subscriptions.entries()) {
      if (sub.customerId === customerId) {
        this.subscriptions.set(id, { ...sub, status: 'canceled', cancelAtPeriodEnd: false });
      }
    }
    this.deletedCustomers.add(customerId);
  }

  public constructWebhookEvent(
    rawBody: Buffer,
    signatureHeader: string,
    webhookSecret: string,
  ): LoungeStripeWebhookEvent {
    const tMatch = /(?:^|,)t=(\d+)/.exec(signatureHeader);
    const v1Match = /(?:^|,)v1=([a-f0-9]+)/i.exec(signatureHeader);
    if (tMatch && v1Match) {
      const expected = crypto
        .createHmac('sha256', webhookSecret)
        .update(`${tMatch[1]}.${rawBody.toString('utf8')}`, 'utf8')
        .digest('hex');
      const a = Buffer.from(v1Match[1].toLowerCase(), 'utf8');
      const b = Buffer.from(expected, 'utf8');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        throw new LoungeAuthError(401, 'Invalid Stripe webhook signature');
      }
    } else {
      const legacyExpected = crypto
        .createHmac('sha256', webhookSecret)
        .update(rawBody)
        .digest('hex');
      if (signatureHeader !== `test-sig-${legacyExpected}` && signatureHeader !== webhookSecret) {
        throw new LoungeAuthError(401, 'Invalid Stripe webhook signature');
      }
    }

    const parsed = JSON.parse(rawBody.toString('utf8')) as {
      readonly id?: unknown;
      readonly type?: unknown;
      readonly data?: { readonly object?: unknown };
    };
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.type !== 'string' ||
      typeof parsed.data?.object !== 'object' ||
      parsed.data.object === null
    ) {
      throw new Error('Malformed synthetic webhook JSON payload');
    }

    const dataObject = parsed.data.object as Readonly<Record<string, unknown>>;
    this.syncSyntheticWebhookState(parsed.type, dataObject);

    return {
      id: parsed.id,
      type: parsed.type,
      dataObject,
    };
  }

  private syncSyntheticWebhookState(
    type: string,
    obj: Readonly<Record<string, unknown>>,
  ): void {
    if (type === 'customer.subscription.updated' || type === 'customer.subscription.deleted') {
      const subId = typeof obj['id'] === 'string' ? obj['id'] : '';
      const existing = subId ? this.subscriptions.get(subId) : undefined;
      if (subId) {
        const rawStatus = typeof obj['status'] === 'string' ? obj['status'] : undefined;
        const nextStatus: LoungeStripeSubscriptionSnapshot['status'] =
          type === 'customer.subscription.deleted'
            ? 'canceled'
            : rawStatus === 'past_due' ||
                rawStatus === 'canceled' ||
                rawStatus === 'unpaid' ||
                rawStatus === 'incomplete_expired' ||
                rawStatus === 'trialing' ||
                rawStatus === 'active'
              ? rawStatus
              : existing?.status ?? 'active';
        const customerId =
          typeof obj['customer'] === 'string' ? obj['customer'] : existing?.customerId ?? '';
        const itemsObj = obj['items'] as
          | { readonly data?: ReadonlyArray<{ readonly current_period_end?: unknown }> }
          | undefined;
        const periodEndSec = itemsObj?.data?.[0]?.current_period_end;
        const periodEndIso =
          typeof periodEndSec === 'number' && Number.isFinite(periodEndSec)
            ? new Date(periodEndSec * 1000).toISOString()
            : existing?.currentPeriodEndIso ?? new Date(Date.now() + 30 * 86400_000).toISOString();

        this.subscriptions.set(subId, {
          id: subId,
          customerId,
          status: nextStatus,
          cancelAtPeriodEnd:
            typeof obj['cancel_at_period_end'] === 'boolean'
              ? obj['cancel_at_period_end']
              : existing?.cancelAtPeriodEnd ?? false,
          currentPeriodEndIso: periodEndIso,
          ...(existing?.latestInvoiceId ? { latestInvoiceId: existing.latestInvoiceId } : {}),
          ...(existing?.currency ? { currency: existing.currency } : {}),
        });
      }
    } else if (type === 'invoice.payment_failed') {
      const parent = obj['parent'] as
        | { readonly subscription_details?: { readonly subscription?: unknown } }
        | undefined;
      const subId =
        typeof parent?.subscription_details?.subscription === 'string'
          ? parent.subscription_details.subscription
          : typeof obj['subscription'] === 'string'
            ? obj['subscription']
            : '';
      const existing = subId ? this.subscriptions.get(subId) : undefined;
      if (subId && existing) {
        this.subscriptions.set(subId, { ...existing, status: 'past_due' });
      }
    } else if (type === 'invoice.paid') {
      const parent = obj['parent'] as
        | { readonly subscription_details?: { readonly subscription?: unknown } }
        | undefined;
      const subId =
        typeof parent?.subscription_details?.subscription === 'string'
          ? parent.subscription_details.subscription
          : typeof obj['subscription'] === 'string'
            ? obj['subscription']
            : '';
      const existing = subId ? this.subscriptions.get(subId) : undefined;
      const periodEndSec = obj['period_end'];
      const invoiceId = typeof obj['id'] === 'string' ? obj['id'] : existing?.latestInvoiceId;
      if (subId && existing) {
        this.subscriptions.set(subId, {
          ...existing,
          status: 'active',
          ...(invoiceId ? { latestInvoiceId: invoiceId } : {}),
          ...(typeof periodEndSec === 'number' && Number.isFinite(periodEndSec)
            ? { currentPeriodEndIso: new Date(periodEndSec * 1000).toISOString() }
            : {}),
        });
      }
    }
  }
}
