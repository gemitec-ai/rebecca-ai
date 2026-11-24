import crypto from 'node:crypto';
import type {
  LoungeCurrency,
  LoungeFirebaseWebConfig,
  LoungeProductId,
} from '@rebecca/types';
import { LoungeValidationError } from '../utils/errors';

/** Default IANA fallback timezone when none is provided or configured. */
export const DEFAULT_LOUNGE_TIMEZONE = 'Asia/Tokyo';

/** Billing lot validity duration in days (180-day statutory PSA exemption ceiling). */
export const LOUNGE_CREDIT_LOT_VALIDITY_DAYS = 180;

/** Non-PII anti-fraud grant retention horizon in days (3 years). */
export const LOUNGE_TRIAL_GRANT_RETENTION_DAYS = 365 * 3;

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
export const LOUNGE_DAILY_SEARCH_LIMITS = {
  FREE: 2,
  PAID_OR_STANDARD: 3,
} as const;

/** Iso-3166-1 alpha-2 country codes belonging to EEA + UK + Switzerland for Phase 2 compliance gating. */
export const EEA_UK_CH_COUNTRY_CODES = new Set<string>([
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
      grantedTurns: 100,
      validityDays: LOUNGE_CREDIT_LOT_VALIDITY_DAYS,
      mode: 'payment',
      taxInclusive: true,
      promotionCodesAllowed: false,
      priceIdEnvKey: 'STRIPE_PRICE_TRIAL_JPY',
    },
    CHARGE_TICKET_100: {
      unitAmountMinor: 500,
      formattedPrice: '¥500',
      grantedTurns: 100,
      validityDays: LOUNGE_CREDIT_LOT_VALIDITY_DAYS,
      mode: 'payment',
      taxInclusive: true,
      promotionCodesAllowed: true,
      priceIdEnvKey: 'STRIPE_PRICE_CHARGE_JPY',
    },
    STANDARD_MONTHLY: {
      unitAmountMinor: 1400,
      formattedPrice: '¥1,400',
      grantedTurns: 100,
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
      grantedTurns: 100,
      validityDays: LOUNGE_CREDIT_LOT_VALIDITY_DAYS,
      mode: 'payment',
      taxInclusive: false,
      promotionCodesAllowed: false,
      priceIdEnvKey: 'STRIPE_PRICE_TRIAL_USD',
    },
    CHARGE_TICKET_100: {
      unitAmountMinor: 350,
      formattedPrice: '$3.50',
      grantedTurns: 100,
      validityDays: LOUNGE_CREDIT_LOT_VALIDITY_DAYS,
      mode: 'payment',
      taxInclusive: false,
      promotionCodesAllowed: true,
      priceIdEnvKey: 'STRIPE_PRICE_CHARGE_USD',
    },
    STANDARD_MONTHLY: {
      unitAmountMinor: 950,
      formattedPrice: '$9.50',
      grantedTurns: 100,
      validityDays: null,
      mode: 'subscription',
      taxInclusive: false,
      promotionCodesAllowed: false,
      priceIdEnvKey: 'STRIPE_PRICE_STANDARD_USD',
    },
  },
};

const LIVE_STRIPE_KEY_PREFIXES = ['sk_live_', 'rk_live_', 'pk_live_'] as const;
const STRIPE_KEY_ENV_NAMES = [
  'STRIPE_SECRET_KEY',
  'STRIPE_PUBLISHABLE_KEY',
  'LOUNGE_STRIPE_SECRET_KEY',
  'LOUNGE_STRIPE_PUBLISHABLE_KEY',
] as const;

/**
 * Enforces the Stripe test-key invariant across all non-production environments.
 * Fails fast on startup if a live Stripe secret, restricted, or publishable key is supplied outside `production`.
 *
 * @throws Error When any Stripe key carries a `*_live_` prefix while `NODE_ENV !== 'production'`.
 */
export function assertSafeStripeKeyConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  const nodeEnv = env['NODE_ENV']?.trim();
  if (nodeEnv === 'production') {
    return;
  }
  for (const keyName of STRIPE_KEY_ENV_NAMES) {
    const raw = env[keyName]?.trim();
    if (!raw) {
      continue;
    }
    if (LIVE_STRIPE_KEY_PREFIXES.some((prefix) => raw.startsWith(prefix))) {
      throw new Error(
        `Refusing live Stripe key in ${keyName} while NODE_ENV="${nodeEnv ?? 'undefined'}". Use sk_test_/rk_test_/pk_test_ keys outside production.`,
      );
    }
  }
}

