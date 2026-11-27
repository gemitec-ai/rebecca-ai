import crypto from 'node:crypto';
import { FieldValue, type Firestore, type Transaction } from '@google-cloud/firestore';
import {
  COLLECTIONS,
  assertLoungeRecordOwnedByUid,
  createUserScopedLoungeSessionDb,
  type DbCollections,
} from '@rebecca/db';
import {
  toPublicLoungeMessage,
  type ConversationLogEntry,
  type LoungeEmotionState,
  type LoungeMemoryCategory,
  type LoungeMessage,
  type LoungeMessageDoc,
  type LoungeMessageListResponseDto,
  type LoungePaginationQueryDto,
  type LoungeRagMemory,
  type LoungeRagMemoryDoc,
  type LoungeSession,
  type LoungeSessionDoc,
  type LoungeTokenUsage,
} from '@rebecca/types';
import {
  LoungeAuthError,
  LoungeValidationError,
  normalizePaginationLimit,
  normalizePaginationQuery,
} from '../../../utils/errors';
import { deleteQueryInBatches } from '../../../utils/firestoreBatch';

const MAX_EPISODIC_BUFFER_ENTRIES = 40;
const MAX_LOUNGE_RAG_MEMORIES = 100;

/** Computes normalized cosine similarity in `[-1, 1]` between equal-length vectors. */
export function computeCosineSimilarity(
  a: ReadonlyArray<number>,
  b: ReadonlyArray<number>,
): number {
  if (a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA <= 0 || normB <= 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Input required to append a user/assistant message turn atomically to `lounge_messages`.
 */
export interface AppendLoungeMessagePairInput {
  readonly uid: string;
  readonly sessionId: string;
  readonly userContent: string;
  readonly userEmotion: LoungeEmotionState;
  readonly assistantContent: string;
  readonly assistantThought?: string;
  readonly assistantEmotion: LoungeEmotionState;
  readonly assistantTokenUsage: LoungeTokenUsage;
  readonly imageAssetId?: string;
  readonly imageUrl?: string;
  readonly publicXMemorySyncedAt?: string;
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
  /** Retrieves the caller's existing singleton session, or `null` if none exists yet. */
  findSessionByUid(uid: string): Promise<LoungeSession | null>;
  /** Retrieves or atomically creates the single persistent session owned 1:1 by `uid`. */
  getOrCreateSingletonSession(uid: string, publicXMemorySyncedAt: string): Promise<LoungeSession>;
  /**
   * Lists paginated public messages ordered chronologically (`[oldest..newest]`) per page.
   *
   * @throws LoungeValidationError When an explicit `cursor` does not exist or belongs to another user (`400`).
   */
  listMessages(
    uid: string,
    query?: LoungePaginationQueryDto,
  ): Promise<LoungeMessageListResponseDto>;
  /** Queries the latest internal message documents returned oldest-to-newest for LLM continuity. */
  listRecentMessages(uid: string, limit?: number): Promise<LoungeMessageDoc[]>;
  /**
   * Executes cosine vector search over isolated `lounge_rag_memories` owned by `uid`.
   *
   * @throws Error When production vector search fails unexpectedly.
   */
  searchPrivateRagMemoriesByVector(
    uid: string,
    queryEmbedding: readonly number[],
    limit?: number,
  ): Promise<LoungeRagMemory[]>;
  /**
   * Atomically appends user and assistant turns while verifying `lounge_users/{uid}` remains `ACTIVE`.
   *
   * @throws LoungeAuthError When the owning user record is missing or no longer `ACTIVE` (`403`).
   */
  appendMessagePair(input: AppendLoungeMessagePairInput): Promise<AppendLoungeMessagePairResult>;
  /** Stores turn vector embedding, prunes overflow memories, and appends Dreaming episodic entries. */
  indexPrivateTurnMemory(input: {
    readonly uid: string;
    readonly sessionId: string;
    readonly category: LoungeMemoryCategory;
    readonly summary: string;
    readonly embedding: readonly number[];
    readonly salienceScore: number;
    readonly episodicEntries: ReadonlyArray<ConversationLogEntry>;
  }): Promise<void>;
  /** Permanently deletes session metadata, messages, and RAG memories owned by `uid`. */
  deleteAllUserSessionData(uid: string): Promise<void>;
}

/**
 * Firestore repository operating strictly against `lounge_sessions`,
 * `lounge_messages`, and `lounge_rag_memories`.
 */
export class LoungeSessionRepository implements ILoungeSessionRepository {
  constructor(
    private readonly firestore: Firestore,
    private readonly collections: Pick<
      DbCollections,
      'loungeUsers' | 'loungeSessions' | 'loungeMessages' | 'loungeRagMemories'
    >,
    private readonly isEmulator: boolean = false,
  ) {}

  /** Retrieves the caller's existing singleton session document, or `null` when not yet initialized. */
  public async findSessionByUid(uid: string): Promise<LoungeSession | null> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_SESSIONS);
    const scoped = createUserScopedLoungeSessionDb(this.collections, uid);
    const snap = await scoped.sessionDoc().get();
    const existing = snap.data();
    return snap.exists && existing ? scoped.assertOwned(existing, COLLECTIONS.LOUNGE_SESSIONS) : null;
  }

  /** Fetches or provisions the single persistent conversation session owned 1:1 by `uid`. */
  public async getOrCreateSingletonSession(
    uid: string,
    publicXMemorySyncedAt: string,
  ): Promise<LoungeSession> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_SESSIONS);
    const scoped = createUserScopedLoungeSessionDb(this.collections, uid);
    const sessionRef = scoped.sessionDoc();

    return this.firestore.runTransaction(async (tx: Transaction) => {
      const snap = await tx.get(sessionRef);
      const existing = snap.data();
      if (snap.exists && existing) {
        return scoped.assertOwned(existing, COLLECTIONS.LOUNGE_SESSIONS);
      }
      const nowIso = new Date().toISOString();
      const created: LoungeSessionDoc = {
        id: uid,
        uid,
        title: 'Private Lounge',
        messageCount: 0,
        currentEmotion: 'NEUTRAL',
        publicXMemorySyncedAt,
        lastMessagePreview: '',
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      tx.set(sessionRef, created);
      return created;
    });
  }

  /**
   * Lists paginated public messages ordered chronologically (`[oldest..newest]`) per page
   * with server-only internal thoughts stripped.
   *
   * @throws LoungeValidationError When an explicit `cursor` does not exist or belongs to another user (`400`).
   */
  public async listMessages(
    uid: string,
    query?: LoungePaginationQueryDto,
  ): Promise<LoungeMessageListResponseDto> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_MESSAGES);
    const safeQuery = normalizePaginationQuery(query);
    const scoped = createUserScopedLoungeSessionDb(this.collections, uid);

    let cursorSnap:
      | Awaited<ReturnType<ReturnType<DbCollections['loungeMessages']['doc']>['get']>>
      | undefined;
    if (safeQuery.cursor) {
      cursorSnap = await this.collections.loungeMessages.doc(safeQuery.cursor).get();
      if (!cursorSnap.exists || cursorSnap.data()?.uid !== uid) {
        throw new LoungeValidationError('Invalid message pagination cursor');
      }
    }

    const countSnap = await scoped.messagesQuery().count().get();
    const totalItems = countSnap.data().count;
    const totalPages = Math.max(1, Math.ceil(totalItems / safeQuery.limit));

    if (totalItems === 0) {
      return {
        data: [],
        meta: {
          totalItems: 0,
          totalPages: 1,
          currentPage: 1,
          limit: safeQuery.limit,
          nextCursor: null,
          hasMore: false,
        },
      };
    }

    let descQuery = scoped
      .messagesQuery()
      .orderBy('createdAt', 'desc')
      .orderBy('__name__', 'desc');

    if (cursorSnap) {
      descQuery = descQuery.startAfter(cursorSnap);
    } else if (safeQuery.page > 1) {
      const offsetCount = (safeQuery.page - 1) * safeQuery.limit;
      descQuery = descQuery.offset(offsetCount);
    }

    const snap = await descQuery.limit(safeQuery.limit + 1).get();
    const hasMore = snap.docs.length > safeQuery.limit;
    const pageDocs = snap.docs
      .slice(0, safeQuery.limit)
      .map((d) => toPublicLoungeMessage(scoped.assertOwned(d.data(), COLLECTIONS.LOUNGE_MESSAGES)));

    // Flip newest-first Firestore slice into chronological order `[oldest..newest]`
    const chronological = [...pageDocs].reverse();
    const nextCursor =
      hasMore && chronological.length > 0 ? chronological[0].id : null;

    return {
      data: chronological,
      meta: {
        totalItems,
        totalPages,
        currentPage: Math.min(safeQuery.page, totalPages),
        limit: safeQuery.limit,
        nextCursor,
        hasMore,
      },
    };
  }

  /** Queries the latest `limit` internal message docs (`createdAt DESC`) returned oldest-to-newest for LLM context. */
  public async listRecentMessages(uid: string, limit?: number): Promise<LoungeMessageDoc[]> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_MESSAGES);
    const safeLimit = normalizePaginationLimit(limit);
    const scoped = createUserScopedLoungeSessionDb(this.collections, uid);
    const snap = await scoped
      .messagesQuery()
      .orderBy('createdAt', 'desc')
      .limit(safeLimit)
      .get();

    return snap.docs
      .map((d) => scoped.assertOwned(d.data(), COLLECTIONS.LOUNGE_MESSAGES))
      .reverse();
  }

  /**
   * Executes cosine vector search over isolated `lounge_rag_memories` owned by `uid`.
   *
   * @throws Error When vector search fails outside local Firestore Emulator mode.
   */
  public async searchPrivateRagMemoriesByVector(
    uid: string,
    queryEmbedding: readonly number[],
    limit?: number,
  ): Promise<LoungeRagMemory[]> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_RAG_MEMORIES);
    const safeLimit = Math.min(normalizePaginationLimit(limit), 10);
    const scoped = createUserScopedLoungeSessionDb(this.collections, uid);

    if (queryEmbedding.length === 0) {
      const snap = await scoped
        .ragMemoriesQuery()
        .orderBy('updatedAt', 'desc')
        .limit(safeLimit)
        .get();
      return snap.docs.map((d) => scoped.assertOwned(d.data(), COLLECTIONS.LOUNGE_RAG_MEMORIES));
    }

    try {
      const snap = await scoped
        .ragMemoriesQuery()
        .findNearest({
          vectorField: 'embedding',
          queryVector: FieldValue.vector([...queryEmbedding]),
          limit: safeLimit,
          distanceMeasure: 'COSINE',
        })
        .get();

      const results = snap.docs.map((d) =>
        scoped.assertOwned(d.data(), COLLECTIONS.LOUNGE_RAG_MEMORIES),
      );
      if (results.length > 0 || !this.isEmulator) {
        return results;
      }
    } catch (err) {
      if (!this.isEmulator) {
        throw new Error(`Private RAG vector query failed for "${uid}"`, { cause: err });
      }
    }

    // Deterministic cosine ranking fallback for Firestore Emulator environments
    const candidateSnap = await scoped.ragMemoriesQuery().limit(100).get();
    return candidateSnap.docs
      .map((d) => scoped.assertOwned(d.data(), COLLECTIONS.LOUNGE_RAG_MEMORIES))
      .map((mem) => ({
        mem,
        score: computeCosineSimilarity(queryEmbedding, mem.embedding),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, safeLimit)
      .map((entry) => entry.mem);
  }

  /**
   * Appends user and assistant message documents atomically while verifying `lounge_users/{uid}`
   * remains `ACTIVE` inside the transaction so concurrent account deletion aborts cleanly.
   *
   * @throws LoungeAuthError When `lounge_users/{uid}` is missing or not `ACTIVE` (`403`).
   */
  public async appendMessagePair(
    input: AppendLoungeMessagePairInput,
  ): Promise<AppendLoungeMessagePairResult> {
    assertLoungeRecordOwnedByUid({ uid: input.uid }, input.uid, COLLECTIONS.LOUNGE_MESSAGES);
    const scoped = createUserScopedLoungeSessionDb(this.collections, input.uid);
    const sessionRef = scoped.sessionDoc();

    const nowMs = Date.now();
    const userCreatedAt = new Date(nowMs).toISOString();
    const assistantCreatedAt = new Date(nowMs + 1).toISOString();

    const userMessage: LoungeMessageDoc = {
      id: `msg_${nowMs}_u_${crypto.randomUUID().slice(0, 8)}`,
      sessionId: input.sessionId,
      uid: input.uid,
      role: 'USER',
      content: input.userContent,
      emotion: input.userEmotion,
      createdAt: userCreatedAt,
    };

    const trimmedThought = input.assistantThought?.trim();
    const assistantMessage: LoungeMessageDoc = {
      id: `msg_${nowMs + 1}_a_${crypto.randomUUID().slice(0, 8)}`,
      sessionId: input.sessionId,
      uid: input.uid,
      role: 'ASSISTANT',
      content: input.assistantContent,
      ...(trimmedThought ? { thought: trimmedThought } : {}),
      emotion: input.assistantEmotion,
      ...(input.imageAssetId ? { imageAssetId: input.imageAssetId } : {}),
      ...(input.imageUrl ? { imageUrl: input.imageUrl } : {}),
      tokenUsage: input.assistantTokenUsage,
      createdAt: assistantCreatedAt,
    };

    const session = await this.firestore.runTransaction(async (tx: Transaction) => {
      const [userSnap, snap] = await Promise.all([tx.get(scoped.userDoc()), tx.get(sessionRef)]);
      const userDoc = userSnap.data();
      if (!userSnap.exists || !userDoc || userDoc.status !== 'ACTIVE') {
        throw new LoungeAuthError(403, 'Private Lounge account is not active');
      }

      const existing = snap.data();
      const baseSession: LoungeSessionDoc =
        snap.exists && existing
          ? scoped.assertOwned(existing, COLLECTIONS.LOUNGE_SESSIONS)
          : {
              id: input.uid,
              uid: input.uid,
              title: 'Private Lounge',
              messageCount: 0,
              currentEmotion: 'NEUTRAL',
              publicXMemorySyncedAt: input.publicXMemorySyncedAt ?? userCreatedAt,
              lastMessagePreview: '',
              createdAt: userCreatedAt,
              updatedAt: userCreatedAt,
            };

      const nextSession: LoungeSessionDoc = {
        ...baseSession,
        messageCount: baseSession.messageCount + 2,
        currentEmotion: input.assistantEmotion,
        lastMessagePreview: input.assistantContent.slice(0, 120),
        ...(input.publicXMemorySyncedAt
          ? { publicXMemorySyncedAt: input.publicXMemorySyncedAt }
          : {}),
        updatedAt: assistantCreatedAt,
      };

      tx.set(sessionRef, nextSession);
      tx.set(this.collections.loungeMessages.doc(userMessage.id), userMessage);
      tx.set(this.collections.loungeMessages.doc(assistantMessage.id), assistantMessage);
      return nextSession;
    });

    return {
      session,
      userMessage: toPublicLoungeMessage(userMessage),
      assistantMessage: toPublicLoungeMessage(assistantMessage),
    };
  }

  /**
   * Indexes a turn summary vector in `lounge_rag_memories` and appends turns to `lounge_users.episodicBuffer`
   * for Nightly Batch Dreaming consolidation.
   */
  public async indexPrivateTurnMemory(input: {
    readonly uid: string;
    readonly sessionId: string;
    readonly category: LoungeMemoryCategory;
    readonly summary: string;
    readonly embedding: readonly number[];
    readonly salienceScore: number;
    readonly episodicEntries: ReadonlyArray<ConversationLogEntry>;
  }): Promise<void> {
    assertLoungeRecordOwnedByUid({ uid: input.uid }, input.uid, COLLECTIONS.LOUNGE_RAG_MEMORIES);
    const nowIso = new Date().toISOString();
    const scoped = createUserScopedLoungeSessionDb(this.collections, input.uid);

    if (input.embedding.length > 0 && input.summary.trim().length > 0) {
      const ragDoc: LoungeRagMemoryDoc = {
        id: `mem_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
        uid: input.uid,
        sessionId: input.sessionId,
        category: input.category,
        summary: input.summary.trim(),
        embedding: [...input.embedding],
        salienceScore: input.salienceScore,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      await this.collections.loungeRagMemories.doc(ragDoc.id).set(ragDoc);
      const overflowSnap = await scoped
        .ragMemoriesQuery()
        .orderBy('updatedAt', 'desc')
        .limit(MAX_LOUNGE_RAG_MEMORIES + 20)
        .get();
      if (overflowSnap.docs.length > MAX_LOUNGE_RAG_MEMORIES) {
        const pruneBatch = this.firestore.batch();
        for (const staleDoc of overflowSnap.docs.slice(MAX_LOUNGE_RAG_MEMORIES)) {
          pruneBatch.delete(staleDoc.ref);
        }
        await pruneBatch.commit();
      }
    }

    if (input.episodicEntries.length > 0) {
      const userRef = this.collections.loungeUsers.doc(input.uid);
      await this.firestore.runTransaction(async (tx: Transaction) => {
        const snap = await tx.get(userRef);
        const existing = snap.data();
        if (!snap.exists || !existing || existing.status === 'DELETING') {
          return;
        }
        const combined = [...(existing.episodicBuffer ?? []), ...input.episodicEntries].slice(
          -MAX_EPISODIC_BUFFER_ENTRIES,
        );
        tx.set(userRef, {
          ...existing,
          episodicBuffer: combined,
          updatedAt: nowIso,
        });
      });
    }
  }

  /**
   * Permanently deletes the user's single session document, all raw messages in
   * `lounge_messages`, and all episodic vectors in `lounge_rag_memories` on withdrawal.
   */
  public async deleteAllUserSessionData(uid: string): Promise<void> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_SESSIONS);
    const scoped = createUserScopedLoungeSessionDb(this.collections, uid);
    await deleteQueryInBatches(this.firestore, scoped.messagesQuery());
    await deleteQueryInBatches(this.firestore, scoped.ragMemoriesQuery());
    await scoped.sessionDoc().delete();
  }
}
