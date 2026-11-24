import type { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { from, switchMap } from 'rxjs';
import { environment } from '../../../environments/environment';
import { LoungeAuthService } from '../services/lounge-auth.service';

/**
 * Verifies that an outgoing HTTP URL points strictly to a same-origin relative path or the
 * configured Private Lounge BFF origin so Firebase ID Bearer tokens never leak to external hosts.
 */
export function isTrustedLoungeApiDestination(url: string): boolean {
  if (url.startsWith('/')) {
    return !url.startsWith('//');
  }
  try {
    const currentOrigin =
      typeof window !== 'undefined' && window.location?.origin
        ? window.location.origin
        : 'http://127.0.0.1:4300';
    const parsed = new URL(url, currentOrigin);
    if (parsed.origin === currentOrigin) {
      return true;
    }
    if (
      environment.apiBaseUrl.startsWith('http://') ||
      environment.apiBaseUrl.startsWith('https://')
    ) {
      const configuredOrigin = new URL(environment.apiBaseUrl).origin;
      return parsed.origin === configuredOrigin;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Attaches the user's Firebase ID Bearer token to trusted Private Lounge BFF requests.
 */
export const loungeAuthInterceptor: HttpInterceptorFn = (req, next) => {
  if (!isTrustedLoungeApiDestination(req.url)) {
    return next(req);
  }

  const authService = inject(LoungeAuthService);
  const syncToken = authService.getSyncToken();
  if (syncToken) {
    return next(
      req.clone({
        setHeaders: {
          Authorization: `Bearer ${syncToken}`,
        },
      }),
    );
  }

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
