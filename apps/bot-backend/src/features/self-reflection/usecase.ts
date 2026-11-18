import { SelfReflectionEngine } from '@rebecca/memory';
import { AppDependencies } from '../../types';
import { SelfReflectionResult } from './types';
import { logger } from '../../utils/logger';

/**
 * Configuration options for the SelfReflectionUseCase.
 */
export interface SelfReflectionConfig {
  postLimit?: number;
}

/**
 * Orchestrates the persona's self-reflection batch process (Layer 2).
 * Delegates activity summarization and fail-fast guards to `@rebecca/memory`'s
 * {@link SelfReflectionEngine} backed by X timeline Firestore and Gemini adapters.
 */
export class SelfReflectionUseCase {
  private readonly engine: SelfReflectionEngine;

  /**
   * Initializes a new instance of SelfReflectionUseCase.
   *
   * @param deps - Application dependencies providing access to Firestore, Gemini, and Persona services.
   * @param config - Optional configuration specifying the number of recent posts to summarize.
   */
  constructor(
    deps: AppDependencies,
    config?: SelfReflectionConfig,
  ) {
    this.engine = new SelfReflectionEngine(
      {
        store: {
          getRecentActivities: (limit) => deps.firestore.getRecentTimelinePosts({ limit }),
          getSummary: () => deps.firestore.getTimelineSummary(),
          saveSummary: (summary) => deps.firestore.saveTimelineSummary(summary),
        },
        synthesizer: {
          generateSummary: ({ prompt, systemInstruction }) =>
            deps.gemini.generateTimelineSummary(prompt, systemInstruction),
        },
        personaDisplayName: deps.persona.metadata.displayName,
        activitySectionLabel: '最近のツイート（古い順）',
        logger,
        logTag: '[SelfReflectionUseCase]',
      },
      config,
    );
  }

  /**
   * Executes timeline summarization.
   *
   * @returns A promise resolving to a SelfReflectionResult detailing execution status.
   * @throws Error if Gemini API fails or returns invalid/empty content, preventing data corruption.
   */
  async execute(): Promise<SelfReflectionResult> {
    return this.engine.execute();
  }
}
