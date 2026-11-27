import crypto from 'node:crypto';
import type {
  LoungeCreditLot,
  LoungeCreditLotDoc,
  LoungeCreditLotStatus,
  LoungeExpiringLotWarningDto,
  LoungeQuotaBreakdownDto,
  LoungeQuotaDeltaType,
  LoungeQuotaLedgerDoc,
  LoungeSubscription,
  LoungeSubscriptionDoc,
  LoungeSubscriptionStatus,
  LoungeSubscriptionTier,
} from '@rebecca/types';
import { toPublicLoungeCreditLot, toPublicLoungeSubscription } from '@rebecca/types';
import { normalizeIanaTimezoneOrDefault } from '../../../utils/locale';
import {
  DEFAULT_LOUNGE_TIMEZONE,
  LOUNGE_DAILY_QUOTA_BY_TIER,
  LOUNGE_QUOTA_LEDGER_TTL_DAYS,
} from './loungeCatalog.constants';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Receipt captured when a chat turn atomically consumes daily or credit-lot quota. */
export interface LoungeTurnReservationReceipt {
  readonly uid: string;
  readonly source: 'DAILY' | 'LOT';
  readonly lotId?: string;
  readonly nextDailyResetAt: string;
  readonly todaysSearchCount: number;
  readonly referenceId: string;
  readonly subscription: LoungeSubscription;
}

/** Result returned when re-evaluating lazy daily reset and intraday credit lot expiration. */
export interface LazyQuotaEvaluationResult {
  readonly mutated: boolean;
  readonly subscription: LoungeSubscriptionDoc;
  readonly activeLots: LoungeCreditLotDoc[];
  readonly expiredLots: LoungeCreditLotDoc[];
  readonly ledgerEntries: LoungeQuotaLedgerDoc[];
}

/** Discriminated pure outcome for atomic chat turn quota reservation. */
export type TurnReservationComputation =
  | {
      readonly kind: 'RESERVED';
      readonly subscription: LoungeSubscriptionDoc;
      readonly updatedLot?: LoungeCreditLotDoc;
      readonly expiredLots: LoungeCreditLotDoc[];
      readonly ledgerEntries: LoungeQuotaLedgerDoc[];
      readonly receipt: LoungeTurnReservationReceipt;
    }
  | {
      readonly kind: 'EXHAUSTED';
      readonly mutated: boolean;
      readonly subscription: LoungeSubscriptionDoc;
      readonly expiredLots: LoungeCreditLotDoc[];
      readonly ledgerEntries: LoungeQuotaLedgerDoc[];
    };

function getZonedYmd(date: Date, timezone: string): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const findNum = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number.parseInt(found.value, 10) : 0;
  };
  return {
    year: findNum('year'),
    month: findNum('month'),
    day: findNum('day'),
  };
}

/**
 * Computes the monotonic UTC ISO-8601 timestamp corresponding to the next local `00:00`
 * (or first valid local instant on DST spring-forward dates skipping midnight) in `timezone`.
 * Uses binary refinement in UTC over calendar day differences so DST transitions never cause drift.
 */
export function nextLocalMidnightAfter(now: Date, rawTimezone: string): string {
  const timezone = normalizeIanaTimezoneOrDefault(rawTimezone, DEFAULT_LOUNGE_TIMEZONE);
  const today = getZonedYmd(now, timezone);
  const targetUtcDate = new Date(Date.UTC(today.year, today.month - 1, today.day + 1, 0, 0, 0, 0));
  const targetYmd = {
    year: targetUtcDate.getUTCFullYear(),
    month: targetUtcDate.getUTCMonth() + 1,
    day: targetUtcDate.getUTCDate(),
  };
  const targetKey = targetYmd.year * 10000 + targetYmd.month * 100 + targetYmd.day;

  // Scan within [-16h, +36h] around UTC target midnight to bracket exact transition minute.
  const baseMs = targetUtcDate.getTime();
  let lowMs = baseMs - 16 * HOUR_MS;
  let highMs = baseMs + 36 * HOUR_MS;

  const dayKey = (ms: number): number => {
    const p = getZonedYmd(new Date(ms), timezone);
    return p.year * 10000 + p.month * 100 + p.day;
  };

  while (highMs - lowMs > 60_000) {
    const midMs = Math.floor((lowMs + highMs) / 2);
    if (dayKey(midMs) >= targetKey) {
      highMs = midMs;
    } else {
      lowMs = midMs;
    }
  }

  // Round to exact start of minute where dayKey reaches targetKey
  let candidateMs = highMs - (highMs % 60_000);
  while (candidateMs > lowMs && dayKey(candidateMs - 60_000) >= targetKey) {
    candidateMs -= 60_000;
  }
  return new Date(candidateMs).toISOString();
}

