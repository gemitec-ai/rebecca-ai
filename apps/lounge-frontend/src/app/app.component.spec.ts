import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import type {
  LOUNGE_ERROR_CODE_DISCLAIMER_RECONSENT_REQUIRED,
  LoungeAccountSummaryDto,
  LoungeAuthSessionDto,
  LoungeDeleteAccountRequestDto,
  LoungeEmotionState,
  LoungeGalleryItem,
  LoungeGalleryListResponseDto,
  LoungeLanguage,
  LoungeMessage,
  LoungeMessageListResponseDto,
  LoungePaginationQueryDto,
  LoungePersonaBranding,
  LoungeSendMessageResponseDto,
  LoungeSession,
  LoungeUser,
} from '@rebecca/types';
import { AppComponent } from './app.component';
import { appConfig } from './app.config';
import {
  LoungeBffAdapter,
  LoungeReconsentRequiredClientError,
} from './core/adapters/lounge-bff.adapter';
import {
  detectInitialLoungeLanguage,
  detectInitialLoungeTimezone,
  LOUNGE_TRANSLATIONS,
} from './core/i18n/lounge-translations';
import { LoungeAccountPort } from './core/ports/lounge-account.port';
import { LoungeAuthPort } from './core/ports/lounge-auth.port';
import { LoungeConfigPort } from './core/ports/lounge-config.port';
import { LoungeGalleryPort } from './core/ports/lounge-gallery.port';
import { LoungeSessionPort } from './core/ports/lounge-session.port';
import { LoungeFacadeService } from './core/services/lounge-facade.service';
import { LoungeDropdownComponent } from './shared/components/lounge-dropdown/lounge-dropdown.component';
import { LoungePaginationComponent } from './shared/components/lounge-pagination/lounge-pagination.component';
import { ReconsentModalComponent } from './shared/components/reconsent-modal/reconsent-modal.component';

const SYNTHETIC_BRANDING: LoungePersonaBranding = {
  displayName: 'レベッカ',
  englishName: 'Rebecca',
  brandName: 'Gemitec Lounge',
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
};

function createSyntheticUser(
  language: LoungeLanguage = 'ja',
  timezone = 'Asia/Tokyo',
  onboardingCompleted = true,
  disclaimerVersion = 1,
): LoungeUser {
  const now = '2026-11-22T12:00:00.000Z';
  return {
    uid: 'uid_test_001',
    xUserId: '1000000001',
    xHandle: '@example_user',
    displayName: 'Example Member',
    avatarUrl: 'assets/gemitec_icon.svg',
    status: 'ACTIVE',
    language,
    timezone,
    onboardingCompleted,
    allowServiceImprovementAnalytics: true,
    disclaimerConsent: {
      disclaimerVersion,
      agreedToGeminiTrainingUsage: true,
      agreedToZeroPiiProhibition: true,
      agreedToOneWayMemoryIsolation: true,
      scrolledToBottomAt: now,
      consentedAt: now,
    },
    createdAt: now,
    updatedAt: now,
    lastLoginAt: now,
  };
}

