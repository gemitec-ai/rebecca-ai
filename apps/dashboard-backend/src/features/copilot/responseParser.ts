import { createStructuredPersonaSchema, parsePersonaJsonObject } from '@rebecca/persona';
import { CopilotAction, CopilotActionType, CopilotAttachment, CopilotResponse } from '@rebecca/types';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const parseCopilotActionType = (value: unknown): CopilotActionType | null => {
  switch (value) {
    case 'BLOCK_USER':
    case 'UNBLOCK_USER':
    case 'DELETE_POST':
    case 'FORCE_DREAMING':
    case 'REGENERATE_CAPTIONS':
    case 'SYNC_POSTS':
    case 'TRIGGER_REPLY':
      return value;
    default:
      return null;
  }
};

const parseCopilotImpactLevel = (value: unknown): CopilotAction['impactLevel'] | null => {
  switch (value) {
    case 'danger':
    case 'warning':
    case 'info':
      return value;
    default:
      return null;
  }
};

const parseCopilotAction = (candidate: unknown): CopilotAction | null => {
  if (!isPlainObject(candidate)) {
    return null;
  }

  const type = parseCopilotActionType(candidate['type']);
  const impactLevel = parseCopilotImpactLevel(candidate['impactLevel']);
  const title = candidate['title'];
  const description = candidate['description'];
  const requiresConfirmation = candidate['requiresConfirmation'];
  const payload = candidate['payload'];

  if (
    type === null ||
    impactLevel === null ||
    typeof title !== 'string' ||
    title.trim().length === 0 ||
    typeof description !== 'string' ||
    description.trim().length === 0 ||
    typeof requiresConfirmation !== 'boolean' ||
    !isPlainObject(payload)
  ) {
    return null;
  }

  return {
    type,
    title: title.trim(),
    description: description.trim(),
    impactLevel,
    requiresConfirmation,
    payload,
  };
};

/**
 * Schema contract enforcing Honne (`thought`), Tatemae (`reply`), and 1–3 follow-up `suggestionChips`.
 */
export const COPILOT_FINAL_RESPONSE_SCHEMA = createStructuredPersonaSchema({
  thoughtDescription:
    'Inner thoughts, true feelings, and emotional reflection based on the active persona (Honne, within 150 characters).',
  replyDescription: 'Conversational reply embodying the active persona (Tatemae).',
  additionalProperties: {
    suggestionChips: {
      type: 'array',
      minItems: 1,
      items: { type: 'string' },
      description: '1 to 3 relevant follow-up prompt chips for the user.',
    },
  },
  additionalRequired: ['suggestionChips'],
});

/**
 * Validated Copilot LLM payload: optional Honne (`thought`), Tatemae (`reply`),
 * follow-up `suggestionChips`, and an optional strictly validated HITL `actionRequired` proposal.
 */
export interface ParsedCopilotPayload {
  readonly thought?: string;
  readonly reply: string;
  readonly suggestionChips: string[];
  readonly actionRequired?: CopilotAction | null;
}

/**
 * Safely extracts and parses JSON payloads containing Honne (`thought`), Tatemae (`reply`),
 * `suggestionChips`, and optional `actionRequired` via `@rebecca/persona`'s shared parser.
 *
 * Security invariant: Never leaks malformed or truncated JSON payloads containing `"thought"` or `"reply"`
 * into `reply`, regardless of JSON property ordering.
 */
