import type { ConversationLogEntry } from '@rebecca/types';
import {
  createTurnPair,
  formatHistoryWithInnerThought,
  formatTurnWithInnerThought,
  getWorkingMemory,
  IMemoryEpisodicStore,
  saveInteraction,
} from '../src';

describe('workingMemory and Tatemae/Honne reconstruction', () => {
  describe('getWorkingMemory', () => {
    it('returns empty array for undefined, empty buffer, or non-positive limits', () => {
      const sample: ConversationLogEntry[] = [{ role: 'user', content: 'hi' }];
      expect(getWorkingMemory(undefined)).toEqual([]);
      expect(getWorkingMemory([])).toEqual([]);
      expect(getWorkingMemory(sample, 0)).toEqual([]);
      expect(getWorkingMemory(sample, -2)).toEqual([]);
    });

    it('slices exact trailing 2 * limit entries across boundary sizes', () => {
      const entries: ConversationLogEntry[] = Array.from({ length: 24 }, (_, idx) => ({
        role: idx % 2 === 0 ? 'user' : 'model',
        content: `turn-${idx}`,
      }));

      expect(getWorkingMemory(entries, 10)).toHaveLength(20);
      expect(getWorkingMemory(entries, 10)[0]?.content).toBe('turn-4');
      expect(getWorkingMemory(entries, 10)[19]?.content).toBe('turn-23');
      expect(getWorkingMemory(entries, 1)).toEqual(entries.slice(-2));
      expect(getWorkingMemory(entries, 20)).toEqual(entries);
    });
  });

  describe('createTurnPair and saveInteraction', () => {
    it('omits thought field when absent or whitespace-only', () => {
      const [userEntry, modelWithoutThought] = createTurnPair('hi', 'hello', '   ', '2026-01-01T00:00:00.000Z');
      expect(userEntry).toEqual({
        role: 'user',
        content: 'hi',
        timestamp: '2026-01-01T00:00:00.000Z',
      });
      expect(modelWithoutThought).toEqual({
        role: 'model',
        content: 'hello',
        timestamp: '2026-01-01T00:00:00.000Z',
      });
      expect('thought' in modelWithoutThought).toBe(false);
    });

    it('preserves thought on model entry and persists sequentially via store', async () => {
      const appended: Array<{ userId: string; log: ConversationLogEntry }> = [];
      const store: IMemoryEpisodicStore = {
        appendEpisodicBuffer: async (userId, log) => {
          appended.push({ userId, log });
        },
      };

      const fixedNow = new Date('2026-05-01T12:00:00.000Z');
      await saveInteraction(store, 'user_001', 'Good morning', 'Hey there!', 'So glad they said hi', fixedNow);

      expect(appended).toEqual([
        {
          userId: 'user_001',
          log: { role: 'user', content: 'Good morning', timestamp: '2026-05-01T12:00:00.000Z' },
        },
        {
          userId: 'user_001',
          log: {
            role: 'model',
            content: 'Hey there!',
            thought: 'So glad they said hi',
            timestamp: '2026-05-01T12:00:00.000Z',
          },
        },
      ]);
    });

    it('fails fast when userId is blank', async () => {
      const store: IMemoryEpisodicStore = {
        appendEpisodicBuffer: jest.fn(),
      };
      await expect(saveInteraction(store, '   ', 'hi', 'hey')).rejects.toThrow(
        'Cannot save interaction: userId must be a non-empty string',
      );
      expect(store.appendEpisodicBuffer).not.toHaveBeenCalled();
    });

    it('propagates persistence failures without swallowing errors', async () => {
      const store: IMemoryEpisodicStore = {
        appendEpisodicBuffer: jest.fn().mockRejectedValue(new Error('firestore unavailable')),
      };
      await expect(saveInteraction(store, 'user_001', 'hi', 'hey')).rejects.toThrow('firestore unavailable');
    });
  });

  describe('formatTurnWithInnerThought and formatHistoryWithInnerThought', () => {
    it('formats model turns with Tatemae/Honne structure and timestamp prefix', () => {
      const turns: ConversationLogEntry[] = [
        { role: 'user', content: 'How are you?', timestamp: '2026-05-01T00:00:00.000Z' },
        {
          role: 'model',
          content: 'Doing great!',
          thought: 'Actually thrilled they asked.',
          timestamp: '2026-05-01T00:01:00.000Z',
        },
        { role: 'model', content: 'Still here.' },
      ];

      const formatted = formatHistoryWithInnerThought(turns, 'UTC');
      expect(formatted).toHaveLength(3);
      expect(formatted[0]?.role).toBe('user');
      expect(formatted[0]?.text).toMatch(/^\[2026-05-01 00:00 UTC\] How are you\?$/);
      expect(formatted[1]?.role).toBe('model');
      expect(formatted[1]?.text).toContain('【思考・本音】Actually thrilled they asked.\n【発話】Doing great!');
      expect(formatted[2]).toEqual({ role: 'model', text: 'Still here.' });

      const formattedEn = formatHistoryWithInnerThought(turns, 'UTC', 'en');
      expect(formattedEn[1]?.text).toContain('[Inner Thought]Actually thrilled they asked.\n[Spoken Reply]Doing great!');
    });

    it('omits timestamp prefix cleanly when timestamp is invalid', () => {
      const turned = formatTurnWithInnerThought({ role: 'user', content: 'ping', timestamp: 'bad-ts' }, 'UTC');
      expect(turned).toEqual({ role: 'user', text: 'ping' });
    });
  });
});
