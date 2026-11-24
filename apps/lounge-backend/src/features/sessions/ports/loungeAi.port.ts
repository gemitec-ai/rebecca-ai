import type {
  LoungeEmotionState,
  LoungeLanguage,
  LoungePrivateMemorySnapshot,
  LoungePublicXMemorySnapshot,
  LoungeSession,
  LoungeTokenUsage,
} from '@rebecca/types';

/**
 * Hexagonal port for computing dense text embedding vectors used to retrieve both
 * isolated `lounge_rag_memories` and read-only Public X `rag_memories`.
 */
export interface ILoungeEmbeddingPort {
  embedQuery(text: string): Promise<number[]>;
}

/**
 * Strictly read-only Hexagonal port for reading Public X Bot memory context.
 * Surfaces the user's Public X profile, recent raw conversation turns, vector memories,
 * and the active persona's Layer 1/2/3 self-post context without any write-back capability.
 */
export interface IPublicXMemoryReadPort {
  readPublicXMemorySnapshot(
    xUserId: string,
    queryEmbedding: readonly number[],
  ): Promise<LoungePublicXMemorySnapshot | null>;
}

/**
 * Hexagonal port for classifying the active persona's emotional state for avatar icons and matching.
 */
export interface ILoungeEmotionClassifierPort {
  classifyEmotion(content: string): Promise<LoungeEmotionState>;
}

/**
 * Matched Bot illustration asset (`images` collection) returned during reply generation.
 */
export interface MatchedBotImageAsset {
  readonly assetId: string;
  readonly imageUrl: string;
}

/**
 * Hexagonal port reusing the Bot backend image vector search to match relevant illustrations
 * for an assistant response; any matched image displayed in chat is saved to the user's Gallery.
 */
export interface IBotImageAssetSearchPort {
  findBestMatchingImage(
    replyText: string,
    emotion: LoungeEmotionState,
  ): Promise<MatchedBotImageAsset | null>;
}

/**
 * Input context supplied to the Private Lounge Gemini dialogue generation pipeline.
 * Production pipelines consume `privateMemory.recentRawMessages` directly as typed dialogue turns
 * alongside `memoryPromptDirective` (which supplies Dreaming profile, RAG vectors, and read-only Public X context).
 */
export interface LoungeChatPipelineInput {
  readonly uid: string;
  readonly session: LoungeSession;
  readonly userPrompt: string;
  /** Independent `lounge_*` memory snapshot; `recentRawMessages` provides ordered raw dialogue turns. */
  readonly privateMemory: LoungePrivateMemorySnapshot;
  /** Read-only Public X memory snapshot (null when user has no linked Public X history). */
  readonly publicXMemory: LoungePublicXMemorySnapshot | null;
  /** Delimiter-isolated prompt directive summarizing Private RAG and read-only Public X memories. */
  readonly memoryPromptDirective: string;
  readonly responseLanguage: LoungeLanguage;
  readonly userTimezone: string;
  readonly localePromptDirective: string;
  readonly allowWebSearch?: boolean;
}

/**
 * Result returned from generating an assistant reply in the Private Lounge.
 */
export interface LoungeChatPipelineOutput {
  readonly replyText: string;
  readonly emotion: LoungeEmotionState;
  readonly tokenUsage: LoungeTokenUsage;
  readonly usedWebSearch?: boolean;
}

/**
 * Hexagonal port abstracting LLM prompt assembly and reply generation for Private Lounge turns.
 */
export interface ILoungeChatPipelinePort {
  generateReply(input: LoungeChatPipelineInput): Promise<LoungeChatPipelineOutput>;
}
