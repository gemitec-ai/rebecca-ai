import type { Request, Response, NextFunction } from 'express';
import type {
  ILoungeAuthVerifierPort,
  LoungeVerifiedIdentity,
} from '../features/auth/ports/loungeAuthVerifier.port';
import {
  LoungeAuthError,
  LoungeHttpError,
  extractTraceHeader,
  handleLoungeControllerError,
} from '../utils/errors';

/**
 * Express request augmented with the authenticated Private Lounge user identity.
 */
export interface LoungeAuthenticatedRequest extends Request {
  loungeIdentity?: LoungeVerifiedIdentity;
}

/**
 * Extracts and verifies the authenticated Private Lounge identity from an incoming request.
 *
 * @throws LoungeAuthError When `loungeIdentity` is missing from the request context.
 */
export function requireLoungeIdentity(req: LoungeAuthenticatedRequest): LoungeVerifiedIdentity {
  if (!req.loungeIdentity) {
    throw new LoungeAuthError(401, 'Authenticated user identity is required');
  }
  return req.loungeIdentity;
}

/**
 * Parses and validates an incoming `Authorization: Bearer <token>` header value.
 *
 * @throws LoungeAuthError When the header is absent, malformed, or contains an empty token.
 */
export function extractBearerTokenFromHeader(authHeader: unknown): string {
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    throw new LoungeAuthError(401, 'Missing or malformed Bearer authorization header');
  }
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    throw new LoungeAuthError(401, 'Empty Bearer token');
  }
  return token;
}

/**
 * Options configuring the Private Lounge authentication middleware.
 */
export interface LoungeAuthMiddlewareOptions {
  /** Verifier port implementation (Firebase Identity client in production). */
  readonly verifier: ILoungeAuthVerifierPort;
  /** Local emulator-only auth bypass flag; ignored unless running outside Cloud Run and production. */
  readonly noAuth?: boolean;
  /** Current Node environment string (`production` blocks bypass unconditionally). */
  readonly nodeEnv?: string;
  /** Cloud Run indicator injected from validated startup configuration (`true` blocks bypass unconditionally). */
  readonly isCloudRun?: boolean;
  /** Firebase Auth emulator host indicator required alongside `NO_AUTH` unless running in `test`. */
  readonly authEmulatorHost?: string;
}

/**
 * Creates Express middleware enforcing verified Private Lounge user identity.
 * Ensures `NO_AUTH` cannot bypass token verification in production, Cloud Run, or staging builds.
 */
export function createLoungeAuthMiddleware(
  options: LoungeAuthMiddlewareOptions,
): (req: LoungeAuthenticatedRequest, res: Response, next: NextFunction) => Promise<void> {
  const hasEmulatorOrTestEnv =
    Boolean(options.authEmulatorHost?.trim()) || options.nodeEnv === 'test';
  const allowLocalBypass =
    options.noAuth === true &&
    options.nodeEnv !== 'production' &&
    !options.isCloudRun &&
    hasEmulatorOrTestEnv;

  return async (
    req: LoungeAuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const traceHeader = extractTraceHeader(req);

    try {
      if (allowLocalBypass) {
        req.loungeIdentity = {
          uid: 'lounge_dev_user',
          xUserId: '1000000001',
          xHandle: '@lounge_dev',
          displayName: 'Local Lounge User',
          avatarUrl: 'assets/gemitec_icon.svg',
        };
        next();
        return;
      }

      const token = extractBearerTokenFromHeader(req.headers.authorization);
      req.loungeIdentity = await options.verifier.verifyBearerToken(token);
      next();
    } catch (err) {
      const propagated =
        err instanceof LoungeHttpError
          ? err
          : new LoungeAuthError(401, 'Invalid or expired authentication token', { cause: err });
      handleLoungeControllerError(res, propagated, 'loungeAuthMiddleware', traceHeader);
    }
  };
}
