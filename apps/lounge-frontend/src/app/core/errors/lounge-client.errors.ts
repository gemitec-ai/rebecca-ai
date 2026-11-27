import type { LOUNGE_ERROR_CODE_DISCLAIMER_RECONSENT_REQUIRED } from '@rebecca/types';

/** Machine-readable BFF error code requiring disclaimer re-consent before continuing chat. */
export const DISCLAIMER_RECONSENT_REQUIRED_CODE: typeof LOUNGE_ERROR_CODE_DISCLAIMER_RECONSENT_REQUIRED =
  'DISCLAIMER_RECONSENT_REQUIRED';

/**
 * Structured client error raised when the active chat turn requires updated disclaimer re-consent.
 */
export class LoungeReconsentRequiredClientError extends Error {
  public readonly code = DISCLAIMER_RECONSENT_REQUIRED_CODE;
  public readonly requiredDisclaimerVersion: number;
  public readonly acceptedDisclaimerVersion: number;

  constructor(requiredDisclaimerVersion: number, acceptedDisclaimerVersion: number) {
    super('Updated disclaimer consent is required before continuing conversation');
    this.name = 'LoungeReconsentRequiredClientError';
    this.requiredDisclaimerVersion = requiredDisclaimerVersion;
    this.acceptedDisclaimerVersion = acceptedDisclaimerVersion;
  }
}

/**
 * Typed HTTP client error propagating BFF status codes and machine-readable error codes cleanly.
 */
export class LoungeClientApiError extends Error {
  public readonly statusCode: number;
  public readonly code?: string;

  constructor(statusCode: number, message: string, code?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LoungeClientApiError';
    this.statusCode = statusCode;
    this.code = code;
  }
}
