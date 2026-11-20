import type { IPersonaDefinition } from '@rebecca/persona';
import { getCopilotChannelContext } from '../../src/features/copilot/prompts';

const persona = {
  metadata: {
    userCallsign: { ja: 'テストオペレーター', en: 'Test Operator' },
    localizedTone: { ja: 'テスト口調ラベル', en: 'test-tone-label' },
  },
} as unknown as Pick<IPersonaDefinition, 'metadata'>;

describe('getCopilotChannelContext', () => {
  describe('English', () => {
    const text = getCopilotChannelContext(persona, 'en');

    it('addresses the operator with the injected English callsign', () => {
      expect(text).toContain('You are assisting Test Operator (the system operator)');
    });

    it('delegates voice to the system-prompt persona in every mode and leaves the model to pick the mode', () => {
      expect(text).toContain('Always respond as the persona defined in this system prompt, in every mode.');
      expect(text).toContain("Decide the mode yourself from the operator's message");
    });

    it('leaves Conversation Mode unconstrained', () => {
      expect(text).toMatch(/\*\*Conversation Mode\*\*[^\n]*: No additional constraints\./);
    });

    it('scopes the anti-flattery rule to Analysis Mode only', () => {
      const lines = text.split('\n');
      const flatteryLines = lines.filter((line) => line.includes('blind flattery'));

      expect(flatteryLines).toHaveLength(1);
      expect(flatteryLines[0]).toContain('**Analysis Mode**');
      expect(flatteryLines[0]).toContain('Test Operator');
      expect(text).toContain('apply Analysis Mode only to the analytical part');
    });

    it('does not inject tone labels or character-specific wording', () => {
      expect(text).not.toContain('test-tone-label');
      expect(text).not.toContain('Gyaru');
    });
  });

  describe('Japanese', () => {
    const text = getCopilotChannelContext(persona, 'ja');

    it('addresses the operator with the injected Japanese callsign', () => {
      expect(text).toContain('システム管理者（テストオペレーター）と1対1で対話する補助パートナー');
    });

    it('delegates voice to the system-prompt persona in every mode and leaves the model to pick the mode', () => {
      expect(text).toContain('どのモードでも、このシステムプロンプトで定義されたペルソナとして応答してください。');
      expect(text).toContain('モードはオペレーターの発話内容からあなた自身が判断してください');
    });

    it('leaves Conversation Mode unconstrained', () => {
      expect(text).toMatch(/\*\*会話モード\*\*[^\n]*: 追加の制約はありません。/);
    });

    it('scopes the anti-flattery rule to Analysis Mode only', () => {
      const lines = text.split('\n');
      const flatteryLines = lines.filter((line) => line.includes('迎合'));

      expect(flatteryLines).toHaveLength(1);
      expect(flatteryLines[0]).toContain('**解析モード**');
      expect(flatteryLines[0]).toContain('テストオペレーター');
      expect(text).toContain('分析部分のみ解析モードを適用してください');
    });

    it('does not inject tone labels or character-specific wording', () => {
      expect(text).not.toContain('テスト口調ラベル');
      expect(text).not.toContain('ギャル');
      expect(text).not.toContain('全肯定');
    });
  });
});
