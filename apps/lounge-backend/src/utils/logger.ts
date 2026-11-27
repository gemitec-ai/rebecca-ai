import { Logger } from '@rebecca/logger';

/**
 * Shared structured logger instance for the Private Lounge BFF service.
 */
export const loungeLogger = new Logger('lounge-backend');

/**
 * Strips CR/LF control sequences from untrusted log strings to prevent multi-line log injection.
 */
export function toSingleLineLog(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}
