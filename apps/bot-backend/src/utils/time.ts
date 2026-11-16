import {
  formatZonedDateTime as formatZonedDateTimeCore,
  getZonedDateParts as getZonedDatePartsCore,
  type ZonedDateParts,
} from '@rebecca/prompt';
import config from '../config';

export type { ZonedDateParts };

/**
 * Extracts localized calendar and clock components for a given date in the target timezone.
 * Uses ECMA-402 Intl.DateTimeFormat for strict and DST-aware calculations.
 *
 * @param date - The Date instance to evaluate (defaults to current time).
 * @param timezone - Target IANA time zone identifier (defaults to config.appTimezone).
 * @returns Localized date parts with string (zero-padded) and numeric values.
 */
export const getZonedDateParts = (
  date: Date = new Date(),
  timezone: string = config.appTimezone,
): ZonedDateParts => {
  return getZonedDatePartsCore(date, timezone);
};

/**
 * Formats a Date or ISO-8601 string into a human-readable zoned timestamp: YYYY-MM-DD HH:mm [TZ].
 *
 * @param isoOrDate - ISO-8601 string or Date object representing the timestamp.
 * @param timezone - Target IANA time zone identifier (defaults to config.appTimezone).
 * @returns Formatted date string with timezone abbreviation (e.g. "2026-09-13 07:30 JST"),
 *          or an empty string if input is falsy or invalid.
 */
export const formatZonedDateTime = (
  isoOrDate?: string | Date | null,
  timezone: string = config.appTimezone,
): string => {
  return formatZonedDateTimeCore(isoOrDate, timezone);
};