/**
 * Computes next daily reset anchor while preventing BOTH clock drift and timezone-hopping abuse:
 * - Same timezone: strictly anchored to local `00:00` (`nextLocalMidnightAfter`).
 * - Timezone changed: clamped to at least `lastDailyResetAt + 24h` so users cannot trigger early resets.
 */
export function resolveNextDailyResetIso(
  now: Date,
  lastDailyResetAtIso: string,
  lastQuotaResetTimezone: string,
  currentTimezone: string,
): string {
  const safeCurrentTz = normalizeIanaTimezoneOrDefault(currentTimezone, DEFAULT_LOUNGE_TIMEZONE);
  const safeLastTz = normalizeIanaTimezoneOrDefault(lastQuotaResetTimezone, DEFAULT_LOUNGE_TIMEZONE);
  const midnightIso = nextLocalMidnightAfter(now, safeCurrentTz);
  if (safeCurrentTz === safeLastTz) {
    return midnightIso;
  }
  const midnightMs = Date.parse(midnightIso);
  const lastResetMs = Date.parse(lastDailyResetAtIso);
  if (!Number.isFinite(lastResetMs)) {
    return midnightIso;
  }
  const clampedMs = Math.max(midnightMs, lastResetMs + DAY_MS);
  return new Date(clampedMs).toISOString();
}

/** Builds a 180-day TTL ledger record ready for Firestore persistence. */
export function createQuotaLedgerEntry(params: {
  readonly uid: string;
  readonly deltaType: LoungeQuotaDeltaType;
  readonly deltaDaily: number;
  readonly deltaPurchased: number;
  readonly balanceTotalAfter: number;
  readonly lotId?: string;
  readonly referenceId: string;
  readonly now: Date;
}): LoungeQuotaLedgerDoc {
  const createdAt = params.now.toISOString();
  const expireAt = new Date(
    params.now.getTime() + LOUNGE_QUOTA_LEDGER_TTL_DAYS * DAY_MS,
  ).toISOString();
  return {
    id: `ledger_${crypto.randomUUID()}`,
    uid: params.uid,
    deltaType: params.deltaType,
    deltaDaily: params.deltaDaily,
    deltaPurchased: params.deltaPurchased,
    balanceTotalAfter: Math.max(0, params.balanceTotalAfter),
    ...(params.lotId ? { lotId: params.lotId } : {}),
    referenceId: params.referenceId,
    createdAt,
    expireAt,
  };
}

/** Sorts active credit lots strictly by ascending `expiresAt` (`FIFO`) and aggregates cache fields. */
export function summarizeActiveCreditLots(
  lots: ReadonlyArray<LoungeCreditLotDoc>,
  nowMs: number,
): {
  readonly activeLots: LoungeCreditLotDoc[];
  readonly purchasedRemainingTurns: number;
  readonly earliestLotExpiresAt: string | null;
} {
  const activeLots = lots
    .filter(
      (lot) =>
        lot.status === 'ACTIVE' &&
        lot.remainingTurns > 0 &&
        Date.parse(lot.expiresAt) > nowMs,
    )
    .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));

  const purchasedRemainingTurns = activeLots.reduce(
    (sum, lot) => sum + lot.remainingTurns,
    0,
  );
  const earliestLotExpiresAt =
    activeLots.length > 0 ? activeLots[0].expiresAt : null;

  return {
    activeLots,
    purchasedRemainingTurns,
    earliestLotExpiresAt,
  };
}

