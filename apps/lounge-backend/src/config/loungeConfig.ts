import fs from 'node:fs';
import path from 'node:path';
import { getActivePersona } from '@rebecca/persona';
import {
  CURRENT_LOUNGE_DISCLAIMER_VERSION,
  type LoungeCurrency,
  type LoungeFirebaseWebConfig,
  type LoungeLegalUrlsDto,
  type LoungeProductId,
} from '@rebecca/types';
import {
  ALLOWED_TRUSTED_GEO_HEADERS,
  DEFAULT_TRUSTED_GEO_HEADER,
  type TrustedGeoHeaderName,
} from '../utils/clientGeo';
import type { TrialHmacKeyring } from '../utils/trialGrantHmac';

const LIVE_STRIPE_KEY_PREFIXES = ['sk_live_', 'rk_live_', 'pk_live_'] as const;
const TEST_STRIPE_KEY_PREFIXES = ['sk_test_', 'rk_test_', 'pk_test_'] as const;
const STRIPE_KEY_ENV_NAMES = [
  'STRIPE_SECRET_KEY',
  'STRIPE_PUBLISHABLE_KEY',
  'LOUNGE_STRIPE_SECRET_KEY',
  'LOUNGE_STRIPE_PUBLISHABLE_KEY',
] as const;
const EMULATOR_HOST_ENV_NAMES = [
  'FIREBASE_AUTH_EMULATOR_HOST',
  'FIRESTORE_EMULATOR_HOST',
  'FIREBASE_STORAGE_EMULATOR_HOST',
  'STORAGE_EMULATOR_HOST',
  'PUBSUB_EMULATOR_HOST',
] as const;
const ALLOWED_NODE_ENVS = new Set<string>(['development', 'test', 'production', 'staging']);

/** Obfuscates support contact email (`@` -> ` [at mark] `) matching Portal Web `/api/v1/support/plans`. */
export function formatObfuscatedContactEmail(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed || !trimmed.includes('@')) {
    return null;
  }
  return trimmed.replace('@', ' [at mark] ');
}

function readOptionalEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseBooleanEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  defaultValue: boolean,
): boolean {
  const raw = readOptionalEnv(env, key);
  if (raw === undefined) {
    return defaultValue;
  }
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  throw new Error(`Invalid boolean value "${raw}" for ${key}; expected "true" or "false"`);
}

function parsePositiveIntEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  defaultValue: number,
  maxValue?: number,
): number {
  const raw = readOptionalEnv(env, key);
  if (raw === undefined) {
    return defaultValue;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid positive integer "${raw}" for ${key}`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid positive integer "${raw}" for ${key}`);
  }
  return maxValue !== undefined ? Math.min(parsed, maxValue) : parsed;
}

function parseUnitIntervalEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  defaultValue: number,
): number {
  const raw = readOptionalEnv(env, key);
  if (raw === undefined) {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`Invalid number "${raw}" for ${key}; expected finite value in [0, 1]`);
  }
  return parsed;
}

function parseOriginUrl(raw: string, envName: string, requireHttps: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (err) {
    throw new Error(`Invalid URL "${raw}" for ${envName}`, { cause: err });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid URL protocol "${parsed.protocol}" for ${envName}`);
  }
  if (requireHttps && parsed.protocol !== 'https:') {
    throw new Error(`${envName} must use https:// in production`);
  }
  return parsed.origin;
}

/**
 * Resolves package version string from `APP_VERSION`, workspace `package.json`, or `npm_package_version`.
 * Throws if no version source can be resolved.
 */
export function resolveLoungeAppVersion(env: NodeJS.ProcessEnv): string {
  const configured = readOptionalEnv(env, 'APP_VERSION');
  if (configured) {
    return configured.startsWith('v') ? configured : `v${configured}`;
  }
  const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
  if (fs.existsSync(pkgPath)) {
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.trim()) {
      const clean = parsed.version.trim();
      return clean.startsWith('v') ? clean : `v${clean}`;
    }
  }
  const npmVer = readOptionalEnv(env, 'npm_package_version');
  if (npmVer) {
    return npmVer.startsWith('v') ? npmVer : `v${npmVer}`;
  }
  throw new Error('Unable to resolve application version from APP_VERSION or package.json');
}

/**
 * Resolves the active positive integer disclaimer version from `LOUNGE_DISCLAIMER_VERSION`
 * (or fallback `DISCLAIMER_VERSION`), defaulting to `CURRENT_LOUNGE_DISCLAIMER_VERSION` when omitted.
 *
 * @throws Error When supplied env value is not a positive integer.
 */
