import { vectorizeText } from '@rebecca/memory';
import { buildPersonaFewShotPrompt, findTopPersonaPatterns } from '@rebecca/persona';
import type { SituationalAnchorsOptions } from './types';

/**
 * Resolves dynamic few-shot persona anchors from a persona's exemplar vector dataset
 * by vectorizing synthesized multi-dimensional situational context.
 *
 * Gracefully degrades to an empty string when context elements are blank or embedding fails.
 *
 * @param options - Embedder, context elements, pattern dataset (or persona), matcher callbacks, and target language.
 * @returns Formatted Few-Shot prompt block, or `''` if unavailable.
 * @throws Error if neither `patternVectors` nor `persona.patternVectors` is provided.
 */
export const resolveSituationalPersonaAnchors = async (
  options: SituationalAnchorsOptions,
): Promise<string> => {
  const {
    embedder,
    contextElements,
    persona,
    patternVectors,
    findTopPatterns,
    buildFewShotPrompt,
    lang = 'ja',
    topK = 3,
    logger,
  } = options;

  const resolvedVectors = patternVectors ?? persona?.patternVectors;
  if (!resolvedVectors) {
    throw new Error('resolveSituationalPersonaAnchors requires either patternVectors or persona');
  }

  const resolvePatterns =
    findTopPatterns ??
    (persona && !patternVectors
      ? (qv: number[], _pv: typeof resolvedVectors, k: number) => persona.findTopPatterns(qv, k)
      : findTopPersonaPatterns);
  const formatFewShot =
    buildFewShotPrompt ??
    (persona ? (patterns, l) => persona.buildFewShotPrompt(patterns, l) : buildPersonaFewShotPrompt);

  const query = contextElements
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join('\n');

  const normalizedTopK = Number.isFinite(topK) ? Math.trunc(topK) : 0;
  if (normalizedTopK <= 0 || !query || resolvedVectors.length === 0) {
    return '';
  }

  try {
    const queryVector = await vectorizeText(embedder, query);
    if (queryVector.length === 0) {
      return '';
    }
    const topPatterns = resolvePatterns(queryVector, resolvedVectors, normalizedTopK);
    return formatFewShot(topPatterns, lang);
  } catch (err) {
    logger?.warn?.('Failed to resolve dynamic situational persona anchors', { err });
    return '';
  }
};
