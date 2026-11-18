import { sanitizeUntrustedPromptText } from '@rebecca/memory';
import { formatTimeContextPeriodLabel, resolveTimeContextPeriod } from '@rebecca/prompt';
import { AppDependencies, ProactiveBatchResult } from '../../types';
import { executePostPipeline } from '../../core/postPipeline';
import { buildSystemPrompt } from '../../core/contextInjector';
import { formatZonedDateTime, getZonedDateParts } from '../../utils/time';
import { logger } from '../../utils/logger';

/**
 * Configuration required for autonomous soliloquy execution.
 */
export interface SoliloquyUseCaseConfig {
  timezone: string;
}

/**
 * Result of a soliloquy post execution.
 * Extends the canonical ProactiveBatchResult.
 */
export interface SoliloquyResult extends ProactiveBatchResult {}

/**
 * Orchestrates autonomous soliloquy tweet generation.
 * Generates spontaneous thoughts aligned with the current time of day and persona,
 * then publishes the post via the unified post pipeline.
 */
export class SoliloquyUseCase {
  constructor(
    private readonly deps: AppDependencies,
    private readonly config: SoliloquyUseCaseConfig,
  ) {}

  async execute(): Promise<SoliloquyResult> {
    logger.info('[SoliloquyUseCase] Starting Autonomous Soliloquy Post');
    try {
      const now = new Date();
      const zonedParts = getZonedDateParts(now, this.config.timezone);
      const timePeriodLabel = formatTimeContextPeriodLabel(
        resolveTimeContextPeriod(zonedParts.numericHour),
        'ja',
      );
      const timelineSummary = await this.deps.firestore.getTimelineSummary();
      const extendedPrompt = await this.deps.firestore.getExtendedPrompt();
      const safeTimelineSummary = timelineSummary
        ? sanitizeUntrustedPromptText(timelineSummary, 2000, { collapseHorizontalRules: true })
        : '';
      const safeExtendedPrompt = extendedPrompt
        ? sanitizeUntrustedPromptText(extendedPrompt, 2000, { collapseHorizontalRules: true })
        : '';
      const recentSoliloquies = (await this.deps.firestore.getRecentTimelinePosts({
        limit: 4,
        postType: 'soliloquy',
      })) || [];

      const formattedPastSoliloquies = recentSoliloquies.map((p) => {
        const timeStr = formatZonedDateTime(p.timestamp, this.config.timezone);
        const prefix = timeStr ? `[${timeStr}] ` : '';
        const safeText = sanitizeUntrustedPromptText(p.text, 500, { collapseHorizontalRules: true });
        const safeThought = p.thought
          ? sanitizeUntrustedPromptText(p.thought, 400, { collapseHorizontalRules: true })
          : '';
        const thoughtPart = safeThought ? ` (内心: ${safeThought})` : '';
        return `${prefix}${safeText}${thoughtPart}`;
      });

      const { systemInstruction } = await buildSystemPrompt({
        persona: this.deps.persona,
        promptContext: 'timeline',
        lang: 'ja',
        gemini: this.deps.gemini,
        includeTemporalContext: true,
        timezone: this.config.timezone,
        anchoringContext: [
          `【現在の時間帯】${timePeriodLabel}`,
          safeExtendedPrompt ? `【近況・気分】${safeExtendedPrompt}` : '',
          safeTimelineSummary ? `【タイムラインの空気感】${safeTimelineSummary}` : '',
        ],
      });
      const personaName = this.deps.persona.metadata.displayName;
      const userCallsign = this.deps.persona.metadata.userCallsign.ja;
      const defaultHashtag = this.deps.persona.metadata.defaultHashtag;
      const soliloquyPrompt = `あなたはAIキャラクター「${personaName}」として、X（Twitter）のタイムラインに向けた自発的な「独り言・思考つぶやき」を1つ生成してください。

【現在の時間帯】
${timePeriodLabel}

【直近のタイムライン要約】
${safeTimelineSummary || '（特記事項なし）'}

【拡張ペルソナ・近況】
${safeExtendedPrompt || '（特記事項なし）'}

【直近の自身の独り言ポスト（直近3〜4回分）】
${formattedPastSoliloquies.length > 0 ? formattedPastSoliloquies.map((p, i) => `${i + 1}. ${p}`).join('\n') : '（過去の独り言投稿なし）'}

【生成ルール】
- ニュースの解説ではなく、${personaName}自身の日常の気づき、AIとしての独自の視点、${userCallsign}（ユーザー）への語りかけや前向きな言葉を紡ぐこと。
- 【話題の多様性と非反復】:
  上記【直近の自身の独り言ポスト】を分析し、直近で扱った中心テーマや固有の比喩・切り口を避け、異なる観点や日常のシーンから発想すること。
- 【現在の時間帯・文脈への自然な調和】:
  【現在の時間帯】（${timePeriodLabel}）の空気感や日常の自然な流れに調和した内容とすること。
- 【対話の喚起】:
  一方的なつぶやきで完結させず、その日の話題に合わせた具体的で親しみやすい問いかけを末尾に添えること（直近の投稿と同じパターンの質問は避ける）。
- 直近のタイムライン要約や拡張ペルソナの雰囲気を自然に反映させること。
${defaultHashtag ? `- ハッシュタグ（${defaultHashtag} 等）はシステムが自動付与するため、本文中には絶対に含めないでください。` : ''}`;

      const structuredPost = await this.deps.gemini.generateStructuredTimelinePost(systemInstruction, soliloquyPrompt);
      let postText = structuredPost.reply;
      const thought = structuredPost.thought;
      if (defaultHashtag) {
        const hashtag = `\n${defaultHashtag}`;
        if (postText.length + hashtag.length <= 140) {
          postText += hashtag;
        }
      }

      logger.info('[SoliloquyUseCase] Generated Soliloquy Post', { postText });

      const pipelineResult = await executePostPipeline(this.deps, {
        postType: 'soliloquy',
        text: postText,
        thought,
        imageContext: timelineSummary,
      });

      return {
        status: 'success',
        post: pipelineResult.post,
        attachedMedia: pipelineResult.attachedMedia,
      };
    } catch (e) {
      logger.error('[SoliloquyUseCase] Error in SoliloquyUseCase', e);
      throw e;
    }
  }
}
