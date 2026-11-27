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
  /**
   * Computes a 768-dimension semantic embedding vector for `text` (returns `[]` when blank).
   *
   * @throws Error When the embedding provider request fails.
   */
  embedQuery(text: string): Promise<number[]>;
}

/**
 * Strictly read-only Hexagonal port for reading Public X Bot memory context.
 * Surfaces the user's Public X profile, recent raw conversation turns, vector memories,
 * and the active persona's Layer 1/2/3 self-post context without any write-back capability.
 */
export interface IPublicXMemoryReadPort {
  /**
   * Reads read-only Public X profile, recent dialogue turns, vector memories formatted in `userTimezone`,
   * and Layer 1/2/3 persona timeline context for `xUserId`, or returns `null` when unavailable.
   */
  readPublicXMemorySnapshot(
    xUserId: string,
    queryEmbedding: readonly number[],
    userTimezone?: string,
  ): Promise<LoungePublicXMemorySnapshot | null>;
}

/**
 * Hexagonal port for classifying the assistant's post-reply emotional state for avatar expressions.
 */
export interface ILoungeEmotionClassifierPort {
  /**
   * Selects the matching Lounge avatar expression emotion for a completed turn and reports token usage.
   *
   * @throws Error When the classifier returns malformed or unrecognized JSON output.
   */
  classifyEmotion(input: {
    readonly userPrompt: string;
    readonly thought: string;
    readonly replyText: string;
    readonly onTokenUsage?: (usage: LoungeTokenUsage) => void;
  }): Promise<LoungeEmotionState>;
}

/**
 * Matched Bot illustration candidate (`images` collection) returned during 3-stage image matching.
 */
export interface MatchedBotImageAsset {
  readonly assetId: string;
  readonly imageUrl: string;
  readonly caption: string;
}

/**
 * Hexagonal port querying `collections.images` via semantic vectors while excluding
 * assets already displayed in the caller's recent turns.
 */
export interface IBotImageAssetSearchPort {
  /** Returns up to `limit` verified `SUCCESS` illustration candidates matching `searchQuery`. */
  findCandidateImages(
    searchQuery: string,
    excludeAssetIds: ReadonlySet<string>,
    limit?: number,
  ): Promise<MatchedBotImageAsset[]>;
}

/**
 * Hexagonal port performing LLM Stage 1 query inference and Stage 3 semantic image relevance verification.
 */
export interface ILoungeImageMatcherPort {
  /**
   * Infers whether an illustration enhances the reply and returns a concise query or `null`.
   *
   * @throws Error When planner output JSON is missing or malformed.
   */
  planImageSearch(input: {
    readonly userPrompt: string;
    readonly thought: string;
    readonly replyText: string;
    readonly onTokenUsage?: (usage: LoungeTokenUsage) => void;
  }): Promise<string | null>;

  /**
   * Verifies semantic consistency between candidate illustration caption and reply context.
   *
   * @throws Error When verifier output JSON is missing or malformed.
   */
  verifyImageRelevance(input: {
    readonly candidateCaption: string;
    readonly replyText: string;
    readonly thought: string;
    readonly onTokenUsage?: (usage: LoungeTokenUsage) => void;
  }): Promise<boolean>;
}

/**
 * Input context supplied to the Private Lounge Gemini dialogue generation pipeline.
 */
export interface LoungeChatPipelineInput {
  readonly uid: string;
  readonly session: LoungeSession;
  readonly userPrompt: string;
  /** User display name supplied to `@rebecca/prompt` Interlocutor Account Info. */
  readonly userDisplayName?: string;
  /** User X handle supplied to `@rebecca/prompt` Interlocutor Account Info. */
  readonly userXHandle?: string;
  /** Pre-computed query vector reused to anchor 120-pattern situational few-shot selection without extra API calls. */
  readonly queryEmbedding?: readonly number[];
  /** Independent `lounge_*` memory snapshot; `recentRawMessages` preserves internal `thought` strings. */
  readonly privateMemory: LoungePrivateMemorySnapshot;
  /** Read-only Public X memory snapshot (null when user has no linked Public X history). */
  readonly publicXMemory: LoungePublicXMemorySnapshot | null;
  readonly responseLanguage: LoungeLanguage;
  readonly userTimezone: string;
  readonly allowWebSearch?: boolean;
}

/**
 * Result returned from generating an assistant reply in the Private Lounge.
 */
export interface LoungeChatPipelineOutput {
  readonly thought: string;
  readonly replyText: string;
  readonly tokenUsage: LoungeTokenUsage;
  readonly usedWebSearch?: boolean;
}

/**
 * Hexagonal port abstracting LLM prompt assembly and reply generation for Private Lounge turns.
 */
export interface ILoungeChatPipelinePort {
  /**
   * Composes persona/memory prompts and generates structured `{ thought, replyText }` output plus metering.
   *
   * @throws Error When the dialogue model returns empty or malformed structured output.
   */
  generateReply(input: LoungeChatPipelineInput): Promise<LoungeChatPipelineOutput>;
}
