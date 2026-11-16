import { GlobalEvolutionEngine, GlobalEvolutionResult } from '@rebecca/memory';
import { AppDependencies } from '../../types';
import { logger } from '../../utils/logger';

/**
 * Configuration required for global evolution batch execution.
 */
export interface EvolutionUseCaseConfig {
  lookbackDays: number;
}

/**
 * Represents the result of a global evolution execution.
 */
export type EvolutionResult = GlobalEvolutionResult;

/**
 * Use case responsible for orchestrating the global evolution batch process (Layer 1).
 * Delegates synthesis, safety audit, and persistence orchestration to `@rebecca/memory`'s
 * {@link GlobalEvolutionEngine} backed by X bot Firestore and Gemini adapters.
 */
export class GlobalEvolutionUseCase {
  private readonly engine: GlobalEvolutionEngine;

  /**
   * Initializes a new instance of the GlobalEvolutionUseCase.
   *
   * @param deps - The application dependencies required to execute the evolution process.
   * @param config - Configuration options for evolution lookback window.
   */
  constructor(
    deps: AppDependencies,
    config: EvolutionUseCaseConfig,
  ) {
    this.engine = new GlobalEvolutionEngine(
      {
        store: {
          getRecentConversationLogs: (lookbackDays) =>
            deps.firestore.getRecentConversationLogs(lookbackDays),
          saveExtendedPrompt: (prompt) => deps.firestore.saveExtendedPrompt(prompt),
        },
        synthesizer: {
          generateEvolutionPrompt: (prompt) => deps.gemini.generateEvolutionPrompt(prompt),
          auditEvolutionPrompt: (candidatePrompt, auditInstruction) =>
            deps.gemini.auditEvolutionPrompt(candidatePrompt, auditInstruction),
        },
        persona: deps.persona.metadata,
        logger: {
          info: (msg, meta) => logger.info(msg, meta),
          warn: (msg, meta) => logger.warn(msg, meta),
          error: (_msg, err) =>
            logger.error('[GlobalEvolutionUseCase] Error in runGlobalEvolutionBatch', err),
        },
        logTag: '[GlobalEvolutionUseCase]',
      },
      config,
    );
  }

  /**
   * Executes the global evolution batch process.
   *
   * @returns A promise that resolves to an `EvolutionResult` indicating the final status.
   * @throws Error if underlying storage or upstream generation operations fail unexpectedly.
   */
  async execute(): Promise<EvolutionResult> {
    return this.engine.execute();
  }
}
