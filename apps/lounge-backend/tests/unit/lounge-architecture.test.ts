import { Firestore } from '@google-cloud/firestore';
import request from 'supertest';
import { getCollections } from '@rebecca/db';
import type {
  LoungeMessage,
  LoungeRagMemory,
  LoungeReward,
  LoungeRewardListResponseDto,
  LoungeSession,
  LoungeSessionListResponseDto,
  LoungeSubscription,
  LoungeUser,
} from '@rebecca/types';
import {
  createLoungeApp,
  createSkeletonLoungeDependencies,
  resolveLoungeAppVersion,
  type LoungeAppDependencies,
} from '../../src/app';
import {
  LoungeAuthRepository,
  type CreateLoungeUserWithConsentInput,
  type ILoungeAuthRepository,
} from '../../src/features/auth/repositories/loungeAuth.repository';
import { LoungeAuthController } from '../../src/features/auth/controllers/loungeAuth.controller';
import { LoungeAuthUseCase } from '../../src/features/auth/usecases/loungeAuth.usecase';
import {
  LoungeAccountRepository,
  type ILoungeAccountRepository,
} from '../../src/features/account/repositories/loungeAccount.repository';
import { LoungeAccountUseCase } from '../../src/features/account/usecases/loungeAccount.usecase';
import {
  LoungeRewardRepository,
  type ILoungeRewardRepository,
} from '../../src/features/rewards/repositories/loungeReward.repository';
import { LoungeRewardUseCase } from '../../src/features/rewards/usecases/loungeReward.usecase';
import type {
  ILoungeChatPipelinePort,
  ILoungeEmotionClassifierPort,
  IPublicXMemoryReadPort,
} from '../../src/features/sessions/ports/loungeAi.port';
import {
  LoungeSessionRepository,
  type AppendLoungeMessagePairInput,
  type ILoungeSessionRepository,
} from '../../src/features/sessions/repositories/loungeSession.repository';
import {
  LoungeSessionUseCase,
  MAX_LOUNGE_MESSAGE_LENGTH,
  MAX_LOUNGE_TITLE_LENGTH,
} from '../../src/features/sessions/usecases/loungeSession.usecase';
import {
  requireLoungeIdentity,
  type ILoungeAuthVerifierPort,
  type LoungeAuthenticatedRequest,
  type LoungeVerifiedIdentity,
} from '../../src/middleware/loungeAuth';
import {
  LoungeHttpError,
  LoungeNotImplementedError,
  extractTraceHeader,
  normalizePaginationLimit,
} from '../../src/utils/errors';
import { loungeLogger, sanitizeLogInput } from '../../src/utils/logger';

function createValidConsent() {
  return {
    disclaimerVersion: '2026-11-22',
    agreedToGeminiTrainingUsage: true,
    agreedToZeroPiiProhibition: true,
    agreedToOneWayMemoryIsolation: true,
    scrolledToBottomAt: '2026-11-22T12:00:00.000Z',
    consentedAt: '2026-11-22T12:00:05.000Z',
  };
}

