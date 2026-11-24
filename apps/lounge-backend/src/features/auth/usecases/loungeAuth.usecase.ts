import {
  CURRENT_LOUNGE_DISCLAIMER_VERSION,
  type LoungeAuthSessionDto,
  type LoungeLanguage,
  type LoungeLoginRequestDto,
  type LoungeSignUpRequestDto,
  type LoungeUserDisclaimerConsent,
} from '@rebecca/types';
import type { ResolvedClientGeo } from '../../../config/loungeConfig';
import type { ILoungeAuthVerifierPort, LoungeVerifiedIdentity } from '../../../middleware/loungeAuth';
import {
  LoungeAuthError,
  LoungeConflictError,
  LoungeHttpError,
  LoungeQuotaExhaustedError,
  LoungeValidationError,
} from '../../../utils/errors';
import {
  isStrictIsoTimestamp,
  parseSupportedLoungeLanguage,
  parseValidIanaTimezone,
} from '../../../utils/locale';
import { toPublicLoungeUser, type ILoungeAuthRepository } from '../repositories/loungeAuth.repository';

/**
 * Use case contract for X-linked Private Lounge sign-up, login, and logout.
 */
export interface ILoungeAuthUseCase {
  signUpWithX(
    request: LoungeSignUpRequestDto,
    clientGeo?: ResolvedClientGeo,
  ): Promise<LoungeAuthSessionDto>;
  loginWithX(request: LoungeLoginRequestDto): Promise<LoungeAuthSessionDto>;
  logout(uid: string): Promise<void>;
}

/**
 * Validates and whitelists scroll-verified sign-up or re-consent terms at the trust boundary.
 * Never returns unwhitelisted client properties.
 *
 * @throws LoungeValidationError When fields are non-object, version is invalid/outdated, clauses are unaccepted, or timestamps are chronologically invalid.
 */
export function parseAndValidateSignUpConsent(
  raw: unknown,
  requiredVersion?: number,
): LoungeUserDisclaimerConsent {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LoungeValidationError('Field "disclaimerConsent" must be an object');
  }
  const candidate = raw as Record<string, unknown>;
  const rawVersion = candidate['disclaimerVersion'];
  if (typeof rawVersion !== 'number' || !Number.isInteger(rawVersion) || rawVersion < 1) {
    throw new LoungeValidationError('Disclaimer version must be a positive integer');
  }
  if (requiredVersion !== undefined && rawVersion !== requiredVersion) {
    throw new LoungeValidationError(
      `Outdated or mismatched disclaimer version (${rawVersion}); latest version ${requiredVersion} must be accepted`,
    );
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
    typeof candidate['consentedAt'] !== 'string' ||
    !isStrictIsoTimestamp(candidate['scrolledToBottomAt']) ||
    !isStrictIsoTimestamp(candidate['consentedAt'])
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
    disclaimerVersion: rawVersion,
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
export function parseAndValidateSignUpRequest(
  raw: unknown,
  requiredVersion?: number,
): LoungeSignUpRequestDto {
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
  const disclaimerConsent = parseAndValidateSignUpConsent(
    candidate['disclaimerConsent'],
    requiredVersion,
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
    xOAuthCode,
    disclaimerConsent,
    ...(language ? { language } : {}),
    ...(timezone ? { timezone } : {}),
  };
}

/**
 * Orchestrates X-linked authentication and mandatory scroll-gated disclaimer validation.
 */
export class LoungeAuthUseCase implements ILoungeAuthUseCase {
  private dailySignupUtcDate = new Date().toISOString().slice(0, 10);
  private dailySignupCount = 0;

  constructor(
    private readonly authRepository: ILoungeAuthRepository,
    private readonly authVerifier: ILoungeAuthVerifierPort,
    private readonly appVersion: string,
    private readonly disclaimerVersion: number = CURRENT_LOUNGE_DISCLAIMER_VERSION,
    private readonly globalDailySignupCap: number = 2000,
  ) {}

  /**
   * Validates that the user scrolled the disclaimer to bottom and agreed to Gemini training,
   * zero-PII prohibition, and one-way memory isolation, then enforces 1:1 X linkage before sign-up.
   *
   * @throws LoungeValidationError When disclaimer version is invalid/outdated or timestamps are invalid.
   * @throws LoungeConflictError When UID or X user ID already owns a registered `lounge_users` account (`409`).
   * @throws LoungeQuotaExhaustedError When the global daily sign-up circuit breaker is reached (`429`).
   */
  public async signUpWithX(
    request: LoungeSignUpRequestDto,
    clientGeo?: ResolvedClientGeo,
  ): Promise<LoungeAuthSessionDto> {
    const todayUtc = new Date().toISOString().slice(0, 10);
    if (todayUtc !== this.dailySignupUtcDate) {
      this.dailySignupUtcDate = todayUtc;
      this.dailySignupCount = 0;
    }
    if (this.dailySignupCount >= this.globalDailySignupCap) {
      throw new LoungeQuotaExhaustedError(
        'Daily registration capacity reached; please try again later',
      );
    }

    const sanitized = parseAndValidateSignUpRequest(request, this.disclaimerVersion);
    const identity = await this.verifyIdentityToken(sanitized.idToken);
    const [existingByUid, existingByX] = await Promise.all([
      this.authRepository.findUserByUid(identity.uid),
      this.authRepository.findUserByXUserId(identity.xUserId),
    ]);
    if (existingByUid || existingByX) {
      throw new LoungeConflictError('An account linked to this X account is already registered');
    }

    const user = await this.authRepository.createUserWithConsent({
      uid: identity.uid,
      xUserId: identity.xUserId,
      xHandle: identity.xHandle,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
      disclaimerConsent: sanitized.disclaimerConsent,
      onboardingCompleted: false,
      language: sanitized.language,
      timezone: sanitized.timezone,
      allowServiceImprovementAnalytics: true,
      ...(clientGeo
        ? {
            countryCode: clientGeo.countryCode,
            isEeaResident: clientGeo.isEeaResident,
            preferredCurrency: clientGeo.currency,
          }
        : {}),
    });

    this.dailySignupCount += 1;

    return {
      user: toPublicLoungeUser(user),
      appVersion: this.appVersion,
      issuedAt: new Date().toISOString(),
    };
  }

  /**
   * Authenticates an existing Private Lounge user linked to X OAuth.
   *
   * @throws LoungeValidationError When `idToken` is missing/blank.
   * @throws LoungeAuthError When Firebase token is invalid (`401`) or account is unregistered (`401`) or suspended (`403`).
   */
  public async loginWithX(request: LoungeLoginRequestDto): Promise<LoungeAuthSessionDto> {
    const sanitized = parseAndValidateLoginRequest(request);
    const identity = await this.verifyIdentityToken(sanitized.idToken);
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
      user: toPublicLoungeUser({ ...user, lastLoginAt: nowIso }),
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

  private async verifyIdentityToken(idToken: string): Promise<LoungeVerifiedIdentity> {
    try {
      return await this.authVerifier.verifyBearerToken(idToken);
    } catch (err) {
      if (err instanceof LoungeHttpError) {
        throw err;
      }
      throw new LoungeAuthError(401, 'Invalid or expired authentication token', { cause: err });
    }
  }
}
