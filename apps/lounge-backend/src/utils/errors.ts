import type { Request, Response } from 'express';
import { loungeLogger, sanitizeLogInput } from './logger';

/**
 * Extracts and sanitizes Google Cloud Trace context header if present on the incoming HTTP request.
 */
export function extractTraceHeader(req: Request): string | undefined {
  const value = req.headers['x-cloud-trace-context'];
  return typeof value === 'string' ? sanitizeLogInput(value) : undefined;
}

/**
 * Parses and validates optional `startAfterId` cursor query parameter.
 * Rejects arrays or non-string parameter values with HTTP 400.
 */
export function parseStartAfterId(rawCursor: unknown): string | undefined {
  if (rawCursor === undefined) {
    return undefined;
  }
  if (typeof rawCursor !== 'string') {
    throw new LoungeValidationError('Query parameter "startAfterId" must be a single string');
  }
  const trimmed = rawCursor.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Base typed HTTP error for Private Lounge BFF boundary failures.
 */
export class LoungeHttpError extends Error {
  public readonly statusCode: number;

  constructor(statusCode: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.statusCode = statusCode;
  }
}

/**
 * Raised when request parameters or sign-up disclaimer consent fail validation (HTTP 400).
 */
export class LoungeValidationError extends LoungeHttpError {
  constructor(message: string, options?: ErrorOptions) {
    super(400, message, options);
  }
}

/**
 * Raised when Firebase/X authentication fails or the account is suspended (HTTP 401/403).
 */
export class LoungeAuthError extends LoungeHttpError {
  public override readonly statusCode: 401 | 403;

  constructor(statusCode: 401 | 403, message: string, options?: ErrorOptions) {
    super(statusCode, message, options);
    this.statusCode = statusCode;
  }
}

/**
 * Raised when an X account already owns a registered Private Lounge account (HTTP 409).
 */
export class LoungeConflictError extends LoungeHttpError {
  constructor(message: string, options?: ErrorOptions) {
    super(409, message, options);
  }
}

/**
 * Raised when a requested Lounge resource does not exist or is not owned by the caller (HTTP 404).
 */
export class LoungeNotFoundError extends LoungeHttpError {
  constructor(message: string, options?: ErrorOptions) {
    super(404, message, options);
  }
}

/**
 * Raised when a Lounge user has exhausted daily interactive chat turns (HTTP 429).
 */
export class LoungeQuotaExhaustedError extends LoungeHttpError {
  constructor(message: string, options?: ErrorOptions) {
    super(429, message, options);
  }
}

/**
 * Raised by architecture skeleton stub methods awaiting concrete Firestore/AI wiring (HTTP 501).
 */
export class LoungeNotImplementedError extends LoungeHttpError {
  constructor(methodName: string, options?: ErrorOptions) {
    super(501, `${methodName} is an architecture skeleton stub awaiting implementation`, options);
  }
}

/**
 * Clamps pagination limits into the strict BFF `[1, 100]` boundary (default 20).
 *
 * @throws LoungeValidationError When a finite positive integer limit is violated outside bounds.
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
 * Maps domain errors to safe HTTP responses and Cloud Logging severity levels.
 * Client errors (4xx) emit WARNING; unhandled 5xx exceptions emit ERROR.
 */
export function handleLoungeControllerError(
  res: Response,
  err: unknown,
  operation: string,
  traceHeader?: string,
): void {
  if (err instanceof LoungeHttpError && err.statusCode < 500) {
    loungeLogger.warn(
      `Client or business rejection in ${sanitizeLogInput(operation)}`,
      { statusCode: err.statusCode, reason: sanitizeLogInput(err.message) },
      traceHeader,
    );
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  if (err instanceof LoungeNotImplementedError) {
    loungeLogger.warn(
      `Skeleton stub invoked for ${sanitizeLogInput(operation)}`,
      { statusCode: err.statusCode, reason: sanitizeLogInput(err.message) },
      traceHeader,
    );
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  if (err instanceof LoungeHttpError) {
    loungeLogger.error(
      `HTTP error invariant breach in ${sanitizeLogInput(operation)}`,
      err,
      { statusCode: err.statusCode, operation: sanitizeLogInput(operation) },
      traceHeader,
    );
    res.status(err.statusCode).json({ error: 'Internal server error' });
    return;
  }

  const normalizedError =
    err instanceof Error
      ? err
      : new Error(`Unexpected failure during ${operation}`, { cause: err });
  loungeLogger.error(
    `Unhandled failure in ${sanitizeLogInput(operation)}`,
    normalizedError,
    { operation: sanitizeLogInput(operation) },
    traceHeader,
  );
  res.status(500).json({ error: 'Internal server error' });
}
