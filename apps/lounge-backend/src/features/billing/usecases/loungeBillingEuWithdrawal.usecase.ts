import {
  toPublicLoungeSubscription,
  type LoungeCurrency,
  type LoungeEuWithdrawalRequestDto,
  type LoungeEuWithdrawalResponseDto,
} from '@rebecca/types';
import type { ResolvedClientGeo } from '../../../utils/clientGeo';
import {
  LoungeConflictError,
  LoungeForbiddenError,
  LoungeNotFoundError,
} from '../../../utils/errors';
import { loungeLogger } from '../../../utils/logger';
import {
  ACTIVE_SUBSCRIPTION_WITHDRAWAL_ALIAS,
  DAY_MS,
  EU_WITHDRAWAL_WINDOW_DAYS,
  assertTrustedBillingGeo,
  requireActiveUserAndSubscription,
  type LoungeBillingUseCaseConfig,
} from '../domain/loungeBilling.helpers';
import { LOUNGE_PRODUCT_CATALOG_SPECS } from '../domain/loungeCatalog.constants';
import type { ILoungeStripeGatewayPort } from '../ports/loungeStripe.port';
import type { ILoungeBillingRepository } from '../repositories/loungeBilling.repository';
import { parseAndValidateEuWithdrawalRequest } from '../validators/loungeBilling.validator';

/**
 * Use case executing Phase 2 EEA statutory 14-day withdrawal with transactional pre-locking
 * and Stripe outage rollback protection for both one-time credit lots and subscriptions.
 */
export class LoungeBillingEuWithdrawalUseCase {
  constructor(
    private readonly billingRepository: ILoungeBillingRepository,
    private readonly stripeGateway: ILoungeStripeGatewayPort,
    private readonly config: LoungeBillingUseCaseConfig,
  ) {}

