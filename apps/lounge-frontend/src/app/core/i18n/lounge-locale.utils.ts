import type { LoungeLanguage } from '@rebecca/types';
import type { LoungeSelectOption } from './lounge-i18n.types';

/**
 * Eight supported UI and conversational AI response languages.
 */
export const LOUNGE_LANGUAGE_OPTIONS: readonly LoungeSelectOption<LoungeLanguage>[] = [
  { label: '日本語 (JA)', value: 'ja' },
  { label: 'English (EN)', value: 'en' },
  { label: 'Deutsch (DE)', value: 'de' },
  { label: 'Português (PT)', value: 'pt' },
  { label: 'Español (ES)', value: 'es' },
  { label: '繁體中文・香港 (ZH-HK)', value: 'zh-HK' },
  { label: 'Tiếng Việt (VI)', value: 'vi' },
  { label: 'ภาษาไทย (TH)', value: 'th' },
];

/**
 * Standard 29 global IANA timezone options synchronized with Dashboard settings so morning/night context
 * aligns between the user's local clock and the AI companion.
 */
export const LOUNGE_TIMEZONE_OPTIONS: readonly LoungeSelectOption<string>[] = [
  { label: '(UTC-12:00) International Date Line West (Baker Island)', value: 'Etc/GMT+12' },
  { label: '(UTC-11:00) Midway, Samoa, Niue (Pacific/Midway)', value: 'Pacific/Midway' },
  { label: '(UTC-10:00) Hawaii, Honolulu, Tahiti (Pacific/Honolulu)', value: 'Pacific/Honolulu' },
  { label: '(UTC-09:00) Alaska, Anchorage (America/Anchorage)', value: 'America/Anchorage' },
  { label: '(UTC-08:00) Pacific Time: Los Angeles, Vancouver (America/Los_Angeles)', value: 'America/Los_Angeles' },
  { label: '(UTC-07:00) Mountain Time: Denver, Phoenix, Calgary (America/Denver)', value: 'America/Denver' },
  { label: '(UTC-06:00) Central Time: Chicago, Mexico City, Dallas (America/Chicago)', value: 'America/Chicago' },
  { label: '(UTC-05:00) Eastern Time: New York, Toronto, Miami, Bogota (America/New_York)', value: 'America/New_York' },
  { label: '(UTC-04:00) Atlantic Time: Santiago, Halifax, Caracas (America/Santiago)', value: 'America/Santiago' },
  { label: '(UTC-03:00) Sao Paulo, Buenos Aires, Brasilia (America/Sao_Paulo)', value: 'America/Sao_Paulo' },
  { label: '(UTC-02:00) Mid-Atlantic, South Georgia (America/Noronha)', value: 'America/Noronha' },
  { label: '(UTC-01:00) Azores, Cape Verde (Atlantic/Azores)', value: 'Atlantic/Azores' },
  { label: '(UTC+00:00) UTC, London, Dublin, Lisbon, Casablanca (UTC)', value: 'UTC' },
  { label: '(UTC+01:00) Paris, Berlin, Rome, Madrid, Amsterdam (Europe/Paris)', value: 'Europe/Paris' },
  { label: '(UTC+02:00) Cairo, Jerusalem, Athens, Johannesburg, Helsinki (Africa/Cairo)', value: 'Africa/Cairo' },
  { label: '(UTC+03:00) Moscow, Riyadh, Nairobi, Istanbul, Doha (Europe/Moscow)', value: 'Europe/Moscow' },
  { label: '(UTC+04:00) Dubai, Abu Dhabi, Baku, Tbilisi, Yerevan (Asia/Dubai)', value: 'Asia/Dubai' },
  { label: '(UTC+05:00) Karachi, Tashkent, Islamabad, Yekaterinburg (Asia/Karachi)', value: 'Asia/Karachi' },
  { label: '(UTC+05:30) Mumbai, New Delhi, Kolkata, Bengaluru (Asia/Kolkata)', value: 'Asia/Kolkata' },
  { label: '(UTC+06:00) Dhaka, Almaty, Astana, Omsk (Asia/Dhaka)', value: 'Asia/Dhaka' },
  { label: '(UTC+07:00) Bangkok, Jakarta, Hanoi, Novosibirsk (Asia/Bangkok)', value: 'Asia/Bangkok' },
  { label: '(UTC+08:00) Singapore, Hong Kong, Beijing, Taipei, Perth (Asia/Singapore)', value: 'Asia/Singapore' },
  { label: '(UTC+09:00) Tokyo, Seoul, Osaka, Kyoto (Asia/Tokyo)', value: 'Asia/Tokyo' },
  { label: '(UTC+09:30) Adelaide, Darwin (Australia/Adelaide)', value: 'Australia/Adelaide' },
  { label: '(UTC+10:00) Sydney, Melbourne, Brisbane, Guam (Australia/Sydney)', value: 'Australia/Sydney' },
  { label: '(UTC+11:00) Solomon Islands, New Caledonia, Vladivostok (Pacific/Guadalcanal)', value: 'Pacific/Guadalcanal' },
  { label: '(UTC+12:00) Auckland, Wellington, Fiji, Marshall Islands (Pacific/Auckland)', value: 'Pacific/Auckland' },
  { label: "(UTC+13:00) Tonga, Nuku'alofa, Samoa (Pacific/Tongatapu)", value: 'Pacific/Tongatapu' },
  { label: '(UTC+14:00) Kiritimati, Line Islands (Pacific/Kiritimati)', value: 'Pacific/Kiritimati' },
];

