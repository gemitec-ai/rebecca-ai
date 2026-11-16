import { DreamingConsolidationEngine } from '@rebecca/memory';
import { AppDependencies, FirestoreUser } from '../../types';
import { DreamingConfig, DreamingExecutionResult } from './types';
import { logger } from '../../utils/logger';

/**
 * Orchestrates the public X Bot user memory consolidation (Dreaming) process.
 *
 * Delegates episodic-to-CoreProfile assimilation to `@rebecca/memory`'s
 * {@link DreamingConsolidationEngine}, binding Firestore user storage and Gemini synthesis.
 */
export class GlobalDreamingUseCase {
  private readonly engine: DreamingConsolidationEngine<FirestoreUser>;

  /**
   * Initializes a new instance of GlobalDreamingUseCase.
   *
   * @param deps - Application dependencies for Firestore, Gemini, and Persona.
   * @param config - Optional configuration for rate-limiting throttle duration.
   */
  constructor(
    deps: AppDependencies,
    config?: DreamingConfig,
  ) {
    this.engine = new DreamingConsolidationEngine<FirestoreUser>(
      {
        store: {
          listConsolidationCandidates: () => deps.firestore.getAllUsers(),
          updateCoreProfile: (userId, profile, retainedBuffer, lastDreamedAt) =>
            deps.firestore.updateCoreProfile(userId, profile, retainedBuffer, lastDreamedAt),
        },
        synthesizer: deps.gemini,
        dreamingPrompt: () => deps.persona.getDreamingPrompt(),
        logger,
        logTag: '[GlobalDreamingUseCase]',
      },
      config,
    );
  }

  /**
   * Executes the dreaming process across users with pending, unconsolidated episodic buffers.
   *
   * @returns A promise resolving to DreamingExecutionResult detailing the execution metrics.
   */
  async execute(): Promise<DreamingExecutionResult> {
    return this.engine.execute();
  }

  /**
   * Consolidates episodic conversation turns into `coreProfile` for a single user.
   *
   * @param userId - Target user identifier.
   * @param userData - User record containing `episodicBuffer` and existing `coreProfile`.
   * @returns True if dreaming succeeded and was saved, false otherwise.
   */
  async consolidateUser(userId: string, userData: FirestoreUser): Promise<boolean> {
    return this.engine.consolidateUser(userId, userData);
  }
}