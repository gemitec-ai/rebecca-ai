import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type {
  LoungeAccountSummaryDto,
  LoungeBillingCatalogDto,
  LoungeBillingOrdersResponseDto,
  LoungeBillingReceiptResponseDto,
  LoungeCreateCheckoutResponseDto,
  LoungeCreatePortalResponseDto,
  LoungeEuWithdrawalResponseDto,
  LoungeRuntimeConfigDto,
  LoungeSubscription,
  LoungeSubscriptionDetailResponseDto,
  LoungeUser,
  LoungeVerifyCheckoutResponseDto,
} from '@rebecca/types';
import {
  LoungeClientApiError,
  LoungeReconsentRequiredClientError,
} from '../../core/errors/lounge-client.errors';
import { HttpLoungeAccountAdapter } from './http-lounge-account.adapter';
import { HttpLoungeAuthAdapter } from './http-lounge-auth.adapter';
import { HttpLoungeBillingAdapter } from './http-lounge-billing.adapter';
import { HttpLoungeConfigAdapter } from './http-lounge-config.adapter';
import { HttpLoungeGalleryAdapter } from './http-lounge-gallery.adapter';
import { HttpLoungeSessionAdapter } from './http-lounge-session.adapter';
import { LoungeHttpClientHelper } from './lounge-http-client.helpers';