export function resolveDisclaimerVersion(env: NodeJS.ProcessEnv): number {
  const raw =
    readOptionalEnv(env, 'LOUNGE_DISCLAIMER_VERSION') ?? readOptionalEnv(env, 'DISCLAIMER_VERSION');
  if (raw === undefined) {
    return CURRENT_LOUNGE_DISCLAIMER_VERSION;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid disclaimer version "${raw}"; expected positive integer`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid disclaimer version "${raw}"; expected integer >= 1`);
  }
  return parsed;
}

/**
 * Enforces strict Stripe key environment separation across production and non-production environments:
 * - Non-production refuses live Stripe keys (`*_live_`).
 * - Production refuses test Stripe keys (`*_test_`).
 *
 * @throws Error When Stripe key prefix does not match `NODE_ENV`.
 */
export function assertSafeStripeKeyConfiguration(env: NodeJS.ProcessEnv): void {
  const nodeEnv = readOptionalEnv(env, 'NODE_ENV');
  const isProd = nodeEnv === 'production';
  for (const keyName of STRIPE_KEY_ENV_NAMES) {
    const raw = readOptionalEnv(env, keyName);
    if (!raw) {
      continue;
    }
    if (!isProd && LIVE_STRIPE_KEY_PREFIXES.some((prefix) => raw.startsWith(prefix))) {
      throw new Error(
        `Refusing live Stripe key in ${keyName} while NODE_ENV="${nodeEnv ?? 'undefined'}". Use sk_test_/rk_test_/pk_test_ keys outside production.`,
      );
    }
    if (isProd && TEST_STRIPE_KEY_PREFIXES.some((prefix) => raw.startsWith(prefix))) {
      throw new Error(
        `Refusing test Stripe key in ${keyName} while NODE_ENV="production". Configure live Stripe credentials or omit billing keys for Free-only launch.`,
      );
    }
  }
}

/**
 * Loads the HMAC keyring from `LOUNGE_TRIAL_HMAC_KEYS` (JSON object) and/or `LOUNGE_TRIAL_HMAC_SECRET_V1`.
 * Deterministic local default key is permitted ONLY when `isLocalEmulatorMode` is `true`.
 *
 * @throws Error When keyring JSON/entries are malformed, missing outside emulator mode, or active version is missing.
 */
export function loadTrialHmacKeyring(
  env: NodeJS.ProcessEnv,
  isLocalEmulatorMode = false,
): TrialHmacKeyring {
  const keys = new Map<number, string>();

  const jsonKeysRaw = readOptionalEnv(env, 'LOUNGE_TRIAL_HMAC_KEYS');
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

  const v1Secret = readOptionalEnv(env, 'LOUNGE_TRIAL_HMAC_SECRET_V1');
  if (v1Secret && !keys.has(1)) {
    keys.set(1, v1Secret);
  }

  if (keys.size === 0) {
    if (!isLocalEmulatorMode) {
      throw new Error(
        'LOUNGE_TRIAL_HMAC_KEYS or LOUNGE_TRIAL_HMAC_SECRET_V1 is required outside local emulator mode',
      );
    }
    keys.set(1, 'local-emulator-lounge-trial-hmac-secret-v1');
  }

  const explicitActive = readOptionalEnv(env, 'LOUNGE_TRIAL_HMAC_ACTIVE_VERSION');
  let activeVersion: number;
  if (explicitActive !== undefined) {
    if (!/^\d+$/.test(explicitActive)) {
      throw new Error(`Invalid LOUNGE_TRIAL_HMAC_ACTIVE_VERSION "${explicitActive}"`);
    }
    activeVersion = Number.parseInt(explicitActive, 10);
    if (!keys.has(activeVersion)) {
      throw new Error(
        `LOUNGE_TRIAL_HMAC_ACTIVE_VERSION=${activeVersion} is not present in loaded HMAC keys`,
      );
    }
  } else {
    activeVersion = Math.max(...keys.keys());
  }

  return { activeVersion, keys };
}

