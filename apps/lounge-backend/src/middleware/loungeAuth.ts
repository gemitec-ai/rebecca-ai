import type { Request, Response, NextFunction } from 'express';
import {
  LoungeAuthError,
  LoungeHttpError,
  extractTraceHeader,
  handleLoungeControllerError,
} from '../utils/errors';

/**
 * Verified identity extracted from a Firebase/X-linked Bearer ID token.
 */
export interface LoungeVerifiedIdentity {
  readonly uid: string;
  readonly xUserId: string;
  readonly xHandle: string;
  readonly displayName: string;
  readonly avatarUrl: string;
}

/**
 * Hexagonal port for validating Private Lounge client ID tokens.
 */
export interface ILoungeAuthVerifierPort {
  verifyBearerToken(idToken: string): Promise<LoungeVerifiedIdentity>;
}

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
 * Options configuring the Private Lounge authentication middleware.
 */
export interface LoungeAuthMiddlewareOptions {
  /** Verifier port implementation (Firebase Admin Auth in production). */
  readonly verifier: ILoungeAuthVerifierPort;
  /** Local emulator-only auth bypass flag; ignored unless explicitly local dev/emulator and non-production. */
  readonly noAuth?: boolean;
  /** Current Node environment string (`production` blocks bypass unconditionally). */
  readonly nodeEnv?: string;
  /** Firebase Auth emulator host indicator required alongside `NO_AUTH` unless running in test/development. */
  readonly authEmulatorHost?: string;
}

/**
 * Creates Express middleware enforcing verified Private Lounge user identity.
 * Ensures `NO_AUTH` cannot bypass token verification in production or misconfigured staging builds.
 */
export function createLoungeAuthMiddleware(
  options: LoungeAuthMiddlewareOptions,
): (req: LoungeAuthenticatedRequest, res: Response, next: NextFunction) => Promise<void> {
  return async (
    req: LoungeAuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const traceHeader = extractTraceHeader(req);

    try {
      const isLocalEnv =
        options.nodeEnv === 'development' ||
        options.nodeEnv === 'test' ||
        Boolean(options.authEmulatorHost?.trim());
      const allowLocalBypass =
        options.noAuth === true && options.nodeEnv !== 'production' && isLocalEnv;
      const authHeader = req.headers.authorization;

      if (allowLocalBypass && !authHeader) {
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

      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new LoungeAuthError(401, 'Missing or malformed Bearer authorization header');
      }

      const token = authHeader.slice('Bearer '.length).trim();
      if (!token) {
        throw new LoungeAuthError(401, 'Empty Bearer token');
      }

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
