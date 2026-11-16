import {
  formatAbsenceSection,
  formatActivitySummarySection,
  formatBirthdaySection,
  formatCoreProfileSection,
  formatCurrentTimeSection,
  formatExtendedTrendSection,
  formatInterlocutorSection,
  formatRagMemoriesSection,
  formatReadOnlyOverlaySection,
  formatTimeBracketSection,
} from './sections';
import { DEFAULT_APP_TIMEZONE, formatZonedDateTime, getZonedDateParts } from './time';
import type { PromptCompositionOptions, PromptSection } from './types';

/**
 * Joins an ordered sequence of prompt sections and plain text blocks, filtering out
 * `null`, `undefined`, and blank entries while preserving caller-specified section ordering
 * (supporting cache-prefix stability strategies in interactive channels).
 *
 * @param items - Ordered array of structured sections or raw text blocks.
 * @returns Combined system instruction string separated by blank lines.
 */
export const assemblePromptSections = (
  items: ReadonlyArray<PromptSection | string | null | undefined>,
): string => {
  const rendered: string[] = [];

  for (const item of items) {
    if (!item) {
      continue;
    }

    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed) {
        rendered.push(trimmed);
      }
      continue;
    }

    const trimmedBody = item.body.trim();
    if (!trimmedBody) {
      continue;
    }

    const trimmedHeader = item.header?.trim();
    rendered.push(trimmedHeader ? `${trimmedHeader}\n${trimmedBody}` : trimmedBody);
  }

  return rendered.join('\n\n');
};

/**
 * Builds a complete multi-tier persona system prompt by combining `@rebecca/persona` Layer 0
 * identity with host-supplied channel rules, localized time/anniversary awareness,
 * retrieved RAG episodes, Layer 1–3 memories, optional read-only overlays, and custom sections.
 *
 * @param options - Structured prompt composition options and memory slices.
 * @returns Fully assembled system instruction string.
 */
export const composeSystemPrompt = (options: PromptCompositionOptions): string => {
  const {
    persona,
    channelInstruction = '',
    userData,
    extendedPrompt = '',
    activitySummary = '',
    ragMemories = [],
    lang = 'ja',
    personaFewShotPrompt = '',
    accountHandleLabel,
    activitySummaryHeader,
    activitySummaryLead,
    additionalSections = [],
    readOnlyMemoryOverlay = null,
    platformGuidelines = '',
    timezone = DEFAULT_APP_TIMEZONE,
    now = new Date(),
    timeResolver,
  } = options;

  const resolveParts = timeResolver ? timeResolver.getZonedDateParts : getZonedDateParts;
  const resolveFormatted = timeResolver ? timeResolver.formatZonedDateTime : formatZonedDateTime;

  const parts = resolveParts(now, timezone);
  const formattedCurrentTime = resolveFormatted(now, timezone);
  const callsign =
    lang === 'en' ? persona.metadata.userCallsign.en : persona.metadata.userCallsign.ja;

  const coreAndChannel = persona.composePrompt(channelInstruction, lang);

  return assemblePromptSections([
    coreAndChannel,
    formatCurrentTimeSection(formattedCurrentTime, lang),
    formatBirthdaySection(persona, parts, lang),
    personaFewShotPrompt,
    userData
      ? formatInterlocutorSection(callsign, userData, lang, accountHandleLabel)
      : null,
    userData ? formatCoreProfileSection(callsign, userData.coreProfile, lang) : null,
    formatReadOnlyOverlaySection(
      readOnlyMemoryOverlay,
      callsign,
      lang,
      timezone,
      resolveFormatted,
    ),
    formatRagMemoriesSection(ragMemories, lang),
    formatTimeBracketSection(parts.numericHour, lang),
    formatAbsenceSection(persona, userData?.lastReplyDate, now, lang),
    formatExtendedTrendSection(extendedPrompt, lang),
    formatActivitySummarySection(activitySummary, lang, {
      header: activitySummaryHeader,
      lead: activitySummaryLead,
    }),
    ...additionalSections,
    platformGuidelines,
  ]);
};
