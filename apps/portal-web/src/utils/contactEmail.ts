/**
 * Formats and obfuscates a configured support email address (`@` -> `[at mark]`)
 * for static build-time and progressive HTML rendering in `/legal`.
 * Returns `''` when unset/blank rather than synthesizing a fake address.
 *
 * @throws Error When `rejectPlaceholderDomains` is true and a synthetic `@example.*` address is supplied.
 */
export function formatObfuscatedSupportEmail(
  rawEmail?: string | null,
  options: { readonly rejectPlaceholderDomains?: boolean } = {},
): string {
  const normalized = typeof rawEmail === 'string' ? rawEmail.trim() : '';
  if (!normalized) {
    return '';
  }
  if (options.rejectPlaceholderDomains && /@example\.(com|org|net)$/i.test(normalized)) {
    throw new Error(
      `Refusing synthetic placeholder SUPPORT_CONTACT_EMAIL ("${normalized}") in production build`,
    );
  }
  return normalized.replace(/@/g, ' [at mark] ');
}
