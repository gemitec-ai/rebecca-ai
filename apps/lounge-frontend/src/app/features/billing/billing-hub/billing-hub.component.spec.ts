import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import type {
  LoungeAccountSummaryDto,
  LoungeAuthSessionDto,
  LoungeBillingCatalogDto,
  LoungeBillingOrderItemDto,
  LoungeBillingOrdersResponseDto,
  LoungeBillingReceiptResponseDto,
  LoungeCreateCheckoutRequestDto,
  LoungeCreateCheckoutResponseDto,
  LoungeCreatePortalRequestDto,
  LoungeCreatePortalResponseDto,
  LoungeCreditLot,
  LoungeDeleteAccountRequestDto,
  LoungeEuWithdrawalRequestDto,
  LoungeEuWithdrawalResponseDto,
  LoungeGalleryListResponseDto,
  LoungeLoginRequestDto,
  LoungeMessageListResponseDto,
  LoungePaginationQueryDto,
  LoungeRuntimeConfigDto,
  LoungeSendMessageRequestDto,
  LoungeSendMessageResponseDto,
  LoungeSession,
  LoungeSignUpRequestDto,
  LoungeSubscription,
  LoungeSubscriptionDetailResponseDto,
  LoungeUpdateDisclaimerConsentRequestDto,
  LoungeUpdatePreferencesRequestDto,
  LoungeUser,
  LoungeVerifyCheckoutRequestDto,
  LoungeVerifyCheckoutResponseDto,
} from '@rebecca/types';
import { AppComponent } from '../../../app.component';
import { EntranceViewComponent } from '../../auth/entrance-view/entrance-view.component';
import { ChatViewComponent } from '../../chat/chat-view/chat-view.component';
import { DeleteAccountModalComponent } from '../../options/delete-account-modal/delete-account-modal.component';
import { OptionsViewComponent } from '../../options/options-view/options-view.component';
import { LoungeClientApiError } from '../../../core/errors/lounge-client.errors';
import { LoungeAccountPort } from '../../../core/ports/lounge-account.port';
import { LoungeAuthPort } from '../../../core/ports/lounge-auth.port';
import { LoungeBillingPort } from '../../../core/ports/lounge-billing.port';
import { LoungeConfigPort } from '../../../core/ports/lounge-config.port';
import { LoungeGalleryPort } from '../../../core/ports/lounge-gallery.port';
import { LoungeSessionPort } from '../../../core/ports/lounge-session.port';
import {
  LoungeFacadeService,
  MAX_LOUNGE_COMPOSER_LENGTH,
} from '../../../core/services/lounge-facade.service';
import { BillingHubComponent } from './billing-hub.component';

