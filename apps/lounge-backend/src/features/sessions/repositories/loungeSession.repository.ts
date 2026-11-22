import type { DbCollections } from '@rebecca/db';
import type {
  LoungeEmotionState,
  LoungeMessage,
  LoungeMessageListResponseDto,
  LoungeRagMemory,
  LoungeSession,
  LoungeSessionListResponseDto,
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
  readonly unlockedRewardId?: string;
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
 * Persistence contract for isolated `lounge_sessions`, `lounge_messages`, and `lounge_rag_memories`.
 */
export interface ILoungeSessionRepository {
  listSessions(
    uid: string,
    limit?: number,
    startAfterId?: string,
  ): Promise<LoungeSessionListResponseDto>;
  getSessionById(sessionId: string): Promise<LoungeSession | null>;
  createSession(
    uid: string,
    title: string,
    publicXMemorySyncedAt: string,
  ): Promise<LoungeSession>;
  listMessages(
    sessionId: string,
    limit?: number,
    startAfterId?: string,
  ): Promise<LoungeMessageListResponseDto>;
  appendMessagePair(input: AppendLoungeMessagePairInput): Promise<AppendLoungeMessagePairResult>;
  listRagMemories(uid: string, limit?: number): Promise<LoungeRagMemory[]>;
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

  /** Enforces `[1, 100]` pagination limit clamping for session/message queries. */
  public clampLimit(limit?: number): number {
    return normalizePaginationLimit(limit);
  }

  /** Lists paginated Private Lounge sessions owned by `uid`. */
  public async listSessions(
    uid: string,
    limit?: number,
    startAfterId?: string,
  ): Promise<LoungeSessionListResponseDto> {
    const safeLimit = this.clampLimit(limit);
    void this.collections.loungeSessions;
    void uid;
    void safeLimit;
    void startAfterId;
    throw new LoungeNotImplementedError('LoungeSessionRepository.listSessions');
  }

  /** Fetches a single Private Lounge session by ID. */
  public async getSessionById(sessionId: string): Promise<LoungeSession | null> {
    void this.collections.loungeSessions;
    void sessionId;
    throw new LoungeNotImplementedError('LoungeSessionRepository.getSessionById');
  }

  /** Creates a new Private Lounge session thread initialized with Public X sync timestamp. */
  public async createSession(
    uid: string,
    title: string,
    publicXMemorySyncedAt: string,
  ): Promise<LoungeSession> {
    void this.collections.loungeSessions;
    void uid;
    void title;
    void publicXMemorySyncedAt;
    throw new LoungeNotImplementedError('LoungeSessionRepository.createSession');
  }

  /** Lists paginated messages in chronological order for `sessionId`. */
  public async listMessages(
    sessionId: string,
    limit?: number,
    startAfterId?: string,
  ): Promise<LoungeMessageListResponseDto> {
    const safeLimit = this.clampLimit(limit);
    void this.collections.loungeMessages;
    void sessionId;
    void safeLimit;
    void startAfterId;
    throw new LoungeNotImplementedError('LoungeSessionRepository.listMessages');
  }

  /** Appends user and assistant message documents and updates session summary metadata. */
  public async appendMessagePair(
    input: AppendLoungeMessagePairInput,
  ): Promise<AppendLoungeMessagePairResult> {
    void this.collections.loungeMessages;
    void this.collections.loungeSessions;
    void input;
    throw new LoungeNotImplementedError('LoungeSessionRepository.appendMessagePair');
  }

  /** Retrieves private episodic RAG memories scoped strictly to `lounge_rag_memories`. */
  public async listRagMemories(uid: string, limit?: number): Promise<LoungeRagMemory[]> {
    const safeLimit = this.clampLimit(limit);
    void this.collections.loungeRagMemories;
    void uid;
    void safeLimit;
    throw new LoungeNotImplementedError('LoungeSessionRepository.listRagMemories');
  }
}
