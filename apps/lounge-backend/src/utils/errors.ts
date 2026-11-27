import {
  LOUNGE_ERROR_CODE_DISCLAIMER_RECONSENT_REQUIRED,
  type LoungePaginationQueryDto,
} from '@rebecca/types';
import type { Request, Response } from 'express';
import { loungeLogger, toSingleLineLog } from './logger';

/**
 * Extracts single-line Google Cloud Trace context header if present on the incoming HTTP request.
 */
export function extractTraceHeader(req: Request): string | undefined {
  const value = req.headers['x-cloud-trace-context'];
  return typeof value === 'string' ? toSingleLineLog(value) : undefined;
}

/**
 * Parses and validates optional opaque `cursor` pagination query parameter.
 * Rejects arrays or non-string parameter values with HTTP 400.
 */
export function parsePaginationCursor(rawCursor: unknown): string | undefined {
  if (rawCursor === undefined || rawCursor === null) {
    return undefined;
  }
  if (typeof rawCursor !== 'string') {
    throw new LoungeValidationError('Query parameter "cursor" must be a single string');
  }
  const trimmed = rawCursor.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Optional metadata attached to structured Private Lounge BFF HTTP errors.
 */
export interface LoungeHttpErrorOptions extends ErrorOptions {
  readonly code?: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

/**
 * Base typed HTTP error for Private Lounge BFF boundary failures.
 */
export class LoungeHttpError extends Error {
  public readonly statusCode: number;
  public readonly code?: string;
  public readonly meta?: Readonly<Record<string, unknown>>;

  constructor(statusCode: number, message: string, options?: LoungeHttpErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = options?.code;
    this.meta = options?.meta;
  }
}

/**
 * Raised when request parameters or sign-up disclaimer consent fail validation (HTTP 400).
 */
export class LoungeValidationError extends LoungeHttpError {
  constructor(message: string, options?: LoungeHttpErrorOptions) {
    super(400, message, options);
  }
}

/**
 * Raised when Firebase/X authentication fails or the account is suspended (HTTP 401/403).
 */
export class LoungeAuthError extends LoungeHttpError {
  public override readonly statusCode: 401 | 403;

  constructor(statusCode: 401 | 403, message: string, options?: LoungeHttpErrorOptions) {
    super(statusCode, message, options);
    this.statusCode = statusCode;
  }
}

/**
 * Raised when policy, regional eligibility, or feature gates forbid an operation (HTTP 403).
 */
export class LoungeForbiddenError extends LoungeHttpError {
  public override readonly statusCode = 403;

  constructor(message: string, options?: LoungeHttpErrorOptions) {
    super(403, message, options);
  }
}

/**
 * Raised when a user's accepted legal disclaimer version is older than the required BFF version (`HTTP 403`).
 */
export class LoungeDisclaimerReconsentRequiredError extends LoungeAuthError {
  public readonly requiredDisclaimerVersion: number;
  public readonly acceptedDisclaimerVersion: number;

  constructor(requiredDisclaimerVersion: number, acceptedDisclaimerVersion: number) {
    super(403, 'Updated disclaimer consent is required before continuing conversation', {
      code: LOUNGE_ERROR_CODE_DISCLAIMER_RECONSENT_REQUIRED,
      meta: { requiredDisclaimerVersion, acceptedDisclaimerVersion },
    });
    this.requiredDisclaimerVersion = requiredDisclaimerVersion;
    this.acceptedDisclaimerVersion = acceptedDisclaimerVersion;
  }
}

/**
 * Raised when an X account already owns a registered Private Lounge account (HTTP 409).
 */
export class LoungeConflictError extends LoungeHttpError {
  constructor(message: string, options?: LoungeHttpErrorOptions) {
    super(409, message, options);
  }
}

/**
 * Raised when a requested Lounge resource does not exist or is not owned by the caller (HTTP 404).
 */
export class LoungeNotFoundError extends LoungeHttpError {
  constructor(message: string, options?: LoungeHttpErrorOptions) {
    super(404, message, options);
  }
}

/**
 * Raised when a Lounge user has exhausted daily interactive chat turns (HTTP 429).
 */
export class LoungeQuotaExhaustedError extends LoungeHttpError {
  constructor(message: string, options?: LoungeHttpErrorOptions) {
    super(429, message, options);
  }
}

/**
 * Clamps pagination page numbers to finite positive integers (`>= 1`, default `1`).
 *
 * @throws LoungeValidationError When a provided `page` parameter is not a positive integer.
 */
export function normalizePaginationPage(rawPage: unknown, defaultPage = 1): number {
  if (rawPage === undefined || rawPage === null || rawPage === '') {
    return defaultPage;
  }
  if (Array.isArray(rawPage) || (typeof rawPage !== 'number' && typeof rawPage !== 'string')) {
    throw new LoungeValidationError('Query parameter "page" must be a positive integer');
  }
  const parsed = typeof rawPage === 'number' ? rawPage : Number(rawPage);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    throw new LoungeValidationError('Query parameter "page" must be a positive integer');
  }
  return parsed;
}

/**
 * Clamps pagination limits into the strict BFF `[1, 100]` boundary (default 20).
 *
 * @throws LoungeValidationError When a provided limit is not a finite positive integer (`>= 1`).
 */
export function normalizePaginationLimit(rawLimit: unknown, defaultLimit = 20): number {
  if (rawLimit === undefined || rawLimit === null || rawLimit === '') {
    return defaultLimit;
  }
  if (Array.isArray(rawLimit) || (typeof rawLimit !== 'number' && typeof rawLimit !== 'string')) {
    throw new LoungeValidationError('Query parameter "limit" must be a positive integer');
  }
  const parsed = typeof rawLimit === 'number' ? rawLimit : Number(rawLimit);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    throw new LoungeValidationError('Query parameter "limit" must be a positive integer');
  }
  return Math.min(parsed, 100);
}

