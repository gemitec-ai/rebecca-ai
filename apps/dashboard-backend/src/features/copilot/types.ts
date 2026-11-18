import type { IMemoryVectorEmbedder } from '@rebecca/memory';
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
