import crypto from 'node:crypto';
import type { Firestore, Timestamp, Transaction } from '@google-cloud/firestore';
import { COLLECTIONS, type DbCollections } from '@rebecca/db';
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
import {
  DEFAULT_LOUNGE_TIMEZONE,
  LOUNGE_DAILY_QUOTA_BY_TIER,
  LOUNGE_QUOTA_LEDGER_TTL_DAYS,
} from '../../../config/loungeConfig';
import { LoungeQuotaExhaustedError } from '../../../utils/errors';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Receipt captured when a chat turn atomically consumes daily or credit-lot quota. */
export interface LoungeTurnReservationReceipt {
  readonly uid: string;
  readonly source: 'DAILY' | 'LOT';
  readonly lotId?: string;
  readonly nextDailyResetAt: string;
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

function getZonedPartsForCheck(date: Date, timezone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const findNum = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number.parseInt(found.value, 10) : 0;
  };
  const rawHour = findNum('hour');
  return {
    year: findNum('year'),
    month: findNum('month'),
    day: findNum('day'),
    hour: rawHour === 24 ? 0 : rawHour,
    minute: findNum('minute'),
  };
}

function safeTimezone(timezone: string | undefined): string {
  const candidate = timezone?.trim();
  if (!candidate) {
    return DEFAULT_LOUNGE_TIMEZONE;
  }
  try {
    Intl.DateTimeFormat(undefined, { timeZone: candidate });
    return candidate;
  } catch {
    return DEFAULT_LOUNGE_TIMEZONE;
  }
}

/**
 * Computes the monotonic UTC ISO-8601 timestamp corresponding to the next local `00:00`
 * (or first valid local instant on DST spring-forward dates skipping midnight) in `timezone`.
 * Uses binary refinement in UTC over calendar day differences so DST transitions never cause drift.
 */
