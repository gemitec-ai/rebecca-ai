import { FieldValue, type Firestore } from '@google-cloud/firestore';
import { COLLECTIONS, type DbCollections } from '@rebecca/db';
import { getWorkingMemory } from '@rebecca/memory';
import { formatZonedDateTime } from '@rebecca/prompt';
import type { ConversationLogEntry, LoungePublicXMemorySnapshot } from '@rebecca/types';
import { normalizeIanaTimezoneOrDefault } from '../../../utils/locale';
import { loungeLogger, toSingleLineLog } from '../../../utils/logger';
import { DEFAULT_LOUNGE_TIMEZONE } from '../../billing/domain/loungeCatalog.constants';
import type { IPublicXMemoryReadPort } from '../ports/loungeAi.port';
import { computeCosineSimilarity } from '../repositories/loungeSession.repository';

/**
 * Strictly read-only bridge over Public X Bot memory (`users`, `rag_memories`, `conversation_logs`,
 * `system/persona`, `timeline_history`) that never mutates any Public Bot collection.
 */
export class FirestorePublicXMemoryReadAdapter implements IPublicXMemoryReadPort {
  constructor(
    private readonly firestore: Firestore,
    private readonly collections: Pick<
      DbCollections,
      'users' | 'ragMemories' | 'conversationLogs' | 'system' | 'timelineHistory'
    >,
    private readonly isEmulator: boolean = false,
  ) {}

  /** Reads Public X profile, RAG vectors (formatted in `userTimezone`), recent turns, and Layer 1-3 self memory read-only. */
  public async readPublicXMemorySnapshot(
    xUserId: string,
    queryEmbedding: readonly number[],
    userTimezone: string = DEFAULT_LOUNGE_TIMEZONE,
  ): Promise<LoungePublicXMemorySnapshot | null> {
    const trimmed = xUserId.trim();
    if (!trimmed) {
      return null;
    }
    const safeTimezone = normalizeIanaTimezoneOrDefault(userTimezone, DEFAULT_LOUNGE_TIMEZONE);

    const [userSnap, personaSnap, recentLogsSnap, recentPostsSnap] = await Promise.all([
      this.collections.users.doc(trimmed).get(),
      this.collections.system.doc('persona').get(),
      this.collections.conversationLogs
        .where('userId', '==', trimmed)
        .orderBy('timestamp', 'desc')
        .limit(6)
        .get(),
      this.collections.timelineHistory
        .orderBy('timestamp', 'desc')
        .limit(5)
        .get(),
    ]);

    const userData = userSnap.data();
    const personaData = personaSnap.data() as
      | { readonly extended_prompt?: string; readonly timeline_summary?: string }
      | undefined;

    let userVectorMemories: string[] = [];
    if (queryEmbedding.length > 0) {
      try {
        const ragSnap = await this.firestore
          .collection(COLLECTIONS.RAG_MEMORIES)
          .where('userId', '==', trimmed)
          .findNearest({
            vectorField: 'embedding',
            queryVector: FieldValue.vector([...queryEmbedding]),
            limit: 4,
            distanceMeasure: 'COSINE',
          })
          .get();
        userVectorMemories = ragSnap.docs
          .map((d) => {
            const raw = d.data() as { readonly text?: unknown; readonly timestamp?: unknown };
            const text = typeof raw['text'] === 'string' ? raw['text'].trim() : '';
            if (!text) {
              return '';
            }
            const rawTs = raw['timestamp'];
            const formattedTs =
              typeof rawTs === 'string' && rawTs.trim()
                ? formatZonedDateTime(rawTs, safeTimezone)
                : '';
            return formattedTs ? `[${formattedTs}] ${text}` : text;
          })
          .filter((t) => t.length > 0);
      } catch (err) {
        if (this.isEmulator) {
          const fallbackSnap = await this.collections.ragMemories
            .where('userId', '==', trimmed)
            .limit(40)
            .get();
          userVectorMemories = fallbackSnap.docs
            .map((d) => d.data())
            .map((doc) => ({
              text: doc.text,
              timestamp: doc.timestamp,
              score: computeCosineSimilarity(queryEmbedding, doc.embedding ?? []),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 4)
            .map((entry) => {
              const text = entry.text.trim();
              if (!text) {
                return '';
              }
              const formattedTs = entry.timestamp
                ? formatZonedDateTime(entry.timestamp, safeTimezone)
                : '';
              return formattedTs ? `[${formattedTs}] ${text}` : text;
            })
            .filter((t) => t.length > 0);
        } else {
          loungeLogger.warn('Failed Public X vector RAG read (continuing without X RAG)', {
            reason: toSingleLineLog(err instanceof Error ? err.message : String(err)),
          });
        }
      }
    }

    const bufferedTurns =
      userData?.episodicBuffer && userData.episodicBuffer.length > 0
        ? getWorkingMemory(userData.episodicBuffer, 6)
        : [];
    const rawLogTurns: ConversationLogEntry[] =
      bufferedTurns.length > 0
        ? bufferedTurns
        : [...recentLogsSnap.docs].reverse().flatMap((d) => {
            const raw = d.data();
            const pair: ConversationLogEntry[] = [];
            if (typeof raw.userText === 'string' && raw.userText.trim()) {
              pair.push({ role: 'user', content: raw.userText, timestamp: raw.timestamp });
            }
            if (typeof raw.aiText === 'string' && raw.aiText.trim()) {
              pair.push({
                role: 'model',
                content: raw.aiText,
                ...(raw.thought ? { thought: raw.thought } : {}),
                timestamp: raw.timestamp,
              });
            }
            return pair;
          });
    const userRecentTurns = rawLogTurns;

    const personaLayer3RecentPosts = recentPostsSnap.docs
      .map((d) => d.data().text)
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0);

    if (
      !userData &&
      userRecentTurns.length === 0 &&
      userVectorMemories.length === 0 &&
      !personaData?.extended_prompt &&
      !personaData?.timeline_summary &&
      personaLayer3RecentPosts.length === 0
    ) {
      return null;
    }

    const lastPublicReplyAt = userData?.lastReplyDate ?? userData?.lastSeen;
    return {
      xUserId: trimmed,
      ...(userData?.name ? { xDisplayName: userData.name } : {}),
      ...(userData?.username ? { xUsername: userData.username } : {}),
      ...(lastPublicReplyAt ? { lastPublicReplyAt } : {}),
      userStructuredProfile: userData?.coreProfile ?? null,
      userRecentTurns,
      userVectorMemories,
      personaLayer1ExtendedPrompt: personaData?.extended_prompt ?? '',
      personaLayer2TimelineSummary: personaData?.timeline_summary ?? '',
      personaLayer3RecentPosts,
      syncedAt: new Date().toISOString(),
    };
  }
}