/**
 * Resolved Geo-IP origin and currency lock state derived strictly from server headers and stored locks.
 * Never consumes client-mutable UI `language`.
 */
export interface ResolvedClientGeo {
  readonly countryCode: string;
  readonly isEeaResident: boolean;
  readonly currency: LoungeCurrency;
}

/**
 * Resolves the authoritative ISO country code, EEA/UK/CH residency flag, and billing currency
 * from trusted Cloud Load Balancer / CDN Geo-IP headers (`x-client-country` / `cf-ipcountry`).
 */
export function resolveClientGeo(
  headers: Readonly<Record<string, unknown>>,
  options: {
    readonly existingPreferredCurrency?: LoungeCurrency;
    readonly defaultCountryCode?: string;
  } = {},
): ResolvedClientGeo {
  const rawHeader = headers['x-client-country'] ?? headers['cf-ipcountry'];
  const headerCountry =
    typeof rawHeader === 'string' ? rawHeader.trim().toUpperCase() : '';
  const fallbackCountry = (options.defaultCountryCode?.trim() || 'JP').toUpperCase();
  const countryCode = /^[A-Z]{2}$/.test(headerCountry) ? headerCountry : fallbackCountry;
  const isEeaResident = EEA_UK_CH_COUNTRY_CODES.has(countryCode);
  const currency: LoungeCurrency =
    options.existingPreferredCurrency ?? (countryCode === 'JP' ? 'JPY' : 'USD');

  return {
    countryCode,
    isEeaResident,
    currency,
  };
}

/**
 * HMAC keyring mapping integer key version numbers (`>= 1`) to raw HMAC secrets
 * for anonymizing `lounge_trial_grants` without losing continuity across key rotations.
 */
export interface TrialHmacKeyring {
  readonly activeVersion: number;
  readonly keys: ReadonlyMap<number, string>;
}

/**
 * Loads the HMAC keyring from `LOUNGE_TRIAL_HMAC_KEYS` (JSON object) or `LOUNGE_TRIAL_HMAC_SECRET_V1`.
 * Throws in `production` when no secret is configured; uses a deterministic test key in non-prod.
 */
export function loadTrialHmacKeyring(env: NodeJS.ProcessEnv = process.env): TrialHmacKeyring {
  const isProd = env['NODE_ENV']?.trim() === 'production';
  const keys = new Map<number, string>();

  const jsonKeysRaw = env['LOUNGE_TRIAL_HMAC_KEYS']?.trim();
  if (jsonKeysRaw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonKeysRaw);
    } catch (err) {
      throw new Error('Invalid JSON in LOUNGE_TRIAL_HMAC_KEYS', { cause: err });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('LOUNGE_TRIAL_HMAC_KEYS must be a JSON object mapping version numbers to secrets');
    }
    for (const [verStr, secret] of Object.entries(parsed)) {
      const ver = Number(verStr);
      if (!Number.isInteger(ver) || ver < 1 || typeof secret !== 'string' || !secret.trim()) {
        throw new Error(`Invalid HMAC key entry "${verStr}" in LOUNGE_TRIAL_HMAC_KEYS`);
      }
      keys.set(ver, secret.trim());
    }
  }

  const v1Secret = env['LOUNGE_TRIAL_HMAC_SECRET_V1']?.trim();
  if (v1Secret && !keys.has(1)) {
    keys.set(1, v1Secret);
  }

  if (keys.size === 0) {
    if (isProd) {
      throw new Error(
        'LOUNGE_TRIAL_HMAC_KEYS or LOUNGE_TRIAL_HMAC_SECRET_V1 is required in production',
      );
    }
    keys.set(1, 'local-emulator-lounge-trial-hmac-secret-v1');
  }

  const activeVersion = Math.max(...keys.keys());
  return { activeVersion, keys };
}

/** Computes a single keyed HMAC-SHA256 digest for `xUserId` under `secret`. */
export function computeTrialHmacDigest(xUserId: string, secret: string): string {
  const normalized = xUserId.trim();
  if (!normalized) {
    throw new LoungeValidationError('X user ID must not be empty when computing grant hash');
  }
  return crypto.createHmac('sha256', secret).update(normalized, 'utf8').digest('hex');
}

/** Computes the active versioned hash `{ keyVersion, hash }` for persisting new grant rows. */
export function computeActiveTrialGrantHash(
  xUserId: string,
  keyring: TrialHmacKeyring,
): { readonly keyVersion: number; readonly hash: string } {
  const secret = keyring.keys.get(keyring.activeVersion);
  if (!secret) {
    throw new Error(`Missing HMAC secret for active key version ${keyring.activeVersion}`);
  }
  return {
    keyVersion: keyring.activeVersion,
    hash: computeTrialHmacDigest(xUserId, secret),
  };
}

