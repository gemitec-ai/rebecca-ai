import { Logger } from '@rebecca/logger';

/**
 * Shared structured logger instance for the Private Lounge BFF service.
 */
export const loungeLogger = new Logger('lounge-backend');

/**
 * Removes CR/LF control sequences from untrusted log strings to prevent log injection.
 */
export function sanitizeLogInput(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}