export function extractStructuredCopilotResponse(rawText: string): ParsedCopilotPayload {
  const cleaned = rawText.trim();
  const parsedObj = parsePersonaJsonObject(cleaned);

  let thoughtText: string | undefined;
  let replyText = '';
  let suggestionChips: string[] = [];
  let actionRequired: CopilotAction | null = null;

  if (parsedObj) {
    if (typeof parsedObj['thought'] === 'string' && parsedObj['thought'].trim().length > 0) {
      thoughtText = parsedObj['thought'].trim();
    }
    if (typeof parsedObj['reply'] === 'string' && parsedObj['reply'].trim().length > 0) {
      replyText = parsedObj['reply'].trim();
    }
    if (Array.isArray(parsedObj['suggestionChips'])) {
      suggestionChips = parsedObj['suggestionChips'].filter(
        (s): s is string => typeof s === 'string' && s.trim().length > 0,
      );
    }
    actionRequired = parseCopilotAction(parsedObj['actionRequired']);
  } else {
    const strippedFences = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const looksLikeStructuredJsonPayload =
      strippedFences.startsWith('{') || /"(?:thought|reply)"\s*:/.test(strippedFences);
    if (!looksLikeStructuredJsonPayload) {
      replyText = strippedFences;
    }
  }

  return {
    ...(thoughtText !== undefined ? { thought: thoughtText } : {}),
    reply: replyText,
    suggestionChips,
    actionRequired,
  };
}

/**
 * Deduplicates rich attachments and isolates attachments to the confirmed HITL target entity when applicable.
 */
export const resolveCopilotAttachments = (
  accumulated: ReadonlyArray<CopilotAttachment>,
  action: CopilotAction | null,
): CopilotAttachment[] | undefined => {
  if (accumulated.length === 0) {
    return undefined;
  }

  const unique = Array.from(
    new Map(accumulated.map((a) => [`${a.type}:${a.id}`, a])).values(),
  );

  if (action?.payload?.userId) {
    const targetUserId = String(action.payload.userId);
    if (unique.some((a) => a.type === 'user' && a.id === targetUserId)) {
      return unique.filter((a) => a.type !== 'user' || a.id === targetUserId);
    }
  } else if (action?.payload?.postId) {
    const targetPostId = String(action.payload.postId);
    if (unique.some((a) => a.type === 'post' && a.id === targetPostId)) {
      return unique.filter((a) => a.type !== 'post' || a.id === targetPostId);
    }
  }

  return unique;
};

/**
 * Pure fast-path evaluator: accepts an intermediate tool-loop step only when complete
 * `thought`, `reply`, and non-empty `suggestionChips` are already present.
 */
export const tryAcceptDirectCopilotStep = (
  rawText: string,
  accumulatedAttachments: ReadonlyArray<CopilotAttachment>,
  proposedAction: CopilotAction | null,
): CopilotResponse | undefined => {
  const extracted = extractStructuredCopilotResponse(rawText);
  if (!extracted.thought || !extracted.reply || extracted.suggestionChips.length === 0) {
    return undefined;
  }

  const action = proposedAction ?? extracted.actionRequired ?? null;
  return {
    thought: extracted.thought,
    reply: extracted.reply,
    attachments: resolveCopilotAttachments(accumulatedAttachments, action),
    actionRequired: action,
    suggestionChips: extracted.suggestionChips,
  };
};

/**
 * Pure final parser invoked after `runToolDialogueLoop` completes constrained synthesis (`declarations: []`).
 *
 * @param rawText - Raw synthesized response string from Gemini.
 * @param accumulatedAttachments - Tool-emitted entity attachments collected across turns.
 * @param proposedAction - Pending HITL action returned by `propose_destructive_action`, if any.
 * @returns Validated `CopilotResponse` with `thought`, `reply`, attachments, action, and chips.
 * @throws Error if `thought` or `reply` is missing or whitespace-only.
 */
export const parseFinalCopilotResponse = (
  rawText: string,
  accumulatedAttachments: ReadonlyArray<CopilotAttachment>,
  proposedAction: CopilotAction | null,
): CopilotResponse => {
  const finalExtracted = extractStructuredCopilotResponse(rawText);
  if (!finalExtracted.reply.trim() || !finalExtracted.thought?.trim()) {
    throw new Error('Copilot structured synthesis returned incomplete Honne/Tatemae payload');
  }

  const action = proposedAction ?? finalExtracted.actionRequired ?? null;
  return {
    thought: finalExtracted.thought,
    reply: finalExtracted.reply,
    attachments: resolveCopilotAttachments(accumulatedAttachments, action),
    actionRequired: action,
    suggestionChips: finalExtracted.suggestionChips,
  };
};
