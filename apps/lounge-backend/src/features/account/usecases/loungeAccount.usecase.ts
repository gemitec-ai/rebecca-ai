import type {
  LoungeAccountSummaryDto,
  LoungeDeleteAccountRequestDto,
  LoungePersonaBranding,
  LoungeUpdatePreferencesRequestDto,
  LoungeUser,
} from '@rebecca/types';
import {
  LoungeAuthError,
  LoungeNotFoundError,
  LoungeValidationError,
} from '../../../utils/errors';
import {
  SUPPORTED_LOUNGE_LANGUAGES,
  parseSupportedLoungeLanguage,
  parseValidIanaTimezone,
} from '../../../utils/locale';
import { toPublicLoungeUser, type ILoungeAuthRepository } from '../../auth/repositories/loungeAuth.repository';
import type { ILoungeGalleryRepository } from '../../gallery/repositories/loungeGallery.repository';
import type { ILoungeSessionRepository } from '../../sessions/repositories/loungeSession.repository';
import type { ILoungeAccountRepository } from '../repositories/loungeAccount.repository';

export { SUPPORTED_LOUNGE_LANGUAGES };

/**
 * Validates and whitelists user preference update payloads (`language`, `timezone`).
 *
 * @throws LoungeValidationError When payload is non-object, empty, or contains an unsupported language or invalid IANA timezone.
 */
export function parseAndValidatePreferencesRequest(
  raw: unknown,
): LoungeUpdatePreferencesRequestDto {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LoungeValidationError('Preferences payload must be a JSON object');
  }
  const candidate = raw as Record<string, unknown>;
  const result: LoungeUpdatePreferencesRequestDto = {};

  if (candidate['language'] !== undefined) {
    result.language = parseSupportedLoungeLanguage(candidate['language']);
  }

  if (candidate['timezone'] !== undefined) {
    result.timezone = parseValidIanaTimezone(candidate['timezone']);
  }

  if (result.language === undefined && result.timezone === undefined) {
    throw new LoungeValidationError('At least one of "language" or "timezone" must be provided');
  }

  return result;
}

/**
 * Validates and whitelists explicit confirmation checkboxes required for irreversible account withdrawal.
 *
 * @throws LoungeValidationError When payload is non-object or either confirmation checkbox is not `true`.
 */
export function parseAndValidateDeleteAccountRequest(
  raw: unknown,
): LoungeDeleteAccountRequestDto {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LoungeValidationError('Account deletion confirmation payload must be a JSON object');
  }
  const candidate = raw as Record<string, unknown>;
  if (candidate['confirmedIrreversibleDeletion'] !== true) {
    throw new LoungeValidationError(
      'Irreversible data deletion warning must be explicitly acknowledged',
    );
  }
  if (candidate['confirmedNoRefundForRemainingTurns'] !== true) {
    throw new LoungeValidationError(
      'No-refund notice for paid plans and remaining chat turns must be explicitly acknowledged',
    );
  }
  return {
    confirmedIrreversibleDeletion: true,
    confirmedNoRefundForRemainingTurns: true,
  };
}

/**
 * Use case contract for assembling account summary, updating preferences, and irreversible withdrawal.
 */
export interface ILoungeAccountUseCase {
  getAccountSummary(uid: string): Promise<LoungeAccountSummaryDto>;
  updatePreferences(uid: string, request: LoungeUpdatePreferencesRequestDto): Promise<LoungeUser>;
  deleteAccount(uid: string, request: LoungeDeleteAccountRequestDto): Promise<void>;
}

/**
 * Aggregates profile, subscription tier, remaining chat turns, gallery count, locale preferences,
 * and cascading irreversible account withdrawal across all isolated `lounge_*` stores.
 */
export class LoungeAccountUseCase implements ILoungeAccountUseCase {
  constructor(
    private readonly authRepository: ILoungeAuthRepository,
    private readonly accountRepository: ILoungeAccountRepository,
    private readonly galleryRepository: ILoungeGalleryRepository,
    private readonly sessionRepository: ILoungeSessionRepository,
    private readonly appVersion: string,
    private readonly personaBranding?: LoungePersonaBranding,
  ) {}

  /**
   * Builds the authenticated user's Sidebar/Account summary payload.
   *
   * @throws LoungeAuthError When the user profile does not exist or is suspended.
   * @throws LoungeNotFoundError When the subscription record is missing.
   */
  public async getAccountSummary(uid: string): Promise<LoungeAccountSummaryDto> {
    const user = await this.authRepository.findUserByUid(uid);
    if (!user) {
      throw new LoungeAuthError(401, 'Private Lounge user profile not found');
    }
    if (user.status !== 'ACTIVE') {
      throw new LoungeAuthError(403, 'Private Lounge account is suspended');
    }

    const subscription = await this.accountRepository.getSubscriptionByUid(uid);
    if (!subscription) {
      throw new LoungeNotFoundError('Lounge subscription record not found');
    }

    const galleryPage = await this.galleryRepository.listGalleryByUid(uid, 100);
    return {
      user: toPublicLoungeUser(user),
      subscription,
      ...(this.personaBranding ? { persona: this.personaBranding } : {}),
      unlockedGalleryCount: galleryPage.unlockedCount,
      totalGalleryCount: galleryPage.totalCount,
      appVersion: this.appVersion,
    };
  }

  /**
   * Updates language and/or IANA timezone preferences for an active Private Lounge user.
   *
   * @throws LoungeAuthError When user profile does not exist or is suspended.
   * @throws LoungeValidationError When language or timezone validation fails.
   */
  public async updatePreferences(
    uid: string,
    request: LoungeUpdatePreferencesRequestDto,
  ): Promise<LoungeUser> {
    const sanitized = parseAndValidatePreferencesRequest(request);
    const user = await this.authRepository.findUserByUid(uid);
    if (!user) {
      throw new LoungeAuthError(401, 'Private Lounge user profile not found');
    }
    if (user.status !== 'ACTIVE') {
      throw new LoungeAuthError(403, 'Private Lounge account is suspended');
    }

    const updated = await this.authRepository.updateUserPreferences(
      uid,
      sanitized.language,
      sanitized.timezone,
    );
    return toPublicLoungeUser(updated);
  }

  /**
   * Permanently deletes the caller's Private Lounge account, singleton conversation session,
   * raw messages, Dreaming/RAG memories, Gallery records, and quota/subscription state.
   * Does not delete or refund upstream payment history or mutate Public X records.
   *
   * @throws LoungeValidationError When confirmation flags are incomplete.
   * @throws LoungeAuthError When user profile does not exist (`401`).
   */
  public async deleteAccount(uid: string, request: LoungeDeleteAccountRequestDto): Promise<void> {
    parseAndValidateDeleteAccountRequest(request);
    const user = await this.authRepository.findUserByUid(uid);
    if (!user) {
      throw new LoungeAuthError(401, 'Private Lounge user profile not found');
    }

    await Promise.all([
      this.sessionRepository.deleteAllUserSessionData(uid),
      this.galleryRepository.deleteAllUserGalleryItems(uid),
      this.accountRepository.deleteSubscription(uid),
      this.authRepository.revokeSession(uid),
    ]);
    await this.authRepository.deleteUser(uid);
  }
}
