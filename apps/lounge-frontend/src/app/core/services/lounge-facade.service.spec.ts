import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type {
  LoungeAccountSummaryDto,
  LoungeBillingCatalogDto,
  LoungeLanguage,
  LoungeRuntimeConfigDto,
  LoungeSubscription,
  LoungeSubscriptionDetailResponseDto,
  LoungeUser,
} from '@rebecca/types';
import { LoungeClientApiError } from '../errors/lounge-client.errors';
import { LoungeAccountPort } from '../ports/lounge-account.port';
import { LoungeAuthPort } from '../ports/lounge-auth.port';
import { LoungeBillingPort } from '../ports/lounge-billing.port';
import { LoungeConfigPort } from '../ports/lounge-config.port';
import { LoungeGalleryPort } from '../ports/lounge-gallery.port';
import { LoungeSessionPort } from '../ports/lounge-session.port';
import {
  assertNonEmptyChatMessage,
  assertValidDeleteAccountRequest,
  assertValidPreCheckoutConsent,
  assertValidReconsentSubmission,
  assertValidSignUpConsent,
} from '../validators/lounge-business.validator';
import { LoungeAuthService } from './lounge-auth.service';
import { LoungeFacadeService } from './lounge-facade.service';
import {
  LOUNGE_TRANSLATIONS,
  buildLoungeTimezoneOptions,
  formatLoungeCopy,
} from './lounge-translations';

