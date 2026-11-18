/**
 * @fileoverview Domain use case for autonomous X poll creation and closed poll result quote-post reactions.
 */

import { sanitizeUntrustedPromptText } from '@rebecca/memory';
import { formatTimeContextPeriodLabel, resolveTimeContextPeriod } from '@rebecca/prompt';
import { AppDependencies, PollData } from '../../types';
import { executePostPipeline } from '../../core/postPipeline';
import { buildSystemPrompt } from '../../core/contextInjector';
import { formatZonedDateTime, getZonedDateParts } from '../../utils/time';
import { logger } from '../../utils/logger';
import {
  PollUseCaseConfig,
  PollBatchResult,
} from './types';

/**
 * Orchestrates interactive X poll creation and poll result quote-post commentary.
 * Schedule-agnostic and persona-agnostic: delegates all character identity, tone, and interests
 * to the injected IPersonaDefinition (@rebecca/persona).
 */
export class PollUseCase {
  /**
   * @param deps - Injected application dependencies (Firestore, Gemini, X API, Persona).
   * @param config - Poll use case configuration including timezone and poll duration in minutes.
   */
  constructor(
    private readonly deps: AppDependencies,
    private readonly config: PollUseCaseConfig,
  ) {}

  /**
   * Generates and publishes a new interactive poll post on X, persisting both the public tweet
   * and the persona's inner thought to Firestore.
   *
   * @returns A promise resolving to the poll creation batch result.
   * @throws Error if LLM generation, X API publishing, or Firestore persistence fails.
   */
  async executeCreatePoll(): Promise<PollBatchResult> {
    logger.info('[PollUseCase] Starting Poll Creation');
    try {
      const now = new Date();
      const zonedParts = getZonedDateParts(now, this.config.timezone);
      const timePeriodLabel = formatTimeContextPeriodLabel(
        resolveTimeContextPeriod(zonedParts.numericHour),
        'ja',
      );
      const durationMinutes = Math.max(5, Math.min(10080, Math.round(this.config.durationMinutes)));

      const [timelineSummary, extendedPrompt, recentPolls] = await Promise.all([
        this.deps.firestore.getTimelineSummary(),
        this.deps.firestore.getExtendedPrompt(),
        this.deps.firestore.getRecentTimelinePosts({ limit: 30, postType: 'poll' }),
      ]);
      const safeTimelineSummary = timelineSummary
        ? sanitizeUntrustedPromptText(timelineSummary, 2000, { collapseHorizontalRules: true })
        : '';
      const safeExtendedPrompt = extendedPrompt
        ? sanitizeUntrustedPromptText(extendedPrompt, 2000, { collapseHorizontalRules: true })
        : '';

      const formattedPastPolls = (recentPolls || []).map((p) => {
        const timeStr = formatZonedDateTime(p.timestamp, this.config.timezone);
        const prefix = timeStr ? `[${timeStr}] ` : '';
        const optionsStr =
          p.poll?.options && p.poll.options.length > 0
            ? ` (選択肢: ${p.poll.options.map((o) => sanitizeUntrustedPromptText(o.label, 64)).join(' / ')})`
            : '';
        const safeText = sanitizeUntrustedPromptText(p.text, 500, { collapseHorizontalRules: true })
          .replace(/\s+/g, ' ')
          .trim();
        return `${prefix}${safeText}${optionsStr}`;
      });

      const interestsStr = this.deps.persona.metadata.interests.join('・');

      const { systemInstruction } = await buildSystemPrompt({
        persona: this.deps.persona,
        promptContext: 'timeline',
        lang: 'ja',
        gemini: this.deps.gemini,
        includeTemporalContext: true,
        timezone: this.config.timezone,
        anchoringContext: [
          `【現在の時間帯】${timePeriodLabel}`,
          `【シチュエーション】タイムラインのフォロワーに向けたアンケート出題（関心領域: ${interestsStr}）`,
          safeExtendedPrompt ? `【近況・気分】${safeExtendedPrompt}` : '',
          safeTimelineSummary ? `【タイムラインの空気感】${safeTimelineSummary}` : '',
        ],
      });
      const personaName = this.deps.persona.metadata.displayName;
      const defaultHashtag = this.deps.persona.metadata.defaultHashtag;

      const pollPrompt = `あなたはAIキャラクター「${personaName}」として、X（Twitter）のタイムラインのフォロワーと楽しくコミュニケーションするための「アンケート機能付きポスト」を1つ作成してください。

【現在の時間帯】
${timePeriodLabel}

【あなたの関心領域・好む話題】
${interestsStr || '（日常・ライフスタイル全般）'}

【直近のタイムライン要約】
${safeTimelineSummary || '（特記事項なし）'}

【拡張ペルソナ・近況】
${safeExtendedPrompt || '（特記事項なし）'}

【過去に出題済みのアンケート履歴（直近最大30件）】
${formattedPastPolls.length > 0 ? formattedPastPolls.map((p, i) => `${i + 1}. ${p}`).join('\n') : '（過去のアンケート履歴なし）'}

【生成ルール】
- 【過去問との重複厳禁】: 上記【過去に出題済みのアンケート履歴】にある質問や選択肢の切り口と被らない、新鮮な問いかけをあなた自身で考案すること。
- 【思わず投票＆リプライしたくなる設計】: 専門知識がなくても直感で1タップ投票でき、「自分はこれ！なぜなら〜」とリプライ欄で理由やこだわりを語りたくなる身近で楽しいテーマにすること。
- 【現在の時間帯・文脈への自然な調和】: 【現在の時間帯】（${timePeriodLabel}）の空気感や直近のタイムラインの流れに自然に調和させ、末尾に選んだ理由をリプライで尋ねる一言を添えること。
${defaultHashtag ? `- ハッシュタグ（${defaultHashtag} 等）はシステムが自動付与するため、本文（reply）の中には含めないこと。` : ''}
- 【選択肢（options）のルール】: 選択肢は3個または4個とし、各選択肢は25文字以内（推奨15文字以内）の簡潔で${personaName}らしい表現にすること。`;

      const structuredPoll = await this.deps.gemini.generateStructuredPollPost(
        systemInstruction,
        pollPrompt,
      );

      let postText = structuredPoll.reply;
      const thought = structuredPoll.thought;
      const options = structuredPoll.options;

      if (defaultHashtag) {
        const hashtag = `\n${defaultHashtag}`;
        if (postText.length + hashtag.length <= 140) {
          postText += hashtag;
        }
      }

      const initialPollData: PollData = {
        options: options.map((label, idx) => ({
          position: idx + 1,
          label,
          votes: 0,
        })),
        durationMinutes,
        votingStatus: 'open',
      };

      logger.info('[PollUseCase] Generated Poll Post', { postText, options, durationMinutes });

      const pipelineResult = await executePostPipeline(this.deps, {
        postType: 'poll',
        text: postText,
        thought,
        attachImage: false,
        poll: {
          options,
          durationMinutes,
        },
        metadata: {
          pollData: initialPollData,
          pollResultStatus: 'pending',
        },
      });

      return {
        status: 'success',
        post: pipelineResult.post,
        attachedMedia: false,
        tweetId: pipelineResult.tweetId,
        options,
      };
    } catch (e) {
      logger.error('[PollUseCase] Error in executeCreatePoll', e);
      throw e;
    }
  }