class InMemoryLoungeBffFake
  implements
    LoungeConfigPort,
    LoungeAuthPort,
    LoungeAccountPort,
    LoungeSessionPort,
    LoungeGalleryPort
{
  public user = createSyntheticUser();
  public currentSessionUser: LoungeUser | null = null;
  public shouldFailGetCurrentSession = false;
  public remainingTurns = 5;
  public dailyTurnQuota = 10;
  public omitPersonaOnSummary = false;
  public shouldFailConfig = false;
  public shouldFailLogin = false;
  public shouldFailSignUp = false;
  public shouldFailPreferences = false;
  public shouldFailReconsent = false;
  public shouldFailDelete = false;
  public shouldFailSend = false;
  public shouldFailLogout = false;
  public shouldFailListMessages = false;
  public shouldFailListGallery = false;
  public simulatedMidSessionRequiredVersion?: number;
  public deleteRequests: LoungeDeleteAccountRequestDto[] = [];
  public lastRequestedLanguage?: LoungeLanguage;
  public lastRequestedTimezone?: string;

  public session: LoungeSession = {
    id: 'uid_test_001',
    uid: 'uid_test_001',
    title: 'Private Lounge',
    messageCount: 2,
    currentEmotion: 'SURPRISED',
    publicXMemorySyncedAt: '2026-11-22T12:00:00.000Z',
    lastMessagePreview: 'おはよう',
    createdAt: '2026-11-22T12:00:00.000Z',
    updatedAt: '2026-11-22T12:05:00.000Z',
  };

  public messages: LoungeMessage[] = [
    {
      id: 'msg_init_u',
      sessionId: 'uid_test_001',
      uid: 'uid_test_001',
      role: 'USER',
      content: 'こんにちは',
      emotion: 'NEUTRAL',
      createdAt: '2026-11-22T12:01:00.000Z',
    },
    {
      id: 'msg_init_a',
      sessionId: 'uid_test_001',
      uid: 'uid_test_001',
      role: 'ASSISTANT',
      content: 'おっ、来たじゃん！',
      emotion: 'SURPRISED',
      imageAssetId: 'bot_img_01',
      imageUrl: 'assets/gallery_morning.webp',
      createdAt: '2026-11-22T12:02:00.000Z',
    },
  ];

  public galleryItems: LoungeGalleryItem[] = [
    {
      id: 'uid_test_001_bot_img_01',
      uid: 'uid_test_001',
      assetId: 'bot_img_01',
      imageUrl: 'assets/gallery_morning.webp',
      unlocked: true,
      unlockedAt: '2026-11-22T12:02:00.000Z',
      sourceSessionId: 'uid_test_001',
    },
    {
      id: 'uid_test_001_bot_img_02',
      uid: 'uid_test_001',
      assetId: 'bot_img_02',
      imageUrl: '',
      unlocked: false,
    },
  ];

  public async getRuntimeConfig() {
    if (this.shouldFailConfig) {
      throw new Error('Config unreachable');
    }
    return {
      appVersion: '1.45.2',
      disclaimerVersion: 1,
      persona: SYNTHETIC_BRANDING,
    };
  }

  public async getCurrentSession(): Promise<LoungeAuthSessionDto | null> {
    if (this.shouldFailGetCurrentSession) {
      throw new Error('Session endpoint unavailable');
    }
    if (!this.currentSessionUser) {
      return null;
    }
    return {
      user: this.currentSessionUser,
      appVersion: 'v1.45.2',
      issuedAt: this.currentSessionUser.lastLoginAt,
    };
  }

  public async loginWithX(): Promise<LoungeAuthSessionDto> {
    if (this.shouldFailLogin) {
      throw new Error('X login rejected');
    }
    this.currentSessionUser = this.user;
    return {
      user: this.user,
      appVersion: 'v1.45.2',
      issuedAt: '2026-11-22T12:00:00.000Z',
    };
  }

  public async signUpWithX(req: {
    language?: LoungeLanguage;
    timezone?: string;
  }): Promise<LoungeAuthSessionDto> {
    if (this.shouldFailSignUp) {
      throw new Error('Sign-up rejected by server');
    }
    this.user = createSyntheticUser(
      req.language ?? this.user.language,
      req.timezone ?? this.user.timezone,
      false,
      1,
    );
    this.currentSessionUser = this.user;
    return {
      user: this.user,
      appVersion: 'v1.45.2',
      issuedAt: '2026-11-22T12:00:00.000Z',
    };
  }

  public async logout(): Promise<void> {
    if (this.shouldFailLogout) {
      throw new Error('Logout endpoint unavailable');
    }
    this.currentSessionUser = null;
  }

  public async getAccountSummary(): Promise<LoungeAccountSummaryDto> {
    const activeUser = this.currentSessionUser ?? this.user;
    return {
      user: activeUser,
      subscription: {
        uid: this.user.uid,
        tier: 'STANDARD',
        status: 'ACTIVE',
        billingCurrency: 'JPY',
        dailyTurnQuota: this.dailyTurnQuota,
        dailyRemainingTurns: this.remainingTurns,
        purchasedRemainingTurns: 0,
        remainingChatTurns: this.remainingTurns,
        earliestLotExpiresAt: null,
        lastDailyResetAt: '2026-11-22T00:00:00.000Z',
        lastQuotaResetTimezone: 'Asia/Tokyo',
        nextDailyResetAt: '2026-11-23T00:00:00.000Z',
        currentPeriodEnd: '2026-12-22T00:00:00.000Z',
        trialTicketUsed: false,
        cancelAtPeriodEnd: false,
        updatedAt: '2026-11-22T12:00:00.000Z',
      },
      ...(this.omitPersonaOnSummary ? {} : { persona: SYNTHETIC_BRANDING }),
      unlockedGalleryCount: this.galleryItems.filter((item) => item.unlocked).length,
      totalGalleryCount: this.galleryItems.length,
      appVersion: 'v1.45.2',
    };
  }

  public async updatePreferences(req: {
    language?: LoungeLanguage;
    timezone?: string;
    completeOnboarding?: boolean;
  }): Promise<LoungeUser> {
    if (this.shouldFailPreferences) {
      throw new Error('Failed to persist preferences');
    }
    if (req.language !== undefined) {
      this.lastRequestedLanguage = req.language;
    }
    if (req.timezone !== undefined) {
      this.lastRequestedTimezone = req.timezone;
    }
    this.user = {
      ...this.user,
      language: req.language ?? this.user.language,
      timezone: req.timezone ?? this.user.timezone,
      onboardingCompleted:
        req.completeOnboarding !== undefined
          ? req.completeOnboarding
          : this.user.onboardingCompleted,
    };
    this.currentSessionUser = this.user;
    return this.user;
  }

  public async updateDisclaimerConsent(req: {
    disclaimerConsent: LoungeUser['disclaimerConsent'];
  }): Promise<LoungeUser> {
    if (this.shouldFailReconsent) {
      throw new Error('Consent update temporarily unavailable');
    }
    this.user = {
      ...this.user,
      disclaimerConsent: req.disclaimerConsent,
    };
    this.currentSessionUser = this.user;
    return this.user;
  }

  public async deleteAccount(req: LoungeDeleteAccountRequestDto): Promise<void> {
    if (this.shouldFailDelete) {
      throw new Error('Account deletion temporarily unavailable');
    }
    this.deleteRequests.push(req);
  }

  public async getSession(): Promise<LoungeSession> {
    return this.session;
  }

  public async listMessages(
    query?: LoungePaginationQueryDto,
  ): Promise<LoungeMessageListResponseDto> {
    if (this.shouldFailListMessages) {
      throw new Error('Failed to load conversation history');
    }
    const rawLimit = query?.limit;
    const limit =
      typeof rawLimit === 'number' && Number.isFinite(rawLimit)
        ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100)
        : 20;
    const totalItems = this.messages.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / limit));

    if (query?.cursor) {
      const cursorIndex = this.messages.findIndex((msg) => msg.id === query.cursor);
      if (cursorIndex <= 0) {
        return {
          data: [],
          meta: {
            currentPage: totalPages,
            limit,
            totalItems,
            totalPages,
            nextCursor: null,
            hasMore: false,
          },
        };
      }
      const startIdx = Math.max(0, cursorIndex - limit);
      const data = this.messages.slice(startIdx, cursorIndex);
      const hasMore = startIdx > 0;
      const nextCursor = hasMore && data.length > 0 ? data[0].id : null;
      const page =
        totalItems === 0 ? 1 : Math.min(totalPages, Math.ceil((totalItems - startIdx) / limit));
      return {
        data,
        meta: { currentPage: page, limit, totalItems, totalPages, nextCursor, hasMore },
      };
    }

    const rawPage = query?.page;
    const page =
      typeof rawPage === 'number' && Number.isFinite(rawPage)
        ? Math.max(1, Math.trunc(rawPage))
        : 1;
    const endIdx = Math.max(0, totalItems - (page - 1) * limit);
    const startIdx = Math.max(0, endIdx - limit);
    const data = this.messages.slice(startIdx, endIdx);
    const hasMore = startIdx > 0;
    const nextCursor = hasMore && data.length > 0 ? data[0].id : null;
    return {
      data,
      meta: { currentPage: page, limit, totalItems, totalPages, nextCursor, hasMore },
    };
  }

  public async sendMessage(req: { content: string }): Promise<LoungeSendMessageResponseDto> {
    if (
      this.simulatedMidSessionRequiredVersion !== undefined &&
      this.user.disclaimerConsent.disclaimerVersion < this.simulatedMidSessionRequiredVersion
    ) {
      const code: typeof LOUNGE_ERROR_CODE_DISCLAIMER_RECONSENT_REQUIRED =
        'DISCLAIMER_RECONSENT_REQUIRED';
      throw {
        code,
        requiredDisclaimerVersion: this.simulatedMidSessionRequiredVersion,
        acceptedDisclaimerVersion: this.user.disclaimerConsent.disclaimerVersion,
      };
    }
    if (this.shouldFailSend) {
      throw new Error('Upstream AI service temporary error');
    }
    const unlockedGalleryItem: LoungeGalleryItem = {
      id: 'uid_test_001_bot_img_02',
      uid: 'uid_test_001',
      assetId: 'bot_img_02',
      imageUrl: 'assets/IMG_8649.JPG',
      unlocked: true,
      unlockedAt: '2026-11-22T12:10:00.000Z',
      sourceSessionId: this.session.id,
    };
    const existsInGallery = this.galleryItems.some((item) => item.id === unlockedGalleryItem.id);
    this.galleryItems = existsInGallery
      ? this.galleryItems.map((item) =>
          item.id === unlockedGalleryItem.id ? unlockedGalleryItem : item,
        )
      : [...this.galleryItems, unlockedGalleryItem];
    this.remainingTurns = Math.max(0, this.remainingTurns - 1);

    return {
      session: {
        ...this.session,
        currentEmotion: 'EXCITED',
        messageCount: this.messages.length + 2,
      },
      userMessage: {
        id: 'msg_new_u',
        sessionId: this.session.id,
        uid: 'uid_test_001',
        role: 'USER',
        content: req.content,
        emotion: 'NEUTRAL',
        createdAt: '2026-11-22T12:10:00.000Z',
      },
      assistantMessage: {
        id: 'msg_new_a',
        sessionId: this.session.id,
        uid: 'uid_test_001',
        role: 'ASSISTANT',
        content: '新しいイラスト見つけたよ！',
        emotion: 'EXCITED',
        imageAssetId: 'bot_img_02',
        imageUrl: 'assets/IMG_8649.JPG',
        createdAt: '2026-11-22T12:10:01.000Z',
      },
      remainingChatTurns: this.remainingTurns,
      unlockedGalleryItem,
    };
  }

  public async listGallery(
    query?: LoungePaginationQueryDto,
  ): Promise<LoungeGalleryListResponseDto> {
    if (this.shouldFailListGallery) {
      throw new Error('Failed to load gallery collection');
    }
    const rawLimit = query?.limit;
    const limit =
      typeof rawLimit === 'number' && Number.isFinite(rawLimit)
        ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100)
        : 12;
    const totalItems = this.galleryItems.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / limit));
    const unlockedCount = this.galleryItems.filter((item) => item.unlocked).length;

    const rawPage = query?.page;
    const page =
      typeof rawPage === 'number' && Number.isFinite(rawPage)
        ? Math.max(1, Math.trunc(rawPage))
        : 1;
    const startIdx = (page - 1) * limit;
    const endIdx = Math.min(totalItems, startIdx + limit);
    const data = startIdx < totalItems ? this.galleryItems.slice(startIdx, endIdx) : [];
    const hasMore = endIdx < totalItems;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;

    return {
      data,
      meta: { currentPage: page, limit, totalItems, totalPages, nextCursor, hasMore },
      summary: { unlockedCount, totalCount: totalItems },
    };
  }
}

