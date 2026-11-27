import {
  CURRENT_LOUNGE_DISCLAIMER_VERSION,
  type LoungeAccountSummaryDto,
  type LoungeDeleteAccountRequestDto,
  type LoungePersonaBranding,
  type LoungeUpdateDisclaimerConsentRequestDto,
  type LoungeUpdatePreferencesRequestDto,
  type LoungeUser,
} from '@rebecca/types';
import { requireActiveLoungeUser } from '../../../domain/loungeAccessPolicy';
import { toPublicLoungeUser } from '../../../domain/loungeUser.domain';
import {
  LoungeAuthError,
  LoungeHttpError,
  LoungeNotFoundError,
  LoungeValidationError,
} from '../../../utils/errors';
import { loungeLogger } from '../../../utils/logger';
import type { ILoungeAuthRepository } from '../../auth/repositories/loungeAuth.repository';
import type { ILoungeGalleryRepository } from '../../gallery/repositories/loungeGallery.repository';
import type { ILoungeSessionRepository } from '../../sessions/repositories/loungeSession.repository';
import type { IStripeCustomerWithdrawalCleanupPort } from '../ports/stripeCustomerCleanup.port';
import type { ILoungeAccountRepository } from '../repositories/loungeAccount.repository';
import {
  parseAndValidateDeleteAccountRequest,
  parseAndValidatePreferencesRequest,
  parseAndValidateReconsentRequest,
} from '../validators/loungeAccount.validator';

/**
 * Use case contract for assembling account summary, updating preferences, and irreversible withdrawal.
 */
export interface ILoungeAccountUseCase {
  /** Retrieves sidebar account profile, subscription summary, and unlocked gallery totals. */
  getAccountSummary(uid: string): Promise<LoungeAccountSummaryDto>;
  /** Updates user locale, onboarding status, or analytics opt-out preferences. */
  updatePreferences(
    uid: string,
    request: LoungeUpdatePreferencesRequestDto,
    traceHeader?: string,
  ): Promise<LoungeUser>;
  /** Records scroll-verified acceptance of the required disclaimer version. */
  updateDisclaimerConsent(
    uid: string,
    request: LoungeUpdateDisclaimerConsentRequestDto,
    traceHeader?: string,
  ): Promise<LoungeUser>;
  /** Cancels external Stripe billing fail-closed and permanently wipes Private Lounge data. */
  deleteAccount(
    uid: string,
    request: LoungeDeleteAccountRequestDto,
    traceHeader?: string,
  ): Promise<void>;
}

/**
 * Aggregates profile, subscription tier, remaining chat turns, gallery count, locale preferences,
 * disclaimer re-consent updates, and cascading irreversible account withdrawal across `lounge_*` stores.
 */
export class LoungeAccountUseCase implements ILoungeAccountUseCase {
  constructor(
    private readonly authRepository: ILoungeAuthRepository,
    private readonly accountRepository: ILoungeAccountRepository,
    private readonly galleryRepository: ILoungeGalleryRepository,
    private readonly sessionRepository: ILoungeSessionRepository,
    private readonly appVersion: string,
    private readonly stripeWithdrawalCleanup: IStripeCustomerWithdrawalCleanupPort,
    private readonly personaBranding?: LoungePersonaBranding,
    private readonly disclaimerVersion: number = CURRENT_LOUNGE_DISCLAIMER_VERSION,
    private readonly phase2EeaEnabled: boolean = false,
  ) {}

  /**
   * Builds the authenticated user's Sidebar/Account summary payload.
   *
   * @throws LoungeAuthError When the user profile does not exist or is suspended.
   * @throws LoungeNotFoundError When the subscription record is missing.
   */
  public async getAccountSummary(uid: string): Promise<LoungeAccountSummaryDto> {
    const user = await requireActiveLoungeUser(this.authRepository, uid);

    const subscription = await this.accountRepository.getSubscriptionByUid(uid);
    if (!subscription) {
      throw new LoungeNotFoundError('Lounge subscription record not found');
    }

    const galleryPage = await this.galleryRepository.listGalleryByUid(uid, { page: 1, limit: 1 });
    return {
      user: toPublicLoungeUser(user),
      subscription,
      ...(this.personaBranding ? { persona: this.personaBranding } : {}),
      unlockedGalleryCount: galleryPage.summary.unlockedCount,
      totalGalleryCount: galleryPage.summary.totalCount,
      appVersion: this.appVersion,
    };
  }

