import type {
  LoungeCreditLotStatus,
  LoungeCurrency,
  LoungeOrderStatus,
  LoungeProcessedEventDoc,
  LoungeProductId,
  LoungeSubscriptionDoc,
  LoungeSubscriptionStatus,
  LoungeTrialGrantDoc,
  LoungeUserDoc,
} from '@rebecca/types';
import { assertActiveLoungeUserStatus } from '../../../domain/loungeAccessPolicy';
import type { ResolvedClientGeo } from '../../../utils/clientGeo';
import { LoungeForbiddenError, LoungeNotFoundError } from '../../../utils/errors';
import { computeAllTrialGrantHashes, type TrialHmacKeyring } from '../../../utils/trialGrantHmac';
import type { LoungeStripeChargeRecord, LoungeStripeSubscriptionSnapshot } from '../ports/loungeStripe.port';
import type { ILoungeBillingRepository } from '../repositories/loungeBilling.repository';
import {
  DEFAULT_LOUNGE_TIMEZONE,
  LOUNGE_PROCESSED_EVENT_TTL_DAYS,
} from './loungeCatalog.constants';

export const SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_]{1,250}$/;
export const CHARGE_ID_PATTERN = /^ch_[A-Za-z0-9_]{1,250}$/;
export const STRIPE_RECEIPT_URL_PATTERN = /^https:\/\/(?:[a-z0-9-]+\.)*stripe\.com(?:\/|$)/i;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const EU_WITHDRAWAL_WINDOW_DAYS = 14;
export const ACTIVE_SUBSCRIPTION_WITHDRAWAL_ALIAS = 'ACTIVE_SUBSCRIPTION';
export const PURCHASABLE_PRODUCT_IDS: readonly Exclude<LoungeProductId, 'WELCOME_BONUS_20'>[] = [
  'TRIAL_TICKET_100',
  'CHARGE_TICKET_100',
  'STANDARD_MONTHLY',
];

/** Narrow billing configuration contract injected from validated application composition. */
export interface LoungeBillingUseCaseConfig {
  readonly loungePublicOrigin: string;
  readonly phase2EeaEnabled: boolean;
  readonly allowDefaultGeoFallback: boolean;
  readonly trialHmacKeyring: TrialHmacKeyring;
  readonly stripeWebhookSecret?: string;
  readonly stripePortalConfigurationId?: string;
  readonly stripePriceIds: Readonly<
    Record<LoungeCurrency, Readonly<Record<Exclude<LoungeProductId, 'WELCOME_BONUS_20'>, string | null>>>
  >;
}

/** Redacts Checkout Session IDs in application logs to avoid exposing bearer-like session handles. */
export function maskCheckoutSessionId(sessionId: string): string {
  if (!sessionId || sessionId.length <= 10) {
    return '***';
  }
  return `${sessionId.slice(0, 6)}...${sessionId.slice(-4)}`;
}

/** Filters active non-expired `lounge_trial_grants` documents (`retainUntil > nowMs`). */
export function filterActiveTrialGrants(
  grants: ReadonlyArray<LoungeTrialGrantDoc | undefined>,
  nowMs: number,
): LoungeTrialGrantDoc[] {
  return grants.filter((g): g is LoungeTrialGrantDoc => {
    if (!g) {
      return false;
    }
    const retainMs = Date.parse(g.retainUntil);
    return Number.isFinite(retainMs) && retainMs > nowMs;
  });
}

/** Enforces presence of a trusted Geo-IP header when fallback mode is disabled (`403 GEO_UNAVAILABLE`). */
export function assertTrustedBillingGeo(
  allowDefaultGeoFallback: boolean,
  clientGeo?: ResolvedClientGeo,
): void {
  if (!allowDefaultGeoFallback && (!clientGeo || !clientGeo.hasTrustedGeoHeader)) {
    throw new LoungeForbiddenError('Regional eligibility could not be verified', {
      code: 'GEO_UNAVAILABLE',
    });
  }
}