/** Computes effective daily turn quota for a tier + subscription status pair. */
export function resolveEffectiveDailyQuota(
  tier: LoungeSubscriptionTier,
  status: LoungeSubscriptionStatus,
): number {
  if (tier === 'STANDARD' && (status === 'ACTIVE' || status === 'CANCELING')) {
    return LOUNGE_DAILY_QUOTA_BY_TIER.STANDARD;
  }
  return LOUNGE_DAILY_QUOTA_BY_TIER.FREE;
}

/** Returns whether a subscription document requires lazy daily reset, lot expiry sweep, or period-end transition at `now`. */
export function needsLazyQuotaSync(sub: LoungeSubscriptionDoc, now: Date = new Date()): boolean {
  const nowMs = now.getTime();
  return (
    nowMs >= Date.parse(sub.nextDailyResetAt) ||
    (sub.earliestLotExpiresAt !== null && nowMs >= Date.parse(sub.earliestLotExpiresAt)) ||
    (sub.status === 'CANCELING' && nowMs >= Date.parse(sub.currentPeriodEnd))
  );
}

/**
 * Pure lazy evaluation of daily quota rollover, canceling subscription expiration,
 * and expired credit lot sweeping (`now >= nextDailyResetAt || now >= earliestLotExpiresAt`).
 */
export function evaluateLazyQuotaState(
  sub: LoungeSubscriptionDoc,
  lots: ReadonlyArray<LoungeCreditLotDoc>,
  userTimezone: string,
  now: Date = new Date(),
): LazyQuotaEvaluationResult {
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const safeTz = normalizeIanaTimezoneOrDefault(userTimezone, DEFAULT_LOUNGE_TIMEZONE);

  let nextTier = sub.tier;
  let nextStatus = sub.status;
  let nextCancelAtPeriodEnd = sub.cancelAtPeriodEnd;
  let nextDailyTurnQuota = sub.dailyTurnQuota;
  let nextDailyRemainingTurns = sub.dailyRemainingTurns;
  let nextTodaysConsumed = sub.todaysConsumedDailyTurns;
  let nextTodaysSearchCount = sub.todaysSearchCount ?? 0;
  let nextLastResetAt = sub.lastDailyResetAt;
  let nextLastResetTz = sub.lastQuotaResetTimezone;
  let nextResetAt = sub.nextDailyResetAt;
  let mutated = false;
  const ledgerEntries: LoungeQuotaLedgerDoc[] = [];

  // 1. Handle period-end expiration of a CANCELING subscription before reset calculations
  const periodEndMs = Date.parse(sub.currentPeriodEnd);
  if (
    nextStatus === 'CANCELING' &&
    Number.isFinite(periodEndMs) &&
    nowMs >= periodEndMs
  ) {
    nextTier = 'FREE';
    nextStatus = 'CANCELED';
    nextCancelAtPeriodEnd = false;
    nextDailyTurnQuota = LOUNGE_DAILY_QUOTA_BY_TIER.FREE;
    nextDailyRemainingTurns = Math.max(0, nextDailyTurnQuota - nextTodaysConsumed);
    mutated = true;
  }

  // 2. Sweep any credit lots whose validity expired (`expiresAt <= now`)
  const expiredLots: LoungeCreditLotDoc[] = [];
  const nextLots = lots.map((lot) => {
    if (lot.status === 'ACTIVE' && Date.parse(lot.expiresAt) <= nowMs) {
      const expired: LoungeCreditLotDoc = { ...lot, status: 'EXPIRED' };
      expiredLots.push(expired);
      mutated = true;
      return expired;
    }
    return lot;
  });

  const { activeLots, purchasedRemainingTurns, earliestLotExpiresAt } =
    summarizeActiveCreditLots(nextLots, nowMs);

  if (
    purchasedRemainingTurns !== sub.purchasedRemainingTurns ||
    earliestLotExpiresAt !== sub.earliestLotExpiresAt
  ) {
    mutated = true;
  }

  // 3. Evaluate lazy daily midnight rollover (`now >= nextDailyResetAt`)
  const resetDueMs = Date.parse(nextResetAt);
  if (!Number.isFinite(resetDueMs) || nowMs >= resetDueMs) {
    const previousDailyRemaining = nextDailyRemainingTurns;
    nextDailyTurnQuota = resolveEffectiveDailyQuota(nextTier, nextStatus);
    nextDailyRemainingTurns = nextDailyTurnQuota;
    nextTodaysConsumed = 0;
    nextTodaysSearchCount = 0;
    nextLastResetAt = nowIso;
    nextResetAt = resolveNextDailyResetIso(
      now,
      sub.lastDailyResetAt,
      sub.lastQuotaResetTimezone,
      safeTz,
    );
    nextLastResetTz = safeTz;
    mutated = true;

    ledgerEntries.push(
      createQuotaLedgerEntry({
        uid: sub.uid,
        deltaType: 'DAILY_RESET',
        deltaDaily: nextDailyRemainingTurns - previousDailyRemaining,
        deltaPurchased: 0,
        balanceTotalAfter: nextDailyRemainingTurns + purchasedRemainingTurns,
        referenceId: `reset_${nowIso.slice(0, 10)}_${safeTz}`,
        now,
      }),
    );
  }

  const nextRemainingChatTurns = nextDailyRemainingTurns + purchasedRemainingTurns;
  if (nextRemainingChatTurns !== sub.remainingChatTurns) {
    mutated = true;
  }

  const updatedSub: LoungeSubscriptionDoc = {
    ...sub,
    tier: nextTier,
    status: nextStatus,
    cancelAtPeriodEnd: nextCancelAtPeriodEnd,
    dailyTurnQuota: nextDailyTurnQuota,
    dailyRemainingTurns: nextDailyRemainingTurns,
    purchasedRemainingTurns,
    remainingChatTurns: nextRemainingChatTurns,
    earliestLotExpiresAt,
    lastDailyResetAt: nextLastResetAt,
    lastQuotaResetTimezone: nextLastResetTz,
    nextDailyResetAt: nextResetAt,
    todaysConsumedDailyTurns: nextTodaysConsumed,
    todaysSearchCount: nextTodaysSearchCount,
    updatedAt: mutated ? nowIso : sub.updatedAt,
  };

  return {
    mutated,
    subscription: updatedSub,
    activeLots,
    expiredLots,
    ledgerEntries,
  };
}

