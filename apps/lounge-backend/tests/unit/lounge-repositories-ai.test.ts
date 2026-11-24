import crypto from 'node:crypto';
import type { GoogleGenAI } from '@google/genai';
import { Timestamp, type Firestore } from '@google-cloud/firestore';
import express from 'express';
import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import request from 'supertest';
import { COLLECTIONS, getCollections } from '@rebecca/db';
import {
  AssetStatus,
  type LoungeUserDisclaimerConsent,
} from '@rebecca/types';
import { loadTrialHmacKeyring } from '../../src/config/loungeConfig';
import { LoungeAccountRepository } from '../../src/features/account/repositories/loungeAccount.repository';
import {
  FirebaseLoungeAuthVerifier,
  resolveFirebaseLoungeAuthClient,
} from '../../src/features/auth/adapters/firebaseLoungeAuth.verifier';
import { LoungeAuthRepository } from '../../src/features/auth/repositories/loungeAuth.repository';
import {
  createLoungeBatchRouter,
  FirestoreLoungeDreamingStore,
  LoungeDreamingBatchService,
} from '../../src/features/dreaming/loungeDreaming.service';
import { LoungeGalleryRepository } from '../../src/features/gallery/repositories/loungeGallery.repository';
import {
  buildDeterministicTestEmbedding,
  FirestoreBotImageVectorSearchAdapter,
  FirestorePublicXMemoryReadAdapter,
  GeminiLoungeAiAdapter,
  LocalEmulatorLoungeAiAdapter,
} from '../../src/features/sessions/adapters/geminiLoungeAi.adapters';
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
    it('resolves tenant-aware Firebase Admin Auth clients and verifies X identities & emulator tokens', async () => {
      (getApps as jest.Mock).mockReturnValueOnce([]);
      resolveFirebaseLoungeAuthClient('proj-1', 'tenant-lounge');
      expect(initializeApp).toHaveBeenCalledWith({ projectId: 'proj-1' }, 'lounge-bff-auth');

      (getApps as jest.Mock).mockReturnValueOnce([{ name: 'lounge-bff-auth' }]);
      resolveFirebaseLoungeAuthClient('proj-1');
      expect(getAuth).toHaveBeenCalled();

      (getApps as jest.Mock).mockReturnValue([{ name: '[DEFAULT]' }]);
      resolveFirebaseLoungeAuthClient('');
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

    it('authenticates non-prod timing-safe x-batch-secret and production Google OIDC tokens', async () => {
      const verifyIdToken = jest.fn();
      const nonProdApp = express();
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

      // Production ignores x-batch-secret and enforces Bearer OIDC verification
      const prodApp = express();
      prodApp.post(
        '/run',
        createLoungeBatchAuthMiddleware({
          nodeEnv: 'production',
          batchSecretKey: 'super-secret-batch',
          expectedAudience: 'https://lounge.example.com',
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

      verifyIdToken.mockResolvedValueOnce({});
      expect(
        (await request(prodApp).post('/run').set('Authorization', 'Bearer oidc-good')).status,
      ).toBe(200);
    });
  });

  describe('Firestore Repositories & Chunked Batch Deletion', () => {
    it('executes auth, account, gallery, and chunked deletion lifecycle cleanly', async () => {
      const { firestore } = createVectorCapableFirestore();
      const cols = getCollections(firestore);
      const keyring = loadTrialHmacKeyring({ NODE_ENV: 'test' });
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
        preferredCurrency: 'JPY',
      });
      expect(created.uid).toBe('uid_repo_1');
      expect((await authRepo.findUserByUid('uid_repo_1'))?.xUserId).toBe('x_repo_1');
      expect((await authRepo.findUserByXUserId('x_repo_1'))?.uid).toBe('uid_repo_1');
      expect(await authRepo.findUserByXUserId('missing_x')).toBeNull();

      await expect(
        authRepo.createUserWithConsent({
          uid: 'uid_repo_2',
          xUserId: 'x_repo_1',
          xHandle: '@repo1',
          displayName: 'Dup',
          avatarUrl: 'assets/gemitec_icon.svg',
          disclaimerConsent: createConsent(1),
          onboardingCompleted: false,
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

      // Account repository search counter, quota decrement & lot lookup
      await accountRepo.incrementDailySearchCount('uid_repo_1');
      expect((await accountRepo.getSubscriptionDocByUid('uid_repo_1'))?.todaysSearchCount).toBe(1);
      expect((await accountRepo.listActiveCreditLotsByUid('uid_repo_1'))).toHaveLength(1);
      const decSub = await accountRepo.decrementRemainingTurns('uid_repo_1');
      expect(decSub.dailyRemainingTurns).toBe(4);

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
      expect(unlocked.unlocked).toBe(true);
      // Idempotent unlock
      expect(
        (await galleryRepo.unlockGalleryItem('uid_repo_1', 'img_ready', 'assets/ready.webp', 'uid_repo_1')).id,
      ).toBe(unlocked.id);

      const listRes = await galleryRepo.listGalleryByUid('uid_repo_1', { page: 1, limit: 10 });
      expect(listRes.summary).toEqual({ unlockedCount: 1, totalCount: 1 });
      expect(listRes.data).toHaveLength(1);

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
      expect(snapshot?.userVectorMemories).toEqual(['Loves city pop vinyl']);
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
      expect(await imgAdapter.findBestMatchingImage('Coffee chat!', 'HAPPY')).toEqual({
        assetId: 'img_good',
        imageUrl: 'assets/good.webp',
      });

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
      expect(await prodImgAdapter.findBestMatchingImage('Coffee!', 'HAPPY')).toEqual({
        assetId: 'img_prod',
        imageUrl: 'assets/prod.webp',
      });
      embedPort.embedQuery.mockResolvedValueOnce([]);
      expect(await prodImgAdapter.findBestMatchingImage('Empty embed', 'NEUTRAL')).toBeNull();
      const nonEmuBrokenImg = new FirestoreBotImageVectorSearchAdapter(emuFs, emuCols, embedPort, 0.45, false);
      expect(await nonEmuBrokenImg.findBestMatchingImage('Coffee!', 'HAPPY')).toBeNull();
    });

    it('invokes Gemini Flash-Lite search_web tool loop, fallback retry, LocalEmulator adapter & Dreaming endpoint', async () => {
      const embedContent = jest.fn().mockResolvedValue({
        embeddings: [{ values: buildDeterministicTestEmbedding('coffee') }],
      });
      const generateContent = jest
        .fn()
        // classifyEmotion response
        .mockResolvedValueOnce({ text: '{"emotion":"EXCITED"}' })
        // Round 1 of chat dialogue loop: triggers search_web tool
        .mockResolvedValueOnce({
          functionCalls: [{ name: 'search_web', args: { query: 'Tokyo weather' } }],
          candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'search_web' } }] } }],
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, totalTokenCount: 25 },
        })
        // executeWebSearch Google Search grounding call
        .mockResolvedValueOnce({ text: 'Clear skies 18C in Tokyo.' })
        // Round 2 final JSON reply
        .mockResolvedValueOnce({
          text: '{"thought":"warm reply","reply":"東京は18℃で晴れみたいだよ！","emotion":"HAPPY"}',
          usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 15, totalTokenCount: 45 },
        })
        // Dreaming synthesis JSON response
        .mockResolvedValueOnce({
          text: '{"interests":["City Pop"],"recentTopics":["Weather"]}',
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
      expect(await geminiAdapter.classifyEmotion('Yay!')).toBe('EXCITED');
      const reply = await geminiAdapter.generateReply({
        uid: 'uid_ai_1',
        session: mockSession,
        userPrompt: '今日の東京の天気教えて！',
        responseLanguage: 'ja',
        userTimezone: 'Asia/Tokyo',
        allowWebSearch: true,
        localePromptDirective: 'Reply in Japanese.',
        memoryPromptDirective: '<untrusted_memory_context>Coffee lover</untrusted_memory_context>',
        privateMemory: {
          coreProfile: { interests: ['Espresso'] },
          recentRawMessages: [],
          vectorMemories: [],
        },
        publicXMemory: null,
      });
      expect(reply.usedWebSearch).toBe(true);
      expect(reply.emotion).toBe('HAPPY');
      expect(reply.tokenUsage.totalTokens).toBe(70);

      // LocalEmulatorLoungeAiAdapter coverage across heuristics & dreaming
      const localAi = new LocalEmulatorLoungeAiAdapter();
      expect(await localAi.embedQuery('')).toEqual([]);
      expect((await localAi.embedQuery('hello')).length).toBe(768);
      expect(await localAi.classifyEmotion('すごい！')).toBe('EXCITED');
      expect(await localAi.classifyEmotion('どうしてかな？')).toBe('THOUGHTFUL');
      expect(await localAi.classifyEmotion('ありがとう')).toBe('HAPPY');
      expect(await localAi.classifyEmotion('まさか')).toBe('SURPRISED');
      expect(await localAi.classifyEmotion('照れるな')).toBe('SHY');
      expect(await localAi.classifyEmotion('ふふっ')).toBe('TEASING');
      const localReply = await localAi.generateReply({
        uid: 'uid_emu',
        session: { ...mockSession, id: 'uid_emu', uid: 'uid_emu' },
        userPrompt: '今日の天気検索して',
        responseLanguage: 'en',
        userTimezone: 'UTC',
        allowWebSearch: true,
        localePromptDirective: 'English',
        memoryPromptDirective: '',
        privateMemory: { coreProfile: {}, recentRawMessages: [], vectorMemories: [] },
        publicXMemory: null,
      });
      expect(localReply.usedWebSearch).toBe(true);

      // Nightly Batch Dreaming via HTTP /batch/dreaming route
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
        .post('/api/v1/lounge/batch/dreaming')
        .set('x-batch-secret', 'sec-1');
      expect(batchRes.status).toBe(200);
      expect(batchRes.body.succeeded).toBe(1);
      expect(batchRes.body.processedUsers).toBe(1);
      const updatedUser = (await cols.loungeUsers.doc('uid_dream_1').get()).data()!;
      expect((updatedUser.coreProfile as { interests?: string[] })?.interests).toContain('City Pop');

      // Exercise Gemini tool-loop retry fallback + Dreaming malformed fallback + Batch 500 error masking
      generateContent
        .mockResolvedValueOnce({ text: 'not valid json for tool loop' })
        .mockResolvedValueOnce({
          text: '{"thought":"recovered","reply":"ツールなしで答えるよ！","emotion":"NEUTRAL"}',
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5, totalTokenCount: 10 },
        })
        .mockResolvedValueOnce({ text: 'invalid-dreaming-json' });

      const retryReply = await geminiAdapter.generateReply({
        uid: 'uid_ai_1',
        session: mockSession,
        userPrompt: 'Fallback check',
        responseLanguage: 'ja',
        userTimezone: 'Asia/Tokyo',
        allowWebSearch: true,
        localePromptDirective: 'Japanese',
        memoryPromptDirective: '',
        privateMemory: { coreProfile: {}, recentRawMessages: [], vectorMemories: [] },
        publicXMemory: null,
      });
      expect(retryReply.replyText).toBe('ツールなしで答えるよ！');
      expect(
        await geminiAdapter.generateDreaming('Prompt', [], { preserved: true }),
      ).toEqual({ preserved: true });

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

      // Gemini empty/error fallback & LocalEmulator dreaming
      expect(await geminiAdapter.embedQuery('   ')).toEqual([]);
      expect(await geminiAdapter.classifyEmotion('   ')).toBe('NEUTRAL');
      generateContent.mockRejectedValueOnce(new Error('classifier down'));
      expect(await geminiAdapter.classifyEmotion('Yay!')).toBe('EXCITED');
      expect(await geminiAdapter.executeWebSearch('   ')).toContain('クエリ');
      generateContent.mockRejectedValueOnce(new Error('search down'));
      expect(await geminiAdapter.executeWebSearch('Tokyo weather')).toContain('検索エラー');
      const emuDreamed = await localAi.generateDreaming(
        'sys',
        [{ role: 'user', content: 'Jazz bars' }],
        { hobby: 'vinyl' },
      );
      expect((emuDreamed as { recentTopics?: string[] }).recentTopics).toEqual(['Jazz bars']);

      // Auth & Account missing-user and error propagation paths
      const { firestore: edgeFs } = createVectorCapableFirestore();
      const edgeCols = getCollections(edgeFs);
      const edgeKeyring = loadTrialHmacKeyring({ NODE_ENV: 'test' });
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
      await edgeAccountRepo.incrementDailySearchCount('uid_none');
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
      const xSnap = await prodXReader.readPublicXMemorySnapshot('x_prod_rag', [1, 0, 0]);
      expect(xSnap?.userVectorMemories).toEqual(['Mentioned midnight jazz']);

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
      expect(await prodImgSearch.findBestMatchingImage('Tea time', 'NEUTRAL')).toBeNull();

      const generateContent = jest.fn().mockResolvedValueOnce({
        text: '{"thought":"calm","reply":"こんばんは！","emotion":"UNKNOWN_EMOTION"}',
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
        responseLanguage: 'ja',
        userTimezone: 'Asia/Tokyo',
        allowWebSearch: false,
        localePromptDirective: 'Japanese',
        memoryPromptDirective: 'Memory context',
        privateMemory: {
          coreProfile: {},
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
      expect(noToolReply.emotion).toBe('NEUTRAL');
      expect(noToolReply.usedWebSearch).toBe(false);
    });
  });
});
