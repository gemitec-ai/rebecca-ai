import fs from 'node:fs';
import path from 'node:path';

const BOT_SRC_ROOT = path.resolve(__dirname, '../../../src');
const BOT_FEATURES_ROOT = path.join(BOT_SRC_ROOT, 'features');

/**
 * Collects all `usecase.ts` files under `apps/bot-backend/src/features`.
 */
const findFeatureUseCases = (dir: string): string[] => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFeatureUseCases(fullPath));
    } else if (entry.isFile() && entry.name === 'usecase.ts') {
      results.push(fullPath);
    }
  }
  return results;
};

describe('Bot Single-Pipeline Prompt Architecture Guards', () => {
  it('ensures every persona-speaking feature usecase uses the single unified buildSystemPrompt pipeline without bypasses', () => {
    const useCaseFiles = findFeatureUseCases(BOT_FEATURES_ROOT);
    expect(useCaseFiles.length).toBeGreaterThanOrEqual(8);

    const generationMethodPattern =
      /gemini\.(?:generateStructuredReply|generateStructuredTimelinePost|generateStructuredNewsPost|generateStructuredPollPost|generateStructuredSupportPost)\s*\(/;

    for (const filePath of useCaseFiles) {
      const source = fs.readFileSync(filePath, 'utf8');
      const relative = path.relative(BOT_FEATURES_ROOT, filePath);

      if (generationMethodPattern.test(source)) {
        expect({
          file: relative,
          usesUnifiedBotPromptPipeline: /\bbuildSystemPrompt\s*\(/.test(source),
        }).toEqual({
          file: relative,
          usesUnifiedBotPromptPipeline: true,
        });
      }

      // Guard against multiple prompt pipelines or unanchored persona calls inside features
      expect({
        file: relative,
        hasForbiddenBypassOrSplitPipeline:
          /(?:persona\.(?:composePrompt|getBasePrompt)|buildBotChannelBasePrompt|resolveSituationalPersonaAnchors|composeAnchoredChannelPrompt|composeGroundedSystemPrompt|composeSystemPrompt)\s*\(/.test(
            source,
          ),
      }).toEqual({
        file: relative,
        hasForbiddenBypassOrSplitPipeline: false,
      });
    }
  });

  it('keeps redundant wrapper modules removed from core/', () => {
    expect(fs.existsSync(path.join(BOT_SRC_ROOT, 'core/personaAnchoring.ts'))).toBe(false);
    expect(fs.existsSync(path.join(BOT_SRC_ROOT, 'core/personaEmbeddingCache.ts'))).toBe(false);
    const channelPromptsSrc = fs.readFileSync(
      path.join(BOT_SRC_ROOT, 'core/channelPrompts.ts'),
      'utf8',
    );
    expect(channelPromptsSrc).not.toContain('buildBotChannelBasePrompt');
    expect(channelPromptsSrc).not.toContain('buildGroundedBotChannelPrompt');
  });

  it('enforces unified Honne & Tatemae structured response schemas via @rebecca/persona without hand-rolled schema duplicates', () => {
    const geminiServiceSrc = fs.readFileSync(
      path.join(BOT_SRC_ROOT, 'services/gemini.ts'),
      'utf8',
    );
    expect(geminiServiceSrc).toContain('PERSONA_RESPONSE_SCHEMA');
    expect(geminiServiceSrc).toContain('createStructuredPersonaSchema(');
    expect(geminiServiceSrc).not.toMatch(/required:\s*\[\s*['"](?:selectedTitle|thought)['"]/);
  });
});
