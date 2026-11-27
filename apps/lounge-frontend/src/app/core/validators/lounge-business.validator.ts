import type {
  LoungeDeleteAccountRequestDto,
  LoungeUserDisclaimerConsent,
} from '@rebecca/types';

/**
 * ASCT Art. 12-6 checkboxes collected inside the pre-checkout confirmation modal.
 */
export interface PreCheckoutConsentSubmission {
  readonly acceptedPurchaseDisclosure: boolean;
  readonly acceptedAutoRenewalOptIn: boolean;
  readonly confirmedAdultOrParentalConsent: boolean;
  readonly euDigitalWaiverAccepted?: boolean;
}

/**
 * Validates all mandatory disclaimer checkboxes prior to submitting X-linked sign-up.
 *
 * @throws Error When mandatory disclaimer terms or Phase 1 non-EEA confirmation are missing.
 */
export function assertValidSignUpConsent(
  consent: LoungeUserDisclaimerConsent,
  phase2EeaEnabled: boolean,
): void {
  if (
    !consent.agreedToGeminiTrainingUsage ||
    !consent.agreedToZeroPiiProhibition ||
    !consent.agreedToOneWayMemoryIsolation
  ) {
    throw new Error('Mandatory disclaimer terms must be accepted before sign-up.');
  }
  if (!phase2EeaEnabled && consent.agreedToNonEeaEligibility !== true) {
    throw new Error('Non-EEA eligibility confirmation is required during Phase 1.');
  }
}

/**
 * Validates re-consent terms, Phase 1 residency confirmation, and exact active version matching
 * prior to calling `POST /account/consent`.
 *
 * @throws Error When clauses are unchecked or `consent.disclaimerVersion` lags `activeDisclaimerVersion`.
 */
export function assertValidReconsentSubmission(
  consent: LoungeUserDisclaimerConsent,
  activeDisclaimerVersion: number,
  phase2EeaEnabled: boolean,
): void {
  if (
    !consent.agreedToGeminiTrainingUsage ||
    !consent.agreedToZeroPiiProhibition ||
    !consent.agreedToOneWayMemoryIsolation
  ) {
    throw new Error('Mandatory disclaimer clauses must be accepted.');
  }
  if (!phase2EeaEnabled && consent.agreedToNonEeaEligibility !== true) {
    throw new Error('Non-EEA eligibility confirmation is required.');
  }
  if (consent.disclaimerVersion !== activeDisclaimerVersion) {
    throw new Error(
      `Consent version ${consent.disclaimerVersion} must match active version ${activeDisclaimerVersion}.`,
    );
  }
}

/**
 * Ensures both irreversible data-erasure and no-refund acknowledgements are confirmed before deletion.
 *
 * @throws Error When either mandatory deletion confirmation checkbox is false.
 */
export function assertValidDeleteAccountRequest(request: LoungeDeleteAccountRequestDto): void {
  if (!request.confirmedIrreversibleDeletion || !request.confirmedNoRefundForRemainingTurns) {
    throw new Error('Both irreversible deletion and no-refund confirmations are required.');
  }
}

/**
 * Validates that an outgoing chat message contains non-whitespace text and returns the trimmed string.
 *
 * @throws Error When the trimmed message content is empty.
 */
export function assertNonEmptyChatMessage(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error('Message content cannot be empty.');
  }
  return trimmed;
}

/**
 * Validates ASCT Art. 12-6 pre-checkout disclosure checkboxes before creating a Checkout Session.
 *
 * @throws Error When any mandatory disclosure checkbox is false.
 */
export function assertValidPreCheckoutConsent(consent: PreCheckoutConsentSubmission): void {
  if (
    !consent.acceptedPurchaseDisclosure ||
    !consent.acceptedAutoRenewalOptIn ||
    !consent.confirmedAdultOrParentalConsent
  ) {
    throw new Error('All required pre-checkout disclosures must be accepted.');
  }
}