function buildFakeDeps(
  overrides: {
    user?: LoungeUser | null;
    subscription?: LoungeSubscription | null;
    session?: LoungeSession | null;
    rewardUnlockCode?: string;
    tokenUid?: string;
    tokenXUserId?: string;
  } = {},
) {
  let currentUser: LoungeUser | null =
    overrides.user === undefined
      ? {
          uid: 'uid_test_001',
          xUserId: '100001',
          xHandle: '@user_001',
          displayName: 'Test User 001',
          avatarUrl: 'assets/gemitec_icon.svg',
          status: 'ACTIVE',
          disclaimerConsent: createValidConsent(),
          createdAt: '2026-11-22T12:00:05.000Z',
          updatedAt: '2026-11-22T12:00:05.000Z',
          lastLoginAt: '2026-11-22T12:00:05.000Z',
        }
      : overrides.user;

  let currentSub: LoungeSubscription | null =
    overrides.subscription === undefined
      ? {
          uid: 'uid_test_001',
          tier: 'SUPPORTER',
          status: 'ACTIVE',
          dailyTurnQuota: 30,
          remainingChatTurns: 24,
          quotaResetAt: '2026-11-23T00:00:00.000Z',
          currentPeriodEnd: '2026-12-22T00:00:00.000Z',
          updatedAt: '2026-11-22T12:00:05.000Z',
        }
      : overrides.subscription;

  const activeSession: LoungeSession | null =
    overrides.session === undefined
      ? {
          id: 'sess_001',
          uid: 'uid_test_001',
          title: 'Cyber Midnight Talk',
          messageCount: 2,
          currentEmotion: 'TEASING',
          publicXMemorySyncedAt: '2026-11-22T12:00:00.000Z',
          lastMessagePreview: 'ようこそラウンジへ',
          createdAt: '2026-11-22T12:00:00.000Z',
          updatedAt: '2026-11-22T12:05:00.000Z',
        }
      : overrides.session;

  const reward: LoungeReward = {
    id: 'uid_test_001_RW-01',
    uid: 'uid_test_001',
    code: 'RW-01',
    titleJa: 'ネオンの休憩時間',
    titleEn: 'Neon Coffee Break',
    descriptionJa: 'プライベートセッション解放記念',
    descriptionEn: 'Unlocked on private session',
    emotionTag: 'HAPPY',
    rarity: 'SSR',
    previewAssetPath: 'assets/gallery_morning.webp',
    unlocked: false,
  };

  let lastRequestedLimit: number | undefined;
  let lastSessionOwnerUid: string | undefined;

  const personaBranding = {
    displayName: 'レベッカ',
    englishName: 'Rebecca',
    brandName: 'Rebecca AI',
    avatarPath: 'assets/persona_cutout.webp',
  };

  const authVerifier: ILoungeAuthVerifierPort = {
    async verifyBearerToken(idToken: string): Promise<LoungeVerifiedIdentity> {
      if (idToken === 'bad-token') {
        throw new Error('Signature verification failed');
      }
      if (idToken === 'stub-501-token') {
        throw new LoungeNotImplementedError('Verifier.stub');
      }
      return {
        uid: overrides.tokenUid ?? 'uid_test_001',
        xUserId: overrides.tokenXUserId ?? '100001',
        xHandle: '@user_001',
        displayName: 'Test User 001',
        avatarUrl: 'assets/gemitec_icon.svg',
      };
    },
  };

  const authRepository: ILoungeAuthRepository = {
    async findUserByUid(uid: string) {
      return currentUser && currentUser.uid === uid ? currentUser : null;
    },
    async findUserByXUserId(xUserId: string) {
      return currentUser && currentUser.xUserId === xUserId ? currentUser : null;
    },
    async createUserWithConsent(input: CreateLoungeUserWithConsentInput) {
      currentUser = {
        uid: input.uid,
        xUserId: input.xUserId,
        xHandle: input.xHandle,
        displayName: input.displayName,
        avatarUrl: input.avatarUrl,
        status: 'ACTIVE',
        disclaimerConsent: input.disclaimerConsent,
        createdAt: '2026-11-22T12:00:05.000Z',
        updatedAt: '2026-11-22T12:00:05.000Z',
        lastLoginAt: '2026-11-22T12:00:05.000Z',
      };
      return currentUser;
    },
    async recordLoginTimestamp(uid: string, timestampIso: string) {
      if (currentUser && currentUser.uid === uid) {
        currentUser = { ...currentUser, lastLoginAt: timestampIso };
      }
    },
    async revokeSession() {
      return;
    },
  };

  const accountRepository: ILoungeAccountRepository = {
    async getSubscriptionByUid(uid: string) {
      return currentSub && currentSub.uid === uid ? currentSub : null;
    },
    async decrementRemainingTurns(uid: string) {
      if (!currentSub || currentSub.uid !== uid) {
        throw new Error('Missing subscription');
      }
      currentSub = {
        ...currentSub,
        remainingChatTurns: currentSub.remainingChatTurns - 1,
      };
      return currentSub;
    },
  };

  const rewardRepository: ILoungeRewardRepository = {
    async listRewardsByUid(_uid: string, limit?: number): Promise<LoungeRewardListResponseDto> {
      lastRequestedLimit = limit;
      return {
        items: [reward],
        unlockedCount: reward.unlocked ? 1 : 0,
        totalCount: 1,
        nextCursor: null,
      };
    },
    async unlockReward(_uid: string, rewardCode: string, sessionId: string) {
      return {
        ...reward,
        code: rewardCode,
        unlocked: true,
        unlockedAt: '2026-11-22T12:15:00.000Z',
        sourceSessionId: sessionId,
      };
    },
  };

  const sessionRepository: ILoungeSessionRepository = {
    async listSessions(uid: string, limit?: number): Promise<LoungeSessionListResponseDto> {
      lastSessionOwnerUid = uid;
      lastRequestedLimit = limit;
      return {
        items: activeSession ? [activeSession] : [],
        nextCursor: null,
        totalCount: activeSession ? 1 : 0,
      };
    },
    async getSessionById(sessionId: string) {
      return activeSession && activeSession.id === sessionId ? activeSession : null;
    },
    async createSession(uid: string, title: string, syncedAt: string) {
      return {
        id: 'sess_created_001',
        uid,
        title,
        messageCount: 0,
        currentEmotion: 'NEUTRAL',
        publicXMemorySyncedAt: syncedAt,
        lastMessagePreview: '',
        createdAt: syncedAt,
        updatedAt: syncedAt,
      };
    },
    async listMessages(sessionId: string, limit?: number) {
      lastRequestedLimit = limit;
      const items: LoungeMessage[] = [
        {
          id: 'msg_001',
          sessionId,
          uid: 'uid_test_001',
          role: 'ASSISTANT',
          content: 'プライベートラウンジへようこそ。',
          emotion: 'TEASING',
          createdAt: '2026-11-22T12:01:00.000Z',
        },
      ];
      return { items, nextCursor: null, totalCount: items.length };
    },
    async appendMessagePair(input: AppendLoungeMessagePairInput) {
      return {
        session: {
          ...(activeSession as LoungeSession),
          messageCount: 4,
          currentEmotion: input.assistantEmotion,
          lastMessagePreview: input.assistantContent,
        },
        userMessage: {
          id: 'msg_user_new',
          sessionId: input.sessionId,
          uid: input.uid,
          role: 'USER',
          content: input.userContent,
          emotion: input.userEmotion,
          createdAt: '2026-11-22T12:10:00.000Z',
        },
        assistantMessage: {
          id: 'msg_assistant_new',
          sessionId: input.sessionId,
          uid: input.uid,
          role: 'ASSISTANT',
          content: input.assistantContent,
          emotion: input.assistantEmotion,
          unlockedRewardId: input.unlockedRewardId,
          tokenUsage: input.assistantTokenUsage,
          createdAt: '2026-11-22T12:10:01.000Z',
        },
      };
    },
    async listRagMemories(): Promise<LoungeRagMemory[]> {
      return [];
    },
  };

  const publicXMemoryPort: IPublicXMemoryReadPort = {
    async readPublicXUserSnapshot(xUserId: string) {
      return {
        xUserId,
        relationshipToneSummary: 'Friendly coffee talk buddy',
        sharedHighlights: ['Enjoys retro synthwave'],
        syncedAt: '2026-11-22T12:00:00.000Z',
      };
    },
  };

  const emotionClassifier: ILoungeEmotionClassifierPort = {
    async classifyEmotion() {
      return 'HAPPY';
    },
  };

  const chatPipeline: ILoungeChatPipelinePort = {
    async generateReply() {
      return {
        replyText: 'プライベート空間でゆっくり話そう。',
        emotion: 'TEASING',
        tokenUsage: { promptTokens: 210, candidatesTokens: 48, totalTokens: 258 },
        unlockedRewardCode: overrides.rewardUnlockCode,
      };
    },
  };

  const deps: LoungeAppDependencies = {
    authVerifier,
    authUseCase: new LoungeAuthUseCase(authRepository, authVerifier, 'v1.45.2'),
    accountUseCase: new LoungeAccountUseCase(
      authRepository,
      accountRepository,
      rewardRepository,
      'v1.45.2',
      personaBranding,
    ),
    sessionUseCase: new LoungeSessionUseCase(
      sessionRepository,
      authRepository,
      accountRepository,
      rewardRepository,
      publicXMemoryPort,
      emotionClassifier,
      chatPipeline,
    ),
    rewardUseCase: new LoungeRewardUseCase(rewardRepository),
    allowedOrigins: ['http://localhost:4300'],
    appVersion: 'v1.45.2',
    disclaimerVersion: '2026-11-22',
    personaBranding,
  };

  return {
    deps,
    publicXMemoryPort,
    getLastLimit: () => lastRequestedLimit,
    getLastSessionOwnerUid: () => lastSessionOwnerUid,
  };
}

