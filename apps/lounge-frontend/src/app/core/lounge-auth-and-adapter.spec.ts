import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  LOUNGE_ERROR_CODE_DISCLAIMER_RECONSENT_REQUIRED,
  type LoungeBillingCatalogDto,
  type LoungeBillingOrdersResponseDto,
  type LoungeBillingReceiptResponseDto,
  type LoungeCreateCheckoutResponseDto,
  type LoungeCreatePortalResponseDto,
  type LoungeEuWithdrawalResponseDto,
  type LoungeRuntimeConfigDto,
  type LoungeSubscription,
  type LoungeSubscriptionDetailResponseDto,
  type LoungeUser,
  type LoungeVerifyCheckoutResponseDto,
} from '@rebecca/types';
import { firstValueFrom } from 'rxjs';
import {
  LoungeBffAdapter,
  LoungeClientApiError,
  LoungeReconsentRequiredClientError,
} from './adapters/lounge-bff.adapter';
import {
  isTrustedLoungeApiDestination,
  loungeAuthInterceptor,
} from './interceptors/lounge-auth.interceptor';
import { LoungeAuthService } from './services/lounge-auth.service';
import { isAllowedStripeRedirectUrl } from './utils/lounge-url-security';

const mockInitializeApp = jest.fn((_cfg?: unknown, name?: string) => ({ name: name ?? '[DEFAULT]' }));
const mockGetApps = jest.fn(() => [] as { name: string }[]);
const mockGetApp = jest.fn((name?: string) => ({ name: name ?? '[DEFAULT]' }));
const mockAuthInstance: {
  currentUser: {
    uid: string;
    accessToken?: string;
    getIdToken: jest.Mock<Promise<string>, [boolean?]>;
  } | null;
  tenantId: string | null;
  authStateReady: jest.Mock<Promise<void>, []>;
} = {
  currentUser: null,
  tenantId: null,
  authStateReady: jest.fn(async () => undefined),
};
const mockGetAuth = jest.fn(() => mockAuthInstance);
const mockConnectAuthEmulator = jest.fn();
const mockOnAuthStateChanged = jest.fn(
  (_auth: unknown, cb: (user: typeof mockAuthInstance.currentUser) => void) => {
    cb(mockAuthInstance.currentUser);
    return jest.fn();
  },
);
const mockSignInWithCredential = jest.fn(async () => ({
  user: {
    uid: 'uid_emu_001',
    accessToken: 'emu-id-token',
    getIdToken: jest.fn(async () => 'emu-id-token'),
  },
}));
const mockSignInWithPopup = jest.fn(async () => ({
  user: {
    uid: 'uid_live_001',
    accessToken: 'live-id-token',
    getIdToken: jest.fn(async () => 'live-id-token'),
  },
}));
const mockSignOut = jest.fn(async () => {
  mockAuthInstance.currentUser = null;
});
const mockOAuthCredential = jest.fn((params: { readonly idToken: string }) => ({
  providerId: 'twitter.com',
  idToken: params.idToken,
}));
const mockTwitterCredentialFromResult = jest.fn(
  (_result: unknown): { readonly accessToken?: string } | null => ({
    accessToken: 'twitter-oauth-access-token',
  }),
);

jest.mock('firebase/app', () => ({
  initializeApp: (cfg: unknown, name?: string) => mockInitializeApp(cfg, name),
  getApps: () => mockGetApps(),
  getApp: (name?: string) => mockGetApp(name),
}));

jest.mock('firebase/auth', () => {
  class MockOAuthProvider {
    constructor(public readonly providerId: string) {}
    public credential(params: { readonly idToken: string }) {
      return mockOAuthCredential(params);
    }
  }
  class MockTwitterAuthProvider {
    public readonly providerId = 'twitter.com';
    public static credentialFromResult(result: unknown) {
      return mockTwitterCredentialFromResult(result);
    }
  }
  return {
    getAuth: () => mockGetAuth(),
    connectAuthEmulator: (...args: unknown[]) => mockConnectAuthEmulator(...args),
    onAuthStateChanged: (auth: unknown, cb: (user: typeof mockAuthInstance.currentUser) => void) =>
      mockOnAuthStateChanged(auth, cb),
    signInWithCredential: (...args: unknown[]) => mockSignInWithCredential(...args),
    signInWithPopup: (...args: unknown[]) => mockSignInWithPopup(...args),
    signOut: (...args: unknown[]) => mockSignOut(...args),
    OAuthProvider: MockOAuthProvider,
    TwitterAuthProvider: MockTwitterAuthProvider,
  };
});

