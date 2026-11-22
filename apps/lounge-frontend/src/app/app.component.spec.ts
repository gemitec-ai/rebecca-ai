import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type {
  LoungeAccountSummaryDto,
  LoungeAuthSessionDto,
  LoungeDeleteAccountRequestDto,
  LoungeEmotionState,
  LoungeGalleryItem,
  LoungeLanguage,
  LoungePersonaBranding,
  LoungeSendMessageResponseDto,
  LoungeSession,
  LoungeUser,
} from '@rebecca/types';
import { AppComponent } from './app.component';
import { appConfig } from './app.config';
import { LoungeBffAdapter } from './core/adapters/lounge-bff.adapter';
import { LOUNGE_TRANSLATIONS } from './core/i18n/lounge-translations';
import { LoungeAccountPort } from './core/ports/lounge-account.port';
import { LoungeAuthPort } from './core/ports/lounge-auth.port';
import { LoungeConfigPort } from './core/ports/lounge-config.port';
import { LoungeGalleryPort } from './core/ports/lounge-gallery.port';
import { LoungeSessionPort } from './core/ports/lounge-session.port';
import { LoungeFacadeService } from './core/services/lounge-facade.service';
import { LoungeDropdownComponent } from './shared/components/lounge-dropdown/lounge-dropdown.component';

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

