import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { Firestore, QueryDocumentSnapshot } from '@google-cloud/firestore';
import type { DbCollections } from '@rebecca/db';
import {
  DreamingConsolidationEngine,
  hasUnconsolidatedActivity,
  type DreamingExecutionResult,
  type IDreamingMemoryStore,
  type IDreamingSynthesizer,
  type MemoryUserSnapshot,
} from '@rebecca/memory';
import { getActivePersona, type IPersonaDefinition } from '@rebecca/persona';
import type { ConversationLogEntry, LoungeUserDoc, UserCoreProfile } from '@rebecca/types';
import { extractTraceHeader } from '../../utils/errors';
import { loungeLogger, toSingleLineLog } from '../../utils/logger';

const MAX_RETAINED_EPISODIC_ENTRIES = 40;
const DREAMING_RETAINED_WINDOW = 12;

interface DreamingCandidateMarker {
  readonly updatedAt: string;
  readonly lastEntry?: ConversationLogEntry;
}

/**
 * Private Lounge Dreaming store adapter over isolated `lounge_users` profiles and episodic buffers.
 * Scans active users via cursor pagination to avoid starvation past the first 200 accounts and merges
 * concurrent `episodicBuffer` appends inside transactions.
 */
export class FirestoreLoungeDreamingStore implements IDreamingMemoryStore<MemoryUserSnapshot> {
  private readonly candidateMarkers = new Map<string, DreamingCandidateMarker>();

  constructor(
    private readonly firestore: Firestore,
    private readonly collections: Pick<DbCollections, 'loungeUsers'>,
    private readonly maxCandidatesPerRun: number = 200,
    private readonly scanPageSize: number = 200,
  ) {}

  /**
   * Cursor-scans `ACTIVE` `lounge_users` documents and selects up to `maxCandidatesPerRun` accounts
   * with unconsolidated episodic activity.
   */
  public async listConsolidationCandidates(): Promise<MemoryUserSnapshot[]> {
    this.candidateMarkers.clear();
    const candidates: MemoryUserSnapshot[] = [];
    let lastDoc: QueryDocumentSnapshot<LoungeUserDoc> | null = null;

    while (candidates.length < this.maxCandidatesPerRun) {
      let query = this.collections.loungeUsers
        .where('status', '==', 'ACTIVE')
        .orderBy('__name__', 'asc');
      if (lastDoc) {
        query = query.startAfter(lastDoc);
      }
      const snap = await query.limit(this.scanPageSize).get();
      if (snap.empty) {
        break;
      }

      for (const docSnap of snap.docs) {
        const user = docSnap.data();
        const snapshot: MemoryUserSnapshot = {
          id: user.uid,
          name: user.displayName,
          username: user.xHandle,
          coreProfile: user.coreProfile,
          episodicBuffer: user.episodicBuffer,
          lastSeen: user.updatedAt,
          lastDreamedAt: user.lastDreamedAt,
        };
        if (hasUnconsolidatedActivity(snapshot)) {
          const buffer = user.episodicBuffer ?? [];
          this.candidateMarkers.set(user.uid, {
            updatedAt: user.updatedAt,
            lastEntry: buffer.length > 0 ? buffer[buffer.length - 1] : undefined,
          });
          candidates.push(snapshot);
          if (candidates.length >= this.maxCandidatesPerRun) {
            break;
          }
        }
      }

      if (snap.docs.length < this.scanPageSize) {
        break;
      }
      lastDoc = snap.docs[snap.docs.length - 1];
    }

    return candidates;
  }

