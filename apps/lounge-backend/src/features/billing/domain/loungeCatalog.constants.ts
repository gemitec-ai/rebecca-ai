import type { LoungeCurrency, LoungeProductId } from '@rebecca/types';

/** Default IANA timezone used strictly for initial provisioning defaults or explicit migration recovery. */
export const DEFAULT_LOUNGE_TIMEZONE = 'Asia/Tokyo';

/** Billing lot validity duration in days (180-day statutory PSA exemption ceiling). */
export const LOUNGE_CREDIT_LOT_VALIDITY_DAYS = 180;

/** Initial welcome bonus turns granted once per X identity. */
export const LOUNGE_WELCOME_BONUS_CREDITS = 20;

/** Standard monthly subscription daily turn allowance. */
export const LOUNGE_STANDARD_MONTHLY_CREDITS = 100;

/** Paid ticket bundle turn grants. */
export const LOUNGE_TICKET_PACK_TURNS = 100;

/** Non-PII anti-fraud grant retention horizon in years (3 calendar years). */
export const LOUNGE_TRIAL_GRANT_RETENTION_YEARS = 3;

/**
 * Computes the UTC ISO-8601 retention deadline exactly `years` calendar years after `now`.
 * Accounts for leap years and clamps Feb 29 cleanly to Feb 28 in non-leap target years.
 */
export function computeTrialGrantRetainUntilIso(
  now: Date,
  years: number = LOUNGE_TRIAL_GRANT_RETENTION_YEARS,
): string {
  const targetYear = now.getUTCFullYear() + years;
  const targetMonth = now.getUTCMonth();
  const maxDayInMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(now.getUTCDate(), maxDayInMonth);
  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      clampedDay,
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    ),
  ).toISOString();
}

/** Ledger retention TTL in days (180 days). */
export const LOUNGE_QUOTA_LEDGER_TTL_DAYS = 180;

/** Webhook processed-event retention TTL in days (90 days). */
export const LOUNGE_PROCESSED_EVENT_TTL_DAYS = 90;

/** Daily quota allowance per membership tier. */
export const LOUNGE_DAILY_QUOTA_BY_TIER = {
  FREE: 5,
  STANDARD: 100,
} as const;

/** Daily Gemini 3 Google Search grounding execution limits per entitlement class. */
export const LOUNGE_DAILY_SEARCH_QUOTA_FREE = 2;
export const LOUNGE_DAILY_SEARCH_QUOTA_PAID = 3;
export const LOUNGE_DAILY_SEARCH_LIMITS = {
  FREE: LOUNGE_DAILY_SEARCH_QUOTA_FREE,
  PAID_OR_STANDARD: LOUNGE_DAILY_SEARCH_QUOTA_PAID,
} as const;

/** ISO-3166-1 alpha-2 country codes belonging to EEA + UK + Switzerland for Phase 1/2 compliance gating. */
export const EEA_UK_CH_COUNTRY_CODES: ReadonlySet<string> = new Set<string>([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IS', 'IE', 'IT', 'LV', 'LI', 'LT', 'LU',
  'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'GB', 'CH',
]);

/** Immutable product pricing metadata indexed by billing currency and purchasable product ID. */
export interface LoungeCurrencyProductSpec {
  readonly unitAmountMinor: number;
  readonly formattedPrice: string;
  readonly grantedTurns: number;
  readonly validityDays: number | null;
  readonly mode: 'payment' | 'subscription';
  readonly taxInclusive: boolean;
  readonly promotionCodesAllowed: boolean;
  readonly priceIdEnvKey: string;
}

/** Static price & allowance specification table across `JPY` (zero-decimal) and `USD` (cents). */
export const LOUNGE_PRODUCT_CATALOG_SPECS: Readonly<
  Record<
    LoungeCurrency,
    Readonly<Record<Exclude<LoungeProductId, 'WELCOME_BONUS_20'>, LoungeCurrencyProductSpec>>
  >
> = {
  JPY: {
    TRIAL_TICKET_100: {
      unitAmountMinor: 200,
      formattedPrice: '¥200',
      grantedTurns: LOUNGE_TICKET_PACK_TURNS,
      validityDays: LOUNGE_CREDIT_LOT_VALIDITY_DAYS,
      mode: 'payment',
      taxInclusive: true,
      promotionCodesAllowed: false,
      priceIdEnvKey: 'STRIPE_PRICE_TRIAL_JPY',
    },
    CHARGE_TICKET_100: {
      unitAmountMinor: 500,
      formattedPrice: '¥500',
      grantedTurns: LOUNGE_TICKET_PACK_TURNS,
      validityDays: LOUNGE_CREDIT_LOT_VALIDITY_DAYS,
      mode: 'payment',
      taxInclusive: true,
      promotionCodesAllowed: true,
      priceIdEnvKey: 'STRIPE_PRICE_CHARGE_JPY',
    },
    STANDARD_MONTHLY: {
      unitAmountMinor: 1400,
      formattedPrice: '¥1,400',
      grantedTurns: LOUNGE_STANDARD_MONTHLY_CREDITS,
      validityDays: null,
      mode: 'subscription',
      taxInclusive: true,
      promotionCodesAllowed: false,
      priceIdEnvKey: 'STRIPE_PRICE_STANDARD_JPY',
    },
  },
  USD: {
    TRIAL_TICKET_100: {
      unitAmountMinor: 150,
      formattedPrice: '$1.50',
      grantedTurns: LOUNGE_TICKET_PACK_TURNS,
      validityDays: LOUNGE_CREDIT_LOT_VALIDITY_DAYS,
      mode: 'payment',
      taxInclusive: false,
      promotionCodesAllowed: false,
      priceIdEnvKey: 'STRIPE_PRICE_TRIAL_USD',
    },
    CHARGE_TICKET_100: {
      unitAmountMinor: 350,
      formattedPrice: '$3.50',
      grantedTurns: LOUNGE_TICKET_PACK_TURNS,
      validityDays: LOUNGE_CREDIT_LOT_VALIDITY_DAYS,
      mode: 'payment',
      taxInclusive: false,
      promotionCodesAllowed: true,
      priceIdEnvKey: 'STRIPE_PRICE_CHARGE_USD',
    },
    STANDARD_MONTHLY: {
      unitAmountMinor: 950,
      formattedPrice: '$9.50',
      grantedTurns: LOUNGE_STANDARD_MONTHLY_CREDITS,
      validityDays: null,
      mode: 'subscription',
      taxInclusive: false,
      promotionCodesAllowed: false,
      priceIdEnvKey: 'STRIPE_PRICE_STANDARD_USD',
    },
  },
};
