import type {
  LoungeDeleteAccountRequestDto,
  LoungeUpdateDisclaimerConsentRequestDto,
  LoungeUpdatePreferencesRequestDto,
} from '@rebecca/types';
import { parseAndValidateSignUpConsent } from '../../../domain/loungeUser.domain';
import { LoungeValidationError } from '../../../utils/errors';
import { parseSupportedLoungeLanguage, parseValidIanaTimezone } from '../../../utils/locale';

/**
 * Validates and whitelists user preference update payloads (`language`, `timezone`,
 * `completeOnboarding`, and `allowServiceImprovementAnalytics`).
 *
 * @throws LoungeValidationError When payload is non-object, empty, or contains invalid values.
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

  if (candidate['completeOnboarding'] !== undefined) {
    if (typeof candidate['completeOnboarding'] !== 'boolean') {
      throw new LoungeValidationError('Field "completeOnboarding" must be a boolean');
    }
    result.completeOnboarding = candidate['completeOnboarding'];
  }

  if (candidate['allowServiceImprovementAnalytics'] !== undefined) {
    if (typeof candidate['allowServiceImprovementAnalytics'] !== 'boolean') {
      throw new LoungeValidationError(
        'Field "allowServiceImprovementAnalytics" must be a boolean',
      );
    }
    result.allowServiceImprovementAnalytics = candidate['allowServiceImprovementAnalytics'];
  }

  if (
    result.language === undefined &&
    result.timezone === undefined &&
    result.completeOnboarding === undefined &&
    result.allowServiceImprovementAnalytics === undefined
  ) {
    throw new LoungeValidationError(
      'At least one preference field ("language", "timezone", "completeOnboarding", or "allowServiceImprovementAnalytics") must be provided',
    );
  }

  return result;
}

/**
 * Validates and whitelists updated disclaimer re-consent payloads against `requiredVersion`.
 *
 * @throws LoungeValidationError When payload is invalid or does not match `requiredVersion`.
 */
export function parseAndValidateReconsentRequest(
  raw: unknown,
  requiredVersion?: number,
  options: { readonly requireNonEeaEligibility?: boolean } = {},
): LoungeUpdateDisclaimerConsentRequestDto {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LoungeValidationError('Re-consent payload must be a JSON object');
  }
  const candidate = raw as Record<string, unknown>;
  return {
    disclaimerConsent: parseAndValidateSignUpConsent(
      candidate['disclaimerConsent'],
      requiredVersion,
      options,
    ),
  };
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
