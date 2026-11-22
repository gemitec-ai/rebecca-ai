import type {
  LoungeAuthSessionDto,
  LoungeLoginRequestDto,
  LoungeSignUpRequestDto,
  LoungeUserDisclaimerConsent,
} from '@rebecca/types';
import type { ILoungeAuthVerifierPort } from '../../../middleware/loungeAuth';
import { LoungeAuthError, LoungeValidationError } from '../../../utils/errors';
import type { ILoungeAuthRepository } from '../repositories/loungeAuth.repository';

/**
 * Use case contract for X-linked Private Lounge sign-up, login, and logout.
 */
export interface ILoungeAuthUseCase {
  signUpWithX(request: LoungeSignUpRequestDto): Promise<LoungeAuthSessionDto>;
  loginWithX(request: LoungeLoginRequestDto): Promise<LoungeAuthSessionDto>;
  logout(uid: string): Promise<void>;
}

/**
 * Validates and whitelists scroll-verified sign-up consent at the trust boundary.
 * Never returns unwhitelisted client properties.
 *
 * @throws LoungeValidationError When fields are non-object, missing, falsy/non-boolean, or chronologically invalid.
 */
export function parseAndValidateSignUpConsent(raw: unknown): LoungeUserDisclaimerConsent {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LoungeValidationError('Field "disclaimerConsent" must be an object');
  }
  const candidate = raw as Record<string, unknown>;
  const disclaimerVersion =
    typeof candidate['disclaimerVersion'] === 'string'
      ? candidate['disclaimerVersion'].trim()
      : '';
  if (!disclaimerVersion) {
    throw new LoungeValidationError('Disclaimer version is required');
  }

  if (
    candidate['agreedToGeminiTrainingUsage'] !== true ||
    candidate['agreedToZeroPiiProhibition'] !== true ||
    candidate['agreedToOneWayMemoryIsolation'] !== true
  ) {
    throw new LoungeValidationError(
      'All mandatory Gemini training, zero-PII, and memory-isolation clauses must be accepted',
    );
  }

  if (
    typeof candidate['scrolledToBottomAt'] !== 'string' ||
    typeof candidate['consentedAt'] !== 'string'
  ) {
    throw new LoungeValidationError(
      'Scroll and consent verification timestamps must be valid ISO 8601 strings',
    );
  }

  const scrolledMs = Date.parse(candidate['scrolledToBottomAt']);
  const consentedMs = Date.parse(candidate['consentedAt']);
  if (Number.isNaN(scrolledMs) || Number.isNaN(consentedMs) || consentedMs < scrolledMs) {
    throw new LoungeValidationError(
      'Disclaimer must be scrolled to bottom before consent confirmation',
    );
  }

  return {
    disclaimerVersion,
    agreedToGeminiTrainingUsage: true,
    agreedToZeroPiiProhibition: true,
    agreedToOneWayMemoryIsolation: true,
    scrolledToBottomAt: candidate['scrolledToBottomAt'],
    consentedAt: candidate['consentedAt'],
  };
}

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
  const xOAuthCode =
    typeof candidate['xOAuthCode'] === 'string' && candidate['xOAuthCode'].trim()
      ? candidate['xOAuthCode'].trim()
      : undefined;
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
export function parseAndValidateSignUpRequest(raw: unknown): LoungeSignUpRequestDto {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LoungeValidationError('Invalid sign-up request payload');
  }
  const candidate = raw as Record<string, unknown>;
  const idToken = typeof candidate['idToken'] === 'string' ? candidate['idToken'].trim() : '';
  if (!idToken) {
    throw new LoungeValidationError('Field "idToken" is required');
  }
  const xOAuthCode =
    typeof candidate['xOAuthCode'] === 'string' ? candidate['xOAuthCode'].trim() : '';
  if (!xOAuthCode) {
    throw new LoungeValidationError('Field "xOAuthCode" is required for X OAuth sign-up');
  }
  const disclaimerConsent = parseAndValidateSignUpConsent(candidate['disclaimerConsent']);
  return {
    idToken,
    xOAuthCode,
    disclaimerConsent,
  };
}

/**
 * Orchestrates X-linked authentication and mandatory scroll-gated disclaimer validation.
 */
export class LoungeAuthUseCase implements ILoungeAuthUseCase {
  constructor(
    private readonly authRepository: ILoungeAuthRepository,
    private readonly authVerifier: ILoungeAuthVerifierPort,
    private readonly appVersion: string,
  ) {}

  /**
   * Validates that the user scrolled the disclaimer to bottom and agreed to Gemini training,
   * zero-PII prohibition, and one-way memory isolation, then enforces 1:1 X linkage before sign-up.
   *
   * @throws LoungeValidationError When disclaimer flags or ISO audit timestamps are incomplete.
   * @throws LoungeAuthError When UID or X user ID is already registered in `lounge_users` or token is invalid.
   */
  public async signUpWithX(request: LoungeSignUpRequestDto): Promise<LoungeAuthSessionDto> {
    const sanitized = parseAndValidateSignUpRequest(request);
    const identity = await this.authVerifier.verifyBearerToken(sanitized.idToken);
    const [existingByUid, existingByX] = await Promise.all([
      this.authRepository.findUserByUid(identity.uid),
      this.authRepository.findUserByXUserId(identity.xUserId),
    ]);
    if (existingByUid || existingByX) {
      throw new LoungeAuthError(403, 'Private Lounge account already registered');
    }

    const user = await this.authRepository.createUserWithConsent({
      uid: identity.uid,
      xUserId: identity.xUserId,
      xHandle: identity.xHandle,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
      disclaimerConsent: sanitized.disclaimerConsent,
    });

    return {
      user,
      appVersion: this.appVersion,
      issuedAt: new Date().toISOString(),
    };
  }

  /**
   * Authenticates an existing Private Lounge user linked to X OAuth.
   *
   * @throws LoungeValidationError When `idToken` is missing/blank.
   * @throws LoungeAuthError When account is not registered or is suspended.
   */
  public async loginWithX(request: LoungeLoginRequestDto): Promise<LoungeAuthSessionDto> {
    const sanitized = parseAndValidateLoginRequest(request);
    const identity = await this.authVerifier.verifyBearerToken(sanitized.idToken);
    const user = await this.authRepository.findUserByUid(identity.uid);
    if (!user) {
      throw new LoungeAuthError(401, 'Private Lounge user not registered');
    }
    if (user.status !== 'ACTIVE') {
      throw new LoungeAuthError(403, 'Private Lounge account is suspended');
    }

    const nowIso = new Date().toISOString();
    await this.authRepository.recordLoginTimestamp(user.uid, nowIso);

    return {
      user: { ...user, lastLoginAt: nowIso },
      appVersion: this.appVersion,
      issuedAt: nowIso,
    };
  }

  /**
   * Revokes active session credentials for the authenticated user.
   */
  public async logout(uid: string): Promise<void> {
    if (!uid.trim()) {
      throw new LoungeValidationError('Authenticated UID is required');
    }
    await this.authRepository.revokeSession(uid);
  }
}
