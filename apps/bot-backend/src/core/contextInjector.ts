import { composeSystemPrompt } from '@rebecca/memory';
import { getZonedDateParts, formatZonedDateTime } from '../utils/time';
import config from '../config';
import { PromptContext, Language, IPersonaDefinition } from '@rebecca/persona';
import { FirestoreUser } from '../types';

/**
 * Builds the comprehensive system prompt by combining the base persona prompt
 * with various contextual injections such as core profile, episodic memories,
 * time of day, rollout anniversary, and timeline history.
 *
 * Delegates prompt assembly to `@rebecca/memory`'s `composeSystemPrompt` while preserving
 * `bot-backend`'s positional signature and injectable `utils/time` clock helpers.
 *
 * @param persona - The active persona definition.
 * @param promptContext - The context in which the prompt is being used.
 * @param userData - The current user's profile and state from Firestore.
 * @param userInput - The user's input string (retained for call-site signature compatibility).
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
  promptContext: PromptContext,
  userData: FirestoreUser | null,
  userInput: string,
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
    promptContext,
    userData,
    extendedPrompt,
    timelineSummary,
    ragMemories,
    lang,
    personaFewShotPrompt,
    campaignContext,
    parentPostContext,
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