  /**
   * Updates language, IANA timezone, onboarding completion, and/or service analytics preferences
   * for an active Private Lounge user. Rejects enabling service-improvement analytics for EEA/UK/CH residents.
   *
   * @throws LoungeAuthError When user profile does not exist (`401`) or is suspended (`403`).
   * @throws LoungeValidationError When preference validation fails or an EEA resident attempts analytics opt-in (`400`).
   */
  public async updatePreferences(
    uid: string,
    request: LoungeUpdatePreferencesRequestDto,
    traceHeader?: string,
  ): Promise<LoungeUser> {
    const sanitized = parseAndValidatePreferencesRequest(request);
    const user = await requireActiveLoungeUser(this.authRepository, uid);
    if (user.isEeaResident === true && sanitized.allowServiceImprovementAnalytics === true) {
      throw new LoungeValidationError(
        'Service improvement analytics opt-in is not available for EEA/UK/Switzerland residents',
      );
    }

    const updated = await this.authRepository.updateUserPreferences(
      uid,
      sanitized.language,
      sanitized.timezone,
      sanitized.completeOnboarding,
      sanitized.allowServiceImprovementAnalytics,
    );
    loungeLogger.info('Updated Private Lounge user preferences', { uid }, traceHeader);
    return toPublicLoungeUser(updated);
  }

  /**
   * Records scroll-verified acceptance of the latest legal/privacy disclaimer version for an active user.
   * Enforces non-EEA/UK/Switzerland eligibility confirmation while Phase 2 EEA is disabled.
   *
   * @throws LoungeAuthError When user profile does not exist (`401`) or is suspended (`403`).
   * @throws LoungeValidationError When consent payload or version does not match `this.disclaimerVersion`.
   */
  public async updateDisclaimerConsent(
    uid: string,
    request: LoungeUpdateDisclaimerConsentRequestDto,
    traceHeader?: string,
  ): Promise<LoungeUser> {
    const parsed = parseAndValidateReconsentRequest(request, this.disclaimerVersion, {
      requireNonEeaEligibility: !this.phase2EeaEnabled,
    });
    await requireActiveLoungeUser(this.authRepository, uid);
    const updated = await this.authRepository.updateUserDisclaimerConsent(
      uid,
      parsed.disclaimerConsent,
    );
    loungeLogger.info(
      'Updated Private Lounge disclaimer re-consent',
      { uid, disclaimerVersion: parsed.disclaimerConsent.disclaimerVersion },
      traceHeader,
    );
    return toPublicLoungeUser(updated);
  }

  /**
   * Fail-closed irreversible withdrawal:
   * 1. Rejects `SUSPENDED` accounts (`403`) so disputed/blocked evidence stays intact.
   * 2. Marks `lounge_users/{uid}.status = 'DELETING'` so interrupted retries remain authorized.
   * 3. Sequentially cancels/releases/deletes Stripe customer & subs (`502` fail-closed before wiping DB).
   * 4. Deletes all `lounge_*` user data (preserving non-PII `lounge_trial_grants`) and revokes/deletes Auth.
   *
   * @throws LoungeValidationError When confirmation flags are incomplete (`400`).
   * @throws LoungeAuthError When user profile does not exist (`401`) or is `SUSPENDED` (`403`).
   * @throws LoungeHttpError With `statusCode: 502` and `code: 'STRIPE_CANCELLATION_FAILED'` on Stripe outage.
   */
  public async deleteAccount(
    uid: string,
    request: LoungeDeleteAccountRequestDto,
    traceHeader?: string,
  ): Promise<void> {
    parseAndValidateDeleteAccountRequest(request);
    const user = await this.authRepository.findUserByUid(uid);
    if (!user) {
      throw new LoungeAuthError(401, 'Private Lounge user profile not found');
    }
    if (user.status === 'SUSPENDED') {
      throw new LoungeAuthError(
        403,
        'Suspended account cannot be deleted while under dispute or compliance review',
      );
    }

    await this.authRepository.updateUserStatus(uid, 'DELETING');
    loungeLogger.info('Initiated Private Lounge irreversible account deletion', { uid }, traceHeader);

    const fullSub = await this.accountRepository.getSubscriptionDocByUid(uid);
    if (fullSub?.stripeCustomerId) {
      try {
        await this.stripeWithdrawalCleanup.cancelAndDeleteCustomer(fullSub.stripeCustomerId);
      } catch (err) {
        throw new LoungeHttpError(502, 'Failed to cancel active Stripe customer subscriptions', {
          code: 'STRIPE_CANCELLATION_FAILED',
          cause: err,
        });
      }
    }

    await Promise.all([
      this.sessionRepository.deleteAllUserSessionData(uid),
      this.galleryRepository.deleteAllUserGalleryItems(uid),
      this.accountRepository.deleteSubscription(uid),
    ]);
    await this.authRepository.revokeSession(uid);
    await this.authRepository.deleteUser(uid);
    loungeLogger.info('Completed Private Lounge irreversible account deletion', { uid }, traceHeader);
  }
}
