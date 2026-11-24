import Stripe from 'stripe';
import type { LoungeCurrency, LoungePortalFlow } from '@rebecca/types';
import { LoungeAuthError } from '../../../utils/errors';
import type {
  CreateLoungeStripeCheckoutInput,
  ILoungeStripeGatewayPort,
  LoungeStripeChargeRecord,
  LoungeStripeCheckoutSession,
  LoungeStripeResolvedInvoice,
  LoungeStripeSubscriptionSnapshot,
  LoungeStripeWebhookEvent,
} from '../ports/loungeStripe.port';

function normalizeCurrency(raw: string | null | undefined): LoungeCurrency | undefined {
  if (!raw) {
    return undefined;
  }
  const upper = raw.trim().toUpperCase();
  return upper === 'JPY' ? 'JPY' : upper === 'USD' ? 'USD' : undefined;
}

function unixToIso(seconds: number | null | undefined): string {
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
    return new Date(seconds * 1000).toISOString();
  }
  return new Date().toISOString();
}

function extractStringMetadata(
  raw: Stripe.Metadata | null | undefined,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  if (!raw) {
    return result;
  }
  for (const [key, val] of Object.entries(raw)) {
    if (typeof val === 'string') {
      result[key] = val;
    }
  }
  return result;
}

function isStripeResourceMissing(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const code = (err as { readonly code?: unknown }).code;
  const statusCode = (err as { readonly statusCode?: unknown }).statusCode;
  return code === 'resource_missing' || statusCode === 404;
}

function mapStripeSubscription(sub: Stripe.Subscription): LoungeStripeSubscriptionSnapshot {
  const periodEndUnix = sub.items.data[0]?.current_period_end;
  const latestInvoiceId =
    typeof sub.latest_invoice === 'string'
      ? sub.latest_invoice
      : sub.latest_invoice?.id;
  const scheduleId =
    typeof sub.schedule === 'string' ? sub.schedule : sub.schedule?.id;
  const customerId =
    typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const statusMap: Readonly<
    Record<Stripe.Subscription.Status, LoungeStripeSubscriptionSnapshot['status']>
  > = {
    active: 'active',
    trialing: 'trialing',
    past_due: 'past_due',
    canceled: 'canceled',
    unpaid: 'unpaid',
    incomplete: 'incomplete',
    incomplete_expired: 'incomplete_expired',
    paused: 'past_due',
  };

  return {
    id: sub.id,
    customerId,
    status: statusMap[sub.status] ?? 'active',
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
    currentPeriodEndIso: unixToIso(periodEndUnix),
    ...(latestInvoiceId ? { latestInvoiceId } : {}),
    ...(scheduleId ? { scheduleId } : {}),
    ...(normalizeCurrency(sub.currency) ? { currency: normalizeCurrency(sub.currency) } : {}),
  };
}

function mapStripeCharge(charge: Stripe.Charge): LoungeStripeChargeRecord {
  const customerId =
    typeof charge.customer === 'string'
      ? charge.customer
      : charge.customer?.id;
  const paymentIntentId =
    typeof charge.payment_intent === 'string'
      ? charge.payment_intent
      : charge.payment_intent?.id;
  const currency = normalizeCurrency(charge.currency) ?? 'USD';
  const status: LoungeStripeChargeRecord['status'] =
    charge.status === 'succeeded'
      ? 'succeeded'
      : charge.status === 'failed'
        ? 'failed'
        : 'pending';

  return {
    id: charge.id,
    ...(customerId ? { customerId } : {}),
    status,
    amount: charge.amount,
    amountRefunded: charge.amount_refunded,
    refunded: charge.refunded,
    disputed: charge.disputed,
    currency,
    createdIso: unixToIso(charge.created),
    ...(paymentIntentId ? { paymentIntentId } : {}),
    ...(charge.receipt_url ? { receiptUrl: charge.receipt_url } : {}),
    metadata: extractStringMetadata(charge.metadata),
  };
}

/**
 * Production Stripe SDK v23 (`2026-11-18.endive`) gateway adapter enforcing pre-created Customers,
 * `items.data[0].current_period_end`, `invoicePayments.list` refund attribution, and idempotency keys.
 */
export class StripeSdkGatewayAdapter implements ILoungeStripeGatewayPort {
  private readonly stripe: Stripe;

  constructor(secretKey: string, client?: Stripe) {
    this.stripe = client ?? new Stripe(secretKey);
  }

