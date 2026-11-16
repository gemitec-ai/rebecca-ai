import {
  cosineSimilarity,
  IMemoryRagStore,
  IMemoryVectorEmbedder,
  indexVectorMemory,
  MemoryLogger,
  resolveSituationalPersonaAnchors,
  searchVectorMemories,
  vectorizeText,
} from '../src';

describe('core vectorization, RAG primitives, and personaAnchoring', () => {
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
      expect(await searchVectorMemories(embedder, store, 'u1', '   ', 3)).toEqual([]);
      expect(await searchVectorMemories(embedder, store, 'u1', 'coffee', 5)).toEqual(['episode 1']);
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

  describe('resolveSituationalPersonaAnchors', () => {
    it('returns empty string immediately when context elements are empty or whitespace', async () => {
      const embedder = { generateEmbedding: jest.fn() };
      const res = await resolveSituationalPersonaAnchors({
        embedder,
        contextElements: ['', '   '],
        patternVectors: [],
        findTopPatterns: jest.fn(),
        buildFewShotPrompt: jest.fn(),
      });
      expect(res).toBe('');
      expect(embedder.generateEmbedding).not.toHaveBeenCalled();
    });

    it('returns empty string when embedder returns empty vector or throws, logging a warning', async () => {
      const warnLogger: MemoryLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

      const emptyRes = await resolveSituationalPersonaAnchors({
        embedder: { generateEmbedding: jest.fn().mockResolvedValue([]) },
        contextElements: ['morning coffee'],
        patternVectors: [],
        findTopPatterns: jest.fn(),
        buildFewShotPrompt: jest.fn(),
        logger: warnLogger,
      });
      expect(emptyRes).toBe('');

      const errRes = await resolveSituationalPersonaAnchors({
        embedder: { generateEmbedding: jest.fn().mockRejectedValue(new Error('quota')) },
        contextElements: ['morning coffee'],
        patternVectors: [],
        findTopPatterns: jest.fn(),
        buildFewShotPrompt: jest.fn(),
        logger: warnLogger,
      });
      expect(errRes).toBe('');
      expect(warnLogger.warn).toHaveBeenCalledWith(
        'Failed to resolve dynamic situational persona anchors',
        expect.objectContaining({ err: expect.any(Error) }),
      );
    });

    it('resolves top patterns and formats few-shot prompt cleanly', async () => {
      const samplePattern = {
        id: 1,
        category: 'care',
        trigger: 'tired',
        internal_thought: 'worry',
        behavior: 'encourage',
        sample_response: 'Rest up!',
      };
      const res = await resolveSituationalPersonaAnchors({
        embedder: { generateEmbedding: jest.fn().mockResolvedValue([0.5, 0.5]) },
        contextElements: ['Evening check-in', '  '],
        patternVectors: [{ ...samplePattern, vector: [0.5, 0.5] }],
        findTopPatterns: jest.fn().mockReturnValue([samplePattern]),
        buildFewShotPrompt: jest.fn((patterns, lang) => `FEW_SHOT(${lang}):${patterns.length}`),
        lang: 'en',
        topK: 2,
      });
      expect(res).toBe('FEW_SHOT(en):1');
    });
  });
});
