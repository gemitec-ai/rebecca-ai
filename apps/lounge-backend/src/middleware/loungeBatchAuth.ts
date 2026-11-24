import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { extractTraceHeader } from '../utils/errors';
import { loungeLogger, sanitizeLogInput } from '../utils/logger';

/**
 * Options configuring Google Cloud OIDC / Cloud Scheduler verification for `/api/v1/lounge/batch/*`.
 */
export interface LoungeBatchAuthOptions {
  readonly nodeEnv?: string;
  readonly batchSecretKey?: string;
  readonly expectedAudience?: string;
  readonly oidcClient?: Pick<OAuth2Client, 'verifyIdToken'>;
}

/**
 * Middleware authenticating internal Cloud Scheduler jobs (Nightly Dreaming) via Google Cloud OIDC tokens.
 * Permits local `x-batch-secret` fallback strictly outside `production` using timing-safe comparison.
 */
export function createLoungeBatchAuthMiddleware(
  options: LoungeBatchAuthOptions,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const isProd = options.nodeEnv === 'production';
  const oidcClient = options.oidcClient ?? new OAuth2Client();

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const traceHeader = extractTraceHeader(req);
    const localSecret = options.batchSecretKey?.trim();
    const headerSecret = req.headers['x-batch-secret'];

    if (!isProd && localSecret && typeof headerSecret === 'string') {
      const providedBuf = Buffer.from(headerSecret, 'utf8');
      const expectedBuf = Buffer.from(localSecret, 'utf8');
      if (
        providedBuf.length === expectedBuf.length &&
        crypto.timingSafeEqual(providedBuf, expectedBuf)
      ) {
        next();
        return;
      }
      loungeLogger.warn('Rejected batch request due to invalid local batch secret', {
        path: sanitizeLogInput(req.path),
      }, traceHeader);
      res.status(401).json({ error: 'Unauthorized batch invocation' });
      return;
    }

    const authHeader = req.headers.authorization;
    if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
      loungeLogger.warn('Rejected batch request without Bearer OIDC token', {
        path: sanitizeLogInput(req.path),
      }, traceHeader);
      res.status(401).json({ error: 'Unauthorized batch invocation' });
      return;
    }

    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) {
      res.status(401).json({ error: 'Unauthorized batch invocation' });
      return;
    }

    try {
      await oidcClient.verifyIdToken({
        idToken: token,
        ...(options.expectedAudience ? { audience: options.expectedAudience } : {}),
      });
      next();
    } catch (err) {
      loungeLogger.warn('Rejected batch request after OIDC verification failure', {
        path: sanitizeLogInput(req.path),
        reason: sanitizeLogInput(err instanceof Error ? err.message : String(err)),
      }, traceHeader);
      res.status(401).json({ error: 'Invalid OIDC token' });
    }
  };
}