describe('Gemitec Private Lounge Root Shell (AppComponent)', () => {
  let fakeBff: InMemoryLoungeBffFake;
  let fixture: ComponentFixture<AppComponent>;
  let component: AppComponent;
  let facade: LoungeFacadeService;

  beforeEach(async () => {
    fakeBff = new InMemoryLoungeBffFake();
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: LoungeConfigPort, useValue: fakeBff },
        { provide: LoungeAuthPort, useValue: fakeBff },
        { provide: LoungeAccountPort, useValue: fakeBff },
        { provide: LoungeSessionPort, useValue: fakeBff },
        { provide: LoungeGalleryPort, useValue: fakeBff },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AppComponent);
    component = fixture.componentInstance;
    facade = fixture.componentInstance.facade;
    await facade.ready;
    await fixture.whenStable();
    fixture.detectChanges();
  });

  function query<T extends HTMLElement>(selector: string): T {
    const el = fixture.nativeElement.querySelector(selector) as T | null;
    if (!el) {
      throw new Error(`Expected DOM element matching selector: ${selector}`);
    }
    return el;
  }

  function flushMicrotasks(): Promise<void> {
    return Promise.resolve().then(() => Promise.resolve());
  }

  it('wires Angular Zoneless appConfig providers, defaults to LOGIN tab, and omits forbidden UI artifacts', async () => {
    expect(appConfig.providers.length).toBeGreaterThanOrEqual(5);
    expect(facade.isBootstrapping()).toBe(false);
    expect(facade.activeView()).toBe('AUTH');
    expect(facade.authMode()).toBe('LOGIN');

    const tabs = (fixture.nativeElement as HTMLElement).querySelectorAll('.auth-tab');
    expect(tabs[0]?.id).toBe('tab-login');
    expect(tabs[1]?.id).toBe('tab-signup');

    await facade.setLanguage('ja');
    facade.setAuthMode('SIGNUP');
    await fixture.whenStable();
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).not.toContain('STEP 01');
    expect(text).not.toContain('暗号化');
    expect(text).not.toContain('ONE-WAY X SYNC');
    expect(text).not.toContain('DB ISOLATED');
    expect(text).not.toContain('✨');
    expect(text).not.toContain('●');
    expect(fixture.nativeElement.querySelector('select')).toBeNull();
    expect(text).toContain('v1.45.2');

    facade.appVersion.set('   ');
    expect(component.formattedVersion()).toBe('');
  });

  it('guides sign-up through Consent -> X Link -> Language & Timezone Confirmation -> Start Chatting', async () => {
    await facade.setLanguage('ja');
    await fixture.whenStable();
    fixture.detectChanges();

    query<HTMLButtonElement>('#btn-switch-to-signup').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(facade.authMode()).toBe('SIGNUP');

    const checkbox = query<HTMLInputElement>('#checkbox-disclaimer-consent');
    const signUpBtn = query<HTMLButtonElement>('#btn-x-signup');

    expect(checkbox.disabled).toBe(true);
    expect(signUpBtn.disabled).toBe(true);

    // Attempt submit before scrolling fails safely
    await facade.submitSignUpWithX();
    expect(facade.errorMessage()).toBe(LOUNGE_TRANSLATIONS.ja.scrollRequiredError);
    facade.setDisclaimerChecked(true);
    expect(facade.disclaimerChecked()).toBe(false);

    // Guard non-element / non-input events
    component.onDisclaimerScroll(new Event('scroll'));
    component.onConsentChange(new Event('change'));
    component.onDeleteIrreversibleChange(new Event('change'));
    component.onDeleteNoRefundChange(new Event('change'));
    component.onComposerInput(new Event('input'));

    // Auto-unlock non-overflowing disclaimer containers on window resize while on AUTH view
    const box = query<HTMLElement>('#disclaimer-scroll-box');
    Object.defineProperty(box, 'clientHeight', { value: 220, configurable: true });
    Object.defineProperty(box, 'scrollHeight', { value: 220, configurable: true });
    component.onWindowResize();
    expect(facade.disclaimerScrollProgress()).toBe(100);
    expect(facade.disclaimerScrolledToBottom()).toBe(true);

    // Also verify scrollable disclaimer box unlocks via scroll listener
    facade.disclaimerScrolledToBottom.set(false);
    facade.disclaimerScrollProgress.set(0);
    Object.defineProperty(box, 'scrollTop', { value: 400, configurable: true });
    Object.defineProperty(box, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(box, 'scrollHeight', { value: 600, configurable: true });
    box.dispatchEvent(new Event('scroll'));
    await fixture.whenStable();
    fixture.detectChanges();

    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(signUpBtn.disabled).toBe(false);

    signUpBtn.click();
    await flushMicrotasks();
    await fixture.whenStable();
    fixture.detectChanges();

    // Step 3: ONBOARDING confirms Language & Timezone + shows "can change later in Options" note
    expect(facade.activeView()).toBe('ONBOARDING');
    const onboardingCard = query<HTMLElement>('#onboarding-preferences-card');
    expect(onboardingCard.textContent).toContain('オプション');
    expect(onboardingCard.textContent).toContain('@example_user');

    // Selecting language/timezone during ONBOARDING updates signals without premature save
    component.onLanguageChange('en');
    component.onTimezoneChange('America/Los_Angeles');
    await flushMicrotasks();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(onboardingCard.textContent).toContain('Options');
    expect(fakeBff.lastRequestedLanguage).toBeUndefined();

    // Clicking "Start Using" confirms preferences via PATCH /account/preferences and opens CHAT
    query<HTMLButtonElement>('#btn-start-lounge').click();
    await flushMicrotasks();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(facade.activeView()).toBe('CHAT');
    expect(fakeBff.lastRequestedLanguage).toBe('en');
    expect(fakeBff.lastRequestedTimezone).toBe('America/Los_Angeles');
    expect(query<HTMLElement>('#chat-message-stream').textContent).toContain('おっ、来たじゃん！');
  });

  it('supports full keyboard/pointer dropdown navigation and preserves non-preset timezone values', async () => {
    await facade.setLanguage('ja');
    await fixture.whenStable();
    fixture.detectChanges();

    const authDropdown = query<HTMLElement>('#auth-lang-dropdown');
    const trigger = authDropdown.querySelector<HTMLButtonElement>('.dropdown-trigger');
    expect(trigger).not.toBeNull();

    trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
    expect(authDropdown.querySelector('[role="listbox"]')).toBeNull();

    trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await fixture.whenStable();
    fixture.detectChanges();

    trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await flushMicrotasks();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(facade.lang()).toBe('en');

    trigger?.click();
    await fixture.whenStable();
    fixture.detectChanges();
    trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(authDropdown.querySelector('[role="listbox"]')).toBeNull();

    // Non-preset timezone stays visible instead of substituting opts[0] (Baker Island)
    const customDropdownFixture = TestBed.createComponent(LoungeDropdownComponent);
    customDropdownFixture.componentRef.setInput('options', [
      { label: '(UTC-12:00) Baker Island', value: 'Etc/GMT+12' },
    ]);
    customDropdownFixture.componentRef.setInput('selectedValue', 'Europe/Berlin');
    customDropdownFixture.detectChanges();
    expect(customDropdownFixture.componentInstance.selectedOption()?.label).toBe('Europe/Berlin');

    // Empty options and disabled guard checks
    customDropdownFixture.componentRef.setInput('options', []);
    customDropdownFixture.componentRef.setInput('selectedValue', '');
    customDropdownFixture.componentRef.setInput('disabled', true);
    customDropdownFixture.detectChanges();
    customDropdownFixture.componentInstance.toggleOpen();
    customDropdownFixture.componentInstance.selectOption('x');
    customDropdownFixture.componentInstance.onTriggerKeydown(
      new KeyboardEvent('keydown', { key: 'Enter' }),
    );
    expect(customDropdownFixture.componentInstance.selectedOption()).toBeNull();
    expect(customDropdownFixture.componentInstance.isOpen()).toBe(false);

    // Verify all 8 locales switch document lang cleanly
    const locales: LoungeLanguage[] = ['ja', 'en', 'de', 'pt', 'es', 'zh-HK', 'vi', 'th'];
    for (const locale of locales) {
      component.onLanguageChange(locale);
      await flushMicrotasks();
      expect(facade.lang()).toBe(locale);
      expect(document.documentElement.lang).toBe(locale);
    }

    // Outside click, toggle-close, ArrowUp, Enter open/select, and Escape close dropdown
    trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(authDropdown.querySelector('[role="listbox"]')).not.toBeNull();
    trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(authDropdown.querySelector('[role="listbox"]')).toBeNull();

    trigger?.click();
    await fixture.whenStable();
    fixture.detectChanges();
    trigger?.click(); // Clicking trigger again closes menu
    await fixture.whenStable();
    fixture.detectChanges();
    expect(authDropdown.querySelector('[role="listbox"]')).toBeNull();

    trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await fixture.whenStable();
    fixture.detectChanges();
    document.dispatchEvent(new Event('click'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(authDropdown.querySelector('[role="listbox"]')).toBeNull();
  });

  it('renders emotion-mapped circular avatars in Chat, formats midnight as 00:xx, and enforces focus traps', async () => {
    facade.setAuthMode('LOGIN');
    await fixture.whenStable();
    fixture.detectChanges();

    query<HTMLButtonElement>('#btn-x-login').click();
    await flushMicrotasks();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(facade.activeView()).toBe('CHAT');
    const avatarImg = query<HTMLImageElement>('.from-assistant .ai-chat-avatar');
    expect(avatarImg.getAttribute('src')).toBe('assets/avatars/persona_surprised.png');

    const emotions: LoungeEmotionState[] = [
      'NEUTRAL',
      'HAPPY',
      'TEASING',
      'SHY',
      'EXCITED',
      'THOUGHTFUL',
      'SURPRISED',
    ];
    for (const emotion of emotions) {
      expect(component.getEmotionAvatarPath(emotion)).toContain(emotion.toLowerCase());
    }
    expect(component.getEmotionAvatarPath(undefined)).toBe('assets/avatars/persona_icon.png');

    // Midnight formatting uses h23 (00:00, never 24:00) + invalid date/zone fallbacks
    facade.lang.set('en');
    facade.timezone.set('Asia/Tokyo');
    expect(component.formatMessageTime('2026-11-22T15:00:00.000Z')).toBe('00:00');
    expect(component.formatMessageTime('not-a-date')).toBe('');
    facade.timezone.set('Invalid/Zone_Test');
    expect(component.formatMessageTime('2026-11-22T12:08:00.000Z')).toBe('12:08');
    facade.timezone.set('Asia/Tokyo');
    facade.lang.set('ja');

    // Zero text emotion badges in Chat
    expect(query<HTMLElement>('#chat-message-stream').textContent).not.toContain('SURPRISED');

    // Lightbox focus trap asserts activeElement wraps cleanly back to close button
    component.openImagePreview('');
    expect(component.selectedImageUrl()).toBeNull();

    const inlineBtn = query<HTMLButtonElement>('.chat-inline-image-btn');
    inlineBtn.click();
    await fixture.whenStable();
    fixture.detectChanges();

    const closeLightboxBtn = query<HTMLButtonElement>('#btn-close-lightbox');
    closeLightboxBtn.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(closeLightboxBtn);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('#gallery-lightbox-modal')).toBeNull();
  });

  it('executes single-session Chat turns, unlocks Gallery artwork, rolls back failed preferences, and completes 2-step Account Deletion', async () => {
    await facade.submitLoginWithX();
    await fixture.whenStable();
    fixture.detectChanges();

    // Chat turn, auto-grow composer & Enter submit + empty/error send guards
    const textarea = query<HTMLTextAreaElement>('#chat-composer-input');
    Object.defineProperty(textarea, 'scrollHeight', { value: 96, configurable: true });
    textarea.value = '今日の写真見せて！';
    textarea.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(textarea.style.height).toBe('96px');

    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(facade.messages().length).toBe(4);
    expect(component.unlockedGalleryCount()).toBe(2);

    // Newly unlocked Bot artwork triggers both celebratory toast and inline badge
    expect(query<HTMLElement>('#gallery-unlock-toast')).toBeTruthy();
    expect(query<HTMLElement>('.inline-new-gallery-badge')).toBeTruthy();
    query<HTMLButtonElement>('#btn-unlock-toast-gallery').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(facade.activeView()).toBe('GALLERY');
    expect(facade.newlyUnlockedGalleryItem()).toBeNull();

    // Re-appearing toast also auto-clears when navigating directly to GALLERY via sidebar/shortcut
    facade.newlyUnlockedGalleryItem.set(fakeBff.galleryItems[1]);
    facade.navigateTo('GALLERY');
    expect(facade.newlyUnlockedGalleryItem()).toBeNull();

    facade.navigateTo('CHAT');
    await fixture.whenStable();
    fixture.detectChanges();

    await facade.sendMessage('   ');
    expect(facade.messages().length).toBe(4);

    fakeBff.shouldFailSend = true;
    await facade.sendMessage('エラー系テスト');
    expect(facade.errorMessage()).toBe('Upstream AI service temporary error');
    facade.dismissError();
    fakeBff.shouldFailSend = false;

    // Companion Gallery shortcut -> visual-only gallery (zero rarity / titles)
    query<HTMLButtonElement>('#btn-companion-gallery').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(facade.activeView()).toBe('GALLERY');

    query<HTMLButtonElement>('#gallery-card-uid_test_001_bot_img_02').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(query<HTMLImageElement>('#gallery-lightbox-modal .lightbox-img').getAttribute('src')).toBe(
      'assets/IMG_8649.JPG',
    );
    query<HTMLButtonElement>('#btn-close-lightbox').click();
    await fixture.whenStable();
    fixture.detectChanges();

    // Hamburger -> Options -> test preference rollback when BFF fails
    query<HTMLButtonElement>('#btn-hamburger').click();
    await fixture.whenStable();
    fixture.detectChanges();
    query<HTMLButtonElement>('#nav-btn-options').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(facade.activeView()).toBe('OPTIONS');

    fakeBff.shouldFailPreferences = true;
    await facade.setLanguage('en'); // BFF failure rolls back optimistic language switch to ja
    expect(facade.lang()).toBe('ja');
    expect(document.documentElement.lang).toBe('ja');
    await facade.setTimezone('Europe/Paris'); // BFF failure rolls back optimistic timezone switch
    expect(facade.timezone()).toBe('Asia/Tokyo');
    facade.dismissError();
    fakeBff.shouldFailPreferences = false;

    // Success update in Options
    component.onLanguageChange('es');
    await flushMicrotasks();
    component.onTimezoneChange('America/New_York');
    await flushMicrotasks();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(query<HTMLElement>('#options-saved-banner').textContent).toContain('Preferencias guardadas');

    // Multi-Step Account Deletion Flow in Options:
    // Step 1 Warning -> Step 2 Checkboxes -> Disabled until BOTH checkboxes ticked -> Confirm -> Wipes to AUTH/SIGNUP
    query<HTMLButtonElement>('#btn-open-delete-account').click();
    await fixture.whenStable();
    fixture.detectChanges();

    const modalEl = query<HTMLElement>('#delete-account-modal');
    expect(facade.deleteAccountStep()).toBe(1);
    const firstFocusableStep1 = query<HTMLButtonElement>('#btn-delete-manage-subscription');
    const nextBtnStep1 = query<HTMLButtonElement>('#btn-delete-step1-next');
    nextBtnStep1.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(firstFocusableStep1);

    // Advance to Step 2 and assert focus shifts cleanly to the first checkbox
    nextBtnStep1.click();
    await flushMicrotasks();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(facade.deleteAccountStep()).toBe(2);

    const checkIrrev = query<HTMLInputElement>('#checkbox-delete-irreversible');
    expect(document.activeElement).toBe(checkIrrev);
    const checkNoRefund = query<HTMLInputElement>('#checkbox-delete-no-refund');
    const confirmDeleteBtn = query<HTMLButtonElement>('#btn-confirm-delete-account');
    expect(confirmDeleteBtn.disabled).toBe(true);

    checkIrrev.checked = true;
    checkIrrev.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(confirmDeleteBtn.disabled).toBe(true); // Still disabled until second box checked

    checkNoRefund.checked = true;
    checkNoRefund.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(confirmDeleteBtn.disabled).toBe(false);

    confirmDeleteBtn.click();
    await flushMicrotasks();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fakeBff.deleteRequests).toEqual([
      { confirmedIrreversibleDeletion: true, confirmedNoRefundForRemainingTurns: true },
    ]);
    expect(facade.activeView()).toBe('AUTH');
    expect(facade.authMode()).toBe('SIGNUP');
    expect(facade.accountSummary()).toBeNull();
    expect(facade.messages().length).toBe(0);
    expect(facade.galleryItems().length).toBe(0);
    void modalEl;
  });

  it('handles quota exhaustion, BFF error paths, Escape drawer close, and LoungeBffAdapter lifecycle', async () => {
    fakeBff.shouldFailConfig = true;
    await facade.loadRuntimeConfig();
    expect(facade.personaBranding().chatIconPath).toBe('assets/avatars/persona_icon.png');
    fakeBff.shouldFailConfig = false;

    fakeBff.shouldFailLogin = true;
    await facade.submitLoginWithX();
    expect(facade.errorMessage()).toBe('X login rejected');
    fakeBff.shouldFailLogin = false;

    fakeBff.remainingTurns = 0;
    fakeBff.dailyTurnQuota = 0;
    await facade.submitLoginWithX();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(facade.remainingTurnsPercent()).toBe(0);
    expect(query<HTMLTextAreaElement>('#chat-composer-input').disabled).toBe(true);
    expect(fixture.nativeElement.querySelector('.quota-exhausted-banner')).not.toBeNull();

    // Drawer focus trap asserts focus wraps cleanly between first and last focusable element
    query<HTMLButtonElement>('#btn-hamburger').click();
    await fixture.whenStable();
    fixture.detectChanges();

    const drawerButtons = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
      '#lounge-sidebar-drawer button',
    );
    const firstBtn = drawerButtons[0];
    const lastBtn = drawerButtons[drawerButtons.length - 1];
    lastBtn.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(firstBtn);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(lastBtn);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(facade.isSidebarOpen()).toBe(false);

    // Guard & error paths for delete modal, Escape dismissal, sign-up, onboarding & logout
    await facade.confirmDeleteAccount(); // no-op when modal is closed
    facade.openDeleteAccountModal();
    await fixture.whenStable();
    fixture.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(facade.deleteAccountStep()).toBe(0);

    facade.openDeleteAccountModal();
    facade.proceedToDeleteAccountStep2();
    facade.setDeleteConfirmIrreversible(true);
    facade.setDeleteConfirmNoRefund(true);
    fakeBff.shouldFailDelete = true;
    await facade.confirmDeleteAccount();
    expect(facade.errorMessage()).toBe('Account deletion temporarily unavailable');
    facade.closeDeleteAccountModal();
    facade.dismissError();
    fakeBff.shouldFailDelete = false;

    fakeBff.shouldFailPreferences = true;
    await facade.completeOnboarding();
    expect(facade.errorMessage()).toBe('Failed to persist preferences');
    fakeBff.shouldFailPreferences = false;

    fakeBff.shouldFailLogout = true;
    await facade.logout();
    expect(facade.errorMessage()).toBe('Logout endpoint unavailable');
    expect(facade.activeView()).toBe('AUTH');
    fakeBff.shouldFailLogout = false;

    fakeBff.shouldFailSignUp = true;
    facade.disclaimerScrolledToBottom.set(true);
    facade.disclaimerChecked.set(true);
    await facade.submitSignUpWithX();
    expect(facade.errorMessage()).toBe('Sign-up rejected by server');
    fakeBff.shouldFailSignUp = false;

    await facade.submitLoginWithX();
    await fixture.whenStable();
    fixture.detectChanges();
    await facade.logout();
    expect(facade.authMode()).toBe('LOGIN');
    expect(facade.errorMessage()).toBeNull();

    // Direct LoungeBffAdapter lifecycle, HTTP /config fallbacks & preview scenario contracts
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    const httpTesting = TestBed.inject(HttpTestingController);
    const createAdapter = (): LoungeBffAdapter =>
      TestBed.runInInjectionContext(() => new LoungeBffAdapter());

    const adapter = createAdapter();
    const cfg1Promise = adapter.getRuntimeConfig();
    httpTesting.expectOne('/api/v1/lounge/config').flush({
      appVersion: 'v9.9.9',
      disclaimerVersion: 2,
      persona: SYNTHETIC_BRANDING,
    });
    expect((await cfg1Promise).appVersion).toBe('v9.9.9');

    const cfg2Promise = adapter.getRuntimeConfig();
    httpTesting
      .expectOne('/api/v1/lounge/config')
      .flush({}, { status: 500, statusText: 'Server Error' });
    expect((await cfg2Promise).appVersion).toMatch(/^\d+\.\d+\.\d+$|^v\d+\.\d+\.\d+$/);

    const cfg3Promise = adapter.getRuntimeConfig();
    httpTesting
      .expectOne('/api/v1/lounge/config')
      .flush({ appVersion: 'v1.0.0', disclaimerVersion: '2026', persona: 'invalid' });
    expect((await cfg3Promise).persona.englishName).toBe('AI Companion');

    const cfg4Promise = adapter.getRuntimeConfig();
    httpTesting.expectOne('/api/v1/lounge/config').flush({
      appVersion: 'v1.0.0',
      disclaimerVersion: 1,
      persona: { ...SYNTHETIC_BRANDING, emotionAvatarPaths: null },
    });
    expect((await cfg4Promise).persona.englishName).toBe('AI Companion');
    httpTesting.verify();

    const originalSearch = window.location.search;
    try {
      window.history.replaceState({}, '', '?previewScenario=billing');
      const previewAdapter = createAdapter();
      await previewAdapter.logout();
      await expect(previewAdapter.getCurrentSession()).resolves.not.toBeNull();
      // Force fresh sign-up validation by setting previewUser null via onboarding logout -> signup
      window.history.replaceState({}, '', '?previewScenario=session');
      const freshAdapter = createAdapter();
      await freshAdapter.logout();

      await expect(
        freshAdapter.signUpWithX({
          idToken: 'tok',
          xOAuthCode: 'code',
          disclaimerConsent: {
            disclaimerVersion: 1,
            agreedToGeminiTrainingUsage: false,
            agreedToZeroPiiProhibition: true,
            agreedToOneWayMemoryIsolation: true,
            scrolledToBottomAt: '2026-11-22T12:00:00.000Z',
            consentedAt: '2026-11-22T12:00:00.000Z',
          },
        }),
      ).rejects.toThrow('Mandatory disclaimer');

      const signedUp = await freshAdapter.signUpWithX({
        idToken: 'tok',
        xOAuthCode: 'code',
        language: 'zh-HK',
        timezone: 'Asia/Hong_Kong',
        disclaimerConsent: {
          disclaimerVersion: 1,
          agreedToGeminiTrainingUsage: true,
          agreedToZeroPiiProhibition: true,
          agreedToOneWayMemoryIsolation: true,
          scrolledToBottomAt: '2026-11-22T12:00:00.000Z',
          consentedAt: '2026-11-22T12:00:00.000Z',
        },
      });
      expect(signedUp.user.language).toBe('zh-HK');
      expect(signedUp.user.onboardingCompleted).toBe(false);
      expect(signedUp.user.disclaimerConsent.disclaimerVersion).toBe(1);
      await expect(freshAdapter.getCurrentSession()).resolves.not.toBeNull();

      // Duplicate sign-up rejects (1 account per X account)
      await expect(
        freshAdapter.signUpWithX({
          idToken: 'tok',
          xOAuthCode: 'code',
          disclaimerConsent: signedUp.user.disclaimerConsent,
        }),
      ).rejects.toThrow('already registered');

      const summary = await freshAdapter.getAccountSummary();
      expect(summary.totalGalleryCount).toBeGreaterThan(0);
      const updatedPrefUser = await freshAdapter.updatePreferences({
        language: 'de',
        timezone: 'Europe/Berlin',
        completeOnboarding: true,
      });
      expect(updatedPrefUser.language).toBe('de');
      expect(updatedPrefUser.onboardingCompleted).toBe(true);

      await expect(
        freshAdapter.updateDisclaimerConsent({
          disclaimerConsent: {
            disclaimerVersion: 1,
            agreedToGeminiTrainingUsage: false,
            agreedToZeroPiiProhibition: true,
            agreedToOneWayMemoryIsolation: true,
            scrolledToBottomAt: '2026-11-23T00:00:00.000Z',
            consentedAt: '2026-11-23T00:00:00.000Z',
          },
        }),
      ).rejects.toThrow('Mandatory disclaimer clauses');
      await expect(
        freshAdapter.updateDisclaimerConsent({
          disclaimerConsent: {
            disclaimerVersion: 2,
            agreedToGeminiTrainingUsage: true,
            agreedToZeroPiiProhibition: true,
            agreedToOneWayMemoryIsolation: true,
            scrolledToBottomAt: '2026-11-23T00:00:00.000Z',
            consentedAt: '2026-11-23T00:00:00.000Z',
          },
        }),
      ).rejects.toThrow('must match active version');
      const reconsentedUser = await freshAdapter.updateDisclaimerConsent({
        disclaimerConsent: {
          disclaimerVersion: 1,
          agreedToGeminiTrainingUsage: true,
          agreedToZeroPiiProhibition: true,
          agreedToOneWayMemoryIsolation: true,
          scrolledToBottomAt: '2026-11-23T00:00:00.000Z',
          consentedAt: '2026-11-23T00:00:00.000Z',
        },
      });
      expect(reconsentedUser.disclaimerConsent.disclaimerVersion).toBe(1);

      const singleton = await freshAdapter.getSession();
      expect(singleton.id).toBe('uid_preview_001');
      const msgsPage1 = await freshAdapter.listMessages({ page: 1, limit: 20 });
      expect(msgsPage1.data.length).toBe(20);
      expect(msgsPage1.meta).toEqual({
        currentPage: 1,
        limit: 20,
        totalItems: 26,
        totalPages: 2,
        nextCursor: 'msg_007',
        hasMore: true,
      });
      const nextChatCursor = msgsPage1.meta.nextCursor;
      if (!nextChatCursor) {
        throw new Error('Expected nextCursor on chat page 1');
      }
      const msgsPage2 = await freshAdapter.listMessages({
        limit: 20,
        cursor: nextChatCursor,
      });
      expect(msgsPage2.data.length).toBe(6);
      expect(msgsPage2.data[0].id).toBe('msg_001');
      expect(msgsPage2.meta).toEqual({
        currentPage: 2,
        limit: 20,
        totalItems: 26,
        totalPages: 2,
        nextCursor: null,
        hasMore: false,
      });
      const invalidCursorMsgs = await freshAdapter.listMessages({
        limit: 20,
        cursor: 'missing_msg_cursor',
      });
      expect(invalidCursorMsgs.data).toEqual([]);
      expect(invalidCursorMsgs.meta.hasMore).toBe(false);

      const galleryPage1 = await freshAdapter.listGallery({ page: 1, limit: 12 });
      expect(galleryPage1.data.length).toBe(12);
      expect(galleryPage1.meta.totalPages).toBe(2);
      expect(galleryPage1.meta.hasMore).toBe(true);
      expect(galleryPage1.summary).toEqual({ unlockedCount: 5, totalCount: 18 });
      const galleryPage2 = await freshAdapter.listGallery({ page: 2, limit: 12 });
      expect(galleryPage2.data.length).toBe(6);
      expect(galleryPage2.meta.hasMore).toBe(false);
      expect(galleryPage2.meta.nextCursor).toBeNull();
      const nextGalleryCursor = galleryPage1.meta.nextCursor;
      if (!nextGalleryCursor) {
        throw new Error('Expected nextCursor on gallery page 1');
      }
      const galleryByCursor = await freshAdapter.listGallery({
        limit: 12,
        cursor: nextGalleryCursor,
      });
      expect(galleryByCursor.data.map((item) => item.id)).toEqual(
        galleryPage2.data.map((item) => item.id),
      );
      const invalidCursorGallery = await freshAdapter.listGallery({
        limit: 12,
        cursor: 'missing_gallery_cursor',
      });
      expect(invalidCursorGallery.data).toEqual([]);

      await expect(freshAdapter.sendMessage({ content: '   ' })).rejects.toThrow('cannot be empty');
      const turnRes = await freshAdapter.sendMessage({ content: 'こんにちは' });
      expect(turnRes.unlockedGalleryItem?.unlocked).toBe(true);
      const gallery = await freshAdapter.listGallery({ page: 1, limit: 12 });
      expect(gallery.summary.unlockedCount).toBe(6);

      // Exhaust preview quota (5 daily + 20 welcome = 25 total -> 24 remaining after 1st turn)
      for (let i = 0; i < 24; i++) {
        await freshAdapter.sendMessage({ content: `turn ${i}` });
      }
      await expect(freshAdapter.sendMessage({ content: 'over quota' })).rejects.toThrow(
        'quota exhausted',
      );

      // Incomplete deletion throws, complete deletion wipes preview session cleanly, logout + login restore session
      await expect(
        freshAdapter.deleteAccount({
          confirmedIrreversibleDeletion: false,
          confirmedNoRefundForRemainingTurns: true,
        }),
      ).rejects.toThrow('confirmations are required');
      await freshAdapter.deleteAccount({
        confirmedIrreversibleDeletion: true,
        confirmedNoRefundForRemainingTurns: true,
      });
      await freshAdapter.loginWithX({ idToken: 'tok' });
      await expect(freshAdapter.getCurrentSession()).resolves.not.toBeNull();
      await freshAdapter.logout();

      // Preview scenario URL hooks for headless UX audits
      window.history.replaceState({}, '', '?previewScenario=onboarding');
      const onboardingPreview = createAdapter();
      expect((await onboardingPreview.getCurrentSession())?.user.onboardingCompleted).toBe(false);

      window.history.replaceState({}, '', '?previewScenario=reconsent');
      const reconsentPreview = createAdapter();
      expect(
        (await reconsentPreview.getCurrentSession())?.user.disclaimerConsent.disclaimerVersion,
      ).toBe(0);
      await expect(reconsentPreview.sendMessage({ content: 'blocked turn' })).rejects.toThrow(
        LoungeReconsentRequiredClientError,
      );

      window.history.replaceState({}, '', '?previewScenario=mid-session-reconsent');
      const midSessionPreview = createAdapter();
      expect(
        (await midSessionPreview.getCurrentSession())?.user.disclaimerConsent.disclaimerVersion,
      ).toBe(1);
      await expect(midSessionPreview.sendMessage({ content: 'stale session turn' })).rejects.toThrow(
        LoungeReconsentRequiredClientError,
      );

      window.history.replaceState({}, '', '?previewScenario=session');
      const sessionPreview = createAdapter();
      expect((await sessionPreview.getCurrentSession())?.user.onboardingCompleted).toBe(true);
    } finally {
      window.history.replaceState({}, '', originalSearch || '/');
    }
  });

  it('auto-detects initial browser language and timezone across 8 locales with fallback to en/UTC', () => {
    expect(detectInitialLoungeLanguage({ languages: ['   ', 'ja-JP', 'en-US'], language: 'en' })).toBe('ja');
    expect(detectInitialLoungeLanguage({ languages: ['zh-TW'], language: 'zh-TW' })).toBe('zh-HK');
    expect(detectInitialLoungeLanguage({ languages: ['zh-Hant'] })).toBe('zh-HK');
    expect(detectInitialLoungeLanguage({ languages: ['de-DE'] })).toBe('de');
    expect(detectInitialLoungeLanguage({ languages: ['es-MX'] })).toBe('es');
    expect(detectInitialLoungeLanguage({ languages: ['pt-BR'] })).toBe('pt');
    expect(detectInitialLoungeLanguage({ languages: ['vi-VN'] })).toBe('vi');
    expect(detectInitialLoungeLanguage({ languages: ['th-TH'] })).toBe('th');
    expect(detectInitialLoungeLanguage({ languages: ['fr-FR'] })).toBe('en');
    expect(detectInitialLoungeLanguage({ languages: [], language: '' })).toBe('en');

    const dateTimeFormatSpy = jest.spyOn(Intl, 'DateTimeFormat').mockImplementation((...args) => {
      const options = args[1];
      if (options?.timeZone === 'Invalid/Mock_Zone') {
        throw new Error('Invalid timezone');
      }
      return {
        resolvedOptions: () => ({ timeZone: 'Asia/Tokyo' }),
        format: () => '2026',
      } as unknown as Intl.DateTimeFormat;
    });
    try {
      expect(detectInitialLoungeTimezone()).toBe('Asia/Tokyo');

      dateTimeFormatSpy.mockImplementationOnce(() => {
        throw new Error('Intl unavailable');
      });
      expect(detectInitialLoungeTimezone()).toBe('UTC');
    } finally {
      dateTimeFormatSpy.mockRestore();
    }
  });

  it('renders non-dismissible 3-choice Re-Consent popup over preserved Chat and enforces mid-session gate', async () => {
    // 0. Session check error degrades cleanly to AUTH screen without throwing
    fakeBff.shouldFailGetCurrentSession = true;
    await facade.initializeLounge();
    expect(facade.isBootstrapping()).toBe(false);
    expect(facade.activeView()).toBe('AUTH');
    expect(facade.isReconsentRequired()).toBe(false);
    fakeBff.shouldFailGetCurrentSession = false;

    // 1. Outdated consent version (< 1) mounts preserved CHAT behind non-dismissible #reconsent-modal
    const outdatedUser = createSyntheticUser('ja', 'Asia/Tokyo', true, 0);
    fakeBff.user = outdatedUser;
    fakeBff.currentSessionUser = outdatedUser;
    await facade.initializeLounge();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(facade.isBootstrapping()).toBe(false);
    expect(facade.activeView()).toBe('CHAT');
    expect(facade.isReconsentRequired()).toBe(true);
    expect(query<HTMLElement>('#chat-message-stream').textContent).toContain('おっ、来たじゃん！');

    const modal = query<HTMLElement>('#reconsent-modal');
    expect(modal.textContent).toContain('v1');
    expect(modal.textContent).toContain('同意してチャットに戻る');
    expect(modal.querySelector('.reconsent-summary-card')).toBeNull();
    expect(modal.querySelector('.reconsent-preserved-callout')).toBeNull();
    expect(modal.querySelector('.reconsent-footer')).toBeNull();

    // Escape key & backdrop click MUST NOT close #reconsent-modal; Tab wraps focus inside modal
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    modal.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(facade.isReconsentRequired()).toBe(true);

    // Exercise resize zero-overflow auto-unlock and non-element event guards on ReconsentModalComponent
    const reconsentComp = fixture.debugElement.query(
      By.directive(ReconsentModalComponent),
    ).componentInstance as ReconsentModalComponent;
    reconsentComp.onDisclaimerScroll(new Event('scroll'));
    reconsentComp.onConsentChange(new Event('change'));
    const box = query<HTMLElement>('#reconsent-scroll-box');
    Object.defineProperty(box, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(box, 'scrollHeight', { value: 200, configurable: true });
    reconsentComp.onWindowResize();
    expect(facade.disclaimerScrolledToBottom()).toBe(true);
    facade.disclaimerScrolledToBottom.set(false);
    facade.disclaimerScrollProgress.set(0);

    // Shift+Tab even from the non-focusable .reconsent-modal-card container wraps backward inside #reconsent-modal
    expect(query<HTMLElement>('.lounge-shell').hasAttribute('inert')).toBe(true);
    const modalCard = query<HTMLElement>('.reconsent-modal-card');
    modalCard.focus();
    expect(document.activeElement).toBe(modalCard);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(query<HTMLElement>('#btn-reconsent-delete'));

    const modalFocusables = modal.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    const firstModalEl = modalFocusables[0];
    const lastModalEl = modalFocusables[modalFocusables.length - 1];
    lastModalEl.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(firstModalEl);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(lastModalEl);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));

    const submitReconsentBtn = query<HTMLButtonElement>('#btn-submit-reconsent');
    expect(submitReconsentBtn.disabled).toBe(true);

    // Attempt premature submit fails safely
    await facade.submitDisclaimerReconsent();
    expect(facade.errorMessage()).toBe(LOUNGE_TRANSLATIONS.ja.scrollRequiredError);

    // Scroll to bottom, tick checkbox, surface BFF error cleanly, then Choice 1 agrees and unlocks Chat
    Object.defineProperty(box, 'scrollTop', { value: 420, configurable: true });
    Object.defineProperty(box, 'clientHeight', { value: 140, configurable: true });
    Object.defineProperty(box, 'scrollHeight', { value: 560, configurable: true });
    box.dispatchEvent(new Event('scroll'));
    await fixture.whenStable();
    fixture.detectChanges();

    const checkbox = query<HTMLInputElement>('#checkbox-reconsent');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(submitReconsentBtn.disabled).toBe(false);

    fakeBff.shouldFailReconsent = true;
    submitReconsentBtn.click();
    await flushMicrotasks();
    expect(facade.errorMessage()).toBe('Consent update temporarily unavailable');
    expect(facade.isReconsentRequired()).toBe(true);
    fakeBff.shouldFailReconsent = false;

    submitReconsentBtn.click();
    await flushMicrotasks();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(facade.activeView()).toBe('CHAT');
    expect(facade.isReconsentRequired()).toBe(false);
    expect(fixture.nativeElement.querySelector('#reconsent-modal')).toBeNull();

    // 2. Choice 2 (Logout) exits cleanly to AUTH
    const outdatedAgain = createSyntheticUser('ja', 'Asia/Tokyo', true, 0);
    fakeBff.user = outdatedAgain;
    fakeBff.currentSessionUser = outdatedAgain;
    await facade.initializeLounge();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(facade.isReconsentRequired()).toBe(true);
    query<HTMLButtonElement>('#btn-reconsent-logout').click();
    await flushMicrotasks();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(facade.activeView()).toBe('AUTH');
    expect(facade.isReconsentRequired()).toBe(false);

    // 3. Choice 3 (Decline & Delete Account) opens Step 1/Step 2 deletion modal over #reconsent-modal
    fakeBff.user = outdatedAgain;
    fakeBff.currentSessionUser = outdatedAgain;
    await facade.initializeLounge();
    await fixture.whenStable();
    fixture.detectChanges();

    const reconsentDeleteBtn = query<HTMLButtonElement>('#btn-reconsent-delete');
    reconsentDeleteBtn.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(facade.deleteAccountStep()).toBe(1);
    expect(query<HTMLElement>('#delete-account-modal')).toBeTruthy();

    // Canceling deletion keeps #reconsent-modal active and restores focus cleanly to #btn-reconsent-delete
    query<HTMLButtonElement>('#btn-delete-cancel').click();
    await flushMicrotasks();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(facade.deleteAccountStep()).toBe(0);
    expect(facade.isReconsentRequired()).toBe(true);
    expect(document.activeElement).toBe(reconsentDeleteBtn);

    // Confirming Step 2 executes DELETE /account and resets cleanly to SIGNUP
    reconsentDeleteBtn.click();
    await fixture.whenStable();
    fixture.detectChanges();
    query<HTMLButtonElement>('#btn-delete-step1-next').click();
    await fixture.whenStable();
    fixture.detectChanges();
    const checkIrrev = query<HTMLInputElement>('#checkbox-delete-irreversible');
    checkIrrev.checked = true;
    checkIrrev.dispatchEvent(new Event('change'));
    const checkNoRef = query<HTMLInputElement>('#checkbox-delete-no-refund');
    checkNoRef.checked = true;
    checkNoRef.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    fixture.detectChanges();
    query<HTMLButtonElement>('#btn-confirm-delete-account').click();
    await flushMicrotasks();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(facade.activeView()).toBe('AUTH');
    expect(facade.authMode()).toBe('SIGNUP');
    expect(facade.isReconsentRequired()).toBe(false);

    // 4. Mid-session loophole closure: server 403 DISCLAIMER_RECONSENT_REQUIRED on POST /session/messages
    // pops #reconsent-modal (v1 -> v2) while preserving the user's unsent composer draft!
    const activeV1User = createSyntheticUser('ja', 'Asia/Tokyo', true, 1);
    fakeBff.user = activeV1User;
    fakeBff.currentSessionUser = activeV1User;
    fakeBff.simulatedMidSessionRequiredVersion = undefined;
    await facade.initializeLounge();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(facade.activeView()).toBe('CHAT');
    expect(facade.isReconsentRequired()).toBe(false);

    facade.composerDraft.set('送信前に規約が上がったケース');
    fakeBff.simulatedMidSessionRequiredVersion = 2;
    await facade.sendMessage(facade.composerDraft());
    await fixture.whenStable();
    fixture.detectChanges();

    expect(facade.isReconsentRequired()).toBe(true);
    expect(facade.disclaimerVersion()).toBe(2);
    expect(facade.errorMessage()).toBeNull();
    expect(facade.composerDraft()).toBe('送信前に規約が上がったケース');
    expect(query<HTMLElement>('#reconsent-modal').textContent).toContain('v1 → v2');
    fakeBff.simulatedMidSessionRequiredVersion = undefined;

    // Agree to v2 inside #reconsent-modal and immediately resend preserved composerDraft cleanly!
    const midBox = query<HTMLElement>('#reconsent-scroll-box');
    Object.defineProperty(midBox, 'scrollTop', { value: 420, configurable: true });
    Object.defineProperty(midBox, 'clientHeight', { value: 140, configurable: true });
    Object.defineProperty(midBox, 'scrollHeight', { value: 560, configurable: true });
    midBox.dispatchEvent(new Event('scroll'));
    await fixture.whenStable();
    fixture.detectChanges();
    const midCheck = query<HTMLInputElement>('#checkbox-reconsent');
    midCheck.checked = true;
    midCheck.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    fixture.detectChanges();
    query<HTMLButtonElement>('#btn-submit-reconsent').click();
    await flushMicrotasks();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(facade.isReconsentRequired()).toBe(false);
    expect(facade.composerDraft()).toBe('送信前に規約が上がったケース');
    await facade.sendMessage(facade.composerDraft());
    expect(facade.composerDraft()).toBe('');

    // 5. Unfinished onboarding resumes straight into ONBOARDING
    const unfinishedUser = createSyntheticUser('en', 'UTC', false, 2);
    fakeBff.user = unfinishedUser;
    fakeBff.currentSessionUser = unfinishedUser;
    facade.disclaimerVersion.set(2);
    await facade.initializeLounge();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(facade.activeView()).toBe('ONBOARDING');
    expect(facade.isReconsentRequired()).toBe(false);
    expect(facade.lang()).toBe('en');
  });

  it('supports Gallery multi-page navigation, preserves unlocked count across pages, and refreshes on out-of-page unlock', async () => {
    fakeBff.galleryItems = Array.from({ length: 18 }, (_, idx) => {
      const seq = String(idx + 1).padStart(2, '0');
      const assetId = `bot_img_${seq}`;
      const unlocked = idx < 5;
      return {
        id: `uid_test_001_${assetId}`,
        uid: 'uid_test_001',
        assetId,
        imageUrl: unlocked ? 'assets/gallery_morning.webp' : '',
        unlocked,
        ...(unlocked
          ? { unlockedAt: '2026-11-22T12:00:00.000Z', sourceSessionId: 'uid_test_001' }
          : {}),
      };
    });

    await facade.submitLoginWithX();
    await fixture.whenStable();
    fixture.detectChanges();

    facade.navigateTo('GALLERY');
    await fixture.whenStable();
    fixture.detectChanges();

    expect(facade.galleryCurrentPage()).toBe(1);
    expect(facade.galleryTotalPages()).toBe(2);
    expect(facade.galleryItems().length).toBe(12);
    expect(component.unlockedGalleryCount()).toBe(5);
    expect(component.totalGalleryCount()).toBe(18);
    expect(fixture.nativeElement.querySelectorAll('.gallery-tile').length).toBe(12);

    const paginationEl = query<HTMLElement>('#gallery-pagination');
    const page2Btn = Array.from(paginationEl.querySelectorAll('button')).find(
      (btn) => btn.textContent?.trim() === '2',
    );
    if (!page2Btn) {
      throw new Error('Expected page 2 button');
    }
    page2Btn.click();
    await flushMicrotasks();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(facade.galleryCurrentPage()).toBe(2);
    expect(facade.galleryItems().length).toBe(6);
    expect(fixture.nativeElement.querySelectorAll('.gallery-tile').length).toBe(6);
    expect(component.unlockedGalleryCount()).toBe(5);

    // Out-of-page already-unlocked encounter while viewing Page 2 must NOT inflate count
    // and refreshes Page 1 cleanly upon returning to GALLERY
    await facade.sendMessage('Page 2滞在中の既存アンロック確認');
    expect(component.unlockedGalleryCount()).toBe(5);
    facade.navigateTo('GALLERY');
    await flushMicrotasks();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(facade.galleryCurrentPage()).toBe(1);
    expect(component.unlockedGalleryCount()).toBe(5);

    // Gallery fetch failure sets explicit errorMessage and resets loading flag
    fakeBff.shouldFailListGallery = true;
    await facade.loadGalleryPage(2);
    expect(facade.errorMessage()).toBe('Failed to load gallery collection');
    expect(facade.isLoadingGalleryPage()).toBe(false);
    fakeBff.shouldFailListGallery = false;

    // Unlocking a brand-new item when a session starts with an empty gallery increments counts 0 -> 1
    await facade.logout();
    fakeBff.galleryItems = [];
    await facade.submitLoginWithX();
    expect(component.totalGalleryCount()).toBe(0);
    await facade.sendMessage('空ギャラリーからの初回解放');
    expect(facade.galleryTotalItems()).toBe(1);
    expect(component.totalGalleryCount()).toBe(1);
    expect(component.unlockedGalleryCount()).toBe(1);
  });

  it('lazy-loads older Chat turns upward without a sort toggle, anchors scroll position, and toggles Jump-to-latest', async () => {
    fakeBff.messages = Array.from({ length: 26 }, (_, idx) => {
      const seq = String(idx + 1).padStart(3, '0');
      return {
        id: `msg_${seq}`,
        sessionId: 'uid_test_001',
        uid: 'uid_test_001',
        role: idx % 2 === 0 ? 'ASSISTANT' : 'USER',
        content: `Conversation message ${seq}`,
        emotion: idx % 2 === 0 ? 'HAPPY' : 'NEUTRAL',
        createdAt: new Date(Date.parse('2026-11-21T10:00:00.000Z') + idx * 60_000).toISOString(),
      };
    });

    await facade.submitLoginWithX();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(facade.messages().length).toBe(20);
    expect(facade.messages()[0].id).toBe('msg_007');
    expect(facade.messages()[19].id).toBe('msg_026');
    expect(facade.hasMoreMessages()).toBe(true);
    expect(facade.oldestMessageCursor()).toBe('msg_007');
    expect(facade.messagesTotalItems()).toBe(26);
    expect(query<HTMLButtonElement>('#btn-load-older-messages')).toBeTruthy();

    // Verify no oldest-first / newest-first sort toggle exists anywhere in Chat DOM
    const chatPanelText = query<HTMLElement>('.chat-panel').textContent ?? '';
    expect(chatPanelText).not.toMatch(/古い順|新しい順|Sort order/i);

    const streamEl = query<HTMLElement>('#chat-message-stream');
    let currentScrollTop = 500;
    const getScrollHeight = () => (facade.messages().length >= 26 ? 1480 : 1000);
    Object.defineProperty(streamEl, 'scrollHeight', {
      get: getScrollHeight,
      configurable: true,
    });
    Object.defineProperty(streamEl, 'clientHeight', {
      value: 400,
      configurable: true,
    });
    Object.defineProperty(streamEl, 'scrollTop', {
      get: () => currentScrollTop,
      set: (val: number) => {
        currentScrollTop = val;
      },
      configurable: true,
    });

    // Scrolled far from bottom (> 80px) reveals Jump-to-latest pill & guards onInlineImageLoad()
    streamEl.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();
    expect(component.showJumpToLatest()).toBe(true);
    expect(query<HTMLButtonElement>('#btn-jump-to-latest')).toBeTruthy();
    component.onInlineImageLoad();
    expect(currentScrollTop).toBe(500);

    // Trigger upward boundary at scrollTop <= 40 -> prepends msg_001..006 & anchors scrollTop by delta (+480)
    currentScrollTop = 10;
    streamEl.dispatchEvent(new Event('scroll'));
    await flushMicrotasks();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(facade.messages().length).toBe(26);
    expect(facade.messages()[0].id).toBe('msg_001');
    expect(facade.hasMoreMessages()).toBe(false);
    expect(facade.oldestMessageCursor()).toBeNull();
    expect(currentScrollTop).toBe(490);
    expect(query<HTMLElement>('#chat-history-beginning')).toBeTruthy();

    // Scrolling again once exhausted or without cursor returns false safely
    expect(await facade.loadOlderMessages()).toBe(false);
    facade.hasMoreMessages.set(true);
    facade.oldestMessageCursor.set(null);
    expect(await facade.loadOlderMessages()).toBe(false);

    // Jump-to-latest pill returns scroll position to bottom & hides pill; positive onInlineImageLoad anchors bottom
    query<HTMLButtonElement>('#btn-jump-to-latest').click();
    fixture.detectChanges();
    expect(currentScrollTop).toBe(getScrollHeight());
    expect(component.showJumpToLatest()).toBe(false);
    currentScrollTop = 120;
    component.onInlineImageLoad();
    expect(currentScrollTop).toBe(getScrollHeight());

    // Upward fetch error populates errorMessage cleanly
    fakeBff.shouldFailListMessages = true;
    facade.hasMoreMessages.set(true);
    facade.oldestMessageCursor.set('msg_007');
    expect(await facade.loadOlderMessages()).toBe(false);
    expect(facade.errorMessage()).toBe('Failed to load conversation history');
    expect(facade.isLoadingOlderMessages()).toBe(false);

    // Logout resets all pagination state cleanly
    await facade.logout();
    expect(facade.hasMoreMessages()).toBe(false);
    expect(facade.oldestMessageCursor()).toBeNull();
    expect(facade.messagesTotalItems()).toBe(0);
    expect(facade.galleryCurrentPage()).toBe(1);
    expect(facade.galleryTotalPages()).toBe(1);
    expect(facade.galleryTotalItems()).toBe(0);
    expect(facade.galleryUnlockedCount()).toBe(0);
  });
});