/**
 * Pure computation of a 1-turn reservation (`DAILY` first, FIFO `ACTIVE` credit lot second)
 * following lazy quota/lot rollover at `now`.
 */
export function computeTurnReservation(params: {
  readonly uid: string;
  readonly sub: LoungeSubscriptionDoc;
  readonly activeLots: ReadonlyArray<LoungeCreditLotDoc>;
  readonly userTimezone: string;
  readonly referenceId: string;
  readonly now?: Date;
}): TurnReservationComputation {
  const now = params.now ?? new Date();
  const nowIso = now.toISOString();
  const evaluated = evaluateLazyQuotaState(params.sub, params.activeLots, params.userTimezone, now);
  const baseSub = evaluated.subscription;

  if (baseSub.dailyRemainingTurns > 0) {
    const nextDailyRemaining = baseSub.dailyRemainingTurns - 1;
    const nextTotal = nextDailyRemaining + baseSub.purchasedRemainingTurns;
    const nextSub: LoungeSubscriptionDoc = {
      ...baseSub,
      dailyRemainingTurns: nextDailyRemaining,
      todaysConsumedDailyTurns: baseSub.todaysConsumedDailyTurns + 1,
      remainingChatTurns: nextTotal,
      updatedAt: nowIso,
    };
    const reserveLedger = createQuotaLedgerEntry({
      uid: params.uid,
      deltaType: 'RESERVE_DAILY',
      deltaDaily: -1,
      deltaPurchased: 0,
      balanceTotalAfter: nextTotal,
      referenceId: params.referenceId,
      now,
    });
    return {
      kind: 'RESERVED',
      subscription: nextSub,
      expiredLots: evaluated.expiredLots,
      ledgerEntries: [...evaluated.ledgerEntries, reserveLedger],
      receipt: {
        uid: params.uid,
        source: 'DAILY',
        nextDailyResetAt: nextSub.nextDailyResetAt,
        todaysSearchCount: nextSub.todaysSearchCount ?? 0,
        referenceId: params.referenceId,
        subscription: toPublicLoungeSubscription(nextSub),
      },
    };
  }

  if (evaluated.activeLots.length > 0 && baseSub.purchasedRemainingTurns > 0) {
    const targetLot = evaluated.activeLots[0];
    const nextLotRemaining = targetLot.remainingTurns - 1;
    const nextLotStatus: LoungeCreditLotStatus = nextLotRemaining <= 0 ? 'EXHAUSTED' : 'ACTIVE';
    const updatedLot: LoungeCreditLotDoc = {
      ...targetLot,
      remainingTurns: nextLotRemaining,
      status: nextLotStatus,
    };
    const updatedLots = evaluated.activeLots.map((l) => (l.id === updatedLot.id ? updatedLot : l));
    const resummarized = summarizeActiveCreditLots(updatedLots, now.getTime());
    const nextTotal = baseSub.dailyRemainingTurns + resummarized.purchasedRemainingTurns;
    const nextSub: LoungeSubscriptionDoc = {
      ...baseSub,
      purchasedRemainingTurns: resummarized.purchasedRemainingTurns,
      earliestLotExpiresAt: resummarized.earliestLotExpiresAt,
      remainingChatTurns: nextTotal,
      updatedAt: nowIso,
    };
    const reserveLedger = createQuotaLedgerEntry({
      uid: params.uid,
      deltaType: 'RESERVE_LOT',
      deltaDaily: 0,
      deltaPurchased: -1,
      balanceTotalAfter: nextTotal,
      lotId: targetLot.id,
      referenceId: params.referenceId,
      now,
    });
    return {
      kind: 'RESERVED',
      subscription: nextSub,
      updatedLot,
      expiredLots: evaluated.expiredLots,
      ledgerEntries: [...evaluated.ledgerEntries, reserveLedger],
      receipt: {
        uid: params.uid,
        source: 'LOT',
        lotId: targetLot.id,
        nextDailyResetAt: nextSub.nextDailyResetAt,
        todaysSearchCount: nextSub.todaysSearchCount ?? 0,
        referenceId: params.referenceId,
        subscription: toPublicLoungeSubscription(nextSub),
      },
    };
  }

  return {
    kind: 'EXHAUSTED',
    mutated: evaluated.mutated,
    subscription: baseSub,
    expiredLots: evaluated.expiredLots,
    ledgerEntries: evaluated.ledgerEntries,
  };
}

