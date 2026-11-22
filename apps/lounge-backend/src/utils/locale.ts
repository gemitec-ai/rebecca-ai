import type { LoungeLanguage } from '@rebecca/types';
import { LoungeValidationError } from './errors';

/** All languages supported across the Private Lounge UI and AI prompt injection. */
export const SUPPORTED_LOUNGE_LANGUAGES: readonly LoungeLanguage[] = [
  'ja',
  'en',
  'de',
  'pt',
  'es',
  'zh-HK',
  'vi',
  'th',
];

const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Type predicate narrowing untrusted strings to an allowlisted `LoungeLanguage`. */
export function isSupportedLoungeLanguage(value: unknown): value is LoungeLanguage {
  return (
    typeof value === 'string' &&
    SUPPORTED_LOUNGE_LANGUAGES.some((allowed) => allowed === value)
  );
}

/**
 * Validates and returns an allowlisted `LoungeLanguage` code.
 *
 * @throws LoungeValidationError When value is missing or unsupported.
 */
export function parseSupportedLoungeLanguage(raw: unknown): LoungeLanguage {
  if (!isSupportedLoungeLanguage(raw)) {
    throw new LoungeValidationError('Unsupported Lounge language code');
  }
  return raw;
}

/**
 * Validates and normalizes an IANA timezone identifier via `Intl.DateTimeFormat`.
 *
 * @throws LoungeValidationError When value is empty, non-string, or unrecognized by ICU.
 */
export function parseValidIanaTimezone(raw: unknown): string {
  const tz = typeof raw === 'string' ? raw.trim() : '';
  if (!tz) {
    throw new LoungeValidationError('Field "timezone" must be a non-empty IANA timezone identifier');
  }
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
  } catch {
    throw new LoungeValidationError(`Invalid IANA timezone identifier "${tz}"`);
  }
  return tz;
}

/**
 * Checks whether `value` matches full ISO-8601 date-time syntax (`YYYY-MM-DDTHH:mm:ss(.sss)?(Z|+HH:MM)`).
 */
export function isStrictIsoTimestamp(value: string): boolean {
  return ISO_DATE_TIME_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}
