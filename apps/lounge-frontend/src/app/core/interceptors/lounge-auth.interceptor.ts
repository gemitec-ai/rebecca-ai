import type { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { from, switchMap } from 'rxjs';
import { environment } from '../../../environments/environment';
import { LoungeAuthService } from '../services/lounge-auth.service';
import { isSameTrustedOrigin } from '../utils/trusted-origin.util';

function resolveApiBaseDetails(apiBaseUrl: string): {
  readonly valid: boolean;
  readonly configuredOrigin: string | null;
  readonly pathPrefix: string;
} {
  const trimmed = apiBaseUrl.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.origin === 'null') {
        return { valid: false, configuredOrigin: null, pathPrefix: '' };
      }
      const stripped = parsed.pathname.replace(/\/+$/, '');
      const normalizedPath = stripped.length > 0 ? stripped : '/api/v1/lounge';
      return { valid: true, configuredOrigin: parsed.origin, pathPrefix: normalizedPath };
    } catch {
      return { valid: false, configuredOrigin: null, pathPrefix: '' };
    }
  }
  const prefixed = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const stripped = prefixed.replace(/\/+$/, '');
  return {
    valid: true,
    configuredOrigin: null,
    pathPrefix: stripped.length > 0 ? stripped : '/api/v1/lounge',
  };
}

/**
 * Verifies that an outgoing HTTP URL targets strictly the Private Lounge BFF path namespace
 * (`/api/v1/lounge` or `/api/v1/lounge/*`) on either the active verified window origin (for
 * same-origin proxying) or the configured absolute BFF origin, failing closed when no verified
 * non-opaque origin exists or when an absolute `apiBaseUrl` is malformed/opaque.
 */
export function isTrustedLoungeApiDestination(
  url: string,
  options?: { readonly windowOrigin?: string; readonly apiBaseUrl?: string },
): boolean {
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith('//')) {
    return false;
  }

  const baseDetails = resolveApiBaseDetails(options?.apiBaseUrl ?? environment.apiBaseUrl);
  if (!baseDetails.valid) {
    return false;
  }
  const { configuredOrigin, pathPrefix } = baseDetails;

  const windowOriginRaw =
    options?.windowOrigin ?? (typeof window !== 'undefined' ? window.location?.origin : undefined);
  const verifiedWindowOrigin =
    typeof windowOriginRaw === 'string' &&
    windowOriginRaw.trim().length > 0 &&
    windowOriginRaw !== 'null'
      ? windowOriginRaw
      : null;

  const isAbsoluteUrl = trimmed.startsWith('http://') || trimmed.startsWith('https://');
  const parseBase = verifiedWindowOrigin ?? configuredOrigin;
  if (!isAbsoluteUrl && !parseBase) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = parseBase ? new URL(trimmed, parseBase) : new URL(trimmed);
  } catch {
    return false;
  }

  if (parsed.origin === 'null' || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    return false;
  }

  const matchesPath =
    parsed.pathname === pathPrefix || parsed.pathname.startsWith(`${pathPrefix}/`);
  if (!matchesPath) {
    return false;
  }

  if (configuredOrigin && isSameTrustedOrigin(parsed.href, configuredOrigin)) {
    return true;
  }

  if (!configuredOrigin && verifiedWindowOrigin && isSameTrustedOrigin(parsed.href, verifiedWindowOrigin)) {
    return true;
  }

  return false;
}

/**
 * Attaches the user's Firebase ID Bearer token to trusted Private Lounge BFF requests.
 */
export const loungeAuthInterceptor: HttpInterceptorFn = (req, next) => {
  if (!isTrustedLoungeApiDestination(req.url)) {
    return next(req);
  }

  const authService = inject(LoungeAuthService);
  if (!authService.currentUserSignal()) {
    return next(req);
  }

  return from(authService.getToken()).pipe(
    switchMap((asyncToken) => {
      if (!asyncToken) {
        return next(req);
      }
      return next(
        req.clone({
          setHeaders: {
            Authorization: `Bearer ${asyncToken}`,
          },
        }),
      );
    }),
  );
};
