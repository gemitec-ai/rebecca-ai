import type {
  DreamingConfig,
  DreamingExecutionResult,
  IDreamingMemoryStore,
  IDreamingSynthesizer,
  MemoryLogger,
  MemoryUserSnapshot,
} from './types';

/** Default inter-user throttle delay in milliseconds (guards 15 RPM LLM quotas). */
export const DEFAULT_DREAMING_THROTTLE_MS = 4500;

/** Default number of episodic entries retained as sliding window after consolidation. */
export const DEFAULT_DREAMING_RETAINED_ENTRIES = 20;

const NOOP_LOGGER: MemoryLogger = {
  info: () => {},
  error: () => {},
};

/**
 * Determines whether a user has pending conversational activity requiring memory consolidation.
 * Uses epoch millisecond comparison to guard against ISO-8601 formatting or timezone offset differences.
 *
 * @param user - User memory snapshot to evaluate.
 * @returns `true` if episodic entries exist and occurred after the last completed dreaming cycle.
 */
export const hasUnconsolidatedActivity = (user: MemoryUserSnapshot): boolean => {
  if (!Array.isArray(user.episodicBuffer) || user.episodicBuffer.length === 0) {
    return false;
  }

  if (!user.lastDreamedAt) {
    return true;
  }

  const lastSeenMs = user.lastSeen ? new Date(user.lastSeen).getTime() : 0;
  const lastDreamedMs = new Date(user.lastDreamedAt).getTime();

  return Number.isFinite(lastSeenMs) && Number.isFinite(lastDreamedMs) && lastSeenMs > lastDreamedMs;
};

/**
 * Storage-agnostic dependencies required by {@link DreamingConsolidationEngine}.
 */
export interface DreamingEngineDeps<TUser extends MemoryUserSnapshot = MemoryUserSnapshot> {
  readonly store: IDreamingMemoryStore<TUser>;
  readonly synthesizer: IDreamingSynthesizer;
  /** Persona-supplied synthesis instruction string or lazy resolver callback. */
  readonly dreamingPrompt: string | (() => string);
  readonly logger?: MemoryLogger;
  readonly logTag?: string;
}

/**
 * Cognitive memory consolidation (Dreaming) engine for periodic per-user memory synthesis.
 *
 * Assimilates unconsolidated episodic buffers into durable `coreProfile` traits
 * while preserving a bounded sliding window and applying configurable inter-user throttling.
 */
export class DreamingConsolidationEngine<TUser extends MemoryUserSnapshot = MemoryUserSnapshot> {
  private readonly throttleMs: number;
  private readonly retainedBufferEntries: number;
  private readonly logger: MemoryLogger;
  private readonly logTag: string;

  /**
   * Initializes the dreaming consolidation engine.
   *
   * @param deps - Store, synthesizer, persona, and optional structured logger.
   * @param config - Optional throttling and retention window configuration.
   */
  constructor(
    private readonly deps: DreamingEngineDeps<TUser>,
    config?: DreamingConfig,
  ) {
    const rawThrottle = config?.throttleMs ?? DEFAULT_DREAMING_THROTTLE_MS;
    this.throttleMs = Number.isFinite(rawThrottle)
      ? Math.max(0, Math.trunc(rawThrottle))
      : DEFAULT_DREAMING_THROTTLE_MS;
    const rawRetained = config?.retainedBufferEntries ?? DEFAULT_DREAMING_RETAINED_ENTRIES;
    this.retainedBufferEntries = Number.isFinite(rawRetained)
      ? Math.max(0, Math.trunc(rawRetained))
      : 0;
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.logTag = deps.logTag ?? '[DreamingConsolidationEngine]';
  }

  /**
   * Executes batch memory consolidation across all candidates with unconsolidated episodic activity.
   * Failures for an individual user are isolated and reported in `status` / `failed` counts.
   *
   * @returns Summary metrics describing total, processed, succeeded, failed, and skipped users.
   */
  async execute(): Promise<DreamingExecutionResult> {
    this.logger.info(`${this.logTag} Starting user memory consolidation (dreaming)`);
    const users = await this.deps.store.listConsolidationCandidates();
    const targetUsers = users.filter((user) => hasUnconsolidatedActivity(user));

    if (targetUsers.length === 0) {
      this.logger.info(`${this.logTag} No users with pending episodic buffers found. Skipping`);
      return {
        status: 'skipped',
        reason: 'no_users_with_episodic_buffer',
        totalUsers: users.length,
        processedUsers: 0,
        succeeded: 0,
        failed: 0,
        skipped: users.length,
      };
    }

    this.logger.info(`${this.logTag} Found users with unconsolidated episodic buffers`, {
      count: targetUsers.length,
    });

    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < targetUsers.length; i++) {
      const user = targetUsers[i];
      if (!user.id) {
        this.logger.error(`${this.logTag} Dreaming skipped user without id`, new Error('Missing user.id'), {});
        failed++;
      } else {
        const success = await this.consolidateUser(user.id, user);
        if (success) {
          succeeded++;
        } else {
          failed++;
        }
      }

      if (i < targetUsers.length - 1 && this.throttleMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.throttleMs));
      }
    }

    const status: DreamingExecutionResult['status'] =
      failed === 0 ? 'success' : succeeded > 0 ? 'partial_success' : 'failed';

    this.logger.info(`${this.logTag} Completed dreaming batch`, {
      succeeded,
      failed,
      total: targetUsers.length,
    });

    return {
      status,
      totalUsers: users.length,
      processedUsers: targetUsers.length,
      succeeded,
      failed,
      skipped: users.length - targetUsers.length,
    };
  }

  /**
   * Consolidates episodic conversation turns into long-term `coreProfile` for a single user.
   *
   * @param userId - Canonical identifier of the user record.
   * @param userData - User snapshot containing `episodicBuffer` and existing `coreProfile`.
   * @returns `true` if consolidation succeeded and was persisted, `false` when skipped or failed.
   */
  async consolidateUser(userId: string, userData: TUser): Promise<boolean> {
    const { episodicBuffer, coreProfile } = userData;
    if (!episodicBuffer || episodicBuffer.length === 0) {
      return false;
    }

    const systemPrompt =
      typeof this.deps.dreamingPrompt === 'function'
        ? this.deps.dreamingPrompt()
        : this.deps.dreamingPrompt;
    try {
      const mutableBuffer = [...episodicBuffer];
      const existingProfile = coreProfile ?? {};
      const newCoreProfile = await this.deps.synthesizer.generateDreaming(
        systemPrompt,
        mutableBuffer,
        existingProfile,
      );
      const retainedBuffer =
        this.retainedBufferEntries > 0 ? mutableBuffer.slice(-this.retainedBufferEntries) : [];
      const dreamedAt = new Date().toISOString();
      await this.deps.store.updateCoreProfile(userId, newCoreProfile, retainedBuffer, dreamedAt);
      this.logger.info(`${this.logTag} Successfully consolidated memory for user`, { userId });
      return true;
    } catch (error) {
      this.logger.error(`${this.logTag} Dreaming failed for user`, error, { userId });
      return false;
    }
  }
}
