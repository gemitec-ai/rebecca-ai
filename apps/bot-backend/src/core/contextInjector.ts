import type { IMemoryVectorEmbedder } from '@rebecca/memory';
import {
  composeSystemPrompt,
  type ComposedSystemPrompt,
  type PromptSection,
} from '@rebecca/prompt';
import type { IPersonaDefinition, Language } from '@rebecca/persona';
import config from '../config';
import type { FirestoreUser } from '../types';
import { logger } from '../utils/logger';
import { formatZonedDateTime, getZonedDateParts } from '../utils/time';
import { type BotChannelContext, getBotChannelGuidelines } from './channelPrompts';

/**
 * Formats X-specific contextual sections (active campaign narratives and replied-to root posts)
 * for injection into `@rebecca/prompt`'s unified `composeSystemPrompt`.
 */
const buildBotAdditionalSections = (
  personaDisplayName: string,
  lang: Language,
  campaignContext: string,
  parentPostContext: string,
): PromptSection[] => {
  const sections: PromptSection[] = [];

  if (campaignContext && campaignContext.trim() !== '') {
    sections.push(
      lang === 'en'
        ? {
            header: '[Current Ongoing Campaign / Special Narrative Event]',
            body: `${campaignContext}\n\n[CRITICAL: Empathy Priority Rule]\nAlways prioritize the user's emotional state, troubles, or immediate question before mentioning the campaign. Never derail a serious or melancholic conversation with bubbly event talk unless the user asked about it or it naturally fits.`,
          }
        : {
            header: '【現在進行中のイベント・キャンペーン状況（Special Narrative Event）】',
            body: `${campaignContext}\n\n【最優先ルール：共感・ユーザーファースト（Empathy Priority）】\nユーザーの悩み、相談、質問、感情の機微を最優先で受け止めて返信してください。ユーザーが真剣な話や落ち込んでいる時に、イベントの話題（旅行や浮かれた話など）を無理やり割り込ませて話の腰を折ることは厳禁です。ユーザーからイベントについて尋ねられた場合、または自然な雑談の流れでのみ触れてください。`,
          },
    );
  }

  if (parentPostContext && parentPostContext.trim() !== '') {
    sections.push(
      lang === 'en'
        ? {
            header: '[Context: Your Original Post Being Replied To]',
            body: `The user is directly replying to your following post:\n"${parentPostContext}"\n[Instruction for Root Post Replies]\nTake into account your original post and the question/topic you raised, and naturally acknowledge the user's reaction. *Always match the interlocutor's language regardless of the original post language.`,
          }
        : {
            header: `【文脈：ユーザーが返信している${personaDisplayName}の元ポスト】`,
            body: `ユーザーはあなたの以下の投稿に対して直接リプライしています：\n「${parentPostContext}」\n【元ポスト返信時の指針】\nあなたが元ポストで投げかけた話題や問いかけを踏まえた上で、相手の反応を自然に受け止めて会話を繋げてください（※返信言語は元ポストではなく、必ず相手の発言言語に合わせてください）。`,
          },
    );
  }

  return sections;
};

/**
 * Unified input contract for building every X Bot / CLI persona system prompt.
 * Requires `gemini` and `anchoringContext` so 120-pattern situational grounding
 * is consistently enforced across all features.
 */
export interface BuildBotSystemPromptOptions {
  readonly persona: IPersonaDefinition;
  readonly promptContext: BotChannelContext;
  readonly gemini: IMemoryVectorEmbedder;
  readonly anchoringContext: readonly string[];
  readonly lang?: Language;
  readonly topK?: number;
  readonly includeTemporalContext?: boolean;
  readonly userData?: FirestoreUser | null;
  readonly extendedPrompt?: string;
  readonly timelineSummary?: string;
  readonly ragMemories?: readonly string[];
  readonly campaignContext?: string;
  readonly parentPostContext?: string;
  readonly platformGuidelines?: string;
}

/**
 * Single canonical entrypoint for building all Bot system prompts across replies,
 * proactive timeline posts, polls, campaigns, supporter messages, and random engagement.
 *
 * Delegates Layer 0 + channel composition, 120-pattern situational anchoring,
 * localized temporal awareness, and memory assembly to `@rebecca/prompt`'s unified `composeSystemPrompt`.
 *
 * @param options - Grounded bot prompt assembly parameters.
 * @returns Structured prompt bundle containing `baseSystemInstruction`, `personaFewShotPrompt`, and `systemInstruction`.
 */
const buildSystemPrompt = async (
  options: BuildBotSystemPromptOptions,
): Promise<ComposedSystemPrompt> => {
  const {
    persona,
    promptContext,
    gemini,
    anchoringContext,
    lang = 'ja',
    topK = 3,
    includeTemporalContext = false,
    userData = null,
    extendedPrompt = '',
    timelineSummary = '',
    ragMemories = [],
    campaignContext = '',
    parentPostContext = '',
    platformGuidelines = '',
  } = options;

  const hasMemoryContext =
    userData !== null ||
    extendedPrompt.trim() !== '' ||
    timelineSummary.trim() !== '' ||
    ragMemories.length > 0;

  return composeSystemPrompt({
    persona,
    channelInstruction: getBotChannelGuidelines(promptContext, persona, lang),
    lang,
    anchoring: {
      embedder: gemini,
      contextElements: anchoringContext,
      topK,
      logger,
    },
    ...(includeTemporalContext
      ? {
          temporal: {
            timezone: config.appTimezone,
            timeResolver: {
              getZonedDateParts,
              formatZonedDateTime,
            },
          },
        }
      : {}),
    ...(hasMemoryContext
      ? {
          memory: {
            userData,
            extendedPrompt,
            activitySummary: timelineSummary,
            ragMemories,
            accountHandleLabel: lang === 'en' ? 'X Handle' : 'XユーザーID',
            activitySummaryHeader:
              lang === 'en' ? '[My Recent Posts (Context)]' : '【最近の自分の投稿（参考）】',
            activitySummaryLead:
              lang === 'en'
                ? 'Recently, I posted this:'
                : `${persona.metadata.displayName}は最近以下のようにつぶやいていた。`,
          },
        }
      : {}),
    additionalSections: buildBotAdditionalSections(
      persona.metadata.displayName,
      lang,
      campaignContext,
      parentPostContext,
    ),
    platformGuidelines,
  });
};

export { buildSystemPrompt };
