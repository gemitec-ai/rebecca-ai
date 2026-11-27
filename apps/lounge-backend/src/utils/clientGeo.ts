import type { LoungeCurrency } from '@rebecca/types';
import { EEA_UK_CH_COUNTRY_CODES } from '../features/billing/domain/loungeCatalog.constants';
import { LoungeForbiddenError } from './errors';

/** Allowlisted edge Geo-IP header names selectable via `LOUNGE_TRUSTED_GEO_HEADER`. */
export const ALLOWED_TRUSTED_GEO_HEADERS = [
  'x-client-country',
  'cf-ipcountry',
  'x-appengine-country',
] as const;

/** Single edge Geo-IP header trusted by this deployment topology. */
export type TrustedGeoHeaderName = (typeof ALLOWED_TRUSTED_GEO_HEADERS)[number];

/** Default trusted Geo-IP header injected by Google Cloud Load Balancer (`{client_region}`). */
export const DEFAULT_TRUSTED_GEO_HEADER: TrustedGeoHeaderName = 'x-client-country';

const IGNORED_PSEUDO_COUNTRIES = new Set<string>(['XX', 'T1', 'ZZ']);

/**
 * Policy flags governing regional compliance checks injected from validated startup config.
 */
export interface LoungeGeoCompliancePolicy {
  readonly phase2EeaEnabled: boolean;
  readonly allowDefaultGeoFallback: boolean;
}

/**
 * Resolved Geo-IP origin, EEA/UK/CH residency flag, and locked billing currency.
 * `hasTrustedGeoHeader` indicates whether an authoritative edge/LB header supplied a real country code.
 */
export interface ResolvedClientGeo {
  readonly countryCode: string;
  readonly isEeaResident: boolean;
  readonly currency: LoungeCurrency;
  readonly hasTrustedGeoHeader: boolean;
}

/**
 * Resolves the authoritative ISO-3166-1 alpha-2 country code, EEA/UK/CH flag, and billing currency
 * strictly from the single configured trusted edge Geo-IP header (`options.trustedGeoHeader`).
 * Never falls back across multiple header names and never consumes client-mutable UI `language`.
 */
export function resolveClientGeo(
  headers: Readonly<Record<string, unknown>>,
  options: {
    readonly trustedGeoHeader?: TrustedGeoHeaderName;
    readonly existingPreferredCurrency?: LoungeCurrency;
    readonly defaultCountryCode?: string;
  } = {},
): ResolvedClientGeo {
  const headerName = options.trustedGeoHeader ?? DEFAULT_TRUSTED_GEO_HEADER;
  let headerCountry = '';
  const raw = headers[headerName];
  if (typeof raw === 'string') {
    const normalized = raw.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(normalized) && !IGNORED_PSEUDO_COUNTRIES.has(normalized)) {
      headerCountry = normalized;
    }
  }

  const hasTrustedGeoHeader = headerCountry.length === 2;
  const trimmedDefault = options.defaultCountryCode?.trim();
  const fallbackCountry = (
    trimmedDefault && trimmedDefault.length > 0 ? trimmedDefault : 'JP'
  ).toUpperCase();
  const countryCode = hasTrustedGeoHeader ? headerCountry : fallbackCountry;
  const isEeaResident = EEA_UK_CH_COUNTRY_CODES.has(countryCode);
  const currency: LoungeCurrency =
    options.existingPreferredCurrency ?? (countryCode === 'JP' ? 'JPY' : 'USD');

  return {
    countryCode,
    isEeaResident,
    currency,
    hasTrustedGeoHeader,
  };
}

/**
 * Enforces fail-closed regional eligibility:
 * - Rejects requests lacking trusted Geo-IP headers outside local emulator mode (`403 GEO_UNAVAILABLE`).
 * - Blocks EEA/UK/Switzerland access across Phase 1 when `phase2EeaEnabled === false` (`403 GEO_BLOCKED`).
 *
 * @throws LoungeForbiddenError When trusted Geo-IP is missing or caller is in a Phase 1 restricted region.
 */
export function assertGeoEligibleForPhase(
  clientGeo: ResolvedClientGeo | undefined,
  policy: LoungeGeoCompliancePolicy,
  storedIsEeaResident?: boolean,
): void {
  if (!policy.allowDefaultGeoFallback && (!clientGeo || !clientGeo.hasTrustedGeoHeader)) {
    throw new LoungeForbiddenError('Regional eligibility could not be verified', {
      code: 'GEO_UNAVAILABLE',
    });
  }
  const effectiveEea = Boolean(storedIsEeaResident || clientGeo?.isEeaResident);
  if (!policy.phase2EeaEnabled && effectiveEea) {
    throw new LoungeForbiddenError(
      'Rebecca Private Lounge is unavailable in the EEA, UK, and Switzerland during Phase 1',
      { code: 'GEO_BLOCKED' },
    );
  }
}