class InMemoryBillingAppFake
  implements
    LoungeConfigPort,
    LoungeAuthPort,
    LoungeAccountPort,
    LoungeBillingPort,
    LoungeSessionPort,
    LoungeGalleryPort
{
  public user: LoungeUser = {
    uid: 'uid_billing_001',
    xUserId: '1000000888',
    xHandle: '@billing_member',
    displayName: 'Billing Member',
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
      consentedAt: '2026-11-24T00:00:02.000Z',
    },
    createdAt: '2026-11-24T00:00:00.000Z',
    updatedAt: '2026-11-24T00:00:02.000Z',
    lastLoginAt: '2026-11-24T00:00:02.000Z',
  };

  public subscription: LoungeSubscription = {
    uid: 'uid_billing_001',
    tier: 'STANDARD',
    status: 'ACTIVE',
    billingCurrency: 'JPY',
    dailyTurnQuota: 100,
    dailyRemainingTurns: 80,
    purchasedRemainingTurns: 100,
    remainingChatTurns: 180,
    earliestLotExpiresAt: '2026-12-01T00:00:00.000Z',
    lastDailyResetAt: '2026-11-24T00:00:00.000Z',
    lastQuotaResetTimezone: 'Asia/Tokyo',
    nextDailyResetAt: '2026-11-25T00:00:00.000Z',
    currentPeriodEnd: '2026-12-24T00:00:00.000Z',
    trialTicketUsed: false,
    cancelAtPeriodEnd: false,
    updatedAt: '2026-11-24T00:00:00.000Z',
  };

  public catalog: LoungeBillingCatalogDto = {
    currency: 'JPY',
    currencyLocked: true,
    countryCode: 'JP',
    isEeaResident: false,
    phase2EeaEnabled: false,
    trialEligible: true,
    subscriptionStatus: 'ACTIVE',
    products: [
      {
        productId: 'TRIAL_TICKET_100',
        mode: 'payment',
        currency: 'JPY',
        unitAmountMinor: 200,
        formattedPrice: '¥200',
        grantedTurns: 100,
        validityDays: 180,
        taxInclusive: true,
        promotionCodesAllowed: false,
        available: true,
        eligible: true,
      },
      {
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
      },
      {
        productId: 'STANDARD_MONTHLY',
        mode: 'subscription',
        currency: 'JPY',
        unitAmountMinor: 1400,
        formattedPrice: '¥1,400',
        grantedTurns: 100,
        validityDays: null,
        taxInclusive: true,
        promotionCodesAllowed: false,
        available: true,
        eligible: false,
        ineligibleReason: 'SUBSCRIPTION_ALREADY_ACTIVE',
      },
    ],
  };

  public allOrders: LoungeBillingOrderItemDto[] = [
    {
      chargeId: 'ch_ord_001',
      productId: 'STANDARD_MONTHLY',
      status: 'COMPLETED',
      amountMinor: 1400,
      refundedAmountMinor: 0,
      currency: 'JPY',
      createdAt: '2026-11-24T01:00:00.000Z',
      receiptAvailable: true,
    },
    {
      chargeId: 'ch_ord_002',
      productId: 'CHARGE_TICKET_100',
      status: 'PARTIAL_REFUNDED',
      amountMinor: 350,
      refundedAmountMinor: 100,
      currency: 'USD',
      createdAt: '2026-11-23T01:00:00.000Z',
      receiptAvailable: true,
      remainingTurns: 80,
      initialTurns: 100,
      expiresAt: '2027-05-22T01:00:00.000Z',
    },
    {
      chargeId: 'ch_ord_003',
      productId: 'TRIAL_TICKET_100',
      status: 'REFUNDED',
      amountMinor: 200,
      refundedAmountMinor: 200,
      currency: 'JPY',
      createdAt: '2026-11-22T01:00:00.000Z',
      receiptAvailable: false,
    },
  ];

  public phase2EuWithdrawalEligible = false;
  public autoRefundOnVerify = false;
  public nextCheckoutUrl = 'https://checkout.stripe.com/c/pay/cs_test_ok';
  public nextPortalUrl = 'https://billing.stripe.com/p/session/bps_ok';
  public nextReceiptUrl = 'https://pay.stripe.com/receipts/ch_ord_001';
  public shouldFailReceipt = false;
  public shouldFailAnalyticsUpdate = false;
  public shouldFailDeleteWith502 = false;
  public recordedCheckoutRequests: LoungeCreateCheckoutRequestDto[] = [];
  public recordedPortalFlows: string[] = [];

  public async getRuntimeConfig(): Promise<LoungeRuntimeConfigDto> {
    return {
      appVersion: '1.45.2',
      disclaimerVersion: 1,
      production: false,
      useEmulators: true,
      phase2EeaEnabled: false,
      persona: {
        displayName: 'レベッカ',
        englishName: 'Rebecca',
        brandName: 'Rebecca Private Lounge',
        avatarPath: 'assets/rebecca_avatar.png',
        chatIconPath: 'assets/rebecca_chat.png',
        emotionAvatarPaths: {
          NEUTRAL: 'assets/neutral.png',
          HAPPY: 'assets/happy.png',
          TEASING: 'assets/teasing.png',
          SHY: 'assets/shy.png',
          EXCITED: 'assets/excited.png',
          THOUGHTFUL: 'assets/thoughtful.png',
          SURPRISED: 'assets/surprised.png',
        },
      },
    };
  }

  public async getCurrentSession(): Promise<LoungeAuthSessionDto | null> {
    return {
      user: this.user,
      appVersion: '1.45.2',
      issuedAt: this.user.lastLoginAt,
    };
  }

  public async loginWithX(_req: LoungeLoginRequestDto): Promise<LoungeAuthSessionDto> {
    return {
      user: this.user,
      appVersion: '1.45.2',
      issuedAt: this.user.lastLoginAt,
    };
  }

  public async signUpWithX(_req: LoungeSignUpRequestDto): Promise<LoungeAuthSessionDto> {
    return {
      user: this.user,
      appVersion: '1.45.2',
      issuedAt: this.user.lastLoginAt,
    };
  }

  public logoutCalls = 0;

  public async logout(): Promise<void> {
    this.logoutCalls += 1;
  }

  public async getAccountSummary(): Promise<LoungeAccountSummaryDto> {
    return {
      user: this.user,
      subscription: this.subscription,
      persona: (await this.getRuntimeConfig()).persona,
      unlockedGalleryCount: 1,
      totalGalleryCount: 1,
      appVersion: '1.45.2',
    };
  }

  public async updatePreferences(req: LoungeUpdatePreferencesRequestDto): Promise<LoungeUser> {
    if (req.allowServiceImprovementAnalytics !== undefined && this.shouldFailAnalyticsUpdate) {
      throw new Error('Failed to save analytics preference');
    }
    this.user = {
      ...this.user,
      ...(req.language ? { language: req.language } : {}),
      ...(req.timezone ? { timezone: req.timezone } : {}),
      ...(req.completeOnboarding !== undefined
        ? { onboardingCompleted: req.completeOnboarding }
        : {}),
      ...(req.allowServiceImprovementAnalytics !== undefined
        ? { allowServiceImprovementAnalytics: req.allowServiceImprovementAnalytics }
        : {}),
    };
    return this.user;
  }

  public async updateDisclaimerConsent(
    req: LoungeUpdateDisclaimerConsentRequestDto,
  ): Promise<LoungeUser> {
    this.user = { ...this.user, disclaimerConsent: req.disclaimerConsent };
    return this.user;
  }

  public async deleteAccount(_req: LoungeDeleteAccountRequestDto): Promise<void> {
    if (this.shouldFailDeleteWith502) {
      throw new LoungeClientApiError(
        502,
        'Internal server error',
        'STRIPE_CANCELLATION_FAILED',
      );
    }
  }

  public async getSession(): Promise<LoungeSession> {
    return {
      id: 'uid_billing_001',
      uid: 'uid_billing_001',
      title: 'Private Lounge',
      messageCount: 1,
      currentEmotion: 'HAPPY',
      createdAt: '2026-11-24T00:00:00.000Z',
      updatedAt: '2026-11-24T00:00:00.000Z',
    };
  }

  public async listMessages(_q?: LoungePaginationQueryDto): Promise<LoungeMessageListResponseDto> {
    return {
      data: [],
      meta: {
        currentPage: 1,
        limit: 20,
        totalItems: 0,
        totalPages: 1,
        nextCursor: null,
        hasMore: false,
      },
    };
  }

  public async sendMessage(_req: LoungeSendMessageRequestDto): Promise<LoungeSendMessageResponseDto> {
    throw new Error('Unused in billing unit test');
  }

  public async listGallery(_q?: LoungePaginationQueryDto): Promise<LoungeGalleryListResponseDto> {
    return {
      data: [],
      meta: {
        currentPage: 1,
        limit: 12,
        totalItems: 0,
        totalPages: 1,
        nextCursor: null,
        hasMore: false,
      },
      summary: { unlockedCount: 0, totalCount: 0 },
    };
  }

  public async getCatalog(): Promise<LoungeBillingCatalogDto> {
    return this.catalog;
  }

  public async createCheckout(
    request: LoungeCreateCheckoutRequestDto,
  ): Promise<LoungeCreateCheckoutResponseDto> {
    this.recordedCheckoutRequests.push(request);
    return {
      checkoutUrl: this.nextCheckoutUrl,
      sessionIdMasked: 'cs_tes...t_ok',
    };
  }

  public async verifyCheckout(
    _request: LoungeVerifyCheckoutRequestDto,
  ): Promise<LoungeVerifyCheckoutResponseDto> {
    this.subscription = {
      ...this.subscription,
      purchasedRemainingTurns: 200,
      remainingChatTurns: 280,
      trialTicketUsed: true,
    };
    return {
      subscription: this.subscription,
      verified: true,
      ...(this.autoRefundOnVerify ? { autoRefundedConflict: true } : {}),
    };
  }

  public async createPortal(
    request: LoungeCreatePortalRequestDto,
  ): Promise<LoungeCreatePortalResponseDto> {
    this.recordedPortalFlows.push(request.flow);
    return { portalUrl: this.nextPortalUrl };
  }

  public async getSubscriptionDetail(options?: {
    readonly portalReturn?: boolean;
  }): Promise<LoungeSubscriptionDetailResponseDto> {
    if (options?.portalReturn) {
      this.subscription = {
        ...this.subscription,
        status: 'CANCELING',
        cancelAtPeriodEnd: true,
      };
    }
    return {
      subscription: this.subscription,
      quotaBreakdown: {
        dailyTurnQuota: this.subscription.dailyTurnQuota,
        dailyRemainingTurns: this.subscription.dailyRemainingTurns,
        purchasedRemainingTurns: this.subscription.purchasedRemainingTurns,
        remainingChatTurns: this.subscription.remainingChatTurns,
        activeLots: [
          {
            id: 'cs_lot_001',
            uid: 'uid_billing_001',
            productId: 'CHARGE_TICKET_100',
            isPaid: true,
            initialTurns: 100,
            remainingTurns: 80,
            currency: 'JPY',
            unitAmount: 500,
            status: 'ACTIVE',
            purchasedAt: '2026-11-20T00:00:00.000Z',
            expiresAt: '2026-12-01T00:00:00.000Z',
          },
        ],
        nextDailyResetAt: this.subscription.nextDailyResetAt,
        consumptionOrder: ['DAILY', 'LOT_FIFO'],
        phase2EuWithdrawalEligible: this.phase2EuWithdrawalEligible,
      },
      expiringSoonWarning: {
        hoursRemaining: 168,
        expiringTurns: 80,
        expiresAt: '2026-12-01T00:00:00.000Z',
      },
    };
  }

  public async withdrawEu(
    _request: LoungeEuWithdrawalRequestDto,
  ): Promise<LoungeEuWithdrawalResponseDto> {
    this.subscription = {
      ...this.subscription,
      tier: 'FREE',
      status: 'CANCELED',
      dailyTurnQuota: 5,
      dailyRemainingTurns: 5,
      remainingChatTurns: 105,
    };
    return {
      withdrawnAt: '2026-11-24T02:00:00.000Z',
      refundId: 're_mock_1',
      refundedAmountMinor: 1400,
      currency: 'JPY',
      revokedTurns: 20,
      confirmationChannel: 'STRIPE_RECEIPT_AND_IN_APP',
      subscription: this.subscription,
    };
  }

  public async listOrders(query?: {
    readonly limit?: number;
    readonly startingAfter?: string;
  }): Promise<LoungeBillingOrdersResponseDto> {
    if (!query?.startingAfter) {
      return {
        orders: this.allOrders.slice(0, 2),
        nextCursor: 'ch_ord_002',
        hasMore: true,
      };
    }
    return {
      orders: this.allOrders.slice(2),
      nextCursor: null,
      hasMore: false,
    };
  }

  public async getOrderReceipt(_chargeId: string): Promise<LoungeBillingReceiptResponseDto> {
    if (this.shouldFailReceipt) {
      throw new Error('Receipt retrieval failed');
    }
    return { receiptUrl: this.nextReceiptUrl };
  }
}