/**
 * Returns the standard timezone dropdown list, prepending an offset-labeled option when
 * `currentTimezone` is a valid IANA identifier outside the curated 29-zone preset list.
 */
export function buildLoungeTimezoneOptions(
  currentTimezone: string,
): readonly LoungeSelectOption<string>[] {
  const trimmed = currentTimezone.trim();
  if (!trimmed || LOUNGE_TIMEZONE_OPTIONS.some((opt) => opt.value === trimmed)) {
    return LOUNGE_TIMEZONE_OPTIONS;
  }
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: trimmed,
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date());
    const zoneName = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
    let offsetLabel = 'UTC';
    const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(zoneName);
    if (match) {
      const sign = match[1];
      const hours = match[2].padStart(2, '0');
      const mins = match[3] ?? '00';
      offsetLabel = hours === '00' && mins === '00' ? 'UTC' : `UTC${sign}${hours}:${mins}`;
    }
    return [{ label: `(${offsetLabel}) ${trimmed}`, value: trimmed }, ...LOUNGE_TIMEZONE_OPTIONS];
  } catch {
    return LOUNGE_TIMEZONE_OPTIONS;
  }
}

/**
 * Detects the best initial Lounge UI language from the browser's `navigator.languages` / `navigator.language`
 * so international first-time visitors immediately see their native language or English fallback (`en`).
 */
export function detectInitialLoungeLanguage(nav?: {
  readonly languages?: readonly string[];
  readonly language?: string;
}): LoungeLanguage {
  const browserNav =
    nav ?? (typeof navigator !== 'undefined' ? navigator : undefined);
  const candidates: string[] = [];
  if (browserNav?.languages && browserNav.languages.length > 0) {
    candidates.push(...browserNav.languages);
  }
  if (browserNav?.language) {
    candidates.push(browserNav.language);
  }
  for (const raw of candidates) {
    const lower = raw.trim().toLowerCase();
    if (!lower) {
      continue;
    }
    if (
      lower.startsWith('zh-hk') ||
      lower.startsWith('zh-tw') ||
      lower.startsWith('zh-mo') ||
      lower.startsWith('zh-hant')
    ) {
      return 'zh-HK';
    }
    const base = lower.split('-')[0];
    if (
      base === 'ja' ||
      base === 'en' ||
      base === 'de' ||
      base === 'pt' ||
      base === 'es' ||
      base === 'vi' ||
      base === 'th'
    ) {
      return base;
    }
  }
  return 'en';
}

/**
 * Detects the user's current local IANA timezone from `Intl.DateTimeFormat`,
 * falling back cleanly to `UTC` if unavailable or invalid.
 */
export function detectInitialLoungeTimezone(): string {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone?.trim();
    if (resolved) {
      new Intl.DateTimeFormat('en-US', { timeZone: resolved }).format(new Date());
      return resolved;
    }
  } catch {
    // Fallback below
  }
  return 'UTC';
}

/** Replaces `{name}` template tokens cleanly inside translated strings. */
export function formatLoungeCopy(template: string, personaName: string): string {
  return template.replace(/\{name\}/g, () => personaName);
}
