export * from './types';
export * from './basePersona';
export * from './structuredResponse';
export { precomputedPersonaPatternEmbeddings, PersonaPatternWithVector } from './personaPatternVectors';
export {
  rebeccaPersona,
  RebeccaPersona,
  REBECCA_METADATA,
  REBECCA_PORTAL_CONFIG,
  parsePersonaPatterns,
} from './personas/rebecca';

import { formatPersonaFewShotPrompt, rankPersonaPatternVectors } from './basePersona';
import { rebeccaPersona } from './personas/rebecca';
import { IPersonaDefinition, PersonaPattern, Language } from './types';
import { PersonaPatternWithVector } from './personaPatternVectors';

/**
 * Registry resolver for active persona.
 * Fail-fast: Throws an explicit error if an unrecognized persona ID is requested.
 * Defaults to 'rebecca' if id is undefined, null, empty, or whitespace-only.
 *
 * @param id - Optional persona identifier to resolve.
 * @returns The matching `IPersonaDefinition` implementation.
 * @throws Error if a non-empty unrecognized persona ID is requested.
 */
export function getActivePersona(id?: string): IPersonaDefinition {
  const normalizedId = (id?.trim() || 'rebecca').toLowerCase();
  if (normalizedId === 'rebecca') {
    return rebeccaPersona;
  }
  throw new Error(`Unknown persona ID: "${id}". Registered personas: ["rebecca"].`);
}

/**
 * Default patterns (from Rebecca persona)
 */
export const personaPatterns: readonly PersonaPattern[] = rebeccaPersona.patterns;

/**
 * Finds top-K matching persona patterns based on cosine similarity against the supplied pattern vectors.
 * Evaluates strictly against `patternVectors` without falling back to any hardcoded persona singleton.
 *
 * @param queryVector - Embedding vector representing the current situational trigger.
 * @param patternVectors - Precomputed pattern entries paired with embedding vectors.
 * @param topK - Maximum number of matching patterns to return (defaults to `3`).
 * @returns Top-K matching patterns ranked by similarity.
 */
export const findTopPersonaPatterns = (
  queryVector: readonly number[],
  patternVectors: readonly PersonaPatternWithVector[],
  topK = 3
): PersonaPattern[] => {
  return rankPersonaPatternVectors(queryVector, patternVectors, topK);
};

/**
 * Builds the few-shot prompt section from selected persona patterns.
 *
 * @param patterns - Selected patterns to format.
 * @param lang - Target natural language (`'ja'` or `'en'`). Defaults to `'ja'`.
 * @returns Formatted few-shot section string.
 */
export const buildPersonaFewShotPrompt = (
  patterns: readonly PersonaPattern[],
  lang: Language = 'ja',
): string => {
  return formatPersonaFewShotPrompt(patterns, lang);
};