/**
 * Pure compensation calculation for a previously reserved `DAILY` turn.
 * Returns `null` when the quota reset window has already rolled over to prevent inflating tomorrow's balance.
 */
export function computeDailyTurnCompensation(params: {
  readonly sub: LoungeSubscriptionDoc;
  readonly receipt: LoungeTurnReservationReceipt;
  readonly now?: Date;
}): {
  readonly subscription: LoungeSubscriptionDoc;
  readonly ledgerEntry: LoungeQuotaLedgerDoc;
} | null {
  if (params.sub.nextDailyResetAt !== params.receipt.nextDailyResetAt) {
    return null;
  }
  const now = params.now ?? new Date();
  const nextConsumed = Math.max(0, params.sub.todaysConsumedDailyTurns - 1);
  const nextDailyRemaining = Math.max(0, params.sub.dailyTurnQuota - nextConsumed);
  const deltaDaily = nextDailyRemaining - params.sub.dailyRemainingTurns;
  const nextTotal = nextDailyRemaining + params.sub.purchasedRemainingTurns;
  const subscription: LoungeSubscriptionDoc = {
    ...params.sub,
    todaysConsumedDailyTurns: nextConsumed,
    dailyRemainingTurns: nextDailyRemaining,
    remainingChatTurns: nextTotal,
    updatedAt: now.toISOString(),
  };
  const ledgerEntry = createQuotaLedgerEntry({
    uid: params.receipt.uid,
    deltaType: 'COMPENSATION_REFUND',
    deltaDaily,
    deltaPurchased: 0,
    balanceTotalAfter: nextTotal,
    referenceId: params.receipt.referenceId,
    now,
  });
  return { subscription, ledgerEntry };
}

