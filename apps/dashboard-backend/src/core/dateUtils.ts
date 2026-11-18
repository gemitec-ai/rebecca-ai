import { DateTime } from 'luxon';

/**
 * Standard preset periods for query filtering.
 */
export const StandardTimePeriod = {
  TODAY: 'today',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
  YEARLY: 'yearly',
  ALL_TIME: 'all-time'
} as const;

export type StandardTimePeriod = typeof StandardTimePeriod[keyof typeof StandardTimePeriod];

/**
 * Strict regex for relative duration specifications:
 * e.g., '7d', '14d', '2w', '3m', '1y'
 * Captures positive integer count (>= 1) and duration unit ('d' | 'w' | 'm' | 'y').
 */
export const RELATIVE_DURATION_REGEX = /^([1-9]\d*)([dwmy])$/i;

/**
 * Parsed duration breakdown with normalized Luxon duration units.
 */
export interface RelativeDuration {
  readonly count: number;
  readonly unit: 'days' | 'weeks' | 'months' | 'years';
}

/**
 * Parses a relative duration string into a typed RelativeDuration, or returns null if invalid.
 *
 * @param input - Duration string like '7d', '14d', '2w', '3m', '1y'.
 * @returns RelativeDuration object or null.
 */
export function parseRelativeDuration(input: string): RelativeDuration | null {
  const match = RELATIVE_DURATION_REGEX.exec(input.trim());
  if (!match) return null;

  const count = parseInt(match[1], 10);
  if (!Number.isFinite(count) || count <= 0) return null;

  const rawUnit = match[2].toLowerCase();
  switch (rawUnit) {
    case 'd':
      return { count, unit: 'days' };
    case 'w':
      return { count, unit: 'weeks' };
    case 'm':
      return { count, unit: 'months' };
    case 'y':
      return { count, unit: 'years' };
    default:
      return null;
  }
}

/**
 * Calculates the start and end UTC ISO timestamps for a calendar period aligned with the specified IANA timezone.
 *
 * @param period - The aggregation period. Accepted values are 'monthly', 'yearly', or 'all-time'.
 * @param isoDate - The ISO-8601 formatted date string representing the target period (e.g., '2026-07' or '2026').
 * @param timezone - Target IANA timezone identifier (defaults to `'Asia/Tokyo'`).
 * @returns An object containing the start and end ISO strings in UTC, or null if the period is 'all-time', invalid, or not provided.
 */
export function getJstDateRangeInUtc(
  period: string,
  isoDate?: string,
  timezone: string = 'Asia/Tokyo',
): { start: string; end: string } | null {
  if (period === StandardTimePeriod.ALL_TIME || !isoDate) {
    return null;
  }

  if (period === StandardTimePeriod.YEARLY) {
    const year = parseInt(isoDate, 10);
    if (isNaN(year)) return null;
    const startDt = DateTime.fromObject({ year, month: 1, day: 1 }, { zone: timezone });
    const endDt = DateTime.fromObject({ year, month: 12, day: 31 }, { zone: timezone });
    if (!startDt.isValid || !endDt.isValid) return null;

    const start = startDt.startOf('day').toUTC().toISO();
    const end = endDt.endOf('day').toUTC().toISO();
    if (!start || !end) return null;

    return { start, end };
  }

  if (period === StandardTimePeriod.MONTHLY) {
    const dt = DateTime.fromFormat(isoDate, 'yyyy-MM', { zone: timezone });
    if (!dt.isValid) return null;

    const start = dt.startOf('month').toUTC().toISO();
    const end = dt.endOf('month').toUTC().toISO();
    if (!start || !end) return null;

    return { start, end };
  }

  return null;
}

/**
 * Calculates start and end UTC timestamps for relative duration windows ('7d', '14d', '2w', '3m'),
 * standard named presets ('today', 'weekly', 'monthly', 'yearly'),
 * or calendar periods ('monthly', 'yearly' with isoDate) aligned with the requested timezone boundaries.
 * Returns null if the period is 'all-time', undefined, or unsupported.
 *
 * @param period - The period window ('today', 'weekly', 'monthly', 'yearly', 'all-time', or duration '7d', '14d', '2w', etc.).
 * @param isoDate - Optional specific calendar date ('yyyy-MM' or 'yyyy').
 * @param timezone - Target IANA timezone identifier (defaults to `'Asia/Tokyo'`).
 * @returns Object with start and end ISO strings in UTC, or null.
 */
export function getTimelinePeriodRangeInUtc(
  period?: string,
  isoDate?: string,
  timezone: string = 'Asia/Tokyo',
): { start: string; end: string } | null {
  if (!period || period === StandardTimePeriod.ALL_TIME) {
    return null;
  }

  const normalized = period.trim().toLowerCase();
  const nowZoned = DateTime.now().setZone(timezone);

  // 1. Strict relative duration parsing (e.g. '7d', '14d', '2w', '3m', '1y')
  const relative = parseRelativeDuration(normalized);
  if (relative) {
    const start = nowZoned.minus({ [relative.unit]: relative.count }).startOf('day').toUTC().toISO();
    const end = nowZoned.endOf('day').toUTC().toISO();
    if (start && end) {
      return { start, end };
    }
  }

  // 2. Standard named presets
  if (normalized === StandardTimePeriod.TODAY) {
    const start = nowZoned.startOf('day').toUTC().toISO();
    const end = nowZoned.endOf('day').toUTC().toISO();
    if (start && end) return { start, end };
  }

  if (normalized === StandardTimePeriod.WEEKLY) {
    const start = nowZoned.minus({ days: 7 }).startOf('day').toUTC().toISO();
    const end = nowZoned.endOf('day').toUTC().toISO();
    if (start && end) return { start, end };
  }

  // 3. Calendar isoDate specification
  if (isoDate) {
    const calendarRange = getJstDateRangeInUtc(normalized, isoDate, timezone);
    if (calendarRange) return calendarRange;
  }

  if (normalized === StandardTimePeriod.MONTHLY) {
    const start = nowZoned.startOf('month').toUTC().toISO();
    const end = nowZoned.endOf('month').toUTC().toISO();
    if (start && end) return { start, end };
  }

  if (normalized === StandardTimePeriod.YEARLY) {
    const start = nowZoned.startOf('year').toUTC().toISO();
    const end = nowZoned.endOf('year').toUTC().toISO();
    if (start && end) return { start, end };
  }

  return null;
}
