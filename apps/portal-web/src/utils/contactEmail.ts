/**
 * Formats and obfuscates a project support email address (`@` -> `[at mark]`)
 * for static build-time and progressive HTML rendering in `/legal`.
 */
export function formatObfuscatedSupportEmail(rawEmail?: string | null): string {
  const normalized =
    typeof rawEmail === 'string' && rawEmail.trim().length > 0
      ? rawEmail.trim()
      : 'contact@example.com';
  return normalized.replace(/@/g, ' [at mark] ');
}
