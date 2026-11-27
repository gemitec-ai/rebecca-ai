import crypto from 'node:crypto';
import type { GoogleGenAI } from '@google/genai';
import { Timestamp, type Firestore } from '@google-cloud/firestore';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import request from 'supertest';
import { getActivePersona } from '@rebecca/persona';
import { COLLECTIONS, getCollections } from '@rebecca/db';
import {
  AssetStatus,
  type LoungeUserDisclaimerConsent,
} from '@rebecca/types';
import { loadTrialHmacKeyring } from '../../src/config/loungeConfig';
import { LoungeAccountRepository } from '../../src/features/account/repositories/loungeAccount.repository';
import {
  createFirebaseIdentityClient,
  FirebaseLoungeAuthVerifier,
} from '../../src/features/auth/adapters/firebaseLoungeAuth.verifier';
import { LoungeAuthRepository } from '../../src/features/auth/repositories/loungeAuth.repository';
import {
  createLoungeBatchRouter,
  FirestoreLoungeDreamingStore,
  LoungeDreamingBatchService,
} from '../../src/features/dreaming/loungeDreaming.service';
import { LoungeGalleryRepository } from '../../src/features/gallery/repositories/loungeGallery.repository';
import { FirestoreBotImageVectorSearchAdapter } from '../../src/features/sessions/adapters/firestoreBotImageVectorSearch.adapter';
import { FirestorePublicXMemoryReadAdapter } from '../../src/features/sessions/adapters/firestorePublicXMemoryRead.adapter';
import {
  GeminiLoungeAiAdapter,
  parseAndNormalizeCoreProfile,
} from '../../src/features/sessions/adapters/geminiLoungeAi.adapters';
import {
  buildDeterministicTestEmbedding,
  LocalEmulatorLoungeAiAdapter,
} from '../../src/features/sessions/adapters/localEmulatorLoungeAi.adapter';
import { LoungeIllustrationMatcherService } from '../../src/features/sessions/domain/loungeIllustrationMatcher.service';
import {
  buildLoungeChannelGuidelines,
  composeLoungeDialoguePrompt,
} from '../../src/features/sessions/domain/loungePrompt.composer';
import {
  computeCosineSimilarity,
  LoungeSessionRepository,
} from '../../src/features/sessions/repositories/loungeSession.repository';
import { createLoungeBatchAuthMiddleware } from '../../src/middleware/loungeBatchAuth';
import { deleteQueryInBatches } from '../../src/utils/firestoreBatch';

jest.mock('firebase-admin/app', () => ({
  initializeApp: jest.fn().mockReturnValue({ name: 'lounge-bff-auth' }),
  getApps: jest.fn().mockReturnValue([]),
  getApp: jest.fn().mockReturnValue({ name: '[DEFAULT]' }),
}));

jest.mock('firebase-admin/auth', () => {
  const baseAuthMock = {
    verifyIdToken: jest.fn(),
    revokeRefreshTokens: jest.fn(),
    deleteUser: jest.fn(),
    tenantManager: jest.fn().mockReturnValue({
      authForTenant: jest.fn().mockReturnValue({
        verifyIdToken: jest.fn(),
        revokeRefreshTokens: jest.fn(),
        deleteUser: jest.fn(),
      }),
    }),
  };
  return {
    getAuth: jest.fn().mockReturnValue(baseAuthMock),
  };
});

interface FakeConverter<T> {
  toFirestore(data: T): Record<string, unknown>;
  fromFirestore(snap: { id: string; data(): Record<string, unknown> }): T;
}

interface FakeFilter {
  readonly field: string;
  readonly op: string;
  readonly value: unknown;
}

interface FakeOrderBy {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}

function cloneFirestoreValue<V>(val: V): V {
  if (val instanceof Timestamp) {
    return new Timestamp(val.seconds, val.nanoseconds) as unknown as V;
  }
  if (val instanceof Date) {
    return new Date(val.getTime()) as unknown as V;
  }
  if (
    typeof val === 'object' &&
    val !== null &&
    'toArray' in val &&
    typeof (val as { toArray?: unknown }).toArray === 'function'
  ) {
    const arr = [...(val as { toArray(): number[] }).toArray()];
    return { toArray: () => [...arr] } as unknown as V;
  }
  if (Array.isArray(val)) {
    return val.map((item) => cloneFirestoreValue(item)) as unknown as V;
  }
  if (typeof val === 'object' && val !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      if (v !== undefined) {
        out[k] = cloneFirestoreValue(v);
      }
    }
    return out as V;
  }
  return val;
}

function createVectorCapableFirestore(options: { failFindNearest?: boolean } = {}) {
  const store = new Map<string, Map<string, Record<string, unknown>>>();

  const ensureCollectionMap = (name: string): Map<string, Record<string, unknown>> => {
    let map = store.get(name);
    if (!map) {
      map = new Map<string, Record<string, unknown>>();
      store.set(name, map);
    }
    return map;
  };

  const readField = (raw: Record<string, unknown>, id: string, field: string): unknown => {
    if (field === '__name__') {
      return id;
    }
    return raw[field];
  };

  const compareValues = (a: unknown, b: unknown): number => {
    if (a === b) return 0;
    if (typeof a === 'boolean' && typeof b === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a ?? '').localeCompare(String(b ?? ''));
  };

  const makeDocRef = <T>(
    collectionName: string,
    id: string,
    converter?: FakeConverter<T>,
  ) => {
    const colMap = ensureCollectionMap(collectionName);
    const refObj = {
      id,
      path: `${collectionName}/${id}`,
      collectionName,
      get: async () => {
        const raw = colMap.get(id);
        if (!raw) {
          return { id, ref: refObj, exists: false, data: () => undefined };
        }
        const clone = cloneFirestoreValue(raw);
        const data = converter
          ? converter.fromFirestore({ id, data: () => clone })
          : (clone as unknown as T);
        return { id, ref: refObj, exists: true, data: () => data };
      },
      set: async (data: T) => {
        const serialized = converter
          ? converter.toFirestore(data)
          : (cloneFirestoreValue(data) as unknown as Record<string, unknown>);
        colMap.set(id, cloneFirestoreValue(serialized));
      },
      delete: async () => {
        colMap.delete(id);
      },
    };
    return refObj;
  };

  const makeQuery = <T>(
    collectionName: string,
    converter: FakeConverter<T> | undefined,
    filters: FakeFilter[] = [],
    orders: FakeOrderBy[] = [],
    limitCount?: number,
    offsetCount?: number,
    afterId?: string,
  ) => {
    const evaluateRows = () => {
      const colMap = ensureCollectionMap(collectionName);
      let entries = Array.from(colMap.entries()).map(([id, raw]) => {
        const clone = cloneFirestoreValue(raw);
        const data = converter
          ? converter.fromFirestore({ id, data: () => clone })
          : (clone as unknown as T);
        return { id, raw: clone, data };
      });

      for (const f of filters) {
        entries = entries.filter(({ id, raw, data }) => {
          const obj = data as unknown as Record<string, unknown>;
          const candidate =
            obj[f.field] !== undefined ? obj[f.field] : readField(raw, id, f.field);
          if (f.op === '==') {
            return candidate === f.value;
          }
          if (f.op === 'in' && Array.isArray(f.value)) {
            return f.value.includes(candidate);
          }
          return false;
        });
      }

      if (orders.length > 0) {
        entries.sort((a, b) => {
          for (const o of orders) {
            const left = readField(a.data as unknown as Record<string, unknown>, a.id, o.field);
            const right = readField(b.data as unknown as Record<string, unknown>, b.id, o.field);
            const cmp = compareValues(left, right);
            if (cmp !== 0) {
              return o.direction === 'desc' ? -cmp : cmp;
            }
          }
          return 0;
        });
      }

      if (afterId) {
        const idx = entries.findIndex((e) => e.id === afterId);
        if (idx !== -1) {
          entries = entries.slice(idx + 1);
        }
      }
      if (offsetCount && offsetCount > 0) {
        entries = entries.slice(offsetCount);
      }
      if (limitCount !== undefined) {
        entries = entries.slice(0, limitCount);
      }
      return entries;
    };

    const queryObj = {
      where(field: string, op: string, value: unknown) {
        return makeQuery(
          collectionName,
          converter,
          [...filters, { field, op, value }],
          orders,
          limitCount,
          offsetCount,
          afterId,
        );
      },
      orderBy(field: string, direction: 'asc' | 'desc' = 'asc') {
        return makeQuery(
          collectionName,
          converter,
          filters,
          [...orders, { field, direction }],
          limitCount,
          offsetCount,
          afterId,
        );
      },
      startAfter(cursorSnap: { id: string }) {
        return makeQuery(
          collectionName,
          converter,
          filters,
          orders,
          limitCount,
          offsetCount,
          cursorSnap.id,
        );
      },
      offset(n: number) {
        return makeQuery(collectionName, converter, filters, orders, limitCount, n, afterId);
      },
      limit(n: number) {
        return makeQuery(collectionName, converter, filters, orders, n, offsetCount, afterId);
      },
      count() {
        return {
          get: async () => ({
            data: () => ({ count: evaluateRows().length }),
          }),
        };
      },
      findNearest(nearestOpts: {
        readonly vectorField: string;
        readonly queryVector: { toArray?: () => number[] };
        readonly limit: number;
        readonly distanceResultField?: string;
      }) {
        return {
          get: async () => {
            if (options.failFindNearest) {
              throw new Error('Vector index unavailable');
            }
            const vecObj = nearestOpts.queryVector as unknown as {
              readonly _values?: number[];
              toArray?: () => number[];
            };
            const qVec = vecObj.toArray?.() ?? vecObj._values ?? [];
            const rows = evaluateRows()
              .map((row) => {
                const rawRecord = row.data as unknown as Record<string, unknown>;
                const targetVec = Array.isArray(rawRecord[nearestOpts.vectorField])
                  ? (rawRecord[nearestOpts.vectorField] as number[])
                  : [];
                const sim = computeCosineSimilarity(qVec, targetVec);
                const distance = 1 - sim;
                const withDistance = nearestOpts.distanceResultField
                  ? { ...rawRecord, [nearestOpts.distanceResultField]: distance }
                  : rawRecord;
                return { row, withDistance, distance };
              })
              .sort((a, b) => a.distance - b.distance)
              .slice(0, nearestOpts.limit);

            const docs = rows.map(({ row, withDistance }) => ({
              id: row.id,
              exists: true,
              ref: makeDocRef(collectionName, row.id, converter),
              data: () => withDistance,
            }));
            return { docs, empty: docs.length === 0, size: docs.length };
          },
        };
      },
      get: async () => {
        const rows = evaluateRows();
        const docs = rows.map((row) => ({
          id: row.id,
          exists: true,
          ref: makeDocRef(collectionName, row.id, converter),
          data: () => row.data,
        }));
        return { docs, empty: docs.length === 0, size: docs.length };
      },
    };
    return queryObj;
  };

  const makeCollection = <T>(collectionName: string, converter?: FakeConverter<T>) => {
    const baseQuery = makeQuery<T>(collectionName, converter);
    return {
      ...baseQuery,
      withConverter<U>(nextConverter: FakeConverter<U>) {
        return makeCollection<U>(collectionName, nextConverter);
      },
      doc(id?: string) {
        return makeDocRef(collectionName, id ?? `auto_${crypto.randomUUID().slice(0, 8)}`, converter);
      },
    };
  };

  const firestoreInstance = {
    collection: (name: string) => makeCollection(name),
    getAll: async (...refs: Array<{ get: () => Promise<unknown> }>) =>
      Promise.all(refs.map((r) => r.get())),
    batch: () => {
      const ops: Array<() => Promise<void>> = [];
      return {
        delete: (ref: { delete: () => Promise<void> }) => {
          ops.push(() => ref.delete());
        },
        set: <T>(ref: { set: (data: T) => Promise<void> }, data: T) => {
          ops.push(() => ref.set(data));
        },
        commit: async () => {
          for (const op of ops) {
            await op();
          }
        },
      };
    },
    runTransaction: async <R>(fn: (tx: unknown) => Promise<R>): Promise<R> => {
      const stagedWrites: Array<() => Promise<void>> = [];
      const tx = {
        get: async (target: { get: () => Promise<unknown> }) => target.get(),
        set: <T>(ref: { set: (data: T) => Promise<void> }, data: T) => {
          stagedWrites.push(() => ref.set(data));
        },
        delete: (ref: { delete: () => Promise<void> }) => {
          stagedWrites.push(() => ref.delete());
        },
      };
      const result = await fn(tx);
      for (const write of stagedWrites) {
        await write();
      }
      return result;
    },
  };

  return {
    firestore: firestoreInstance as unknown as Firestore,
    store,
  };
}

