import type {
  LoungeEmotionState,
  LoungeMessage,
  LoungeRagMemory,
  LoungeSession,
  LoungeTokenUsage,
} from '@rebecca/types';

/**
 * Read-only snapshot fetched from Public X Bot collections (`users` / `rag_memories`).
 * Never exposes any write handle or mutation method back to public X state.
 */
export interface PublicXUserMemorySnapshot {
  readonly xUserId: string;
  readonly relationshipToneSummary: string;
  readonly sharedHighlights: readonly string[];
  readonly syncedAt: string;
}

/**
 * Strictly read-only Hexagonal port for reading Public X Bot memory context.
 * Enforces one-way memory isolation from Public X Bot into Private Lounge.
 */
export interface IPublicXMemoryReadPort {
  readPublicXUserSnapshot(xUserId: string): Promise<PublicXUserMemorySnapshot | null>;
}

/**
 * Hexagonal port for classifying the active persona's emotional state for HUD and illustration triggers.
 */
export interface ILoungeEmotionClassifierPort {
  classifyEmotion(content: string): Promise<LoungeEmotionState>;
}

/**
 * Input context supplied to the Private Lounge Gemini dialogue generation pipeline.
 */
export interface LoungeChatPipelineInput {
  readonly uid: string;
  readonly session: LoungeSession;
  readonly userPrompt: string;
  readonly recentMessages: readonly LoungeMessage[];
  readonly privateRagMemories: readonly LoungeRagMemory[];
  readonly publicXSnapshot: PublicXUserMemorySnapshot | null;
}

/**
 * Result returned from generating an assistant reply in the Private Lounge.
 */
export interface LoungeChatPipelineOutput {
  readonly replyText: string;
  readonly emotion: LoungeEmotionState;
  readonly tokenUsage: LoungeTokenUsage;
  readonly unlockedRewardCode?: string;
}

/**
 * Hexagonal port abstracting LLM prompt assembly and reply generation for Private Lounge turns.
 */
export interface ILoungeChatPipelinePort {
  generateReply(input: LoungeChatPipelineInput): Promise<LoungeChatPipelineOutput>;
}
