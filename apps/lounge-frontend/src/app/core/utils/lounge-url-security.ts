/**
 * Allowlisted Stripe hosted web origins permitted for client-side Checkout, Customer Portal,
 * and hosted receipt navigation.
 */
const ALLOWED_STRIPE_ORIGINS = [
  'https://checkout.stripe.com',
  'https://billing.stripe.com',
  'https://pay.stripe.com',
  'https://invoice.stripe.com',
  'https://receipt.stripe.com',
] as const;

interface OriginConstructorLike {
  from(value: string): {
    readonly opaque?: boolean;
    isSameOrigin(other: unknown): boolean;
  };
}

function readNativeOriginApi(): OriginConstructorLike | null {
  if (typeof globalThis !== 'object' || globalThis === null || !('Origin' in globalThis)) {
    return null;
  }
  const candidate = (globalThis as { Origin?: unknown }).Origin;
  if (typeof candidate === 'function' && 'from' in candidate) {
    return candidate as unknown as OriginConstructorLike;
  }
  return null;
}

function isSameOriginUrl(candidateUrl: string, trustedOriginUrl: string): boolean {
  try {
    const originApi = readNativeOriginApi();
    if (originApi) {
      const candidateOrigin = originApi.from(candidateUrl);
      if (candidateOrigin.opaque) {
        return false;
      }
      return candidateOrigin.isSameOrigin(originApi.from(trustedOriginUrl));
    }
    const parsedCandidate = new URL(candidateUrl);
    const parsedTrusted = new URL(trustedOriginUrl);
    return (
      parsedCandidate.origin !== 'null' &&
      parsedTrusted.origin !== 'null' &&
      parsedCandidate.origin === parsedTrusted.origin
    );
  } catch {
    return false;
  }
}

/**
 * Validates that an external billing/checkout/portal/receipt URL points strictly to an
 * allowlisted HTTPS Stripe origin (or, outside production, the local emulator SPA origin).
 * Uses `Origin` (`Origin.from()` / `isSameOrigin()`) with a `new URL()` fallback to reject
 * opaque `"null"` origins (`data:`, `javascript:`) and prefix-spoofed hostnames.
 */
export function isAllowedStripeRedirectUrl(
  candidate: string,
  allowLocalOrigin = false,
): boolean {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }

  if (parsed.origin === 'null') {
    return false;
  }

  if (parsed.protocol === 'https:') {
    return ALLOWED_STRIPE_ORIGINS.some((trusted) => isSameOriginUrl(trimmed, trusted));
  }

  if (allowLocalOrigin && parsed.protocol === 'http:') {
    if (
      typeof window !== 'undefined' &&
      window.location?.origin &&
      isSameOriginUrl(trimmed, window.location.origin)
    ) {
      return true;
    }
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  }

  return false;
}