/**
 * Pure compensation calculation for a previously reserved `LOT` turn.
 * Returns `null` if the lot has been revoked or expired so withdrawn/expired turns are never revived.
 */
export function computeLotTurnCompensation(params: {
  readonly sub: LoungeSubscriptionDoc;
  readonly targetLot: LoungeCreditLotDoc;
  readonly activeLots: ReadonlyArray<LoungeCreditLotDoc>;
  readonly receipt: LoungeTurnReservationReceipt;
  readonly now?: Date;
}): {
  readonly updatedLot: LoungeCreditLotDoc;
  readonly subscription: LoungeSubscriptionDoc;
  readonly ledgerEntry: LoungeQuotaLedgerDoc;
} | null {
  const now = params.now ?? new Date();
  const nowMs = now.getTime();
  if (
    params.targetLot.status === 'REVOKED' ||
    params.targetLot.status === 'EXPIRED' ||
    Date.parse(params.targetLot.expiresAt) <= nowMs
  ) {
    return null;
  }

  const nextLotRemaining = Math.min(
    params.targetLot.initialTurns,
    params.targetLot.remainingTurns + 1,
  );
  const updatedLot: LoungeCreditLotDoc = {
    ...params.targetLot,
    remainingTurns: nextLotRemaining,
    status: 'ACTIVE',
  };

  const mergedLots = params.activeLots
    .map((lot) => (lot.id === updatedLot.id ? updatedLot : lot))
    .concat(params.activeLots.some((lot) => lot.id === updatedLot.id) ? [] : [updatedLot]);

  const summary = summarizeActiveCreditLots(mergedLots, nowMs);
  const nextTotal = params.sub.dailyRemainingTurns + summary.purchasedRemainingTurns;
  const subscription: LoungeSubscriptionDoc = {
    ...params.sub,
    purchasedRemainingTurns: summary.purchasedRemainingTurns,
    earliestLotExpiresAt: summary.earliestLotExpiresAt,
    remainingChatTurns: nextTotal,
    updatedAt: now.toISOString(),
  };
  const ledgerEntry = createQuotaLedgerEntry({
    uid: params.receipt.uid,
    deltaType: 'COMPENSATION_REFUND',
    deltaDaily: 0,
    deltaPurchased: subscription.purchasedRemainingTurns - params.sub.purchasedRemainingTurns,
    balanceTotalAfter: nextTotal,
    lotId: updatedLot.id,
    referenceId: params.receipt.referenceId,
    now,
  });
  return { updatedLot, subscription, ledgerEntry };
}

/**
 * Transitions daily quota allowances across midday subscription upgrades (`FREE -> STANDARD`)
 * or downgrades (`STANDARD -> FREE` / `PAST_DUE`), preserving consumed turns for the current day.
 */
