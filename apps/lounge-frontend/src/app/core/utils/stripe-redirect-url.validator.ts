import { isSameTrustedOrigin } from './trusted-origin.utils';

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
    return ALLOWED_STRIPE_ORIGINS.some((trusted) => isSameTrustedOrigin(trimmed, trusted));
  }

  if (allowLocalOrigin && parsed.protocol === 'http:') {
    if (
      typeof window !== 'undefined' &&
      window.location?.origin &&
      isSameTrustedOrigin(trimmed, window.location.origin)
    ) {
      return true;
    }
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  }

  return false;
}
