import type { LoungeSubscriptionStatus } from '@rebecca/types';
import { loungeLogger } from '../../../utils/logger';
import {
  SESSION_ID_PATTERN,
  buildProcessedEventDoc,
  extractSubscriptionIdFromInvoiceObj,
  readStripeId,
  resolveTargetStatusFromStripeSnapshot,
  type LoungeBillingUseCaseConfig,
} from '../domain/loungeBilling.helpers';
import type { ILoungeStripeGatewayPort } from '../ports/loungeStripe.port';
import type { ILoungeBillingRepository } from '../repositories/loungeBilling.repository';
import type { LoungeBillingCheckoutUseCase } from './loungeBillingCheckout.usecase';

/**
 * Use case verifying `stripe-signature` headers and dispatching all 7 Stripe billing webhook
 * event types idempotently via `ILoungeBillingRepository`.
 */
export class LoungeBillingWebhookUseCase {
  constructor(
    private readonly billingRepository: ILoungeBillingRepository,
    private readonly stripeGateway: ILoungeStripeGatewayPort,
    private readonly checkoutUseCase: Pick<LoungeBillingCheckoutUseCase, 'fulfillCheckoutSession'>,
    private readonly config: LoungeBillingUseCaseConfig,
  ) {}

  /** Verifies `stripe-signature` on raw request Buffer and processes billing webhooks idempotently. */
  public async handleStripeWebhook(
    rawBody: Buffer,
    signatureHeader: string,
    traceHeader?: string,
  ): Promise<{ readonly received: true; readonly ignored?: boolean }> {
    const secret = this.config.stripeWebhookSecret;
    if (!secret) {
      throw new Error('STRIPE_WEBHOOK_SECRET is required');
    }

    const event = this.stripeGateway.constructWebhookEvent(rawBody, signatureHeader, secret);
    const now = new Date();

    if (await this.billingRepository.hasProcessedEvent(event.id)) {
      loungeLogger.info(
        'Ignored duplicate Stripe webhook event',
        { eventId: event.id, eventType: event.type },
        traceHeader,
      );
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
      await this.checkoutUseCase.fulfillCheckoutSession(
        session,
        { id: event.id, type: event.type },
        traceHeader,
      );
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
      const uid = await this.billingRepository.findUidByStripeCustomerOrSubscription(
        stripeSub.customerId,
        stripeSub.id,
      );
      if (!uid) {
        await this.billingRepository.recordProcessedEvent(
          buildProcessedEventDoc(event.id, event.type, undefined, invoiceId, now),
        );
        return { received: true };
      }
      const applied = await this.billingRepository.applyInvoicePaidWebhookTx({
        uid,
        eventId: event.id,
        eventType: event.type,
        invoiceId,
        stripeSub,
        now,
      });
      if (applied) {
        loungeLogger.info(
          'Processed Stripe invoice.paid webhook',
          { uid, eventId: event.id, invoiceId, subscriptionId: stripeSub.id },
          traceHeader,
        );
      }
      return { received: true };
    }

    if (event.type === 'invoice.payment_failed') {
      const subId = extractSubscriptionIdFromInvoiceObj(event.dataObject);
      if (!subId) {
        return { received: true, ignored: true };
      }
      const stripeSub = await this.stripeGateway.retrieveSubscription(subId);
      await this.applyLifecycleWebhook(
        event.id,
        event.type,
        stripeSub,
        'PAST_DUE',
        now,
        traceHeader,
      );
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
      const targetStatus = resolveTargetStatusFromStripeSnapshot(
        stripeSub,
        event.type === 'customer.subscription.deleted',
      );
      await this.applyLifecycleWebhook(
        event.id,
        event.type,
        stripeSub,
        targetStatus,
        now,
        traceHeader,
      );
      return { received: true };
    }

    if (event.type === 'charge.refunded') {
      await this.handleChargeRefundedWebhook(
        event.id,
        event.type,
        event.dataObject,
        now,
        traceHeader,
      );
      return { received: true };
    }

    if (event.type === 'charge.dispute.created') {
      await this.handleChargeDisputeCreatedWebhook(
        event.id,
        event.type,
        event.dataObject,
        now,
        traceHeader,
      );
      return { received: true };
    }

    return { received: true, ignored: true };
  }

  private async applyLifecycleWebhook(
    eventId: string,
    eventType: string,
    stripeSub: Awaited<ReturnType<ILoungeStripeGatewayPort['retrieveSubscription']>>,
    targetStatus: LoungeSubscriptionStatus,
    now: Date,
    traceHeader?: string,
  ): Promise<void> {
    const uid = await this.billingRepository.findUidByStripeCustomerOrSubscription(
      stripeSub.customerId,
      stripeSub.id,
    );
    if (!uid) {
      await this.billingRepository.recordProcessedEvent(
        buildProcessedEventDoc(eventId, eventType, undefined, stripeSub.id, now),
      );
      return;
    }

    const outcome = await this.billingRepository.applySubscriptionLifecycleWebhookTx({
      uid,
      eventId,
      eventType,
      stripeSub,
      targetStatus,
      now,
    });
    if (outcome === 'SKIPPED_STALE_SUB') {
      loungeLogger.warn(
        'Ignored stale Stripe subscription lifecycle webhook',
        { uid, eventId, eventType, webhookSubId: stripeSub.id },
        traceHeader,
      );
    } else if (outcome === 'APPLIED') {
      loungeLogger.info(
        'Applied Stripe subscription lifecycle webhook',
        { uid, eventId, eventType, subscriptionId: stripeSub.id, targetStatus },
        traceHeader,
      );
    }
  }