export function applySubscriptionTransition(
  sub: LoungeSubscriptionDoc,
  lots: ReadonlyArray<LoungeCreditLotDoc>,
  userTimezone: string,
  targetTier: LoungeSubscriptionTier,
  targetStatus: LoungeSubscriptionStatus,
  now: Date = new Date(),
  overrides: Partial<
    Pick<
      LoungeSubscriptionDoc,
      | 'billingCurrency'
      | 'stripeCustomerId'
      | 'stripeSubscriptionId'
      | 'stripeScheduleId'
      | 'lastProcessedInvoiceId'
      | 'currentPeriodEnd'
      | 'trialTicketUsed'
      | 'cancelAtPeriodEnd'
    >
  > = {},
): {
  readonly subscription: LoungeSubscriptionDoc;
  readonly expiredLots: LoungeCreditLotDoc[];
  readonly ledgerEntries: LoungeQuotaLedgerDoc[];
} {
  const lazy = evaluateLazyQuotaState(sub, lots, userTimezone, now);
  const current = lazy.subscription;
  const newDailyQuota = resolveEffectiveDailyQuota(targetTier, targetStatus);
  const newDailyRemaining = Math.max(0, newDailyQuota - current.todaysConsumedDailyTurns);
  const nowIso = now.toISOString();
  const nextRemainingTotal = newDailyRemaining + current.purchasedRemainingTurns;

  const updatedSub: LoungeSubscriptionDoc = {
    ...current,
    ...overrides,
    tier: targetTier,
    status: targetStatus,
    dailyTurnQuota: newDailyQuota,
    dailyRemainingTurns: newDailyRemaining,
    remainingChatTurns: nextRemainingTotal,
    updatedAt: nowIso,
  };

  const ledgerEntries = [...lazy.ledgerEntries];
  if (newDailyRemaining !== current.dailyRemainingTurns) {
    ledgerEntries.push(
      createQuotaLedgerEntry({
        uid: current.uid,
        deltaType: newDailyRemaining > current.dailyRemainingTurns ? 'UPGRADE_TOPUP' : 'REFUND_CLAWBACK',
        deltaDaily: newDailyRemaining - current.dailyRemainingTurns,
        deltaPurchased: 0,
        balanceTotalAfter: nextRemainingTotal,
        referenceId: overrides.lastProcessedInvoiceId ?? `transition_${nowIso}`,
        now,
      }),
    );
  }

  return {
    subscription: updatedSub,
    expiredLots: lazy.expiredLots,
    ledgerEntries,
  };
}

/** Builds billing Tab 2 quota breakdown + proactive 14d / 3d lot expiration reminder. */
export function buildQuotaBreakdownAndWarning(
  sub: LoungeSubscription,
  activeLots: ReadonlyArray<LoungeCreditLotDoc>,
  phase2EuWithdrawalEligible = false,
  now: Date = new Date(),
): {
  readonly quotaBreakdown: LoungeQuotaBreakdownDto;
  readonly expiringSoonWarning?: LoungeExpiringLotWarningDto;
} {
  const sortedActive = [...activeLots]
    .filter((l) => l.status === 'ACTIVE' && l.remainingTurns > 0 && Date.parse(l.expiresAt) > now.getTime())
    .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));

  const publicLots: LoungeCreditLot[] = sortedActive.map(toPublicLoungeCreditLot);
  const quotaBreakdown: LoungeQuotaBreakdownDto = {
    dailyTurnQuota: sub.dailyTurnQuota,
    dailyRemainingTurns: sub.dailyRemainingTurns,
    purchasedRemainingTurns: sub.purchasedRemainingTurns,
    remainingChatTurns: sub.remainingChatTurns,
    activeLots: publicLots,
    nextDailyResetAt: sub.nextDailyResetAt,
    consumptionOrder: ['DAILY', 'LOT_FIFO'],
    ...(phase2EuWithdrawalEligible ? { phase2EuWithdrawalEligible: true } : {}),
  };

  let expiringSoonWarning: LoungeExpiringLotWarningDto | undefined;
  if (sortedActive.length > 0) {
    const earliest = sortedActive[0];
    const diffMs = Date.parse(earliest.expiresAt) - now.getTime();
    const hoursRemaining = Math.max(1, Math.ceil(diffMs / HOUR_MS));
    if (diffMs > 0 && diffMs <= 14 * DAY_MS) {
      expiringSoonWarning = {
        hoursRemaining,
        expiringTurns: earliest.remainingTurns,
        expiresAt: earliest.expiresAt,
      };
    }
  }

  return {
    quotaBreakdown,
    ...(expiringSoonWarning ? { expiringSoonWarning } : {}),
  };
}