describe('Thin HTTP Lounge Port Adapters', () => {
  let configAdapter: HttpLoungeConfigAdapter;
  let authAdapter: HttpLoungeAuthAdapter;
  let accountAdapter: HttpLoungeAccountAdapter;
  let billingAdapter: HttpLoungeBillingAdapter;
  let sessionAdapter: HttpLoungeSessionAdapter;
  let galleryAdapter: HttpLoungeGalleryAdapter;
  let httpHelper: LoungeHttpClientHelper;
  let httpTesting: HttpTestingController;

  const validConfig: LoungeRuntimeConfigDto = {
    appVersion: 'v1.46.0',
    disclaimerVersion: 2,
    production: false,
    useEmulators: true,
    phase2EeaEnabled: false,
    billingEnabled: false,
    contactEmail: 'support [at mark] example.com',
    legalUrls: {
      tosUrl: 'https://portal.example.com/tos',
      privacyUrl: 'https://portal.example.com/privacy',
      legalUrl: 'https://portal.example.com/legal',
    },
    firebase: {
      apiKey: 'demo-key',
      authDomain: 'localhost',
      projectId: 'demo-project',
      appId: '1:1:web:demo',
    },
    persona: {
      displayName: 'レベッカ',
      englishName: 'Rebecca',
      brandName: 'Rebecca Private Lounge',
      avatarPath: 'assets/persona_cutout.webp',
      chatIconPath: 'assets/avatars/persona_icon.png',
      emotionAvatarPaths: {
        NEUTRAL: 'assets/avatars/persona_neutral.png',
        HAPPY: 'assets/avatars/persona_happy.png',
        TEASING: 'assets/avatars/persona_teasing.png',
        SHY: 'assets/avatars/persona_shy.png',
        EXCITED: 'assets/avatars/persona_excited.png',
        THOUGHTFUL: 'assets/avatars/persona_thoughtful.png',
        SURPRISED: 'assets/avatars/persona_surprised.png',
      },
    },
  };

  const sampleSub: LoungeSubscription = {
    uid: 'uid_http_1',
    tier: 'STANDARD',
    status: 'ACTIVE',
    billingCurrency: 'JPY',
    dailyTurnQuota: 100,
    dailyRemainingTurns: 99,
    purchasedRemainingTurns: 0,
    remainingChatTurns: 99,
    earliestLotExpiresAt: null,
    lastDailyResetAt: '2026-11-24T00:00:00.000Z',
    lastQuotaResetTimezone: 'Asia/Tokyo',
    nextDailyResetAt: '2026-11-25T00:00:00.000Z',
    currentPeriodEnd: '2026-12-24T00:00:00.000Z',
    trialTicketUsed: false,
    cancelAtPeriodEnd: false,
    updatedAt: '2026-11-24T00:00:00.000Z',
  };

  const sampleUser: LoungeUser = {
    uid: 'uid_http_1',
    xUserId: '1000000100',
    xHandle: '@sample_member',
    displayName: 'Sample Member',
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
      disclaimerVersion: 2,
      agreedToGeminiTrainingUsage: true,
      agreedToZeroPiiProhibition: true,
      agreedToOneWayMemoryIsolation: true,
      agreedToNonEeaEligibility: true,
      scrolledToBottomAt: '2026-11-24T00:00:00.000Z',
      consentedAt: '2026-11-24T00:00:01.000Z',
    },
    createdAt: '2026-11-24T00:00:00.000Z',
    updatedAt: '2026-11-24T00:00:01.000Z',
    lastLoginAt: '2026-11-24T00:00:01.000Z',
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    }).compileComponents();

    configAdapter = TestBed.inject(HttpLoungeConfigAdapter);
    authAdapter = TestBed.inject(HttpLoungeAuthAdapter);
    accountAdapter = TestBed.inject(HttpLoungeAccountAdapter);
    billingAdapter = TestBed.inject(HttpLoungeBillingAdapter);
    sessionAdapter = TestBed.inject(HttpLoungeSessionAdapter);
    galleryAdapter = TestBed.inject(HttpLoungeGalleryAdapter);
    httpHelper = TestBed.inject(LoungeHttpClientHelper);
    httpTesting = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpTesting.verify();
    TestBed.resetTestingModule();
  });

  it('loads and validates /config strictly without silent fallback fixtures', async () => {
    const okPromise = configAdapter.getRuntimeConfig();
    httpTesting.expectOne('/api/v1/lounge/config').flush(validConfig);
    const loaded = await okPromise;
    expect(loaded.persona.brandName).toBe('Rebecca Private Lounge');
    expect(loaded.legalUrls?.tosUrl).toBe('https://portal.example.com/tos');
    expect(loaded.billingEnabled).toBe(false);
    expect(loaded.contactEmail).toBe('support [at mark] example.com');

    const optionalFieldsRejectedPromise = configAdapter.getRuntimeConfig();
    httpTesting.expectOne('/api/v1/lounge/config').flush({
      appVersion: 'v1.46.1',
      disclaimerVersion: 2,
      persona: validConfig.persona,
      legalUrls: { tosUrl: 'javascript:alert(1)', privacyUrl: 'not-a-url', legalUrl: 123 },
      firebase: { apiKey: '', authDomain: 'localhost', projectId: 'demo', appId: 'app' },
    });
    const stripped = await optionalFieldsRejectedPromise;
    expect(stripped.legalUrls).toBeUndefined();
    expect(stripped.firebase).toBeUndefined();

    const badEmotionPromise = configAdapter.getRuntimeConfig();
    httpTesting.expectOne('/api/v1/lounge/config').flush({
      appVersion: 'v1.46.1',
      disclaimerVersion: 2,
      persona: {
        ...validConfig.persona,
        emotionAvatarPaths: { NEUTRAL: 'ok.png' },
      },
    });
    await expect(badEmotionPromise).rejects.toThrow(/Invalid runtime configuration/i);

    const errPromise = configAdapter.getRuntimeConfig();
    httpTesting
      .expectOne('/api/v1/lounge/config')
      .flush(
        { error: 'Backend down', code: 'UPSTREAM_UNAVAILABLE' },
        { status: 503, statusText: 'Service Unavailable' },
      );
    await expect(errPromise).rejects.toMatchObject({
      statusCode: 503,
      message: 'Backend down',
      code: 'UPSTREAM_UNAVAILABLE',
    });

    const invalidPromise = configAdapter.getRuntimeConfig();
    httpTesting.expectOne('/api/v1/lounge/config').flush({ appVersion: '', disclaimerVersion: 0 });
    await expect(invalidPromise).rejects.toThrow(/Invalid runtime configuration/i);
  });

  it('sends thin auth, account, billing, session, and gallery HTTP requests and maps typed errors', async () => {
    const cfgPromise = configAdapter.getRuntimeConfig();
    httpTesting.expectOne('/api/v1/lounge/config').flush(validConfig);
    await cfgPromise;

    const currentSessionPromise = authAdapter.getCurrentSession();
    httpTesting.expectOne('/api/v1/lounge/auth/login').flush({
      user: sampleUser,
      appVersion: 'v1.46.0',
      issuedAt: '2026-11-24T00:00:01.000Z',
    });
    expect((await currentSessionPromise)?.user.uid).toBe('uid_http_1');

    const loginPromise = authAdapter.loginWithX({
      idToken: 'provided-login-token',
      xOAuthCode: 'x_code_2',
    });
    const reqExplicitLogin = httpTesting.expectOne('/api/v1/lounge/auth/login');
    expect(reqExplicitLogin.request.body).toEqual({
      idToken: 'provided-login-token',
      xOAuthCode: 'x_code_2',
    });
    reqExplicitLogin.flush({
      user: sampleUser,
      appVersion: 'v1.46.0',
      issuedAt: '2026-11-24T00:00:01.000Z',
    });
    expect((await loginPromise).user.uid).toBe('uid_http_1');

    const signUpPromise = authAdapter.signUpWithX({
      idToken: 'provided-token',
      disclaimerConsent: sampleUser.disclaimerConsent,
    });
    const reqSignUp = httpTesting.expectOne('/api/v1/lounge/auth/signup');
    expect(reqSignUp.request.body).not.toHaveProperty('xOAuthCode');
    reqSignUp.flush({
      user: sampleUser,
      appVersion: 'v1.46.0',
      issuedAt: '2026-11-24T00:00:01.000Z',
    });
    expect((await signUpPromise).user.uid).toBe('uid_http_1');

    const logoutPromise = authAdapter.logout();
    httpTesting.expectOne('/api/v1/lounge/auth/logout').flush({});
    await logoutPromise;

    const summaryPayload: LoungeAccountSummaryDto = {
      user: sampleUser,
      subscription: sampleSub,
      persona: validConfig.persona,
      unlockedGalleryCount: 1,
      totalGalleryCount: 1,
      appVersion: 'v1.46.0',
    };
    const sumPromise = accountAdapter.getAccountSummary();
    httpTesting.expectOne('/api/v1/lounge/account').flush(summaryPayload);
    expect((await sumPromise).user.xHandle).toBe('@sample_member');

    const prefPromise = accountAdapter.updatePreferences({ language: 'en' });
    httpTesting.expectOne('/api/v1/lounge/account/preferences').flush({
      ...sampleUser,
      language: 'en',
    });
    expect((await prefPromise).language).toBe('en');

    const prefErrPromise = accountAdapter.updatePreferences({ language: 'en' });
    httpTesting.expectOne('/api/v1/lounge/account/preferences').flush({}, { status: 500, statusText: 'Error' });
    await expect(prefErrPromise).rejects.toMatchObject({
      statusCode: 500,
      message: 'HTTP 500',
    });

    const consentPromise = accountAdapter.updateDisclaimerConsent({
      disclaimerConsent: sampleUser.disclaimerConsent,
    });
    httpTesting.expectOne('/api/v1/lounge/account/consent').flush(sampleUser);
    expect((await consentPromise).uid).toBe('uid_http_1');

    const delPromise = accountAdapter.deleteAccount({
      confirmedIrreversibleDeletion: true,
      confirmedNoRefundForRemainingTurns: true,
    });
    httpTesting.expectOne({ method: 'DELETE', url: '/api/v1/lounge/account' }).flush(null);
    await delPromise;

    const catalogPromise = billingAdapter.getCatalog();
    httpTesting.expectOne('/api/v1/lounge/billing/catalog').flush({} as LoungeBillingCatalogDto);
    await catalogPromise;

    const checkoutPromise = billingAdapter.createCheckout({
      productId: 'CHARGE_TICKET_100',
      acceptedPurchaseDisclosure: true,
      acceptedAutoRenewalOptIn: true,
      confirmedAdultOrParentalConsent: true,
    });
    httpTesting
      .expectOne('/api/v1/lounge/billing/checkout')
      .flush({
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_1',
        sessionIdMasked: 'cs_...1',
      } satisfies LoungeCreateCheckoutResponseDto);
    await checkoutPromise;

    const verifyPromise = billingAdapter.verifyCheckout({ sessionId: 'cs_1' });
    httpTesting
      .expectOne('/api/v1/lounge/billing/checkout/verify')
      .flush({ subscription: sampleSub, verified: true } satisfies LoungeVerifyCheckoutResponseDto);
    await verifyPromise;

    const portalPromise = billingAdapter.createPortal({ flow: 'default' });
    httpTesting
      .expectOne('/api/v1/lounge/billing/portal')
      .flush({ portalUrl: 'https://billing.stripe.com/p/1' } satisfies LoungeCreatePortalResponseDto);
    await portalPromise;

    const subDetailPromise = billingAdapter.getSubscriptionDetail({ portalReturn: true });
    httpTesting
      .expectOne('/api/v1/lounge/billing/subscription?portalReturn=1')
      .flush({} as LoungeSubscriptionDetailResponseDto);
    await subDetailPromise;

    const subPlainPromise = billingAdapter.getSubscriptionDetail();
    httpTesting
      .expectOne('/api/v1/lounge/billing/subscription')
      .flush({} as LoungeSubscriptionDetailResponseDto);
    await subPlainPromise;

    const withdrawPromise = billingAdapter.withdrawEu({
      targetType: 'SUBSCRIPTION',
      targetId: 'ACTIVE_SUBSCRIPTION',
      confirmedWithdrawal: true,
    });
    httpTesting
      .expectOne('/api/v1/lounge/billing/eu-withdrawal')
      .flush({} as LoungeEuWithdrawalResponseDto);
    await withdrawPromise;

    const ordersPromise = billingAdapter.listOrders({ limit: 10, startingAfter: 'ch_1' });
    httpTesting
      .expectOne('/api/v1/lounge/billing/orders?limit=10&startingAfter=ch_1')
      .flush({ orders: [], hasMore: false, nextCursor: null } satisfies LoungeBillingOrdersResponseDto);
    await ordersPromise;

    const receiptPromise = billingAdapter.getOrderReceipt('ch_1');
    httpTesting
      .expectOne('/api/v1/lounge/billing/orders/ch_1/receipt')
      .flush({ receiptUrl: 'https://pay.stripe.com/receipts/ch_1' } satisfies LoungeBillingReceiptResponseDto);
    await receiptPromise;

    const sesPromise = sessionAdapter.getSession();
    httpTesting.expectOne('/api/v1/lounge/session').flush({ id: 'uid_http_1' });
    await sesPromise;

    const msgListPromise = sessionAdapter.listMessages({ page: 1, limit: 20, cursor: 'msg_1' });
    httpTesting.expectOne('/api/v1/lounge/session/messages?page=1&limit=20&cursor=msg_1').flush({
      data: [],
      meta: { currentPage: 1, limit: 20, totalItems: 0, totalPages: 1, nextCursor: null, hasMore: false },
    });
    await msgListPromise;

    const reconsentErrPromise = sessionAdapter.sendMessage({ content: 'hello' });
    httpTesting.expectOne('/api/v1/lounge/session/messages').flush(
      {
        error: 'Reconsent needed',
        code: 'DISCLAIMER_RECONSENT_REQUIRED',
        requiredDisclaimerVersion: 3,
        acceptedDisclaimerVersion: 1,
      },
      { status: 428, statusText: 'Precondition Required' },
    );
    await expect(reconsentErrPromise).rejects.toBeInstanceOf(LoungeReconsentRequiredClientError);

    const galPromise = galleryAdapter.listGallery({ page: 2, limit: 12, cursor: 'c_1' });
    httpTesting.expectOne('/api/v1/lounge/gallery?page=2&limit=12&cursor=c_1').flush({
      data: [],
      meta: { currentPage: 2, limit: 12, totalItems: 0, totalPages: 1, nextCursor: null, hasMore: false },
      summary: { unlockedCount: 0, totalCount: 0 },
    });
    await galPromise;

    // Non-HTTP unknown error mapping
    expect(httpHelper.mapHttpError('raw-error')).toBeInstanceOf(Error);
    expect(httpHelper.mapHttpError(new LoungeClientApiError(400, 'Bad', 'ERR'))).toBeInstanceOf(Error);
  });
});
