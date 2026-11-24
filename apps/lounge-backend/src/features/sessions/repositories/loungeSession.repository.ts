import crypto from 'node:crypto';
import { FieldValue, type Firestore, type Transaction } from '@google-cloud/firestore';
import {
  COLLECTIONS,
  assertLoungeRecordOwnedByUid,
  createUserScopedLoungeDb,
  type DbCollections,
} from '@rebecca/db';
import type {
  ConversationLogEntry,
  LoungeEmotionState,
  LoungeMemoryCategory,
  LoungeMessage,
  LoungeMessageDoc,
  LoungeMessageListResponseDto,
  LoungePaginationQueryDto,
  LoungeRagMemory,
  LoungeRagMemoryDoc,
  LoungeSession,
  LoungeSessionDoc,
  LoungeTokenUsage,
} from '@rebecca/types';
import { normalizePaginationLimit, normalizePaginationQuery } from '../../../utils/errors';
import { deleteQueryInBatches } from '../../../utils/firestoreBatch';

const MAX_EPISODIC_BUFFER_ENTRIES = 40;

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
    query?: LoungePaginationQueryDto,
  ): Promise<LoungeMessageListResponseDto>;
  listRecentMessages(uid: string, limit?: number): Promise<LoungeMessage[]>;
  searchPrivateRagMemoriesByVector(
    uid: string,
    queryEmbedding: readonly number[],
    limit?: number,
  ): Promise<LoungeRagMemory[]>;
  appendMessagePair(input: AppendLoungeMessagePairInput): Promise<AppendLoungeMessagePairResult>;
  indexPrivateTurnMemory?(input: {
    readonly uid: string;
    readonly sessionId: string;
    readonly category: LoungeMemoryCategory;
    readonly summary: string;
    readonly embedding: readonly number[];
    readonly salienceScore: number;
    readonly episodicEntries: ReadonlyArray<ConversationLogEntry>;
  }): Promise<void>;
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
      | 'loungeUsers'
      | 'loungeSubscriptions'
      | 'loungeSessions'
      | 'loungeMessages'
      | 'loungeRagMemories'
      | 'loungeGallery'
      | 'loungeCreditLots'
      | 'loungeQuotaLedger'
    >,
    private readonly isEmulator: boolean = Boolean(process.env['FIRESTORE_EMULATOR_HOST']),
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
    const scoped = createUserScopedLoungeDb(this.collections, uid);
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
   * Lists paginated messages ordered chronologically (`[oldest..newest]`) per page for `uid`'s single session.
   * Supports backward cursor pagination (`cursor = oldestLoadedMessageId`) and numbered page offset fallback.
   */
  public async listMessages(
    uid: string,
    query?: LoungePaginationQueryDto,
  ): Promise<LoungeMessageListResponseDto> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_MESSAGES);
    const safeQuery = normalizePaginationQuery(query);
    const scoped = createUserScopedLoungeDb(this.collections, uid);

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

    if (safeQuery.cursor) {
      const cursorSnap = await this.collections.loungeMessages.doc(safeQuery.cursor).get();
      if (cursorSnap.exists && cursorSnap.data()?.uid === uid) {
        descQuery = descQuery.startAfter(cursorSnap);
      }
    } else if (safeQuery.page > 1) {
      const offsetCount = (safeQuery.page - 1) * safeQuery.limit;
      descQuery = descQuery.offset(offsetCount);
    }

    const snap = await descQuery.limit(safeQuery.limit + 1).get();
    const hasMore = snap.docs.length > safeQuery.limit;
    const pageDocs = snap.docs
      .slice(0, safeQuery.limit)
      .map((d) => scoped.assertOwned(d.data(), COLLECTIONS.LOUNGE_MESSAGES));

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

  /** Queries the latest `limit` messages (`createdAt DESC` index) returned oldest-to-newest for LLM context. */
  public async listRecentMessages(uid: string, limit?: number): Promise<LoungeMessage[]> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_MESSAGES);
    const safeLimit = this.clampLimit(limit);
    const scoped = createUserScopedLoungeDb(this.collections, uid);
    const snap = await scoped
      .messagesQuery()
      .orderBy('createdAt', 'desc')
      .limit(safeLimit)
      .get();

    return snap.docs
      .map((d) => scoped.assertOwned(d.data(), COLLECTIONS.LOUNGE_MESSAGES))
      .reverse();
  }

  /** Executes cosine vector search over isolated `lounge_rag_memories` owned by `uid`. */
  public async searchPrivateRagMemoriesByVector(
    uid: string,
    queryEmbedding: readonly number[],
    limit?: number,
  ): Promise<LoungeRagMemory[]> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_RAG_MEMORIES);
    const safeLimit = Math.min(this.clampLimit(limit), 10);
    const scoped = createUserScopedLoungeDb(this.collections, uid);

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

  /** Appends user and assistant message documents atomically and updates singleton session metadata. */
  public async appendMessagePair(
    input: AppendLoungeMessagePairInput,
  ): Promise<AppendLoungeMessagePairResult> {
    assertLoungeRecordOwnedByUid({ uid: input.uid }, input.uid, COLLECTIONS.LOUNGE_MESSAGES);
    const scoped = createUserScopedLoungeDb(this.collections, input.uid);
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

    const assistantMessage: LoungeMessageDoc = {
      id: `msg_${nowMs + 1}_a_${crypto.randomUUID().slice(0, 8)}`,
      sessionId: input.sessionId,
      uid: input.uid,
      role: 'ASSISTANT',
      content: input.assistantContent,
      emotion: input.assistantEmotion,
      ...(input.imageAssetId ? { imageAssetId: input.imageAssetId } : {}),
      ...(input.imageUrl ? { imageUrl: input.imageUrl } : {}),
      tokenUsage: input.assistantTokenUsage,
      createdAt: assistantCreatedAt,
    };

    const session = await this.firestore.runTransaction(async (tx: Transaction) => {
      const snap = await tx.get(sessionRef);
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
              publicXMemorySyncedAt: userCreatedAt,
              lastMessagePreview: '',
              createdAt: userCreatedAt,
              updatedAt: userCreatedAt,
            };

      const nextSession: LoungeSessionDoc = {
        ...baseSession,
        messageCount: baseSession.messageCount + 2,
        currentEmotion: input.assistantEmotion,
        lastMessagePreview: input.assistantContent.slice(0, 120),
        updatedAt: assistantCreatedAt,
      };

      tx.set(sessionRef, nextSession);
      tx.set(this.collections.loungeMessages.doc(userMessage.id), userMessage);
      tx.set(this.collections.loungeMessages.doc(assistantMessage.id), assistantMessage);
      return nextSession;
    });

    return {
      session,
      userMessage,
      assistantMessage,
    };
  }

  /**
   * Asynchronously indexes a single turn summary vector in `lounge_rag_memories` and appends
   * recent turns to `lounge_users.episodicBuffer` for Nightly Batch Dreaming consolidation.
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
    const scoped = createUserScopedLoungeDb(this.collections, uid);
    await deleteQueryInBatches(this.firestore, scoped.messagesQuery());
    await deleteQueryInBatches(this.firestore, scoped.ragMemoriesQuery());
    await scoped.sessionDoc().delete();
  }
}