describe('LoungePaginationComponent (Smart Windowing & Boundary Contract)', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LoungePaginationComponent],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  it('renders contiguous pages when totalPages <= 5 and handles 0-item edge range', () => {
    const fixture = TestBed.createComponent(LoungePaginationComponent);
    fixture.componentRef.setInput('currentPage', 1);
    fixture.componentRef.setInput('totalPages', 1);
    fixture.componentRef.setInput('totalItems', 0);
    fixture.componentRef.setInput('pageSize', 12);
    fixture.detectChanges();

    expect(fixture.componentInstance.rangeStart()).toBe(0);
    expect(fixture.componentInstance.rangeEnd()).toBe(0);
    expect(fixture.componentInstance.paginationTokens()).toEqual([
      { key: 'page-1', kind: 'page', page: 1 },
    ]);

    fixture.componentRef.setInput('totalPages', 4);
    fixture.componentRef.setInput('totalItems', 42);
    fixture.componentRef.setInput('currentPage', 2);
    fixture.detectChanges();

    expect(fixture.componentInstance.rangeStart()).toBe(13);
    expect(fixture.componentInstance.rangeEnd()).toBe(24);
    expect(fixture.componentInstance.paginationTokens().map((t) => t.key)).toEqual([
      'page-1',
      'page-2',
      'page-3',
      'page-4',
    ]);
  });

  it('windows start, middle (unique left/right ellipses), and end ranges across > 5 pages and guards emits', () => {
    const fixture = TestBed.createComponent(LoungePaginationComponent);
    const emitted: number[] = [];
    fixture.componentInstance.pageChange.subscribe((page) => emitted.push(page));

    // Start window (page 2 of 8)
    fixture.componentRef.setInput('currentPage', 2);
    fixture.componentRef.setInput('totalPages', 8);
    fixture.componentRef.setInput('totalItems', 96);
    fixture.detectChanges();
    expect(fixture.componentInstance.paginationTokens().map((t) => t.key)).toEqual([
      'page-1',
      'page-2',
      'page-3',
      'page-4',
      'ellipsis-right',
      'page-8',
    ]);

    // Middle window (page 4 of 8 -> both ellipsis-left and ellipsis-right must have distinct keys)
    fixture.componentRef.setInput('currentPage', 4);
    fixture.detectChanges();
    expect(fixture.componentInstance.paginationTokens().map((t) => t.key)).toEqual([
      'page-1',
      'ellipsis-left',
      'page-3',
      'page-4',
      'page-5',
      'ellipsis-right',
      'page-8',
    ]);

    // End window (page 7 of 8)
    fixture.componentRef.setInput('currentPage', 7);
    fixture.detectChanges();
    expect(fixture.componentInstance.paginationTokens().map((t) => t.key)).toEqual([
      'page-1',
      'ellipsis-left',
      'page-5',
      'page-6',
      'page-7',
      'page-8',
    ]);

    // Interactive click emits valid page, while active / out-of-range / loading suppress emission
    fixture.componentInstance.selectPage(5);
    fixture.componentInstance.selectPage(7);
    fixture.componentInstance.selectPage(0);
    fixture.componentInstance.selectPage(9);
    fixture.componentRef.setInput('loading', true);
    fixture.detectChanges();
    fixture.componentInstance.selectPage(3);

    expect(emitted).toEqual([5]);
  });
});