/** Complete validated Private Lounge runtime configuration. */
export interface LoungeRuntimeEnvironmentConfig {
  readonly port: number;
  readonly nodeEnv: string;
  readonly isProd: boolean;
  readonly isCloudRun: boolean;
  readonly isLocalEmulatorMode: boolean;
  readonly allowDefaultGeoFallback: boolean;
  readonly projectId: string;
  readonly appVersion: string;
  readonly disclaimerVersion: number;
  readonly activePersonaId: string;
  readonly corsAllowedOrigins: readonly string[];
  readonly loungePublicOrigin: string;
  readonly portalOrigin: string;
  readonly legalUrls: LoungeLegalUrlsDto;
  readonly noAuth: boolean;
  readonly batchSecretKey?: string;
  readonly batchOidcAudience?: string;
  readonly batchOidcServiceAccountEmail?: string;
  readonly authEmulatorHost?: string;
  readonly firestoreEmulatorHost?: string;
  readonly firebaseTenantId?: string;
  readonly firebaseWebConfig?: LoungeFirebaseWebConfig;
  readonly phase2EeaEnabled: boolean;
  readonly defaultGeoCountryCode: string;
  readonly trustedGeoHeader: TrustedGeoHeaderName;
  readonly trialHmacKeyring: TrialHmacKeyring;
  readonly stripeSecretKey?: string;
  readonly stripeWebhookSecret?: string;
  readonly stripePortalConfigurationId?: string;
  readonly stripePriceIds: Readonly<
    Record<LoungeCurrency, Readonly<Record<Exclude<LoungeProductId, 'WELCOME_BONUS_20'>, string | null>>>
  >;
  readonly billingEnabled: boolean;
  readonly contactEmail: string | null;
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
 * Parses and validates the full Private Lounge environment configuration strictly at startup.
 * Enforces fail-fast checks for required production/Cloud Run settings and test-only keys in non-prod.
 *
 * @throws Error When mandatory production/Cloud Run settings, origins, OIDC verification, or Stripe keys are invalid.
 */
export function loadLoungeRuntimeConfig(
  env: NodeJS.ProcessEnv,
): LoungeRuntimeEnvironmentConfig {
  assertSafeStripeKeyConfiguration(env);

  const isCloudRun = Boolean(readOptionalEnv(env, 'K_SERVICE'));
  const rawNodeEnv = readOptionalEnv(env, 'NODE_ENV');
  if (isCloudRun && !rawNodeEnv) {
    throw new Error('NODE_ENV is required when running on Cloud Run');
  }
  const nodeEnv = rawNodeEnv ?? 'development';
  if (!ALLOWED_NODE_ENVS.has(nodeEnv)) {
    throw new Error(`Unsupported NODE_ENV value "${nodeEnv}"`);
  }

  const isProd = nodeEnv === 'production';
  const useFirebaseEmulatorsFlag = parseBooleanEnv(env, 'USE_FIREBASE_EMULATORS', false);
  if (isProd || isCloudRun) {
    for (const emulatorEnvKey of EMULATOR_HOST_ENV_NAMES) {
      if (readOptionalEnv(env, emulatorEnvKey)) {
        throw new Error(
          `Refusing local emulator environment variable ${emulatorEnvKey} in ${isProd ? 'production' : 'Cloud Run'}`,
        );
      }
    }
    if (useFirebaseEmulatorsFlag) {
      throw new Error(
        `USE_FIREBASE_EMULATORS=true is forbidden in ${isProd ? 'production' : 'Cloud Run'}`,
      );
    }
  }

  const authEmulatorHost =
    isProd || isCloudRun ? undefined : readOptionalEnv(env, 'FIREBASE_AUTH_EMULATOR_HOST');
  const firestoreEmulatorHost =
    isProd || isCloudRun ? undefined : readOptionalEnv(env, 'FIRESTORE_EMULATOR_HOST');
  const isLocalEmulatorMode =
    !isProd &&
    !isCloudRun &&
    (nodeEnv === 'development' || nodeEnv === 'test') &&
    (Boolean(authEmulatorHost || firestoreEmulatorHost) || nodeEnv === 'test');

  const explicitAllowGeoFallback = parseBooleanEnv(env, 'ALLOW_GEO_FALLBACK_COUNTRY', false);
  if (explicitAllowGeoFallback && (isProd || isCloudRun)) {
    throw new Error('ALLOW_GEO_FALLBACK_COUNTRY=true is forbidden in production or Cloud Run');
  }
  const allowDefaultGeoFallback = isLocalEmulatorMode || explicitAllowGeoFallback;

  const projectId =
    readOptionalEnv(env, 'GCP_PROJECT_ID') ??
    readOptionalEnv(env, 'GOOGLE_CLOUD_PROJECT') ??
    (isLocalEmulatorMode ? 'rebecca-ai-gal-local' : undefined);
  if (!projectId) {
    throw new Error('GCP_PROJECT_ID or GOOGLE_CLOUD_PROJECT is required outside local emulator mode');
  }

  const corsRaw = readOptionalEnv(env, 'CORS_ALLOWED_ORIGINS');
  let corsAllowedOrigins: string[];
  if (corsRaw) {
    const items = corsRaw
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
    if (items.some((origin) => origin === '*')) {
      throw new Error('CORS_ALLOWED_ORIGINS must never contain wildcard "*"');
    }
    corsAllowedOrigins = items.map((origin) =>
      parseOriginUrl(origin, 'CORS_ALLOWED_ORIGINS', isProd),
    );
  } else if (isLocalEmulatorMode) {
    corsAllowedOrigins = ['http://localhost:4300', 'http://127.0.0.1:4300'];
  } else {
    throw new Error('CORS_ALLOWED_ORIGINS is required outside local emulator mode');
  }

  const rawPublicOrigin =
    readOptionalEnv(env, 'LOUNGE_PUBLIC_ORIGIN') ??
    (isLocalEmulatorMode ? corsAllowedOrigins[0] : undefined);
  if (!rawPublicOrigin) {
    throw new Error('LOUNGE_PUBLIC_ORIGIN is required outside local emulator mode');
  }
  const loungePublicOrigin = parseOriginUrl(rawPublicOrigin, 'LOUNGE_PUBLIC_ORIGIN', isProd);

  const activePersonaId = readOptionalEnv(env, 'ACTIVE_PERSONA_ID') ?? 'rebecca';
  const activePersona = getActivePersona(activePersonaId);
  const rawPortalOrigin =
    readOptionalEnv(env, 'LOUNGE_PORTAL_ORIGIN') ?? activePersona.metadata.lounge.portalOrigin;
  const portalOrigin = parseOriginUrl(rawPortalOrigin, 'LOUNGE_PORTAL_ORIGIN', isProd);
  const legalUrls: LoungeLegalUrlsDto = {
    tosUrl: `${portalOrigin}/tos`,
    privacyUrl: `${portalOrigin}/privacy`,
    legalUrl: `${portalOrigin}/legal`,
  };

  const firebaseTenantId = readOptionalEnv(env, 'LOUNGE_FIREBASE_TENANT_ID');
  const webApiKey = readOptionalEnv(env, 'FIREBASE_WEB_API_KEY');
  const webAuthDomain = readOptionalEnv(env, 'FIREBASE_WEB_AUTH_DOMAIN');
  const webProjectId = readOptionalEnv(env, 'FIREBASE_WEB_PROJECT_ID') ?? projectId;
  const webAppId = readOptionalEnv(env, 'FIREBASE_WEB_APP_ID');

  let firebaseWebConfig: LoungeFirebaseWebConfig | undefined;
  if (webApiKey && webAppId) {
    firebaseWebConfig = {
      apiKey: webApiKey,
      authDomain: webAuthDomain ?? `${webProjectId}.firebaseapp.com`,
      projectId: webProjectId,
      appId: webAppId,
      ...(firebaseTenantId ? { tenantId: firebaseTenantId } : {}),
    };
  } else if (isLocalEmulatorMode) {
    firebaseWebConfig = {
      apiKey: 'demo-local-emulator-api-key',
      authDomain: `${webProjectId}.firebaseapp.com`,
      projectId: webProjectId,
      appId: '1:000000000000:web:rebecca-lounge-local',
      ...(firebaseTenantId ? { tenantId: firebaseTenantId } : {}),
    };
  } else {
    throw new Error(
      'FIREBASE_WEB_API_KEY and FIREBASE_WEB_APP_ID are required outside local emulator mode',
    );
  }

  const resolvePriceId = (
    envKey: string,
    localEmulatorDefault: string,
  ): string | null => {
    const raw = env[envKey];
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.toUpperCase() === 'DISABLED' || trimmed.toUpperCase() === 'NONE') {
        return null;
      }
      if (trimmed.startsWith('price_placeholder_')) {
        if (isProd) {
          throw new Error(`Refusing placeholder Stripe Price ID "${trimmed}" in ${envKey} for production`);
        }
        return null;
      }
      if (isProd && trimmed.startsWith('price_test_')) {
        throw new Error(`Refusing placeholder Stripe Price ID "${trimmed}" in ${envKey} for production`);
      }
      return trimmed;
    }
    return isLocalEmulatorMode ? localEmulatorDefault : null;
  };

  const stripePriceIds: LoungeRuntimeEnvironmentConfig['stripePriceIds'] = {
    JPY: {
      TRIAL_TICKET_100: resolvePriceId('STRIPE_PRICE_TRIAL_JPY', 'price_test_trial_jpy'),
      CHARGE_TICKET_100: resolvePriceId('STRIPE_PRICE_CHARGE_JPY', 'price_test_charge_jpy'),
      STANDARD_MONTHLY: resolvePriceId('STRIPE_PRICE_STANDARD_JPY', 'price_test_standard_jpy'),
    },
    USD: {
      TRIAL_TICKET_100: resolvePriceId('STRIPE_PRICE_TRIAL_USD', 'price_test_trial_usd'),
      CHARGE_TICKET_100: resolvePriceId('STRIPE_PRICE_CHARGE_USD', 'price_test_charge_usd'),
      STANDARD_MONTHLY: resolvePriceId('STRIPE_PRICE_STANDARD_USD', 'price_test_standard_usd'),
    },
  };

  const hasAnyConfiguredStripePrice =
    Object.values(stripePriceIds.JPY).some(Boolean) ||
    Object.values(stripePriceIds.USD).some(Boolean);

  const stripeSecretKey =
    readOptionalEnv(env, 'LOUNGE_STRIPE_SECRET_KEY') ?? readOptionalEnv(env, 'STRIPE_SECRET_KEY');
  const stripeWebhookSecret = readOptionalEnv(env, 'STRIPE_WEBHOOK_SECRET');
  if (!isLocalEmulatorMode && hasAnyConfiguredStripePrice && !stripeSecretKey) {
    throw new Error(
      'STRIPE_SECRET_KEY or LOUNGE_STRIPE_SECRET_KEY is required when Stripe prices are configured outside local emulator mode',
    );
  }
  if (!isLocalEmulatorMode && hasAnyConfiguredStripePrice && !stripeWebhookSecret) {
    throw new Error(
      'STRIPE_WEBHOOK_SECRET is required when Stripe prices are configured outside local emulator mode',
    );
  }
  const billingEnabled =
    hasAnyConfiguredStripePrice && Boolean(stripeSecretKey || isLocalEmulatorMode);
  const contactEmail = formatObfuscatedContactEmail(readOptionalEnv(env, 'SUPPORT_CONTACT_EMAIL'));

  const geminiApiKey = readOptionalEnv(env, 'GEMINI_API_KEY');
  if (!isLocalEmulatorMode && !geminiApiKey) {
    throw new Error('GEMINI_API_KEY is required outside local emulator mode');
  }

  const rawDefaultCountry = (readOptionalEnv(env, 'DEFAULT_GEO_COUNTRY') ?? 'JP').toUpperCase();
  if (!/^[A-Z]{2}$/.test(rawDefaultCountry)) {
    throw new Error(`Invalid DEFAULT_GEO_COUNTRY "${rawDefaultCountry}"; expected ISO 3166-1 alpha-2`);
  }

  const rawTrustedGeoHeader = readOptionalEnv(env, 'LOUNGE_TRUSTED_GEO_HEADER')?.toLowerCase();
  let trustedGeoHeader: TrustedGeoHeaderName = DEFAULT_TRUSTED_GEO_HEADER;
  if (rawTrustedGeoHeader !== undefined) {
    const matchedHeader = ALLOWED_TRUSTED_GEO_HEADERS.find((h) => h === rawTrustedGeoHeader);
    if (!matchedHeader) {
      throw new Error(
        `Unsupported LOUNGE_TRUSTED_GEO_HEADER "${rawTrustedGeoHeader}"; expected one of: ${ALLOWED_TRUSTED_GEO_HEADERS.join(', ')}`,
      );
    }
    trustedGeoHeader = matchedHeader;
  }

  const rawBatchAudience = readOptionalEnv(env, 'LOUNGE_BATCH_OIDC_AUDIENCE');
  let batchOidcAudience: string | undefined;
  if (rawBatchAudience !== undefined) {
    // Preserve full endpoint path if configured (Cloud Scheduler audience can be URL or path-scoped URL)
    parseOriginUrl(rawBatchAudience, 'LOUNGE_BATCH_OIDC_AUDIENCE', isProd);
    batchOidcAudience = rawBatchAudience;
  }
  const batchOidcServiceAccountEmail = readOptionalEnv(
    env,
    'LOUNGE_BATCH_OIDC_SERVICE_ACCOUNT_EMAIL',
  );
  if (batchOidcServiceAccountEmail !== undefined) {
    const emails = batchOidcServiceAccountEmail
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (emails.length === 0 || emails.some((item) => !item.includes('@'))) {
      throw new Error(
        'LOUNGE_BATCH_OIDC_SERVICE_ACCOUNT_EMAIL must contain comma-separated valid service account emails',
      );
    }
  }
  if ((isProd || isCloudRun) && (!batchOidcAudience || !batchOidcServiceAccountEmail)) {
    throw new Error(
      'LOUNGE_BATCH_OIDC_AUDIENCE and LOUNGE_BATCH_OIDC_SERVICE_ACCOUNT_EMAIL are required in production and Cloud Run',
    );
  }

  const appVersion = resolveLoungeAppVersion(env);
  const disclaimerVersion = resolveDisclaimerVersion(env);
  const noAuthRequested = parseBooleanEnv(env, 'NO_AUTH', false);
  const phase2EeaEnabled = parseBooleanEnv(env, 'LOUNGE_PHASE2_EEA_ENABLED', false);
  const geminiPaidTierEnabled = parseBooleanEnv(env, 'LOUNGE_GEMINI_PAID_TIER', false);
  const batchSecretKey =
    isProd || isCloudRun ? undefined : readOptionalEnv(env, 'BATCH_SECRET_KEY');

  return {
    port: parsePositiveIntEnv(env, 'PORT', 8083),
    nodeEnv,
    isProd,
    isCloudRun,
    isLocalEmulatorMode,
    allowDefaultGeoFallback,
    projectId,
    appVersion,
    disclaimerVersion,
    activePersonaId,
    corsAllowedOrigins,
    loungePublicOrigin,
    portalOrigin,
    legalUrls,
    noAuth: noAuthRequested && !isProd && !isCloudRun && isLocalEmulatorMode,
    ...(batchSecretKey ? { batchSecretKey } : {}),
    ...(batchOidcAudience ? { batchOidcAudience } : {}),
    ...(batchOidcServiceAccountEmail ? { batchOidcServiceAccountEmail } : {}),
    ...(authEmulatorHost ? { authEmulatorHost } : {}),
    ...(firestoreEmulatorHost ? { firestoreEmulatorHost } : {}),
    ...(firebaseTenantId ? { firebaseTenantId } : {}),
    firebaseWebConfig,
    phase2EeaEnabled,
    defaultGeoCountryCode: rawDefaultCountry,
    trustedGeoHeader,
    trialHmacKeyring: loadTrialHmacKeyring(env, isLocalEmulatorMode),
    ...(stripeSecretKey ? { stripeSecretKey } : {}),
    ...(stripeWebhookSecret ? { stripeWebhookSecret } : {}),
    ...(readOptionalEnv(env, 'STRIPE_PORTAL_CONFIGURATION_ID')
      ? { stripePortalConfigurationId: readOptionalEnv(env, 'STRIPE_PORTAL_CONFIGURATION_ID') }
      : {}),
    stripePriceIds,
    billingEnabled,
    contactEmail,
    ...(geminiApiKey ? { geminiApiKey } : {}),
    geminiChatModel: readOptionalEnv(env, 'LOUNGE_GEMINI_CHAT_MODEL') ?? 'gemini-3.1-flash-lite',
    geminiSearchModel: readOptionalEnv(env, 'LOUNGE_GEMINI_SEARCH_MODEL') ?? 'gemini-3.1-flash-lite',
    geminiEmbeddingModel: readOptionalEnv(env, 'LOUNGE_GEMINI_EMBEDDING_MODEL') ?? 'gemini-embedding-2',
    geminiMaxOutputTokens: parsePositiveIntEnv(env, 'LOUNGE_MAX_OUTPUT_TOKENS', 450, 450),
    geminiPaidTierEnabled,
    imageSimilarityThreshold: parseUnitIntervalEnv(env, 'LOUNGE_IMAGE_SIMILARITY_THRESHOLD', 0.45),
    globalDailySignupCap: parsePositiveIntEnv(env, 'LOUNGE_GLOBAL_DAILY_SIGNUP_CAP', 2000),
    globalDailyTurnCap: parsePositiveIntEnv(env, 'LOUNGE_GLOBAL_DAILY_TURN_CAP', 50000),
  };
}
