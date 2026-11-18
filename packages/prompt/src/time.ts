import type { TimeContextPeriod, ZonedDateParts } from './types';

/** Default IANA timezone used when callers do not specify an override. */
export const DEFAULT_APP_TIMEZONE = 'Asia/Tokyo';

/**
 * Extracts localized calendar and clock components for a given date in the target timezone.
 * Uses ECMA-402 `Intl.DateTimeFormat` for strict and DST-aware calculations.
 *
 * @param date - The Date instance to evaluate (defaults to current time).
 * @param timezone - Target IANA time zone identifier (defaults to `'Asia/Tokyo'`).
 * @returns Localized date parts with zero-padded string and numeric values.
 * @throws RangeError if `timezone` is not a valid IANA time zone identifier or `date` is invalid.
 */
export const getZonedDateParts = (
  date: Date = new Date(),
  timezone: string = DEFAULT_APP_TIMEZONE,
): ZonedDateParts => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const findPart = (type: Intl.DateTimeFormatPartTypes): string => {
    const matched = parts.find((p) => p.type === type);
    return matched ? matched.value : '00';
  };

  const year = findPart('year');
  const month = findPart('month');
  const day = findPart('day');
  const rawHour = findPart('hour');
  const hour = rawHour === '24' ? '00' : rawHour;
  const minute = findPart('minute');
  const second = findPart('second');

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    numericYear: parseInt(year, 10),
    numericMonth: parseInt(month, 10),
    numericDay: parseInt(day, 10),
    numericHour: parseInt(hour, 10),
    numericMinute: parseInt(minute, 10),
  };
};

/**
 * Formats a Date or ISO-8601 string into a human-readable zoned timestamp (`YYYY-MM-DD HH:mm [TZ]`).
 *
 * @param isoOrDate - ISO-8601 string or Date object representing the timestamp.
 * @param timezone - Target IANA time zone identifier (defaults to `'Asia/Tokyo'`).
 * @returns Formatted date string with timezone abbreviation, or `''` if input is empty or invalid.
 * @throws RangeError if `timezone` is not a valid IANA time zone identifier when formatting a valid date.
 */
export const formatZonedDateTime = (
  isoOrDate?: string | Date | null,
  timezone: string = DEFAULT_APP_TIMEZONE,
): string => {
  if (!isoOrDate) return '';
  const date = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  if (Number.isNaN(date.getTime())) return '';

  const formatter = new Intl.DateTimeFormat('ja-JP', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  });

  return formatter.format(date).replace(/\//g, '-');
};

/**
 * Maps a 24-hour localized clock hour (`0`..`23`) to its conversational time bracket.
 *
 * @param numericHour - Hour of day in 24-hour clock format (`0`-`23`).
 * @returns Discrete time-of-day period bracket.
 */
export const resolveTimeContextPeriod = (numericHour: number): TimeContextPeriod => {
  if (numericHour >= 5 && numericHour <= 6) {
    return 'early_morning';
  }
  if (numericHour >= 7 && numericHour <= 10) {
    return 'morning';
  }
  if (numericHour >= 11 && numericHour <= 16) {
    return 'daytime';
  }
  if (numericHour >= 17 && numericHour <= 21) {
    return 'evening';
  }
  return 'late_night';
};

/**
 * Resolves a localized human-readable label for a {@link TimeContextPeriod}.
 *
 * @param period - Discrete time-of-day period bracket.
 * @param lang - Target language (`'ja'` or `'en'`). Defaults to `'ja'`.
 * @returns Localized label (`'早朝'`/`'朝'`/`'昼'`/`'夕方・夜'`/`'深夜'` or English equivalent).
 */
export const formatTimeContextPeriodLabel = (
  period: TimeContextPeriod,
  lang: 'ja' | 'en' = 'ja',
): string => {
  const labels: Readonly<Record<TimeContextPeriod, { ja: string; en: string }>> = {
    early_morning: { ja: '早朝', en: 'Early Morning' },
    morning: { ja: '朝', en: 'Morning' },
    daytime: { ja: '昼', en: 'Daytime' },
    evening: { ja: '夕方・夜', en: 'Evening' },
    late_night: { ja: '深夜', en: 'Late Night' },
  };
  return labels[period][lang];
};