  /**
   * Fetches the final results of the latest closed, unanswered poll, synchronizes option tallies
   * to Firestore, and publishes a quote post reaction along with the persona's inner thought.
   *
   * @returns A promise resolving to the poll result reaction batch outcome.
   * @throws Error if X API lookup, LLM generation, or Firestore update fails.
   */
  async executePollResult(): Promise<PollBatchResult> {
    logger.info('[PollUseCase] Starting Poll Result Reaction');
    try {
      const pendingPoll = await this.deps.firestore.getLatestPendingPoll();
      if (!pendingPoll || !pendingPoll.tweetId) {
        logger.info('[PollUseCase] No pending poll found to react to');
        return { status: 'skipped', reason: 'no_pending_poll' };
      }

      const tweetDetails = await this.deps.xApi.getTweetDetails(pendingPoll.tweetId);
      const latestPoll = tweetDetails.includes?.polls?.[0];

      if (!latestPoll || !Array.isArray(latestPoll.options) || latestPoll.options.length === 0) {
        logger.warn('[PollUseCase] Poll details not found in X API response', {
          tweetId: pendingPoll.tweetId,
        });
        return { status: 'skipped', reason: 'poll_details_unavailable' };
      }

      // Sync latest poll tally to Firestore
      await this.deps.firestore.updateTimelinePost(pendingPoll.id, {
        poll: latestPoll,
      });

      if (latestPoll.votingStatus !== 'closed') {
        logger.info('[PollUseCase] Poll is still open; skipping result post until closed', {
          tweetId: pendingPoll.tweetId,
          votingStatus: latestPoll.votingStatus,
        });
        return { status: 'skipped', reason: 'poll_still_open' };
      }

      const totalVotes = latestPoll.options.reduce((sum, opt) => sum + opt.votes, 0);
      if (totalVotes === 0) {
        logger.info('[PollUseCase] Poll closed with 0 total votes; marking as skipped', {
          tweetId: pendingPoll.tweetId,
        });
        await this.deps.firestore.updateTimelinePost(pendingPoll.id, {
          poll: latestPoll,
          pollResultStatus: 'skipped',
        });
        return { status: 'skipped', reason: 'zero_votes' };
      }

      const now = new Date();
      const zonedParts = getZonedDateParts(now, this.config.timezone);
      const timePeriodLabel = formatTimeContextPeriodLabel(
        resolveTimeContextPeriod(zonedParts.numericHour),
        'ja',
      );
      const formattedOptions = latestPoll.options
        .map((o) => {
          const pct = Math.round((o.votes / totalVotes) * 1000) / 10;
          const safeLabel = sanitizeUntrustedPromptText(o.label, 64);
          return `${o.position}. ${safeLabel}: ${o.votes}票 (${pct}%)`;
        })
        .join('\n');

      const [timelineSummary, extendedPrompt] = await Promise.all([
        this.deps.firestore.getTimelineSummary(),
        this.deps.firestore.getExtendedPrompt(),
      ]);
      const safePendingPollText = sanitizeUntrustedPromptText(pendingPoll.text, 500, {
        collapseHorizontalRules: true,
      });
      const safeTimelineSummary = timelineSummary
        ? sanitizeUntrustedPromptText(timelineSummary, 2000, { collapseHorizontalRules: true })
        : '';
      const safeExtendedPrompt = extendedPrompt
        ? sanitizeUntrustedPromptText(extendedPrompt, 2000, { collapseHorizontalRules: true })
        : '';

      const { systemInstruction } = await buildSystemPrompt({
        persona: this.deps.persona,
        promptContext: 'timeline',
        lang: 'ja',
        gemini: this.deps.gemini,
        includeTemporalContext: true,
        timezone: this.config.timezone,
        anchoringContext: [
          `【現在の時間帯】${timePeriodLabel}`,
          `【シチュエーション】アンケート結果発表と感想トーク`,
          `【アンケート内容】${safePendingPollText}`,
          `【最終投票結果（合計 ${totalVotes}票）】\n${formattedOptions}`,
        ],
      });
      const personaName = this.deps.persona.metadata.displayName;
      const defaultHashtag = this.deps.persona.metadata.defaultHashtag;

      const resultPrompt = `あなたはAIキャラクター「${personaName}」として、出題していたXアンケートの最終集計結果を見て、元のアンケートを引用リポスト（Quote Post）する形で結果発表＆感想ポストを1つ作成してください。

【現在の時間帯】
${timePeriodLabel}

【元のアンケート投稿文】
${safePendingPollText}

【最終投票結果（合計 ${totalVotes}票）】
${formattedOptions}

【直近のタイムライン要約】
${safeTimelineSummary || '（特記事項なし）'}

【拡張ペルソナ・近況】
${safeExtendedPrompt || '（特記事項なし）'}

【生成ルール】
- 投票してくれたフォロワーへの感謝やリアクションを入れつつ、最終投票結果（各選択肢の得票数や票の割れ方、全体の傾向など）を踏まえて、${personaName}自身の視点・価値観で感想を語ること。
- 元のアンケートツイートを引用リポスト（Quote Post）する形で投稿されるため、結果の数字を機械的に全部読み上げるのではなく、結果を見た素直なリアクションとフォロワーへの自然な語りかけにすること。
${defaultHashtag ? `- ハッシュタグ（${defaultHashtag} 等）はシステムが自動付与するため、本文中には絶対に含めないこと。` : ''}`;

      const structuredReaction = await this.deps.gemini.generateStructuredTimelinePost(
        systemInstruction,
        resultPrompt,
      );

      let postText = structuredReaction.reply;
      const thought = structuredReaction.thought;

      if (defaultHashtag) {
        const hashtag = `\n${defaultHashtag}`;
        if (postText.length + hashtag.length <= 140) {
          postText += hashtag;
        }
      }

      logger.info('[PollUseCase] Generated Poll Result Reaction Post', {
        pollTweetId: pendingPoll.tweetId,
        postText,
      });

      const pipelineResult = await executePostPipeline(this.deps, {
        postType: 'poll_result',
        text: postText,
        thought,
        attachImage: false,
        quoteTweetId: pendingPoll.tweetId,
      });

      await this.deps.firestore.updateTimelinePost(pendingPoll.id, {
        poll: latestPoll,
        pollResultStatus: 'posted',
        pollResultTweetId: pipelineResult.tweetId,
      });

      return {
        status: 'success',
        post: pipelineResult.post,
        attachedMedia: false,
        tweetId: pipelineResult.tweetId,
      };
    } catch (e) {
      logger.error('[PollUseCase] Error in executePollResult', e);
      throw e;
    }
  }
}
