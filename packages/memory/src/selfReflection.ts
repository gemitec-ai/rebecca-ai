import type {
  ISelfReflectionStore,
  ISelfReflectionSynthesizer,
  MemoryLogger,
  SelfReflectionActivityEntry,
  SelfReflectionConfig,
  SelfReflectionExecutionResult,
} from './types';

/** Default number of recent activity entries included in Layer 2 self-reflection. */
export const DEFAULT_SELF_REFLECTION_POST_LIMIT = 20;

/** Default Japanese heading describing recent persona activities in chronological order. */
export const DEFAULT_SELF_REFLECTION_ACTIVITY_LABEL = '最近の投稿（古い順）';

/**
 * Dependency bundle injected into {@link SelfReflectionEngine}.
 */
export interface SelfReflectionEngineDependencies {
  readonly store: ISelfReflectionStore;
  readonly synthesizer: ISelfReflectionSynthesizer;
  readonly personaDisplayName: string;
  /** Heading label describing recent activity items (e.g., `'最近のツイート（古い順）'`). */
  readonly activitySectionLabel?: string;
  readonly logger?: MemoryLogger;
  /** Optional log/error prefix override (defaults to `'[SelfReflectionEngine]'`). */
  readonly logTag?: string;
}

/**
 * Formats the Layer 2 self-reflection prompt combining the prior summary (for continuity)
 * with indexed recent persona activities and inner thoughts.
 *
 * @param params - Previous summary, persona display name, ordered activities, and optional label.
 * @returns Prompt sent to {@link ISelfReflectionSynthesizer.generateSummary}.
 */
export const buildSelfReflectionPrompt = (params: {
  readonly previousSummary: string;
  readonly personaDisplayName: string;
  readonly activities: ReadonlyArray<SelfReflectionActivityEntry>;
  readonly activitySectionLabel?: string;
}): string => {
  const {
    previousSummary,
    personaDisplayName,
    activities,
    activitySectionLabel = DEFAULT_SELF_REFLECTION_ACTIVITY_LABEL,
  } = params;

  const formattedPosts = activities.map((post, index) => {
    const thoughtSuffix = post.thought ? ` (内心: ${post.thought})` : '';
    return `[${index + 1}] ${post.text}${thoughtSuffix}`;
  });

  return `【過去の要約】
${previousSummary ? previousSummary : '（まだ要約なし）'}

【${personaDisplayName}の${activitySectionLabel}】
${formattedPosts.join('\n')}`;
};

/**
 * Core Layer 2 cognitive engine that summarizes recent autonomous persona activity into
 * `system/persona.timeline_summary`. Enforces fail-fast semantics so blank or failed LLM
 * responses never overwrite existing Layer 2 long-term memory.
 */
export class SelfReflectionEngine {
  private readonly postLimit: number;
  private readonly activitySectionLabel: string;
  private readonly logTag: string;

  constructor(
    private readonly deps: SelfReflectionEngineDependencies,
    config?: SelfReflectionConfig,
  ) {
    this.postLimit = config?.postLimit ?? DEFAULT_SELF_REFLECTION_POST_LIMIT;
    this.activitySectionLabel =
      deps.activitySectionLabel ?? DEFAULT_SELF_REFLECTION_ACTIVITY_LABEL;
    this.logTag = deps.logTag ?? '[SelfReflectionEngine]';
  }

  /**
   * Executes one Layer 2 timeline/activity self-reflection summarization pass.
   *
   * @returns Summary result detailing `skipped` or `success` state and activity count.
   * @throws Error if summarization yields empty text or upstream dependencies throw.
   */
  async execute(): Promise<SelfReflectionExecutionResult> {
    this.deps.logger?.info(`${this.logTag} Starting timeline self-reflection`);

    const recentActivities = await this.deps.store.getRecentActivities(this.postLimit);
    if (!recentActivities || recentActivities.length === 0) {
      this.deps.logger?.info(`${this.logTag} No recent timeline posts found. Skipping summarization`);
      return { status: 'skipped', reason: 'no_recent_timeline_posts', postsCount: 0 };
    }

    const previousSummary = await this.deps.store.getSummary();
    const prompt = buildSelfReflectionPrompt({
      previousSummary,
      personaDisplayName: this.deps.personaDisplayName,
      activities: recentActivities,
      activitySectionLabel: this.activitySectionLabel,
    });

    try {
      const rawSummary = await this.deps.synthesizer.generateSummary(prompt);
      const trimmedSummary = rawSummary ? rawSummary.trim() : '';

      if (trimmedSummary.length === 0) {
        throw new Error(`${this.logTag} Generated timeline summary was empty.`);
      }

      await this.deps.store.saveSummary(trimmedSummary);
      this.deps.logger?.info(`${this.logTag} Timeline summary successfully updated`);

      return {
        status: 'success',
        summary: trimmedSummary,
        previousSummary,
        postsCount: recentActivities.length,
      };
    } catch (error: unknown) {
      this.deps.logger?.error(`${this.logTag} Timeline summary generation failed`, error);
      throw error;
    }
  }
}
