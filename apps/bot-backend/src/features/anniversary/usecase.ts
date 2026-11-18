import { sanitizeUntrustedPromptText } from '@rebecca/memory';
import { AppDependencies } from '../../types';
import { executePostPipeline } from '../../core/postPipeline';
import { buildSystemPrompt } from '../../core/contextInjector';
import { IAnniversaryProvider, AnniversaryItem, AnniversaryResult } from './types';
import { logger } from '../../utils/logger';

export * from './types';

/**
 * Executes a batch job to proactively post about today's memorial days / anniversaries ("◯◯の日").
 *
 * It queries an IAnniversaryProvider for the current date in the application timezone,
 * generates a persona-grounded post, and publishes it via PostPipeline.
 * If no valid anniversaries are retrieved, it returns a skipped status.
 */
export class ProactiveAnniversaryUseCase {
  /**
   * Initializes the ProactiveAnniversaryUseCase.
   *
   * @param deps Application dependencies.
   * @param anniversaryProvider Provider satisfying the IAnniversaryProvider contract.
   */
  constructor(
    private readonly deps: AppDependencies,
    private readonly anniversaryProvider: IAnniversaryProvider,
  ) {}

  /**
   * Executes the proactive anniversary post process.
   *
   * @returns A promise resolving to an AnniversaryResult object.
   */
  async execute(): Promise<AnniversaryResult> {
    logger.info('[ProactiveAnniversaryUseCase] Starting Proactive Anniversary Post Batch');
    try {
      const now = new Date();
      const anniversaries: AnniversaryItem[] = await this.anniversaryProvider.getAnniversaries(now);

      if (!anniversaries || anniversaries.length === 0) {
        logger.info('[ProactiveAnniversaryUseCase] No anniversaries found for today');
        return { status: 'skipped', reason: 'no_anniversaries' };
      }

      logger.info('[ProactiveAnniversaryUseCase] Retrieved anniversary candidates', {
        count: anniversaries.length,
        candidates: anniversaries.map((a) => `${a.name}: ${a.description}`),
      });

      const timelineSummary = await this.deps.firestore.getTimelineSummary();
      const extendedPrompt = await this.deps.firestore.getExtendedPrompt();
      const safeTimelineSummary = timelineSummary
        ? sanitizeUntrustedPromptText(timelineSummary, 2000, { collapseHorizontalRules: true })
        : '';
      const safeExtendedPrompt = extendedPrompt
        ? sanitizeUntrustedPromptText(extendedPrompt, 2000, { collapseHorizontalRules: true })
        : '';

      const candidateListText = anniversaries
        .slice(0, 8)
        .map((a) => {
          const safeName = sanitizeUntrustedPromptText(a.name, 120, { collapseHorizontalRules: true });
          const safeDesc = a.description
            ? sanitizeUntrustedPromptText(a.description, 400, { collapseHorizontalRules: true })
            : '';
          return `・${safeName}${safeDesc ? ` (${safeDesc})` : ''}`;
        })
        .join('\n');

      const { systemInstruction } = await buildSystemPrompt({
        persona: this.deps.persona,
        promptContext: 'timeline',
        lang: 'ja',
        gemini: this.deps.gemini,
        anchoringContext: [
          `【今日の記念日候補】\n${candidateListText}`,
          safeExtendedPrompt ? `【近況・気分】${safeExtendedPrompt}` : '',
          safeTimelineSummary ? `【タイムラインの空気感】${safeTimelineSummary}` : '',
        ],
      });
      const personaName = this.deps.persona.metadata.displayName;
      const defaultHashtag = this.deps.persona.metadata.defaultHashtag;
      const anniversaryPrompt = `以下の【今日の記念日・年中行事】の一覧から、AIキャラクター「${personaName}」として共感・盛り上がりそうな話題（カルチャー、食、日常、音楽、記念日など）を【1つだけ】選び、それに言及しながらタイムライン向けの自発的ツイートを生成してください。

【今日の記念日・年中行事】
${candidateListText}
${safeTimelineSummary ? `\n【直近のタイムライン要約】\n${safeTimelineSummary}\n` : ''}
${safeExtendedPrompt ? `\n【拡張ペルソナ・近況】\n${safeExtendedPrompt}\n` : ''}

【追加ルール】
- 戦争・紛争・追悼や過度に暗い記念日は絶対に選ばないこと。日常的で明るい話題や親しみやすい記念日を選んでください。
- 単なる解説や豆知識の紹介で終わらせず、その記念日や話題を読み手の日常・身近な行動に関連付けること。
- 読み手が自分の予定や体験を一言リプライしたくなるような、具体的で答えやすい問いかけを末尾に必ず含めること。
- 特定の個人への返信ではなく、タイムライン全体のフォロワーに向けたオープンな語りかけとすること。
- 「今日は◯◯の日なんだって！」「◯◯の日だし〜」のように、選んだ記念日名を自然に会話に盛り込んでください。
${defaultHashtag ? `- ハッシュタグ（${defaultHashtag} 等）はシステムが自動付与するため、本文中には絶対に含めないでください。` : ''}`;

      const structuredPost = await this.deps.gemini.generateStructuredTimelinePost(systemInstruction, anniversaryPrompt);
      let postText = structuredPost.reply;
      const thought = structuredPost.thought;

      if (defaultHashtag) {
        const hashtag = `\n${defaultHashtag}`;
        if (postText.length + hashtag.length <= 140) {
          postText += hashtag;
        }
      }

      logger.info('[ProactiveAnniversaryUseCase] Generated Post', { postText });

      // Identify which anniversary name was referenced
      const matchedItem = anniversaries.find((a) => postText.includes(a.name));
      const anniversaryTitle = matchedItem ? matchedItem.name : undefined;

      const matchedSafeName = matchedItem
        ? sanitizeUntrustedPromptText(matchedItem.name, 120, { collapseHorizontalRules: true })
        : '';
      const matchedSafeDesc = matchedItem?.description
        ? sanitizeUntrustedPromptText(matchedItem.description, 400, { collapseHorizontalRules: true })
        : '';

      const pipelineResult = await executePostPipeline(this.deps, {
        postType: 'anniversary',
        text: postText,
        thought,
        imageContext: matchedItem
          ? `記念日: ${matchedSafeName}\n内容: ${matchedSafeDesc}\nタイムライン状況: ${safeTimelineSummary}`
          : `タイムライン状況: ${safeTimelineSummary}`,
        metadata: {
          anniversaryTitle,
        },
      });

      return {
        status: 'success',
        post: pipelineResult.post,
        attachedMedia: pipelineResult.attachedMedia,
        ...(anniversaryTitle ? { anniversaryTitle } : {}),
      };
    } catch (error) {
      logger.error('[ProactiveAnniversaryUseCase] Unexpected error during execution', error);
      throw error;
    }
  }
}