export function nextLocalMidnightAfter(now: Date, rawTimezone: string): string {
  const timezone = safeTimezone(rawTimezone);
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
  const verify = getZonedPartsForCheck(new Date(candidateMs), timezone);
  if (verify.hour > 1 && dayKey(candidateMs - HOUR_MS) >= targetKey) {
    candidateMs -= HOUR_MS;
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
  const safeCurrentTz = safeTimezone(currentTimezone);
  const safeLastTz = safeTimezone(lastQuotaResetTimezone);
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
  const safeTz = safeTimezone(userTimezone);

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

/**
 * Firestore-backed transactional quota coordinator handling lazy evaluation,
 * atomic per-turn FIFO deduction, and conditional AI-failure compensation.
 */
export class LoungeQuotaEngine {
  constructor(
    private readonly firestore: Firestore,
    private readonly collections: Pick<
      DbCollections,
      'loungeUsers' | 'loungeSubscriptions' | 'loungeCreditLots' | 'loungeQuotaLedger'
    >,
  ) {}

  /**
   * Synchronizes lazy daily reset and intraday lot expirations for `uid` in a Firestore transaction.
   * Invoked on startup/hydration (`GET /account`), `GET /billing/subscription`, and pre-turn reservation.
   */
  public async syncLazyState(
    uid: string,
    userTimezone: string,
    now: Date = new Date(),
  ): Promise<{
    readonly subscription: LoungeSubscriptionDoc;
    readonly activeLots: LoungeCreditLotDoc[];
  } | null> {
    return this.firestore.runTransaction(async (tx: Transaction) => {
      const subRef = this.collections.loungeSubscriptions.doc(uid);
      const lotsQuery = this.collections.loungeCreditLots
        .where('uid', '==', uid)
        .where('status', '==', 'ACTIVE');

      const [subSnap, lotsSnap] = await Promise.all([tx.get(subRef), tx.get(lotsQuery)]);
      if (!subSnap.exists) {
        return null;
      }
      const currentSub = subSnap.data();
      if (!currentSub) {
        return null;
      }
      const lots = lotsSnap.docs.map((d) => d.data());
      const nowMs = now.getTime();
      const needsSync =
        nowMs >= Date.parse(currentSub.nextDailyResetAt) ||
        (currentSub.earliestLotExpiresAt !== null &&
          nowMs >= Date.parse(currentSub.earliestLotExpiresAt)) ||
        (currentSub.status === 'CANCELING' && nowMs >= Date.parse(currentSub.currentPeriodEnd));

      if (!needsSync) {
        const summary = summarizeActiveCreditLots(lots, nowMs);
        return { subscription: currentSub, activeLots: summary.activeLots };
      }

      const evaluation = evaluateLazyQuotaState(currentSub, lots, userTimezone, now);
      if (evaluation.mutated) {
        tx.set(subRef, evaluation.subscription);
        for (const expired of evaluation.expiredLots) {
          tx.set(this.collections.loungeCreditLots.doc(expired.id), expired);
        }
        for (const ledger of evaluation.ledgerEntries) {
          tx.set(this.collections.loungeQuotaLedger.doc(ledger.id), ledger);
        }
      }
      return { subscription: evaluation.subscription, activeLots: evaluation.activeLots };
    });
  }

  /**
   * Atomically reserves 1 chat turn (`DAILY` first, then FIFO `ACTIVE` credit lot) inside a transaction.
   *
   * @throws LoungeQuotaExhaustedError When neither daily nor active ticket balance remains (`429`).
   */
  public async reserveTurn(
    uid: string,
    userTimezone: string,
    referenceId: string,
    now: Date = new Date(),
  ): Promise<LoungeTurnReservationReceipt> {
    return this.firestore.runTransaction(async (tx: Transaction) => {
      const subRef = this.collections.loungeSubscriptions.doc(uid);
      const lotsQuery = this.collections.loungeCreditLots
        .where('uid', '==', uid)
        .where('status', '==', 'ACTIVE');

      const [subSnap, lotsSnap] = await Promise.all([tx.get(subRef), tx.get(lotsQuery)]);
      const currentSub = subSnap.data();
      if (!subSnap.exists || !currentSub) {
        throw new Error(`Lounge subscription missing for "${uid}"`);
      }

      const lots = lotsSnap.docs.map((d) => d.data());
      const evaluated = evaluateLazyQuotaState(currentSub, lots, userTimezone, now);
      for (const expired of evaluated.expiredLots) {
        tx.set(this.collections.loungeCreditLots.doc(expired.id), expired);
      }
      for (const ledger of evaluated.ledgerEntries) {
        tx.set(this.collections.loungeQuotaLedger.doc(ledger.id), ledger);
      }

      const baseSub = evaluated.subscription;
      const nowIso = now.toISOString();

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
          uid,
          deltaType: 'RESERVE_DAILY',
          deltaDaily: -1,
          deltaPurchased: 0,
          balanceTotalAfter: nextTotal,
          referenceId,
          now,
        });
        tx.set(subRef, nextSub);
        tx.set(this.collections.loungeQuotaLedger.doc(reserveLedger.id), reserveLedger);
        return {
          uid,
          source: 'DAILY',
          nextDailyResetAt: nextSub.nextDailyResetAt,
          referenceId,
          subscription: toPublicLoungeSubscription(nextSub),
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
          uid,
          deltaType: 'RESERVE_LOT',
          deltaDaily: 0,
          deltaPurchased: -1,
          balanceTotalAfter: nextTotal,
          lotId: targetLot.id,
          referenceId,
          now,
        });
        tx.set(this.collections.loungeCreditLots.doc(targetLot.id), updatedLot);
        tx.set(subRef, nextSub);
        tx.set(this.collections.loungeQuotaLedger.doc(reserveLedger.id), reserveLedger);
        return {
          uid,
          source: 'LOT',
          lotId: targetLot.id,
          nextDailyResetAt: nextSub.nextDailyResetAt,
          referenceId,
          subscription: toPublicLoungeSubscription(nextSub),
        };
      }

      if (evaluated.mutated) {
        tx.set(subRef, baseSub);
      }
      throw new LoungeQuotaExhaustedError('Daily and purchased chat turn quota exhausted', {
        code: 'QUOTA_EXHAUSTED',
        meta: {
          nextDailyResetAt: baseSub.nextDailyResetAt,
        },
      });
    });
  }

  /**
   * Conditionally refunds a previously reserved turn when AI generation or message persistence fails.
   * Daily turns are only restored if the quota day has not rolled over; expired lots are not revived.
   */
  public async compensateTurn(
    receipt: LoungeTurnReservationReceipt,
    now: Date = new Date(),
  ): Promise<void> {
    await this.firestore.runTransaction(async (tx: Transaction) => {
      const subRef = this.collections.loungeSubscriptions.doc(receipt.uid);
      const subSnap = await tx.get(subRef);
      const currentSub = subSnap.data();
      if (!subSnap.exists || !currentSub) {
        return;
      }

      const nowMs = now.getTime();
      const nowIso = now.toISOString();

      if (receipt.source === 'DAILY') {
        // Skip restoring into a brand-new reset window to avoid inflating tomorrow's quota
        if (currentSub.nextDailyResetAt !== receipt.nextDailyResetAt) {
          return;
        }
        const nextConsumed = Math.max(0, currentSub.todaysConsumedDailyTurns - 1);
        const nextDailyRemaining = Math.max(0, currentSub.dailyTurnQuota - nextConsumed);
        const deltaDaily = nextDailyRemaining - currentSub.dailyRemainingTurns;
        const nextTotal = nextDailyRemaining + currentSub.purchasedRemainingTurns;
        const nextSub: LoungeSubscriptionDoc = {
          ...currentSub,
          todaysConsumedDailyTurns: nextConsumed,
          dailyRemainingTurns: nextDailyRemaining,
          remainingChatTurns: nextTotal,
          updatedAt: nowIso,
        };
        const ledger = createQuotaLedgerEntry({
          uid: receipt.uid,
          deltaType: 'COMPENSATION_REFUND',
          deltaDaily,
          deltaPurchased: 0,
          balanceTotalAfter: nextTotal,
          referenceId: receipt.referenceId,
          now,
        });
        tx.set(subRef, nextSub);
        tx.set(this.collections.loungeQuotaLedger.doc(ledger.id), ledger);
        return;
      }

      if (!receipt.lotId) {
        return;
      }
      const lotRef = this.collections.loungeCreditLots.doc(receipt.lotId);
      const lotSnap = await tx.get(lotRef);
      const currentLot = lotSnap.data();
      if (!lotSnap.exists || !currentLot) {
        return;
      }
      if (currentLot.status === 'REVOKED' || currentLot.status === 'EXPIRED' || Date.parse(currentLot.expiresAt) <= nowMs) {
        return;
      }

      const nextLotRemaining = Math.min(currentLot.initialTurns, currentLot.remainingTurns + 1);
      const updatedLot: LoungeCreditLotDoc = {
        ...currentLot,
        remainingTurns: nextLotRemaining,
        status: 'ACTIVE',
      };

      const activeQuery = this.collections.loungeCreditLots
        .where('uid', '==', receipt.uid)
        .where('status', '==', 'ACTIVE');
      const activeSnap = await tx.get(activeQuery);
      const activeLots = activeSnap.docs
        .map((d) => (d.id === updatedLot.id ? updatedLot : d.data()))
        .concat(activeSnap.docs.some((d) => d.id === updatedLot.id) ? [] : [updatedLot]);

      const summary = summarizeActiveCreditLots(activeLots, nowMs);
      const nextTotal = currentSub.dailyRemainingTurns + summary.purchasedRemainingTurns;
      const nextSub: LoungeSubscriptionDoc = {
        ...currentSub,
        purchasedRemainingTurns: summary.purchasedRemainingTurns,
        earliestLotExpiresAt: summary.earliestLotExpiresAt,
        remainingChatTurns: nextTotal,
        updatedAt: nowIso,
      };
      const ledger = createQuotaLedgerEntry({
        uid: receipt.uid,
        deltaType: 'COMPENSATION_REFUND',
        deltaDaily: 0,
        deltaPurchased: nextSub.purchasedRemainingTurns - currentSub.purchasedRemainingTurns,
        balanceTotalAfter: nextTotal,
        lotId: updatedLot.id,
        referenceId: receipt.referenceId,
        now,
      });

      tx.set(lotRef, updatedLot);
      tx.set(subRef, nextSub);
      tx.set(this.collections.loungeQuotaLedger.doc(ledger.id), ledger);
    });
  }
}

export { COLLECTIONS };
export type { Timestamp };
