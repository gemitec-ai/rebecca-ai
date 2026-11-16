import type { ConversationLogEntry, UserCoreProfile } from '@rebecca/types';
import {
  DreamingConsolidationEngine,
  hasUnconsolidatedActivity,
  IDreamingMemoryStore,
  IDreamingSynthesizer,
  MemoryLogger,
  MemoryUserSnapshot,
} from '../src';

describe('DreamingConsolidationEngine and hasUnconsolidatedActivity', () => {
  describe('hasUnconsolidatedActivity', () => {
    it('returns false when episodicBuffer is missing or empty', () => {
      expect(hasUnconsolidatedActivity({})).toBe(false);
      expect(hasUnconsolidatedActivity({ episodicBuffer: [] })).toBe(false);
    });

    it('returns true when episodicBuffer has entries and lastDreamedAt is absent', () => {
      expect(
        hasUnconsolidatedActivity({
          episodicBuffer: [{ role: 'user', content: 'hi' }],
        }),
      ).toBe(true);
    });

    it('evaluates epoch milliseconds across timezone offsets and invalid timestamps', () => {
      expect(
        hasUnconsolidatedActivity({
          lastSeen: '2026-10-18T04:30:00.000Z',
          lastDreamedAt: '2026-10-18T04:30:00.000Z',
          episodicBuffer: [{ role: 'user', content: 'equal' }],
        }),
      ).toBe(false);

      expect(
        hasUnconsolidatedActivity({
          lastSeen: '2026-10-18T13:31:00.000+09:00',
          lastDreamedAt: '2026-10-18T04:30:00.000Z',
          episodicBuffer: [{ role: 'user', content: 'newer offset' }],
        }),
      ).toBe(true);

      expect(
        hasUnconsolidatedActivity({
          lastSeen: 'invalid-date',
          lastDreamedAt: '2026-10-18T04:30:00.000Z',
          episodicBuffer: [{ role: 'user', content: 'bad date' }],
        }),
      ).toBe(false);
    });
  });

  describe('DreamingConsolidationEngine', () => {
    const createHarness = (users: MemoryUserSnapshot[]) => {
      const updated = new Map<
        string,
        { profile: UserCoreProfile; retainedBuffer: ConversationLogEntry[]; lastDreamedAt: string }
      >();
      const store: IDreamingMemoryStore = {
        listConsolidationCandidates: jest.fn(async () => users),
        updateCoreProfile: jest.fn(async (userId, profile, retainedBuffer, lastDreamedAt) => {
          updated.set(userId, { profile, retainedBuffer, lastDreamedAt });
        }),
      };
      const synthesizer: IDreamingSynthesizer = {
        generateDreaming: jest.fn(async (_prompt, _buffer, existing) => ({
          ...existing,
          consolidated: true,
        })),
      };
      const logger: MemoryLogger = {
        info: jest.fn(),
        error: jest.fn(),
      };

      return { updated, store, synthesizer, logger };
    };

    it('returns skipped status when no users have pending episodic activity', async () => {
      const { store, synthesizer, logger } = createHarness([
        { id: 'u1', episodicBuffer: [] },
        {
          id: 'u2',
          episodicBuffer: [{ role: 'user', content: 'old' }],
          lastSeen: '2026-01-01T00:00:00.000Z',
          lastDreamedAt: '2026-01-02T00:00:00.000Z',
        },
      ]);

      const engine = new DreamingConsolidationEngine(
        { store, synthesizer, dreamingPrompt: 'DREAM', logger },
        { throttleMs: 0 },
      );

      const res = await engine.execute();
      expect(res).toEqual({
        status: 'skipped',
        reason: 'no_users_with_episodic_buffer',
        totalUsers: 2,
        processedUsers: 0,
        succeeded: 0,
        failed: 0,
        skipped: 2,
      });
      expect(synthesizer.generateDreaming).not.toHaveBeenCalled();
    });

    it('consolidates pending users, retains sliding buffer boundary, and handles partial failures', async () => {
      const longBuffer: ConversationLogEntry[] = Array.from({ length: 25 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'model',
        content: `m-${i}`,
      }));

      const { updated, store, synthesizer, logger } = createHarness([
        { id: 'u_ok', coreProfile: { hobby: 'art' }, episodicBuffer: longBuffer },
        { id: 'u_fail', coreProfile: {}, episodicBuffer: [{ role: 'user', content: 'fail me' }] },
        { episodicBuffer: [{ role: 'user', content: 'missing id' }] },
        { id: 'u_skip', episodicBuffer: [] },
      ]);

      (synthesizer.generateDreaming as jest.Mock).mockImplementation(async (_p, buffer) => {
        if (buffer[0]?.content === 'fail me') {
          throw new Error('Synthesizer timeout');
        }
        return { hobby: 'art', updated: true };
      });

      const engine = new DreamingConsolidationEngine(
        { store, synthesizer, dreamingPrompt: () => 'DREAM', logger, logTag: '[TestDream]' },
        { throttleMs: 1, retainedBufferEntries: 20 },
      );

      const res = await engine.execute();
      expect(res).toEqual({
        status: 'partial_success',
        totalUsers: 4,
        processedUsers: 3,
        succeeded: 1,
        failed: 2,
        skipped: 1,
      });

      const uOkUpdate = updated.get('u_ok');
      expect(uOkUpdate?.profile).toEqual({ hobby: 'art', updated: true });
      expect(uOkUpdate?.retainedBuffer).toHaveLength(20);
      expect(uOkUpdate?.retainedBuffer[0]?.content).toBe('m-5');
      expect(logger.error).toHaveBeenCalledWith('[TestDream] Dreaming failed for user', expect.any(Error), {
        userId: 'u_fail',
      });
    });

    it('reports failed status when every pending user fails and handles zero retainedBufferEntries', async () => {
      const { updated, store, synthesizer } = createHarness([
        { id: 'u1', episodicBuffer: [{ role: 'user', content: 'err' }] },
      ]);
      (synthesizer.generateDreaming as jest.Mock).mockRejectedValueOnce(new Error('Upstream 503'));

      const failEngine = new DreamingConsolidationEngine(
        { store, synthesizer, dreamingPrompt: 'DREAM' },
        { throttleMs: 0 },
      );
      const failResult = await failEngine.execute();
      expect(failResult.status).toBe('failed');
      expect(failResult.failed).toBe(1);

      (synthesizer.generateDreaming as jest.Mock).mockResolvedValueOnce({ done: true });
      const zeroRetentionEngine = new DreamingConsolidationEngine(
        { store, synthesizer, dreamingPrompt: () => 'DREAM' },
        { throttleMs: 0, retainedBufferEntries: 0 },
      );
      expect(await zeroRetentionEngine.consolidateUser('u1', { episodicBuffer: [] })).toBe(false);
      expect(
        await zeroRetentionEngine.consolidateUser('u1', {
          episodicBuffer: [{ role: 'user', content: 'hello' }],
        }),
      ).toBe(true);
      expect(updated.get('u1')?.retainedBuffer).toEqual([]);
    });
  });
});
