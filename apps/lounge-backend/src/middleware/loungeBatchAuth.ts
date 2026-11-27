import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { extractTraceHeader } from '../utils/errors';
import { loungeLogger, toSingleLineLog } from '../utils/logger';

/**
 * Options configuring Google Cloud OIDC / Cloud Scheduler verification for `/api/v1/lounge/batch/*`.
 */
export interface LoungeBatchAuthOptions {
  readonly nodeEnv?: string;
  readonly isCloudRun?: boolean;
  readonly batchSecretKey?: string;
  readonly expectedAudience?: string;
  /** Comma-separated allowlist of verified Google Cloud Scheduler service account emails. */
  readonly expectedServiceAccountEmail?: string;
  readonly oidcClient?: Pick<OAuth2Client, 'verifyIdToken'>;
}

/**
 * Middleware authenticating internal Cloud Scheduler jobs (Nightly Dreaming) via Google Cloud OIDC tokens.
 * In `production` or Cloud Run, enforces non-empty `expectedAudience`, `expectedServiceAccountEmail`
 * allowlist matching, `email_verified === true`, and trusted Google issuer claims.
 * Permits local `x-batch-secret` fallback strictly outside `production` and Cloud Run using timing-safe comparison.
 */
export function createLoungeBatchAuthMiddleware(
  options: LoungeBatchAuthOptions,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const isProdOrCloudRun = options.nodeEnv === 'production' || Boolean(options.isCloudRun);
  const oidcClient = options.oidcClient ?? new OAuth2Client();
  const expectedAudience = options.expectedAudience?.trim();
  const allowedServiceAccountEmails = (options.expectedServiceAccountEmail ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const traceHeader = extractTraceHeader(req);
    const localSecret = options.batchSecretKey?.trim();
    const headerSecret = req.headers['x-batch-secret'];
    const safePath = toSingleLineLog(req.path);

    if (!isProdOrCloudRun && localSecret && typeof headerSecret === 'string') {
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
        path: safePath,
      }, traceHeader);
      res.status(401).json({ error: 'Unauthorized batch invocation' });
      return;
    }

    if (!expectedAudience || allowedServiceAccountEmails.length === 0) {
      loungeLogger.warn(
        'Rejected batch request because OIDC audience or service account allowlist is unconfigured',
        { path: safePath, isProdOrCloudRun },
        traceHeader,
      );
      res.status(401).json({ error: 'Batch OIDC verification is not configured' });
      return;
    }

    const authHeader = req.headers.authorization;
    if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
      loungeLogger.warn('Rejected batch request without Bearer OIDC token', {
        path: safePath,
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
      const ticket = await oidcClient.verifyIdToken({
        idToken: token,
        audience: expectedAudience,
      });
      const payload = ticket.getPayload();
      const validIssuer =
        payload?.iss === 'https://accounts.google.com' || payload?.iss === 'accounts.google.com';
      const tokenEmail = payload?.email?.toLowerCase().trim();
      if (!validIssuer || payload?.email_verified !== true || !tokenEmail) {
        loungeLogger.warn('Rejected batch OIDC token due to invalid issuer or unverified email', {
          path: safePath,
          hasEmail: Boolean(tokenEmail),
          emailVerified: payload?.email_verified === true,
        }, traceHeader);
        res.status(401).json({ error: 'Invalid OIDC token claims' });
        return;
      }
      if (!allowedServiceAccountEmails.includes(tokenEmail)) {
        loungeLogger.warn('Rejected batch OIDC token due to unauthorized service account email', {
          path: safePath,
          receivedEmail: toSingleLineLog(tokenEmail),
        }, traceHeader);
        res.status(403).json({ error: 'Forbidden service account principal' });
        return;
      }
      next();
    } catch (err) {
      const safeReason = toSingleLineLog(err instanceof Error ? err.message : String(err));
      loungeLogger.warn('Rejected batch request after OIDC verification failure', {
        path: safePath,
        reason: safeReason,
      }, traceHeader);
      res.status(401).json({ error: 'Invalid OIDC token' });
    }
  };
}
