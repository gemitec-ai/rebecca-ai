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
 * Canonical Layer 2 long-term memory summarization system instruction shared across host services.
 */
export const DEFAULT_SELF_REFLECTION_SYSTEM_INSTRUCTION =
  'あなたはAIキャラクターの長期記憶管理システムです。与えられたキャラクター自身の投稿履歴と過去の要約を元に、最近どのようなニュース、技術、社会トレンドや日常のトピックについて言及していたかを客観的に400文字以内で要約してください。言及されたトピックの内容や関心の推移を中心に記述し、語尾や過剰な感情表現の模倣ではなく、対話や思考の知的背景となる文脈を自然な日本語の文章で整理してください（箇条書きや記号は使用しないでください）。';

/**
 * Dependency bundle injected into {@link SelfReflectionEngine}.
 */
export interface SelfReflectionEngineDependencies {
  readonly store: ISelfReflectionStore;
  readonly synthesizer: ISelfReflectionSynthesizer;
  readonly personaDisplayName: string;
  /** Optional override for Layer 2 summarization system instruction. */
  readonly systemInstruction?: string;
  /** Heading label describing recent activity items. */
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
 * @returns Prompt sent alongside the system instruction to {@link ISelfReflectionSynthesizer.generateSummary}.
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

  const formattedEntries = activities.map((entry, index) => {
    const thoughtSuffix = entry.thought ? ` (内心: ${entry.thought})` : '';
    return `[${index + 1}] ${entry.text}${thoughtSuffix}`;
  });

  return `【過去の要約】
${previousSummary ? previousSummary : '（まだ要約なし）'}

【${personaDisplayName}の${activitySectionLabel}】
${formattedEntries.join('\n')}`;
};

/**
 * Core Layer 2 cognitive engine that summarizes recent autonomous persona activity into
 * global summary memory. Enforces fail-fast semantics so blank or failed synthesis
 * responses never overwrite existing Layer 2 long-term state.
 */
export class SelfReflectionEngine {
  private readonly postLimit: number;
  private readonly activitySectionLabel: string;
  private readonly systemInstruction: string;
  private readonly logTag: string;

  /**
   * @param deps - Store, synthesizer, persona display name, and optional logger/overrides.
   * @param config - Optional self-reflection post limit configuration.
   * @throws Error if `config.postLimit` is zero, negative, or non-finite.
   */
  constructor(
    private readonly deps: SelfReflectionEngineDependencies,
    config?: SelfReflectionConfig,
  ) {
    const rawLimit = config?.postLimit ?? DEFAULT_SELF_REFLECTION_POST_LIMIT;
    const normalizedLimit = Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 0;
    const logTag = deps.logTag ?? '[SelfReflectionEngine]';
    if (normalizedLimit <= 0) {
      throw new Error(`${logTag} postLimit must be a positive integer.`);
    }
    this.postLimit = normalizedLimit;
    this.activitySectionLabel =
      deps.activitySectionLabel ?? DEFAULT_SELF_REFLECTION_ACTIVITY_LABEL;
    this.systemInstruction =
      deps.systemInstruction ?? DEFAULT_SELF_REFLECTION_SYSTEM_INSTRUCTION;
    this.logTag = logTag;
  }

  /**
   * Executes one Layer 2 activity self-reflection summarization pass.
   *
   * @returns Summary result detailing `skipped` or `success` state and processed item count.
   * @throws Error if summarization yields empty text or upstream dependencies throw.
   */
  async execute(): Promise<SelfReflectionExecutionResult> {
    this.deps.logger?.info(`${this.logTag} Starting activity self-reflection`);

    const recentActivities = await this.deps.store.getRecentActivities(this.postLimit);
    if (!recentActivities || recentActivities.length === 0) {
      this.deps.logger?.info(`${this.logTag} No recent activities found. Skipping summarization`);
      return { status: 'skipped', reason: 'no_recent_activities', postsCount: 0 };
    }

    const previousSummary = await this.deps.store.getSummary();
    const prompt = buildSelfReflectionPrompt({
      previousSummary,
      personaDisplayName: this.deps.personaDisplayName,
      activities: recentActivities,
      activitySectionLabel: this.activitySectionLabel,
    });

    try {
      const rawSummary = await this.deps.synthesizer.generateSummary({
        systemInstruction: this.systemInstruction,
        prompt,
      });
      const trimmedSummary = rawSummary ? rawSummary.trim() : '';

      if (trimmedSummary.length === 0) {
        throw new Error(`${this.logTag} Generated summary was empty.`);
      }

      await this.deps.store.saveSummary(trimmedSummary);
      this.deps.logger?.info(`${this.logTag} Activity summary successfully updated`);

      return {
        status: 'success',
        summary: trimmedSummary,
        previousSummary,
        postsCount: recentActivities.length,
      };
    } catch (error: unknown) {
      this.deps.logger?.error(`${this.logTag} Activity summary generation failed`, error);
      throw error;
    }
  }
}