function createUserFixture(): LoungeUser {
  return {
    uid: 'uid_user_001',
    xUserId: '1000000099',
    xHandle: '@member_0099',
    displayName: 'Member 0099',
    avatarUrl: 'assets/gemitec_icon.svg',
    status: 'ACTIVE',
    language: 'ja',
    timezone: 'Asia/Tokyo',
    onboardingCompleted: true,
    allowServiceImprovementAnalytics: true,
    countryCode: 'JP',
    isEeaResident: false,
    preferredCurrency: 'JPY',
    disclaimerConsent: {
      disclaimerVersion: 1,
      agreedToGeminiTrainingUsage: true,
      agreedToZeroPiiProhibition: true,
      agreedToOneWayMemoryIsolation: true,
      scrolledToBottomAt: '2026-11-24T00:00:00.000Z',
      consentedAt: '2026-11-24T00:00:05.000Z',
    },
    createdAt: '2026-11-24T00:00:00.000Z',
    updatedAt: '2026-11-24T00:00:05.000Z',
    lastLoginAt: '2026-11-24T00:00:05.000Z',
  };
}

function createSubFixture(): LoungeSubscription {
  return {
    uid: 'uid_user_001',
    tier: 'FREE',
    status: 'NONE',
    billingCurrency: 'JPY',
    dailyTurnQuota: 5,
    dailyRemainingTurns: 5,
    purchasedRemainingTurns: 20,
    remainingChatTurns: 25,
    earliestLotExpiresAt: '2027-05-23T00:00:00.000Z',
    lastDailyResetAt: '2026-11-24T00:00:00.000Z',
    lastQuotaResetTimezone: 'Asia/Tokyo',
    nextDailyResetAt: '2026-11-25T00:00:00.000Z',
    currentPeriodEnd: '2026-12-24T00:00:00.000Z',
    trialTicketUsed: false,
    cancelAtPeriodEnd: false,
    updatedAt: '2026-11-24T00:00:00.000Z',
  };
}