/**
 * Loads `lounge_users/{uid}` and `lounge_subscriptions/{uid}`, verifying an active user and existing subscription.
 *
 * @throws LoungeAuthError `401` when profile is missing, `403` when user is not `ACTIVE`.
 * @throws LoungeNotFoundError When `lounge_subscriptions/{uid}` does not exist.
 */
export async function requireActiveUserAndSubscription(
  billingRepository: Pick<ILoungeBillingRepository, 'getUserAndSubscription'>,
  uid: string,
): Promise<{ readonly user: LoungeUserDoc; readonly sub: LoungeSubscriptionDoc }> {
  const { user: rawUser, subscription } = await billingRepository.getUserAndSubscription(uid);
  const user = assertActiveLoungeUserStatus(rawUser, {
    inactiveMessage: 'Private Lounge account is not active',
  });
  if (!subscription) {
    throw new LoungeNotFoundError(`Lounge subscription for "${uid}" was not found`);
  }
  return { user, sub: subscription };
}

/** Evaluates one-time trial ticket eligibility & dispute blocks across active HMAC grant hashes. */
export async function evaluateTrialEligibility(
  billingRepository: Pick<ILoungeBillingRepository, 'findActiveTrialGrants'>,
  keyring: TrialHmacKeyring,
  xUserId: string,
  sub: Pick<LoungeSubscriptionDoc, 'trialTicketUsed'>,
  nowMs: number,
): Promise<{ readonly eligible: boolean; readonly disputeBlocked: boolean }> {
  if (sub.trialTicketUsed) {
    return { eligible: false, disputeBlocked: false };
  }
  const hashes = computeAllTrialGrantHashes(xUserId, keyring);
  const activeGrants = await billingRepository.findActiveTrialGrants(
    hashes.map((h) => h.hash),
    nowMs,
  );
  const disputeBlocked = activeGrants.some((g) => g.riskStatus === 'DISPUTE_BLOCKED');
  const trialUsed = activeGrants.some((g) => Boolean(g.trialTicketGrantedAt));
  return {
    eligible: !disputeBlocked && !trialUsed,
    disputeBlocked,
  };
}

/** Resolves effective locked or Geo-IP currency for checkout & catalog rendering. */
export function resolveBillingCurrency(
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

/** Maps a Stripe Subscription snapshot to internal `LoungeSubscriptionStatus`. */
export function resolveTargetStatusFromStripeSnapshot(
  snapshot: Pick<LoungeStripeSubscriptionSnapshot, 'status' | 'cancelAtPeriodEnd'>,
  isDeletedEvent = false,
): LoungeSubscriptionStatus {
  if (
    isDeletedEvent ||
    snapshot.status === 'canceled' ||
    snapshot.status === 'unpaid' ||
    snapshot.status === 'incomplete_expired'
  ) {
    return 'CANCELED';
  }
  if (snapshot.status === 'past_due') {
    return 'PAST_DUE';
  }
  return snapshot.cancelAtPeriodEnd ? 'CANCELING' : 'ACTIVE';
}

/** Builds an idempotency record for `lounge_processed_events`. */
export function buildProcessedEventDoc(
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

/** Builds a fallback zero-turn canceled subscription projection when a withdrawn webhook arrives. */
export function buildEmptySubscription(uid: string, nowIso: string): LoungeSubscriptionDoc {
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

/** Extracts an expanded or raw Stripe string identifier cleanly. */
export function readStripeId(raw: unknown): string | undefined {
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.trim();
  }
  if (typeof raw === 'object' && raw !== null && 'id' in raw) {
    const id = (raw as { readonly id?: unknown }).id;
    return typeof id === 'string' && id.trim().length > 0 ? id.trim() : undefined;
  }
  return undefined;
}

/** Extracts Stripe Subscription ID from v23 Invoice (`parent.subscription_details.subscription` or legacy `subscription`). */
export function extractSubscriptionIdFromInvoiceObj(
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

/** Resolves order history status from Stripe Charge flags and credit lot revocation state. */
export function resolveOrderStatusFromCharge(
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