describe('LoungeFacadeService', () => {
  let configMock: { getRuntimeConfig: jest.Mock<Promise<LoungeRuntimeConfigDto>, []> };
  let authMock: {
    getCurrentSession: jest.Mock;
    loginWithX: jest.Mock;
    signUpWithX: jest.Mock;
    logout: jest.Mock;
  };
  let accountMock: {
    getAccountSummary: jest.Mock<Promise<LoungeAccountSummaryDto>, []>;
    updatePreferences: jest.Mock;
    updateDisclaimerConsent: jest.Mock;
    deleteAccount: jest.Mock;
  };
  let billingMock: {
    getCatalog: jest.Mock;
    createCheckout: jest.Mock;
    verifyCheckout: jest.Mock;
    createPortal: jest.Mock;
    getSubscriptionDetail: jest.Mock;
    withdrawEu: jest.Mock;
    listOrders: jest.Mock;
    getOrderReceipt: jest.Mock;
  };
  let sessionMock: { getSession: jest.Mock; listMessages: jest.Mock; sendMessage: jest.Mock };
  let galleryMock: { listGallery: jest.Mock };

  const baseSubscription: LoungeSubscription = {
    uid: 'uid_fac_1',
    tier: 'FREE',
    status: 'NONE',
    billingCurrency: 'JPY',
    dailyTurnQuota: 5,
    dailyRemainingTurns: 5,
    purchasedRemainingTurns: 20,
    remainingChatTurns: 25,
    earliestLotExpiresAt: null,
    lastDailyResetAt: '2026-11-24T00:00:00.000Z',
    lastQuotaResetTimezone: 'Asia/Tokyo',
    nextDailyResetAt: '2026-11-25T00:00:00.000Z',
    currentPeriodEnd: null,
    trialTicketUsed: false,
    cancelAtPeriodEnd: false,
    updatedAt: '2026-11-24T00:00:00.000Z',
  };

  const baseUser: LoungeUser = {
    uid: 'uid_fac_1',
    xUserId: '1000000010',
    xHandle: '@fac_user',
    displayName: 'Fac User',
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
      agreedToNonEeaEligibility: true,
      scrolledToBottomAt: '2026-11-24T00:00:00.000Z',
      consentedAt: '2026-11-24T00:00:01.000Z',
    },
    createdAt: '2026-11-24T00:00:00.000Z',
    updatedAt: '2026-11-24T00:00:01.000Z',
    lastLoginAt: '2026-11-24T00:00:01.000Z',
  };

  const runtimeConfig: LoungeRuntimeConfigDto = {
    appVersion: 'v1.46.0',
    disclaimerVersion: 1,
    production: false,
    phase2EeaEnabled: false,
    legalUrls: {
      tosUrl: 'https://portal.example.com/tos',
      privacyUrl: 'https://portal.example.com/privacy',
      legalUrl: 'https://portal.example.com/legal',
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

  function setupTestBed(): LoungeFacadeService {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: LoungeConfigPort, useValue: configMock },
        { provide: LoungeAuthPort, useValue: authMock },
        { provide: LoungeAccountPort, useValue: accountMock },
        { provide: LoungeBillingPort, useValue: billingMock },
        { provide: LoungeSessionPort, useValue: sessionMock },
        { provide: LoungeGalleryPort, useValue: galleryMock },
      ],
    });
    const facade = TestBed.inject(LoungeFacadeService);
    jest.spyOn(facade, 'navigateExternalUrl').mockImplementation(() => undefined);
    return facade;
  }

  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    configMock = { getRuntimeConfig: jest.fn(async () => runtimeConfig) };
    authMock = {
      getCurrentSession: jest.fn(async () => null),
      loginWithX: jest.fn(async () => ({ user: baseUser, appVersion: 'v1.46.0', issuedAt: '' })),
      signUpWithX: jest.fn(async () => ({
        user: { ...baseUser, onboardingCompleted: false },
        appVersion: 'v1.46.0',
        issuedAt: '',
      })),
      logout: jest.fn(async () => undefined),
    };
    accountMock = {
      getAccountSummary: jest.fn(async () => ({
        user: baseUser,
        subscription: baseSubscription,
        persona: runtimeConfig.persona,
        unlockedGalleryCount: 0,
        totalGalleryCount: 0,
        appVersion: 'v1.46.0',
      })),
      updatePreferences: jest.fn(async (req) => ({ ...baseUser, ...req })),
      updateDisclaimerConsent: jest.fn(async () => baseUser),
      deleteAccount: jest.fn(async () => undefined),
    };
    billingMock = {
      getCatalog: jest.fn(async () => ({}) as LoungeBillingCatalogDto),
      createCheckout: jest.fn(async () => ({
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_1',
        sessionIdMasked: 'cs_...1',
      })),
      verifyCheckout: jest.fn(async () => ({ subscription: baseSubscription, verified: true })),
      createPortal: jest.fn(async () => ({ portalUrl: 'https://billing.stripe.com/p/1' })),
      getSubscriptionDetail: jest.fn(
        async () =>
          ({
            subscription: baseSubscription,
            quotaBreakdown: {
              dailyTurnQuota: 5,
              dailyRemainingTurns: 5,
              purchasedRemainingTurns: 20,
              remainingChatTurns: 25,
              activeLots: [],
              nextDailyResetAt: null,
              consumptionOrder: ['DAILY', 'LOT_FIFO'],
              phase2EuWithdrawalEligible: false,
            },
          }) satisfies LoungeSubscriptionDetailResponseDto,
      ),
      withdrawEu: jest.fn(async () => ({
        withdrawnAt: '2026-11-24T00:00:00.000Z',
        refundedAmountMinor: 500,
        currency: 'JPY',
        revokedTurns: 100,
        receiptEmailDispatched: true,
        subscription: baseSubscription,
      })),
      listOrders: jest.fn(async () => ({ orders: [], hasMore: false, nextCursor: null })),
      getOrderReceipt: jest.fn(async () => ({
        receiptUrl: 'https://pay.stripe.com/receipts/ch_1',
      })),
    };
    sessionMock = {
      getSession: jest.fn(async () => ({
        id: 'uid_fac_1',
        uid: 'uid_fac_1',
        title: 'Private Lounge',
        messageCount: 0,
        currentEmotion: 'NEUTRAL',
        createdAt: '2026-11-24T00:00:00.000Z',
        updatedAt: '2026-11-24T00:00:00.000Z',
      })),
      listMessages: jest.fn(async () => ({
        data: [],
        meta: { currentPage: 1, limit: 20, totalItems: 0, totalPages: 1, nextCursor: null, hasMore: false },
      })),
      sendMessage: jest.fn(),
    };
    galleryMock = {
      listGallery: jest.fn(async () => ({
        data: [],
        meta: { currentPage: 1, limit: 12, totalItems: 0, totalPages: 1, nextCursor: null, hasMore: false },
        summary: { unlockedCount: 0, totalCount: 0 },
      })),
    };
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('surfaces explicit configLoadError on /config failure and recovers on retryInitializeLounge()', async () => {
    configMock.getRuntimeConfig.mockRejectedValueOnce(
      new LoungeClientApiError(503, 'Service unavailable https://internal.invalid', 'UPSTREAM_UNAVAILABLE'),
    );
    const facade = setupTestBed();
    await facade.ready;

    expect(facade.configLoadError()).toBe(facade.t('configLoadErrorBody'));
    expect(facade.configLoadError()).not.toContain('internal.invalid');
    expect(facade.activeView()).toBe('AUTH');

    await facade.retryInitializeLounge();
    expect(facade.configLoadError()).toBeNull();
    expect(facade.personaBranding().brandName).toBe('Rebecca Private Lounge');
    expect(facade.legalUrls()?.privacyUrl).toBe('https://portal.example.com/privacy');
  });

  it('enforces Phase 1 non-EEA confirmation and maps GEO_BLOCKED / GEO_UNAVAILABLE to localized messages', async () => {
    const facade = setupTestBed();
    await facade.ready;

    facade.setAuthMode('SIGNUP');
    facade.updateDisclaimerScroll(100, 100, 100);
    facade.setDisclaimerChecked(true);
    expect(facade.canSubmitSignUp()).toBe(false);

    facade.setNonEeaEligibilityChecked(true);
    expect(facade.canSubmitSignUp()).toBe(true);

    authMock.signUpWithX.mockRejectedValueOnce(
      new LoungeClientApiError(403, 'Geo blocked', 'GEO_BLOCKED'),
    );
    await facade.submitSignUpWithX();
    expect(facade.errorMessage()).toBe(facade.t('geoBlockedError'));

    authMock.loginWithX.mockRejectedValueOnce(
      new LoungeClientApiError(503, 'Geo unknown', 'GEO_UNAVAILABLE'),
    );
    await facade.submitLoginWithX();
    expect(facade.errorMessage()).toBe(facade.t('geoUnavailableError'));
  });

  it('manages inline 2-step EU withdrawal confirmation and localized tier/status helpers', async () => {
    const facade = setupTestBed();
    await facade.ready;

    expect(facade.getTierLabel('FREE')).toBe(facade.t('tierFreeLabel'));
    expect(facade.getTierLabel('STANDARD')).toBe(facade.t('tierStandardLabel'));
    expect(facade.getSubscriptionStatusLabel('ACTIVE')).toBe(facade.t('subStatusActiveLabel'));
    expect(facade.getSubscriptionStatusLabel('CANCELING')).toBe(facade.t('subStatusCancelingLabel'));
    expect(facade.getSubscriptionStatusLabel('CANCELED')).toBe(facade.t('subStatusCanceledLabel'));
    expect(facade.getSubscriptionStatusLabel('PAST_DUE')).toBe(facade.t('subStatusPastDueLabel'));
    expect(facade.getSubscriptionStatusLabel('NONE')).toBe(facade.t('subStatusNoneLabel'));

    facade.requestEuWithdrawalConfirmation({
      targetType: 'CREDIT_LOT',
      targetId: 'lot_eu_1',
      confirmedWithdrawal: true,
    });
    expect(facade.pendingEuWithdrawal()?.targetId).toBe('lot_eu_1');
    facade.cancelEuWithdrawalConfirmation();
    expect(facade.pendingEuWithdrawal()).toBeNull();

    await facade.confirmPendingEuWithdrawal(); // no-op when null
    expect(billingMock.withdrawEu).not.toHaveBeenCalled();

    facade.requestEuWithdrawalConfirmation({
      targetType: 'SUBSCRIPTION',
      targetId: 'sub_eu_1',
      confirmedWithdrawal: true,
    });
    await facade.confirmPendingEuWithdrawal();
    expect(billingMock.withdrawEu).toHaveBeenCalledWith({
      targetType: 'SUBSCRIPTION',
      targetId: 'sub_eu_1',
      confirmedWithdrawal: true,
    });
    expect(facade.billingBannerNotice()?.tone).toBe('success');
  });

  it('rejects untrusted Stripe redirect URLs and handles checkout/portal/analytics rollbacks cleanly', async () => {
    const facade = setupTestBed();
    await facade.ready;
    await facade.submitLoginWithX();

    billingMock.createCheckout.mockResolvedValueOnce({
      checkoutUrl: 'https://evil.example/pay',
      sessionIdMasked: 'cs_...bad',
    });
    facade.openPreCheckoutModal({
      productId: 'CHARGE_TICKET_100',
      mode: 'payment',
      currency: 'JPY',
      unitAmountMinor: 500,
      formattedPrice: '¥500',
      grantedTurns: 100,
      validityDays: 180,
      taxInclusive: true,
      promotionCodesAllowed: true,
      available: true,
      eligible: true,
    });
    await facade.submitCheckout({
      acceptedPurchaseDisclosure: true,
      acceptedAutoRenewalOptIn: true,
      confirmedAdultOrParentalConsent: true,
    });
    expect(facade.errorMessage()).toBe(facade.t('errorUntrustedRedirectUrl'));
    expect(facade.isLoadingBilling()).toBe(false);

    // Valid Stripe Checkout redirect keeps isLoadingBilling locked to prevent double-submit
    facade.openPreCheckoutModal({
      productId: 'CHARGE_TICKET_100',
      mode: 'payment',
      currency: 'JPY',
      unitAmountMinor: 500,
      formattedPrice: '¥500',
      grantedTurns: 100,
      validityDays: 180,
      taxInclusive: true,
      promotionCodesAllowed: true,
      available: true,
      eligible: true,
    });
    await facade.submitCheckout({
      acceptedPurchaseDisclosure: true,
      acceptedAutoRenewalOptIn: true,
      confirmedAdultOrParentalConsent: true,
    });
    expect(facade.isLoadingBilling()).toBe(true);
    expect(facade.selectedCheckoutProduct()).toBeNull();
    facade.isLoadingBilling.set(false);

    // Valid Customer Portal redirect keeps isLoadingBilling locked; failure unlocks cleanly
    await facade.openCustomerPortal('default');
    expect(facade.isLoadingBilling()).toBe(true);
    facade.isLoadingBilling.set(false);

    facade.openPreCheckoutModal({
      productId: 'CHARGE_TICKET_100',
      mode: 'payment',
      currency: 'JPY',
      unitAmountMinor: 500,
      formattedPrice: '¥500',
      grantedTurns: 100,
      validityDays: 180,
      taxInclusive: true,
      promotionCodesAllowed: true,
      available: true,
      eligible: true,
    });
    await expect(
      facade.submitCheckout({
        acceptedPurchaseDisclosure: false,
        acceptedAutoRenewalOptIn: true,
        confirmedAdultOrParentalConsent: true,
      }),
    ).rejects.toThrow(/All required pre-checkout disclosures/);
    facade.closePreCheckoutModal();

    accountMock.updatePreferences.mockRejectedValueOnce(new Error('Pref save error'));
    await facade.setAnalyticsOptIn(false);
    expect(facade.accountSummary()?.user.allowServiceImprovementAnalytics).toBe(true);
    expect(facade.errorMessage()).toBe(facade.t('errorGeneric'));
  });

  it('maps backend error codes/HTTP statuses cleanly without leaking raw internal messages', async () => {
    const facade = setupTestBed();
    await facade.ready;
    await facade.submitLoginWithX();

    const codeExpectations: readonly [string, string][] = [
      ['DISPUTE_BLOCKED', facade.t('billingDisputeBlockedNotice')],
      ['QUOTA_EXHAUSTED', facade.t('quotaExhaustedBanner')],
      ['COMING_SOON', facade.t('errorBillingComingSoon')],
      ['TRIAL_ALREADY_USED', facade.t('errorTrialAlreadyUsed')],
      ['SUBSCRIPTION_ALREADY_ACTIVE', facade.t('errorSubscriptionAlreadyActive')],
      ['EU_WITHDRAWAL_UNAVAILABLE', facade.t('errorEuWithdrawalUnavailable')],
      ['STRIPE_CANCELLATION_FAILED', facade.t('deleteModalStripeErrorBanner')],
      ['UNTRUSTED_REDIRECT_URL', facade.t('errorUntrustedRedirectUrl')],
    ];
    for (const [code, expected] of codeExpectations) {
      sessionMock.sendMessage.mockRejectedValueOnce(new LoungeClientApiError(400, 'raw secret trace', code));
      await facade.sendMessage('hello');
      expect(facade.errorMessage()).toBe(expected);
      expect(facade.errorMessage()).not.toContain('raw secret trace');
    }

    const statusExpectations: readonly [number, string][] = [
      [0, facade.t('errorNetwork')],
      [401, facade.t('errorUnauthorized')],
      [403, facade.t('errorForbidden')],
      [409, facade.t('errorAccountConflict')],
      [429, facade.t('errorRateLimited')],
      [500, facade.t('errorGeneric')],
    ];
    for (const [status, expected] of statusExpectations) {
      sessionMock.sendMessage.mockRejectedValueOnce(new LoungeClientApiError(status, 'https://internal.api/debug'));
      await facade.sendMessage('hello');
      expect(facade.errorMessage()).toBe(expected);
      expect(facade.errorMessage()).not.toContain('internal.api');
    }
  });

  it('prevents stale out-of-order rollbacks/writes across concurrent preference updates', async () => {
    const facade = setupTestBed();
    await facade.ready;
    await facade.submitLoginWithX();

    let rejectLang1!: (err: Error) => void;
    let resolveLang2!: (user: LoungeUser) => void;
    accountMock.updatePreferences
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectLang1 = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveLang2 = resolve;
          }),
      );

    const pLang1 = facade.setLanguage('de');
    const pLang2 = facade.setLanguage('en');
    resolveLang2({ ...baseUser, language: 'en' });
    await pLang2;
    rejectLang1(new Error('late timeout'));
    await pLang1;
    expect(facade.lang()).toBe('en');
    expect(facade.accountSummary()?.user.language).toBe('en');
    expect(facade.errorMessage()).toBeNull();

    let rejectTz1!: (err: Error) => void;
    let resolveTz2!: (user: LoungeUser) => void;
    accountMock.updatePreferences
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectTz1 = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveTz2 = resolve;
          }),
      );

    const pTz1 = facade.setTimezone('UTC');
    const pTz2 = facade.setTimezone('Europe/Paris');
    resolveTz2({ ...baseUser, language: 'en', timezone: 'Europe/Paris' });
    await pTz2;
    rejectTz1(new Error('late tz timeout'));
    await pTz1;
    expect(facade.timezone()).toBe('Europe/Paris');
    expect(facade.errorMessage()).toBeNull();

    let resolveOpt1!: (user: LoungeUser) => void;
    let rejectOpt2!: (err: Error) => void;
    accountMock.updatePreferences
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOpt1 = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectOpt2 = reject;
          }),
      );

    const pOpt1 = facade.setAnalyticsOptIn(false);
    const pOpt2 = facade.setAnalyticsOptIn(true);
    resolveOpt1({ ...baseUser, allowServiceImprovementAnalytics: false });
    await pOpt1;
    // Latest request (pOpt2) failed -> rolls back cleanly to initial state (true) instead of stale false
    rejectOpt2(new Error('opt fail'));
    await pOpt2;
    expect(facade.accountSummary()?.user.allowServiceImprovementAnalytics).toBe(true);
    expect(facade.errorMessage()).toBe(facade.t('errorGeneric'));
  });

  it('handles missing session_id redirects, strips emuXUser in production, resets disclaimer on tab switch, and protects translations', async () => {
    window.history.replaceState({}, '', '/?checkout=success&emuXUser=invalid!param');
    authMock.getCurrentSession.mockResolvedValueOnce({
      user: baseUser,
      appVersion: 'v1.46.0',
      issuedAt: '',
    });
    const facade = setupTestBed();
    await facade.ready;
    expect(facade.activeView()).toBe('BILLING');
    expect(facade.errorMessage()).toBe(facade.t('errorCheckoutVerificationMissing'));
    expect(facade.isLoadingBilling()).toBe(false);
    expect(window.location.search).toBe('');

    // Production runtime strips even syntactically valid emuXUser query params
    configMock.getRuntimeConfig.mockResolvedValueOnce({
      ...runtimeConfig,
      production: true,
    });
    window.history.replaceState({}, '', '/?checkout=cancel&emuXUser=emu_user_1');
    authMock.getCurrentSession.mockResolvedValueOnce({
      user: baseUser,
      appVersion: 'v1.46.0',
      issuedAt: '',
    });
    await facade.initializeLounge();
    expect(window.location.search).toBe('');

    // Switching authMode resets disclaimer scroll and checkbox state
    facade.setAuthMode('SIGNUP');
    facade.updateDisclaimerScroll(100, 100, 100);
    facade.setDisclaimerChecked(true);
    expect(facade.disclaimerChecked()).toBe(true);
    facade.setAuthMode('LOGIN');
    expect(facade.disclaimerScrolledToBottom()).toBe(false);
    expect(facade.disclaimerChecked()).toBe(false);

    // Safe regex replacement for '$' sequences in persona name + dynamic IANA timezone builder + 8-locale audit
    expect(formatLoungeCopy('Hi {name}!', 'Reb$&ecca$$1')).toBe('Hi Reb$&ecca$$1!');
    expect(buildLoungeTimezoneOptions('Europe/Berlin')[0]?.value).toBe('Europe/Berlin');
    expect(buildLoungeTimezoneOptions('Europe/Berlin')[0]?.label).toMatch(/^\(UTC[+-]\d{2}:\d{2}\) Europe\/Berlin$/);
    expect(buildLoungeTimezoneOptions('Invalid/Not_A_Zone')).toHaveLength(29);

    const locales: readonly LoungeLanguage[] = ['ja', 'en', 'de', 'pt', 'es', 'zh-HK', 'vi', 'th'];
    for (const locale of locales) {
      const dict = LOUNGE_TRANSLATIONS[locale];
      for (const value of Object.values(dict)) {
        expect(value.trim().length).toBeGreaterThan(0);
      }
      expect(dict.billingStandardDesc).toMatch(/3/);
      expect(dict.subExpiringSoonWarning).toContain('{name}');
      if (locale !== 'en') {
        expect(dict.newGalleryBadge).not.toBe('NEW GALLERY');
      }
    }
  });

  it('orchestrates Firebase auth lifecycle and enforces core business validators independently of HTTP adapters', async () => {
    const authServiceStub = {
      configured: true,
      isConfigured: jest.fn(() => authServiceStub.configured),
      configure: jest.fn(),
      waitForInit: jest.fn(async () => undefined),
      getToken: jest.fn<Promise<string | null>, [boolean?]>(async () => 'fb-token-1'),
      authenticateWithX: jest.fn(async () => ({
        idToken: 'popup-token-1',
        xOAuthCode: 'oauth-code-1',
        uid: 'uid_fac_1',
      })),
      signOutFirebase: jest.fn(async () => undefined),
    };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: LoungeConfigPort, useValue: configMock },
        { provide: LoungeAuthPort, useValue: authMock },
        { provide: LoungeAccountPort, useValue: accountMock },
        { provide: LoungeBillingPort, useValue: billingMock },
        { provide: LoungeSessionPort, useValue: sessionMock },
        { provide: LoungeGalleryPort, useValue: galleryMock },
        { provide: LoungeAuthService, useValue: authServiceStub },
      ],
    });
    const facade = TestBed.inject(LoungeFacadeService);
    jest.spyOn(facade, 'navigateExternalUrl').mockImplementation(() => undefined);

    // 401 session restore clears stale Firebase session cleanly
    authMock.loginWithX.mockRejectedValueOnce(new LoungeClientApiError(401, 'Expired'));
    await facade.ready;
    expect(authServiceStub.configure).toHaveBeenCalledWith(runtimeConfig);
    expect(authServiceStub.waitForInit).toHaveBeenCalled();
    expect(authServiceStub.signOutFirebase).toHaveBeenCalledTimes(1);
    expect(facade.activeView()).toBe('AUTH');

    // Null token skips /auth/login call cleanly
    authServiceStub.getToken.mockResolvedValueOnce(null);
    await facade.initializeLounge();
    expect(facade.activeView()).toBe('AUTH');

    // 403 GEO_BLOCKED on restore signs out Firebase and surfaces localized geo error
    authMock.loginWithX.mockRejectedValueOnce(new LoungeClientApiError(403, 'Geo blocked', 'GEO_BLOCKED'));
    await facade.initializeLounge();
    expect(authServiceStub.signOutFirebase).toHaveBeenCalledTimes(2);
    expect(facade.errorMessage()).toBe(facade.t('geoBlockedError'));

    // X login uses popup creds; failure signs out Firebase
    authMock.loginWithX.mockRejectedValueOnce(new LoungeClientApiError(404, 'Unregistered'));
    await facade.submitLoginWithX();
    expect(authMock.loginWithX).toHaveBeenLastCalledWith({
      idToken: 'popup-token-1',
      xOAuthCode: 'oauth-code-1',
    });
    expect(authServiceStub.signOutFirebase).toHaveBeenCalledTimes(3);

    // X sign-up uses popup creds; 409 conflict signs out Firebase
    facade.setAuthMode('SIGNUP');
    facade.updateDisclaimerScroll(100, 100, 100);
    facade.setDisclaimerChecked(true);
    facade.setNonEeaEligibilityChecked(true);
    authMock.signUpWithX.mockRejectedValueOnce(new LoungeClientApiError(409, 'Conflict'));
    await facade.submitSignUpWithX();
    expect(authMock.signUpWithX).toHaveBeenLastCalledWith(
      expect.objectContaining({
        idToken: 'popup-token-1',
        xOAuthCode: 'oauth-code-1',
      }),
    );
    expect(authServiceStub.signOutFirebase).toHaveBeenCalledTimes(4);

    // Logout and account deletion sign out Firebase
    await facade.submitLoginWithX();
    await facade.logout();
    expect(authServiceStub.signOutFirebase).toHaveBeenCalledTimes(5);

    await facade.submitLoginWithX();
    facade.openDeleteAccountModal();
    facade.proceedToDeleteAccountStep2();
    facade.setDeleteConfirmIrreversible(true);
    facade.setDeleteConfirmNoRefund(true);
    await facade.confirmDeleteAccount();
    expect(authServiceStub.signOutFirebase).toHaveBeenCalledTimes(6);

    // Pure core business validators enforce mandatory contracts cleanly
    expect(() =>
      assertValidSignUpConsent(
        {
          ...baseUser.disclaimerConsent,
          agreedToGeminiTrainingUsage: false,
        },
        false,
      ),
    ).toThrow(/Mandatory disclaimer terms/);
    expect(() =>
      assertValidSignUpConsent(
        {
          ...baseUser.disclaimerConsent,
          agreedToNonEeaEligibility: false,
        },
        false,
      ),
    ).toThrow(/Non-EEA eligibility/);
    expect(() =>
      assertValidReconsentSubmission(
        {
          ...baseUser.disclaimerConsent,
          agreedToZeroPiiProhibition: false,
        },
        2,
        false,
      ),
    ).toThrow(/Mandatory disclaimer clauses/);
    expect(() =>
      assertValidReconsentSubmission(
        {
          ...baseUser.disclaimerConsent,
          agreedToNonEeaEligibility: false,
        },
        2,
        false,
      ),
    ).toThrow(/Non-EEA eligibility/);
    expect(() =>
      assertValidReconsentSubmission(
        {
          ...baseUser.disclaimerConsent,
          disclaimerVersion: 1,
        },
        2,
        true,
      ),
    ).toThrow(/must match active version 2/);
    expect(() =>
      assertValidDeleteAccountRequest({
        confirmedIrreversibleDeletion: true,
        confirmedNoRefundForRemainingTurns: false,
      }),
    ).toThrow(/Both irreversible deletion/);
    expect(() => assertNonEmptyChatMessage('   ')).toThrow(/cannot be empty/);
    expect(assertNonEmptyChatMessage('  hi  ')).toBe('hi');
    expect(() =>
      assertValidPreCheckoutConsent({
        acceptedPurchaseDisclosure: true,
        acceptedAutoRenewalOptIn: false,
        confirmedAdultOrParentalConsent: true,
      }),
    ).toThrow(/pre-checkout disclosures/);
  });
});
