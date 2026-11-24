import { Router, type NextFunction, type Request, type Response } from 'express';
import type { Firestore } from '@google-cloud/firestore';
import type { DbCollections } from '@rebecca/db';
import {
  DreamingConsolidationEngine,
  type DreamingExecutionResult,
  type IDreamingMemoryStore,
  type IDreamingSynthesizer,
  type MemoryUserSnapshot,
} from '@rebecca/memory';
import { getActivePersona } from '@rebecca/persona';
import type { ConversationLogEntry, UserCoreProfile } from '@rebecca/types';
import { extractTraceHeader } from '../../utils/errors';
import { loungeLogger, sanitizeLogInput } from '../../utils/logger';

/**
 * Private Lounge Dreaming store adapter over isolated `lounge_users` profiles and episodic buffers.
 * Maps `updatedAt` -> `lastSeen` so `@rebecca/memory` detects unconsolidated turns cleanly.
 */
export class FirestoreLoungeDreamingStore implements IDreamingMemoryStore<MemoryUserSnapshot> {
  constructor(
    private readonly firestore: Firestore,
    private readonly collections: Pick<DbCollections, 'loungeUsers'>,
  ) {}

  /** Queries `lounge_users` snapshots with active accounts eligible for nightly consolidation. */
  public async listConsolidationCandidates(): Promise<MemoryUserSnapshot[]> {
    const snap = await this.collections.loungeUsers
      .where('status', '==', 'ACTIVE')
      .limit(200)
      .get();

    return snap.docs.map((docSnap) => {
      const user = docSnap.data();
      return {
        id: user.uid,
        name: user.displayName,
        username: user.xHandle,
        coreProfile: user.coreProfile,
        episodicBuffer: user.episodicBuffer,
        lastSeen: user.updatedAt,
        lastDreamedAt: user.lastDreamedAt,
      };
    });
  }

  /** Persists consolidated `coreProfile`, sliced sliding window buffer, and `lastDreamedAt`. */
  public async updateCoreProfile(
    userId: string,
    coreProfile: UserCoreProfile,
    retainedBuffer: readonly ConversationLogEntry[],
    dreamedAt: string,
  ): Promise<void> {
    const ref = this.collections.loungeUsers.doc(userId);
    await this.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const existing = snap.data();
      if (!snap.exists || !existing || existing.status === 'DELETING') {
        return;
      }
      tx.set(ref, {
        ...existing,
        coreProfile,
        episodicBuffer: [...retainedBuffer],
        lastDreamedAt: dreamedAt,
        updatedAt: dreamedAt,
      });
    });
  }
}

/** Coordinates Nightly Batch Dreaming across `lounge_users` via `@rebecca/memory`. */
export class LoungeDreamingBatchService {
  private readonly engine: DreamingConsolidationEngine<MemoryUserSnapshot>;

  constructor(
    store: IDreamingMemoryStore<MemoryUserSnapshot>,
    synthesizer: IDreamingSynthesizer,
    activePersonaId: string,
    throttleMs = 4500,
  ) {
    const persona = getActivePersona(activePersonaId);
    this.engine = new DreamingConsolidationEngine(
      {
        store,
        synthesizer,
        dreamingPrompt: () => persona.getDreamingPrompt(),
        logTag: '[LoungeDreaming]',
        logger: {
          info: (msg, meta) => loungeLogger.info(msg, meta),
          error: (msg, err, meta) => loungeLogger.error(msg, err, meta),
        },
      },
      { throttleMs, retainedBufferEntries: 12 },
    );
  }

  /** Executes batch consolidation across pending Private Lounge users. */
  public async runNightlyConsolidation(): Promise<DreamingExecutionResult> {
    return this.engine.execute();
  }
}

/** Mounts internal OIDC-protected batch endpoints (`POST /dreaming` & `/lounge-dreaming`). */
export function createLoungeBatchRouter(
  dreamingService: LoungeDreamingBatchService,
  requireBatchAuth: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): Router {
  const router = Router();
  const handler = async (req: Request, res: Response): Promise<void> => {
    const traceHeader = extractTraceHeader(req);
    try {
      const summary = await dreamingService.runNightlyConsolidation();
      res.status(200).json(summary);
    } catch (err) {
      const normalized =
        err instanceof Error ? err : new Error('Nightly dreaming batch failed', { cause: err });
      loungeLogger.error(
        `Failed Private Lounge dreaming batch on ${sanitizeLogInput(req.path)}`,
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