function createSyntheticUser(language: LoungeLanguage = 'ja', timezone = 'Asia/Tokyo'): LoungeUser {
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
    disclaimerConsent: {
      disclaimerVersion: '2026-11-22',
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
  public remainingTurns = 5;
  public dailyTurnQuota = 10;
  public omitPersonaOnSummary = false;
  public shouldFailConfig = false;
  public shouldFailLogin = false;
  public shouldFailSignUp = false;
  public shouldFailPreferences = false;
  public shouldFailDelete = false;
  public shouldFailSend = false;
  public shouldFailLogout = false;
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

  public messages = [
    {
      id: 'msg_init_u',
      sessionId: 'uid_test_001',
      uid: 'uid_test_001',
      role: 'USER' as const,
      content: 'こんにちは',
      emotion: 'NEUTRAL' as LoungeEmotionState,
      createdAt: '2026-11-22T12:01:00.000Z',
    },
    {
      id: 'msg_init_a',
      sessionId: 'uid_test_001',
      uid: 'uid_test_001',
      role: 'ASSISTANT' as const,
      content: 'おっ、来たじゃん！',
      emotion: 'SURPRISED' as LoungeEmotionState,
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
      disclaimerVersion: '2026-11-22',
      persona: SYNTHETIC_BRANDING,
    };
  }

  public async getCurrentSession(): Promise<LoungeAuthSessionDto | null> {
    return {
      user: this.user,
      appVersion: 'v1.45.2',
      issuedAt: this.user.lastLoginAt,
    };
  }

  public async loginWithX(): Promise<LoungeAuthSessionDto> {
    if (this.shouldFailLogin) {
      throw new Error('X login rejected');
    }
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
    );
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
  }

  public async getAccountSummary(): Promise<LoungeAccountSummaryDto> {
    return {
      user: this.user,
      subscription: {
        uid: this.user.uid,
        tier: 'SUPPORTER',
        status: 'ACTIVE',
        dailyTurnQuota: this.dailyTurnQuota,
        remainingChatTurns: this.remainingTurns,
        quotaResetAt: '2026-11-23T00:00:00.000Z',
        currentPeriodEnd: '2026-12-22T00:00:00.000Z',
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
    };
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

  public async listMessages() {
    return {
      items: this.messages,
      nextCursor: null,
      totalCount: this.messages.length,
    };
  }

  public async sendMessage(req: { content: string }): Promise<LoungeSendMessageResponseDto> {
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
    this.galleryItems = [this.galleryItems[0], unlockedGalleryItem];
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

  public async listGallery() {
    return {
      items: this.galleryItems,
      unlockedCount: this.galleryItems.filter((item) => item.unlocked).length,
      totalCount: this.galleryItems.length,
      nextCursor: null,
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
    await facade.loadRuntimeConfig();
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

  it('wires Angular Zoneless appConfig providers and omits forbidden technical/emoji UI artifacts', () => {
    expect(appConfig.providers.length).toBeGreaterThanOrEqual(5);

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
    const cancelBtnStep1 = query<HTMLButtonElement>('#btn-delete-cancel');
    const nextBtnStep1 = query<HTMLButtonElement>('#btn-delete-step1-next');
    nextBtnStep1.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(cancelBtnStep1);

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

    // Direct LoungeBffAdapter lifecycle, offline fallbacks & 1:1 X sign-up / withdrawal tests
    const adapter = new LoungeBffAdapter();
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({
          appVersion: 'v9.9.9',
          disclaimerVersion: '2026-12-01',
          persona: SYNTHETIC_BRANDING,
        }),
      })) as unknown as typeof fetch;
      expect((await adapter.getRuntimeConfig()).appVersion).toBe('v9.9.9');

      globalThis.fetch = jest.fn(async () => ({
        ok: false,
        json: async () => ({}),
      })) as unknown as typeof fetch;
      expect((await adapter.getRuntimeConfig()).appVersion).toMatch(/^\d+\.\d+\.\d+$|^v\d+\.\d+\.\d+$/);

      globalThis.fetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({ appVersion: 'v1.0.0', disclaimerVersion: '2026', persona: 'invalid' }),
      })) as unknown as typeof fetch;
      expect((await adapter.getRuntimeConfig()).persona.englishName).toBe('AI Companion');

      globalThis.fetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({
          appVersion: 'v1.0.0',
          disclaimerVersion: '2026',
          persona: { ...SYNTHETIC_BRANDING, emotionAvatarPaths: null },
        }),
      })) as unknown as typeof fetch;
      expect((await adapter.getRuntimeConfig()).persona.englishName).toBe('AI Companion');

      (globalThis as { fetch?: typeof fetch }).fetch = undefined;
      expect((await adapter.getRuntimeConfig()).persona.englishName).toBe('AI Companion');
    } finally {
      globalThis.fetch = originalFetch;
    }

    await expect(adapter.getCurrentSession()).resolves.toBeNull();
    await expect(
      adapter.signUpWithX({
        idToken: 'tok',
        xOAuthCode: 'code',
        disclaimerConsent: {
          disclaimerVersion: '2026-11-22',
          agreedToGeminiTrainingUsage: false,
          agreedToZeroPiiProhibition: true,
          agreedToOneWayMemoryIsolation: true,
          scrolledToBottomAt: '2026-11-22T12:00:00.000Z',
          consentedAt: '2026-11-22T12:00:00.000Z',
        },
      }),
    ).rejects.toThrow('Mandatory disclaimer');

    const signedUp = await adapter.signUpWithX({
      idToken: 'tok',
      xOAuthCode: 'code',
      language: 'zh-HK',
      timezone: 'Asia/Hong_Kong',
      disclaimerConsent: {
        disclaimerVersion: '2026-11-22',
        agreedToGeminiTrainingUsage: true,
        agreedToZeroPiiProhibition: true,
        agreedToOneWayMemoryIsolation: true,
        scrolledToBottomAt: '2026-11-22T12:00:00.000Z',
        consentedAt: '2026-11-22T12:00:00.000Z',
      },
    });
    expect(signedUp.user.language).toBe('zh-HK');
    await expect(adapter.getCurrentSession()).resolves.not.toBeNull();

    // Duplicate sign-up rejects (1 account per X account)
    await expect(
      adapter.signUpWithX({
        idToken: 'tok',
        xOAuthCode: 'code',
        disclaimerConsent: signedUp.user.disclaimerConsent,
      }),
    ).rejects.toThrow('already registered');

    const summary = await adapter.getAccountSummary();
    expect(summary.totalGalleryCount).toBeGreaterThan(0);
    const updatedPrefUser = await adapter.updatePreferences({ language: 'de', timezone: 'Europe/Berlin' });
    expect(updatedPrefUser.language).toBe('de');

    const singleton = await adapter.getSession();
    expect(singleton.id).toBe('uid_preview_001');
    const msgs = await adapter.listMessages();
    expect(msgs.items.length).toBe(3);

    await expect(adapter.sendMessage({ content: '   ' })).rejects.toThrow('cannot be empty');
    const turnRes = await adapter.sendMessage({ content: 'こんにちは' });
    expect(turnRes.unlockedGalleryItem?.unlocked).toBe(true);
    const gallery = await adapter.listGallery();
    expect(gallery.unlockedCount).toBeGreaterThanOrEqual(2);

    // Exhaust preview quota and assert quota error
    for (let i = 0; i < 23; i++) {
      await adapter.sendMessage({ content: `turn ${i}` });
    }
    await expect(adapter.sendMessage({ content: 'over quota' })).rejects.toThrow('quota exhausted');

    // Incomplete deletion throws, complete deletion wipes preview session cleanly, logout + login restore session
    await expect(
      adapter.deleteAccount({
        confirmedIrreversibleDeletion: false,
        confirmedNoRefundForRemainingTurns: true,
      }),
    ).rejects.toThrow('confirmations are required');
    await adapter.deleteAccount({
      confirmedIrreversibleDeletion: true,
      confirmedNoRefundForRemainingTurns: true,
    });
    await expect(adapter.getCurrentSession()).resolves.toBeNull();
    await adapter.loginWithX({ idToken: 'tok' });
    await expect(adapter.getCurrentSession()).resolves.not.toBeNull();
    await adapter.logout();
    await expect(adapter.getCurrentSession()).resolves.toBeNull();
  });
});
