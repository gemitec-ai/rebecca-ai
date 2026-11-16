import type { MemoryLogger } from '@rebecca/memory';
import { resolveSituationalPersonaAnchors } from '../src';

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

  it('returns empty string when resolvedVectors is empty without calling embedder', async () => {
    const embedder = { generateEmbedding: jest.fn() };
    const res = await resolveSituationalPersonaAnchors({
      embedder,
      contextElements: ['morning coffee'],
      patternVectors: [],
    });
    expect(res).toBe('');
    expect(embedder.generateEmbedding).not.toHaveBeenCalled();
  });

  it('throws when neither patternVectors nor persona is supplied', async () => {
    await expect(
      resolveSituationalPersonaAnchors({
        embedder: { generateEmbedding: jest.fn() },
        contextElements: ['morning coffee'],
      }),
    ).rejects.toThrow('resolveSituationalPersonaAnchors requires either patternVectors or persona');
  });

  it('returns empty string when embedder returns empty vector or throws, logging a warning', async () => {
    const warnLogger: MemoryLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const nonEmptyVectors = [
      {
        id: 1,
        category: 'care',
        trigger: 'tired',
        internal_thought: 'worry',
        behavior: 'encourage',
        sample_response: 'Rest up!',
        vector: [1, 0],
      },
    ];

    const emptyRes = await resolveSituationalPersonaAnchors({
      embedder: { generateEmbedding: jest.fn().mockResolvedValue([]) },
      contextElements: ['morning coffee'],
      patternVectors: nonEmptyVectors,
      findTopPatterns: jest.fn(),
      buildFewShotPrompt: jest.fn(),
      logger: warnLogger,
    });
    expect(emptyRes).toBe('');

    const errRes = await resolveSituationalPersonaAnchors({
      embedder: { generateEmbedding: jest.fn().mockRejectedValue(new Error('quota')) },
      contextElements: ['morning coffee'],
      patternVectors: nonEmptyVectors,
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

  it('resolves top patterns via persona shorthand cleanly', async () => {
    const samplePattern = {
      id: 1,
      category: 'care',
      trigger: 'tired',
      internal_thought: 'worry',
      behavior: 'encourage',
      sample_response: 'Rest up!',
      vector: [0.5, 0.5],
    };
    const persona = {
      patternVectors: [samplePattern],
      findTopPatterns: jest.fn().mockReturnValue([samplePattern]),
      buildFewShotPrompt: jest.fn((patterns, lang) => `PERSONA_FEW_SHOT(${lang}):${patterns.length}`),
    };
    const res = await resolveSituationalPersonaAnchors({
      embedder: { generateEmbedding: jest.fn().mockResolvedValue([0.5, 0.5]) },
      contextElements: ['Evening check-in'],
      persona,
      lang: 'ja',
      topK: 2,
    });
    expect(res).toBe('PERSONA_FEW_SHOT(ja):1');
    expect(persona.findTopPatterns).toHaveBeenCalledWith([0.5, 0.5], 2);
  });

  it('resolves top patterns using explicit matchers cleanly', async () => {
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
