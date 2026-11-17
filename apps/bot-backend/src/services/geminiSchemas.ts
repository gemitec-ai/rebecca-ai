import { createStructuredPersonaSchema } from '@rebecca/persona';

/**
 * Creates the JSON schema for structured news post generation with enum-constrained candidate title selection.
 */
export const createStructuredNewsPostSchema = (candidateHeadlines: string[]) =>
  createStructuredPersonaSchema({
    thoughtDescription:
      'Inner thoughts, true feelings, and emotional shifts based on the persona (within 150 characters).',
    replyDescription: 'The public tweet text (within 100 characters).',
    additionalProperties: {
      selectedTitle: {
        type: 'string',
        enum: candidateHeadlines,
        description: 'The exact headline title chosen from the candidate list.',
      },
    },
    additionalRequired: ['selectedTitle'],
  });

/**
 * JSON schema for structured poll post generation (`thought`, `reply`, and 3-4 poll options).
 */
export const STRUCTURED_POLL_POST_SCHEMA = createStructuredPersonaSchema({
  thoughtDescription:
    'Inner thoughts, true feelings, and why this poll topic was chosen (within 150 characters).',
  replyDescription:
    'The public poll tweet text inviting followers to vote and reply (within 100 characters).',
  additionalProperties: {
    options: {
      type: 'array',
      items: {
        type: 'string',
      },
      minItems: 3,
      maxItems: 4,
      description: '3 to 4 poll choices, each strictly within 25 characters.',
    },
  },
  additionalRequired: ['options'],
});

/**
 * JSON schema for structured supporter appreciation posts (`thought` and `replyBody`).
 */
export const STRUCTURED_SUPPORT_POST_SCHEMA = createStructuredPersonaSchema({
  replyFieldName: 'replyBody',
  thoughtDescription:
    'Inner thoughts reflecting gratitude and personal context in character when thanking the supporter (within 150 characters).',
  replyDescription:
    'Original supporter appreciation tweet directly addressing the supporter by name while expressing warmth and item appreciation (within 90 characters; no boilerplate).',
});
