import { GoogleGenAI } from '@google/genai';
import type { IMemoryVectorEmbedder } from '@rebecca/memory';
import { config } from '../../config';

/**
 * Wraps the `@google/genai` client in `@rebecca/memory`'s provider-agnostic
 * {@link IMemoryVectorEmbedder} port configured for 768-dimensional persona vector alignment.
 *
 * @param aiClient - Initialized GoogleGenAI client instance.
 * @returns Vector embedder adapter compatible with `@rebecca/prompt` anchoring.
 */
export const createCopilotEmbeddingProvider = (
  aiClient: GoogleGenAI,
): IMemoryVectorEmbedder => ({
  generateEmbedding: async (text: string): Promise<number[]> => {
    if (typeof aiClient.models?.embedContent !== 'function') {
      return [];
    }
    const embRes = await aiClient.models.embedContent({
      model: config.gemini.embeddingModel,
      contents: text,
      config: { outputDimensionality: 768 },
    });
    return embRes.embeddings?.[0]?.values ?? [];
  },
});
