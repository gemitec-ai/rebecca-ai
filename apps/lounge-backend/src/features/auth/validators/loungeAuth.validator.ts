import type {
  LoungeLanguage,
  LoungeLoginRequestDto,
  LoungeSignUpRequestDto,
} from '@rebecca/types';
import { parseAndValidateSignUpConsent } from '../../../domain/loungeUser.domain';
import { LoungeValidationError } from '../../../utils/errors';
import { parseSupportedLoungeLanguage, parseValidIanaTimezone } from '../../../utils/locale';

/**
 * Parses and validates an incoming X-linked login payload at the trust boundary.
 *
 * @throws LoungeValidationError When payload is non-object or missing a non-empty `idToken`.
 */
export function parseAndValidateLoginRequest(raw: unknown): LoungeLoginRequestDto {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LoungeValidationError('Invalid login request payload');
  }
  const candidate = raw as Record<string, unknown>;
  const idToken = typeof candidate['idToken'] === 'string' ? candidate['idToken'].trim() : '';
  if (!idToken) {
    throw new LoungeValidationError('Invalid login request payload');
  }
  const rawOAuth = candidate['xOAuthCode'];
  if (rawOAuth !== undefined && typeof rawOAuth !== 'string') {
    throw new LoungeValidationError('Field "xOAuthCode" must be a string when provided');
  }
  const xOAuthCode = typeof rawOAuth === 'string' && rawOAuth.trim() ? rawOAuth.trim() : undefined;
  return {
    idToken,
    ...(xOAuthCode ? { xOAuthCode } : {}),
  };
}

/**
 * Parses and validates an incoming X-linked sign-up payload at the trust boundary.
 *
 * @throws LoungeValidationError When payload tokens or scroll-gated consent terms are invalid.
 */
export function parseAndValidateSignUpRequest(
  raw: unknown,
  requiredVersion?: number,
  options: { readonly requireNonEeaEligibility?: boolean } = {},
): LoungeSignUpRequestDto {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LoungeValidationError('Invalid sign-up request payload');
  }
  const candidate = raw as Record<string, unknown>;
  const idToken = typeof candidate['idToken'] === 'string' ? candidate['idToken'].trim() : '';
  if (!idToken) {
    throw new LoungeValidationError('Field "idToken" is required');
  }
  const rawOAuth = candidate['xOAuthCode'];
  if (rawOAuth !== undefined && typeof rawOAuth !== 'string') {
    throw new LoungeValidationError('Field "xOAuthCode" must be a string when provided');
  }
  const xOAuthCode = typeof rawOAuth === 'string' && rawOAuth.trim() ? rawOAuth.trim() : undefined;
  const disclaimerConsent = parseAndValidateSignUpConsent(
    candidate['disclaimerConsent'],
    requiredVersion,
    options,
  );
  const language: LoungeLanguage | undefined =
    candidate['language'] !== undefined
      ? parseSupportedLoungeLanguage(candidate['language'])
      : undefined;
  const timezone: string | undefined =
    candidate['timezone'] !== undefined
      ? parseValidIanaTimezone(candidate['timezone'])
      : undefined;

  return {
    idToken,
    ...(xOAuthCode ? { xOAuthCode } : {}),
    disclaimerConsent,
    ...(language ? { language } : {}),
    ...(timezone ? { timezone } : {}),
  };
}
