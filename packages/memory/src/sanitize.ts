/**
 * Options customizing untrusted prompt text sanitization.
 */
export interface SanitizePromptTextOptions {
  /** Replaces 3+ consecutive ASCII hyphens (`---`) with an em-dash (`—`) to prevent rule/delimiter spoofing. */
  readonly collapseHorizontalRules?: boolean;
}

/**
 * Sanitizes untrusted text embedded inside LLM system prompts or transcripts by collapsing
 * control/newline characters (`\p{Cc}`), neutralizing ASCII and Japanese bracket section
 * delimiters (`[...]`, `【...】`), collapsing consecutive whitespace, and capping length.
 *
 * @param raw - Untrusted text input from external users, logs, UI contexts, or LLM outputs.
 * @param maxLength - Maximum number of characters to retain after normalization.
 * @param options - Optional delimiter normalization settings.
 * @returns Sanitized, length-bounded single-line string (empty string if `maxLength <= 0` or non-finite).
 */
export const sanitizeUntrustedPromptText = (
  raw: string,
  maxLength: number,
  options?: SanitizePromptTextOptions,
): string => {
  const boundedMax = Number.isFinite(maxLength) ? Math.max(0, Math.trunc(maxLength)) : 0;
  if (boundedMax === 0) {
    return '';
  }

  let normalized = raw
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/【/g, '《')
    .replace(/】/g, '》');

  if (options?.collapseHorizontalRules) {
    normalized = normalized.replace(/-{3,}/g, '—');
  }

  return normalized.replace(/\s{2,}/g, ' ').trim().slice(0, boundedMax);
};
