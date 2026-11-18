import type { IMemoryRagStore, IMemoryVectorEmbedder } from './types';

/** Default maximum number of semantic RAG memories returned per retrieval query. */
export const DEFAULT_RAG_SEARCH_LIMIT = 3;

/**
 * Computes cosine similarity between two equal-dimensional numeric vectors.
 * Returns `0` when inputs are empty, mismatched in length, or contain zero magnitude.
 *
 * @param vecA - First embedding vector.
 * @param vecB - Second embedding vector.
 * @returns Cosine similarity scalar typically within `[-1, 1]`, or `0` on degenerate inputs.
 */
export const cosineSimilarity = (
  vecA: readonly number[],
  vecB: readonly number[],
): number => {
  if (vecA.length === 0 || vecA.length !== vecB.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    const a = vecA[i];
    const b = vecB[i];
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0 || !Number.isFinite(denominator)) {
    return 0;
  }

  return dot / denominator;
};

/**
 * Generates an embedding vector for arbitrary text via the injected embedder port.
 * Skips embedder invocation and returns `[]` when input text is blank.
 *
 * @param embedder - Embedding provider adapter.
 * @param text - Text content to vectorize.
 * @returns Embedding vector, or `[]` when input is blank or provider emits an empty array.
 */
export const vectorizeText = async (
  embedder: IMemoryVectorEmbedder,
  text: string,
): Promise<number[]> => {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const vector = await embedder.generateEmbedding(trimmed);
  if (!Array.isArray(vector) || vector.length === 0) {
    return [];
  }
  return vector;
};

/**
 * Vectorizes an arbitrary memory document prepared by a caller use case and persists it
 * to the configured RAG vector store.
 *
 * Callers retain full ownership over how domain-specific episodes (e.g., X replies,
 * lounge conversations, timeline posts) are formatted into `text`.
 *
 * @param embedder - Embedding provider adapter.
 * @param store - Persistent vector memory store adapter.
 * @param userId - Canonical user identifier within the target memory store.
 * @param text - Caller-formatted memory text to embed and store.
 * @returns `true` if a non-empty vector was generated and persisted, `false` if skipped.
 * @throws Error when `userId` is blank or upstream embedder/store calls reject.
 */
export const indexVectorMemory = async (
  embedder: IMemoryVectorEmbedder,
  store: IMemoryRagStore,
  userId: string,
  text: string,
): Promise<boolean> => {
  if (!userId.trim()) {
    throw new Error('Cannot index vector memory: userId must be a non-empty string');
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  const vector = await vectorizeText(embedder, trimmed);
  if (vector.length === 0) {
    return false;
  }

  await store.saveRagMemory(userId, trimmed, vector);
  return true;
};

/**
 * Vectorizes a caller-supplied search query and retrieves semantically similar memories
 * from the configured RAG store.
 *
 * @param embedder - Embedding provider adapter.
 * @param store - Persistent vector memory store adapter.
 * @param userId - Canonical user identifier within the target memory store.
 * @param queryText - Caller-supplied search query text.
 * @param limit - Maximum number of memories to return. Defaults to `3`.
 * @returns Retrieved memory strings ordered by vector similarity, or `[]` when skipped.
 * @throws Error when `userId` is blank or upstream embedder/store calls reject.
 */
export const searchVectorMemories = async (
  embedder: IMemoryVectorEmbedder,
  store: IMemoryRagStore,
  userId: string,
  queryText: string,
  limit: number = DEFAULT_RAG_SEARCH_LIMIT,
): Promise<string[]> => {
  if (!userId.trim()) {
    throw new Error('Cannot search vector memories: userId must be a non-empty string');
  }

  const normalizedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 0;
  if (normalizedLimit <= 0) {
    return [];
  }

  const queryVector = await vectorizeText(embedder, queryText);
  if (queryVector.length === 0) {
    return [];
  }

  return store.findRagMemories(userId, queryVector, normalizedLimit);
};
