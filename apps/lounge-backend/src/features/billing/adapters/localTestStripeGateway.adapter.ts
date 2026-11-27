import crypto from 'node:crypto';
import type { LoungePortalFlow } from '@rebecca/types';
import {
  LoungeAuthError,
  LoungeNotFoundError,
  LoungeValidationError,
} from '../../../utils/errors';
import { LOUNGE_PRODUCT_CATALOG_SPECS } from '../domain/loungeCatalog.constants';
import type {
  CreateLoungeStripeCheckoutInput,
  ILoungeStripeGatewayPort,
  LoungeStripeChargeRecord,
  LoungeStripeCheckoutSession,
  LoungeStripeResolvedInvoice,
  LoungeStripeSubscriptionSnapshot,
  LoungeStripeWebhookEvent,
} from '../ports/loungeStripe.port';

/**
 * Deterministic non-production Stripe test gateway used ONLY when `isLocalEmulatorMode === true`.
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
    const amountMinor = LOUNGE_PRODUCT_CATALOG_SPECS[input.currency][input.productId].unitAmountMinor;

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
      throw new LoungeNotFoundError(`Synthetic Checkout Session "${sessionId}" not found`);
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
      throw new LoungeNotFoundError(`Synthetic Subscription "${subscriptionId}" not found`);
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
    throw new LoungeNotFoundError(`Synthetic Charge "${chargeId}" not found`);
  }

  public async resolveInvoiceByPaymentIntent(
    paymentIntentId: string,
  ): Promise<LoungeStripeResolvedInvoice | null> {
    let matchedCustomerId: string | undefined;
    for (const [customerId, charges] of this.chargesByCustomer.entries()) {
      if (charges.some((c) => c.paymentIntentId === paymentIntentId)) {
        matchedCustomerId = customerId;
        break;
      }
    }
    if (!matchedCustomerId) {
      return null;
    }
    const matchingSub = Array.from(this.subscriptions.values()).find(
      (sub) => sub.customerId === matchedCustomerId && Boolean(sub.latestInvoiceId),
    );
    if (!matchingSub?.latestInvoiceId) {
      return null;
    }
    return {
      id: matchingSub.latestInvoiceId,
      subscriptionId: matchingSub.id,
      periodEndIso: matchingSub.currentPeriodEndIso,
      paymentIntentId,
    };
  }

  public async resolvePaymentIntentByInvoice(invoiceId: string): Promise<string | null> {
    const matchingSub = Array.from(this.subscriptions.values()).find(
      (sub) => sub.latestInvoiceId === invoiceId,
    );
    if (!matchingSub) {
      return null;
    }
    const charges = this.chargesByCustomer.get(matchingSub.customerId) ?? [];
    const subCharge = charges.find(
      (c) =>
        c.status === 'succeeded' &&
        !c.refunded &&
        c.metadata['productId'] === 'STANDARD_MONTHLY' &&
        typeof c.paymentIntentId === 'string',
    );
    return subCharge?.paymentIntentId ?? null;
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
      const expectedHeader = `test-sig-${crypto
        .createHmac('sha256', webhookSecret)
        .update(rawBody)
        .digest('hex')}`;
      const providedBuf = Buffer.from(signatureHeader.trim(), 'utf8');
      const expectedBuf = Buffer.from(expectedHeader, 'utf8');
      if (
        providedBuf.length !== expectedBuf.length ||
        !crypto.timingSafeEqual(providedBuf, expectedBuf)
      ) {
        throw new LoungeAuthError(401, 'Invalid Stripe webhook signature');
      }
    }

    let parsedRaw: unknown;
    try {
      parsedRaw = JSON.parse(rawBody.toString('utf8'));
    } catch (err) {
      throw new LoungeValidationError('Malformed Stripe webhook JSON payload', { cause: err });
    }
    if (typeof parsedRaw !== 'object' || parsedRaw === null || Array.isArray(parsedRaw)) {
      throw new LoungeValidationError('Malformed Stripe webhook JSON payload');
    }

    const parsed = parsedRaw as {
      readonly id?: unknown;
      readonly type?: unknown;
      readonly data?: { readonly object?: unknown };
    };
    if (
      typeof parsed.id !== 'string' ||
      !parsed.id.trim() ||
      typeof parsed.type !== 'string' ||
      !parsed.type.trim() ||
      typeof parsed.data?.object !== 'object' ||
      parsed.data.object === null ||
      Array.isArray(parsed.data.object)
    ) {
      throw new LoungeValidationError('Malformed Stripe webhook JSON payload');
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
      if (!subId) {
        return;
      }
      const rawStatus = typeof obj['status'] === 'string' ? obj['status'] : undefined;
      let nextStatus: LoungeStripeSubscriptionSnapshot['status'];
      if (type === 'customer.subscription.deleted') {
        nextStatus = 'canceled';
      } else if (
        rawStatus === 'past_due' ||
        rawStatus === 'canceled' ||
        rawStatus === 'unpaid' ||
        rawStatus === 'incomplete' ||
        rawStatus === 'incomplete_expired' ||
        rawStatus === 'trialing' ||
        rawStatus === 'active'
      ) {
        nextStatus = rawStatus;
      } else if (existing) {
        nextStatus = existing.status;
      } else {
        return;
      }

      const customerId =
        typeof obj['customer'] === 'string' && obj['customer'].trim()
          ? obj['customer'].trim()
          : existing?.customerId;
      if (!customerId) {
        return;
      }

      const itemsObj = obj['items'] as
        | { readonly data?: ReadonlyArray<{ readonly current_period_end?: unknown }> }
        | undefined;
      const periodEndSec = itemsObj?.data?.[0]?.current_period_end;
      const periodEndIso =
        typeof periodEndSec === 'number' && Number.isFinite(periodEndSec) && periodEndSec > 0
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
          ...(typeof periodEndSec === 'number' && Number.isFinite(periodEndSec) && periodEndSec > 0
            ? { currentPeriodEndIso: new Date(periodEndSec * 1000).toISOString() }
            : {}),
        });
      }
    }
  }
}