describe('Gemitec Private Lounge BFF Architecture Skeleton', () => {
  beforeEach(() => {
    jest.spyOn(loungeLogger, 'info').mockImplementation(() => undefined);
    jest.spyOn(loungeLogger, 'warn').mockImplementation(() => undefined);
    jest.spyOn(loungeLogger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('serves health & runtime config backed by @rebecca/persona and omits CORS header for untrusted origins', async () => {
    const { deps } = buildFakeDeps();
    const app = createLoungeApp(deps);

    const healthRes = await request(app)
      .get('/api/v1/lounge/health')
      .set('Origin', 'http://localhost:4300');
    expect(healthRes.status).toBe(200);
    expect(healthRes.headers['access-control-allow-origin']).toBe('http://localhost:4300');
    expect(healthRes.body).toEqual({
      status: 'ok',
      service: 'lounge-backend',
      version: 'v1.45.2',
    });

    const configRes = await request(app).get('/api/v1/lounge/config');
    expect(configRes.status).toBe(200);
    expect(configRes.body).toEqual({
      appVersion: 'v1.45.2',
      disclaimerVersion: '2026-11-22',
      persona: {
        displayName: 'レベッカ',
        englishName: 'Rebecca',
        brandName: 'Rebecca AI',
        avatarPath: 'assets/persona_cutout.webp',
      },
    });

    const untrustedCorsRes = await request(app)
      .get('/api/v1/lounge/health')
      .set('Origin', 'https://untrusted.example.com');
    expect(untrustedCorsRes.status).toBe(200);
    expect(untrustedCorsRes.headers['access-control-allow-origin']).toBeUndefined();
    expect(loungeLogger.warn).toHaveBeenCalledTimes(1);

    const malformedJsonRes = await request(app)
      .post('/api/v1/lounge/auth/login')
      .set('Content-Type', 'application/json')
      .send('{ invalid json');
    expect(malformedJsonRes.status).toBe(400);
    expect(malformedJsonRes.body).toEqual({ error: 'Malformed JSON request body' });
  });

  it('enforces Bearer token auth, propagates 501 verifier stubs, and restricts NO_AUTH bypass', async () => {
    const { deps } = buildFakeDeps();
    const prodApp = createLoungeApp({ ...deps, noAuth: true, nodeEnv: 'production' });
    const unauthProd = await request(prodApp).get('/api/v1/lounge/account');
    expect(unauthProd.status).toBe(401);

    const stagingNoEmulator = createLoungeApp({ ...deps, noAuth: true, nodeEnv: 'staging' });
    const unauthStaging = await request(stagingNoEmulator).get('/api/v1/lounge/account');
    expect(unauthStaging.status).toBe(401);

    const malformedRes = await request(prodApp)
      .get('/api/v1/lounge/account')
      .set('Authorization', 'Basic abc');
    expect(malformedRes.status).toBe(401);

    const emptyTokenRes = await request(prodApp)
      .get('/api/v1/lounge/account')
      .set('Authorization', 'Bearer   ');
    expect(emptyTokenRes.status).toBe(401);

    const badTokenRes = await request(prodApp)
      .get('/api/v1/lounge/account')
      .set('Authorization', 'Bearer bad-token');
    expect(badTokenRes.status).toBe(401);

    const stub501TokenRes = await request(prodApp)
      .get('/api/v1/lounge/account')
      .set('Authorization', 'Bearer stub-501-token');
    expect(stub501TokenRes.status).toBe(501);

    const devApp = createLoungeApp({ ...deps, noAuth: true, nodeEnv: 'development' });
    const devMissingUser = await request(devApp).get('/api/v1/lounge/account');
    expect(devMissingUser.status).toBe(401);
  });

  it('validates scroll-gated disclaimer payloads strictly without 500 TypeErrors and enforces 1:1 X uniqueness', async () => {
    const { deps } = buildFakeDeps({ user: null });
    const app = createLoungeApp(deps);

    const badPayload = await request(app).post('/api/v1/lounge/auth/signup').send({});
    expect(badPayload.status).toBe(400);

    const nonObjectConsent = await request(app)
      .post('/api/v1/lounge/auth/signup')
      .send({
        idToken: 'valid-token',
        xOAuthCode: 'oauth-123',
        disclaimerConsent: 'invalid-string',
      });
    expect(nonObjectConsent.status).toBe(400);

    const nonBooleanConsent = await request(app)
      .post('/api/v1/lounge/auth/signup')
      .send({
        idToken: 'valid-token',
        xOAuthCode: 'oauth-123',
        disclaimerConsent: {
          ...createValidConsent(),
          agreedToGeminiTrainingUsage: 'true',
        },
      });
    expect(nonBooleanConsent.status).toBe(400);

    const numericVersionConsent = await request(app)
      .post('/api/v1/lounge/auth/signup')
      .send({
        idToken: 'valid-token',
        xOAuthCode: 'oauth-123',
        disclaimerConsent: {
          ...createValidConsent(),
          disclaimerVersion: 123,
        },
      });
    expect(numericVersionConsent.status).toBe(400);

    const unscrolledRes = await request(app)
      .post('/api/v1/lounge/auth/signup')
      .send({
        idToken: 'valid-token',
        xOAuthCode: 'oauth-123',
        disclaimerConsent: {
          ...createValidConsent(),
          consentedAt: '2026-11-22T11:59:00.000Z',
        },
      });
    expect(unscrolledRes.status).toBe(400);

    const signUpOk = await request(app)
      .post('/api/v1/lounge/auth/signup')
      .send({
        idToken: 'valid-token',
        xOAuthCode: 'oauth-123',
        disclaimerConsent: {
          ...createValidConsent(),
          extraMaliciousField: 'ignored',
        },
      });
    expect(signUpOk.status).toBe(201);
    expect(signUpOk.body.user.xHandle).toBe('@user_001');
    expect(signUpOk.body.user.disclaimerConsent.extraMaliciousField).toBeUndefined();

    // Duplicate registration by UID returns 403
    const dupRes = await request(app)
      .post('/api/v1/lounge/auth/signup')
      .send({
        idToken: 'valid-token',
        xOAuthCode: 'oauth-123',
        disclaimerConsent: createValidConsent(),
      });
    expect(dupRes.status).toBe(403);

    // Duplicate registration by different Firebase UID sharing the same X user ID returns 403
    const existingXDeps = buildFakeDeps({ tokenUid: 'uid_different_002', tokenXUserId: '100001' });
    const existingXApp = createLoungeApp(existingXDeps.deps);
    const dupXRes = await request(existingXApp)
      .post('/api/v1/lounge/auth/signup')
      .send({
        idToken: 'valid-token',
        xOAuthCode: 'oauth-456',
        disclaimerConsent: createValidConsent(),
      });
    expect(dupXRes.status).toBe(403);

    const loginOk = await request(app)
      .post('/api/v1/lounge/auth/login')
      .send({ idToken: 'valid-token' });
    expect(loginOk.status).toBe(200);
    expect(loginOk.body.user.uid).toBe('uid_test_001');

    const logoutOk = await request(app)
      .post('/api/v1/lounge/auth/logout')
      .set('Authorization', 'Bearer valid-token');
    expect(logoutOk.status).toBe(204);
  });

  it('serves account summary, bounded pagination, quota decrement, and enforces session ownership (IDOR defense)', async () => {
    const { deps, publicXMemoryPort, getLastLimit, getLastSessionOwnerUid } = buildFakeDeps({
      rewardUnlockCode: 'RW-01',
    });
    const app = createLoungeApp(deps);

    expect(Object.keys(publicXMemoryPort)).toEqual(['readPublicXUserSnapshot']);

    const accountRes = await request(app)
      .get('/api/v1/lounge/account')
      .set('Authorization', 'Bearer valid-token');
    expect(accountRes.status).toBe(200);
    expect(accountRes.body.subscription.tier).toBe('SUPPORTER');
    expect(accountRes.body.subscription.remainingChatTurns).toBe(24);
    expect(accountRes.body.publicXMemoryOneWayActive).toBe(true);
    expect(accountRes.body.persona.englishName).toBe('Rebecca');

    const sessionsRes = await request(app)
      .get('/api/v1/lounge/sessions?limit=500&startAfterId=cursor_0')
      .set('Authorization', 'Bearer valid-token');
    expect(sessionsRes.status).toBe(200);
    expect(getLastSessionOwnerUid()).toBe('uid_test_001');
    expect(getLastLimit()).toBe(100);

    const arrayCursorRes = await request(app)
      .get('/api/v1/lounge/sessions?startAfterId=a&startAfterId=b')
      .set('Authorization', 'Bearer valid-token');
    expect(arrayCursorRes.status).toBe(400);

    const invalidLimitRes = await request(app)
      .get('/api/v1/lounge/sessions?limit=0')
      .set('Authorization', 'Bearer valid-token');
    expect(invalidLimitRes.status).toBe(400);

    const oversizedTitleRes = await request(app)
      .post('/api/v1/lounge/sessions')
      .set('Authorization', 'Bearer valid-token')
      .send({ title: 'x'.repeat(MAX_LOUNGE_TITLE_LENGTH + 1) });
    expect(oversizedTitleRes.status).toBe(400);

    const createSessionRes = await request(app)
      .post('/api/v1/lounge/sessions')
      .set('Authorization', 'Bearer valid-token')
      .send({ title: '深夜の秘密トーク' });
    expect(createSessionRes.status).toBe(201);
    expect(createSessionRes.body.title).toBe('深夜の秘密トーク');

    const messagesRes = await request(app)
      .get('/api/v1/lounge/sessions/sess_001/messages?limit=10&startAfterId=msg_000')
      .set('Authorization', 'Bearer valid-token');
    expect(messagesRes.status).toBe(200);
    expect(messagesRes.body.items[0].id).toBe('msg_001');
    expect(getLastLimit()).toBe(10);

    const rewardsRes = await request(app)
      .get('/api/v1/lounge/rewards?limit=25')
      .set('Authorization', 'Bearer valid-token');
    expect(rewardsRes.status).toBe(200);
    expect(rewardsRes.body.unlockedCount).toBe(0);
    expect(rewardsRes.body.items[0].code).toBe('RW-01');
    expect(getLastLimit()).toBe(25);

    const blankSessionMessagesRes = await request(app)
      .get('/api/v1/lounge/sessions/%20%20/messages')
      .set('Authorization', 'Bearer valid-token');
    expect(blankSessionMessagesRes.status).toBe(400);

    const blankSessionPostRes = await request(app)
      .post('/api/v1/lounge/sessions/%20%20/messages')
      .set('Authorization', 'Bearer valid-token')
      .send({ content: 'hello' });
    expect(blankSessionPostRes.status).toBe(400);

    const sendRes = await request(app)
      .post('/api/v1/lounge/sessions/sess_001/messages')
      .set('Authorization', 'Bearer valid-token')
      .send({ content: '今日もコーヒー美味しいね！' });
    expect(sendRes.status).toBe(201);
    expect(sendRes.body.remainingChatTurns).toBe(23);
    expect(sendRes.body.unlockedReward?.code).toBe('RW-01');

    // Cross-user IDOR check: different caller UID must receive 404 on sess_001
    const otherUserDeps = buildFakeDeps({
      tokenUid: 'uid_other_999',
      user: {
        uid: 'uid_other_999',
        xUserId: '999999',
        xHandle: '@other_user',
        displayName: 'Other User',
        avatarUrl: 'assets/gemitec_icon.svg',
        status: 'ACTIVE',
        disclaimerConsent: createValidConsent(),
        createdAt: '2026-11-22T12:00:00.000Z',
        updatedAt: '2026-11-22T12:00:00.000Z',
        lastLoginAt: '2026-11-22T12:00:00.000Z',
      },
    });
    const otherUserApp = createLoungeApp(otherUserDeps.deps);
    const idorRead = await request(otherUserApp)
      .get('/api/v1/lounge/sessions/sess_001/messages')
      .set('Authorization', 'Bearer valid-token');
    expect(idorRead.status).toBe(404);
    const idorPost = await request(otherUserApp)
      .post('/api/v1/lounge/sessions/sess_001/messages')
      .set('Authorization', 'Bearer valid-token')
      .send({ content: 'IDOR attempt' });
    expect(idorPost.status).toBe(404);
  });

  it('rejects inactive accounts/subscriptions, exhausted quota (429), and logs 5xx errors with ERROR severity', async () => {
    const canceledSubDeps = buildFakeDeps({
      subscription: {
        uid: 'uid_test_001',
        tier: 'FREE',
        status: 'CANCELED',
        dailyTurnQuota: 5,
        remainingChatTurns: 3,
        quotaResetAt: '2026-11-23T00:00:00.000Z',
        currentPeriodEnd: '2026-12-22T00:00:00.000Z',
        updatedAt: '2026-11-22T12:00:00.000Z',
      },
    });
    const canceledRes = await request(createLoungeApp(canceledSubDeps.deps))
      .post('/api/v1/lounge/sessions/sess_001/messages')
      .set('Authorization', 'Bearer valid-token')
      .send({ content: 'こんにちは' });
    expect(canceledRes.status).toBe(403);

    const quotaDeps = buildFakeDeps({
      subscription: {
        uid: 'uid_test_001',
        tier: 'FREE',
        status: 'ACTIVE',
        dailyTurnQuota: 5,
        remainingChatTurns: 0,
        quotaResetAt: '2026-11-23T00:00:00.000Z',
        currentPeriodEnd: '2026-12-22T00:00:00.000Z',
        updatedAt: '2026-11-22T12:00:00.000Z',
      },
    });
    const app = createLoungeApp(quotaDeps.deps);

    const oversizedBodyRes = await request(app)
      .post('/api/v1/lounge/sessions/sess_001/messages')
      .set('Authorization', 'Bearer valid-token')
      .send({ content: 'a'.repeat(300 * 1024) });
    expect(oversizedBodyRes.status).toBe(413);

    const emptyPrompt = await request(app)
      .post('/api/v1/lounge/sessions/sess_001/messages')
      .set('Authorization', 'Bearer valid-token')
      .send({ content: '   ' });
    expect(emptyPrompt.status).toBe(400);

    const nonStringPrompt = await request(app)
      .post('/api/v1/lounge/sessions/sess_001/messages')
      .set('Authorization', 'Bearer valid-token')
      .send({ content: 42 });
    expect(nonStringPrompt.status).toBe(400);

    const oversizedPrompt = await request(app)
      .post('/api/v1/lounge/sessions/sess_001/messages')
      .set('Authorization', 'Bearer valid-token')
      .send({ content: 'a'.repeat(MAX_LOUNGE_MESSAGE_LENGTH + 1) });
    expect(oversizedPrompt.status).toBe(400);

    const quotaRes = await request(app)
      .post('/api/v1/lounge/sessions/sess_001/messages')
      .set('Authorization', 'Bearer valid-token')
      .send({ content: 'こんにちは' });
    expect(quotaRes.status).toBe(429);

    // Non-501 5xx LoungeHttpError must emit ERROR severity and mask internal detail
    const badGatewayApp = createLoungeApp({
      ...quotaDeps.deps,
      rewardUseCase: {
        async listRewards() {
          throw new LoungeHttpError(502, 'Internal upstream failure detail');
        },
      },
    });
    const gatewayRes = await request(badGatewayApp)
      .get('/api/v1/lounge/rewards')
      .set('Authorization', 'Bearer valid-token')
      .set('x-cloud-trace-context', 'trace123/span1;o=1');
    expect(gatewayRes.status).toBe(502);
    expect(gatewayRes.body).toEqual({ error: 'Internal server error' });
    expect(loungeLogger.error).toHaveBeenCalledTimes(1);
    expect(
      extractTraceHeader({
        headers: { 'x-cloud-trace-context': 'trace123/span1;o=1\r\ninjected' },
      } as unknown as Parameters<typeof extractTraceHeader>[0]),
    ).toBe('trace123/span1;o=1 injected');

    const suspendedDeps = buildFakeDeps({
      user: {
        uid: 'uid_test_001',
        xUserId: '100001',
        xHandle: '@user_001',
        displayName: 'Suspended User',
        avatarUrl: 'assets/gemitec_icon.svg',
        status: 'SUSPENDED',
        disclaimerConsent: createValidConsent(),
        createdAt: '2026-11-22T12:00:05.000Z',
        updatedAt: '2026-11-22T12:00:05.000Z',
        lastLoginAt: '2026-11-22T12:00:05.000Z',
      },
    });
    const suspendedAccountRes = await request(createLoungeApp(suspendedDeps.deps))
      .get('/api/v1/lounge/account')
      .set('Authorization', 'Bearer valid-token');
    expect(suspendedAccountRes.status).toBe(403);

    const noSubDeps = buildFakeDeps({ subscription: null });
    const noSubAccountRes = await request(createLoungeApp(noSubDeps.deps))
      .get('/api/v1/lounge/account')
      .set('Authorization', 'Bearer valid-token');
    expect(noSubAccountRes.status).toBe(404);

    const rawThrowApp = createLoungeApp({
      ...quotaDeps.deps,
      rewardUseCase: {
        async listRewards() {
          throw 'string failure';
        },
      },
    });
    const rawThrowRes = await request(rawThrowApp)
      .get('/api/v1/lounge/rewards')
      .set('Authorization', 'Bearer valid-token');
    expect(rawThrowRes.status).toBe(500);
  });

  it('wires skeleton Firestore repositories cleanly and tests edge rejections directly', async () => {
    expect(resolveLoungeAppVersion({ APP_VERSION: '2.0.0' })).toBe('v2.0.0');
    expect(resolveLoungeAppVersion({})).toMatch(/^v\d+\.\d+\.\d+/);

    const skeletonDeps = createSkeletonLoungeDependencies({ NODE_ENV: 'production' });
    expect(skeletonDeps.allowedOrigins).toEqual([]);
    const configuredCorsDeps = createSkeletonLoungeDependencies({
      CORS_ALLOWED_ORIGINS: 'https://a.example.com, https://b.example.com',
    });
    expect(configuredCorsDeps.allowedOrigins).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
    await expect(configuredCorsDeps.authVerifier.verifyBearerToken('t')).rejects.toThrow(
      LoungeNotImplementedError,
    );
    await expect(
      configuredCorsDeps.sessionUseCase.createSession('u1', 'x1', {}),
    ).rejects.toThrow(LoungeNotImplementedError);
    const skeletonApp = createLoungeApp(skeletonDeps);

    const signupStubRes = await request(skeletonApp)
      .post('/api/v1/lounge/auth/signup')
      .send({
        idToken: 'token',
        xOAuthCode: 'code',
        disclaimerConsent: createValidConsent(),
      });
    expect(signupStubRes.status).toBe(501);

    const firestore = new Firestore({ projectId: 'demo-rebecca-lounge' });
    const collections = getCollections(firestore);
    const authRepo = new LoungeAuthRepository(collections);
    const accountRepo = new LoungeAccountRepository(collections);
    const sessionRepo = new LoungeSessionRepository(collections);
    const rewardRepo = new LoungeRewardRepository(collections);

    await expect(authRepo.findUserByUid('u1')).rejects.toThrow(LoungeNotImplementedError);
    await expect(authRepo.findUserByXUserId('x1')).rejects.toThrow(LoungeNotImplementedError);
    await expect(
      authRepo.createUserWithConsent({
        uid: 'u1',
        xUserId: 'x1',
        xHandle: '@u1',
        displayName: 'U1',
        avatarUrl: '',
        disclaimerConsent: createValidConsent(),
      }),
    ).rejects.toThrow(LoungeNotImplementedError);
    await expect(authRepo.recordLoginTimestamp('u1', '2026-11-22T12:00:00.000Z')).rejects.toThrow(
      LoungeNotImplementedError,
    );
    await expect(authRepo.revokeSession('u1')).rejects.toThrow(LoungeNotImplementedError);
    await expect(accountRepo.getSubscriptionByUid('u1')).rejects.toThrow(LoungeNotImplementedError);
    await expect(accountRepo.decrementRemainingTurns('u1')).rejects.toThrow(
      LoungeNotImplementedError,
    );
    expect(sessionRepo.clampLimit(undefined)).toBe(20);
    expect(normalizePaginationLimit('15')).toBe(15);
    await expect(sessionRepo.listSessions('u1')).rejects.toThrow(LoungeNotImplementedError);
    await expect(sessionRepo.getSessionById('s1')).rejects.toThrow(LoungeNotImplementedError);
    await expect(
      sessionRepo.createSession('u1', 'Title', '2026-11-22T12:00:00.000Z'),
    ).rejects.toThrow(LoungeNotImplementedError);
    await expect(sessionRepo.listMessages('s1')).rejects.toThrow(LoungeNotImplementedError);
    await expect(
      sessionRepo.appendMessagePair({
        uid: 'u1',
        sessionId: 's1',
        userContent: 'hi',
        userEmotion: 'NEUTRAL',
        assistantContent: 'hello',
        assistantEmotion: 'HAPPY',
        assistantTokenUsage: { promptTokens: 1, candidatesTokens: 1, totalTokens: 2 },
      }),
    ).rejects.toThrow(LoungeNotImplementedError);
    await expect(sessionRepo.listRagMemories('u1')).rejects.toThrow(LoungeNotImplementedError);
    await expect(rewardRepo.listRewardsByUid('u1')).rejects.toThrow(LoungeNotImplementedError);
    await expect(rewardRepo.unlockReward('u1', 'RW-01', 's1')).rejects.toThrow(
      LoungeNotImplementedError,
    );

    expect(() => requireLoungeIdentity({} as LoungeAuthenticatedRequest)).toThrow(
      /Authenticated user identity is required/,
    );
    const { deps } = buildFakeDeps();
    const authController = new LoungeAuthController(deps.authUseCase);
    const mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn(), send: jest.fn() } as any;
    await authController.logout({ headers: {} } as any, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(sanitizeLogInput('hello\r\nforged')).toBe('hello forged');
  });
});
