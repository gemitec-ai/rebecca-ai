import { COLLECTIONS, assertLoungeRecordOwnedByUid, type DbCollections } from '@rebecca/db';
import type {
  LoungeEmotionState,
  LoungeMessage,
  LoungeMessageListResponseDto,
  LoungeRagMemory,
  LoungeSession,
  LoungeTokenUsage,
} from '@rebecca/types';
import { LoungeNotImplementedError, normalizePaginationLimit } from '../../../utils/errors';

/**
 * Input required to append a user/assistant message turn atomically to `lounge_messages`.
 */
export interface AppendLoungeMessagePairInput {
  readonly uid: string;
  readonly sessionId: string;
  readonly userContent: string;
  readonly userEmotion: LoungeEmotionState;
  readonly assistantContent: string;
  readonly assistantEmotion: LoungeEmotionState;
  readonly assistantTokenUsage: LoungeTokenUsage;
  readonly imageAssetId?: string;
  readonly imageUrl?: string;
}

/**
 * Result returned after persisting a bidirectional Lounge chat turn.
 */
export interface AppendLoungeMessagePairResult {
  readonly session: LoungeSession;
  readonly userMessage: LoungeMessage;
  readonly assistantMessage: LoungeMessage;
}

/**
 * Persistence contract for the single-session-per-user Private Lounge conversation store
 * (`lounge_sessions`, `lounge_messages`, and vectorized `lounge_rag_memories`).
 */
export interface ILoungeSessionRepository {
  getOrCreateSingletonSession(uid: string, publicXMemorySyncedAt: string): Promise<LoungeSession>;
  listMessages(
    uid: string,
    limit?: number,
    startAfterId?: string,
  ): Promise<LoungeMessageListResponseDto>;
  /**
   * Queries the newest `limit` turns using the `sessionId ASC, createdAt DESC` index and
   * returns them ordered chronologically (`[oldest..newest]`) for LLM context assembly.
   */
  listRecentMessages(uid: string, limit?: number): Promise<LoungeMessage[]>;
  searchPrivateRagMemoriesByVector(
    uid: string,
    queryEmbedding: readonly number[],
    limit?: number,
  ): Promise<LoungeRagMemory[]>;
  appendMessagePair(input: AppendLoungeMessagePairInput): Promise<AppendLoungeMessagePairResult>;
  deleteAllUserSessionData(uid: string): Promise<void>;
}

/**
 * Firestore repository skeleton operating strictly against `lounge_sessions`,
 * `lounge_messages`, and `lounge_rag_memories`.
 */
export class LoungeSessionRepository implements ILoungeSessionRepository {
  constructor(
    private readonly collections: Pick<
      DbCollections,
      'loungeSessions' | 'loungeMessages' | 'loungeRagMemories'
    >,
  ) {}

  /** Enforces `[1, 100]` pagination limit clamping for message queries. */
  public clampLimit(limit?: number): number {
    return normalizePaginationLimit(limit);
  }

  /** Fetches or provisions the single persistent conversation session owned 1:1 by `uid`. */
  public async getOrCreateSingletonSession(
    uid: string,
    publicXMemorySyncedAt: string,
  ): Promise<LoungeSession> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_SESSIONS);
    void this.collections.loungeSessions;
    void publicXMemorySyncedAt;
    throw new LoungeNotImplementedError('LoungeSessionRepository.getOrCreateSingletonSession');
  }

  /** Lists paginated messages in chronological order for `uid`'s single session. */
  public async listMessages(
    uid: string,
    limit?: number,
    startAfterId?: string,
  ): Promise<LoungeMessageListResponseDto> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_MESSAGES);
    const safeLimit = this.clampLimit(limit);
    void this.collections.loungeMessages;
    void safeLimit;
    void startAfterId;
    throw new LoungeNotImplementedError('LoungeSessionRepository.listMessages');
  }

  /** Queries the latest `limit` messages (`createdAt DESC` index) returned oldest-to-newest for LLM context. */
  public async listRecentMessages(uid: string, limit?: number): Promise<LoungeMessage[]> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_MESSAGES);
    const safeLimit = this.clampLimit(limit);
    void this.collections.loungeMessages;
    void safeLimit;
    throw new LoungeNotImplementedError('LoungeSessionRepository.listRecentMessages');
  }

  /** Executes cosine vector search over isolated `lounge_rag_memories` owned by `uid`. */
  public async searchPrivateRagMemoriesByVector(
    uid: string,
    queryEmbedding: readonly number[],
    limit?: number,
  ): Promise<LoungeRagMemory[]> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_RAG_MEMORIES);
    const safeLimit = this.clampLimit(limit);
    void this.collections.loungeRagMemories;
    void queryEmbedding;
    void safeLimit;
    throw new LoungeNotImplementedError('LoungeSessionRepository.searchPrivateRagMemoriesByVector');
  }

  /** Appends user and assistant message documents and updates session summary metadata. */
  public async appendMessagePair(
    input: AppendLoungeMessagePairInput,
  ): Promise<AppendLoungeMessagePairResult> {
    assertLoungeRecordOwnedByUid({ uid: input.uid }, input.uid, COLLECTIONS.LOUNGE_MESSAGES);
    void this.collections.loungeMessages;
    void this.collections.loungeSessions;
    throw new LoungeNotImplementedError('LoungeSessionRepository.appendMessagePair');
  }

  /**
   * Permanently deletes the user's single session document, all raw messages in
   * `lounge_messages`, and all episodic vectors in `lounge_rag_memories` on withdrawal.
   */
  public async deleteAllUserSessionData(uid: string): Promise<void> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_SESSIONS);
    void this.collections.loungeSessions;
    void this.collections.loungeMessages;
    void this.collections.loungeRagMemories;
    throw new LoungeNotImplementedError('LoungeSessionRepository.deleteAllUserSessionData');
  }
}
