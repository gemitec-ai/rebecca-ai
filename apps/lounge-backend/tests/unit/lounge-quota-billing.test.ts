import crypto from 'node:crypto';
import { Timestamp, type Firestore } from '@google-cloud/firestore';
import request from 'supertest';
import Stripe from 'stripe';
import { getCollections } from '@rebecca/db';
import type {
  LoungeCreditLotDoc,
  LoungeSubscriptionDoc,
  LoungeTrialGrantDoc,
  LoungeUserDisclaimerConsent,
} from '@rebecca/types';
import { createLoungeApp, createProductionLoungeDependencies } from '../../src/app';
import {
  assertSafeStripeKeyConfiguration,
  computeActiveTrialGrantHash,
  computeAllTrialGrantHashes,
  computeTrialHmacDigest,
  loadLoungeRuntimeConfig,
  loadTrialHmacKeyring,
  resolveClientGeo,
} from '../../src/config/loungeConfig';
import { StripeSdkGatewayAdapter } from '../../src/features/billing/adapters/stripeSdkGateway.adapter';
import {
  applySubscriptionTransition,
  buildQuotaBreakdownAndWarning,
  evaluateLazyQuotaState,
  LoungeQuotaEngine,
  nextLocalMidnightAfter,
  resolveNextDailyResetIso,
} from '../../src/features/billing/domain/loungeQuota.engine';
import { LocalTestStripeGatewayAdapter } from '../../src/features/billing/ports/loungeStripe.port';
import {
  maskCheckoutSessionId,
  parseAndValidateCreateCheckoutRequest,
  parseAndValidateEuWithdrawalRequest,
  parseAndValidatePortalRequest,
  parseAndValidateVerifyCheckoutRequest,
  parseOrdersQueryParams,
} from '../../src/features/billing/usecases/loungeBilling.usecase';

jest.mock('firebase-admin/app', () => ({
  initializeApp: jest.fn().mockReturnValue({ name: 'lounge-bff-auth' }),
  getApps: jest.fn().mockReturnValue([]),
  getApp: jest.fn().mockReturnValue({ name: '[DEFAULT]' }),
}));

jest.mock('firebase-admin/auth', () => ({
  getAuth: jest.fn().mockReturnValue({
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
  }),
}));

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

