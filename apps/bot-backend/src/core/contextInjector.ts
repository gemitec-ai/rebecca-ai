import { composeSystemPrompt, PromptSection } from '@rebecca/prompt';
import { getZonedDateParts, formatZonedDateTime } from '../utils/time';
import config from '../config';
import { Language, IPersonaDefinition } from '@rebecca/persona';
import { FirestoreUser } from '../types';
import { BotChannelContext, getBotChannelGuidelines } from './channelPrompts';

/**
 * Formats X-specific contextual sections (active campaign narratives and replied-to root posts)
 * for injection into `@rebecca/prompt`'s channel-agnostic `composeSystemPrompt`.
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
 * Builds the comprehensive system prompt by combining the base persona prompt
 * with X channel rules, contextual injections, X campaign/reply sections, and timeline summaries.
 *
 * Delegates core composition to `@rebecca/prompt`'s `composeSystemPrompt` while preserving
 * `bot-backend`'s positional signature and X-specific section builders.
 *
 * @param persona - The active persona definition.
 * @param promptContext - The X Bot channel context (`reply`, `timeline`, or `random_engagement`).
 * @param userData - The current user's profile and state from Firestore.
 * @param _userInput - The user's input string (retained for call-site signature compatibility).
 * @param extendedPrompt - An optional extended prompt generated through evolution.
 * @param timelineSummary - An optional summary of the AI's recent timeline activity.
 * @param ragMemories - Optional retrieved memories relevant to the current conversation.
 * @param lang - The language for the prompt, defaults to `'ja'`.
 * @param personaFewShotPrompt - Optional dynamically selected few-shot examples.
 * @param campaignContext - Optional narrative event context summary when a campaign is active.
 * @param parentPostContext - Optional original timeline post content when the user is replying to a root post.
 * @returns The fully constructed system prompt string.
 */
const buildSystemPrompt = (
  persona: IPersonaDefinition,
  promptContext: BotChannelContext,
  userData: FirestoreUser | null,
  _userInput: string,
  extendedPrompt = '',
  timelineSummary = '',
  ragMemories: string[] = [],
  lang: Language = 'ja',
  personaFewShotPrompt = '',
  campaignContext = '',
  parentPostContext = '',
): string => {
  return composeSystemPrompt({
    persona,
    channelInstruction: getBotChannelGuidelines(promptContext, lang),
    userData,
    extendedPrompt,
    activitySummary: timelineSummary,
    ragMemories,
    lang,
    personaFewShotPrompt,
    accountHandleLabel: lang === 'en' ? 'X Handle' : 'XユーザーID',
    activitySummaryHeader: lang === 'en' ? '[My Recent Posts (Context)]' : '【最近の自分の投稿（参考）】',
    activitySummaryLead:
      lang === 'en'
        ? 'Recently, I posted this:'
        : `${persona.metadata.displayName}は最近以下のようにつぶやいていた。`,
    additionalSections: buildBotAdditionalSections(
      persona.metadata.displayName,
      lang,
      campaignContext,
      parentPostContext,
    ),
    timezone: config.appTimezone,
    timeResolver: {
      getZonedDateParts,
      formatZonedDateTime,
    },
  });
};

export {
  buildSystemPrompt,
};
