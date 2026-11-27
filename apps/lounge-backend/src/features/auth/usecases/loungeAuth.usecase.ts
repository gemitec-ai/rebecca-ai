import {
  CURRENT_LOUNGE_DISCLAIMER_VERSION,
  type LoungeAuthSessionDto,
  type LoungeLoginRequestDto,
  type LoungeSignUpRequestDto,
} from '@rebecca/types';
import { assertActiveLoungeUserStatus } from '../../../domain/loungeAccessPolicy';
import { toPublicLoungeUser } from '../../../domain/loungeUser.domain';
import {
  assertGeoEligibleForPhase,
  type LoungeGeoCompliancePolicy,
  type ResolvedClientGeo,
} from '../../../utils/clientGeo';
import {
  LoungeAuthError,
  LoungeHttpError,
  LoungeQuotaExhaustedError,
  LoungeValidationError,
} from '../../../utils/errors';
import { loungeLogger } from '../../../utils/logger';
import type {
  ILoungeAuthVerifierPort,
  LoungeVerifiedIdentity,
} from '../ports/loungeAuthVerifier.port';
import type { ILoungeAuthRepository } from '../repositories/loungeAuth.repository';
import {
  parseAndValidateLoginRequest,
  parseAndValidateSignUpRequest,
} from '../validators/loungeAuth.validator';

/**
 * Use case contract for X-linked Private Lounge sign-up, login, and logout.
 */
export interface ILoungeAuthUseCase {
  /** Registers a new 1:1 X-linked Private Lounge user after Geo-IP and scroll-gated disclaimer checks. */
  signUpWithX(
    request: LoungeSignUpRequestDto,
    clientGeo?: ResolvedClientGeo,
    traceHeader?: string,
  ): Promise<LoungeAuthSessionDto>;
  /** Authenticates an existing Private Lounge user after verifying token, Geo-IP policy, and account status. */
  loginWithX(
    request: LoungeLoginRequestDto,
    clientGeo?: ResolvedClientGeo,
    traceHeader?: string,
  ): Promise<LoungeAuthSessionDto>;
  /**
   * Revokes active Firebase Auth session credentials for `uid`.
   *
   * @throws LoungeValidationError When `uid` is empty or whitespace.
   */
  logout(uid: string, traceHeader?: string): Promise<void>;
}

/**
 * Orchestrates X-linked authentication, Phase 1/2 Geo-IP compliance, and scroll-gated disclaimer validation.
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
    private readonly geoPolicy: LoungeGeoCompliancePolicy = {
      phase2EeaEnabled: false,
      allowDefaultGeoFallback: true,
    },
  ) {}

  /**
   * Enforces regional Phase 1 EEA/UK/CH block, validates scroll-gated consent (including non-EEA eligibility
   * during Phase 1), and registers 1:1 X-linked user state.
   *
   * @throws LoungeForbiddenError When EEA/UK/CH is blocked in Phase 1 (`403 GEO_BLOCKED`) or Geo-IP is unavailable (`403 GEO_UNAVAILABLE`).
   * @throws LoungeValidationError When disclaimer version is invalid/outdated, timestamps are invalid, or Phase 1 non-EEA clause is unchecked.
   * @throws LoungeConflictError When UID or X user ID already owns a registered `lounge_users` account (`409`).
   * @throws LoungeQuotaExhaustedError When the global daily sign-up circuit breaker is reached (`429`).
   */
  public async signUpWithX(
    request: LoungeSignUpRequestDto,
    clientGeo?: ResolvedClientGeo,
    traceHeader?: string,
  ): Promise<LoungeAuthSessionDto> {
    assertGeoEligibleForPhase(clientGeo, this.geoPolicy);

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

    this.dailySignupCount += 1;
    try {
      const sanitized = parseAndValidateSignUpRequest(request, this.disclaimerVersion, {
        requireNonEeaEligibility: !this.geoPolicy.phase2EeaEnabled,
      });
      const identity = await this.verifyIdentityToken(sanitized.idToken);
      const isEeaResident = clientGeo?.isEeaResident ?? false;
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
        allowServiceImprovementAnalytics: !isEeaResident,
        ...(clientGeo
          ? {
              countryCode: clientGeo.countryCode,
              isEeaResident: clientGeo.isEeaResident,
              preferredCurrency: clientGeo.currency,
            }
          : {}),
      });

      loungeLogger.info(
        'Completed Private Lounge X-linked user registration',
        {
          uid: user.uid,
          countryCode: clientGeo?.countryCode ?? 'UNKNOWN',
          isEeaResident,
        },
        traceHeader,
      );

      return {
        user: toPublicLoungeUser(user),
        appVersion: this.appVersion,
        issuedAt: new Date().toISOString(),
      };
    } catch (err) {
      this.dailySignupCount = Math.max(0, this.dailySignupCount - 1);
      throw err;
    }
  }

  /**
   * Authenticates an existing Private Lounge user linked to X OAuth after verifying regional compliance.
   *
   * @throws LoungeForbiddenError When EEA/UK/CH is blocked in Phase 1 (`403 GEO_BLOCKED`) or Geo-IP is unavailable (`403 GEO_UNAVAILABLE`).
   * @throws LoungeValidationError When `idToken` is missing/blank.
   * @throws LoungeAuthError When Firebase token is invalid (`401`) or account is unregistered (`401`) or suspended (`403`).
   */
  public async loginWithX(
    request: LoungeLoginRequestDto,
    clientGeo?: ResolvedClientGeo,
    traceHeader?: string,
  ): Promise<LoungeAuthSessionDto> {
    assertGeoEligibleForPhase(clientGeo, this.geoPolicy);

    const sanitized = parseAndValidateLoginRequest(request);
    const identity = await this.verifyIdentityToken(sanitized.idToken);
    const user = await this.authRepository.findUserByUid(identity.uid);
    if (!user) {
      throw new LoungeAuthError(401, 'Private Lounge user not registered');
    }
    assertGeoEligibleForPhase(clientGeo, this.geoPolicy, user.isEeaResident);
    assertActiveLoungeUserStatus(user);

    const nowIso = new Date().toISOString();
    await this.authRepository.recordLoginTimestamp(user.uid, nowIso);

    loungeLogger.info(
      'Authenticated Private Lounge X-linked session',
      { uid: user.uid },
      traceHeader,
    );

    return {
      user: toPublicLoungeUser({ ...user, lastLoginAt: nowIso }),
      appVersion: this.appVersion,
      issuedAt: nowIso,
    };
  }

  /**
   * Revokes active session credentials for the authenticated user.
   *
   * @throws LoungeValidationError When `uid` is empty or whitespace.
   */
  public async logout(uid: string, traceHeader?: string): Promise<void> {
    if (!uid.trim()) {
      throw new LoungeValidationError('Authenticated UID is required');
    }
    await this.authRepository.revokeSession(uid);
    loungeLogger.info('Revoked Private Lounge session credentials', { uid }, traceHeader);
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