  /**
   * Transactionally persists consolidated `coreProfile` while preserving any new `episodicBuffer`
   * entries appended concurrently after candidate snapshot capture.
   */
  public async updateCoreProfile(
    userId: string,
    coreProfile: UserCoreProfile,
    retainedBuffer: readonly ConversationLogEntry[],
    dreamedAt: string,
  ): Promise<void> {
    const ref = this.collections.loungeUsers.doc(userId);
    const marker = this.candidateMarkers.get(userId);
    try {
      await this.firestore.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const existing = snap.data();
        if (!snap.exists || !existing || existing.status !== 'ACTIVE') {
          return;
        }

        const existingBuffer = existing.episodicBuffer ?? [];
        const newlyArrived = extractConcurrentBufferEntries(existingBuffer, marker);
        const mergedBuffer = [...retainedBuffer, ...newlyArrived].slice(
          -MAX_RETAINED_EPISODIC_ENTRIES,
        );

        let nextUpdatedAt = dreamedAt;
        if (newlyArrived.length > 0) {
          const dreamedMs = Date.parse(dreamedAt);
          const existingMs = Date.parse(existing.updatedAt);
          const minFutureMs = (Number.isFinite(dreamedMs) ? dreamedMs : Date.now()) + 1;
          nextUpdatedAt = new Date(
            Math.max(minFutureMs, Number.isFinite(existingMs) ? existingMs : minFutureMs),
          ).toISOString();
        }

        tx.set(ref, {
          ...existing,
          coreProfile,
          episodicBuffer: mergedBuffer,
          lastDreamedAt: dreamedAt,
          updatedAt: nextUpdatedAt,
        });
      });
    } finally {
      this.candidateMarkers.delete(userId);
    }
  }
}

function extractConcurrentBufferEntries(
  currentBuffer: readonly ConversationLogEntry[],
  marker: DreamingCandidateMarker | undefined,
): ConversationLogEntry[] {
  if (!marker || currentBuffer.length === 0) {
    return [];
  }
  const { lastEntry, updatedAt } = marker;
  if (lastEntry) {
    for (let i = currentBuffer.length - 1; i >= 0; i -= 1) {
      const candidate = currentBuffer[i];
      if (
        candidate.role === lastEntry.role &&
        candidate.content === lastEntry.content &&
        candidate.timestamp === lastEntry.timestamp
      ) {
        return currentBuffer.slice(i + 1);
      }
    }
  }
  return currentBuffer.filter(
    (entry) => typeof entry.timestamp === 'string' && entry.timestamp > updatedAt,
  );
}

/** Coordinates Nightly Batch Dreaming across `lounge_users` via `@rebecca/memory`. */
export class LoungeDreamingBatchService {
  private readonly persona: IPersonaDefinition;

  constructor(
    private readonly store: IDreamingMemoryStore<MemoryUserSnapshot>,
    private readonly synthesizer: IDreamingSynthesizer,
    activePersonaId: string,
    private readonly throttleMs = 4500,
  ) {
    this.persona = getActivePersona(activePersonaId);
  }

  /** Executes batch consolidation across pending Private Lounge users with request trace correlation. */
  public async runNightlyConsolidation(traceHeader?: string): Promise<DreamingExecutionResult> {
    const engine = new DreamingConsolidationEngine(
      {
        store: this.store,
        synthesizer: this.synthesizer,
        dreamingPrompt: () => this.persona.getDreamingPrompt(),
        logTag: '[LoungeDreaming]',
        logger: {
          info: (msg, meta) => loungeLogger.info(msg, meta, traceHeader),
          error: (msg, err, meta) => loungeLogger.error(msg, err, meta, traceHeader),
        },
      },
      { throttleMs: this.throttleMs, retainedBufferEntries: DREAMING_RETAINED_WINDOW },
    );
    return engine.execute();
  }
}

/** Mounts rate-limited internal OIDC-protected batch endpoints (`POST /dreaming` & `/lounge-dreaming`). */
export function createLoungeBatchRouter(
  dreamingService: LoungeDreamingBatchService,
  requireBatchAuth: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): Router {
  const router = Router();
  router.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 60,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  const handler = async (req: Request, res: Response): Promise<void> => {
    const traceHeader = extractTraceHeader(req);
    const safePath = toSingleLineLog(req.path);
    try {
      const summary = await dreamingService.runNightlyConsolidation(traceHeader);
      res.status(200).json(summary);
    } catch (err) {
      const normalized =
        err instanceof Error ? err : new Error('Nightly dreaming batch failed', { cause: err });
      loungeLogger.error(
        `Failed Private Lounge dreaming batch on ${safePath}`,
        normalized,
        undefined,
        traceHeader,
      );
      res.status(500).json({ error: 'Internal server error' });
    }
  };

  router.post('/dreaming', requireBatchAuth, handler);
  router.post('/lounge-dreaming', requireBatchAuth, handler);
  return router;
}
