import {
  DEFAULT_APP_TIMEZONE,
  formatTimeContextPeriodLabel,
  formatZonedDateTime,
  getZonedDateParts,
  resolveTimeContextPeriod,
} from '../src';

describe('@rebecca/prompt time utilities', () => {
  describe('getZonedDateParts', () => {
    it('extracts JST date parts accurately from a UTC timestamp', () => {
      const utcDate = new Date('2026-04-23T15:05:09.000Z');
      const parts = getZonedDateParts(utcDate, DEFAULT_APP_TIMEZONE);

      expect(parts).toEqual({
        year: '2026',
        month: '04',
        day: '24',
        hour: '00',
        minute: '05',
        second: '09',
        numericYear: 2026,
        numericMonth: 4,
        numericDay: 24,
        numericHour: 0,
        numericMinute: 5,
      });
    });

    it('supports explicit timezone overrides such as UTC', () => {
      const utcDate = new Date('2026-04-23T15:05:09.000Z');
      const parts = getZonedDateParts(utcDate, 'UTC');

      expect(parts.day).toBe('23');
      expect(parts.hour).toBe('15');
      expect(parts.numericHour).toBe(15);
    });

    it('fails fast when given an invalid IANA timezone string', () => {
      expect(() => getZonedDateParts(new Date(), 'Invalid/Timezone_XYZ')).toThrow();
    });
  });

  describe('formatZonedDateTime', () => {
    it('returns empty string for null, undefined, empty, or invalid dates', () => {
      expect(formatZonedDateTime(undefined)).toBe('');
      expect(formatZonedDateTime(null)).toBe('');
      expect(formatZonedDateTime('')).toBe('');
      expect(formatZonedDateTime('not-a-valid-date')).toBe('');
    });

    it('formats ISO string and Date instances in YYYY-MM-DD HH:mm format', () => {
      const iso = '2026-09-13T07:30:00.000Z';
      const formattedUtc = formatZonedDateTime(iso, 'UTC');
      const formattedFromDate = formatZonedDateTime(new Date(iso), 'UTC');

      expect(formattedUtc).toContain('2026-09-13');
      expect(formattedUtc).toContain('07:30');
      expect(formattedFromDate).toBe(formattedUtc);
    });

    it('throws RangeError when given an invalid IANA timezone for a valid timestamp', () => {
      expect(() => formatZonedDateTime('2026-09-13T07:30:00.000Z', 'Invalid/Timezone_XYZ')).toThrow(RangeError);
    });
  });

  describe('resolveTimeContextPeriod', () => {
    it.each([
      [4, 'late_night'],
      [5, 'early_morning'],
      [6, 'early_morning'],
      [7, 'morning'],
      [10, 'morning'],
      [11, 'daytime'],
      [16, 'daytime'],
      [17, 'evening'],
      [21, 'evening'],
      [22, 'late_night'],
      [0, 'late_night'],
    ])('maps boundary hour %i to %s', (hour, expected) => {
      expect(resolveTimeContextPeriod(hour)).toBe(expected);
    });
  });

  describe('formatTimeContextPeriodLabel', () => {
    it('returns localized labels for every TimeContextPeriod', () => {
      expect(formatTimeContextPeriodLabel('early_morning', 'ja')).toBe('早朝');
      expect(formatTimeContextPeriodLabel('morning', 'ja')).toBe('朝');
      expect(formatTimeContextPeriodLabel('daytime', 'ja')).toBe('昼');
      expect(formatTimeContextPeriodLabel('evening', 'ja')).toBe('夕方・夜');
      expect(formatTimeContextPeriodLabel('late_night', 'ja')).toBe('深夜');
      expect(formatTimeContextPeriodLabel('evening', 'en')).toBe('Evening');
    });
  });
});
