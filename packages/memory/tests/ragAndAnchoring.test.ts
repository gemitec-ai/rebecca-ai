import {
  cosineSimilarity,
  IMemoryRagStore,
  IMemoryVectorEmbedder,
  indexVectorMemory,
  searchVectorMemories,
  vectorizeText,
} from '../src';

describe('core vectorization and RAG primitives', () => {
  describe('cosineSimilarity', () => {
    it('returns 0 for empty, mismatched-length, or zero-magnitude vectors', () => {
      expect(cosineSimilarity([], [])).toBe(0);
      expect(cosineSimilarity([1, 2], [1])).toBe(0);
      expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    });

    it('computes accurate cosine similarity for identical and orthogonal vectors', () => {
      expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
      expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
      expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
    });
  });

  describe('vectorizeText, indexVectorMemory, and searchVectorMemories', () => {
    it('skips blank inputs cleanly and trims non-blank inputs before embedding', async () => {
      const embedder: IMemoryVectorEmbedder = {
        generateEmbedding: jest.fn().mockResolvedValue([0.2, 0.8]),
      };
      const store: IMemoryRagStore = {
        saveRagMemory: jest.fn().mockResolvedValue(undefined),
        findRagMemories: jest.fn().mockResolvedValue(['episode 1']),
      };

      expect(await vectorizeText(embedder, '   ')).toEqual([]);
      expect(embedder.generateEmbedding).not.toHaveBeenCalled();

      expect(await indexVectorMemory(embedder, store, 'u1', '   ')).toBe(false);
      expect(await indexVectorMemory(embedder, store, 'u1', '  hello world  ')).toBe(true);
      expect(store.saveRagMemory).toHaveBeenCalledWith('u1', 'hello world', [0.2, 0.8]);

      expect(await searchVectorMemories(embedder, store, 'u1', 'query', 0)).toEqual([]);
      expect(await searchVectorMemories(embedder, store, 'u1', 'query', Number.NaN)).toEqual([]);
      expect(await searchVectorMemories(embedder, store, 'u1', 'query', Number.POSITIVE_INFINITY)).toEqual([]);
      expect(await searchVectorMemories(embedder, store, 'u1', 'query', 0.4)).toEqual([]);
      expect(await searchVectorMemories(embedder, store, 'u1', '   ', 3)).toEqual([]);
      expect(await searchVectorMemories(embedder, store, 'u1', 'coffee', 5.8)).toEqual(['episode 1']);
      expect(store.findRagMemories).toHaveBeenCalledWith('u1', [0.2, 0.8], 5);
    });

    it('returns false / empty when embedder yields empty vector and fails fast on blank userId', async () => {
      const embedder: IMemoryVectorEmbedder = {
        generateEmbedding: jest.fn().mockResolvedValue([]),
      };
      const store: IMemoryRagStore = {
        saveRagMemory: jest.fn(),
        findRagMemories: jest.fn(),
      };

      await expect(indexVectorMemory(embedder, store, ' ', 'text')).rejects.toThrow(
        'Cannot index vector memory: userId must be a non-empty string',
      );
      await expect(searchVectorMemories(embedder, store, '', 'query')).rejects.toThrow(
        'Cannot search vector memories: userId must be a non-empty string',
      );

      expect(await indexVectorMemory(embedder, store, 'u1', 'text')).toBe(false);
      expect(await searchVectorMemories(embedder, store, 'u1', 'query')).toEqual([]);
      expect(store.saveRagMemory).not.toHaveBeenCalled();
      expect(store.findRagMemories).not.toHaveBeenCalled();
    });
  });
});