/**
 * Normalizes and validates unified Private Lounge pagination parameters (`page`, `limit`, `cursor`).
 *
 * @throws LoungeValidationError When any pagination field fails boundary validation.
 */
export function normalizePaginationQuery(
  rawQuery?: { readonly page?: unknown; readonly limit?: unknown; readonly cursor?: unknown },
  defaultLimit = 20,
): Required<Pick<LoungePaginationQueryDto, 'page' | 'limit'>> &
  Pick<LoungePaginationQueryDto, 'cursor'> {
  const page = normalizePaginationPage(rawQuery?.page, 1);
  const limit = normalizePaginationLimit(rawQuery?.limit, defaultLimit);
  const cursor = parsePaginationCursor(rawQuery?.cursor);
  return {
    page,
    limit,
    ...(cursor !== undefined ? { cursor } : {}),
  };
}

/**
 * Maps domain errors to safe HTTP responses and Cloud Logging severity levels.
 * Client errors (4xx) emit WARNING; unhandled 5xx exceptions emit ERROR.
 */
export function handleLoungeControllerError(
  res: Response,
  err: unknown,
  operation: string,
  traceHeader?: string,
): void {
  // Format operation and reason unconditionally before branching to keep log safety uniform.
  const safeOperation = toSingleLineLog(operation);
  const safeReason =
    err instanceof Error ? toSingleLineLog(err.message) : toSingleLineLog(String(err));

  if (err instanceof LoungeHttpError && err.statusCode < 500) {
    loungeLogger.warn(
      `Client or business rejection in ${safeOperation}`,
      {
        statusCode: err.statusCode,
        ...(err.code ? { code: err.code } : {}),
        reason: safeReason,
      },
      traceHeader,
    );
    res.status(err.statusCode).json({
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
      ...(err.meta ?? {}),
    });
    return;
  }

  if (err instanceof LoungeHttpError) {
    loungeLogger.error(
      `HTTP error invariant breach in ${safeOperation}`,
      err,
      { statusCode: err.statusCode, operation: safeOperation },
      traceHeader,
    );
    res.status(err.statusCode).json({
      error: 'Internal server error',
      ...(err.code ? { code: err.code } : {}),
    });
    return;
  }

  const normalizedError =
    err instanceof Error
      ? err
      : new Error(`Unexpected failure during ${safeOperation}`, { cause: err });
  loungeLogger.error(
    `Unhandled failure in ${safeOperation}`,
    normalizedError,
    { operation: safeOperation },
    traceHeader,
  );
  res.status(500).json({ error: 'Internal server error' });
}