/** Computes digests across every configured key version (`db.getAll(...)` batch lookup). */
export function computeAllTrialGrantHashes(
  xUserId: string,
  keyring: TrialHmacKeyring,
): ReadonlyArray<{ readonly keyVersion: number; readonly hash: string }> {
  return Array.from(keyring.keys.entries())
    .sort(([a], [b]) => b - a)
    .map(([keyVersion, secret]) => ({
      keyVersion,
      hash: computeTrialHmacDigest(xUserId, secret),
    }));
}

/** Bounded positive integer helper for runtime env parsing. */
function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return fallback;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

/** Complete validated Private Lounge runtime configuration. */
export interface LoungeRuntimeEnvironmentConfig {
  readonly port: number;
  readonly nodeEnv: string;
  readonly isProd: boolean;
  readonly projectId: string;
  readonly appVersion: string;
  readonly disclaimerVersion: number;
  readonly activePersonaId: string;
  readonly corsAllowedOrigins: readonly string[];
  readonly loungePublicOrigin: string;
  readonly noAuth: boolean;
  readonly batchSecretKey?: string;
  readonly authEmulatorHost?: string;
  readonly firestoreEmulatorHost?: string;
  readonly firebaseTenantId?: string;
  readonly firebaseWebConfig?: LoungeFirebaseWebConfig;
  readonly phase2EeaEnabled: boolean;
  readonly defaultGeoCountryCode: string;
  readonly trialHmacKeyring: TrialHmacKeyring;
  readonly stripeSecretKey?: string;
  readonly stripeWebhookSecret?: string;
  readonly stripePortalConfigurationId?: string;
  readonly stripePriceIds: Readonly<
    Record<LoungeCurrency, Readonly<Record<Exclude<LoungeProductId, 'WELCOME_BONUS_20'>, string>>>
  >;
  readonly geminiApiKey?: string;
  readonly geminiChatModel: string;
  readonly geminiSearchModel: string;
  readonly geminiEmbeddingModel: string;
  readonly geminiMaxOutputTokens: number;
  readonly geminiPaidTierEnabled: boolean;
  readonly imageSimilarityThreshold: number;
  readonly globalDailySignupCap: number;
  readonly globalDailyTurnCap: number;
}

/**
 * Parses and validates the full Private Lounge environment configuration.
 * Enforces test-only Stripe keys outside production and rejects invalid origin protocols.
 */