describe('BillingHubComponent, PreCheckoutModalComponent & AppComponent Billing UX', () => {
  let fakeBff: InMemoryBillingAppFake;
  let fixture: ComponentFixture<AppComponent>;
  let component: AppComponent;
  let facade: LoungeFacadeService;

  beforeEach(async () => {
    window.history.replaceState({}, '', '/');
    fakeBff = new InMemoryBillingAppFake();
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: LoungeConfigPort, useValue: fakeBff },
        { provide: LoungeAuthPort, useValue: fakeBff },
        { provide: LoungeAccountPort, useValue: fakeBff },
        { provide: LoungeBillingPort, useValue: fakeBff },
        { provide: LoungeSessionPort, useValue: fakeBff },
        { provide: LoungeGalleryPort, useValue: fakeBff },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AppComponent);
    component = fixture.componentInstance;
    facade = component.facade;
    await facade.ready;
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  function query<T extends HTMLElement>(selector: string): T {
    const el = fixture.nativeElement.querySelector(selector) as T | null;
    if (!el) {
      throw new Error(`Expected element matching selector: ${selector}`);
    }
    return el;
  }

  it('opens Billing Hub from Topbar button, validates ASCT checkboxes in PreCheckoutModal, and redirects safely', async () => {
    const navSpy = jest.spyOn(facade, 'navigateExternalUrl').mockImplementation(() => undefined);

    query<HTMLButtonElement>('#btn-topbar-billing').click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(facade.activeView()).toBe('BILLING');
    expect(query<HTMLElement>('#billing-view')).toBeTruthy();

    // Open Trial Ticket Pre-Checkout Modal
    query<HTMLButtonElement>('#btn-select-product-TRIAL_TICKET_100').click();
    await fixture.whenStable();
    fixture.detectChanges();

    const chkDisclosure = query<HTMLInputElement>('#chk-precheckout-disclosure');
    const chkAutoRenew = query<HTMLInputElement>('#chk-precheckout-autorenew');
    const chkAdult = query<HTMLInputElement>('#chk-precheckout-adult');
    const proceedBtn = query<HTMLButtonElement>('#btn-precheckout-proceed');

    // Default unchecked per ASCT Art. 12-6
    expect(chkDisclosure.checked).toBe(false);
    expect(chkAutoRenew.checked).toBe(false);
    expect(chkAdult.checked).toBe(false);
    expect(proceedBtn.disabled).toBe(true);

    // Cancel and re-open resets any checked boxes
    chkDisclosure.click();
    fixture.detectChanges();
    expect(chkDisclosure.checked).toBe(true);

    const dialogEl = query<HTMLDialogElement>('#precheckout-dialog');
    dialogEl.dispatchEvent(new Event('cancel', { cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(facade.selectedCheckoutProduct()).toBeNull();

    query<HTMLButtonElement>('#btn-select-product-TRIAL_TICKET_100').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(query<HTMLInputElement>('#chk-precheckout-disclosure').checked).toBe(false);

    // Verify EEA waiver appears and gates proceed when EEA + Phase 2 enabled
    fakeBff.catalog = { ...fakeBff.catalog, isEeaResident: true, phase2EeaEnabled: true };
    await facade.selectBillingTab('PLANS');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(query<HTMLInputElement>('#chk-precheckout-eu-waiver').checked).toBe(false);

    query<HTMLInputElement>('#chk-precheckout-disclosure').click();
    query<HTMLInputElement>('#chk-precheckout-autorenew').click();
    query<HTMLInputElement>('#chk-precheckout-adult').click();
    fixture.detectChanges();
    expect(query<HTMLButtonElement>('#btn-precheckout-proceed').disabled).toBe(true);

    query<HTMLInputElement>('#chk-precheckout-eu-waiver').click();
    fixture.detectChanges();
    expect(query<HTMLButtonElement>('#btn-precheckout-proceed').disabled).toBe(false);

    // External URL security rejects untrusted checkoutUrl cleanly
    fakeBff.nextCheckoutUrl = 'https://evil.example/steal';
    query<HTMLButtonElement>('#btn-precheckout-proceed').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(navSpy).not.toHaveBeenCalled();
    expect(facade.errorMessage()).toBe(facade.t('errorUntrustedRedirectUrl'));
    expect(facade.isLoadingBilling()).toBe(false);

    // Valid Stripe Checkout URL triggers external navigation & preserves loading lock
    fakeBff.nextCheckoutUrl = 'https://checkout.stripe.com/c/pay/cs_valid_123';
    query<HTMLButtonElement>('#btn-precheckout-proceed').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(navSpy).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_valid_123');
    expect(facade.isLoadingBilling()).toBe(true);
    facade.isLoadingBilling.set(false);
    expect(fakeBff.recordedCheckoutRequests[1]).toEqual({
      productId: 'TRIAL_TICKET_100',
      acceptedPurchaseDisclosure: true,
      acceptedAutoRenewalOptIn: true,
      confirmedAdultOrParentalConsent: true,
      euDigitalWaiverAccepted: true,
    });
  });

  it('supports keyboard tab navigation, Subscription FIFO/Portal/EU withdrawal, and History pagination + Safari-safe receipt', async () => {
    const navSpy = jest.spyOn(facade, 'navigateExternalUrl').mockImplementation(() => undefined);
    await facade.openBilling('PLANS');
    await fixture.whenStable();
    fixture.detectChanges();

    const plansTab = query<HTMLButtonElement>('#billing-tab-plans');
    const subTab = query<HTMLButtonElement>('#billing-tab-subscription');
    const historyTab = query<HTMLButtonElement>('#billing-tab-history');
    const focusSubSpy = jest.spyOn(subTab, 'focus');
    const focusHistorySpy = jest.spyOn(historyTab, 'focus');
    const focusPlansSpy = jest.spyOn(plansTab, 'focus');

    plansTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(focusSubSpy).toHaveBeenCalled();
    subTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }));
    expect(focusHistorySpy).toHaveBeenCalled();
    historyTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(focusPlansSpy).toHaveBeenCalled();
    subTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
    expect(focusPlansSpy).toHaveBeenCalledTimes(2);
    subTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    expect(focusPlansSpy).toHaveBeenCalledTimes(3);

    // Switch to Subscription Management tab
    fakeBff.phase2EuWithdrawalEligible = true;
    subTab.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(query<HTMLElement>('#sub-tier-value').textContent?.trim()).toBe(facade.t('tierStandardLabel'));
    expect(query<HTMLElement>('#sub-tier-value').getAttribute('data-tier')).toBe('STANDARD');
    expect(query<HTMLElement>('#sub-status-value').getAttribute('data-status')).toBe('ACTIVE');
    expect(query<HTMLElement>('#sub-daily-bucket-value').textContent).toContain('80 / 100');
    expect(query<HTMLElement>('#billing-expiring-lot-warning')).toBeTruthy();

    query<HTMLButtonElement>('#btn-portal-payment-method').click();
    await fixture.whenStable();
    expect(fakeBff.recordedPortalFlows).toContain('payment_method_update');
    expect(navSpy).toHaveBeenCalledWith('https://billing.stripe.com/p/session/bps_ok');
    expect(facade.isLoadingBilling()).toBe(true);
    facade.isLoadingBilling.set(false);
    fixture.detectChanges();

    // Phase 2 EEA withdrawal execution (2-step inline confirmation)
    query<HTMLButtonElement>('#btn-eu-withdrawal-sub').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(query<HTMLElement>('#eu-withdrawal-confirm-box')).toBeTruthy();
    query<HTMLButtonElement>('#btn-confirm-eu-withdrawal').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(query<HTMLElement>('#billing-status-banner').textContent).toContain('14');
    expect(facade.accountSummary()?.subscription.status).toBe('CANCELED');

    // Switch to Purchase History tab
    historyTab.click();
    await fixture.whenStable();
    fixture.detectChanges();

    const rowsText = fixture.nativeElement.textContent ?? '';
    expect(rowsText).toMatch(/[¥￥]1,400/);
    expect(rowsText).toContain('$3.50');

    // Cursor load more orders appends remaining rows cleanly
    query<HTMLButtonElement>('#btn-load-more-orders').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(facade.billingOrders()).toHaveLength(3);
    expect(fixture.nativeElement.querySelector('#btn-load-more-orders')).toBeNull();

    // Safari-safe synchronous popup pre-open BEFORE async receipt resolution
    const replaceSpy = jest.fn();
    const closeSpy = jest.fn();
    const popupSpy = jest.spyOn(facade, 'openBlankPopupWindow').mockReturnValue({
      closed: false,
      opener: window,
      location: { replace: replaceSpy } as unknown as Location,
      close: closeSpy,
    } as unknown as Window);

    query<HTMLButtonElement>('#btn-receipt-ch_ord_001').click();
    expect(popupSpy).toHaveBeenCalledTimes(1);
    await fixture.whenStable();
    expect(replaceSpy).toHaveBeenCalledWith('https://pay.stripe.com/receipts/ch_ord_001');

    // Failure closes pre-opened blank popup cleanly
    fakeBff.shouldFailReceipt = true;
    query<HTMLButtonElement>('#btn-receipt-ch_ord_001').click();
    await fixture.whenStable();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('handles PAST_DUE warning, low-quota nudge, 1500-char composer limit, analytics opt-out, and Withdrawal 502 / escape hatch', async () => {
    // 1. Composer 1500 char cap & 1200+ counter
    const input = query<HTMLTextAreaElement>('#chat-composer-input');
    input.value = 'a'.repeat(MAX_LOUNGE_COMPOSER_LENGTH + 50);
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(facade.composerDraft().length).toBe(MAX_LOUNGE_COMPOSER_LENGTH);
    expect(query<HTMLElement>('#composer-char-counter').textContent?.trim()).toBe('1500/1500');

    // 2. PAST_DUE warning banner and low-quota nudge
    facade.accountSummary.update((prev) =>
      prev
        ? {
            ...prev,
            subscription: {
              ...prev.subscription,
              status: 'PAST_DUE',
              remainingChatTurns: 2,
              dailyRemainingTurns: 2,
            },
          }
        : prev,
    );
    await fixture.whenStable();
    fixture.detectChanges();
    expect(query<HTMLElement>('#chat-past-due-banner')).toBeTruthy();
    expect(query<HTMLElement>('#chat-low-quota-nudge')).toBeTruthy();

    // 3. Analytics opt-out toggle in Options + rollback on failure
    facade.navigateTo('OPTIONS');
    await fixture.whenStable();
    fixture.detectChanges();

    const chkAnalytics = query<HTMLInputElement>('#chk-analytics-optin');
    expect(chkAnalytics.checked).toBe(true);
    chkAnalytics.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(facade.accountSummary()?.user.allowServiceImprovementAnalytics).toBe(false);

    fakeBff.shouldFailAnalyticsUpdate = true;
    chkAnalytics.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(facade.accountSummary()?.user.allowServiceImprovementAnalytics).toBe(false);
    expect(facade.errorMessage()).toBe(facade.t('errorGeneric'));
    facade.dismissError();

    // 4. Withdrawal Step 1 subscription-cancel escape hatch & Step 2 502 fail-closed alert
    facade.accountSummary.update((prev) =>
      prev ? { ...prev, subscription: { ...prev.subscription, status: 'ACTIVE' } } : prev,
    );
    facade.openDeleteAccountModal();
    await fixture.whenStable();
    fixture.detectChanges();

    query<HTMLButtonElement>('#btn-delete-manage-subscription').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(facade.deleteAccountStep()).toBe(0);
    expect(facade.activeView()).toBe('BILLING');
    expect(facade.billingTab()).toBe('SUBSCRIPTION');

    // Re-open deletion and test 502 STRIPE_CANCELLATION_FAILED stays open with alert
    fakeBff.shouldFailDeleteWith502 = true;
    facade.openDeleteAccountModal();
    facade.proceedToDeleteAccountStep2();
    facade.setDeleteConfirmIrreversible(true);
    facade.setDeleteConfirmNoRefund(true);
    await fixture.whenStable();
    fixture.detectChanges();

    query<HTMLButtonElement>('#btn-confirm-delete-account').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(facade.deleteAccountStep()).toBe(2);
    expect(query<HTMLElement>('#delete-stripe-error-banner')).toBeTruthy();
  });

  it('verifies checkout success (including autoRefundedConflict) and portal_return=1 redirects on startup', async () => {
    fakeBff.autoRefundOnVerify = true;
    window.history.replaceState({}, '', '/?checkout=success&session_id=cs_test_abc123');
    await facade.initializeLounge();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(facade.activeView()).toBe('BILLING');
    expect(facade.billingBannerNotice()?.tone).toBe('warning');
    expect(window.location.search).toBe('');

    window.history.replaceState({}, '', '/?portal_return=1');
    await facade.initializeLounge();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(facade.activeView()).toBe('BILLING');
    expect(facade.billingTab()).toBe('SUBSCRIPTION');
    expect(facade.accountSummary()?.subscription.status).toBe('CANCELING');

    window.history.replaceState({}, '', '/?checkout=cancel');
    await facade.initializeLounge();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(facade.activeView()).toBe('BILLING');
    expect(facade.billingTab()).toBe('PLANS');
  });

  it('covers Standard & Charge modals, empty/all order statuses, error guards, and popup blockers', async () => {
    const navSpy = jest.spyOn(facade, 'navigateExternalUrl').mockImplementation(() => undefined);

    // 1. Make STANDARD_MONTHLY & TRIAL_ALREADY_USED selectable, test subscription modal & cancel button
    fakeBff.catalog = {
      ...fakeBff.catalog,
      products: fakeBff.catalog.products.map((p) => {
        if (p.productId === 'TRIAL_TICKET_100') {
          return { ...p, eligible: false, ineligibleReason: 'TRIAL_ALREADY_USED' };
        }
        if (p.productId === 'STANDARD_MONTHLY') {
          return { ...p, eligible: true, ineligibleReason: undefined };
        }
        return p;
      }),
    };
    await facade.openBilling('PLANS');
    await fixture.whenStable();
    fixture.detectChanges();

    // Suspended dispute banner check
    facade.accountSummary.update((prev) =>
      prev ? { ...prev, user: { ...prev.user, status: 'SUSPENDED' } } : prev,
    );
    fixture.detectChanges();
    expect(query<HTMLElement>('#billing-dispute-blocked-banner')).toBeTruthy();

    facade.accountSummary.update((prev) =>
      prev ? { ...prev, user: { ...prev.user, status: 'ACTIVE' } } : prev,
    );
    fixture.detectChanges();

    // Open STANDARD_MONTHLY PreCheckoutModal & cancel via button
    query<HTMLButtonElement>('#btn-select-product-STANDARD_MONTHLY').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(query<HTMLElement>('#precheckout-total-price').textContent).toContain('/月');
    query<HTMLButtonElement>('#btn-precheckout-cancel').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(facade.selectedCheckoutProduct()).toBeNull();

    // Open CHARGE_TICKET_100 & verify one-time purchase submission
    query<HTMLButtonElement>('#btn-select-product-CHARGE_TICKET_100').click();
    await fixture.whenStable();
    fixture.detectChanges();
    query<HTMLInputElement>('#chk-precheckout-disclosure').click();
    query<HTMLInputElement>('#chk-precheckout-autorenew').click();
    query<HTMLInputElement>('#chk-precheckout-adult').click();
    fixture.detectChanges();
    fakeBff.nextCheckoutUrl = 'https://checkout.stripe.com/c/pay/cs_charge_1';
    query<HTMLButtonElement>('#btn-precheckout-proceed').click();
    await fixture.whenStable();
    expect(navSpy).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_charge_1');
    expect(facade.isLoadingBilling()).toBe(true);
    facade.isLoadingBilling.set(false);
    fixture.detectChanges();

    // 2. Render all 6 order statuses + WELCOME_BONUS_20 + UNKNOWN in History tab
    fakeBff.allOrders = [
      ...fakeBff.allOrders,
      {
        chargeId: 'ch_ord_004',
        productId: 'UNKNOWN',
        status: 'DISPUTED',
        amountMinor: 500,
        refundedAmountMinor: 0,
        currency: 'JPY',
        createdAt: '2026-11-21T01:00:00.000Z',
        receiptAvailable: true,
      },
      {
        chargeId: 'ch_ord_005',
        productId: 'CHARGE_TICKET_100',
        status: 'FAILED',
        amountMinor: 500,
        refundedAmountMinor: 0,
        currency: 'JPY',
        createdAt: 'bad-iso-date',
        receiptAvailable: false,
      },
      {
        chargeId: 'ch_ord_006',
        productId: 'CHARGE_TICKET_100',
        status: 'PENDING',
        amountMinor: 500,
        refundedAmountMinor: 0,
        currency: 'JPY',
        createdAt: '2026-11-20T01:00:00.000Z',
        receiptAvailable: true,
      },
    ];
    await facade.selectBillingTab('HISTORY');
    await fixture.whenStable();
    fixture.detectChanges();
    await facade.loadMoreOrders();
    await fixture.whenStable();
    fixture.detectChanges();

    // Verify popup blocker fallback when window.open returns null
    jest.spyOn(facade, 'openBlankPopupWindow').mockReturnValue(null);
    fakeBff.nextReceiptUrl = 'https://pay.stripe.com/receipts/fallback_1';
    query<HTMLButtonElement>('#btn-receipt-ch_ord_001').click();
    await fixture.whenStable();
    expect(navSpy).toHaveBeenCalledWith('https://pay.stripe.com/receipts/fallback_1');

    // Verify empty orders state & Subscription tab helpers
    fakeBff.allOrders = [];
    await facade.selectBillingTab('HISTORY');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(query<HTMLElement>('#billing-orders-empty')).toBeTruthy();

    // Guard validations on facade methods
    await expect(
      facade.submitCheckout({
        acceptedPurchaseDisclosure: false,
        acceptedAutoRenewalOptIn: true,
        confirmedAdultOrParentalConsent: true,
      }),
    ).resolves.toBeUndefined();
    facade.selectedCheckoutProduct.set(fakeBff.catalog.products[1]);
    await expect(
      facade.submitCheckout({
        acceptedPurchaseDisclosure: false,
        acceptedAutoRenewalOptIn: true,
        confirmedAdultOrParentalConsent: true,
      }),
    ).rejects.toThrow('required pre-checkout disclosures');
    facade.selectedCheckoutProduct.set(null);

    fakeBff.nextPortalUrl = 'https://untrusted.example/portal';
    await facade.openCustomerPortal('default');
    expect(facade.errorMessage()).toBe(facade.t('errorUntrustedRedirectUrl'));
    expect(facade.isLoadingBilling()).toBe(false);
    facade.dismissError();

    // Non-502 error in confirmDeleteAccount surfaces localized errorMessage
    fakeBff.shouldFailDeleteWith502 = false;
    jest.spyOn(fakeBff, 'deleteAccount').mockRejectedValueOnce(new Error('DB transient error'));
    facade.openDeleteAccountModal();
    facade.proceedToDeleteAccountStep2();
    facade.setDeleteConfirmIrreversible(true);
    facade.setDeleteConfirmNoRefund(true);
    await facade.confirmDeleteAccount();
    expect(facade.errorMessage()).toBe(facade.t('errorGeneric'));
    expect(facade.navigateTo('CHAT')).toBeUndefined();
    await fixture.whenStable();
    fixture.detectChanges();
    const chatView = fixture.debugElement.query(
      By.directive(ChatViewComponent),
    ).componentInstance as ChatViewComponent;
    expect(chatView.formatResetTimestamp(undefined)).toBe('');
    expect(chatView.formatResetTimestamp('invalid-iso')).toBe('');

    // Cover real openBlankPopupWindow(), error branches, and geo-blocked banner
    const originalOpen = window.open;
    const mockPopup = { opener: window, closed: false, close: jest.fn(), location: { replace: jest.fn() } };
    const openSpy = jest.spyOn(facade, 'openBlankPopupWindow');
    openSpy.mockRestore();
    try {
      window.open = jest.fn(() => mockPopup as unknown as Window);
      expect(facade.openBlankPopupWindow()).toBeTruthy();
      expect(mockPopup.opener).toBeNull();
    } finally {
      window.open = originalOpen;
    }

    jest.spyOn(facade, 'openBlankPopupWindow').mockReturnValue(mockPopup as unknown as Window);
    fakeBff.nextReceiptUrl = 'https://evil.example/bad-receipt';
    await facade.openOrderReceipt('ch_ord_001');
    expect(facade.errorMessage()).toBe(facade.t('errorUntrustedRedirectUrl'));

    await facade.openOrderReceipt('   ');
    jest.spyOn(fakeBff, 'getCatalog').mockRejectedValueOnce(new Error('Catalog outage'));
    await facade.selectBillingTab('PLANS');
    expect(facade.errorMessage()).toBe(facade.t('errorGeneric'));

    fakeBff.catalog = {
      ...fakeBff.catalog,
      isEeaResident: true,
      phase2EeaEnabled: false,
      products: fakeBff.catalog.products.map((p) => ({
        ...p,
        eligible: false,
        ineligibleReason: 'GEO_BLOCKED',
      })),
    };
    await facade.openBilling('PLANS');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(query<HTMLElement>('#billing-geo-blocked-banner')).toBeTruthy();

    // Test CANCELING banner & empty activeLots branch in Subscription tab
    const detailSpy = jest.spyOn(fakeBff, 'getSubscriptionDetail').mockResolvedValueOnce({
      subscription: { ...fakeBff.subscription, status: 'CANCELING', cancelAtPeriodEnd: true },
      quotaBreakdown: {
        dailyTurnQuota: 100,
        dailyRemainingTurns: 50,
        purchasedRemainingTurns: 0,
        remainingChatTurns: 50,
        activeLots: [],
        nextDailyResetAt: '2026-11-25T00:00:00.000Z',
        consumptionOrder: ['DAILY', 'LOT_FIFO'],
      },
    });
    await facade.selectBillingTab('SUBSCRIPTION');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(query<HTMLElement>('#billing-canceling-notice')).toBeTruthy();
    detailSpy.mockRestore();

    // Cover native <dialog> showModal / cancel / close cycle cleanly
    fakeBff.catalog = {
      ...fakeBff.catalog,
      isEeaResident: false,
      phase2EeaEnabled: false,
      products: fakeBff.catalog.products.map((p) =>
        p.productId === 'CHARGE_TICKET_100'
          ? { ...p, eligible: true, ineligibleReason: undefined }
          : p,
      ),
    };
    await facade.openBilling('PLANS');
    await fixture.whenStable();
    fixture.detectChanges();
    const dialogEl = query<HTMLDialogElement>('#precheckout-dialog');
    query<HTMLButtonElement>('#btn-select-product-CHARGE_TICKET_100').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(dialogEl.hasAttribute('open')).toBe(true);
    query<HTMLButtonElement>('#btn-precheckout-cancel').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(dialogEl.hasAttribute('open')).toBe(false);

    // Early guard & non-portal/branch coverage in Facade & AppComponent
    await facade.submitEuWithdrawal({
      targetType: 'SUBSCRIPTION',
      targetId: 'uid_billing_001',
      confirmedWithdrawal: true,
    });
    facade.isLoadingBilling.set(true);
    await facade.openCustomerPortal('default');
    facade.isLoadingBilling.set(false);
    facade.billingOrdersHasMore.set(false);
    await facade.loadMoreOrders();
    facade.billingOrdersHasMore.set(true);
    facade.billingOrdersNextCursor.set(null);
    await facade.loadMoreOrders();

    // Test non-HTMLInputElement/TextArea event guards on extracted view/modal components
    facade.navigateTo('OPTIONS');
    await fixture.whenStable();
    fixture.detectChanges();
    const optionsView = fixture.debugElement.query(
      By.directive(OptionsViewComponent),
    ).componentInstance as OptionsViewComponent;
    optionsView.onAnalyticsOptInChange(new Event('change'));

    facade.navigateTo('CHAT');
    await fixture.whenStable();
    fixture.detectChanges();
    const chatViewGuard = fixture.debugElement.query(
      By.directive(ChatViewComponent),
    ).componentInstance as ChatViewComponent;
    chatViewGuard.onComposerInput(new Event('input'));

    const deleteModalGuard = fixture.debugElement.query(
      By.directive(DeleteAccountModalComponent),
    ).componentInstance as DeleteAccountModalComponent;
    deleteModalGuard.onDeleteIrreversibleChange(new Event('change'));
    deleteModalGuard.onDeleteNoRefundChange(new Event('change'));

    const entranceGuard = TestBed.runInInjectionContext(() => new EntranceViewComponent());
    entranceGuard.onConsentChange(new Event('change'));
    component.onLanguageChange('invalid-lang');
    component.onTimezoneChange('Invalid/TZ');

    jest.spyOn(fakeBff, 'createPortal').mockRejectedValueOnce(new Error('Portal failed'));
    await facade.openCustomerPortal('subscription_cancel');
    expect(facade.errorMessage()).toBe(facade.t('errorGeneric'));

    jest.spyOn(fakeBff, 'withdrawEu').mockRejectedValueOnce(new Error('EU withdrawal failed'));
    await facade.submitEuWithdrawal({
      targetType: 'SUBSCRIPTION',
      targetId: 'uid_billing_001',
      confirmedWithdrawal: true,
    });
    expect(facade.errorMessage()).toBe(facade.t('errorGeneric'));

    jest.spyOn(fakeBff, 'listOrders').mockRejectedValueOnce(new Error('Orders cursor failed'));
    facade.billingOrdersHasMore.set(true);
    facade.billingOrdersNextCursor.set('ch_ord_001');
    await facade.loadMoreOrders();
    expect(facade.errorMessage()).toBe(facade.t('errorGeneric'));

    // Verify checkout verify failure and non-autoRefund success path
    fakeBff.autoRefundOnVerify = false;
    window.history.replaceState({}, '', '/?checkout=success&session_id=cs_test_ok_2');
    await facade.initializeLounge();
    expect(facade.billingBannerNotice()?.tone).toBe('success');

    jest.spyOn(fakeBff, 'verifyCheckout').mockRejectedValueOnce(new Error('Verify down'));
    window.history.replaceState({}, '', '/?checkout=success&session_id=cs_test_bad');
    await facade.initializeLounge();
    expect(facade.errorMessage()).toBe(facade.t('errorGeneric'));

    jest.spyOn(fakeBff, 'getSubscriptionDetail').mockRejectedValueOnce(new Error('Portal sync down'));
    window.history.replaceState({}, '', '/?portal_return=1');
    await facade.initializeLounge();
    expect(facade.errorMessage()).toBe(facade.t('errorGeneric'));

    // Guard when accountSummary is null during setAnalyticsOptIn
    facade.accountSummary.set(null);
    await facade.setAnalyticsOptIn(false);

    // Toggle sidebar + navigate via Sidebar #nav-btn-billing and dismiss banner
    facade.toggleSidebar(true);
    await fixture.whenStable();
    fixture.detectChanges();
    query<HTMLButtonElement>('#nav-btn-billing').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(facade.activeView()).toBe('BILLING');
    facade.dismissBillingBanner();
    expect(facade.billingBannerNotice()).toBeNull();
  }, 15000);

  it('covers non-Error billing rejections, closed popup/readonly opener, retained query params, and PreCheckoutModal guards', async () => {
    // Re-hydrate valid summary first if cleared
    window.history.replaceState({}, '', '/');
    await facade.initializeLounge();
    await fixture.whenStable();

    // Non-eligible openPreCheckoutModal no-op
    facade.openPreCheckoutModal({ ...fakeBff.catalog.products[0], eligible: false });
    expect(facade.selectedCheckoutProduct()).toBeNull();

    // selectBillingTab early guard when accountSummary missing
    const savedSummary = facade.accountSummary();
    facade.accountSummary.set(null);
    await facade.selectBillingTab('SUBSCRIPTION');
    facade.accountSummary.set(savedSummary);

    // Non-Error rejections across facade billing actions + readonly popup.opener
    const originalOpen = window.open;
    try {
      const readOnlyPopup = {
        closed: false,
        get opener() {
          return window;
        },
        set opener(_v: unknown) {
          throw new TypeError('readonly opener');
        },
        close: jest.fn(),
        location: { replace: jest.fn() },
      };
      window.open = jest.fn(() => readOnlyPopup as unknown as Window);
      jest.spyOn(facade, 'openBlankPopupWindow').mockRestore();
      expect(facade.openBlankPopupWindow()).toBeTruthy();

      readOnlyPopup.closed = true;
      jest.spyOn(fakeBff, 'getOrderReceipt').mockRejectedValueOnce('raw receipt failure');
      await facade.openOrderReceipt('ch_ord_001');
      expect(facade.errorMessage()).toBe(facade.t('errorGeneric'));

      jest.spyOn(fakeBff, 'getOrderReceipt').mockResolvedValueOnce({
        receiptUrl: 'https://pay.stripe.com/receipts/closed_fallback',
      });
      const navSpy = jest.spyOn(facade, 'navigateExternalUrl').mockImplementation(() => undefined);
      await facade.openOrderReceipt('ch_ord_001');
      expect(navSpy).toHaveBeenCalledWith('https://pay.stripe.com/receipts/closed_fallback');
    } finally {
      window.open = originalOpen;
    }

    facade.selectedCheckoutProduct.set(fakeBff.catalog.products[1]);
    jest.spyOn(fakeBff, 'createCheckout').mockRejectedValueOnce('raw checkout failure');
    await facade.submitCheckout({
      acceptedPurchaseDisclosure: true,
      acceptedAutoRenewalOptIn: true,
      confirmedAdultOrParentalConsent: true,
    });
    expect(facade.errorMessage()).toBe(facade.t('errorGeneric'));

    jest.spyOn(fakeBff, 'createPortal').mockRejectedValueOnce('raw portal failure');
    await facade.openCustomerPortal('default');
    expect(facade.errorMessage()).toBe(facade.t('errorGeneric'));

    facade.billingOrdersHasMore.set(true);
    facade.billingOrdersNextCursor.set('ch_ord_001');
    jest.spyOn(fakeBff, 'listOrders').mockRejectedValueOnce('raw orders failure');
    await facade.loadMoreOrders();
    expect(facade.errorMessage()).toBe(facade.t('errorGeneric'));

    jest.spyOn(fakeBff, 'listOrders').mockResolvedValueOnce({
      orders: fakeBff.allOrders.slice(0, 1), // duplicate ID triggers deduplication branch
      nextCursor: null,
      hasMore: false,
    });
    facade.billingOrders.set(fakeBff.allOrders.slice(0, 1));
    await facade.loadMoreOrders();
    expect(facade.billingOrders()).toHaveLength(1);

    jest.spyOn(fakeBff, 'withdrawEu').mockRejectedValueOnce('raw withdrawal failure');
    await facade.submitEuWithdrawal({
      targetType: 'SUBSCRIPTION',
      targetId: 'uid_billing_001',
      confirmedWithdrawal: true,
    });
    expect(facade.errorMessage()).toBe(facade.t('errorGeneric'));

    jest.spyOn(fakeBff, 'getSubscriptionDetail').mockRejectedValueOnce('raw load failure');
    await facade.selectBillingTab('SUBSCRIPTION');
    expect(facade.errorMessage()).toBe(facade.t('errorGeneric'));

    // Retain ?emuXUser across billing redirect cleanup + strip checkout & transient params + non-Error verify/portal fail
    window.history.replaceState(
      {},
      '',
      '/?checkout=cancel&transientParam=drop&emuXUser=x_keep_1',
    );
    await facade.initializeLounge();
    expect(window.location.search).not.toContain('transientParam');
    expect(window.location.search).toContain('emuXUser=x_keep_1');
    expect(window.location.search).not.toContain('checkout=cancel');

    jest.spyOn(fakeBff, 'verifyCheckout').mockRejectedValueOnce('raw verify err');
    window.history.replaceState({}, '', '/?checkout=success&session_id=cs_x');
    await facade.initializeLounge();
    expect(facade.errorMessage()).toBe(facade.t('errorGeneric'));

    jest.spyOn(fakeBff, 'getSubscriptionDetail').mockRejectedValueOnce('raw portal err');
    window.history.replaceState({}, '', '/?portal_return=1');
    await facade.initializeLounge();
    expect(facade.errorMessage()).toBe(facade.t('errorGeneric'));

    // Standalone PreCheckoutModalComponent edge guards when product is null & non-input change events
    const { PreCheckoutModalComponent } = await import(
      '../pre-checkout-modal/pre-checkout-modal.component'
    );
    const modalFixture = TestBed.createComponent(PreCheckoutModalComponent);
    const modalCmp = modalFixture.componentInstance;
    modalFixture.detectChanges();
    expect(modalCmp.productTitle()).toBe('');
    expect(modalCmp.formattedTotalPrice()).toBe('');
    modalCmp.onDisclosureChange(new Event('change'));
    modalCmp.onAutoRenewChange(new Event('change'));
    modalCmp.onAdultConsentChange(new Event('change'));
    modalCmp.onEuWaiverChange(new Event('change'));
    await modalCmp.proceed();
    modalCmp.cancel();

    // Anti-flicker loading grid (no premature .product-disabled), Coming Soon lock card, and HISTORY loading state
    facade.billingCatalog.set(null);
    facade.isLoadingBilling.set(true);
    facade.billingOrders.set([]);
    fixture.detectChanges();
    expect(query<HTMLElement>('#billing-products-loading-grid')).toBeTruthy();
    expect(fixture.nativeElement.querySelectorAll('.product-disabled').length).toBe(0);
    expect(fixture.nativeElement.querySelectorAll('.btn-loading .btn-spinner').length).toBe(3);
    expect(fixture.nativeElement.querySelector('#billing-orders-loading')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('#billing-orders-empty')).toBeNull();

    // Unconfigured / Coming Soon product renders .product-disabled (never recommended glow) + lock CTA
    facade.isLoadingBilling.set(false);
    facade.billingCatalog.set({
      ...fakeBff.catalog,
      products: fakeBff.catalog.products.map((p) =>
        p.productId === 'STANDARD_MONTHLY'
          ? { ...p, available: false, eligible: false, ineligibleReason: 'COMING_SOON' }
          : p,
      ),
    });
    fixture.detectChanges();
    const stdCard = query<HTMLElement>('#product-card-STANDARD_MONTHLY');
    expect(stdCard.classList.contains('product-disabled')).toBe(true);
    expect(stdCard.classList.contains('product-recommended')).toBe(false);
    const stdBtn = query<HTMLButtonElement>('#btn-select-product-STANDARD_MONTHLY');
    expect(stdBtn.disabled).toBe(true);
    expect(stdBtn.textContent).toContain('準備中');
    const stdProduct = facade
      .billingCatalog()
      ?.products.find((p) => p.productId === 'STANDARD_MONTHLY');
    if (!stdProduct) {
      throw new Error('Expected STANDARD_MONTHLY product fixture');
    }
    facade.openPreCheckoutModal(stdProduct);
    expect(facade.selectedCheckoutProduct()).toBeNull();

    // Catalog fetch failure (billingCatalog === null & not loading) falls back to 3 Coming Soon cards
    facade.billingCatalog.set(null);
    fixture.detectChanges();
    expect(query<HTMLElement>('#billing-products-fallback-grid')).toBeTruthy();
    expect(
      fixture.nativeElement.querySelectorAll('#billing-products-fallback-grid .product-disabled')
        .length,
    ).toBe(3);
  });

  it('enforces ACTIVE status and 14-day statutory window boundaries in isEligibleCreditLotWithdrawal()', () => {
    const billingFixture = TestBed.createComponent(BillingHubComponent);
    const billingCmp = billingFixture.componentInstance;
    const baseTimeMs = Date.parse('2026-11-15T00:00:00.000Z');
    const activeLot: LoungeCreditLot = {
      id: 'lot_withdraw_1',
      uid: 'uid_billing_001',
      productId: 'CHARGE_TICKET_100',
      isPaid: true,
      initialTurns: 100,
      remainingTurns: 100,
      currency: 'EUR',
      unitAmount: 350,
      status: 'ACTIVE',
      purchasedAt: '2026-11-01T00:00:00.000Z',
      expiresAt: '2027-04-30T00:00:00.000Z',
    };

    // Exact 14-day boundary -> eligible
    expect(billingCmp.isEligibleCreditLotWithdrawal(activeLot, true, baseTimeMs)).toBe(true);
    // Within 14 days -> eligible
    expect(
      billingCmp.isEligibleCreditLotWithdrawal(
        { ...activeLot, purchasedAt: '2026-11-10T00:00:00.000Z' },
        true,
        baseTimeMs,
      ),
    ).toBe(true);
    // 15 days old (1ms past 14 days) -> ineligible
    expect(billingCmp.isEligibleCreditLotWithdrawal(activeLot, true, baseTimeMs + 1)).toBe(false);
    // Non-ACTIVE status -> ineligible
    expect(
      billingCmp.isEligibleCreditLotWithdrawal(
        { ...activeLot, status: 'EXPIRED', purchasedAt: '2026-11-10T00:00:00.000Z' },
        true,
        baseTimeMs,
      ),
    ).toBe(false);
    // Invalid purchasedAt timestamp -> ineligible
    expect(
      billingCmp.isEligibleCreditLotWithdrawal(
        { ...activeLot, purchasedAt: 'not-a-timestamp' },
        true,
        baseTimeMs,
      ),
    ).toBe(false);
  });
});