  private async handleChargeRefundedWebhook(
    eventId: string,
    eventType: string,
    chargeObj: Readonly<Record<string, unknown>>,
    now: Date,
    traceHeader?: string,
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
      loungeLogger.warn(
        'Received partial Stripe refund event; skipping auto-revocation',
        { eventId, amountRefunded, amountCaptured },
        traceHeader,
      );
      await this.billingRepository.recordProcessedEvent(
        buildProcessedEventDoc(eventId, eventType, undefined, paymentIntentId, now),
      );
      return;
    }

    if (paymentIntentId) {
      const targetLot = await this.billingRepository.findCreditLotByPaymentIntent(paymentIntentId);
      if (targetLot) {
        await this.billingRepository.applyRefundOrDisputeClawbackTx({
          eventId,
          eventType,
          uid: targetLot.uid,
          lotId: targetLot.id,
          referenceId: paymentIntentId,
          isDispute: false,
          trialHmacKeyring: this.config.trialHmacKeyring,
          now,
        });
        loungeLogger.info(
          'Revoked credit lot on Stripe charge.refunded webhook',
          { uid: targetLot.uid, eventId, lotId: targetLot.id, referenceId: paymentIntentId },
          traceHeader,
        );
        return;
      }

      const resolvedInv = await this.stripeGateway.resolveInvoiceByPaymentIntent(paymentIntentId);
      const uid = await this.billingRepository.findUidByStripeCustomerOrSubscription(
        customerId,
        resolvedInv?.subscriptionId,
      );
      if (uid && resolvedInv?.subscriptionId) {
        const currentSub = await this.billingRepository.getSubscriptionByUid(uid);
        if (
          currentSub &&
          currentSub.lastProcessedInvoiceId === resolvedInv.id &&
          currentSub.stripeSubscriptionId === resolvedInv.subscriptionId
        ) {
          await this.stripeGateway.cancelSubscriptionImmediately(resolvedInv.subscriptionId);
          await this.billingRepository.applySubscriptionRefundDowngradeTx({
            eventId,
            eventType,
            uid,
            invoiceId: resolvedInv.id,
            now,
          });
          loungeLogger.info(
            'Downgraded subscription on Stripe charge.refunded webhook',
            { uid, eventId, invoiceId: resolvedInv.id },
            traceHeader,
          );
          return;
        }
      }
    }

    await this.billingRepository.recordProcessedEvent(
      buildProcessedEventDoc(eventId, eventType, undefined, paymentIntentId ?? customerId, now),
    );
  }

  private async handleChargeDisputeCreatedWebhook(
    eventId: string,
    eventType: string,
    disputeObj: Readonly<Record<string, unknown>>,
    now: Date,
    traceHeader?: string,
  ): Promise<void> {
    const paymentIntentId = readStripeId(disputeObj['payment_intent']);
    let targetUid: string | null = null;
    let targetLotId: string | undefined;

    if (paymentIntentId) {
      const lot = await this.billingRepository.findCreditLotByPaymentIntent(paymentIntentId);
      if (lot) {
        targetUid = lot.uid;
        targetLotId = lot.id;
      } else {
        const inv = await this.stripeGateway.resolveInvoiceByPaymentIntent(paymentIntentId);
        targetUid = await this.billingRepository.findUidByStripeCustomerOrSubscription(
          undefined,
          inv?.subscriptionId,
        );
      }
    }

    if (!targetUid) {
      await this.billingRepository.recordProcessedEvent(
        buildProcessedEventDoc(eventId, eventType, undefined, paymentIntentId, now),
      );
      return;
    }

    const sub = await this.billingRepository.getSubscriptionByUid(targetUid);
    if (sub?.stripeSubscriptionId) {
      await this.stripeGateway.cancelSubscriptionImmediately(sub.stripeSubscriptionId);
    }

    const referenceId = paymentIntentId ?? eventId;
    await this.billingRepository.applyRefundOrDisputeClawbackTx({
      eventId,
      eventType,
      uid: targetUid,
      lotId: targetLotId,
      referenceId,
      isDispute: true,
      trialHmacKeyring: this.config.trialHmacKeyring,
      now,
    });
    loungeLogger.warn(
      'Suspended user and recorded DISPUTE_BLOCKED on Stripe chargeback webhook',
      { uid: targetUid, eventId, lotId: targetLotId, referenceId },
      traceHeader,
    );
  }
}
