import { resolveSituationalPersonaAnchors } from './personaAnchoring';
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
import type {
  ComposedSystemPrompt,
  PromptSection,
  SystemPromptCompositionOptions,
} from './types';

/**
 * Joins an ordered sequence of prompt sections and plain text blocks, filtering out
 * `null`, `undefined`, and blank entries while preserving caller-specified section ordering.
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
 * Builds the unified persona system prompt across all host channels and features.
 *
 * Always composes Layer 0 identity (`persona.composePrompt(channelInstruction, lang)`),
 * enforces dynamic situational anchoring against the persona's pattern dataset,
 * and optionally injects localized temporal/birthday awareness, multi-tier memory slices,
 * host-specific sections, and platform guidelines through one consistent pipeline.
 *
 * @param options - System prompt composition options requiring `anchoring`.
 * @returns Base anchored instruction, raw few-shot slice, and complete system instruction.
 */
export const composeSystemPrompt = async (
  options: SystemPromptCompositionOptions,
): Promise<ComposedSystemPrompt> => {
  const {
    persona,
    channelInstruction = '',
    lang = 'ja',
    anchoring,
    temporal,
    memory,
    additionalSections = [],
    platformGuidelines = '',
  } = options;

  const basePrompt = persona.composePrompt(channelInstruction, lang);
  const personaFewShotPrompt = await resolveSituationalPersonaAnchors({
    persona,
    embedder: anchoring.embedder,
    contextElements: anchoring.contextElements,
    patternVectors: anchoring.patternVectors,
    topK: anchoring.topK,
    logger: anchoring.logger,
    lang,
  });

  const baseSystemInstruction = assemblePromptSections([basePrompt, personaFewShotPrompt]);

  const timezone = temporal?.timezone ?? DEFAULT_APP_TIMEZONE;
  const now = temporal?.now ?? new Date();
  const resolveParts = temporal?.timeResolver?.getZonedDateParts ?? getZonedDateParts;
  const resolveFormatted = temporal?.timeResolver?.formatZonedDateTime ?? formatZonedDateTime;

  const temporalParts = temporal ? resolveParts(now, timezone) : null;
  const formattedCurrentTime = temporal ? resolveFormatted(now, timezone) : '';

  const userData = memory?.userData ?? null;
  const callsign =
    lang === 'en' ? persona.metadata.userCallsign.en : persona.metadata.userCallsign.ja;

  const currentTimeSection = temporal
    ? formatCurrentTimeSection(formattedCurrentTime, lang)
    : null;
  const birthdaySection =
    temporal && temporalParts && temporal.includeBirthday !== false
      ? formatBirthdaySection(persona, temporalParts, lang)
      : null;
  const timeBracketSection =
    temporal && temporalParts && temporal.includeTimeBracket !== false
      ? formatTimeBracketSection(temporalParts.numericHour, lang, persona.metadata.userCallsign.en)
      : null;

  const systemInstruction = assemblePromptSections([
    basePrompt,
    currentTimeSection,
    birthdaySection,
    personaFewShotPrompt,
    userData
      ? formatInterlocutorSection(callsign, userData, lang, memory?.accountHandleLabel)
      : null,
    userData ? formatCoreProfileSection(callsign, userData.coreProfile, lang) : null,
    formatReadOnlyOverlaySection(
      memory?.readOnlyMemoryOverlay,
      callsign,
      lang,
      timezone,
      resolveFormatted,
    ),
    formatRagMemoriesSection(memory?.ragMemories ?? [], lang),
    timeBracketSection,
    formatAbsenceSection(persona, userData?.lastReplyDate, now, lang),
    formatExtendedTrendSection(memory?.extendedPrompt, lang),
    formatActivitySummarySection(memory?.activitySummary, lang, {
      header: memory?.activitySummaryHeader,
      lead: memory?.activitySummaryLead,
    }),
    ...additionalSections,
    platformGuidelines,
  ]);

  return {
    baseSystemInstruction,
    personaFewShotPrompt,
    systemInstruction,
  };
};