  /** Executes statutory Phase 2 EEA 14-day electronic contract withdrawal (`POST /billing/eu-withdrawal`). */
  public async withdrawEuContract(
    uid: string,
    request: LoungeEuWithdrawalRequestDto,
    clientGeo: ResolvedClientGeo,
    traceHeader?: string,
  ): Promise<LoungeEuWithdrawalResponseDto> {
    assertTrustedBillingGeo(this.config.allowDefaultGeoFallback, clientGeo);
    const validated = parseAndValidateEuWithdrawalRequest(request);
    const { user, sub } = await requireActiveUserAndSubscription(this.billingRepository, uid);
    const isEea = Boolean(user.isEeaResident || clientGeo.isEeaResident);

    if (!this.config.phase2EeaEnabled || !isEea) {
      throw new LoungeForbiddenError(
        'Statutory EEA withdrawal is only enabled in Phase 2 EEA regions',
        { code: 'EU_WITHDRAWAL_UNAVAILABLE' },
      );
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const currency: LoungeCurrency =
      sub.billingCurrency ?? user.preferredCurrency ?? clientGeo.currency;

    if (validated.targetType === 'CREDIT_LOT') {
      const preRevoked = await this.billingRepository.preRevokeCreditLotForEuWithdrawalTx({
        uid,
        lotId: validated.targetId,
        now,
      });

      let refundId: string;
      try {
        const refundResult = await this.stripeGateway.createFullRefund({
          paymentIntentId: preRevoked.paymentIntentId,
          idempotencyKey: `eu_withdraw_lot_${preRevoked.previousLot.id}`,
          reason: 'requested_by_customer',
          amountMinor: preRevoked.refundMinor,
        });
        refundId = refundResult.refundId;
      } catch (refundErr) {
        await this.billingRepository.rollbackCreditLotRevocationTx(
          uid,
          preRevoked.previousLot,
          preRevoked.previousSub,
        );
        throw new Error('Stripe credit lot refund failed; rolled back lot revocation', {
          cause: refundErr,
        });
      }

      loungeLogger.info(
        'Completed Phase 2 EEA credit lot withdrawal',
        {
          uid,
          lotId: preRevoked.previousLot.id,
          refundId,
          refundedAmountMinor: preRevoked.refundMinor,
          currency,
          revokedTurns: preRevoked.revokedTurns,
        },
        traceHeader,
      );

      return {
        withdrawnAt: nowIso,
        refundId,
        refundedAmountMinor: preRevoked.refundMinor,
        currency,
        revokedTurns: preRevoked.revokedTurns,
        confirmationChannel: 'STRIPE_RECEIPT_AND_IN_APP',
        subscription: toPublicLoungeSubscription(preRevoked.updatedSub),
      };
    }

    const matchesTarget =
      validated.targetId === ACTIVE_SUBSCRIPTION_WITHDRAWAL_ALIAS ||
      validated.targetId === sub.stripeSubscriptionId;
    if (
      !sub.stripeSubscriptionId ||
      !sub.stripeCustomerId ||
      sub.tier !== 'STANDARD' ||
      (sub.status !== 'ACTIVE' && sub.status !== 'CANCELING') ||
      !matchesTarget
    ) {
      throw new LoungeNotFoundError('Matching active subscription not found for EEA withdrawal');
    }

    const [chargesRes, invoicePaymentIntent, ledgerEntries] = await Promise.all([
      this.stripeGateway.listCharges({ customerId: sub.stripeCustomerId, limit: 20 }),
      sub.lastProcessedInvoiceId
        ? this.stripeGateway.resolvePaymentIntentByInvoice(sub.lastProcessedInvoiceId)
        : Promise.resolve(null),
      this.billingRepository.listRecentQuotaLedger(uid, 100),
    ]);

    const subCharge = chargesRes.charges.find(
      (c) =>
        c.status === 'succeeded' &&
        !c.refunded &&
        ((invoicePaymentIntent && c.paymentIntentId === invoicePaymentIntent) ||
          c.metadata['productId'] === 'STANDARD_MONTHLY'),
    );

    if (subCharge) {
      const chargeCreatedMs = Date.parse(subCharge.createdIso);
      if (!Number.isFinite(chargeCreatedMs)) {
        throw new Error(`Invalid Stripe charge created timestamp "${subCharge.createdIso}"`);
      }
      if (now.getTime() - chargeCreatedMs > EU_WITHDRAWAL_WINDOW_DAYS * DAY_MS) {
        throw new LoungeConflictError('14-day subscription withdrawal window expired');
      }
    }

    let latestUpgradeMs = 0;
    for (const entry of ledgerEntries) {
      const parsedMs = Date.parse(entry.createdAt);
      if (!Number.isFinite(parsedMs)) {
        throw new Error(
          `Invalid quota ledger timestamp "${entry.createdAt}" for uid "${uid}"`,
        );
      }
      if (entry.deltaType === 'UPGRADE_TOPUP' && parsedMs > latestUpgradeMs) {
        latestUpgradeMs = parsedMs;
      }
    }
    const consumedAfterUpgrade =
      latestUpgradeMs > 0 &&
      ledgerEntries.some(
        (e) => e.deltaType === 'RESERVE_DAILY' && Date.parse(e.createdAt) >= latestUpgradeMs,
      );
    if (consumedAfterUpgrade) {
      throw new LoungeConflictError('Subscription daily turns have already been consumed');
    }

    const paymentIntentId = invoicePaymentIntent ?? subCharge?.paymentIntentId;
    if (!paymentIntentId) {
      throw new Error(
        `Active subscription "${sub.stripeSubscriptionId}" is missing initial PaymentIntent for EU withdrawal refund`,
      );
    }

    const refundMinor =
      subCharge?.amount ?? LOUNGE_PRODUCT_CATALOG_SPECS[currency].STANDARD_MONTHLY.unitAmountMinor;
    const expectedSubId = sub.stripeSubscriptionId;

    const preTransitioned = await this.billingRepository.preCancelSubscriptionForEuWithdrawalTx({
      uid,
      expectedSubId,
      userTimezone: user.timezone,
      now,
    });

    try {
      await this.stripeGateway.cancelSubscriptionImmediately(expectedSubId);
    } catch (cancelErr) {
      await this.billingRepository.rollbackSubscriptionCancellationTx(
        uid,
        preTransitioned.previousSub,
      );
      throw new Error('Stripe subscription cancellation failed during EU withdrawal', {
        cause: cancelErr,
      });
    }

    let refundId: string;
    try {
      const refundResult = await this.stripeGateway.createFullRefund({
        paymentIntentId,
        idempotencyKey: `eu_withdraw_sub_${expectedSubId}`,
        reason: 'requested_by_customer',
        amountMinor: refundMinor,
      });
      refundId = refundResult.refundId;
    } catch (refundErr) {
      loungeLogger.error(
        'Stripe refund failed after EU withdrawal subscription cancellation',
        refundErr,
        { uid, subscriptionId: expectedSubId, paymentIntentId },
        traceHeader,
      );
      throw refundErr;
    }

    const revokedTurns = Math.max(
      0,
      preTransitioned.previousSub.dailyRemainingTurns -
        preTransitioned.updatedSub.dailyRemainingTurns,
    );
    loungeLogger.info(
      'Completed Phase 2 EEA subscription withdrawal',
      {
        uid,
        subscriptionId: expectedSubId,
        refundId,
        refundedAmountMinor: refundMinor,
        currency,
        revokedTurns,
      },
      traceHeader,
    );

    return {
      withdrawnAt: nowIso,
      refundId,
      refundedAmountMinor: refundMinor,
      currency,
      revokedTurns,
      confirmationChannel: 'STRIPE_RECEIPT_AND_IN_APP',
      subscription: toPublicLoungeSubscription(preTransitioned.updatedSub),
    };
  }
}