function createInMemoryFirestore() {
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
        const converted = converter
          ? converter.fromFirestore({ id, data: () => clone })
          : (clone as unknown as T);
        return {
          id,
          ref: refObj,
          exists: true,
          data: () => converted,
        };
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

    return {
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

function validConsent(version = 1): LoungeUserDisclaimerConsent {
  return {
    disclaimerVersion: version,
    agreedToGeminiTrainingUsage: true,
    agreedToZeroPiiProhibition: true,
    agreedToOneWayMemoryIsolation: true,
    scrolledToBottomAt: '2026-11-22T12:00:00.000Z',
    consentedAt: '2026-11-22T12:00:05.000Z',
  };
}

function createSignedWebhookArgs(payload: Record<string, unknown>, secret = 'whsec_test_secret') {
  const rawText = JSON.stringify(payload);
  const rawBody = Buffer.from(rawText, 'utf8');
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawText}`, 'utf8')
    .digest('hex');
  return {
    rawBody,
    rawText,
    signature: `t=${timestamp},v1=${sig}`,
    secret,
  };
}

describe('Private Lounge Config, Hybrid Quota Engine & Stripe Billing Lifecycle', () => {
  describe('loungeConfig, Stripe Test-Key Guard & HMAC Keyring', () => {
    it('blocks all Stripe *_live_* keys outside production and allows them in production', () => {
      const keyNames = [
        'STRIPE_SECRET_KEY',
        'STRIPE_PUBLISHABLE_KEY',
        'LOUNGE_STRIPE_SECRET_KEY',
        'LOUNGE_STRIPE_PUBLISHABLE_KEY',
      ] as const;
      const livePrefixes = ['sk_live_abc', 'rk_live_abc', 'pk_live_abc'] as const;

      for (const keyName of keyNames) {
        for (const liveVal of livePrefixes) {
          expect(() =>
            assertSafeStripeKeyConfiguration({ NODE_ENV: 'development', [keyName]: liveVal }),
          ).toThrow(/Refusing live Stripe key/);
          expect(() =>
            assertSafeStripeKeyConfiguration({ [keyName]: liveVal }),
          ).toThrow(/Refusing live Stripe key/);
        }
      }

      expect(() =>
        assertSafeStripeKeyConfiguration({
          NODE_ENV: 'test',
          STRIPE_SECRET_KEY: 'sk_test_123',
          STRIPE_PUBLISHABLE_KEY: 'pk_test_123',
        }),
      ).not.toThrow();
      expect(() =>
        assertSafeStripeKeyConfiguration({
          NODE_ENV: 'production',
          STRIPE_SECRET_KEY: 'sk_live_prod_only',
        }),
      ).not.toThrow();
    });

    it('resolves Geo-IP countries, EEA flags, currency locks, and rotated HMAC keyrings', () => {
      expect(resolveClientGeo({ 'x-client-country': 'jp' })).toEqual({
        countryCode: 'JP',
        isEeaResident: false,
        currency: 'JPY',
      });
      expect(resolveClientGeo({ 'cf-ipcountry': 'de' })).toEqual({
        countryCode: 'DE',
        isEeaResident: true,
        currency: 'USD',
      });
      expect(resolveClientGeo({ 'x-client-country': 'invalid' }, { defaultCountryCode: 'GB' })).toEqual({
        countryCode: 'GB',
        isEeaResident: true,
        currency: 'USD',
      });
      expect(
        resolveClientGeo({ 'x-client-country': 'US' }, { existingPreferredCurrency: 'JPY' }),
      ).toEqual({
        countryCode: 'US',
        isEeaResident: false,
        currency: 'JPY',
      });

      expect(() =>
        loadTrialHmacKeyring({ NODE_ENV: 'test', LOUNGE_TRIAL_HMAC_KEYS: '{bad' }),
      ).toThrow(/Invalid JSON in LOUNGE_TRIAL_HMAC_KEYS/);
      expect(() =>
        loadTrialHmacKeyring({ NODE_ENV: 'test', LOUNGE_TRIAL_HMAC_KEYS: '["a"]' }),
      ).toThrow(/must be a JSON object/);
      expect(() =>
        loadTrialHmacKeyring({ NODE_ENV: 'test', LOUNGE_TRIAL_HMAC_KEYS: '{"0":"abc"}' }),
      ).toThrow(/Invalid HMAC key entry/);
      expect(() => loadTrialHmacKeyring({ NODE_ENV: 'production' })).toThrow(
        /required in production/,
      );

      const rotated = loadTrialHmacKeyring({
        NODE_ENV: 'production',
        LOUNGE_TRIAL_HMAC_KEYS: '{"1":"old-sec","3":"new-sec"}',
      });
      expect(rotated.activeVersion).toBe(3);
      const hashes = computeAllTrialGrantHashes('100001', rotated);
      expect(hashes.map((h) => h.keyVersion)).toEqual([3, 1]);
      expect(computeActiveTrialGrantHash('100001', rotated).keyVersion).toBe(3);
      expect(() => computeTrialHmacDigest('   ', 'sec')).toThrow(/must not be empty/);
      expect(() =>
        computeActiveTrialGrantHash('100001', { activeVersion: 99, keys: rotated.keys }),
      ).toThrow(/Missing HMAC secret/);
    });

    it('validates runtime env config bounds, production projectId, and origin protocols', () => {
      expect(() =>
        loadLoungeRuntimeConfig({ NODE_ENV: 'production', LOUNGE_TRIAL_HMAC_SECRET_V1: 'sec' }, '1.0.0', 1),
      ).toThrow(/GCP_PROJECT_ID/);

      expect(() =>
        loadLoungeRuntimeConfig(
          {
            NODE_ENV: 'production',
            GCP_PROJECT_ID: 'proj-1',
            LOUNGE_PUBLIC_ORIGIN: 'ftp://invalid.example.com',
            LOUNGE_TRIAL_HMAC_SECRET_V1: 'sec',
          },
          '1.0.0',
          1,
        ),
      ).toThrow(/Invalid LOUNGE_PUBLIC_ORIGIN/);

      const cfg = loadLoungeRuntimeConfig(
        {
          NODE_ENV: 'production',
          GCP_PROJECT_ID: 'proj-1',
          LOUNGE_PUBLIC_ORIGIN: 'https://lounge.example.com/',
          LOUNGE_TRIAL_HMAC_SECRET_V1: 'sec',
          FIREBASE_WEB_API_KEY: 'api-key-1',
          FIREBASE_WEB_APP_ID: 'app-id-1',
          LOUNGE_FIREBASE_TENANT_ID: 'tenant-lounge',
          LOUNGE_MAX_OUTPUT_TOKENS: '999',
          LOUNGE_IMAGE_SIMILARITY_THRESHOLD: 'NaN',
          NO_AUTH: 'true',
          BATCH_SECRET_KEY: 'ignored-in-prod',
          PORT: 'invalid',
        },
        '1.45.2',
        2,
      );
      expect(cfg.port).toBe(8083);
      expect(cfg.geminiMaxOutputTokens).toBe(450);
      expect(cfg.imageSimilarityThreshold).toBe(0.45);
      expect(cfg.noAuth).toBe(false);
      expect(cfg.batchSecretKey).toBeUndefined();
      expect(cfg.loungePublicOrigin).toBe('https://lounge.example.com');
      expect(cfg.firebaseWebConfig?.tenantId).toBe('tenant-lounge');
    });
  });

  describe('LoungeQuotaEngine (DST, TZ-Change Clamp, FIFO, Midday Transitions & Compensation)', () => {
    it('computes DST spring-forward local midnights and enforces 24h anti-TZ-hop clamps', () => {
      // America/Los_Angeles enters DST on 2026-03-08 (UTC-8 -> UTC-7); midnight is 08:00Z
      const beforeDstMidnight = new Date('2026-03-07T18:00:00.000Z');
      expect(nextLocalMidnightAfter(beforeDstMidnight, 'America/Los_Angeles')).toBe(
        '2026-03-08T08:00:00.000Z',
      );
      // Following day crosses DST boundary -> midnight is 07:00Z
      const dstDayAfternoon = new Date('2026-03-08T20:00:00.000Z');
      expect(nextLocalMidnightAfter(dstDayAfternoon, 'America/Los_Angeles')).toBe(
        '2026-03-09T07:00:00.000Z',
      );
      // Invalid timezone gracefully falls back to Asia/Tokyo
      expect(nextLocalMidnightAfter(new Date('2026-11-24T12:00:00.000Z'), 'Mars/Olympus')).toBe(
        '2026-11-24T15:00:00.000Z',
      );

      // TZ changed right after a midnight reset cannot jump reset earlier than +24h
      const lastResetIso = '2026-11-24T00:00:00.000Z';
      const nowIso = new Date('2026-11-24T01:00:00.000Z');
      const clampedReset = resolveNextDailyResetIso(nowIso, lastResetIso, 'UTC', 'Asia/Tokyo');
      expect(Date.parse(clampedReset)).toBeGreaterThanOrEqual(
        Date.parse(lastResetIso) + 24 * 60 * 60 * 1000,
      );
      expect(resolveNextDailyResetIso(nowIso, 'not-a-date', 'UTC', 'Asia/Tokyo')).toBe(
        nextLocalMidnightAfter(nowIso, 'Asia/Tokyo'),
      );
    });

    it('handles lazy rollover, CANCELING period-end downgrade, intraday expiry, and FIFO reserve/compensate', async () => {
      const { firestore } = createInMemoryFirestore();
      const cols = getCollections(firestore);
      const engine = new LoungeQuotaEngine(firestore, cols);
      const uid = 'uid_quota_001';

      expect(await engine.syncLazyState(uid, 'Asia/Tokyo')).toBeNull();

      const now = new Date('2026-11-24T10:00:00.000Z');
      const baseSub: LoungeSubscriptionDoc = {
        uid,
        tier: 'STANDARD',
        status: 'CANCELING',
        billingCurrency: 'JPY',
        dailyTurnQuota: 100,
        dailyRemainingTurns: 1,
        purchasedRemainingTurns: 5,
        remainingChatTurns: 6,
        earliestLotExpiresAt: '2026-11-24T09:00:00.000Z',
        lastDailyResetAt: '2026-11-23T15:00:00.000Z',
        lastQuotaResetTimezone: 'Asia/Tokyo',
        nextDailyResetAt: '2026-11-25T15:00:00.000Z',
        currentPeriodEnd: '2026-11-24T09:30:00.000Z',
        trialTicketUsed: true,
        cancelAtPeriodEnd: true,
        todaysConsumedDailyTurns: 99,
        todaysSearchCount: 1,
        updatedAt: '2026-11-24T08:00:00.000Z',
      };

      const expiredLot: LoungeCreditLotDoc = {
        id: 'lot_expired',
        uid,
        productId: 'WELCOME_BONUS_20',
        isPaid: false,
        initialTurns: 20,
        remainingTurns: 3,
        currency: 'NONE',
        unitAmount: 0,
        status: 'ACTIVE',
        purchasedAt: '2026-05-01T00:00:00.000Z',
        expiresAt: '2026-11-24T09:00:00.000Z',
      };
      const soonLot: LoungeCreditLotDoc = {
        id: 'lot_soon',
        uid,
        productId: 'TRIAL_TICKET_100',
        isPaid: true,
        initialTurns: 100,
        remainingTurns: 1,
        currency: 'JPY',
        unitAmount: 200,
        status: 'ACTIVE',
        purchasedAt: '2026-06-01T00:00:00.000Z',
        expiresAt: '2026-11-30T10:00:00.000Z',
      };
      const laterLot: LoungeCreditLotDoc = {
        id: 'lot_later',
        uid,
        productId: 'CHARGE_TICKET_100',
        isPaid: true,
        initialTurns: 100,
        remainingTurns: 1,
        currency: 'JPY',
        unitAmount: 500,
        status: 'ACTIVE',
        purchasedAt: '2026-08-01T00:00:00.000Z',
        expiresAt: '2027-02-01T10:00:00.000Z',
      };

      await cols.loungeSubscriptions.doc(uid).set(baseSub);
      await cols.loungeCreditLots.doc(expiredLot.id).set(expiredLot);
      await cols.loungeCreditLots.doc(soonLot.id).set(soonLot);
      await cols.loungeCreditLots.doc(laterLot.id).set(laterLot);

      // First lazy sync expires CANCELING subscription & expiredLot while keeping soonLot + laterLot
      const synced = await engine.syncLazyState(uid, 'Asia/Tokyo', now);
      expect(synced?.subscription.tier).toBe('FREE');
      expect(synced?.subscription.status).toBe('CANCELED');
      expect(synced?.subscription.dailyTurnQuota).toBe(5);
      expect(synced?.subscription.dailyRemainingTurns).toBe(0);
      expect(synced?.subscription.purchasedRemainingTurns).toBe(2);
      expect(synced?.subscription.earliestLotExpiresAt).toBe(soonLot.expiresAt);

      // Breakdown includes 14-day warning + Phase 2 EEA flag
      const breakdown = buildQuotaBreakdownAndWarning(
        synced!.subscription,
        synced!.activeLots,
        true,
        now,
      );
      expect(breakdown.quotaBreakdown.phase2EuWithdrawalEligible).toBe(true);
      expect(breakdown.expiringSoonWarning?.expiringTurns).toBe(1);

      // Reserve consumes soonLot (LOT_FIFO) and exhausts it
      const r1 = await engine.reserveTurn(uid, 'Asia/Tokyo', 'msg_1', now);
      expect(r1.source).toBe('LOT');
      expect(r1.lotId).toBe('lot_soon');
      expect(r1.subscription.purchasedRemainingTurns).toBe(1);
      expect((await cols.loungeCreditLots.doc('lot_soon').get()).data()?.status).toBe('EXHAUSTED');

      // Compensate restores soonLot back to ACTIVE
      await engine.compensateTurn(r1, now);
      expect((await cols.loungeCreditLots.doc('lot_soon').get()).data()?.status).toBe('ACTIVE');

      // Consume both lots -> next call throws 429 QUOTA_EXHAUSTED
      await engine.reserveTurn(uid, 'Asia/Tokyo', 'msg_2', now);
      await engine.reserveTurn(uid, 'Asia/Tokyo', 'msg_3', now);
      await expect(engine.reserveTurn(uid, 'Asia/Tokyo', 'msg_4', now)).rejects.toMatchObject({
        statusCode: 429,
        code: 'QUOTA_EXHAUSTED',
      });

      // Next day triggers DAILY_RESET (`FREE -> 5/5`), consumes DAILY, and mid-day upgrade boosts to 99
      const nextDay = new Date('2026-11-25T16:00:00.000Z');
      const rDaily = await engine.reserveTurn(uid, 'Asia/Tokyo', 'msg_day2', nextDay);
      expect(rDaily.source).toBe('DAILY');
      expect(rDaily.subscription.dailyRemainingTurns).toBe(4);

      // Same-day compensate restores back to 5
      await engine.compensateTurn(rDaily, nextDay);
      const afterComp = (await cols.loungeSubscriptions.doc(uid).get()).data()!;
      expect(afterComp.dailyRemainingTurns).toBe(5);

      // Cross-day compensate is safely ignored
      await engine.compensateTurn(
        { ...rDaily, nextDailyResetAt: '2026-11-24T15:00:00.000Z' },
        nextDay,
      );

      // Upgrade transition recalculates daily quota minus todaysConsumedDailyTurns
      const upgraded = applySubscriptionTransition(
        { ...afterComp, todaysConsumedDailyTurns: 3, dailyRemainingTurns: 2 },
        [],
        'Asia/Tokyo',
        'STANDARD',
        'ACTIVE',
        nextDay,
      );
      expect(upgraded.subscription.dailyTurnQuota).toBe(100);
      expect(upgraded.subscription.dailyRemainingTurns).toBe(97);
      expect(upgraded.ledgerEntries.some((l) => l.deltaType === 'UPGRADE_TOPUP')).toBe(true);

      // Evaluate lazy state with corrupted reset timestamp still resets cleanly
      const lazyBroken = evaluateLazyQuotaState(
        { ...afterComp, nextDailyResetAt: 'bad-date' },
        [],
        'UTC',
        nextDay,
      );
      expect(lazyBroken.mutated).toBe(true);
    });
  });

  describe('StripeSdkGatewayAdapter & LocalTestStripeGatewayAdapter', () => {
    it('delegates customers, Checkout, Portal, v23 subscriptions, invoicePayments refunds, and webhooks', async () => {
      const mockStripe = {
        customers: {
          retrieve: jest
            .fn()
            .mockResolvedValueOnce({ id: 'cus_existing', deleted: false })
            .mockResolvedValueOnce({ id: 'cus_deleted', deleted: true })
            .mockRejectedValueOnce({ code: 'resource_missing' }),
          create: jest.fn().mockResolvedValue({ id: 'cus_created_1' }),
          del: jest.fn().mockResolvedValue({ id: 'cus_del', deleted: true }),
        },
        checkout: {
          sessions: {
            create: jest
              .fn()
              .mockResolvedValueOnce({ id: 'cs_1', url: 'https://checkout.stripe.com/pay/cs_1' })
              .mockResolvedValueOnce({ id: 'cs_sub', url: 'https://checkout.stripe.com/pay/cs_sub' })
              .mockResolvedValueOnce({ id: 'cs_nourl', url: null }),
            retrieve: jest.fn().mockResolvedValue({
              id: 'cs_1',
              url: 'https://checkout.stripe.com/pay/cs_1',
              customer: { id: 'cus_created_1' },
              mode: 'payment',
              payment_status: 'paid',
              payment_intent: { id: 'pi_1', created: 1795400000 },
              currency: 'jpy',
              amount_total: 500,
              metadata: { uid: 'uid_1', productId: 'CHARGE_TICKET_100', ignoredNum: 42 },
            }),
            list: jest.fn().mockReturnValue((async function* () {
              yield { id: 'cs_open_1' };
            })()),
            expire: jest.fn().mockResolvedValue({ id: 'cs_open_1' }),
          },
        },
        billingPortal: {
          sessions: {
            create: jest.fn().mockResolvedValue({ url: 'https://billing.stripe.com/p/session' }),
          },
        },
        subscriptions: {
          retrieve: jest.fn().mockResolvedValue({
            id: 'sub_1',
            customer: { id: 'cus_created_1' },
            status: 'paused',
            cancel_at_period_end: false,
            currency: 'usd',
            latest_invoice: { id: 'in_1' },
            schedule: { id: 'sub_sched_1' },
            items: { data: [{ current_period_end: 1798000000 }] },
          }),
          list: jest.fn().mockReturnValue((async function* () {
            yield { id: 'sub_active_1', status: 'active' };
            yield { id: 'sub_done', status: 'canceled' };
          })()),
          cancel: jest
            .fn()
            .mockRejectedValueOnce({ code: 'resource_missing' })
            .mockResolvedValueOnce({ id: 'sub_active_1', status: 'canceled' }),
        },
        subscriptionSchedules: {
          list: jest.fn().mockReturnValue((async function* () {
            yield { id: 'sched_1', status: 'active' };
          })()),
          release: jest.fn().mockResolvedValue({ id: 'sched_1' }),
        },
        invoices: {
          list: jest.fn().mockReturnValue((async function* () {
            yield { id: 'in_open_1' };
          })()),
          voidInvoice: jest.fn().mockResolvedValue({ id: 'in_open_1' }),
        },
        charges: {
          list: jest.fn().mockResolvedValue({
            data: [
              {
                id: 'ch_1',
                customer: 'cus_1',
                status: 'succeeded',
                amount: 500,
                amount_refunded: 0,
                refunded: false,
                disputed: false,
                currency: 'jpy',
                created: 1795400000,
                payment_intent: 'pi_1',
                receipt_url: 'https://pay.stripe.com/receipts/ch_1',
                metadata: { productId: 'CHARGE_TICKET_100' },
              },
            ],
            has_more: false,
          }),
          retrieve: jest.fn().mockResolvedValue({
            id: 'ch_1',
            customer: 'cus_1',
            status: 'failed',
            amount: 500,
            amount_refunded: 0,
            refunded: false,
            disputed: false,
            currency: 'usd',
            created: 1795400000,
            metadata: {},
          }),
        },
        invoicePayments: {
          list: jest
            .fn()
            .mockResolvedValueOnce({ data: [] })
            .mockResolvedValueOnce({
              data: [{ invoice: { id: 'in_del', deleted: true } }],
            })
            .mockResolvedValueOnce({
              data: [
                {
                  invoice: {
                    id: 'in_real',
                    period_end: 1798000000,
                    parent: { subscription_details: { subscription: { id: 'sub_1' } } },
                  },
                },
              ],
            }),
        },
        refunds: {
          create: jest.fn().mockResolvedValue({ id: 're_1' }),
        },
        webhooks: {
          constructEvent: jest
            .fn()
            .mockReturnValueOnce({
              id: 'evt_1',
              type: 'invoice.paid',
              data: { object: { id: 'in_1' } },
            })
            .mockImplementationOnce(() => {
              throw new Error('bad sig');
            }),
        },
      };

      const adapter = new StripeSdkGatewayAdapter('sk_test_dummy', mockStripe as unknown as Stripe);

      expect(
        (await adapter.ensureCustomer({ existingCustomerId: 'cus_existing', uid: 'u1', xHandle: '@u1', countryCode: 'JP' })).customerId,
      ).toBe('cus_existing');
      expect(
        (await adapter.ensureCustomer({ existingCustomerId: 'cus_deleted', uid: 'u1', xHandle: '@u1', countryCode: 'JP' })).customerId,
      ).toBe('cus_created_1');
      expect(
        (await adapter.ensureCustomer({ existingCustomerId: 'cus_missing', uid: 'u2', xHandle: '@u2', countryCode: 'US' })).customerId,
      ).toBe('cus_created_1');
      expect(mockStripe.customers.create).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ idempotencyKey: 'lounge_customer_u2' }),
      );

      await adapter.createCheckoutSession({
        customerId: 'cus_created_1',
        uid: 'u1',
        productId: 'CHARGE_TICKET_100',
        mode: 'payment',
        priceId: 'price_1',
        currency: 'JPY',
        successUrl: 'https://example.com/ok',
        cancelUrl: 'https://example.com/cancel',
        allowPromotionCodes: true,
        enableInvoiceCreation: true,
        submitMessage: 'Submit',
        metadata: { uid: 'u1' },
      });
      await adapter.createCheckoutSession({
        customerId: 'cus_created_1',
        uid: 'u1',
        productId: 'STANDARD_MONTHLY',
        mode: 'subscription',
        priceId: 'price_sub',
        currency: 'USD',
        successUrl: 'https://example.com/ok',
        cancelUrl: 'https://example.com/cancel',
        allowPromotionCodes: false,
        enableInvoiceCreation: false,
        submitMessage: 'Monthly',
        metadata: { uid: 'u1' },
      });
      await expect(
        adapter.createCheckoutSession({
          customerId: 'cus_created_1',
          uid: 'u1',
          productId: 'TRIAL_TICKET_100',
          mode: 'payment',
          priceId: 'price_t',
          currency: 'JPY',
          successUrl: 'https://example.com/ok',
          cancelUrl: 'https://example.com/cancel',
          allowPromotionCodes: false,
          enableInvoiceCreation: false,
          submitMessage: 'Trial',
          metadata: {},
        }),
      ).rejects.toThrow(/did not return a hosted URL/);

      const retrievedSession = await adapter.retrieveCheckoutSession('cs_1');
      expect(retrievedSession.customerId).toBe('cus_created_1');
      expect(retrievedSession.paymentIntentId).toBe('pi_1');

      await adapter.createPortalSession({
        customerId: 'cus_1',
        returnUrl: 'https://example.com/?portal_return=1',
        flow: 'payment_method_update',
        configurationId: 'bpc_1',
      });
      await adapter.createPortalSession({
        customerId: 'cus_1',
        returnUrl: 'https://example.com/?portal_return=1',
        flow: 'subscription_cancel',
        subscriptionId: 'sub_1',
      });
      await adapter.createPortalSession({
        customerId: 'cus_1',
        returnUrl: 'https://example.com/?portal_return=1',
        flow: 'default',
      });

      const subSnap = await adapter.retrieveSubscription('sub_1');
      expect(subSnap.status).toBe('past_due');
      expect(subSnap.scheduleId).toBe('sub_sched_1');
      expect((await adapter.listCharges({ customerId: 'cus_1', limit: 10 })).charges).toHaveLength(1);
      expect((await adapter.retrieveCharge('ch_1')).status).toBe('failed');

      expect(await adapter.resolveInvoiceByPaymentIntent('pi_none')).toBeNull();
      expect(await adapter.resolveInvoiceByPaymentIntent('pi_deleted')).toBeNull();
      expect(await adapter.resolveInvoiceByPaymentIntent('pi_real')).toMatchObject({
        id: 'in_real',
        subscriptionId: 'sub_1',
      });

      await adapter.createFullRefund({
        paymentIntentId: 'pi_1',
        idempotencyKey: 'key_1',
        reason: 'duplicate',
        amountMinor: 500,
      });
      await adapter.cancelSubscriptionImmediately('sub_missing');
      await adapter.cancelAndDeleteCustomer('cus_1');
      expect(mockStripe.customers.del).toHaveBeenCalledWith('cus_1');

      expect(
        adapter.constructWebhookEvent(Buffer.from('{}'), 'sig', 'whsec_1').type,
      ).toBe('invoice.paid');
      expect(() => adapter.constructWebhookEvent(Buffer.from('{}'), 'bad', 'whsec_1')).toThrow(
        /Invalid Stripe webhook signature/,
      );

      // LocalTestStripeGatewayAdapter coverage for synthetic signature/state paths
      const localStripe = new LocalTestStripeGatewayAdapter('http://localhost:4300');
      localStripe.seedTestSubscriptionState({
        id: 'sub_syn_1',
        customerId: 'cus_syn_1',
        status: 'active',
        cancelAtPeriodEnd: false,
        currentPeriodEndIso: '2026-12-24T00:00:00.000Z',
        latestInvoiceId: 'in_syn_1',
      });
      const signedFail = createSignedWebhookArgs({
        id: 'evt_syn_1',
        type: 'invoice.payment_failed',
        data: { object: { id: 'in_syn_1', subscription: 'sub_syn_1' } },
      });
      expect(
        localStripe.constructWebhookEvent(signedFail.rawBody, signedFail.signature, signedFail.secret).type,
      ).toBe('invoice.payment_failed');
      expect((await localStripe.retrieveSubscription('sub_syn_1')).status).toBe('past_due');

      const signedPaid = createSignedWebhookArgs({
        id: 'evt_syn_2',
        type: 'invoice.paid',
        data: { object: { id: 'in_syn_2', subscription: 'sub_syn_1', period_end: 1799000000 } },
      });
      localStripe.constructWebhookEvent(signedPaid.rawBody, signedPaid.signature, signedPaid.secret);
      expect((await localStripe.retrieveSubscription('sub_syn_1')).status).toBe('active');
      expect(() =>
        localStripe.constructWebhookEvent(signedPaid.rawBody, 't=123,v1=deadbeef', signedPaid.secret),
      ).toThrow(/Invalid Stripe webhook signature/);
    });
  });

  describe('HTTP Billing Routes, All 7 Stripe Webhooks, Safety Guardrails & Account Withdrawal', () => {
    function setupBillingAppHarness(envOverrides: NodeJS.ProcessEnv = {}) {
      const { firestore } = createInMemoryFirestore();
      const stripeGateway = new LocalTestStripeGatewayAdapter('http://localhost:4300');
      const config = loadLoungeRuntimeConfig(
        {
          NODE_ENV: 'test',
          GCP_PROJECT_ID: 'demo-rebecca-lounge',
          STRIPE_WEBHOOK_SECRET: 'whsec_test_secret',
          LOUNGE_TRIAL_HMAC_KEYS: '{"1":"old-hmac-secret","2":"active-hmac-secret"}',
          ...envOverrides,
        },
        '1.45.2',
        1,
      );

      const deps = createProductionLoungeDependencies(undefined, {
        config,
        firestore,
        stripeGateway,
        authVerifier: {
          async verifyBearerToken(idToken: string) {
            if (idToken === 'uid_b') {
              return {
                uid: 'uid_user_b',
                xUserId: 'x_999002',
                xHandle: '@user_b',
                displayName: 'User B',
                avatarUrl: 'assets/gemitec_icon.svg',
              };
            }
            return {
              uid: 'uid_user_a',
              xUserId: 'x_999001',
              xHandle: '@user_a',
              displayName: 'User A',
              avatarUrl: 'assets/gemitec_icon.svg',
            };
          },
        },
      });
      const cols = getCollections(firestore);
      const app = createLoungeApp(deps);

      return { app, firestore, cols, stripeGateway, config };
    }

    it('validates billing input helpers thoroughly', () => {
      expect(maskCheckoutSessionId('cs_123')).toBe('***');
      expect(maskCheckoutSessionId('cs_test_1234567890')).toBe('cs_tes...7890');
      expect(() => parseAndValidateCreateCheckoutRequest(null)).toThrow(/JSON object/);
      expect(() => parseAndValidateCreateCheckoutRequest({ productId: 'NOPE' })).toThrow(/productId/);
      expect(() =>
        parseAndValidateCreateCheckoutRequest({
          productId: 'CHARGE_TICKET_100',
          acceptedPurchaseDisclosure: false,
          acceptedAutoRenewalOptIn: true,
          confirmedAdultOrParentalConsent: true,
        }),
      ).toThrow(/statutory/);
      expect(() =>
        parseAndValidateCreateCheckoutRequest({
          productId: 'CHARGE_TICKET_100',
          acceptedPurchaseDisclosure: true,
          acceptedAutoRenewalOptIn: true,
          confirmedAdultOrParentalConsent: true,
          euDigitalWaiverAccepted: 'yes',
        }),
      ).toThrow(/boolean/);
      expect(() => parseAndValidateVerifyCheckoutRequest({ sessionId: 'bad' })).toThrow(/Checkout Session/);
      expect(() => parseAndValidatePortalRequest({ flow: 'bad' })).toThrow(/flow/);
      expect(() => parseAndValidateEuWithdrawalRequest({ targetType: 'BAD' })).toThrow(/SUBSCRIPTION/);
      expect(() => parseOrdersQueryParams({ limit: 0 })).toThrow(/positive integer/);
      expect(() => parseOrdersQueryParams({ startingAfter: 'bad' })).toThrow(/Charge ID/);
      expect(parseOrdersQueryParams({ limit: '50', startingAfter: 'ch_abc123' })).toEqual({
        limit: 30,
        startingAfter: 'ch_abc123',
      });
    });

    it('executes catalog, checkout, verify, trial race auto-refund across rotated HMAC keys, and orders/receipt', async () => {
      const { app, cols, stripeGateway, config } = setupBillingAppHarness();

      // Register User A via real route + LoungeAuthRepository
      const regRes = await request(app)
        .post('/api/v1/lounge/auth/signup')
        .set('x-client-country', 'JP')
        .send({
          idToken: 'uid_a',
          xOAuthCode: 'x_oauth_test_code_a',
          language: 'ja',
          timezone: 'Asia/Tokyo',
          disclaimerConsent: validConsent(1),
        });
      expect(regRes.status).toBe(201);
      expect(regRes.body.user.preferredCurrency).toBe('JPY');

      // Catalog shows JPY and Trial eligible
      const catRes = await request(app)
        .get('/api/v1/lounge/billing/catalog')
        .set('Authorization', 'Bearer uid_a')
        .set('x-client-country', 'US'); // locked to JPY once created/JP
      expect(catRes.status).toBe(200);
      expect(catRes.body.currency).toBe('JPY');
      expect(catRes.body.trialEligible).toBe(true);

      // Phase 1 EEA geo-block verification
      const regB = await request(app)
        .post('/api/v1/lounge/auth/signup')
        .set('x-client-country', 'DE')
        .send({
          idToken: 'uid_b',
          xOAuthCode: 'x_oauth_test_code_b',
          language: 'de',
          timezone: 'Europe/Berlin',
          disclaimerConsent: validConsent(1),
        });
      expect(regB.status).toBe(201);

      const eeaCat = await request(app)
        .get('/api/v1/lounge/billing/catalog')
        .set('Authorization', 'Bearer uid_b');
      expect(eeaCat.body.products.every((p: { ineligibleReason?: string }) => p.ineligibleReason === 'GEO_BLOCKED')).toBe(
        true,
      );
      const eeaBlockedCheckout = await request(app)
        .post('/api/v1/lounge/billing/checkout')
        .set('Authorization', 'Bearer uid_b')
        .send({
          productId: 'TRIAL_TICKET_100',
          acceptedPurchaseDisclosure: true,
          acceptedAutoRenewalOptIn: true,
          confirmedAdultOrParentalConsent: true,
        });
      expect(eeaBlockedCheckout.status).toBe(403);
      expect(eeaBlockedCheckout.body.code).toBe('GEO_BLOCKED');

      // User A buys Trial Ticket & verifies synchronously
      const trialCheckoutRes = await request(app)
        .post('/api/v1/lounge/billing/checkout')
        .set('Authorization', 'Bearer uid_a')
        .send({
          productId: 'TRIAL_TICKET_100',
          acceptedPurchaseDisclosure: true,
          acceptedAutoRenewalOptIn: true,
          confirmedAdultOrParentalConsent: true,
        });
      expect(trialCheckoutRes.status).toBe(200);
      const trialSessionId = new URL(trialCheckoutRes.body.checkoutUrl).searchParams.get('session_id')!;

      const verifyRes = await request(app)
        .post('/api/v1/lounge/billing/checkout/verify')
        .set('Authorization', 'Bearer uid_a')
        .send({ sessionId: trialSessionId });
      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.verified).toBe(true);
      expect(verifyRes.body.subscription.purchasedRemainingTurns).toBe(120); // +20 welcome + 100 trial
      expect(verifyRes.body.subscription.trialTicketUsed).toBe(true);

      // Cross-user verification rejected (403)
      const crossVerifyRes = await request(app)
        .post('/api/v1/lounge/billing/checkout/verify')
        .set('Authorization', 'Bearer uid_b')
        .send({ sessionId: trialSessionId });
      expect(crossVerifyRes.status).toBe(403);

      // Re-buying trial rejected (409 TRIAL_ALREADY_USED)
      const dupTrialRes = await request(app)
        .post('/api/v1/lounge/billing/checkout')
        .set('Authorization', 'Bearer uid_a')
        .send({
          productId: 'TRIAL_TICKET_100',
          acceptedPurchaseDisclosure: true,
          acceptedAutoRenewalOptIn: true,
          confirmedAdultOrParentalConsent: true,
        });
      expect(dupTrialRes.status).toBe(409);
      expect(dupTrialRes.body.code).toBe('TRIAL_ALREADY_USED');

      // Trial race webhook across rotated key version (v1 hash already claimed on User A while sub temporarily reset)
      const oldV1Hash = computeTrialHmacDigest('x_999001', config.trialHmacKeyring.keys.get(1)!);
      const legacyGrant: LoungeTrialGrantDoc = {
        xUserIdHash: oldV1Hash,
        keyVersion: 1,
        riskStatus: 'OK',
        trialTicketGrantedAt: '2026-10-01T00:00:00.000Z',
        retainUntil: '2029-10-01T00:00:00.000Z',
      };
      await cols.loungeTrialGrants.doc(oldV1Hash).set(legacyGrant);

      const raceSession = await stripeGateway.createCheckoutSession({
        customerId: (await cols.loungeSubscriptions.doc('uid_user_a').get()).data()!.stripeCustomerId!,
        uid: 'uid_user_a',
        productId: 'TRIAL_TICKET_100',
        mode: 'payment',
        priceId: config.stripePriceIds.JPY.TRIAL_TICKET_100,
        currency: 'JPY',
        successUrl: 'http://localhost:4300/?checkout=success&session_id={CHECKOUT_SESSION_ID}',
        cancelUrl: 'http://localhost:4300/?checkout=cancel',
        allowPromotionCodes: false,
        enableInvoiceCreation: false,
        submitMessage: 'Trial',
        metadata: { uid: 'uid_user_a', productId: 'TRIAL_TICKET_100' },
      });
      // Reset local trialTicketUsed to simulate concurrent checkout race right before webhook
      const subBeforeRace = (await cols.loungeSubscriptions.doc('uid_user_a').get()).data()!;
      await cols.loungeSubscriptions.doc('uid_user_a').set({ ...subBeforeRace, trialTicketUsed: false });
      const refundSpy = jest.spyOn(stripeGateway, 'createFullRefund');

      const signedRace = createSignedWebhookArgs({
        id: 'evt_trial_race_1',
        type: 'checkout.session.completed',
        data: { object: { id: raceSession.id } },
      });
      const raceWebhookRes = await request(app)
        .post('/api/v1/lounge/webhooks/stripe')
        .set('stripe-signature', signedRace.signature)
        .set('Content-Type', 'application/json')
        .send(signedRace.rawText);
      expect(raceWebhookRes.status).toBe(200);
      expect(refundSpy).toHaveBeenCalledTimes(1);

      // Replaying same webhook idempotently returns ignored: true
      const replayRes = await request(app)
        .post('/api/v1/lounge/webhooks/stripe')
        .set('stripe-signature', signedRace.signature)
        .set('Content-Type', 'application/json')
        .send(signedRace.rawText);
      expect(replayRes.status).toBe(200);
      expect(replayRes.body.ignored).toBe(true);

      // Orders history & receipt retrieval
      const ordersRes = await request(app)
        .get('/api/v1/lounge/billing/orders?limit=1')
        .set('Authorization', 'Bearer uid_a');
      expect(ordersRes.status).toBe(200);
      expect(ordersRes.body.orders).toHaveLength(1);
      expect(ordersRes.body.hasMore).toBe(true);
      expect(ordersRes.body.orders[0].receiptAvailable).toBe(true);

      const receiptRes = await request(app)
        .get(`/api/v1/lounge/billing/orders/${ordersRes.body.orders[0].chargeId}/receipt`)
        .set('Authorization', 'Bearer uid_a');
      expect(receiptRes.status).toBe(200);
      expect(receiptRes.body.receiptUrl).toMatch(/^https:\/\/pay\.stripe\.com\/receipts\//);

      // User B lacks stripeCustomerId -> receipt 404
      const noCustomerReceipt = await request(app)
        .get(`/api/v1/lounge/billing/orders/${ordersRes.body.orders[0].chargeId}/receipt`)
        .set('Authorization', 'Bearer uid_b');
      expect(noCustomerReceipt.status).toBe(404);
    });

    it('processes subscription webhooks, cross-month refund guard, disputes, and fail-closed withdrawal', async () => {
      const { app, cols, stripeGateway, config } = setupBillingAppHarness();

      await request(app)
        .post('/api/v1/lounge/auth/signup')
        .set('x-client-country', 'JP')
        .send({
          idToken: 'uid_a',
          xOAuthCode: 'x_oauth_test_code_a',
          language: 'ja',
          timezone: 'Asia/Tokyo',
          disclaimerConsent: validConsent(1),
        });

      // Missing signature returns 400; invalid signature returns 401
      const missingSig = await request(app)
        .post('/api/v1/lounge/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .send('{}');
      expect(missingSig.status).toBe(400);

      const badSig = await request(app)
        .post('/api/v1/lounge/webhooks/stripe')
        .set('stripe-signature', 't=123,v1=bad000')
        .set('Content-Type', 'application/json')
        .send('{"id":"evt_x"}');
      expect(badSig.status).toBe(401);

      // Subscribe STANDARD_MONTHLY
      const subCheckoutRes = await request(app)
        .post('/api/v1/lounge/billing/checkout')
        .set('Authorization', 'Bearer uid_a')
        .send({
          productId: 'STANDARD_MONTHLY',
          acceptedPurchaseDisclosure: true,
          acceptedAutoRenewalOptIn: true,
          confirmedAdultOrParentalConsent: true,
        });
      expect(subCheckoutRes.status).toBe(200);
      const subSessionId = new URL(subCheckoutRes.body.checkoutUrl).searchParams.get('session_id')!;

      const verifySub = await request(app)
        .post('/api/v1/lounge/billing/checkout/verify')
        .set('Authorization', 'Bearer uid_a')
        .send({ sessionId: subSessionId });
      expect(verifySub.status).toBe(200);
      expect(verifySub.body.subscription.tier).toBe('STANDARD');
      expect(verifySub.body.subscription.dailyTurnQuota).toBe(100);

      // Duplicate subscription checkout rejected
      const dupSubCheckout = await request(app)
        .post('/api/v1/lounge/billing/checkout')
        .set('Authorization', 'Bearer uid_a')
        .send({
          productId: 'STANDARD_MONTHLY',
          acceptedPurchaseDisclosure: true,
          acceptedAutoRenewalOptIn: true,
          confirmedAdultOrParentalConsent: true,
        });
      expect(dupSubCheckout.status).toBe(409);

      // Portal session for subscription_cancel succeeds
      const portalRes = await request(app)
        .post('/api/v1/lounge/billing/portal')
        .set('Authorization', 'Bearer uid_a')
        .send({ flow: 'subscription_cancel' });
      expect(portalRes.status).toBe(200);
      expect(portalRes.body.portalUrl).toContain('portal_flow=subscription_cancel');

      // Retrieve subscription snapshot & issue invoice.paid for month 2 renewal
      const storedSub = (await cols.loungeSubscriptions.doc('uid_user_a').get()).data()!;
      const stripeSubId = storedSub.stripeSubscriptionId!;
      const month2PeriodEnd = Math.floor((Date.now() + 60 * 86400_000) / 1000);
      const paidEvent = createSignedWebhookArgs({
        id: 'evt_inv_paid_m2',
        type: 'invoice.paid',
        data: {
          object: {
            id: 'in_month_2',
            subscription: stripeSubId,
            period_end: month2PeriodEnd,
          },
        },
      });
      const invPaidRes = await request(app)
        .post('/api/v1/lounge/webhooks/stripe')
        .set('stripe-signature', paidEvent.signature)
        .set('Content-Type', 'application/json')
        .send(paidEvent.rawText);
      expect(invPaidRes.status).toBe(200);
      expect((await cols.loungeSubscriptions.doc('uid_user_a').get()).data()!.lastProcessedInvoiceId).toBe(
        'in_month_2',
      );

      // Month-boundary protection: refunding OLD invoice in_month_1 does NOT revoke active month 2 subscription!
      jest.spyOn(stripeGateway, 'resolveInvoiceByPaymentIntent').mockResolvedValueOnce({
        id: 'in_month_1_old',
        subscriptionId: stripeSubId,
      });
      const oldRefundEvt = createSignedWebhookArgs({
        id: 'evt_refund_old_m1',
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_old',
            customer: storedSub.stripeCustomerId,
            payment_intent: 'pi_old_sub',
            amount_captured: 1400,
            amount_refunded: 1400,
          },
        },
      });
      await request(app)
        .post('/api/v1/lounge/webhooks/stripe')
        .set('stripe-signature', oldRefundEvt.signature)
        .set('Content-Type', 'application/json')
        .send(oldRefundEvt.rawText);
      expect((await cols.loungeSubscriptions.doc('uid_user_a').get()).data()!.status).toBe('ACTIVE');

      // customer.subscription.updated with cancel_at_period_end transitions to CANCELING
      const subCancelEndEvt = createSignedWebhookArgs({
        id: 'evt_sub_canceling',
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: stripeSubId,
            customer: storedSub.stripeCustomerId,
            status: 'active',
            cancel_at_period_end: true,
          },
        },
      });
      await request(app)
        .post('/api/v1/lounge/webhooks/stripe')
        .set('stripe-signature', subCancelEndEvt.signature)
        .set('Content-Type', 'application/json')
        .send(subCancelEndEvt.rawText);
      expect((await cols.loungeSubscriptions.doc('uid_user_a').get()).data()!.status).toBe('CANCELING');

      // invoice.payment_failed transitions subscription to PAST_DUE
      const invFailEvt = createSignedWebhookArgs({
        id: 'evt_inv_fail',
        type: 'invoice.payment_failed',
        data: { object: { id: 'in_fail_1', subscription: stripeSubId } },
      });
      await request(app)
        .post('/api/v1/lounge/webhooks/stripe')
        .set('stripe-signature', invFailEvt.signature)
        .set('Content-Type', 'application/json')
        .send(invFailEvt.rawText);
      expect((await cols.loungeSubscriptions.doc('uid_user_a').get()).data()!.status).toBe('PAST_DUE');

      // customer.subscription.deleted downgrades immediately to FREE / CANCELED
      const subDeletedEvt = createSignedWebhookArgs({
        id: 'evt_sub_del',
        type: 'customer.subscription.deleted',
        data: {
          object: {
            id: stripeSubId,
            customer: storedSub.stripeCustomerId,
            status: 'canceled',
          },
        },
      });
      await request(app)
        .post('/api/v1/lounge/webhooks/stripe')
        .set('stripe-signature', subDeletedEvt.signature)
        .set('Content-Type', 'application/json')
        .send(subDeletedEvt.rawText);
      expect((await cols.loungeSubscriptions.doc('uid_user_a').get()).data()!.status).toBe('CANCELED');

      // Portal return single-shot GET /billing/subscription syncs updated Stripe status
      await stripeGateway.cancelSubscriptionImmediately(stripeSubId);
      const portalSyncRes = await request(app)
        .get('/api/v1/lounge/billing/subscription?portalReturn=1')
        .set('Authorization', 'Bearer uid_a');
      expect(portalSyncRes.status).toBe(200);
      expect(portalSyncRes.body.subscription.status).toBe('CANCELED');

      // Buy Charge Ticket, partial refund skipped, then dispute locks account & DISPUTE_BLOCKED
      const chargeCheckout = await request(app)
        .post('/api/v1/lounge/billing/checkout')
        .set('Authorization', 'Bearer uid_a')
        .send({
          productId: 'CHARGE_TICKET_100',
          acceptedPurchaseDisclosure: true,
          acceptedAutoRenewalOptIn: true,
          confirmedAdultOrParentalConsent: true,
        });
      const chargeSessionId = new URL(chargeCheckout.body.checkoutUrl).searchParams.get('session_id')!;
      await request(app)
        .post('/api/v1/lounge/billing/checkout/verify')
        .set('Authorization', 'Bearer uid_a')
        .send({ sessionId: chargeSessionId });
      const chargeSession = await stripeGateway.retrieveCheckoutSession(chargeSessionId);

      // Partial refund skipped, then full refund revokes lot cleanly
      const partialLotRefund = createSignedWebhookArgs({
        id: 'evt_partial_lot',
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_p',
            payment_intent: chargeSession.paymentIntentId,
            amount_captured: 500,
            amount_refunded: 100,
          },
        },
      });
      await request(app)
        .post('/api/v1/lounge/webhooks/stripe')
        .set('stripe-signature', partialLotRefund.signature)
        .set('Content-Type', 'application/json')
        .send(partialLotRefund.rawText);
      expect((await cols.loungeCreditLots.doc(chargeSessionId).get()).data()!.status).toBe('ACTIVE');

      const fullLotRefund = createSignedWebhookArgs({
        id: 'evt_full_lot',
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_f',
            payment_intent: chargeSession.paymentIntentId,
            amount_captured: 500,
            amount_refunded: 500,
          },
        },
      });
      await request(app)
        .post('/api/v1/lounge/webhooks/stripe')
        .set('stripe-signature', fullLotRefund.signature)
        .set('Content-Type', 'application/json')
        .send(fullLotRefund.rawText);
      expect((await cols.loungeCreditLots.doc(chargeSessionId).get()).data()!.status).toBe('REVOKED');

      // Fail-closed withdrawal preserves DB when Stripe deletion fails, then succeeds on retry
      stripeGateway.forceFailures.cancelAndDeleteCustomer = true;
      const failWithdraw = await request(app)
        .delete('/api/v1/lounge/account')
        .set('Authorization', 'Bearer uid_a')
        .send({
          confirmedIrreversibleDeletion: true,
          confirmedNoRefundForRemainingTurns: true,
        });
      expect(failWithdraw.status).toBe(502);
      expect(failWithdraw.body.code).toBe('STRIPE_CANCELLATION_FAILED');
      // Retrying succeeded once Stripe recovers (note DELETING user can retry DELETE safely)
      stripeGateway.forceFailures.cancelAndDeleteCustomer = false;
      const retryWithdraw = await request(app)
        .delete('/api/v1/lounge/account')
        .set('Authorization', 'Bearer uid_a')
        .send({
          confirmedIrreversibleDeletion: true,
          confirmedNoRefundForRemainingTurns: true,
        });
      expect(retryWithdraw.status).toBe(204);
      expect((await cols.loungeUsers.doc('uid_user_a').get()).exists).toBe(false);
      // Re-registering same X account does NOT grant duplicate +20 welcome bonus!
      await request(app)
        .post('/api/v1/lounge/auth/signup')
        .set('x-client-country', 'JP')
        .send({
          idToken: 'uid_a',
          xOAuthCode: 'x_oauth_test_code_a',
          language: 'ja',
          timezone: 'Asia/Tokyo',
          disclaimerConsent: validConsent(1),
        });
      const subAfterRejoin = (await cols.loungeSubscriptions.doc('uid_user_a').get()).data()!;
      expect(subAfterRejoin.purchasedRemainingTurns).toBe(0);

      // Now verify charge.dispute.created suspends User B with DISPUTE_BLOCKED
      const { app: p2App, cols: p2Cols, stripeGateway: p2Stripe } = setupBillingAppHarness({
        LOUNGE_PHASE2_EEA_ENABLED: 'true',
      });
      await request(p2App)
        .post('/api/v1/lounge/auth/signup')
        .set('x-client-country', 'FR')
        .send({
          idToken: 'uid_b',
          xOAuthCode: 'x_oauth_test_code_b',
          language: 'en',
          timezone: 'Europe/Paris',
          disclaimerConsent: validConsent(1),
        });
      const frCheckout = await request(p2App)
        .post('/api/v1/lounge/billing/checkout')
        .set('Authorization', 'Bearer uid_b')
        .send({
          productId: 'CHARGE_TICKET_100',
          acceptedPurchaseDisclosure: true,
          acceptedAutoRenewalOptIn: true,
          confirmedAdultOrParentalConsent: true,
          euDigitalWaiverAccepted: false,
        });
      const frSid = new URL(frCheckout.body.checkoutUrl).searchParams.get('session_id')!;
      await request(p2App)
        .post('/api/v1/lounge/billing/checkout/verify')
        .set('Authorization', 'Bearer uid_b')
        .send({ sessionId: frSid });

      // Phase 2 EEA withdrawal on CREDIT_LOT refunds 100% and revokes lot
      const euWithdrawRes = await request(p2App)
        .post('/api/v1/lounge/billing/eu-withdrawal')
        .set('Authorization', 'Bearer uid_b')
        .send({
          targetType: 'CREDIT_LOT',
          targetId: frSid,
          confirmedWithdrawal: true,
        });
      expect(euWithdrawRes.status).toBe(200);
      expect(euWithdrawRes.body.revokedTurns).toBe(100);
      expect((await p2Cols.loungeCreditLots.doc(frSid).get()).data()!.status).toBe('REVOKED');

      // Phase 2 EEA withdrawal on STANDARD_MONTHLY subscription cancels immediately & downgrades
      const frSubCheckout = await request(p2App)
        .post('/api/v1/lounge/billing/checkout')
        .set('Authorization', 'Bearer uid_b')
        .send({
          productId: 'STANDARD_MONTHLY',
          acceptedPurchaseDisclosure: true,
          acceptedAutoRenewalOptIn: true,
          confirmedAdultOrParentalConsent: true,
        });
      const frSubSid = new URL(frSubCheckout.body.checkoutUrl).searchParams.get('session_id')!;
      await request(p2App)
        .post('/api/v1/lounge/billing/checkout/verify')
        .set('Authorization', 'Bearer uid_b')
        .send({ sessionId: frSubSid });
      const frSubId = (await p2Cols.loungeSubscriptions.doc('uid_user_b').get()).data()!
        .stripeSubscriptionId!;
      const euSubWithdrawRes = await request(p2App)
        .post('/api/v1/lounge/billing/eu-withdrawal')
        .set('Authorization', 'Bearer uid_b')
        .send({
          targetType: 'SUBSCRIPTION',
          targetId: frSubId,
          confirmedWithdrawal: true,
        });
      expect(euSubWithdrawRes.status).toBe(200);
      expect(euSubWithdrawRes.body.subscription.tier).toBe('FREE');
      expect(euSubWithdrawRes.body.subscription.status).toBe('CANCELED');

      // Portal conflict (CANCELED sub) & validation error checks across billing endpoints
      expect(
        (
          await request(p2App)
            .post('/api/v1/lounge/billing/portal')
            .set('Authorization', 'Bearer uid_b')
            .send({ flow: 'subscription_cancel' })
        ).status,
      ).toBe(409);
      expect(
        (
          await request(p2App)
            .get('/api/v1/lounge/billing/orders?limit=0')
            .set('Authorization', 'Bearer uid_b')
        ).status,
      ).toBe(400);
      expect(
        (
          await request(p2App)
            .get('/api/v1/lounge/billing/orders/invalid_charge/receipt')
            .set('Authorization', 'Bearer uid_b')
        ).status,
      ).toBe(400);

      // Buy another lot and dispute it
      const frCheckout2 = await request(p2App)
        .post('/api/v1/lounge/billing/checkout')
        .set('Authorization', 'Bearer uid_b')
        .send({
          productId: 'CHARGE_TICKET_100',
          acceptedPurchaseDisclosure: true,
          acceptedAutoRenewalOptIn: true,
          confirmedAdultOrParentalConsent: true,
        });
      const frSid2 = new URL(frCheckout2.body.checkoutUrl).searchParams.get('session_id')!;
      await request(p2App)
        .post('/api/v1/lounge/billing/checkout/verify')
        .set('Authorization', 'Bearer uid_b')
        .send({ sessionId: frSid2 });
      const frSession2 = await p2Stripe.retrieveCheckoutSession(frSid2);

      const disputeEvt = createSignedWebhookArgs({
        id: 'evt_dispute_b',
        type: 'charge.dispute.created',
        data: { object: { id: 'dp_1', payment_intent: frSession2.paymentIntentId } },
      });
      await request(p2App)
        .post('/api/v1/lounge/webhooks/stripe')
        .set('stripe-signature', disputeEvt.signature)
        .set('Content-Type', 'application/json')
        .send(disputeEvt.rawText);

      expect((await p2Cols.loungeUsers.doc('uid_user_b').get()).data()!.status).toBe('SUSPENDED');
      // Unknown webhook event ignored cleanly
      const unknownEvt = createSignedWebhookArgs({
        id: 'evt_unknown',
        type: 'customer.created',
        data: { object: { id: 'cus_x' } },
      });
      const unknownRes = await request(p2App)
        .post('/api/v1/lounge/webhooks/stripe')
        .set('stripe-signature', unknownEvt.signature)
        .set('Content-Type', 'application/json')
        .send(unknownEvt.rawText);
      expect(unknownRes.status).toBe(200);
      expect(unknownRes.body.ignored).toBe(true);
      void chargeSession;
      void config;
    });

    it('covers validation bounds, portal/orders/receipt errors, current-cycle subscription refund clawback, and LocalTestStripeGateway branches', async () => {
      // Input validation boundary checks
      expect(() => parseAndValidateVerifyCheckoutRequest(null)).toThrow(/JSON object/);
      expect(() => parseAndValidatePortalRequest(null)).toThrow(/JSON object/);
      expect(() => parseAndValidateEuWithdrawalRequest(null)).toThrow(/JSON object/);
      expect(() => parseAndValidateEuWithdrawalRequest({ targetType: 'SUBSCRIPTION', targetId: '  ' })).toThrow(
        /non-empty/,
      );
      expect(() =>
        parseAndValidateEuWithdrawalRequest({
          targetType: 'SUBSCRIPTION',
          targetId: 'sub_1',
          confirmedWithdrawal: false,
        }),
      ).toThrow(/confirmedWithdrawal/);
      expect(() => parseOrdersQueryParams({ limit: ['1'] })).toThrow(/positive integer/);
      expect(() => parseOrdersQueryParams({ limit: 1.5 })).toThrow(/positive integer/);
      expect(() => parseOrdersQueryParams({ startingAfter: '  ' })).toThrow(/Charge ID/);
      expect(parseOrdersQueryParams({})).toEqual({ limit: 20 });

      // LocalTestStripeGatewayAdapter error & cursor paths
      const gw = new LocalTestStripeGatewayAdapter('http://localhost:4300');
      const { customerId } = await gw.ensureCustomer({ uid: 'u_gw', xHandle: '@gw', countryCode: 'JP' });
      await gw.cancelAndDeleteCustomer(customerId);
      const { customerId: recreatedId } = await gw.ensureCustomer({
        existingCustomerId: customerId,
        uid: 'u_gw',
        xHandle: '@gw',
        countryCode: 'JP',
      });
      expect(recreatedId).not.toBe(customerId);
      await expect(gw.retrieveCheckoutSession('cs_missing')).rejects.toThrow(/not found/);
      await expect(gw.retrieveSubscription('sub_missing')).rejects.toThrow(/not found/);
      await expect(gw.retrieveCharge('ch_missing')).rejects.toThrow(/not found/);
      gw.forceFailures.refund = true;
      await expect(
        gw.createFullRefund({ paymentIntentId: 'pi_x', idempotencyKey: 'k_x' }),
      ).rejects.toThrow(/Forced synthetic refund failure/);
      gw.forceFailures.refund = false;
      expect(
        await gw.createPortalSession({
          customerId: recreatedId,
          returnUrl: 'http://localhost:4300/?a=1',
          flow: 'default',
        }),
      ).toEqual({ url: 'http://localhost:4300/?a=1&portal_flow=default' });

      // Full billing edge cases: missing profile (401), suspended user (403), portal 404, portalReturn catch, current-cycle refund clawback
      const { app, cols, stripeGateway } = setupBillingAppHarness({
        LOUNGE_PHASE2_EEA_ENABLED: 'true',
      });

      // Missing profile hits 401 across billing endpoints
      expect((await request(app).get('/api/v1/lounge/billing/catalog').set('Authorization', 'Bearer uid_a')).status).toBe(401);
      expect(
        (await request(app).post('/api/v1/lounge/billing/portal').set('Authorization', 'Bearer uid_a').send({ flow: 'default' })).status,
      ).toBe(401);
      expect(
        (await request(app).get('/api/v1/lounge/billing/subscription').set('Authorization', 'Bearer uid_a')).status,
      ).toBe(401);

      // Register User A & test orders/receipt/portal pre-customer states
      await request(app)
        .post('/api/v1/lounge/auth/signup')
        .set('x-client-country', 'JP')
        .send({
          idToken: 'uid_a',
          xOAuthCode: 'x_oauth_a',
          language: 'ja',
          timezone: 'Asia/Tokyo',
          disclaimerConsent: validConsent(1),
        });
      expect(
        (await request(app).post('/api/v1/lounge/billing/portal').set('Authorization', 'Bearer uid_a').send({ flow: 'default' })).status,
      ).toBe(404);
      expect((await request(app).get('/api/v1/lounge/billing/orders').set('Authorization', 'Bearer uid_a')).body).toEqual({
        orders: [],
        nextCursor: null,
        hasMore: false,
      });
      // Non-EEA EU withdrawal rejected 403
      expect(
        (
          await request(app)
            .post('/api/v1/lounge/billing/eu-withdrawal')
            .set('Authorization', 'Bearer uid_a')
            .send({ targetType: 'SUBSCRIPTION', targetId: 'sub_1', confirmedWithdrawal: true })
        ).status,
      ).toBe(403);

      // Subscribe, verify portalReturn graceful fallback when retrieveSubscription throws, then refund current invoice
      const subCk = await request(app)
        .post('/api/v1/lounge/billing/checkout')
        .set('Authorization', 'Bearer uid_a')
        .send({
          productId: 'STANDARD_MONTHLY',
          acceptedPurchaseDisclosure: true,
          acceptedAutoRenewalOptIn: true,
          confirmedAdultOrParentalConsent: true,
        });
      const subSid = new URL(subCk.body.checkoutUrl).searchParams.get('session_id')!;
      await request(app)
        .post('/api/v1/lounge/billing/checkout/verify')
        .set('Authorization', 'Bearer uid_a')
        .send({ sessionId: subSid });

      jest.spyOn(stripeGateway, 'retrieveSubscription').mockRejectedValueOnce(new Error('transient stripe outage'));
      const portalFallbackRes = await request(app)
        .get('/api/v1/lounge/billing/subscription?portalReturn=1')
        .set('Authorization', 'Bearer uid_a');
      expect(portalFallbackRes.status).toBe(200);
      expect(portalFallbackRes.body.subscription.status).toBe('ACTIVE');

      const curSub = (await cols.loungeSubscriptions.doc('uid_user_a').get()).data()!;
      // Current invoice refund triggers cancelSubscriptionImmediately + downgradeSubscriptionOnRefundTx
      jest.spyOn(stripeGateway, 'resolveInvoiceByPaymentIntent').mockResolvedValueOnce({
        id: curSub.lastProcessedInvoiceId!,
        subscriptionId: curSub.stripeSubscriptionId!,
      });
      const curRefundEvt = createSignedWebhookArgs({
        id: 'evt_cur_sub_refund',
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_cur_ref',
            customer: curSub.stripeCustomerId,
            payment_intent: 'pi_cur_ref',
            amount_captured: 1400,
            amount_refunded: 1400,
          },
        },
      });
      await request(app)
        .post('/api/v1/lounge/webhooks/stripe')
        .set('stripe-signature', curRefundEvt.signature)
        .set('Content-Type', 'application/json')
        .send(curRefundEvt.rawText);
      expect((await cols.loungeSubscriptions.doc('uid_user_a').get()).data()!.status).toBe('CANCELED');

      // Diverse charge status projection on GET /billing/orders & unsafe receipt URL rejection
      jest.spyOn(stripeGateway, 'listCharges').mockResolvedValueOnce({
        charges: [
          {
            id: 'ch_s1',
            customerId: curSub.stripeCustomerId,
            status: 'succeeded',
            amount: 500,
            amountRefunded: 200,
            refunded: false,
            disputed: false,
            currency: 'JPY',
            createdIso: '2026-11-24T00:00:00.000Z',
            receiptUrl: 'https://evil.example.com/phish',
            metadata: { productId: 'CHARGE_TICKET_100' },
          },
          {
            id: 'ch_s2',
            customerId: curSub.stripeCustomerId,
            status: 'failed',
            amount: 500,
            amountRefunded: 0,
            refunded: false,
            disputed: false,
            currency: 'JPY',
            createdIso: '2026-11-24T00:00:00.000Z',
            metadata: {},
          },
          {
            id: 'ch_s3',
            customerId: curSub.stripeCustomerId,
            status: 'pending',
            amount: 500,
            amountRefunded: 0,
            refunded: false,
            disputed: false,
            currency: 'JPY',
            createdIso: '2026-11-24T00:00:00.000Z',
            metadata: {},
          },
        ],
        hasMore: false,
      });
      const mixedOrdersRes = await request(app)
        .get('/api/v1/lounge/billing/orders')
        .set('Authorization', 'Bearer uid_a');
      expect(mixedOrdersRes.body.orders.map((o: { status: string }) => o.status)).toEqual([
        'PARTIAL_REFUNDED',
        'FAILED',
        'PENDING',
      ]);
      expect(mixedOrdersRes.body.orders[0].receiptAvailable).toBe(false);

      jest.spyOn(stripeGateway, 'retrieveCharge').mockResolvedValueOnce({
        id: 'ch_s1',
        customerId: curSub.stripeCustomerId,
        status: 'succeeded',
        amount: 500,
        amountRefunded: 0,
        refunded: false,
        disputed: false,
        currency: 'JPY',
        createdIso: '2026-11-24T00:00:00.000Z',
        receiptUrl: 'https://evil.example.com/phish',
        metadata: {},
      });
      expect(
        (await request(app).get('/api/v1/lounge/billing/orders/ch_s1/receipt').set('Authorization', 'Bearer uid_a')).status,
      ).toBe(404);

      // Unlinked webhook customer/payment_intent edge cases + unpaid session verify + EU missing lot 404
      jest.spyOn(stripeGateway, 'retrieveCheckoutSession').mockResolvedValueOnce({
        id: 'cs_unpaid_1',
        url: 'https://checkout.stripe.com/cs_unpaid_1',
        customerId: curSub.stripeCustomerId!,
        mode: 'payment',
        paymentStatus: 'unpaid',
        paymentIntentCreatedIso: '2026-11-24T00:00:00.000Z',
        metadata: { uid: 'uid_user_a', productId: 'CHARGE_TICKET_100' },
      });
      const unpaidVerifyRes = await request(app)
        .post('/api/v1/lounge/billing/checkout/verify')
        .set('Authorization', 'Bearer uid_a')
        .send({ sessionId: 'cs_unpaid_1' });
      expect(unpaidVerifyRes.status).toBe(200);
      expect(unpaidVerifyRes.body.verified).toBe(false);

      const unlinkedSubEvt = createSignedWebhookArgs({
        id: 'evt_unlinked_sub_upd',
        type: 'customer.subscription.updated',
        data: { object: { id: 'sub_never_seen', customer: 'cus_never_seen', status: 'active' } },
      });
      await request(app)
        .post('/api/v1/lounge/webhooks/stripe')
        .set('stripe-signature', unlinkedSubEvt.signature)
        .set('Content-Type', 'application/json')
        .send(unlinkedSubEvt.rawText);

      const unlinkedDisputeEvt = createSignedWebhookArgs({
        id: 'evt_unlinked_dispute',
        type: 'charge.dispute.created',
        data: { object: { id: 'dp_unlinked', payment_intent: 'pi_unlinked' } },
      });
      await request(app)
        .post('/api/v1/lounge/webhooks/stripe')
        .set('stripe-signature', unlinkedDisputeEvt.signature)
        .set('Content-Type', 'application/json')
        .send(unlinkedDisputeEvt.rawText);

      const badInvEvt = createSignedWebhookArgs({
        id: 'evt_bad_inv',
        type: 'invoice.paid',
        data: { object: { id: '' } },
      });
      expect(
        (
          await request(app)
            .post('/api/v1/lounge/webhooks/stripe')
            .set('stripe-signature', badInvEvt.signature)
            .set('Content-Type', 'application/json')
            .send(badInvEvt.rawText)
        ).body.ignored,
      ).toBe(true);

      // Register User B as EEA resident to check missing EU lot 404 & mismatched sub 404 + suspended 403
      await request(app)
        .post('/api/v1/lounge/auth/signup')
        .set('x-client-country', 'DE')
        .send({
          idToken: 'uid_b',
          xOAuthCode: 'x_oauth_b2',
          language: 'en',
          timezone: 'Europe/Berlin',
          disclaimerConsent: validConsent(1),
        });
      expect(
        (
          await request(app)
            .post('/api/v1/lounge/billing/eu-withdrawal')
            .set('Authorization', 'Bearer uid_b')
            .send({ targetType: 'CREDIT_LOT', targetId: 'lot_missing', confirmedWithdrawal: true })
        ).status,
      ).toBe(404);
      expect(
        (
          await request(app)
            .post('/api/v1/lounge/billing/eu-withdrawal')
            .set('Authorization', 'Bearer uid_b')
            .send({ targetType: 'SUBSCRIPTION', targetId: 'sub_missing', confirmedWithdrawal: true })
        ).status,
      ).toBe(404);

      const uA = (await cols.loungeUsers.doc('uid_user_a').get()).data()!;
      await cols.loungeUsers.doc('uid_user_a').set({ ...uA, status: 'SUSPENDED' });
      expect((await request(app).get('/api/v1/lounge/billing/catalog').set('Authorization', 'Bearer uid_a')).status).toBe(403);
    });

    it('covers Stripe string-id fallbacks, non-404 error rethrows, dispute-blocked checkout, expired EU lot, and nested invoice webhooks', async () => {
      const mockStripeStr = {
        customers: {
          retrieve: jest.fn().mockRejectedValueOnce({ statusCode: 500, message: 'stripe down' }),
          create: jest.fn(),
          del: jest.fn().mockRejectedValueOnce({ statusCode: 500, message: 'del fail' }),
        },
        checkout: {
          sessions: {
            create: jest.fn(),
            retrieve: jest.fn().mockResolvedValueOnce({
              id: 'cs_str',
              url: null,
              customer: 'cus_str',
              mode: 'subscription',
              payment_status: 'no_payment_required',
              payment_intent: 'pi_str',
              subscription: 'sub_str',
              created: 0,
              currency: null,
              amount_total: null,
              metadata: null,
            }),
            list: jest.fn().mockReturnValue((async function* () {})()),
          },
        },
        subscriptions: {
          retrieve: jest.fn().mockResolvedValueOnce({
            id: 'sub_str',
            customer: 'cus_str',
            status: 'incomplete_expired',
            cancel_at_period_end: false,
            latest_invoice: 'in_str',
            schedule: 'sched_str',
            currency: 'eur',
            items: { data: [{ current_period_end: 0 }] },
          }),
          list: jest.fn().mockReturnValue((async function* () {})()),
          cancel: jest.fn().mockRejectedValueOnce({ statusCode: 500, message: 'cancel fail' }),
        },
        subscriptionSchedules: { list: jest.fn().mockReturnValue((async function* () {})()) },
        invoices: { list: jest.fn().mockReturnValue((async function* () {})()) },
        charges: {
          list: jest.fn().mockResolvedValueOnce({ data: [], has_more: false }),
          retrieve: jest.fn(),
        },
        invoicePayments: {
          list: jest.fn().mockResolvedValueOnce({
            data: [
              {
                invoice: {
                  id: 'in_str_parent',
                  period_end: 1798000000,
                  parent: { subscription_details: { subscription: 'sub_parent_str' } },
                },
              },
            ],
          }),
        },
        refunds: { create: jest.fn() },
        webhooks: { constructEvent: jest.fn() },
      };
      const strAdapter = new StripeSdkGatewayAdapter('sk_test_str', mockStripeStr as unknown as Stripe);
      await expect(
        strAdapter.ensureCustomer({ existingCustomerId: 'cus_err', uid: 'u', xHandle: '@u', countryCode: 'JP' }),
      ).rejects.toMatchObject({ statusCode: 500 });
      await expect(strAdapter.cancelSubscriptionImmediately('sub_err')).rejects.toMatchObject({ statusCode: 500 });
      await expect(strAdapter.cancelAndDeleteCustomer('cus_err')).rejects.toMatchObject({ statusCode: 500 });
      const strSession = await strAdapter.retrieveCheckoutSession('cs_str');
      expect(strSession.customerId).toBe('cus_str');
      expect(strSession.paymentStatus).toBe('no_payment_required');
      const strSub = await strAdapter.retrieveSubscription('sub_str');
      expect(strSub.status).toBe('incomplete_expired');
      expect(strSub.latestInvoiceId).toBe('in_str');
      expect(await strAdapter.resolveInvoiceByPaymentIntent('pi_str')).toMatchObject({
        id: 'in_str_parent',
        subscriptionId: 'sub_parent_str',
      });

      const { app, cols, stripeGateway, config } = setupBillingAppHarness({
        LOUNGE_PHASE2_EEA_ENABLED: 'true',
      });
      await request(app)
        .post('/api/v1/lounge/auth/signup')
        .set('x-client-country', 'DE')
        .send({
          idToken: 'uid_b',
          xOAuthCode: 'x_oauth_b_branch',
          language: 'en',
          timezone: 'Europe/Berlin',
          disclaimerConsent: validConsent(1),
        });

      // Expired 14d credit lot throws 409 on EU withdrawal
      await cols.loungeCreditLots.doc('lot_old_eu').set({
        id: 'lot_old_eu',
        uid: 'uid_user_b',
        productId: 'CHARGE_TICKET_100',
        isPaid: true,
        initialTurns: 100,
        remainingTurns: 100,
        currency: 'USD',
        unitAmount: 350,
        status: 'ACTIVE',
        purchasedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2027-01-01T00:00:00.000Z',
      });
      expect(
        (
          await request(app)
            .post('/api/v1/lounge/billing/eu-withdrawal')
            .set('Authorization', 'Bearer uid_b')
            .send({ targetType: 'CREDIT_LOT', targetId: 'lot_old_eu', confirmedWithdrawal: true })
        ).status,
      ).toBe(409);

      // Dispute blocked trial checkout returns 403 DISPUTE_BLOCKED
      const grantHash = computeActiveTrialGrantHash('x_999002', config.trialHmacKeyring);
      await cols.loungeTrialGrants.doc(grantHash.hash).set({
        xUserIdHash: grantHash.hash,
        keyVersion: grantHash.keyVersion,
        riskStatus: 'DISPUTE_BLOCKED',
        retainUntil: '2029-12-31T00:00:00.000Z',
      });
      const blockedTrial = await request(app)
        .post('/api/v1/lounge/billing/checkout')
        .set('Authorization', 'Bearer uid_b')
        .send({
          productId: 'TRIAL_TICKET_100',
          acceptedPurchaseDisclosure: true,
          acceptedAutoRenewalOptIn: true,
          confirmedAdultOrParentalConsent: true,
        });
      expect(blockedTrial.status).toBe(403);
      expect(blockedTrial.body.code).toBe('DISPUTE_BLOCKED');

      // Catalog shows TRIAL_ALREADY_USED + SUBSCRIPTION_ALREADY_ACTIVE, listOrders handles empty charges + DISPUTED/REFUNDED/COMPLETED
      const subB = (await cols.loungeSubscriptions.doc('uid_user_b').get()).data()!;
      await cols.loungeSubscriptions.doc('uid_user_b').set({
        ...subB,
        trialTicketUsed: true,
        status: 'ACTIVE',
        tier: 'STANDARD',
        stripeCustomerId: 'cus_b_branch',
      });
      const catActive = await request(app)
        .get('/api/v1/lounge/billing/catalog')
        .set('Authorization', 'Bearer uid_b');
      expect(catActive.body.products.find((p: { productId: string }) => p.productId === 'TRIAL_TICKET_100').ineligibleReason).toBe(
        'TRIAL_ALREADY_USED',
      );
      expect(catActive.body.products.find((p: { productId: string }) => p.productId === 'STANDARD_MONTHLY').ineligibleReason).toBe(
        'SUBSCRIPTION_ALREADY_ACTIVE',
      );

      jest
        .spyOn(stripeGateway, 'listCharges')
        .mockResolvedValueOnce({ charges: [], hasMore: false })
        .mockResolvedValueOnce({
          charges: [
            {
              id: 'ch_disp',
              customerId: 'cus_b_branch',
              status: 'succeeded',
              amount: 350,
              amountRefunded: 0,
              refunded: false,
              disputed: true,
              currency: 'USD',
              createdIso: '2026-11-24T00:00:00.000Z',
              metadata: { productId: 'CHARGE_TICKET_100' },
            },
            {
              id: 'ch_ref',
              customerId: 'cus_b_branch',
              status: 'succeeded',
              amount: 350,
              amountRefunded: 350,
              refunded: true,
              disputed: false,
              currency: 'USD',
              createdIso: '2026-11-24T00:00:00.000Z',
              metadata: { productId: 'WELCOME_BONUS_20' },
            },
          ],
          hasMore: false,
        });
      expect(
        (await request(app).get('/api/v1/lounge/billing/orders').set('Authorization', 'Bearer uid_b')).body.orders,
      ).toEqual([]);
      const dispRefOrders = await request(app)
        .get('/api/v1/lounge/billing/orders')
        .set('Authorization', 'Bearer uid_b');
      expect(dispRefOrders.body.orders.map((o: { status: string }) => o.status)).toEqual(['DISPUTED', 'REFUNDED']);
      expect(dispRefOrders.body.orders[1].productId).toBe('UNKNOWN');

      // Nested parent.subscription_details.subscription webhook + missing subId ignored
      const nestedFailMissing = createSignedWebhookArgs({
        id: 'evt_fail_missing',
        type: 'invoice.payment_failed',
        data: { object: { id: 'in_only' } },
      });
      expect(
        (
          await request(app)
            .post('/api/v1/lounge/webhooks/stripe')
            .set('stripe-signature', nestedFailMissing.signature)
            .set('Content-Type', 'application/json')
            .send(nestedFailMissing.rawText)
        ).body.ignored,
      ).toBe(true);
    });
  });
});