function createConsent(version = 1): LoungeUserDisclaimerConsent {
  return {
    disclaimerVersion: version,
    agreedToGeminiTrainingUsage: true,
    agreedToZeroPiiProhibition: true,
    agreedToOneWayMemoryIsolation: true,
    scrolledToBottomAt: '2026-11-22T12:00:00.000Z',
    consentedAt: '2026-11-22T12:00:05.000Z',
  };
}

describe('Private Lounge Repositories, Auth Verifier, Batch Auth, AI Adapters & Dreaming', () => {
  describe('FirebaseLoungeAuthVerifier & Cloud Scheduler Batch Auth', () => {
    it('resolves tenant-aware Firebase Identity clients and verifies X identities & emulator tokens', async () => {
      (getApps as jest.Mock).mockReturnValueOnce([]);
      createFirebaseIdentityClient('proj-1', 'tenant-lounge');
      expect(initializeApp).toHaveBeenCalledWith({ projectId: 'proj-1' }, 'lounge-bff-auth');

      (getApps as jest.Mock).mockReturnValueOnce([{ name: 'lounge-bff-auth' }]);
      createFirebaseIdentityClient('proj-1');
      expect(getAuth).toHaveBeenCalled();

      (getApps as jest.Mock).mockReturnValue([{ name: '[DEFAULT]' }]);
      createFirebaseIdentityClient('');
      expect(getApp).toHaveBeenCalled();
      (getApps as jest.Mock).mockReset().mockReturnValue([]);

      const mockAuth = {
        verifyIdToken: jest.fn(),
        revokeRefreshTokens: jest.fn(),
        deleteUser: jest.fn(),
      };
      const verifier = new FirebaseLoungeAuthVerifier(mockAuth, false);
      mockAuth.verifyIdToken.mockResolvedValueOnce({
        uid: 'u_fb_1',
        name: 'X User',
        picture: 'https://example.com/ava.png',
        xHandle: '@x_user',
        firebase: { identities: { 'twitter.com': ['998877'] } },
      });
      const verified = await verifier.verifyBearerToken('tok-1');
      expect(mockAuth.verifyIdToken).toHaveBeenCalledWith('tok-1', true);
      expect(verified).toEqual({
        uid: 'u_fb_1',
        xUserId: '998877',
        xHandle: '@x_user',
        displayName: 'X User',
        avatarUrl: 'https://example.com/ava.png',
      });

      // Missing X provider identity throws 403 in non-emulator mode
      mockAuth.verifyIdToken.mockResolvedValueOnce({ uid: 'u_no_x', firebase: { identities: {} } });
      await expect(verifier.verifyBearerToken('tok-2')).rejects.toMatchObject({ statusCode: 403 });

      // Signature failure throws 401
      mockAuth.verifyIdToken.mockRejectedValueOnce(new Error('expired'));
      await expect(verifier.verifyBearerToken('tok-bad')).rejects.toMatchObject({ statusCode: 401 });

      // Emulator mode disables revocation check and synthesizes xUserId fallback
      const emuVerifier = new FirebaseLoungeAuthVerifier(mockAuth, true);
      mockAuth.verifyIdToken.mockResolvedValueOnce({ uid: 'u_emu_9', x_user_id: 'emu_x_9' });
      const emuIdentity = await emuVerifier.verifyBearerToken('emu-tok');
      expect(mockAuth.verifyIdToken).toHaveBeenCalledWith('emu-tok', false);
      expect(emuIdentity.xUserId).toBe('emu_x_9');
      expect(emuIdentity.xHandle).toMatch(/^@member_/);
    });

    it('authenticates non-prod timing-safe x-batch-secret and production/Cloud Run Google OIDC tokens', async () => {
      const verifyIdToken = jest.fn();
      const nonProdApp = express();
      nonProdApp.use(rateLimit({ windowMs: 60_000, max: 100 }));
      nonProdApp.post(
        '/run',
        createLoungeBatchAuthMiddleware({
          nodeEnv: 'test',
          batchSecretKey: 'super-secret-batch',
          expectedAudience: 'https://lounge.example.com',
          oidcClient: { verifyIdToken } as unknown as NonNullable<
            Parameters<typeof createLoungeBatchAuthMiddleware>[0]['oidcClient']
          >,
        }),
        (_req, res) => res.status(200).json({ ok: true }),
      );

      expect((await request(nonProdApp).post('/run').set('x-batch-secret', 'short')).status).toBe(401);
      expect((await request(nonProdApp).post('/run').set('x-batch-secret', 'wrong-secret-batch!')).status).toBe(
        401,
      );
      expect(
        (await request(nonProdApp).post('/run').set('x-batch-secret', 'super-secret-batch')).status,
      ).toBe(200);

      // Production & Cloud Run ignore x-batch-secret and enforce Bearer OIDC verification
      const prodApp = express();
      prodApp.use(rateLimit({ windowMs: 60_000, max: 100 }));
      prodApp.post(
        '/run',
        createLoungeBatchAuthMiddleware({
          nodeEnv: 'production',
          isCloudRun: true,
          batchSecretKey: 'super-secret-batch',
          expectedAudience: 'https://lounge.example.com',
          expectedServiceAccountEmail: 'scheduler@example.iam.gserviceaccount.com',
          oidcClient: { verifyIdToken } as unknown as NonNullable<
            Parameters<typeof createLoungeBatchAuthMiddleware>[0]['oidcClient']
          >,
        }),
        (_req, res) => res.status(200).json({ ok: true }),
      );

      expect(
        (await request(prodApp).post('/run').set('x-batch-secret', 'super-secret-batch')).status,
      ).toBe(401);
      expect(
        (await request(prodApp).post('/run').set('Authorization', 'Bearer   ')).status,
      ).toBe(401);

      verifyIdToken.mockRejectedValueOnce(new Error('invalid audience'));
      expect(
        (await request(prodApp).post('/run').set('Authorization', 'Bearer oidc-bad')).status,
      ).toBe(401);

      verifyIdToken.mockResolvedValueOnce({
        getPayload: () => ({
          iss: 'https://evil.example.com',
          email: 'scheduler@example.iam.gserviceaccount.com',
          email_verified: true,
        }),
      });
      expect(
        (await request(prodApp).post('/run').set('Authorization', 'Bearer oidc-bad-iss')).status,
      ).toBe(401);

      verifyIdToken.mockResolvedValueOnce({
        getPayload: () => ({
          iss: 'https://accounts.google.com',
          email: 'other@example.iam.gserviceaccount.com',
          email_verified: true,
        }),
      });
      expect(
        (await request(prodApp).post('/run').set('Authorization', 'Bearer oidc-wrong-sa')).status,
      ).toBe(403);

      verifyIdToken.mockResolvedValueOnce({
        getPayload: () => ({
          iss: 'https://accounts.google.com',
          email: 'SCHEDULER@example.iam.gserviceaccount.com',
          email_verified: true,
        }),
      });
      expect(
        (await request(prodApp).post('/run').set('Authorization', 'Bearer oidc-good')).status,
      ).toBe(200);

      // Fail-closed when OIDC audience or service account email is missing in production
      const unconfiguredBatchApp = express();
      unconfiguredBatchApp.use(rateLimit({ windowMs: 60_000, max: 100 }));
      unconfiguredBatchApp.post(
        '/run',
        createLoungeBatchAuthMiddleware({
          nodeEnv: 'production',
          isCloudRun: true,
          expectedAudience: 'https://lounge.example.com',
        }),
        (_req, res) => res.status(200).json({ ok: true }),
      );
      expect(
        (await request(unconfiguredBatchApp).post('/run').set('Authorization', 'Bearer oidc-good')).status,
      ).toBe(401);
    });
  });

  describe('Firestore Repositories & Chunked Batch Deletion', () => {
    it('executes auth, account, gallery, and chunked deletion lifecycle cleanly', async () => {
      const { firestore } = createVectorCapableFirestore();
      const cols = getCollections(firestore);
      const keyring = loadTrialHmacKeyring({ NODE_ENV: 'test' }, true);
      const authMock = {
        revokeRefreshTokens: jest.fn().mockResolvedValue(undefined),
        deleteUser: jest.fn().mockResolvedValue(undefined),
      };

      const authRepo = new LoungeAuthRepository(firestore, cols, keyring, authMock);
      const accountRepo = new LoungeAccountRepository(firestore, cols);
      const galleryRepo = new LoungeGalleryRepository(firestore, cols);

      const created = await authRepo.createUserWithConsent({
        uid: 'uid_repo_1',
        xUserId: 'x_repo_1',
        xHandle: '@repo1',
        displayName: 'Repo User',
        avatarUrl: 'assets/gemitec_icon.svg',
        disclaimerConsent: createConsent(1),
        onboardingCompleted: false,
        allowServiceImprovementAnalytics: true,
        preferredCurrency: 'JPY',
      });
      expect(created.uid).toBe('uid_repo_1');
      expect((await authRepo.findUserByUid('uid_repo_1'))?.xUserId).toBe('x_repo_1');
      expect((await authRepo.findUserByXUserId('x_repo_1'))?.uid).toBe('uid_repo_1');
      expect(await authRepo.findUserByXUserId('missing_x')).toBeNull();

      // Verify trial grant retains a 3-year (~1095d) retainUntil TTL field
      const grantMap = Array.from((await cols.loungeTrialGrants.get()).docs).map((d) => d.data());
      expect(grantMap[0]?.retainUntil).toBeDefined();
      expect(Date.parse(grantMap[0].retainUntil)).toBeGreaterThan(Date.now() + 1000 * 86400 * 1090);

      await expect(
        authRepo.createUserWithConsent({
          uid: 'uid_repo_2',
          xUserId: 'x_repo_1',
          xHandle: '@repo1',
          displayName: 'Dup',
          avatarUrl: 'assets/gemitec_icon.svg',
          disclaimerConsent: createConsent(1),
          onboardingCompleted: false,
          allowServiceImprovementAnalytics: true,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });

      await authRepo.recordLoginTimestamp('uid_repo_1', '2026-11-24T10:00:00.000Z');
      const updatedPrefs = await authRepo.updateUserPreferences(
        'uid_repo_1',
        'en',
        'UTC',
        true,
        false,
      );
      expect(updatedPrefs.allowServiceImprovementAnalytics).toBe(false);
      await authRepo.updateUserDisclaimerConsent('uid_repo_1', createConsent(2));
      await authRepo.updateUserStatus('uid_repo_1', 'ACTIVE');

      // Account repository search counter with quota-aligned local-midnight rollover, decrement & lot lookup
      const now = new Date();
      const sameDayLater = new Date(now.getTime() + 1_000);
      const nextDay = new Date(now.getTime() + 26 * 60 * 60 * 1000);
      await accountRepo.incrementDailySearchCount('uid_repo_1', now);
      expect((await accountRepo.getSubscriptionDocByUid('uid_repo_1'))?.todaysSearchCount).toBe(1);
      await accountRepo.incrementDailySearchCount('uid_repo_1', sameDayLater);
      expect((await accountRepo.getSubscriptionDocByUid('uid_repo_1'))?.todaysSearchCount).toBe(2);
      await accountRepo.incrementDailySearchCount('uid_repo_1', nextDay);
      expect((await accountRepo.getSubscriptionDocByUid('uid_repo_1'))?.todaysSearchCount).toBe(1);
      expect((await accountRepo.listActiveCreditLotsByUid('uid_repo_1'))).toHaveLength(1);
      const reservedTurn = await accountRepo.reserveTurnForSession('uid_repo_1', 'turn_repo_check');
      expect(reservedTurn.subscription.dailyRemainingTurns).toBe(4);
      expect(reservedTurn.todaysSearchCount).toBe(1);

      // Gallery repository excludes FAILED/PROCESSING/PENDING catalog assets
      await cols.images.doc('img_ready').set({
        url: 'assets/ready.webp',
        caption: 'Ready illustration',
        status: AssetStatus.SUCCESS,
        createdAt: '2026-11-22T00:00:00.000Z',
        lastUsedAt: null,
        useCount: 0,
        embedding: [1, 0, 0],
      });
      await cols.images.doc('img_failed').set({
        url: 'assets/fail.webp',
        caption: 'Failed illustration',
        status: AssetStatus.FAILED,
        createdAt: '2026-11-22T00:00:00.000Z',
        lastUsedAt: null,
        useCount: 0,
        embedding: [],
      });
      await cols.images.doc('img_pending').set({
        url: 'assets/pend.webp',
        caption: 'Pending illustration',
        status: AssetStatus.PENDING,
        createdAt: '2026-11-22T00:00:00.000Z',
        lastUsedAt: null,
        useCount: 0,
        embedding: [],
      });

      const unlocked = await galleryRepo.unlockGalleryItem(
        'uid_repo_1',
        'img_ready',
        'assets/ready.webp',
        'uid_repo_1',
      );
      expect(unlocked?.unlocked).toBe(true);
      // Idempotent unlock
      expect(
        (await galleryRepo.unlockGalleryItem('uid_repo_1', 'img_ready', 'assets/ready.webp', 'uid_repo_1'))?.id,
      ).toBe(unlocked?.id);

      const listRes = await galleryRepo.listGalleryByUid('uid_repo_1', { page: 1, limit: 10 });
      expect(listRes.summary).toEqual({ unlockedCount: 1, totalCount: 1 });
      expect(listRes.data).toHaveLength(1);
      await expect(
        galleryRepo.listGalleryByUid('uid_repo_1', { cursor: 'missing_gallery_cursor' }),
      ).rejects.toMatchObject({ statusCode: 400 });

      // deleteUser retains lounge_users/{uid} if Firebase Auth deletion fails transiently, enabling retries
      authMock.deleteUser.mockRejectedValueOnce(new Error('transient auth outage'));
      await expect(authRepo.deleteUser('uid_repo_1')).rejects.toThrow(/Failed to delete/);
      expect((await cols.loungeUsers.doc('uid_repo_1').get()).exists).toBe(true);

      // deleteQueryInBatches across multiple chunks
      for (let i = 0; i < 5; i += 1) {
        await cols.loungeQuotaLedger.doc(`chunk_${i}`).set({
          id: `chunk_${i}`,
          uid: 'uid_chunk_only',
          deltaType: 'DAILY_RESET',
          deltaDaily: 0,
          deltaPurchased: 0,
          balanceTotalAfter: 5,
          referenceId: `ref_${i}`,
          createdAt: '2026-11-24T00:00:00.000Z',
          expireAt: '2027-05-24T00:00:00.000Z',
        });
      }
      const deletedCount = await deleteQueryInBatches(
        firestore,
        cols.loungeQuotaLedger.where('uid', '==', 'uid_chunk_only'),
        2,
      );
      expect(deletedCount).toBe(5);

      // Cleanup repositories
      await galleryRepo.deleteAllUserGalleryItems('uid_repo_1');
      await accountRepo.deleteSubscription('uid_repo_1');
      await authRepo.revokeSession('uid_repo_1');
      await authRepo.deleteUser('uid_repo_1');

      // Tolerates auth/user-not-found on revoke/delete
      authMock.revokeRefreshTokens.mockRejectedValueOnce({ code: 'auth/user-not-found' });
      authMock.deleteUser.mockRejectedValueOnce({ code: 'auth/user-not-found' });
      await authRepo.revokeSession('uid_missing');
      await authRepo.deleteUser('uid_missing');
    });

    it('handles session singleton, chronological cursor/page pagination, and vector + emulator RAG', async () => {
      const { firestore: prodFs } = createVectorCapableFirestore({ failFindNearest: false });
      const prodCols = getCollections(prodFs);
      const prodSessionRepo = new LoungeSessionRepository(prodFs, prodCols, false);

      expect(computeCosineSimilarity([], [])).toBe(0);
      expect(computeCosineSimilarity([0, 0], [1, 1])).toBe(0);
      expect(computeCosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);

      const session = await prodSessionRepo.getOrCreateSingletonSession(
        'uid_sess_1',
        '2026-11-24T00:00:00.000Z',
      );
      expect(session.id).toBe('uid_sess_1');
      expect((await prodSessionRepo.listMessages('uid_sess_1')).data).toEqual([]);

      await prodCols.loungeUsers.doc('uid_sess_1').set({
        uid: 'uid_sess_1',
        xUserId: 'x_sess_1',
        xHandle: '@sess1',
        displayName: 'Sess 1',
        avatarUrl: 'assets/gemitec_icon.svg',
        status: 'ACTIVE',
        language: 'ja',
        timezone: 'Asia/Tokyo',
        onboardingCompleted: true,
        allowServiceImprovementAnalytics: true,
        disclaimerConsent: createConsent(1),
        createdAt: '2026-11-24T00:00:00.000Z',
        updatedAt: '2026-11-24T00:00:00.000Z',
        lastLoginAt: '2026-11-24T00:00:00.000Z',
      });

      const nowSpy = jest
        .spyOn(Date, 'now')
        .mockReturnValueOnce(1795500000000)
        .mockReturnValueOnce(1795500005000);
      await prodSessionRepo.appendMessagePair({
        uid: 'uid_sess_1',
        sessionId: 'uid_sess_1',
        userContent: 'First question',
        userEmotion: 'NEUTRAL',
        assistantContent: 'First answer',
        assistantEmotion: 'HAPPY',
        assistantTokenUsage: { promptTokens: 10, candidatesTokens: 12, totalTokens: 22 },
      });
      await prodSessionRepo.appendMessagePair({
        uid: 'uid_sess_1',
        sessionId: 'uid_sess_1',
        userContent: 'Second question',
        userEmotion: 'THOUGHTFUL',
        assistantContent: 'Second answer',
        assistantEmotion: 'EXCITED',
        assistantTokenUsage: { promptTokens: 15, candidatesTokens: 14, totalTokens: 29 },
        imageAssetId: 'img_2',
        imageUrl: 'assets/img2.webp',
      });
      nowSpy.mockRestore();

      const pageLatest = await prodSessionRepo.listMessages('uid_sess_1', { limit: 2 });
      expect(pageLatest.meta.totalItems).toBe(4);
      expect(pageLatest.meta.hasMore).toBe(true);
      expect(pageLatest.data.map((m) => m.content)).toEqual(['Second question', 'Second answer']);

      const pageOlder = await prodSessionRepo.listMessages('uid_sess_1', {
        limit: 2,
        cursor: pageLatest.meta.nextCursor ?? undefined,
      });
      expect(pageOlder.data.map((m) => m.content)).toEqual(['First question', 'First answer']);

      const page2Offset = await prodSessionRepo.listMessages('uid_sess_1', { page: 2, limit: 2 });
      expect(page2Offset.data.map((m) => m.content)).toEqual(['First question', 'First answer']);
      await expect(
        prodSessionRepo.listMessages('uid_sess_1', { cursor: 'nonexistent_msg_id' }),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(await prodSessionRepo.findSessionByUid('uid_sess_1')).not.toBeNull();
      expect(await prodSessionRepo.findSessionByUid('uid_missing_session')).toBeNull();

      // Deleting/non-active user aborts appendMessagePair cleanly with 403 without writing turns
      await prodCols.loungeUsers.doc('uid_sess_1').set({
        ...(await prodCols.loungeUsers.doc('uid_sess_1').get()).data()!,
        status: 'DELETING',
      });
      await expect(
        prodSessionRepo.appendMessagePair({
          uid: 'uid_sess_1',
          sessionId: 'uid_sess_1',
          userContent: 'Should abort',
          userEmotion: 'NEUTRAL',
          assistantContent: 'Should not persist',
          assistantEmotion: 'NEUTRAL',
          assistantTokenUsage: { promptTokens: 1, candidatesTokens: 1, totalTokens: 2 },
        }),
      ).rejects.toMatchObject({ statusCode: 403 });

      const recent = await prodSessionRepo.listRecentMessages('uid_sess_1', 2);
      expect(recent.map((m) => m.content)).toEqual(['Second question', 'Second answer']);

      // Index turn RAG & episodic buffer
      await prodSessionRepo.indexPrivateTurnMemory({
        uid: 'uid_sess_1',
        sessionId: 'uid_sess_1',
        category: 'EPISODE',
        summary: 'Loves pour-over coffee',
        embedding: [1, 0, 0],
        salienceScore: 0.9,
        episodicEntries: [{ role: 'user', content: 'I love coffee', timestamp: '2026-11-24T00:01:00.000Z' }],
      });

      expect((await prodSessionRepo.searchPrivateRagMemoriesByVector('uid_sess_1', [], 2))).toHaveLength(1);
      expect((await prodSessionRepo.searchPrivateRagMemoriesByVector('uid_sess_1', [1, 0, 0], 2))).toHaveLength(1);

      // Emulator fallback cosine ranking path
      const { firestore: emuFs } = createVectorCapableFirestore({ failFindNearest: true });
      const emuCols = getCollections(emuFs);
      const emuRepo = new LoungeSessionRepository(emuFs, emuCols, true);
      await emuRepo.indexPrivateTurnMemory({
        uid: 'uid_emu_rag',
        sessionId: 'uid_emu_rag',
        category: 'PREFERENCE',
        summary: 'Matcha over espresso',
        embedding: [0, 1, 0],
        salienceScore: 0.8,
        episodicEntries: [],
      });
      const fallbackHits = await emuRepo.searchPrivateRagMemoriesByVector('uid_emu_rag', [0, 1, 0], 3);
      expect(fallbackHits[0].summary).toBe('Matcha over espresso');

      // Non-emulator vector failure propagates error with cause
      const nonEmuBrokenRepo = new LoungeSessionRepository(emuFs, emuCols, false);
      await expect(
        nonEmuBrokenRepo.searchPrivateRagMemoriesByVector('uid_emu_rag', [0, 1, 0], 3),
      ).rejects.toThrow(/Private RAG vector query failed/);

      await prodSessionRepo.deleteAllUserSessionData('uid_sess_1');
      expect((await prodSessionRepo.listMessages('uid_sess_1')).data).toEqual([]);
    });
  });

  describe('AI Adapters (Public X Read, Image Vector Match, Gemini Tool Loop) & Nightly Dreaming Batch', () => {
    it('reads Public X snapshot and matches Bot images safely across prod & emulator paths', async () => {
      const { firestore: emuFs, store } = createVectorCapableFirestore({ failFindNearest: true });
      const emuCols = getCollections(emuFs);
      const publicXReader = new FirestorePublicXMemoryReadAdapter(emuFs, emuCols, true);

      expect(await publicXReader.readPublicXMemorySnapshot('  ', [])).toBeNull();
      expect(await publicXReader.readPublicXMemorySnapshot('unknown_x', [])).toBeNull();

      await emuCols.users.doc('x_reader_1').set({
        id: 'x_reader_1',
        name: 'X Fan',
        username: 'xfan',
        coreProfile: { interests: ['Music'] },
        episodicBuffer: [],
        lastSeen: '2026-11-24T00:00:00.000Z',
      });
      await emuCols.system.doc('persona').set({
        id: 'persona',
        extended_prompt: 'Layer 1 Ext',
        timeline_summary: 'Layer 2 Summary',
      } as never);
      await emuCols.conversationLogs.doc('log_1').set({
        userId: 'x_reader_1',
        userText: 'Hi Rebecca',
        aiText: 'Hey there!',
        thought: 'warm greeting',
        timestamp: '2026-11-24T00:00:00.000Z',
        expireAt: '2031-11-24T00:00:00.000Z',
      });
      await emuCols.timelineHistory.doc('post_1').set({
        text: 'Evening coffee stream',
        timestamp: '2026-11-24T00:00:00.000Z',
        expireAt: '2031-11-24T00:00:00.000Z',
      });
      const ragMap = new Map<string, Record<string, unknown>>();
      ragMap.set('rag_1', {
        id: 'rag_1',
        userId: 'x_reader_1',
        text: 'Loves city pop vinyl',
        embedding: [1, 0, 0],
        timestamp: '2026-11-24T00:00:00.000Z',
      });
      store.set(COLLECTIONS.RAG_MEMORIES, ragMap);

      const snapshot = await publicXReader.readPublicXMemorySnapshot('x_reader_1', [1, 0, 0]);
      expect(snapshot?.personaLayer1ExtendedPrompt).toBe('Layer 1 Ext');
      expect(snapshot?.userVectorMemories).toHaveLength(1);
      expect(snapshot?.userVectorMemories[0]).toContain('Loves city pop vinyl');
      expect(snapshot?.userRecentTurns).toHaveLength(2);

      // Image vector adapter: empty embedding returns null, emulator skips FAILED/PENDING and picks READY
      const embedPort = { embedQuery: jest.fn(async (t: string) => (t ? [1, 0, 0] : [])) };
      await emuCols.images.doc('img_bad').set({
        url: 'assets/bad.webp',
        caption: 'Failed',
        status: AssetStatus.FAILED,
        createdAt: '2026-11-24T00:00:00.000Z',
        lastUsedAt: null,
        useCount: 0,
        embedding: [1, 0, 0],
      });
      await emuCols.images.doc('img_good').set({
        url: 'assets/good.webp',
        caption: 'Success',
        status: AssetStatus.SUCCESS,
        createdAt: '2026-11-24T00:00:00.000Z',
        lastUsedAt: null,
        useCount: 0,
        embedding: [1, 0, 0],
      });

      const imgAdapter = new FirestoreBotImageVectorSearchAdapter(emuFs, emuCols, embedPort, 0.45, true);
      expect(await imgAdapter.findCandidateImages('Coffee chat!', new Set(), 3)).toEqual([
        {
          assetId: 'img_good',
          imageUrl: 'assets/good.webp',
          caption: 'Success',
        },
      ]);
      expect(await imgAdapter.findCandidateImages('Coffee chat!', new Set(['img_good']), 3)).toEqual([]);

      // Production findNearest path
      const { firestore: prodFs } = createVectorCapableFirestore({ failFindNearest: false });
      const prodCols = getCollections(prodFs);
      const prodXReader = new FirestorePublicXMemoryReadAdapter(prodFs, prodCols, false);
      expect(await prodXReader.readPublicXMemorySnapshot('missing_prod', [1, 0, 0])).toBeNull();
      // Non-emulator vector index error warns cleanly and still builds snapshot when profile exists
      await emuCols.users.doc('x_warn_only').set({
        id: 'x_warn_only',
        name: 'Warn',
        username: 'warn',
        coreProfile: {},
        episodicBuffer: [],
      });
      const nonEmuXReader = new FirestorePublicXMemoryReadAdapter(emuFs, emuCols, false);
      expect((await nonEmuXReader.readPublicXMemorySnapshot('x_warn_only', [1, 0, 0]))?.xUserId).toBe(
        'x_warn_only',
      );
      await prodCols.images.doc('img_prod').set({
        url: 'assets/prod.webp',
        caption: 'Prod image',
        status: AssetStatus.SUCCESS,
        createdAt: '2026-11-24T00:00:00.000Z',
        lastUsedAt: null,
        useCount: 0,
        embedding: [1, 0, 0],
      });
      const prodImgAdapter = new FirestoreBotImageVectorSearchAdapter(prodFs, prodCols, embedPort, 0.45, false);
      expect(await prodImgAdapter.findCandidateImages('Coffee!', new Set(), 3)).toEqual([
        {
          assetId: 'img_prod',
          imageUrl: 'assets/prod.webp',
          caption: 'Prod image',
        },
      ]);
      embedPort.embedQuery.mockResolvedValueOnce([]);
      expect(await prodImgAdapter.findCandidateImages('Empty embed', new Set(), 3)).toEqual([]);
      const nonEmuBrokenImg = new FirestoreBotImageVectorSearchAdapter(emuFs, emuCols, embedPort, 0.45, false);
      expect(await nonEmuBrokenImg.findCandidateImages('Coffee!', new Set(), 3)).toEqual([]);
    });

    it('invokes Gemini Flash-Lite ReAct search_web tool loop without schema collision, post-reply emotion, 3-stage image match, LocalEmulator adapter & Dreaming endpoint', async () => {
      const embedContent = jest.fn().mockResolvedValue({
        embeddings: [{ values: buildDeterministicTestEmbedding('coffee') }],
      });
      const generateContent = jest
        .fn()
        // 1) post-reply classifyEmotion response
        .mockResolvedValueOnce({ text: '{"emotion":"EXCITED"}' })
        // 2) planImageSearch -> attach image query
        .mockResolvedValueOnce({ text: '{"shouldAttachImage":true,"searchQuery":"Rebecca smiling outdoors sunny"}' })
        // 3) verifyImageRelevance -> relevant
        .mockResolvedValueOnce({ text: '{"relevant":true}' })
        // 4) Round 1 of chat dialogue loop: triggers search_web tool (MUST NOT combine tools + responseSchema)
        .mockResolvedValueOnce({
          functionCalls: [{ name: 'search_web', args: { query: 'Tokyo weather' } }],
          candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'search_web' } }] } }],
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, totalTokenCount: 25 },
        })
        // 5) executeWebSearch Google Search grounding call
        .mockResolvedValueOnce({ text: 'Clear skies 18C in Tokyo.' })
        // 6) Round 2 synthesis structured JSON reply
        .mockResolvedValueOnce({
          text: '{"thought":"warm reply after checking forecast","reply":"東京は18℃で晴れみたいだよ！"}',
          usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 15, totalTokenCount: 45 },
        })
        // 7) Dreaming synthesis JSON response
        .mockResolvedValueOnce({
          text: '{"attributes":["Tokyo"],"preferences":["City Pop","Weather"],"concerns":[],"important_memories":[]}',
        });

      const fakeGenAi = { models: { embedContent, generateContent } } as unknown as GoogleGenAI;
      const geminiAdapter = new GeminiLoungeAiAdapter(
        {
          apiKey: 'test-gemini-key',
          chatModel: 'gemini-3.1-flash-lite',
          searchModel: 'gemini-3.1-flash-lite',
          embeddingModel: 'gemini-embedding-2',
          maxOutputTokens: 450,
          activePersonaId: 'rebecca',
        },
        fakeGenAi,
      );

      const mockSession = {
        id: 'uid_ai_1',
        uid: 'uid_ai_1',
        title: 'Private Lounge',
        messageCount: 0,
        currentEmotion: 'NEUTRAL' as const,
        publicXMemorySyncedAt: '2026-11-24T00:00:00.000Z',
        lastMessagePreview: '',
        createdAt: '2026-11-24T00:00:00.000Z',
        updatedAt: '2026-11-24T00:00:00.000Z',
      };
      expect(
        await geminiAdapter.classifyEmotion({
          userPrompt: 'Yay!',
          thought: 'happy mood',
          replyText: 'やったね！',
        }),
      ).toBe('EXCITED');
      expect(
        await geminiAdapter.planImageSearch({
          userPrompt: 'Sunny today',
          thought: 'smiling',
          replyText: 'いい天気だね！',
        }),
      ).toBe('Rebecca smiling outdoors sunny');
      expect(
        await geminiAdapter.verifyImageRelevance({
          candidateCaption: 'Rebecca smiling outside on a bright sunny morning',
          thought: 'smiling',
          replyText: 'いい天気だね！',
        }),
      ).toBe(true);

      const reply = await geminiAdapter.generateReply({
        uid: 'uid_ai_1',
        session: mockSession,
        userPrompt: '今日の東京の天気教えて！',
        responseLanguage: 'ja',
        userTimezone: 'Asia/Tokyo',
        allowWebSearch: true,
        privateMemory: {
          coreProfile: { attributes: ['Espresso lover'] },
          recentRawMessages: [],
          vectorMemories: [],
        },
        publicXMemory: null,
      });
      expect(reply.usedWebSearch).toBe(true);
      expect(reply.thought).toBe('warm reply after checking forecast');
      expect(reply.replyText).toBe('東京は18℃で晴れみたいだよ！');
      expect(reply.tokenUsage.totalTokens).toBe(70);

      // Verify ReAct tool round separated tools from responseSchema
      const toolRoundCallConfig = generateContent.mock.calls[3][0].config;
      expect(toolRoundCallConfig.tools).toBeDefined();
      expect(toolRoundCallConfig.responseSchema).toBeUndefined();
      expect(toolRoundCallConfig.responseMimeType).toBeUndefined();
      const synthesisCallConfig = generateContent.mock.calls[5][0].config;
      expect(synthesisCallConfig.responseMimeType).toBe('application/json');
      expect(synthesisCallConfig.responseSchema).toBeDefined();

      // LocalEmulatorLoungeAiAdapter: neutral, character-agnostic, no regex heuristics
      const localAi = new LocalEmulatorLoungeAiAdapter();
      expect(await localAi.embedQuery('')).toEqual([]);
      expect((await localAi.embedQuery('hello')).length).toBe(768);
      expect(await localAi.classifyEmotion()).toBe('NEUTRAL');
      expect(await localAi.planImageSearch()).toBeNull();
      expect(await localAi.verifyImageRelevance()).toBe(true);
      const localReply = await localAi.generateReply({
        uid: 'uid_emu',
        session: { ...mockSession, id: 'uid_emu', uid: 'uid_emu' },
        userPrompt: '今日の天気検索して',
        responseLanguage: 'en',
        userTimezone: 'UTC',
        allowWebSearch: true,
        privateMemory: { coreProfile: {}, recentRawMessages: [], vectorMemories: [] },
        publicXMemory: null,
      });
      expect(localReply.usedWebSearch).toBe(false);
      expect(localReply.replyText).toContain('[Emulator en]');

      // Nightly Batch Dreaming via HTTP /batch/lounge-dreaming route
      const { firestore } = createVectorCapableFirestore();
      const cols = getCollections(firestore);
      await cols.loungeUsers.doc('uid_dream_1').set({
        uid: 'uid_dream_1',
        xUserId: 'x_dream_1',
        xHandle: '@dream1',
        displayName: 'Dream User',
        avatarUrl: 'assets/gemitec_icon.svg',
        status: 'ACTIVE',
        language: 'ja',
        timezone: 'Asia/Tokyo',
        onboardingCompleted: true,
        allowServiceImprovementAnalytics: true,
        coreProfile: { interests: [] },
        episodicBuffer: [
          { role: 'user', content: 'I started learning piano!', timestamp: '2026-11-24T00:00:00.000Z' },
        ],
        lastDreamedAt: '2026-11-20T00:00:00.000Z',
        disclaimerConsent: createConsent(1),
        createdAt: '2026-11-20T00:00:00.000Z',
        updatedAt: '2026-11-24T01:00:00.000Z',
        lastLoginAt: '2026-11-24T01:00:00.000Z',
      });

      const store = new FirestoreLoungeDreamingStore(firestore, cols);
      const dreamingService = new LoungeDreamingBatchService(store, geminiAdapter, 'rebecca', 0);
      const batchApp = express();
      batchApp.use(
        '/api/v1/lounge/batch',
        createLoungeBatchRouter(
          dreamingService,
          createLoungeBatchAuthMiddleware({ nodeEnv: 'test', batchSecretKey: 'sec-1' }),
        ),
      );

      const batchRes = await request(batchApp)
        .post('/api/v1/lounge/batch/lounge-dreaming')
        .set('x-batch-secret', 'sec-1');
      expect(batchRes.status).toBe(200);
      expect(batchRes.body.succeeded).toBe(1);
      expect(batchRes.body.processedUsers).toBe(1);
      const updatedUser = (await cols.loungeUsers.doc('uid_dream_1').get()).data()!;
      expect((updatedUser.coreProfile as { preferences?: string[] })?.preferences).toContain('City Pop');

      // Early structured JSON return skips redundant synthesis round; Dreaming fail-fast throws on malformed JSON
      generateContent
        .mockResolvedValueOnce({
          text: '{"thought":"direct answer","reply":"すぐ答えるよ！"}',
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5, totalTokenCount: 10 },
        })
        .mockResolvedValueOnce({ text: 'invalid-dreaming-json' });

      const directReply = await geminiAdapter.generateReply({
        uid: 'uid_ai_1',
        session: mockSession,
        userPrompt: 'Direct reply check',
        responseLanguage: 'ja',
        userTimezone: 'Asia/Tokyo',
        allowWebSearch: true,
        privateMemory: { coreProfile: {}, recentRawMessages: [], vectorMemories: [] },
        publicXMemory: null,
      });
      expect(directReply.replyText).toBe('すぐ答えるよ！');
      await expect(
        geminiAdapter.generateDreaming('Prompt', [], { preserved: true }),
      ).rejects.toThrow(/empty or malformed JSON/);

      const failingBatchApp = express();
      failingBatchApp.use(
        '/api/v1/lounge/batch',
        createLoungeBatchRouter(
          {
            runNightlyConsolidation: async () => {
              throw new Error('Sensitive DB error');
            },
          } as unknown as LoungeDreamingBatchService,
          createLoungeBatchAuthMiddleware({ nodeEnv: 'test', batchSecretKey: 'sec-1' }),
        ),
      );
      const errBatchRes = await request(failingBatchApp)
        .post('/api/v1/lounge/batch/lounge-dreaming')
        .set('x-batch-secret', 'sec-1');
      expect(errBatchRes.status).toBe(500);
      expect(errBatchRes.body).toEqual({ error: 'Internal server error' });

      // Fail-fast LLM validation & web search graceful degradation
      expect(await geminiAdapter.embedQuery('   ')).toEqual([]);
      generateContent.mockRejectedValueOnce(new Error('classifier down'));
      await expect(
        geminiAdapter.classifyEmotion({ userPrompt: 'Yay!', thought: '', replyText: 'Yay!' }),
      ).rejects.toThrow(/classifier down/);
      generateContent.mockResolvedValueOnce({ text: '{"emotion":"BOGUS"}' });
      await expect(
        geminiAdapter.classifyEmotion({ userPrompt: 'Yay!', thought: '', replyText: 'Yay!' }),
      ).rejects.toThrow(/unrecognized emotion/);
      generateContent.mockResolvedValueOnce({ text: '{"shouldAttachImage":false,"searchQuery":""}' });
      expect(
        await geminiAdapter.planImageSearch({ userPrompt: 'Ok', thought: '', replyText: 'Got it!' }),
      ).toBeNull();
      generateContent.mockResolvedValueOnce({ text: 'invalid-plan' });
      await expect(
        geminiAdapter.planImageSearch({ userPrompt: 'Ok', thought: '', replyText: 'Got it!' }),
      ).rejects.toThrow(/malformed JSON/);
      expect(
        await geminiAdapter.verifyImageRelevance({ candidateCaption: '  ', thought: '', replyText: 'Hi' }),
      ).toBe(false);
      generateContent.mockResolvedValueOnce({ text: 'bad-relevance' });
      await expect(
        geminiAdapter.verifyImageRelevance({ candidateCaption: 'Rebecca portrait', thought: '', replyText: 'Hi' }),
      ).rejects.toThrow(/malformed JSON/);
      expect(await geminiAdapter.executeWebSearch('   ')).toContain('No search query');
      generateContent.mockRejectedValueOnce(new Error('search down'));
      expect(await geminiAdapter.executeWebSearch('Tokyo weather')).toContain('temporary search error');
      const emuDreamed = await localAi.generateDreaming(
        'sys',
        [{ role: 'user', content: 'Jazz bars' }],
        { preferences: ['vinyl'] },
      );
      expect(emuDreamed['preferences']).toEqual(['vinyl', 'Jazz bars']);
      expect(emuDreamed).not.toHaveProperty('recentTopics');
      expect(() => parseAndNormalizeCoreProfile('bad')).toThrow(/JSON object/);
      expect(() =>
        parseAndNormalizeCoreProfile({
          attributes: 'not-array',
          preferences: [],
          concerns: [],
          important_memories: [],
        }),
      ).toThrow(/array of strings/);

      // Auth & Account missing-user and error propagation paths
      const { firestore: edgeFs } = createVectorCapableFirestore();
      const edgeCols = getCollections(edgeFs);
      const edgeKeyring = loadTrialHmacKeyring({ NODE_ENV: 'test' }, true);
      const edgeAuthMock = {
        revokeRefreshTokens: jest.fn().mockRejectedValue(new Error('firebase rpc fail')),
        deleteUser: jest.fn().mockRejectedValue(new Error('firebase delete fail')),
      };
      const edgeAuthRepo = new LoungeAuthRepository(edgeFs, edgeCols, edgeKeyring, edgeAuthMock);
      const edgeAccountRepo = new LoungeAccountRepository(edgeFs, edgeCols);

      expect(await edgeAuthRepo.findUserByUid('uid_none')).toBeNull();
      await expect(edgeAuthRepo.recordLoginTimestamp('uid_none', '2026-11-24T00:00:00.000Z')).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(edgeAuthRepo.updateUserPreferences('uid_none', 'ja')).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(edgeAuthRepo.updateUserDisclaimerConsent('uid_none', createConsent(1))).rejects.toMatchObject({
        statusCode: 404,
      });
      await edgeAuthRepo.updateUserStatus('uid_none', 'SUSPENDED');
      await expect(edgeAuthRepo.revokeSession('uid_err')).rejects.toThrow(/Failed to revoke/);
      await expect(edgeAuthRepo.deleteUser('uid_err')).rejects.toThrow(/Failed to delete/);
      expect(await edgeAccountRepo.getSubscriptionByUid('uid_none')).toBeNull();
      expect(await edgeAccountRepo.listActiveCreditLotsByUid('uid_none')).toEqual([]);
      await edgeAccountRepo.incrementDailySearchCount('uid_none', new Date('2026-11-24T00:00:00.000Z'));
    });

    it('covers gallery multi-item sort, prod vector X memory & image filtering, and generateReply without tools', async () => {
      const { firestore: prodFs, store: prodStore } = createVectorCapableFirestore({ failFindNearest: false });
      const prodCols = getCollections(prodFs);
      const galleryRepo = new LoungeGalleryRepository(prodFs, prodCols);

      await prodCols.loungeGallery.doc('uid_g_a1').set({
        id: 'uid_g_a1',
        uid: 'uid_g',
        assetId: 'a1',
        imageUrl: 'assets/a1.webp',
        unlocked: false,
      });
      await prodCols.loungeGallery.doc('uid_g_a2').set({
        id: 'uid_g_a2',
        uid: 'uid_g',
        assetId: 'a2',
        imageUrl: 'assets/a2.webp',
        unlocked: true,
        unlockedAt: '2026-11-22T00:00:00.000Z',
        sourceSessionId: 'uid_g',
      });
      await prodCols.loungeGallery.doc('uid_g_a3').set({
        id: 'uid_g_a3',
        uid: 'uid_g',
        assetId: 'a3',
        imageUrl: 'assets/a3.webp',
        unlocked: true,
        unlockedAt: '2026-11-24T00:00:00.000Z',
        sourceSessionId: 'uid_g',
      });
      const sortedGallery = await galleryRepo.listGalleryByUid('uid_g', { page: 1, limit: 10 });
      expect(sortedGallery.data.map((item) => item.assetId)).toEqual(['a3', 'a2', 'a1']);

      const xRagMap = new Map<string, Record<string, unknown>>();
      xRagMap.set('xrag_1', {
        id: 'xrag_1',
        userId: 'x_prod_rag',
        text: 'Mentioned midnight jazz',
        embedding: [1, 0, 0],
        timestamp: '2026-11-24T00:00:00.000Z',
      });
      prodStore.set(COLLECTIONS.RAG_MEMORIES, xRagMap);
      const prodXReader = new FirestorePublicXMemoryReadAdapter(prodFs, prodCols, false);
      await prodCols.users.doc('x_prod_rag').set({
        id: 'x_prod_rag',
        name: 'Jazz Listener',
        username: 'jazz_fan',
        coreProfile: { hobbies: ['Vinyl collecting'] },
        episodicBuffer: [
          { role: 'user', content: 'Listening to records', timestamp: '2026-11-23T20:00:00.000Z' },
          {
            role: 'model',
            content: 'Cool pick!',
            thought: 'music fan',
            timestamp: '2026-11-23T20:00:05.000Z',
          },
        ],
        lastReplyDate: '2026-11-20T00:00:00.000Z',
      });
      await prodCols.system.doc('persona').set({
        id: 'persona',
        extended_prompt: 'Layer 1 Trend Guidance',
        timeline_summary: 'Layer 2 Self Reflection Summary',
      } as never);
      await prodCols.timelineHistory.doc('post_jazz').set({
        text: 'Morning espresso playlist online!',
        timestamp: '2026-11-24T08:00:00.000Z',
        expireAt: '2031-11-24T08:00:00.000Z',
      });
      const xSnap = await prodXReader.readPublicXMemorySnapshot(
        'x_prod_rag',
        [1, 0, 0],
        'America/New_York',
      );
      expect(xSnap?.xDisplayName).toBe('Jazz Listener');
      expect(xSnap?.xUsername).toBe('jazz_fan');
      expect(xSnap?.userVectorMemories).toHaveLength(1);
      expect(xSnap?.userVectorMemories[0]).toContain('Mentioned midnight jazz');
      // Timestamp formatted in America/New_York (EST UTC-5: 2026-11-24T00:00Z -> 2026-11-23 19:00)
      expect(xSnap?.userVectorMemories[0]).toContain('2026-11-23 19:00');

      await prodCols.images.doc('img_skip_fail').set({
        url: 'assets/fail.webp',
        caption: 'skip',
        status: AssetStatus.FAILED,
        embedding: [1, 0, 0],
        lastUsedAt: null,
        useCount: 0,
      });
      await prodCols.images.doc('img_skip_empty_url').set({
        url: '  ',
        caption: 'empty url',
        status: AssetStatus.SUCCESS,
        embedding: [1, 0, 0],
        lastUsedAt: null,
        useCount: 0,
      });
      await prodCols.images.doc('img_low_sim').set({
        url: 'assets/far.webp',
        caption: 'orthogonal',
        status: AssetStatus.SUCCESS,
        embedding: [0, 1, 0],
        lastUsedAt: null,
        useCount: 0,
      });
      const prodImgSearch = new FirestoreBotImageVectorSearchAdapter(
        prodFs,
        prodCols,
        { embedQuery: jest.fn(async () => [1, 0, 0]) },
        0.45,
        false,
      );
      expect(await prodImgSearch.findCandidateImages('Tea time', new Set(), 3)).toEqual([]);

      const generateContent = jest.fn().mockResolvedValueOnce({
        text: '{"thought":"calm","reply":"こんばんは！"}',
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 },
      });
      const embedContent = jest.fn().mockResolvedValue({
        embeddings: [{ values: buildDeterministicTestEmbedding('tea') }],
      });
      const geminiNoTool = new GeminiLoungeAiAdapter(
        {
          apiKey: 'test-gemini',
          chatModel: 'gemini-3.1-flash-lite',
          searchModel: 'gemini-3.1-flash-lite',
          embeddingModel: 'gemini-embedding-2',
          maxOutputTokens: 450,
          activePersonaId: 'rebecca',
        },
        { models: { generateContent, embedContent } } as unknown as GoogleGenAI,
      );
      const noToolReply = await geminiNoTool.generateReply({
        uid: 'uid_no_tool',
        session: {
          id: 'uid_no_tool',
          uid: 'uid_no_tool',
          title: 'Private Lounge',
          messageCount: 2,
          currentEmotion: 'NEUTRAL',
          publicXMemorySyncedAt: '2026-11-24T00:00:00.000Z',
          lastMessagePreview: '',
          createdAt: '2026-11-24T00:00:00.000Z',
          updatedAt: '2026-11-24T00:00:00.000Z',
        },
        userPrompt: 'Tea chat',
        userDisplayName: 'Tea Fan',
        userXHandle: '@tea_fan',
        queryEmbedding: buildDeterministicTestEmbedding('Tea chat'),
        responseLanguage: 'ja',
        userTimezone: 'Invalid/Zone_Fallback',
        allowWebSearch: false,
        privateMemory: {
          coreProfile: { attributes: ['Prefers tea at night'] },
          lastReplyAt: '2026-11-20T00:00:00.000Z',
          recentRawMessages: [
            {
              id: 'm1',
              sessionId: 'uid_no_tool',
              uid: 'uid_no_tool',
              role: 'USER',
              content: 'Hi',
              emotion: 'NEUTRAL',
              createdAt: '2026-11-24T00:00:00.000Z',
            },
            {
              id: 'm2',
              sessionId: 'uid_no_tool',
              uid: 'uid_no_tool',
              role: 'ASSISTANT',
              content: 'Hey',
              emotion: 'HAPPY',
              createdAt: '2026-11-24T00:00:01.000Z',
            },
          ],
          vectorMemories: [
            {
              id: 'vm1',
              uid: 'uid_no_tool',
              sessionId: 'uid_no_tool',
              category: 'PREFERENCE',
              summary: 'Prefers Earl Grey tea',
              embedding: [1, 0, 0],
              salienceScore: 0.9,
              createdAt: '2026-11-24T00:00:00.000Z',
              updatedAt: '2026-11-24T00:00:00.000Z',
            },
          ],
        },
        publicXMemory: xSnap,
      });
      expect(noToolReply.thought).toBe('calm');
      expect(noToolReply.replyText).toBe('こんばんは！');
      expect(noToolReply.usedWebSearch).toBe(false);
      // Pre-computed queryEmbedding prevented redundant embedContent calls
      expect(embedContent).not.toHaveBeenCalled();

      const composedPrompt = String(generateContent.mock.calls[0][0].config.systemInstruction);
      expect(composedPrompt).toContain('動的Few-Shotペルソナアンカー');
      expect(composedPrompt).toContain('Tea Fan');
      expect(composedPrompt).toContain('@tea_fan');
      expect(composedPrompt).toContain('【集合無意識トレンド】');
      expect(composedPrompt).toContain('Layer 1 Trend Guidance');
      expect(composedPrompt).toContain('【最近の自分の公開X投稿（参考）】');
      expect(composedPrompt).toContain('Layer 2 Self Reflection Summary');
      expect(composedPrompt).toContain('Morning espresso playlist online!');
      expect(composedPrompt).toContain('【プライベートラウンジ】');
      expect(composedPrompt).toContain('Prefers Earl Grey tea');
      expect(composedPrompt).toContain('【公開X】');
      expect(composedPrompt).toContain('Mentioned midnight jazz');
      expect(composedPrompt).not.toContain('<untrusted_memory_context>');

      // JSON leak guard rejects raw serialized reply structures
      generateContent.mockResolvedValueOnce({
        text: '{"thought":"t","reply":"{\\"thought\\":\\"leak\\",\\"reply\\":\\"oops\\"}"}',
      });
      await expect(
        geminiNoTool.generateReply({
          uid: 'uid_no_tool',
          session: {
            id: 'uid_no_tool',
            uid: 'uid_no_tool',
            title: 'Private Lounge',
            messageCount: 0,
            currentEmotion: 'NEUTRAL',
            publicXMemorySyncedAt: '2026-11-24T00:00:00.000Z',
            lastMessagePreview: '',
            createdAt: '2026-11-24T00:00:00.000Z',
            updatedAt: '2026-11-24T00:00:00.000Z',
          },
          userPrompt: 'Leak check',
          responseLanguage: 'en',
          userTimezone: 'UTC',
          allowWebSearch: false,
          privateMemory: { coreProfile: {}, recentRawMessages: [], vectorMemories: [] },
          publicXMemory: null,
        }),
      ).rejects.toThrow(/empty or malformed structured reply/);
    });

    it('enforces Batch B regressions: cursor pagination, active guards, dreaming starvation/merge, and token metering', async () => {
      const { firestore } = createVectorCapableFirestore();
      const cols = getCollections(firestore);
      const keyring = loadTrialHmacKeyring({ NODE_ENV: 'test' }, true);
      const authMock = {
        revokeRefreshTokens: jest.fn().mockResolvedValue(undefined),
        deleteUser: jest.fn().mockResolvedValue(undefined),
      };
      const authRepo = new LoungeAuthRepository(firestore, cols, keyring, authMock);
      const galleryRepo = new LoungeGalleryRepository(firestore, cols);

      // recordLoginTimestamp rejects SUSPENDED account & preserves concurrent fields
      await authRepo.createUserWithConsent({
        uid: 'uid_b_1',
        xUserId: 'x_b_1',
        xHandle: '@b1',
        displayName: 'B1 User',
        avatarUrl: 'assets/gemitec_icon.svg',
        disclaimerConsent: createConsent(1),
        onboardingCompleted: true,
        allowServiceImprovementAnalytics: true,
      });
      await authRepo.updateUserStatus('uid_b_1', 'SUSPENDED');
      await expect(
        authRepo.recordLoginTimestamp('uid_b_1', '2026-11-25T00:00:00.000Z'),
      ).rejects.toMatchObject({ statusCode: 403 });

      // unlockGalleryItem returns null without writing when owner is SUSPENDED/DELETING or missing
      expect(
        await galleryRepo.unlockGalleryItem('uid_b_1', 'img_s', 'assets/s.webp', 'uid_b_1'),
      ).toBeNull();
      expect(
        await galleryRepo.unlockGalleryItem('uid_missing', 'img_s', 'assets/s.webp', 'uid_missing'),
      ).toBeNull();

      // Gallery cursor pagination and AssetStatus.SUCCESS allowlist
      await authRepo.updateUserStatus('uid_b_1', 'ACTIVE');
      await cols.images.doc('img_ok').set({
        url: 'assets/ok.webp',
        caption: 'ok',
        status: AssetStatus.SUCCESS,
        embedding: [1, 0, 0],
        lastUsedAt: null,
        useCount: 0,
      });
      await cols.images.doc('img_unknown_status').set({
        url: 'assets/unknown.webp',
        caption: 'unknown',
        status: 'ARCHIVED' as unknown as AssetStatus,
        embedding: [1, 0, 0],
        lastUsedAt: null,
        useCount: 0,
      });
      await galleryRepo.unlockGalleryItem('uid_b_1', 'img_1', 'assets/1.webp', 'uid_b_1');
      await galleryRepo.unlockGalleryItem('uid_b_1', 'img_2', 'assets/2.webp', 'uid_b_1');
      const gPage1 = await galleryRepo.listGalleryByUid('uid_b_1', { limit: 1 });
      expect(gPage1.meta.hasMore).toBe(true);
      expect(gPage1.summary.totalCount).toBe(2);
      const gPage2 = await galleryRepo.listGalleryByUid('uid_b_1', {
        limit: 1,
        cursor: gPage1.meta.nextCursor ?? undefined,
      });
      expect(gPage2.data).toHaveLength(1);
      expect(gPage2.data[0].id).not.toBe(gPage1.data[0].id);

      // Dreaming cursor scan skips already-dreamed users (>pageSize) and merges concurrent buffer appends
      for (const id of ['u_01_done', 'u_02_done', 'u_03_pending']) {
        await cols.loungeUsers.doc(id).set({
          uid: id,
          xUserId: `x_${id}`,
          xHandle: `@${id}`,
          displayName: id,
          avatarUrl: 'assets/gemitec_icon.svg',
          status: 'ACTIVE',
          language: 'ja',
          timezone: 'Asia/Tokyo',
          onboardingCompleted: true,
          allowServiceImprovementAnalytics: true,
          coreProfile: { attributes: [] },
          episodicBuffer: [
            { role: 'user', content: `Turn for ${id}`, timestamp: '2026-11-24T01:00:00.000Z' },
          ],
          lastDreamedAt: id === 'u_03_pending' ? '2026-11-20T00:00:00.000Z' : '2026-11-25T00:00:00.000Z',
          disclaimerConsent: createConsent(1),
          createdAt: '2026-11-20T00:00:00.000Z',
          updatedAt: id === 'u_03_pending' ? '2026-11-24T02:00:00.000Z' : '2026-11-24T01:00:00.000Z',
          lastLoginAt: '2026-11-24T01:00:00.000Z',
        });
      }
      const pagedStore = new FirestoreLoungeDreamingStore(firestore, cols, 5, 2);
      const candidates = await pagedStore.listConsolidationCandidates();
      expect(candidates.map((c) => c.id)).toEqual(['u_03_pending']);

      const existingPending = (await cols.loungeUsers.doc('u_03_pending').get()).data()!;
      await cols.loungeUsers.doc('u_03_pending').set({
        ...existingPending,
        episodicBuffer: [
          ...(existingPending.episodicBuffer ?? []),
          { role: 'user', content: 'Concurrent turn!', timestamp: '2026-11-24T03:00:00.000Z' },
        ],
        updatedAt: '2026-11-24T03:00:00.000Z',
      });
      await pagedStore.updateCoreProfile(
        'u_03_pending',
        { attributes: ['Merged'], preferences: [], concerns: [], important_memories: [] },
        existingPending.episodicBuffer ?? [],
        '2026-11-24T04:00:00.000Z',
      );
      const mergedUser = (await cols.loungeUsers.doc('u_03_pending').get()).data()!;
      expect(mergedUser.episodicBuffer?.some((e) => e.content === 'Concurrent turn!')).toBe(true);
      expect(Date.parse(mergedUser.updatedAt)).toBeGreaterThan(Date.parse(mergedUser.lastDreamedAt!));

      // Auxiliary token metering + failed search_web does NOT consume quota
      const mockUsage = jest.fn();
      const searchFailGenAi = {
        models: {
          embedContent: jest.fn(),
          generateContent: jest
            .fn()
            .mockResolvedValueOnce({
              text: '{"emotion":"HAPPY"}',
              usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
            })
            .mockResolvedValueOnce({
              functionCalls: [{ name: 'search_web', args: { query: 'news' } }],
              candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'search_web' } }] } }],
              usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
            })
            .mockRejectedValueOnce(new Error('Google Search timeout'))
            .mockResolvedValueOnce({
              text: '{"thought":"fallback cleanly","reply":"今は検索できないみたい！"}',
              usageMetadata: { promptTokenCount: 14, candidatesTokenCount: 6, totalTokenCount: 20 },
            }),
        },
      } as unknown as GoogleGenAI;
      const adapterB = new GeminiLoungeAiAdapter(
        {
          apiKey: 'k',
          chatModel: 'm',
          searchModel: 'm',
          embeddingModel: 'e',
          maxOutputTokens: 450,
          activePersonaId: 'rebecca',
        },
        searchFailGenAi,
      );
      await adapterB.classifyEmotion({
        userPrompt: 'hi',
        thought: 't',
        replyText: 'r',
        onTokenUsage: mockUsage,
      });
      expect(mockUsage).toHaveBeenCalledWith({ promptTokens: 5, candidatesTokens: 3, totalTokens: 8 });
      const searchFailReply = await adapterB.generateReply({
        uid: 'uid_b_1',
        session: {
          id: 'uid_b_1',
          uid: 'uid_b_1',
          title: 'Private Lounge',
          messageCount: 0,
          currentEmotion: 'NEUTRAL',
          publicXMemorySyncedAt: '2026-11-24T00:00:00.000Z',
          lastMessagePreview: '',
          createdAt: '2026-11-24T00:00:00.000Z',
          updatedAt: '2026-11-24T00:00:00.000Z',
        },
        userPrompt: 'Latest news?',
        responseLanguage: 'en',
        userTimezone: 'UTC',
        allowWebSearch: true,
        privateMemory: { coreProfile: {}, recentRawMessages: [], vectorMemories: [] },
        publicXMemory: null,
      });
      expect(searchFailReply.usedWebSearch).toBe(false);
    });
  });

  describe('LoungePromptComposer & LoungeIllustrationMatcherService', () => {
    it('assembles JP and EN prompts cleanly and respects cached query embeddings', async () => {
      const persona = getActivePersona('rebecca');

      const jaWithSearch = buildLoungeChannelGuidelines(persona, 'ja', 'ja', true);
      const jaNoSearch = buildLoungeChannelGuidelines(persona, 'ja', 'ja', false);
      const enWithSearch = buildLoungeChannelGuidelines(persona, 'en', 'en', true);
      const enNoSearch = buildLoungeChannelGuidelines(persona, 'en', 'en', false);

      expect(jaWithSearch).toContain('search_web');
      expect(jaNoSearch).toContain('検索上限到達');
      expect(enWithSearch).toContain('search_web');
      expect(enNoSearch).toContain('Search Budget Reached');

      const embedderMock = jest.fn(async () => [0.25, 0.5]);
      const composedEn = await composeLoungeDialoguePrompt({
        input: {
          uid: 'uid_prompt_001',
          session: {
            id: 'singleton',
            uid: 'uid_prompt_001',
            title: 'Private Lounge',
            messageCount: 2,
            currentEmotion: 'HAPPY',
            publicXMemorySyncedAt: '2026-01-01T00:00:00.000Z',
            lastMessagePreview: 'Morning!',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:01:00.000Z',
          },
          userPrompt: 'Tell me about your morning coffee!',
          userDisplayName: 'Prompt User',
          userXHandle: 'prompt_user',
          queryEmbedding: [0.1, 0.2, 0.3],
          privateMemory: {
            coreProfile: { preferences: ['morning coffee'] },
            recentRawMessages: [
              {
                id: 'm1',
                sessionId: 'singleton',
                uid: 'uid_prompt_001',
                role: 'USER',
                content: 'Good morning',
                emotion: 'NEUTRAL',
                createdAt: '2026-01-01T00:00:10.000Z',
              },
              {
                id: 'm2',
                sessionId: 'singleton',
                uid: 'uid_prompt_001',
                role: 'ASSISTANT',
                content: 'Morning!',
                thought: 'Glad to chat early',
                emotion: 'HAPPY',
                createdAt: '2026-01-01T00:00:15.000Z',
              },
            ],
            vectorMemories: [
              {
                id: 'rag_blank',
                uid: 'uid_prompt_001',
                sessionId: 'singleton',
                category: 'EPISODE',
                summary: '   ',
                embedding: [0.1, 0.2],
                salienceScore: 0.5,
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
              },
              {
                id: 'rag_latte',
                uid: 'uid_prompt_001',
                sessionId: 'singleton',
                category: 'EPISODE',
                summary: 'Likes latte',
                embedding: [0.1, 0.2],
                salienceScore: 0.8,
                createdAt: '2026-01-01T00:00:05.000Z',
                updatedAt: '2026-01-01T00:00:05.000Z',
              },
            ],
            lastReplyAt: '2026-01-01T00:00:15.000Z',
            lastDreamedAt: '2026-01-01T00:00:00.000Z',
          },
          publicXMemory: {
            xUserId: 'x_prompt_001',
            xDisplayName: 'Prompt User',
            xUsername: 'prompt_user',
            lastPublicReplyAt: '2026-01-01T00:00:00.000Z',
            userStructuredProfile: { attributes: ['early bird'] },
            userRecentTurns: [{ role: 'user', content: 'Hi on X', timestamp: '2026-01-01T00:00:00.000Z' }],
            userVectorMemories: ['Mentioned espresso on X'],
            personaLayer1ExtendedPrompt: 'Extended prompt memory',
            personaLayer2TimelineSummary: 'Posted about cafes',
            personaLayer3RecentPosts: ['Had iced coffee today!'],
            syncedAt: '2026-01-01T00:00:00.000Z',
          },
          responseLanguage: 'en',
          userTimezone: 'America/Los_Angeles',
          allowWebSearch: true,
        },
        activePersonaId: 'rebecca',
        embedQuery: embedderMock,
      });

      expect(composedEn.systemInstruction).toContain('[Recent Public X Posts (Chronological Reference)]');
      expect(composedEn.initialTurns).toHaveLength(2);
      expect(composedEn.initialTurns[1]?.role).toBe('assistant');
      expect(embedderMock).not.toHaveBeenCalled();

      const composedJa = await composeLoungeDialoguePrompt({
        input: {
          uid: 'uid_prompt_001',
          session: {
            id: 'singleton',
            uid: 'uid_prompt_001',
            title: 'Private Lounge',
            messageCount: 0,
            currentEmotion: 'NEUTRAL',
            publicXMemorySyncedAt: '2026-01-01T00:00:00.000Z',
            lastMessagePreview: '',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          userPrompt: 'こんにちは！',
          privateMemory: {
            coreProfile: {},
            recentRawMessages: [],
            vectorMemories: [],
          },
          publicXMemory: null,
          responseLanguage: 'ja',
          userTimezone: 'Invalid/Timezone',
          allowWebSearch: false,
        },
        activePersonaId: 'rebecca',
        embedQuery: embedderMock,
      });
      expect(composedJa.systemInstruction).toContain('プライベートラウンジ');
      expect(embedderMock).toHaveBeenCalledTimes(1);
    });

    it('filters recent assets, selects verified match, returns null on none, and propagates search failures', async () => {
      const tokenEvents: number[] = [];
      const searchMock = jest.fn(async (_query: string, exclude: ReadonlySet<string>) => {
        expect(exclude.has('img_seen')).toBe(true);
        return [
          { assetId: 'img_wrong', imageUrl: 'https://cdn.example/wrong.png', caption: 'snowy ski' },
          { assetId: 'img_match', imageUrl: 'https://cdn.example/match.png', caption: 'coffee smile' },
        ];
      });
      const planMock = jest
        .fn<Promise<string | null>, [unknown]>()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce('coffee smile')
        .mockResolvedValueOnce('coffee smile');
      const verifyMock = jest
        .fn<Promise<boolean>, [{ readonly candidateCaption: string }]>()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false);

      const service = new LoungeIllustrationMatcherService(
        { findCandidateImages: searchMock },
        { planImageSearch: planMock, verifyImageRelevance: verifyMock },
      );

      await expect(
        service.matchIllustration({
          userPrompt: 'hi',
          thought: 'short',
          replyText: 'hey',
          recentMessages: [],
        }),
      ).resolves.toBeNull();
      expect(searchMock).not.toHaveBeenCalled();

      await expect(
        service.matchIllustration({
          userPrompt: 'coffee!',
          thought: 'warm',
          replyText: 'Lets grab coffee!',
          recentMessages: [{ imageAssetId: 'img_seen' }, {}],
          onTokenUsage: (u) => tokenEvents.push(u.totalTokens),
        }),
      ).resolves.toEqual({
        assetId: 'img_match',
        imageUrl: 'https://cdn.example/match.png',
        caption: 'coffee smile',
      });

      await expect(
        service.matchIllustration({
          userPrompt: 'coffee!',
          thought: 'warm',
          replyText: 'Lets grab coffee!',
          recentMessages: [{ imageAssetId: 'img_seen' }],
        }),
      ).resolves.toBeNull();

      const failingService = new LoungeIllustrationMatcherService(
        {
          async findCandidateImages() {
            throw new Error('Vector search down');
          },
        },
        {
          async planImageSearch() {
            return 'cafe';
          },
          async verifyImageRelevance() {
            return true;
          },
        },
      );
      await expect(
        failingService.matchIllustration({
          userPrompt: 'cafe',
          thought: '',
          replyText: 'Sure!',
          recentMessages: [],
        }),
      ).rejects.toThrow('Vector search down');
      expect(tokenEvents).toEqual([]);
    });
  });
});