export function loadLoungeRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  resolvedAppVersion: string,
  resolvedDisclaimerVersion: number,
): LoungeRuntimeEnvironmentConfig {
  assertSafeStripeKeyConfiguration(env);

  const nodeEnv = env['NODE_ENV']?.trim() || 'development';
  const isProd = nodeEnv === 'production';
  const projectId =
    env['GCP_PROJECT_ID']?.trim() ||
    env['GOOGLE_CLOUD_PROJECT']?.trim() ||
    (isProd ? '' : 'rebecca-ai-gal-local');
  if (!projectId) {
    throw new Error('GCP_PROJECT_ID or GOOGLE_CLOUD_PROJECT is required in production');
  }

  const corsRaw = env['CORS_ALLOWED_ORIGINS']?.trim();
  const corsAllowedOrigins = corsRaw
    ? corsRaw
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0)
    : isProd
      ? []
      : ['http://localhost:4300', 'http://127.0.0.1:4300'];

  const configuredPublicOrigin =
    env['LOUNGE_PUBLIC_ORIGIN']?.trim() ||
    corsAllowedOrigins[0] ||
    (isProd ? '' : 'http://localhost:4300');
  if (configuredPublicOrigin && !/^https?:\/\//.test(configuredPublicOrigin)) {
    throw new Error(`Invalid LOUNGE_PUBLIC_ORIGIN URL: "${configuredPublicOrigin}"`);
  }

  const firebaseTenantId = env['LOUNGE_FIREBASE_TENANT_ID']?.trim() || undefined;
  const webApiKey = env['FIREBASE_WEB_API_KEY']?.trim();
  const webAuthDomain = env['FIREBASE_WEB_AUTH_DOMAIN']?.trim();
  const webProjectId = env['FIREBASE_WEB_PROJECT_ID']?.trim() || projectId;
  const webAppId = env['FIREBASE_WEB_APP_ID']?.trim();

  const firebaseWebConfig: LoungeFirebaseWebConfig | undefined =
    webApiKey && webAppId
      ? {
          apiKey: webApiKey,
          authDomain: webAuthDomain || `${webProjectId}.firebaseapp.com`,
          projectId: webProjectId,
          appId: webAppId,
          ...(firebaseTenantId ? { tenantId: firebaseTenantId } : {}),
        }
      : !isProd
        ? {
            apiKey: 'demo-local-emulator-api-key',
            authDomain: `${projectId}.firebaseapp.com`,
            projectId,
            appId: '1:000000000000:web:rebecca-lounge-local',
            ...(firebaseTenantId ? { tenantId: firebaseTenantId } : {}),
          }
        : undefined;

  const thresholdRaw = env['LOUNGE_IMAGE_SIMILARITY_THRESHOLD']?.trim();
  const parsedThreshold = thresholdRaw ? Number(thresholdRaw) : 0.45;
  const imageSimilarityThreshold =
    Number.isFinite(parsedThreshold) && parsedThreshold >= 0 && parsedThreshold <= 1
      ? parsedThreshold
      : 0.45;

  return {
    port: parsePositiveIntEnv(env['PORT'], 8083),
    nodeEnv,
    isProd,
    projectId,
    appVersion: resolvedAppVersion,
    disclaimerVersion: resolvedDisclaimerVersion,
    activePersonaId: env['ACTIVE_PERSONA_ID']?.trim() || 'rebecca',
    corsAllowedOrigins,
    loungePublicOrigin: configuredPublicOrigin.replace(/\/+$/, ''),
    noAuth: !isProd && env['NO_AUTH'] === 'true',
    batchSecretKey: isProd ? undefined : env['BATCH_SECRET_KEY']?.trim() || undefined,
    authEmulatorHost: env['FIREBASE_AUTH_EMULATOR_HOST']?.trim() || undefined,
    firestoreEmulatorHost: env['FIRESTORE_EMULATOR_HOST']?.trim() || undefined,
    firebaseTenantId,
    firebaseWebConfig,
    phase2EeaEnabled: env['LOUNGE_PHASE2_EEA_ENABLED'] === 'true',
    defaultGeoCountryCode: (env['DEFAULT_GEO_COUNTRY']?.trim() || 'JP').toUpperCase(),
    trialHmacKeyring: loadTrialHmacKeyring(env),
    stripeSecretKey: env['STRIPE_SECRET_KEY']?.trim() || undefined,
    stripeWebhookSecret: env['STRIPE_WEBHOOK_SECRET']?.trim() || undefined,
    stripePortalConfigurationId: env['STRIPE_PORTAL_CONFIGURATION_ID']?.trim() || undefined,
    stripePriceIds: {
      JPY: {
        TRIAL_TICKET_100: env['STRIPE_PRICE_TRIAL_JPY']?.trim() || 'price_test_trial_jpy',
        CHARGE_TICKET_100: env['STRIPE_PRICE_CHARGE_JPY']?.trim() || 'price_test_charge_jpy',
        STANDARD_MONTHLY: env['STRIPE_PRICE_STANDARD_JPY']?.trim() || 'price_test_standard_jpy',
      },
      USD: {
        TRIAL_TICKET_100: env['STRIPE_PRICE_TRIAL_USD']?.trim() || 'price_test_trial_usd',
        CHARGE_TICKET_100: env['STRIPE_PRICE_CHARGE_USD']?.trim() || 'price_test_charge_usd',
        STANDARD_MONTHLY: env['STRIPE_PRICE_STANDARD_USD']?.trim() || 'price_test_standard_usd',
      },
    },
    geminiApiKey: env['GEMINI_API_KEY']?.trim() || undefined,
    geminiChatModel: env['LOUNGE_GEMINI_CHAT_MODEL']?.trim() || 'gemini-3.1-flash-lite',
    geminiSearchModel: env['LOUNGE_GEMINI_SEARCH_MODEL']?.trim() || 'gemini-3.1-flash-lite',
    geminiEmbeddingModel: env['LOUNGE_GEMINI_EMBEDDING_MODEL']?.trim() || 'gemini-embedding-2',
    geminiMaxOutputTokens: Math.min(450, parsePositiveIntEnv(env['LOUNGE_MAX_OUTPUT_TOKENS'], 450)),
    geminiPaidTierEnabled: env['LOUNGE_GEMINI_PAID_TIER'] === 'true',
    imageSimilarityThreshold,
    globalDailySignupCap: parsePositiveIntEnv(env['LOUNGE_GLOBAL_DAILY_SIGNUP_CAP'], 2000),
    globalDailyTurnCap: parsePositiveIntEnv(env['LOUNGE_GLOBAL_DAILY_TURN_CAP'], 50000),
  };
}
