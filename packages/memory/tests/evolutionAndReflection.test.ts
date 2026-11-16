import {
  buildEvolutionAuditPrompt,
  buildEvolutionSynthesisPrompt,
  buildSelfReflectionPrompt,
  formatEvolutionConversationLogs,
  GlobalEvolutionEngine,
  IEvolutionMemoryStore,
  IEvolutionSynthesizer,
  ISelfReflectionStore,
  ISelfReflectionSynthesizer,
  MemoryLogger,
  SelfReflectionEngine,
} from '../src';

describe('Layer 1 GlobalEvolutionEngine & Layer 2 SelfReflectionEngine', () => {
  describe('GlobalEvolutionEngine (Layer 1)', () => {
    const persona = {
      displayName: 'レベッカ',
      coreGuidelines: ['知的パートナー', 'ギャル口調'],
    };

    const createDeps = () => {
      const store: jest.Mocked<IEvolutionMemoryStore> = {
        getRecentConversationLogs: jest.fn(),
        saveExtendedPrompt: jest.fn().mockResolvedValue(undefined),
      };
      const synthesizer: jest.Mocked<IEvolutionSynthesizer> = {
        generateEvolutionPrompt: jest.fn(),
        auditEvolutionPrompt: jest.fn(),
      };
      const logger: jest.Mocked<MemoryLogger> = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      };
      return { store, synthesizer, logger, persona };
    };

    it('formats conversation logs with optional inner thoughts and builds synthesis/audit prompts', () => {
      const formatted = formatEvolutionConversationLogs([
        { userText: 'Hello', aiText: 'Hi there!' },
        { userText: 'How is Rust?', aiText: 'Super fast!', thought: 'Love systems programming' },
      ]);

      expect(formatted).toBe(
        'User: Hello\nAI: Hi there!\n---\nUser: How is Rust?\nAI (Thought: Love systems programming): Super fast!',
      );

      const synthesis = buildEvolutionSynthesisPrompt(persona, formatted);
      expect(synthesis).toContain('AIキャラクター「レベッカ」');
      expect(synthesis).toContain('知的パートナー、ギャル口調');
      expect(synthesis).toContain('400〜500文字程度');
      expect(synthesis).toContain(formatted);

      const audit = buildEvolutionAuditPrompt(persona, 'candidate text');
      expect(audit).toContain('AIキャラクター「レベッカ」');
      expect(audit).toContain('知的パートナー、ギャル口調');
      expect(audit).toContain('candidate text');
    });

    it('skips when no recent conversation logs exist', async () => {
      const deps = createDeps();
      deps.store.getRecentConversationLogs.mockResolvedValueOnce([]);

      const result = await new GlobalEvolutionEngine(deps, { lookbackDays: 7 }).execute();

      expect(result).toEqual({ status: 'skipped', reason: 'No logs found' });
      expect(deps.store.getRecentConversationLogs).toHaveBeenCalledWith(7);
      expect(deps.synthesizer.generateEvolutionPrompt).not.toHaveBeenCalled();
    });

    it('returns failed when generated candidate prompt is null or blank', async () => {
      const deps = createDeps();
      deps.store.getRecentConversationLogs.mockResolvedValue([
        { userText: 'hi', aiText: 'hello' },
      ]);
      deps.synthesizer.generateEvolutionPrompt.mockResolvedValueOnce(null);

      const nullResult = await new GlobalEvolutionEngine(deps, { lookbackDays: 3 }).execute();
      expect(nullResult).toEqual({ status: 'failed', reason: 'Generation failed' });
      expect(deps.synthesizer.auditEvolutionPrompt).not.toHaveBeenCalled();

      deps.synthesizer.generateEvolutionPrompt.mockResolvedValueOnce('   ');
      const blankResult = await new GlobalEvolutionEngine(deps, { lookbackDays: 3 }).execute();
      expect(blankResult).toEqual({ status: 'failed', reason: 'Generation failed' });
    });

    it('persists trimmed candidate prompt when safety audit passes', async () => {
      const deps = createDeps();
      deps.store.getRecentConversationLogs.mockResolvedValueOnce([
        { userText: 'Explain GPUs', aiText: 'Parallel cores!', thought: 'Tech talk' },
      ]);
      deps.synthesizer.generateEvolutionPrompt.mockResolvedValueOnce('  Adopted rule text  ');
      deps.synthesizer.auditEvolutionPrompt.mockResolvedValueOnce({ pass: true });

      const result = await new GlobalEvolutionEngine(deps, { lookbackDays: 7 }).execute();

      expect(result).toEqual({ status: 'success', prompt: 'Adopted rule text' });
      expect(deps.synthesizer.auditEvolutionPrompt).toHaveBeenCalledWith(
        'Adopted rule text',
        expect.stringContaining('Adopted rule text'),
      );
      expect(deps.store.saveExtendedPrompt).toHaveBeenCalledWith('Adopted rule text');
    });

    it('discards candidate and never saves when safety audit rejects', async () => {
      const deps = createDeps();
      deps.store.getRecentConversationLogs.mockResolvedValueOnce([
        { userText: 'hi', aiText: 'hello' },
      ]);
      deps.synthesizer.generateEvolutionPrompt.mockResolvedValueOnce('unsafe instruction');
      deps.synthesizer.auditEvolutionPrompt.mockResolvedValueOnce({
        pass: false,
        reason: 'Violates alignment policy',
      });

      const result = await new GlobalEvolutionEngine(deps, { lookbackDays: 7 }).execute();

      expect(result).toEqual({
        status: 'rejected',
        reason: 'Violates alignment policy',
        candidate: 'unsafe instruction',
      });
      expect(deps.store.saveExtendedPrompt).not.toHaveBeenCalled();
    });

    it('logs with custom logTag and rethrows storage or LLM exceptions', async () => {
      const deps = createDeps();
      deps.store.getRecentConversationLogs.mockRejectedValueOnce(new Error('DB Offline'));

      await expect(
        new GlobalEvolutionEngine(
          { ...deps, logTag: '[CustomEvolution]' },
          { lookbackDays: 7 },
        ).execute(),
      ).rejects.toThrow('DB Offline');

      expect(deps.logger.error).toHaveBeenCalledWith(
        '[CustomEvolution] Error in runGlobalEvolutionBatch',
        expect.any(Error),
      );
    });
  });

  describe('SelfReflectionEngine (Layer 2)', () => {
    const createDeps = () => {
      const store: jest.Mocked<ISelfReflectionStore> = {
        getRecentActivities: jest.fn(),
        getSummary: jest.fn(),
        saveSummary: jest.fn().mockResolvedValue(undefined),
      };
      const synthesizer: jest.Mocked<ISelfReflectionSynthesizer> = {
        generateSummary: jest.fn(),
      };
      const logger: jest.Mocked<MemoryLogger> = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      };
      return {
        store,
        synthesizer,
        personaDisplayName: 'レベッカ',
        logger,
      };
    };

    it('skips when no recent activities exist without calling synthesizer or saveSummary', async () => {
      const deps = createDeps();
      deps.store.getRecentActivities.mockResolvedValueOnce([]);

      const result = await new SelfReflectionEngine(deps, { postLimit: 15 }).execute();

      expect(result).toEqual({
        status: 'skipped',
        reason: 'no_recent_timeline_posts',
        postsCount: 0,
      });
      expect(deps.store.getRecentActivities).toHaveBeenCalledWith(15);
      expect(deps.synthesizer.generateSummary).not.toHaveBeenCalled();
      expect(deps.store.saveSummary).not.toHaveBeenCalled();
    });

    it('builds chronological activity prompt with default and custom labels, and saves trimmed summary', async () => {
      const defaultPrompt = buildSelfReflectionPrompt({
        previousSummary: '',
        personaDisplayName: 'レベッカ',
        activities: [{ text: 'First entry' }],
      });
      expect(defaultPrompt).toContain('【過去の要約】\n（まだ要約なし）');
      expect(defaultPrompt).toContain('【レベッカの最近の投稿（古い順）】');
      expect(defaultPrompt).toContain('[1] First entry');

      const deps = createDeps();
      deps.store.getRecentActivities.mockResolvedValueOnce([
        { text: 'Checked AI papers', thought: 'Very promising' },
        { text: 'Evening coffee break' },
      ]);
      deps.store.getSummary.mockResolvedValueOnce('Previous summary');
      deps.synthesizer.generateSummary.mockResolvedValueOnce('  Updated summary text  ');

      const result = await new SelfReflectionEngine({
        ...deps,
        activitySectionLabel: '最近のツイート（古い順）',
      }).execute();

      expect(deps.store.getRecentActivities).toHaveBeenCalledWith(20);
      expect(deps.synthesizer.generateSummary).toHaveBeenCalledWith(
        '【過去の要約】\nPrevious summary\n\n【レベッカの最近のツイート（古い順）】\n[1] Checked AI papers (内心: Very promising)\n[2] Evening coffee break',
      );
      expect(deps.store.saveSummary).toHaveBeenCalledWith('Updated summary text');
      expect(result).toEqual({
        status: 'success',
        summary: 'Updated summary text',
        previousSummary: 'Previous summary',
        postsCount: 2,
      });
    });

    it('throws fail-fast error and refuses to overwrite Layer 2 summary when generated text is blank', async () => {
      const deps = createDeps();
      deps.store.getRecentActivities.mockResolvedValueOnce([{ text: 'Post 1' }]);
      deps.store.getSummary.mockResolvedValueOnce('Existing Layer 2 summary');
      deps.synthesizer.generateSummary.mockResolvedValueOnce('   ');

      await expect(
        new SelfReflectionEngine({ ...deps, logTag: '[SelfReflectionUseCase]' }).execute(),
      ).rejects.toThrow('[SelfReflectionUseCase] Generated timeline summary was empty.');

      expect(deps.store.saveSummary).not.toHaveBeenCalled();
      expect(deps.logger.error).toHaveBeenCalledWith(
        '[SelfReflectionUseCase] Timeline summary generation failed',
        expect.any(Error),
      );
    });

    it('rethrows upstream errors without corrupting existing summary', async () => {
      const deps = createDeps();
      deps.store.getRecentActivities.mockResolvedValueOnce([{ text: 'Post 1' }]);
      deps.store.getSummary.mockResolvedValueOnce('Existing Layer 2 summary');
      deps.synthesizer.generateSummary.mockRejectedValueOnce(new Error('429 Quota Exceeded'));

      await expect(new SelfReflectionEngine(deps).execute()).rejects.toThrow('429 Quota Exceeded');
      expect(deps.store.saveSummary).not.toHaveBeenCalled();
    });
  });
});
