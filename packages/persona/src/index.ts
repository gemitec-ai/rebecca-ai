export * from './types';
export * from './basePersona';
export * from './structuredResponse';
export { precomputedPersonaPatternEmbeddings, PersonaPatternWithVector } from './personaPatternVectors';
export { rebeccaPersona, RebeccaPersona, REBECCA_METADATA, REBECCA_PORTAL_CONFIG } from './personas/rebecca';

import { rebeccaPersona } from './personas/rebecca';
import { IPersonaDefinition, PersonaPattern, Language } from './types';

/**
 * Registry resolver for active persona.
 * Fail-fast: Throws an explicit error if an unrecognized persona ID is requested.
 * Defaults to 'rebecca' if id is undefined, null, or empty string.
 */
export function getActivePersona(id?: string): IPersonaDefinition {
  const normalizedId = (id || 'rebecca').trim().toLowerCase();
  if (normalizedId === 'rebecca') {
    return rebeccaPersona;
  }
  throw new Error(`Unknown persona ID: "${id}". Registered personas: ["rebecca"].`);
}

/**
 * Default patterns (from Rebecca persona)
 */
export const personaPatterns: PersonaPattern[] = rebeccaPersona.patterns;

/**
 * Finds top-K matching persona patterns based on cosine similarity against trigger vectors.
 */
export const findTopPersonaPatterns = (
  queryVector: number[],
  patternVectors: Array<{ id: number; vector: number[] }>,
  topK = 3
): PersonaPattern[] => {
  return rebeccaPersona.findTopPatterns(queryVector, topK);
};

/**
 * Builds the few-shot prompt section from selected persona patterns.
 */
export const buildPersonaFewShotPrompt = (patterns: PersonaPattern[], lang: Language = 'ja'): string => {
  return rebeccaPersona.buildFewShotPrompt(patterns, lang);
};
