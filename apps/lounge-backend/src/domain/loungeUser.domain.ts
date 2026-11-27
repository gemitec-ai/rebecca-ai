import type { LoungeUser, LoungeUserDisclaimerConsent, LoungeUserDoc } from '@rebecca/types';
import { LoungeValidationError } from '../utils/errors';
import { isStrictIsoTimestamp } from '../utils/locale';

/**
 * Strips server-only Dreaming memory fields (`coreProfile`, `episodicBuffer`, `lastDreamedAt`)
 * before returning an authenticated user profile across BFF HTTP responses.
 */
export function toPublicLoungeUser(doc: LoungeUserDoc): LoungeUser {
  return {
    uid: doc.uid,
    xUserId: doc.xUserId,
    xHandle: doc.xHandle,
    displayName: doc.displayName,
    avatarUrl: doc.avatarUrl,
    status: doc.status,
    language: doc.language,
    timezone: doc.timezone,
    onboardingCompleted: doc.onboardingCompleted,
    allowServiceImprovementAnalytics: doc.allowServiceImprovementAnalytics,
    ...(doc.countryCode !== undefined ? { countryCode: doc.countryCode } : {}),
    ...(doc.isEeaResident !== undefined ? { isEeaResident: doc.isEeaResident } : {}),
    ...(doc.preferredCurrency !== undefined ? { preferredCurrency: doc.preferredCurrency } : {}),
    disclaimerConsent: doc.disclaimerConsent,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    lastLoginAt: doc.lastLoginAt,
  };
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
  options: { readonly requireNonEeaEligibility?: boolean } = {},
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

  const rawNonEea = candidate['agreedToNonEeaEligibility'];
  if (rawNonEea !== undefined && typeof rawNonEea !== 'boolean') {
    throw new LoungeValidationError('Field "agreedToNonEeaEligibility" must be a boolean');
  }
  if (options.requireNonEeaEligibility && rawNonEea !== true) {
    throw new LoungeValidationError(
      'Non-EEA/UK/Switzerland regional eligibility confirmation is required during Phase 1',
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
    ...(typeof rawNonEea === 'boolean' ? { agreedToNonEeaEligibility: rawNonEea } : {}),
    scrolledToBottomAt: candidate['scrolledToBottomAt'],
    consentedAt: candidate['consentedAt'],
  };
}
