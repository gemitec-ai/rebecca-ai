import { sanitizeUntrustedPromptText, type IMemoryVectorEmbedder } from '@rebecca/memory';
import type { ToolDeclaration } from '@rebecca/tools';
import { CopilotAction, CopilotAttachment } from '@rebecca/types';
import { TimelineRepository } from '../timeline/repository';
import { UsersRepository } from '../users/repository';
import { AssetsRepository } from '../assets/repository';
import { SystemMemoryRepository } from '../system-memory/repository';
import { SupportersRepository } from '../supporters/repository';

/**
 * Execution context supplied to copilot tools containing repository instances and configuration.
 */
export interface CopilotToolContext {
  readonly timelineRepo?: TimelineRepository;
  readonly usersRepo?: UsersRepository;
  readonly assetsRepo?: AssetsRepository;
  readonly memoryRepo?: SystemMemoryRepository;
  readonly supportersRepo?: SupportersRepository;
  readonly embedder?: IMemoryVectorEmbedder;
  readonly timezone?: string;
  readonly isEn: boolean;
}

/**
 * Result returned by a copilot tool execution.
 */
export interface CopilotToolExecutionResult {
  /** Structured output data provided back to the LLM for reasoning. */
  readonly data: unknown;
  /** Optional rich media attachments (images, posts, users) to display on frontend. */
  readonly attachments?: CopilotAttachment[];
  /** Optional proposed human-in-the-loop action if explicitly triggered. */
  readonly actionRequired?: CopilotAction | null;
}

/**
 * Abstract interface for a typed provider-neutral Copilot Tool.
 */
export interface CopilotTool {
  /** Unique snake_case identifier matching tool function name. */
  readonly name: string;
  /** Detailed English explanation of tool purpose and when to call it. */
  readonly description: string;
  /** Provider-agnostic JSON Schema tool declaration. */
  readonly declaration: ToolDeclaration;
  /** Executes the tool logic against domain repositories. */
  execute(params: Record<string, unknown>, context: CopilotToolContext): Promise<CopilotToolExecutionResult>;
}

/**
 * Clamps an untrusted numeric tool `limit` parameter between `1` and `max`,
 * falling back to `defaultLimit` only when missing, non-numeric, or non-finite.
 * Preserves explicit `0` as `1` rather than silently reverting to `defaultLimit`.
 */
export const resolveBoundedLimit = (rawLimit: unknown, max: number, defaultLimit = 5): number => {
  if (typeof rawLimit === 'number') {
    return Number.isFinite(rawLimit) ? Math.max(1, Math.min(Math.trunc(rawLimit), max)) : defaultLimit;
  }
  if (typeof rawLimit === 'string' && rawLimit.trim() !== '') {
    const parsed = Number(rawLimit);
    return Number.isFinite(parsed) ? Math.max(1, Math.min(Math.trunc(parsed), max)) : defaultLimit;
  }
  return defaultLimit;
};

/** Maximum character count permitted for incoming Copilot chat messages and history texts. */
export const MAX_COPILOT_MESSAGE_CHARS = 2000;
/** Maximum character count permitted for active UI context summaries. */
export const MAX_COPILOT_CONTEXT_CHARS = 500;
/** Maximum number of recent history turns accepted per Copilot request. */
export const MAX_COPILOT_HISTORY_ITEMS = 20;
/** Maximum character count permitted for prior assistant inner thoughts in history. */
export const MAX_COPILOT_THOUGHT_CHARS = 500;

/**
 * Validates and normalizes an optional ISO-8601/parseable timestamp string bounded to 64 characters.
 *
 * @param raw - Untrusted timestamp value from HTTP payload or request DTO.
 * @returns Trimmed valid timestamp string, or `undefined` when invalid, empty, or oversized.
 */
export const sanitizeBoundedTimestamp = (raw: unknown): string | undefined => {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed.length === 0 || trimmed.length > 64 || Number.isNaN(Date.parse(trimmed))) {
    return undefined;
  }
  return trimmed;
};

/**
 * Unvalidated Copilot chat history item shape accepted at controller or usecase trust boundaries.
 */
export interface RawCopilotHistoryEntry {
  readonly role?: string;
  readonly text?: string;
  readonly thought?: string;
  readonly time?: string;
}

/**
 * Normalized, bounded, and delimiter-sanitized Copilot history item.
 */
export interface SanitizedCopilotHistoryEntry {
  readonly role: 'user' | 'model';
  readonly text: string;
  readonly thought?: string;
  readonly time?: string;
}

/**
 * Slices an untrusted Copilot history array to {@link MAX_COPILOT_HISTORY_ITEMS} entries and
 * sanitizes control characters, prompt delimiters, timestamps, and lengths uniformly.
 *
 * @param rawHistory - Untrusted client or caller conversation history.
 * @returns Sanitized history turns ready for working-memory conversion.
 */
export const sanitizeCopilotHistory = (
  rawHistory: readonly RawCopilotHistoryEntry[],
): SanitizedCopilotHistoryEntry[] =>
  rawHistory.slice(-MAX_COPILOT_HISTORY_ITEMS).map((item) => {
    const validTime = sanitizeBoundedTimestamp(item?.time);
    const cleanText =
      typeof item?.text === 'string'
        ? sanitizeUntrustedPromptText(item.text, MAX_COPILOT_MESSAGE_CHARS)
        : '';
    const cleanThought =
      typeof item?.thought === 'string'
        ? sanitizeUntrustedPromptText(item.thought, MAX_COPILOT_THOUGHT_CHARS)
        : '';
    return {
      role: item?.role === 'model' ? ('model' as const) : ('user' as const),
      text: cleanText,
      ...(cleanThought.length > 0 ? { thought: cleanThought } : {}),
      ...(validTime !== undefined ? { time: validTime } : {}),
    };
  });
