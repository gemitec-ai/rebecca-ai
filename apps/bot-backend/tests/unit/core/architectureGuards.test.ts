import fs from 'node:fs';
import path from 'node:path';

const BOT_FEATURES_ROOT = path.resolve(__dirname, '../../../src/features');

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

describe('Bot Feature Prompt Architecture Guards', () => {
  it('ensures every persona-speaking feature usecase enforces 120-pattern anchoring without raw prompt bypasses', () => {
    const useCaseFiles = findFeatureUseCases(BOT_FEATURES_ROOT);
    expect(useCaseFiles.length).toBeGreaterThanOrEqual(8);

    const generationMethodPattern =
      /gemini\.(?:generateStructuredReply|generateStructuredTimelinePost|generateStructuredNewsPost|generateStructuredPollPost|generateStructuredSupportPost)\s*\(/;
    const anchoringPattern =
      /\b(?:resolveSituationalPersonaAnchors|buildGroundedBotChannelPrompt|composeAnchoredChannelPrompt|composeGroundedSystemPrompt)\s*\(/;

    for (const filePath of useCaseFiles) {
      const source = fs.readFileSync(filePath, 'utf8');
      const relative = path.relative(BOT_FEATURES_ROOT, filePath);

      if (generationMethodPattern.test(source)) {
        expect({
          file: relative,
          hasMandatoryAnchoring: anchoringPattern.test(source),
        }).toEqual({
          file: relative,
          hasMandatoryAnchoring: true,
        });
      }

      // Guard against calling unanchored Layer 0 composePrompt or deprecated getBasePrompt directly inside features
      expect({
        file: relative,
        usesRawComposeOrDeprecatedBase:
          /persona\.(?:composePrompt|getBasePrompt)\s*\(/.test(source),
      }).toEqual({
        file: relative,
        usesRawComposeOrDeprecatedBase: false,
      });
    }
  });
});