  public async ensureCustomer(params: {
    readonly existingCustomerId?: string;
    readonly uid: string;
    readonly xHandle: string;
    readonly countryCode: string;
  }): Promise<{ readonly customerId: string }> {
    if (params.existingCustomerId) {
      try {
        const existing = await this.stripe.customers.retrieve(params.existingCustomerId);
        if (!('deleted' in existing && existing.deleted)) {
          return { customerId: existing.id };
        }
      } catch (err) {
        if (!isStripeResourceMissing(err)) {
          throw err;
        }
      }
    }

    const created = await this.stripe.customers.create(
      {
        metadata: {
          uid: params.uid,
          xHandle: params.xHandle,
          countryCode: params.countryCode,
        },
      },
      { idempotencyKey: `lounge_customer_${params.uid}` },
    );
    return { customerId: created.id };
  }

  public async createCheckoutSession(
    input: CreateLoungeStripeCheckoutInput,
  ): Promise<{ readonly id: string; readonly url: string }> {
    const metadata: Record<string, string> = { ...input.metadata };
    const submitMessage = input.submitMessage.slice(0, 1200);

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      customer: input.customerId,
      mode: input.mode,
      line_items: [{ price: input.priceId, quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata,
      custom_text: {
        submit: { message: submitMessage },
      },
      automatic_tax: { enabled: false },
      ...(input.allowPromotionCodes ? { allow_promotion_codes: true } : {}),
      ...(input.mode === 'subscription'
        ? { subscription_data: { metadata } }
        : {
            payment_intent_data: { metadata },
            ...(input.enableInvoiceCreation
              ? { invoice_creation: { enabled: true, invoice_data: { metadata } } }
              : {}),
          }),
    };

    const created = await this.stripe.checkout.sessions.create(sessionParams);
    if (!created.url) {
      throw new Error(`Stripe Checkout Session "${created.id}" did not return a hosted URL`);
    }
    return { id: created.id, url: created.url };
  }

  public async retrieveCheckoutSession(sessionId: string): Promise<LoungeStripeCheckoutSession> {
    const session = await this.stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent', 'subscription'],
    });
    const customerId =
      typeof session.customer === 'string'
        ? session.customer
        : session.customer?.id ?? '';
    const piObj =
      typeof session.payment_intent === 'object' && session.payment_intent !== null
        ? session.payment_intent
        : null;
    const paymentIntentId =
      typeof session.payment_intent === 'string' ? session.payment_intent : piObj?.id;
    const paymentIntentCreatedIso = piObj?.created
      ? unixToIso(piObj.created)
      : unixToIso(session.created);
    const subId =
      typeof session.subscription === 'string'
        ? session.subscription
        : session.subscription?.id;