describe('Stripe URL Security, Auth Interceptor, Firebase Auth Service & HTTP BFF Adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetApps.mockReturnValue([]);
    mockAuthInstance.currentUser = null;
    mockAuthInstance.tenantId = null;
    window.sessionStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('enforces strict Stripe Checkout/Portal/Receipt origin allowlisting and local dev boundaries', () => {
    expect(isAllowedStripeRedirectUrl('https://checkout.stripe.com/c/pay/cs_test_123')).toBe(true);
    expect(isAllowedStripeRedirectUrl('https://billing.stripe.com/p/session/bps_123')).toBe(true);
    expect(isAllowedStripeRedirectUrl('https://pay.stripe.com/receipts/payment/ch_123')).toBe(true);

    // Attack & downgrade vectors
    expect(isAllowedStripeRedirectUrl('https://checkout.stripe.com.evil.example/pay')).toBe(false);
    expect(isAllowedStripeRedirectUrl('http://checkout.stripe.com/c/pay/cs_123')).toBe(false);
    expect(isAllowedStripeRedirectUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedStripeRedirectUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isAllowedStripeRedirectUrl('   ')).toBe(false);
    expect(isAllowedStripeRedirectUrl('not-a-valid-url')).toBe(false);

    // Local origin boundary outside production vs production
    expect(isAllowedStripeRedirectUrl('http://127.0.0.1:4300/?checkout=success', false)).toBe(false);
    expect(isAllowedStripeRedirectUrl('http://127.0.0.1:4300/?checkout=success', true)).toBe(true);
    expect(isAllowedStripeRedirectUrl('http://evil.example/checkout', true)).toBe(false);

    // Native globalThis.Origin path
    const originalOrigin = (globalThis as { Origin?: unknown }).Origin;
    try {
      (globalThis as { Origin?: unknown }).Origin = {
        from(value: string) {
          const u = new URL(value);
          return {
            opaque: u.origin === 'null',
            isSameOrigin(other: { readonly origin: string }) {
              return u.origin === other.origin;
            },
            origin: u.origin,
          };
        },
      };
      expect(isAllowedStripeRedirectUrl('https://checkout.stripe.com/c/pay/cs_ok')).toBe(true);
      expect(isAllowedStripeRedirectUrl('data:text/plain,hi')).toBe(false);
    } finally {
      if (originalOrigin === undefined) {
        delete (globalThis as { Origin?: unknown }).Origin;
      } else {
        (globalThis as { Origin?: unknown }).Origin = originalOrigin;
      }
    }
  });

  it('guards destination trust in loungeAuthInterceptor and injects Bearer tokens sync and async', async () => {
    expect(isTrustedLoungeApiDestination('/api/v1/lounge/account')).toBe(true);
    expect(isTrustedLoungeApiDestination('//evil.example/steal-token')).toBe(false);
    expect(isTrustedLoungeApiDestination(`${window.location.origin}/api/v1/lounge/config`)).toBe(
      true,
    );
    expect(isTrustedLoungeApiDestination('https://third-party.example/collect')).toBe(false);

    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withInterceptors([loungeAuthInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();

    const http = TestBed.inject(HttpClient);
    const httpTesting = TestBed.inject(HttpTestingController);
    const authService = TestBed.inject(LoungeAuthService);

    jest.spyOn(authService, 'getSyncToken').mockReturnValue('sync-jwt-token');
    const trustedPromise = firstValueFrom(http.get('/api/v1/lounge/account'));
    const trustedReq = httpTesting.expectOne('/api/v1/lounge/account');
    expect(trustedReq.request.headers.get('Authorization')).toBe('Bearer sync-jwt-token');
    trustedReq.flush({});
    await trustedPromise;

    const untrustedPromise = firstValueFrom(http.get('https://external.example/data'));
    const untrustedReq = httpTesting.expectOne('https://external.example/data');
    expect(untrustedReq.request.headers.has('Authorization')).toBe(false);
    untrustedReq.flush({});
    await untrustedPromise;

    jest.spyOn(authService, 'getSyncToken').mockReturnValue(null);
    authService.currentUserSignal.set({ uid: 'uid_async_001' } as never);
    jest.spyOn(authService, 'getToken').mockResolvedValue('async-jwt-token');
    const asyncPromise = firstValueFrom(http.get('/api/v1/lounge/billing/catalog'));
    await Promise.resolve();
    await Promise.resolve();
    const asyncReq = httpTesting.expectOne('/api/v1/lounge/billing/catalog');
    expect(asyncReq.request.headers.get('Authorization')).toBe('Bearer async-jwt-token');
    asyncReq.flush({});
    await asyncPromise;

    httpTesting.verify();
  });

  it('configures Firebase named app in LoungeAuthService across emulator and live popup flows', async () => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
    const authService = TestBed.inject(LoungeAuthService);

    await expect(authService.authenticateWithX()).rejects.toThrow(
      'Firebase Web configuration is missing',
    );
    await authService.waitForInit();
    await authService.signOutFirebase();

    window.history.replaceState({}, '', '/?emuXUser=x_e2e_user_42');
    expect(authService.resolveEmulatorXUserId()).toBe('x_e2e_user_42');
    window.history.replaceState({}, '', '/');
    expect(authService.resolveEmulatorXUserId()).toBe('x_e2e_user_42');

    authService.configure({
      production: false,
      useEmulators: true,
      firebase: {
        apiKey: 'fake-api-key',
        authDomain: 'localhost',
        projectId: 'rebecca-ai-gal-local',
        appId: '1:123:web:abc',
        tenantId: 'tenant-lounge',
      },
    });

    const emuCred = await authService.authenticateWithX();
    expect(emuCred).toEqual({
      idToken: 'emu-id-token',
      xOAuthCode: 'emu_x_oauth_x_e2e_user_42',
      uid: 'uid_emu_001',
    });
    expect(mockConnectAuthEmulator).toHaveBeenCalledWith(
      mockAuthInstance,
      'http://127.0.0.1:9099',
      { disableWarnings: true },
    );
    expect(mockAuthInstance.tenantId).toBe('tenant-lounge');
    expect(authService.getSyncToken()).toBe('emu-id-token');
    expect(await authService.getToken(false)).toBe('emu-id-token');
    expect(await authService.getToken(true)).toBe('emu-id-token');

    await authService.signOutFirebase();
    expect(mockSignOut).toHaveBeenCalled();

    // Switch to live popup branch on fresh instance
    const liveService = new LoungeAuthService();
    mockGetApps.mockReturnValue([{ name: 'gemitec-private-lounge' }]);
    liveService.configure({
      production: true,
      useEmulators: false,
      firebase: {
        apiKey: 'live-cfg-key',
        authDomain: 'example.com',
        projectId: 'proj',
        appId: '1:1:web:1',
      },
    });
    const liveCred = await liveService.authenticateWithX();
    expect(liveCred).toEqual({
      idToken: 'live-id-token',
      xOAuthCode: 'twitter-oauth-access-token',
      uid: 'uid_live_001',
    });
    expect(mockSignInWithPopup).toHaveBeenCalled();
  });

  it('executes real HttpClient requests and maps backend errors in LoungeBffAdapter', async () => {
    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withInterceptors([loungeAuthInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();

    const adapter = TestBed.inject(LoungeBffAdapter);
    const httpTesting = TestBed.inject(HttpTestingController);
    const authService = TestBed.inject(LoungeAuthService);

    // 1. Config endpoint
    const configPromise = adapter.getRuntimeConfig();
    const configReq = httpTesting.expectOne('/api/v1/lounge/config');
    const mockRuntime: LoungeRuntimeConfigDto = {
      appVersion: '1.45.2',
      disclaimerVersion: 2,
      persona: {
        displayName: 'レベッカ',
        englishName: 'Rebecca',
        brandName: 'Gemitec',
        avatarPath: 'assets/avatar.png',
        chatIconPath: 'assets/chat.png',
        emotionAvatarPaths: {
          NEUTRAL: 'assets/n.png',
          HAPPY: 'assets/h.png',
          TEASING: 'assets/t.png',
          SHY: 'assets/s.png',
          EXCITED: 'assets/e.png',
          THOUGHTFUL: 'assets/th.png',
          SURPRISED: 'assets/su.png',
        },
      },
      firebase: {
        apiKey: 'fake-key',
        authDomain: 'localhost',
        projectId: 'rebecca-ai-gal-local',
        appId: '1:1:web:1',
      },
      useEmulators: true,
      production: false,
      phase2EeaEnabled: false,
    };
    configReq.flush(mockRuntime);
    const loadedConfig = await configPromise;
    expect(loadedConfig.disclaimerVersion).toBe(2);
    expect(loadedConfig.useEmulators).toBe(true);

    // 2. getCurrentSession without token returns null immediately
    jest.spyOn(authService, 'waitForInit').mockResolvedValue(undefined);
    jest.spyOn(authService, 'getToken').mockResolvedValueOnce(null);
    expect(await adapter.getCurrentSession()).toBeNull();

    // 3. getCurrentSession with token returning 404 signs out cleanly
    const signOutSpy = jest.spyOn(authService, 'signOutFirebase').mockResolvedValue(undefined);
    jest.spyOn(authService, 'getToken').mockResolvedValueOnce('stale-token');
    const silentSessionPromise = adapter.getCurrentSession();
    await Promise.resolve();
    await Promise.resolve();
    const silentLoginReq = httpTesting.expectOne('/api/v1/lounge/auth/login');
    silentLoginReq.flush(
      { error: 'Account not found', code: 'ACCOUNT_NOT_FOUND' },
      { status: 404, statusText: 'Not Found' },
    );
    expect(await silentSessionPromise).toBeNull();
    expect(signOutSpy).toHaveBeenCalled();

    // 4. Explicit signUpWithX and loginWithX + 409 cleanup
    jest.spyOn(authService, 'authenticateWithX').mockResolvedValue({
      idToken: 'real-x-id-token',
      xOAuthCode: 'real-x-code',
      uid: 'uid_user_001',
    });
    const mockUser = createUserFixture();
    const signUpPromise = adapter.signUpWithX({
      idToken: 'x-session-id-token',
      xOAuthCode: 'x-oauth-authorization-code',
      language: 'ja',
      timezone: 'Asia/Tokyo',
      disclaimerConsent: mockUser.disclaimerConsent,
    });
    await Promise.resolve();
    const signUpReq = httpTesting.expectOne('/api/v1/lounge/auth/signup');
    expect(signUpReq.request.body.idToken).toBe('real-x-id-token');
    signUpReq.flush({ user: mockUser, appVersion: '1.45.2', issuedAt: mockUser.createdAt });
    const session = await signUpPromise;
    expect(session.user.uid).toBe('uid_user_001');

    // Duplicate signUp maps 409 and signs out Firebase cleanly
    const dupPromise = adapter.signUpWithX({
      idToken: 'x-session-id-token',
      xOAuthCode: 'x-oauth-authorization-code',
      disclaimerConsent: mockUser.disclaimerConsent,
    });
    await Promise.resolve();
    const dupReq = httpTesting.expectOne('/api/v1/lounge/auth/signup');
    dupReq.flush({ error: 'Duplicate account' }, { status: 409, statusText: 'Conflict' });
    await expect(dupPromise).rejects.toBeInstanceOf(LoungeClientApiError);

    // 5. All Billing HTTP routes + Session re-consent mapping
    const catalogPromise = adapter.getCatalog();
    const catalogReq = httpTesting.expectOne('/api/v1/lounge/billing/catalog');
    const mockCatalog: LoungeBillingCatalogDto = {
      currency: 'JPY',
      currencyLocked: true,
      countryCode: 'JP',
      isEeaResident: false,
      phase2EeaEnabled: false,
      trialEligible: true,
      subscriptionStatus: 'NONE',
      products: [],
    };
    catalogReq.flush(mockCatalog);
    expect((await catalogPromise).currency).toBe('JPY');

    const checkoutPromise = adapter.createCheckout({
      productId: 'TRIAL_TICKET_100',
      acceptedPurchaseDisclosure: true,
      acceptedAutoRenewalOptIn: true,
      confirmedAdultOrParentalConsent: true,
    });
    const checkoutReq = httpTesting.expectOne('/api/v1/lounge/billing/checkout');
    const checkoutRes: LoungeCreateCheckoutResponseDto = {
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1',
      sessionIdMasked: 'cs_tes...st_1',
    };
    checkoutReq.flush(checkoutRes);
    expect((await checkoutPromise).sessionIdMasked).toBe('cs_tes...st_1');

    const verifyPromise = adapter.verifyCheckout({ sessionId: 'cs_test_1' });
    const verifyReq = httpTesting.expectOne('/api/v1/lounge/billing/checkout/verify');
    const verifyRes: LoungeVerifyCheckoutResponseDto = {
      subscription: createSubFixture(),
      verified: true,
    };
    verifyReq.flush(verifyRes);
    expect((await verifyPromise).verified).toBe(true);

    const portalPromise = adapter.createPortal({ flow: 'payment_method_update' });
    const portalReq = httpTesting.expectOne('/api/v1/lounge/billing/portal');
    const portalRes: LoungeCreatePortalResponseDto = {
      portalUrl: 'https://billing.stripe.com/p/session/bps_1',
    };
    portalReq.flush(portalRes);
    expect((await portalPromise).portalUrl).toContain('billing.stripe.com');

    const subDetailPromise = adapter.getSubscriptionDetail({ portalReturn: true });
    const subDetailReq = httpTesting.expectOne('/api/v1/lounge/billing/subscription?portalReturn=1');
    const subDetailRes: LoungeSubscriptionDetailResponseDto = {
      subscription: createSubFixture(),
      quotaBreakdown: {
        dailyTurnQuota: 5,
        dailyRemainingTurns: 5,
        purchasedRemainingTurns: 20,
        remainingChatTurns: 25,
        activeLots: [],
        nextDailyResetAt: '2026-11-25T00:00:00.000Z',
        consumptionOrder: ['DAILY', 'LOT_FIFO'],
      },
    };
    subDetailReq.flush(subDetailRes);
    expect((await subDetailPromise).quotaBreakdown.remainingChatTurns).toBe(25);

    const ordersPromise = adapter.listOrders({ limit: 20, startingAfter: 'ch_001' });
    const ordersReq = httpTesting.expectOne(
      '/api/v1/lounge/billing/orders?limit=20&startingAfter=ch_001',
    );
    const ordersRes: LoungeBillingOrdersResponseDto = { orders: [], nextCursor: null, hasMore: false };
    ordersReq.flush(ordersRes);
    expect((await ordersPromise).orders).toEqual([]);

    const receiptPromise = adapter.getOrderReceipt('ch_001');
    const receiptReq = httpTesting.expectOne('/api/v1/lounge/billing/orders/ch_001/receipt');
    const receiptRes: LoungeBillingReceiptResponseDto = {
      receiptUrl: 'https://pay.stripe.com/receipts/ch_001',
    };
    receiptReq.flush(receiptRes);
    expect((await receiptPromise).receiptUrl).toContain('pay.stripe.com');

    const withdrawPromise = adapter.withdrawEu({
      targetType: 'SUBSCRIPTION',
      targetId: 'uid_user_001',
      confirmedWithdrawal: true,
    });
    const withdrawReq = httpTesting.expectOne('/api/v1/lounge/billing/eu-withdrawal');
    const withdrawRes: LoungeEuWithdrawalResponseDto = {
      withdrawnAt: '2026-11-24T01:00:00.000Z',
      refundedAmountMinor: 500,
      currency: 'JPY',
      revokedTurns: 100,
      receiptEmailDispatched: true,
      subscription: createSubFixture(),
    };
    withdrawReq.flush(withdrawRes);
    expect((await withdrawPromise).revokedTurns).toBe(100);

    // 6. Send message mapping reconsent error cleanly
    const sendPromise = adapter.sendMessage({ content: 'hello' });
    const sendReq = httpTesting.expectOne('/api/v1/lounge/session/messages');
    sendReq.flush(
      {
        error: 'Updated consent needed',
        code: LOUNGE_ERROR_CODE_DISCLAIMER_RECONSENT_REQUIRED,
        requiredDisclaimerVersion: 3,
        acceptedDisclaimerVersion: 1,
      },
      { status: 403, statusText: 'Forbidden' },
    );
    await expect(sendPromise).rejects.toBeInstanceOf(LoungeReconsentRequiredClientError);

    // 7. Account delete propagates 502 STRIPE_CANCELLATION_FAILED without signing out Firebase
    signOutSpy.mockClear();
    const delPromise = adapter.deleteAccount({
      confirmedIrreversibleDeletion: true,
      confirmedNoRefundForRemainingTurns: true,
    });
    const delReq = httpTesting.expectOne('/api/v1/lounge/account');
    delReq.flush(
      { error: 'Internal server error', code: 'STRIPE_CANCELLATION_FAILED' },
      { status: 502, statusText: 'Bad Gateway' },
    );
    await expect(delPromise).rejects.toMatchObject({ code: 'STRIPE_CANCELLATION_FAILED' });
    expect(signOutSpy).not.toHaveBeenCalled();

    // 8. Remaining Account, Session, Gallery, Auth HTTP success & error branches
    const loginPromise = adapter.loginWithX({ idToken: 'provided-tok' });
    httpTesting.expectOne('/api/v1/lounge/auth/login').flush({
      user: mockUser,
      appVersion: '1.45.2',
      issuedAt: mockUser.lastLoginAt,
    });
    expect((await loginPromise).user.uid).toBe('uid_user_001');

    const accPromise = adapter.getAccountSummary();
    httpTesting.expectOne('/api/v1/lounge/account').flush({
      user: mockUser,
      subscription: createSubFixture(),
      unlockedGalleryCount: 1,
      totalGalleryCount: 1,
      appVersion: '1.45.2',
    });
    expect((await accPromise).appVersion).toBe('1.45.2');

    const prefPromise = adapter.updatePreferences({
      language: 'en',
      timezone: 'UTC',
      completeOnboarding: true,
      allowServiceImprovementAnalytics: false,
    });
    httpTesting.expectOne('/api/v1/lounge/account/preferences').flush({
      ...mockUser,
      language: 'en',
      allowServiceImprovementAnalytics: false,
    });
    expect((await prefPromise).allowServiceImprovementAnalytics).toBe(false);

    const consentPromise = adapter.updateDisclaimerConsent({
      disclaimerConsent: { ...mockUser.disclaimerConsent, disclaimerVersion: 2 },
    });
    httpTesting.expectOne('/api/v1/lounge/account/consent').flush({
      ...mockUser,
      disclaimerConsent: { ...mockUser.disclaimerConsent, disclaimerVersion: 2 },
    });
    expect((await consentPromise).disclaimerConsent.disclaimerVersion).toBe(2);

    const sessPromise = adapter.getSession();
    httpTesting.expectOne('/api/v1/lounge/session').flush({
      id: 'uid_user_001',
      uid: 'uid_user_001',
      title: 'Private Lounge',
      messageCount: 0,
      currentEmotion: 'NEUTRAL',
      createdAt: mockUser.createdAt,
      updatedAt: mockUser.updatedAt,
    });
    expect((await sessPromise).id).toBe('uid_user_001');

    const msgListPromise = adapter.listMessages({ page: 1, limit: 20, cursor: 'm0' });
    httpTesting
      .expectOne('/api/v1/lounge/session/messages?page=1&limit=20&cursor=m0')
      .flush({ data: [], meta: { currentPage: 1, limit: 20, totalItems: 0, totalPages: 1, nextCursor: null, hasMore: false } });
    expect((await msgListPromise).data).toEqual([]);

    const galListPromise = adapter.listGallery({ page: 2, limit: 12, cursor: 'g1' });
    httpTesting
      .expectOne('/api/v1/lounge/gallery?page=2&limit=12&cursor=g1')
      .flush({
        data: [],
        meta: { currentPage: 2, limit: 12, totalItems: 0, totalPages: 1, nextCursor: null, hasMore: false },
        summary: { unlockedCount: 0, totalCount: 0 },
      });
    expect((await galListPromise).meta.currentPage).toBe(2);

    const logoutPromise = adapter.logout();
    httpTesting.expectOne('/api/v1/lounge/auth/logout').flush(null);
    await logoutPromise;

    const delOkPromise = adapter.deleteAccount({
      confirmedIrreversibleDeletion: true,
      confirmedNoRefundForRemainingTurns: true,
    });
    httpTesting.expectOne('/api/v1/lounge/account').flush(null);
    await delOkPromise;
    expect(signOutSpy).toHaveBeenCalled();

    // Error propagation checks across HTTP billing endpoints
    const catErrPromise = adapter.getCatalog();
    httpTesting
      .expectOne('/api/v1/lounge/billing/catalog')
      .flush('Server Error', { status: 500, statusText: 'Error' });
    await expect(catErrPromise).rejects.toBeInstanceOf(LoungeClientApiError);

    const chkErrPromise = adapter.createCheckout({
      productId: 'CHARGE_TICKET_100',
      acceptedPurchaseDisclosure: true,
      acceptedAutoRenewalOptIn: true,
      confirmedAdultOrParentalConsent: true,
    });
    httpTesting
      .expectOne('/api/v1/lounge/billing/checkout')
      .flush({ error: 'Blocked', code: 'DISPUTE_BLOCKED' }, { status: 403, statusText: 'Forbidden' });
    await expect(chkErrPromise).rejects.toMatchObject({ code: 'DISPUTE_BLOCKED' });

    const verErrPromise = adapter.verifyCheckout({ sessionId: 'cs_err' });
    httpTesting
      .expectOne('/api/v1/lounge/billing/checkout/verify')
      .flush({ error: 'Not found' }, { status: 404, statusText: 'Not Found' });
    await expect(verErrPromise).rejects.toBeInstanceOf(LoungeClientApiError);

    const porErrPromise = adapter.createPortal({ flow: 'default' });
    httpTesting
      .expectOne('/api/v1/lounge/billing/portal')
      .flush({ error: 'No customer' }, { status: 404, statusText: 'Not Found' });
    await expect(porErrPromise).rejects.toBeInstanceOf(LoungeClientApiError);

    const subErrPromise = adapter.getSubscriptionDetail();
    httpTesting
      .expectOne('/api/v1/lounge/billing/subscription')
      .flush({ error: 'Fail' }, { status: 500, statusText: 'Error' });
    await expect(subErrPromise).rejects.toBeInstanceOf(LoungeClientApiError);

    const ordErrPromise = adapter.listOrders();
    httpTesting
      .expectOne('/api/v1/lounge/billing/orders')
      .flush({ error: 'Fail' }, { status: 500, statusText: 'Error' });
    await expect(ordErrPromise).rejects.toBeInstanceOf(LoungeClientApiError);

    const recErrPromise = adapter.getOrderReceipt('ch_x');
    httpTesting
      .expectOne('/api/v1/lounge/billing/orders/ch_x/receipt')
      .flush({ error: 'Not found' }, { status: 404, statusText: 'Not Found' });
    await expect(recErrPromise).rejects.toBeInstanceOf(LoungeClientApiError);

    const wdrErrPromise = adapter.withdrawEu({
      targetType: 'CREDIT_LOT',
      targetId: 'lot_1',
      confirmedWithdrawal: true,
    });
    httpTesting
      .expectOne('/api/v1/lounge/billing/eu-withdrawal')
      .flush({ error: 'Conflict' }, { status: 409, statusText: 'Conflict' });
    await expect(wdrErrPromise).rejects.toBeInstanceOf(LoungeClientApiError);

    const accErrPromise = adapter.getAccountSummary();
    httpTesting
      .expectOne('/api/v1/lounge/account')
      .flush({ error: 'Server err' }, { status: 500, statusText: 'Error' });
    await expect(accErrPromise).rejects.toBeInstanceOf(LoungeClientApiError);

    const prefErrPromise = adapter.updatePreferences({ language: 'en' });
    httpTesting
      .expectOne('/api/v1/lounge/account/preferences')
      .flush({ error: 'Bad' }, { status: 400, statusText: 'Bad Request' });
    await expect(prefErrPromise).rejects.toBeInstanceOf(LoungeClientApiError);

    const conErrPromise = adapter.updateDisclaimerConsent({
      disclaimerConsent: { ...mockUser.disclaimerConsent, disclaimerVersion: 2 },
    });
    httpTesting
      .expectOne('/api/v1/lounge/account/consent')
      .flush({ error: 'Bad' }, { status: 400, statusText: 'Bad Request' });
    await expect(conErrPromise).rejects.toBeInstanceOf(LoungeClientApiError);

    const sesErrPromise = adapter.getSession();
    httpTesting
      .expectOne('/api/v1/lounge/session')
      .flush({ error: 'Missing' }, { status: 404, statusText: 'Not Found' });
    await expect(sesErrPromise).rejects.toBeInstanceOf(LoungeClientApiError);

    const msgErrPromise = adapter.listMessages();
    httpTesting
      .expectOne('/api/v1/lounge/session/messages')
      .flush({ error: 'Err' }, { status: 500, statusText: 'Error' });
    await expect(msgErrPromise).rejects.toBeInstanceOf(LoungeClientApiError);

    const galErrPromise = adapter.listGallery();
    httpTesting
      .expectOne('/api/v1/lounge/gallery')
      .flush({ error: 'Err' }, { status: 500, statusText: 'Error' });
    await expect(galErrPromise).rejects.toBeInstanceOf(LoungeClientApiError);

    httpTesting.verify();
  });

  it('activates preview fixture mode exclusively when ?previewScenario= is set', async () => {
    window.history.replaceState({}, '', '/?previewScenario=billing');
    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    }).compileComponents();

    const adapter = TestBed.inject(LoungeBffAdapter);
    const session = await adapter.getCurrentSession();
    expect(session?.user.uid).toBe('uid_preview_001');

    const catalog = await adapter.getCatalog();
    expect(catalog.products).toHaveLength(3);
    const checkout = await adapter.createCheckout({
      productId: 'TRIAL_TICKET_100',
      acceptedPurchaseDisclosure: true,
      acceptedAutoRenewalOptIn: true,
      confirmedAdultOrParentalConsent: true,
    });
    expect(checkout.checkoutUrl).toContain('checkout=success');
    const verified = await adapter.verifyCheckout({ sessionId: 'cs_preview_1' });
    expect(verified.subscription.remainingChatTurns).toBe(125);
    const portal = await adapter.createPortal({ flow: 'default' });
    expect(portal.portalUrl).toContain('portal_return=1');
    const detail = await adapter.getSubscriptionDetail({ portalReturn: true });
    expect(detail.quotaBreakdown.remainingChatTurns).toBe(125);
    const withdraw = await adapter.withdrawEu({
      targetType: 'CREDIT_LOT',
      targetId: 'lot_1',
      confirmedWithdrawal: true,
    });
    expect(withdraw.receiptEmailDispatched).toBe(true);
    const orders = await adapter.listOrders();
    expect(orders.orders.length).toBe(1);
    const receipt = await adapter.getOrderReceipt('ch_preview_001');
    expect(receipt.receiptUrl).toContain('pay.stripe.com');

    await adapter.updatePreferences({ allowServiceImprovementAnalytics: false });
    await adapter.updatePreferences({ completeOnboarding: true, language: 'en', timezone: 'UTC' });
    const afterVerifyCatalog = await adapter.getCatalog();
    expect(afterVerifyCatalog.trialEligible).toBe(false);
    expect((await adapter.getAccountSummary()).user.allowServiceImprovementAnalytics).toBe(false);
    await adapter.deleteAccount({
      confirmedIrreversibleDeletion: true,
      confirmedNoRefundForRemainingTurns: true,
    });
  });

  it('handles LoungeAuthService token refresh failures and missing emulator params cleanly', async () => {
    const svc = new LoungeAuthService();
    expect(svc.getSyncToken()).toBeNull();
    expect(await svc.getToken(false)).toBeNull();
    window.history.replaceState({}, '', '/?emuXUser=invalid!@');
    expect(svc.resolveEmulatorXUserId()).toBe('1000000099');

    svc.configure({
      production: false,
      useEmulators: true,
      firebase: {
        apiKey: 'k',
        authDomain: 'localhost',
        projectId: 'p',
        appId: 'a',
      },
    });
    await svc.waitForInit();
    mockAuthInstance.currentUser = {
      uid: 'uid_err',
      getIdToken: jest.fn(async () => {
        throw new Error('token fetch failed');
      }),
    };
    svc.currentUserSignal.set(mockAuthInstance.currentUser as never);
    expect(await svc.getToken(true)).toBeNull();
  });
});
