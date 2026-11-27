import { LOUNGE_SUPPORTED_LANGUAGES, type LoungeLanguage } from '@rebecca/types';
import { LoungeValidationError } from './errors';

/** All languages supported across the Private Lounge UI and AI prompt injection (re-exported SSOT). */
export const SUPPORTED_LOUNGE_LANGUAGES: readonly LoungeLanguage[] = LOUNGE_SUPPORTED_LANGUAGES;

/** Human-readable language directive labels shared across Lounge prompt synthesis and locale rules. */
export const LOUNGE_LANGUAGE_LABELS: Readonly<Record<LoungeLanguage, string>> = {
  ja: 'Japanese (日本語)',
  en: 'English',
  de: 'German (Deutsch)',
  pt: 'Portuguese (Português)',
  es: 'Spanish (Español)',
  'zh-HK': 'Traditional Chinese with Hong Kong Cantonese nuance (繁體中文・香港)',
  vi: 'Vietnamese (Tiếng Việt)',
  th: 'Thai (ภาษาไทย)',
};

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
 * Returns a trimmed, ICU-valid IANA timezone identifier, falling back to `fallback` when blank or invalid.
 */
export function normalizeIanaTimezoneOrDefault(timezone: string, fallback: string): string {
  const trimmed = timezone.trim();
  if (!trimmed) {
    return fallback;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).format(new Date());
    return trimmed;
  } catch {
    return fallback;
  }
}

/**
 * Checks whether `value` matches full ISO-8601 date-time syntax (`YYYY-MM-DDTHH:mm:ss(.sss)?(Z|+HH:MM)`).
 */
export function isStrictIsoTimestamp(value: string): boolean {
  return ISO_DATE_TIME_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}