    return {
      id: session.id,
      url: session.url ?? '',
      customerId,
      mode: session.mode === 'subscription' ? 'subscription' : 'payment',
      paymentStatus:
        session.payment_status === 'paid'
          ? 'paid'
          : session.payment_status === 'no_payment_required'
            ? 'no_payment_required'
            : 'unpaid',
      ...(paymentIntentId ? { paymentIntentId } : {}),
      paymentIntentCreatedIso,
      ...(subId ? { subscriptionId: subId } : {}),
      ...(normalizeCurrency(session.currency)
        ? { currency: normalizeCurrency(session.currency) }
        : {}),
      ...(session.amount_total !== null && session.amount_total !== undefined
        ? { amountTotal: session.amount_total }
        : {}),
      metadata: extractStringMetadata(session.metadata),
    };
  }

  public async createPortalSession(params: {
    readonly customerId: string;
    readonly returnUrl: string;
    readonly flow: LoungePortalFlow;
    readonly subscriptionId?: string;
    readonly configurationId?: string;
  }): Promise<{ readonly url: string }> {
    const portalParams: Stripe.BillingPortal.SessionCreateParams = {
      customer: params.customerId,
      return_url: params.returnUrl,
      ...(params.configurationId ? { configuration: params.configurationId } : {}),
      ...(params.flow === 'payment_method_update'
        ? {
            flow_data: {
              type: 'payment_method_update',
              after_completion: {
                type: 'redirect',
                redirect: { return_url: params.returnUrl },
              },
            },
          }
        : params.flow === 'subscription_cancel' && params.subscriptionId
          ? {
              flow_data: {
                type: 'subscription_cancel',
                subscription_cancel: { subscription: params.subscriptionId },
                after_completion: {
                  type: 'redirect',
                  redirect: { return_url: params.returnUrl },
                },
              },
            }
          : {}),
    };

    const created = await this.stripe.billingPortal.sessions.create(portalParams);
    return { url: created.url };
  }

  public async retrieveSubscription(
    subscriptionId: string,
  ): Promise<LoungeStripeSubscriptionSnapshot> {
    const sub = await this.stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['schedule', 'latest_invoice'],
    });
    return mapStripeSubscription(sub);
  }

  public async listCharges(params: {
    readonly customerId: string;
    readonly limit: number;
    readonly startingAfter?: string;
  }): Promise<{ readonly charges: LoungeStripeChargeRecord[]; readonly hasMore: boolean }> {
    const res = await this.stripe.charges.list({
      customer: params.customerId,
      limit: params.limit,
      ...(params.startingAfter ? { starting_after: params.startingAfter } : {}),
    });
    return {
      charges: res.data.map(mapStripeCharge),
      hasMore: res.has_more,
    };
  }

  public async retrieveCharge(chargeId: string): Promise<LoungeStripeChargeRecord> {
    const charge = await this.stripe.charges.retrieve(chargeId);
    return mapStripeCharge(charge);
  }

  public async resolveInvoiceByPaymentIntent(
    paymentIntentId: string,
  ): Promise<LoungeStripeResolvedInvoice | null> {
    const list = await this.stripe.invoicePayments.list({
      payment: { type: 'payment_intent', payment_intent: paymentIntentId },
      expand: ['data.invoice'],
      limit: 1,
    });
    const first = list.data[0];
    if (!first) {
      return null;
    }
    const invoiceObj =
      typeof first.invoice === 'object' &&
      first.invoice !== null &&
      !('deleted' in first.invoice && first.invoice.deleted)
        ? first.invoice
        : null;
    const invoiceId = typeof first.invoice === 'string' ? first.invoice : invoiceObj?.id;
    if (!invoiceId) {
      return null;
    }
    const parentSub = invoiceObj?.parent?.subscription_details?.subscription;
    const subscriptionId = typeof parentSub === 'string' ? parentSub : parentSub?.id;
    const periodEndIso = invoiceObj?.period_end ? unixToIso(invoiceObj.period_end) : undefined;
    return {
      id: invoiceId,
      ...(subscriptionId ? { subscriptionId } : {}),
      ...(periodEndIso ? { periodEndIso } : {}),
    };
  }

  public async createFullRefund(params: {
    readonly paymentIntentId: string;
    readonly idempotencyKey: string;
    readonly reason?: 'duplicate' | 'requested_by_customer' | 'fraudulent';
    readonly amountMinor?: number;
  }): Promise<{ readonly refundId: string }> {
    const refund = await this.stripe.refunds.create(
      {
        payment_intent: params.paymentIntentId,
        ...(params.reason ? { reason: params.reason } : {}),
        ...(params.amountMinor !== undefined ? { amount: params.amountMinor } : {}),
      },
      { idempotencyKey: params.idempotencyKey },
    );
    return { refundId: refund.id };
  }

  public async cancelSubscriptionImmediately(subscriptionId: string): Promise<void> {
    try {
      await this.stripe.subscriptions.cancel(subscriptionId);
    } catch (err) {
      if (!isStripeResourceMissing(err)) {
        throw err;
      }
    }
  }

  public async cancelAndDeleteCustomer(customerId: string): Promise<void> {
    try {
      for await (const sub of this.stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 100,
      })) {
        if (sub.status !== 'canceled' && sub.status !== 'incomplete_expired') {
          await this.stripe.subscriptions.cancel(sub.id).catch((err) => {
            if (!isStripeResourceMissing(err)) throw err;
          });
        }
      }

      for await (const schedule of this.stripe.subscriptionSchedules.list({
        customer: customerId,
        limit: 100,
      })) {
        if (schedule.status === 'not_started' || schedule.status === 'active') {
          await this.stripe.subscriptionSchedules.release(schedule.id).catch((err) => {
            if (!isStripeResourceMissing(err)) throw err;
          });
        }
      }

      for await (const invoice of this.stripe.invoices.list({
        customer: customerId,
        status: 'open',
        limit: 100,
      })) {
        await this.stripe.invoices.voidInvoice(invoice.id).catch((err) => {
          if (!isStripeResourceMissing(err)) throw err;
        });
      }

      for await (const session of this.stripe.checkout.sessions.list({
        customer: customerId,
        status: 'open',
        limit: 100,
      })) {
        await this.stripe.checkout.sessions.expire(session.id).catch((err) => {
          if (!isStripeResourceMissing(err)) throw err;
        });
      }

      await this.stripe.customers.del(customerId);
    } catch (err) {
      if (isStripeResourceMissing(err)) {
        return;
      }
      throw err;
    }
  }

  public constructWebhookEvent(
    rawBody: Buffer,
    signatureHeader: string,
    webhookSecret: string,
  ): LoungeStripeWebhookEvent {
    try {
      const event = this.stripe.webhooks.constructEvent(rawBody, signatureHeader, webhookSecret);
      return {
        id: event.id,
        type: event.type,
        dataObject: event.data.object as unknown as Readonly<Record<string, unknown>>,
      };
    } catch (err) {
      throw new LoungeAuthError(401, 'Invalid Stripe webhook signature', { cause: err });
    }
  }
}
