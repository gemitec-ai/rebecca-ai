import { vectorizeText } from '@rebecca/memory';
import type { SituationalAnchorsOptions } from './types';

/**
 * Resolves dynamic few-shot persona anchors from a persona's exemplar vector dataset
 * by vectorizing synthesized multi-dimensional situational context.
 *
 * Gracefully degrades to an empty string when context elements are blank or embedding fails.
 *
 * @param options - Embedder, context elements, pattern vectors, matcher callbacks, and target language.
 * @returns Formatted Few-Shot prompt block, or `''` if unavailable.
 */
export const resolveSituationalPersonaAnchors = async (
  options: SituationalAnchorsOptions,
): Promise<string> => {
  const {
    embedder,
    contextElements,
    patternVectors,
    findTopPatterns,
    buildFewShotPrompt,
    lang = 'ja',
    topK = 3,
    logger,
  } = options;

  const query = contextElements
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join('\n');

  if (!query) {
    return '';
  }

  try {
    const queryVector = await vectorizeText(embedder, query);
    if (queryVector.length === 0) {
      return '';
    }
    const topPatterns = findTopPatterns(queryVector, patternVectors, topK);
    return buildFewShotPrompt(topPatterns, lang);
  } catch (err) {
    logger?.warn?.('Failed to resolve dynamic situational persona anchors', { err });
    return '';
  }
};
