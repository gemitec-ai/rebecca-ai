import { TestBed } from '@angular/core/testing';
import type { LoungeReward } from '@rebecca/types';
import { AppComponent } from './app.component';
import { appConfig } from './app.config';
import { LoungeBffAdapter } from './core/adapters/lounge-bff.adapter';
import { LoungeAccountPort } from './core/ports/lounge-account.port';
import { LoungeAuthPort } from './core/ports/lounge-auth.port';
import { LoungeConfigPort } from './core/ports/lounge-config.port';
import { LoungeRewardPort } from './core/ports/lounge-reward.port';
import { LoungeSessionPort } from './core/ports/lounge-session.port';
import { LoungeFacadeService } from './core/services/lounge-facade.service';

describe('Gemitec Private Lounge Frontend Architecture & UI', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        LoungeBffAdapter,
        { provide: LoungeConfigPort, useExisting: LoungeBffAdapter },
        { provide: LoungeAuthPort, useExisting: LoungeBffAdapter },
        { provide: LoungeAccountPort, useExisting: LoungeBffAdapter },
        { provide: LoungeSessionPort, useExisting: LoungeBffAdapter },
        { provide: LoungeRewardPort, useExisting: LoungeBffAdapter },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    document.documentElement.lang = 'ja';
  });

  it('requires full scroll-to-bottom + consent check before enabling X sign-up CTA and displays version badge', async () => {
    const fixture = TestBed.createComponent(AppComponent);
    const component = fixture.componentInstance;
    fixture.detectChanges();

    expect(appConfig.providers.length).toBeGreaterThanOrEqual(7);
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-testid="auth-version"]')?.textContent?.trim()).toBe('v1.45.2');

    const checkbox = host.querySelector('#lounge-consent-checkbox') as HTMLInputElement;
    const signUpBtn = host.querySelector('#btn-x-signup') as HTMLButtonElement;
    expect(checkbox.disabled).toBe(true);
    expect(signUpBtn.disabled).toBe(true);

    // Attempting premature consent toggle or submit must remain blocked
    component.facade.setDisclaimerChecked(true);
    await component.facade.submitSignUpWithX();
    fixture.detectChanges();
    expect(component.facade.disclaimerChecked()).toBe(false);
    expect(component.facade.activeView()).toBe('AUTH');
    expect(component.facade.errorMessage()).toBeTruthy();

    // Error alert banner dismisses cleanly
    (host.querySelector('.error-dismiss-btn') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(component.facade.errorMessage()).toBeNull();

    // Partial scroll unlocks progress without enabling agreement
    component.facade.updateDisclaimerScroll(60, 180, 400);
    fixture.detectChanges();
    expect(component.facade.disclaimerScrollProgress()).toBe(27);
    expect(component.facade.disclaimerScrolledToBottom()).toBe(false);

    // Full scroll to bottom unlocks checkbox, checking unlocks sign-up CTA
    component.onDisclaimerScroll({
      target: { scrollTop: 220, clientHeight: 180, scrollHeight: 400 },
    } as unknown as Event);
    fixture.detectChanges();
    expect(component.facade.disclaimerScrolledToBottom()).toBe(true);
    expect((host.querySelector('#lounge-consent-checkbox') as HTMLInputElement).disabled).toBe(false);

    component.onConsentCheckboxChange({
      target: { checked: true },
    } as unknown as Event);
    fixture.detectChanges();
    expect((host.querySelector('#btn-x-signup') as HTMLButtonElement).disabled).toBe(false);

    await component.facade.submitSignUpWithX();
    fixture.detectChanges();
    expect(component.facade.activeView()).toBe('CHAT');
    expect(host.querySelector('#btn-hamburger')).not.toBeNull();
  });

  it('handles hamburger sidebar drawer focus trap, rewards lightbox, quota display, and logout', async () => {
    const fixture = TestBed.createComponent(AppComponent);
    const component = fixture.componentInstance;
    fixture.detectChanges();

    component.facade.setAuthMode('LOGIN');
    fixture.detectChanges();
    await component.facade.submitLoginWithX();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(component.facade.activeView()).toBe('CHAT');
    expect(host.querySelector('[data-testid="hud-remaining-turns"]')?.textContent).toContain('24/30');

    // Open slide-over sidebar via top-left hamburger button
    const hamburgerBtn = host.querySelector('#btn-hamburger') as HTMLButtonElement;
    hamburgerBtn.click();
    fixture.detectChanges();
    await Promise.resolve();
    expect(component.facade.isSidebarOpen()).toBe(true);
    expect(host.querySelector('[data-testid="sidebar-subscription-tier"]')?.textContent).toContain(
      'SUPPORTER // ACTIVE',
    );
    expect(host.querySelector('[data-testid="sidebar-remaining-turns"]')?.textContent).toContain(
      '24 / 30',
    );
    expect(host.querySelector('[data-testid="sidebar-version"]')?.textContent?.trim()).toBe('v1.45.2');

    // Focus trap ignores non-Tab keys, middle elements, and cycles Tab/Shift+Tab between endpoints
    component.onDrawerKeydown(new KeyboardEvent('keydown', { key: 'Enter' }));
    const closeBtn = host.querySelector('#btn-close-sidebar') as HTMLButtonElement;
    const chatNavBtn = host.querySelector('#nav-lounge-chat') as HTMLButtonElement;
    const logoutBtn = host.querySelector('#btn-logout') as HTMLButtonElement;
    jest.spyOn(logoutBtn, 'focus').mockImplementation(() => undefined);
    jest.spyOn(closeBtn, 'focus').mockImplementation(() => undefined);
    Object.defineProperty(document, 'activeElement', { value: chatNavBtn, configurable: true });
    component.onDrawerKeydown(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: false }));
    expect(closeBtn.focus).not.toHaveBeenCalled();

    Object.defineProperty(document, 'activeElement', { value: closeBtn, configurable: true });
    component.onDrawerKeydown(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }));
    expect(logoutBtn.focus).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'activeElement', { value: logoutBtn, configurable: true });
    component.onDrawerKeydown(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: false }));
    expect(closeBtn.focus).toHaveBeenCalledTimes(1);

    // Escape closes drawer cleanly (and is a no-op when already closed)
    component.onEscapeKey();
    fixture.detectChanges();
    expect(component.facade.isSidebarOpen()).toBe(false);
    component.onEscapeKey();
    expect(component.facade.isSidebarOpen()).toBe(false);

    // Reopen drawer and navigate to Rewards gallery + open/close Lightbox
    hamburgerBtn.click();
    fixture.detectChanges();
    (host.querySelector('#nav-lounge-rewards') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(component.facade.activeView()).toBe('REWARDS');
    expect(component.facade.isSidebarOpen()).toBe(false);
    expect(host.querySelectorAll('.reward-card').length).toBe(6);

    // Clicking locked reward ignores lightbox open; unlocked card opens lightbox
    component.openRewardLightbox(component.facade.rewards()[4]);
    expect(component.selectedLightboxReward()).toBeNull();

    (host.querySelector('.reward-media-trigger') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(component.selectedLightboxReward()?.code).toBe('RW-01');
    expect(host.querySelector('#reward-lightbox-modal')).not.toBeNull();

    // Escape closes lightbox cleanly
    component.onEscapeKey();
    fixture.detectChanges();
    expect(component.selectedLightboxReward()).toBeNull();

    // Return to Chat, toggle language, and send a message
    (host.querySelector('#btn-back-to-chat') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(component.facade.activeView()).toBe('CHAT');

    component.facade.toggleLanguage();
    fixture.detectChanges();
    expect(component.facade.lang()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(component.personaDisplayName()).toBe('AI Companion');
    expect(component.getEmotionLabel('TEASING')).toBe('TEASING');

    component.facade.composerDraft.set('Hello Private Lounge!');
    await component.onSubmitMessage(new Event('submit'));
    fixture.detectChanges();
    expect(component.facade.messages().length).toBe(5);
    expect(component.facade.accountSummary()?.subscription.remainingChatTurns).toBe(23);

    // Logout resets authenticated state, consent progress, rewards, and returns to Auth Login tab
    hamburgerBtn.click();
    fixture.detectChanges();
    await component.facade.logout();
    fixture.detectChanges();
    expect(component.facade.activeView()).toBe('AUTH');
    expect(component.facade.authMode()).toBe('LOGIN');
    expect(component.facade.accountSummary()).toBeNull();
    expect(component.facade.rewards().length).toBe(0);
    expect(component.facade.disclaimerChecked()).toBe(false);
  });

  it('enforces BFF adapter boundaries, resets messages on createSession, and syncs unlocked rewards', async () => {
    const adapter = TestBed.inject(LoungeBffAdapter);
    expect(await adapter.getCurrentSession()).toBeNull();

    const mockFetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          appVersion: 'v1.45.2',
          disclaimerVersion: '2026-11-22',
          persona: {
            displayName: 'レベッカ',
            englishName: 'Rebecca',
            brandName: 'Rebecca AI',
            avatarPath: 'assets/persona_cutout.webp',
          },
        }),
      })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ appVersion: 'v1', disclaimerVersion: 'd1', persona: null }),
      })
      .mockRejectedValueOnce(new Error('network down'));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    const liveCfg = await adapter.getRuntimeConfig();
    expect(liveCfg.persona.englishName).toBe('Rebecca');
    expect((await adapter.getRuntimeConfig()).persona.englishName).toBe('AI Companion');
    expect((await adapter.getRuntimeConfig()).persona.englishName).toBe('AI Companion');
    const fallbackCfg = await adapter.getRuntimeConfig();
    expect(fallbackCfg.persona.englishName).toBe('AI Companion');
    globalThis.fetch = originalFetch;

    const unnamedSession = await adapter.createSession({});
    expect(unnamedSession.title).toBe('NEON LOUNGE // NEW SESSION');

    await expect(
      adapter.signUpWithX({
        idToken: 't',
        xOAuthCode: 'c',
        disclaimerConsent: {
          disclaimerVersion: '2026-11-22',
          agreedToGeminiTrainingUsage: false,
          agreedToZeroPiiProhibition: true,
          agreedToOneWayMemoryIsolation: true,
          scrolledToBottomAt: '2026-11-22T12:00:00.000Z',
          consentedAt: '2026-11-22T12:00:01.000Z',
        },
      }),
    ).rejects.toThrow(/Mandatory disclaimer terms/);

    await expect(adapter.sendMessage('sess_lounge_001', { content: '   ' })).rejects.toThrow(
      /cannot be empty/,
    );

    const newSession = await adapter.createSession({ title: 'Test Session' });
    expect(newSession.title).toBe('Test Session');
    const emptyMsgs = await adapter.listMessages();
    expect(emptyMsgs.items.length).toBe(0);

    // Exhaust daily quota (24 -> 0) and assert 25th call rejects cleanly
    for (let i = 0; i < 24; i++) {
      await adapter.sendMessage(newSession.id, { content: `turn ${i}` });
    }
    await expect(adapter.sendMessage(newSession.id, { content: 'overflow' })).rejects.toThrow(
      /quota exhausted/,
    );

    const facade = TestBed.inject(LoungeFacadeService);
    facade.updateDisclaimerScroll(0, 200, 200);
    expect(facade.disclaimerScrollProgress()).toBe(100);
    expect(facade.disclaimerScrolledToBottom()).toBe(true);

    // Returning unlockedReward from sendMessage unlocks card in signals immediately
    await facade.submitLoginWithX();
    expect((await adapter.getCurrentSession())?.user.uid).toBe('uid_preview_001');
    const rewardToUnlock: LoungeReward = {
      ...facade.rewards()[3],
      unlocked: true,
      previewAssetPath: 'assets/gallery_morning.webp',
      unlockedAt: '2026-11-22T13:00:00.000Z',
    };
    const activeSession = facade.activeSession();
    if (!activeSession) {
      throw new Error('Expected active session after login');
    }
    const sendSpy = jest.spyOn(adapter, 'sendMessage').mockResolvedValueOnce({
      session: activeSession,
      userMessage: {
        id: 'u_unlock',
        sessionId: newSession.id,
        uid: 'uid_preview_001',
        role: 'USER',
        content: 'Unlock check',
        emotion: 'NEUTRAL',
        createdAt: '2026-11-22T13:00:00.000Z',
      },
      assistantMessage: {
        id: 'a_unlock',
        sessionId: newSession.id,
        uid: 'uid_preview_001',
        role: 'ASSISTANT',
        content: 'Unlocked!',
        emotion: 'EXCITED',
        unlockedRewardId: rewardToUnlock.id,
        createdAt: '2026-11-22T13:00:01.000Z',
      },
      remainingChatTurns: 0,
      unlockedReward: rewardToUnlock,
    });
    await facade.sendMessage('Unlock check');
    expect(facade.rewards().find((r) => r.code === 'RW-04')?.unlocked).toBe(true);
    expect(facade.accountSummary()?.subscription.remainingChatTurns).toBe(0);
    sendSpy.mockRestore();

    // Quota exhaustion blocks UI submit cleanly
    const fixture = TestBed.createComponent(AppComponent);
    const component = fixture.componentInstance;
    fixture.detectChanges();
    expect(component.isQuotaExhausted()).toBe(true);
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-testid="quota-exhausted-banner"]')).not.toBeNull();
    await component.onSubmitMessage(new Event('submit'));

    // Guard against null event targets, logout rejection, and send errors
    component.onDisclaimerScroll({ target: null } as unknown as Event);
    component.onConsentCheckboxChange({ target: null } as unknown as Event);
    await component.facade.sendMessage('   ');

    const logoutFailSpy = jest.spyOn(adapter, 'logout').mockRejectedValueOnce(new Error('Revoke failed'));
    await facade.logout();
    expect(facade.errorMessage()).toBe('Revoke failed');
    expect(facade.activeView()).toBe('AUTH');
    logoutFailSpy.mockRestore();

    const nonErrLoginSpy = jest.spyOn(adapter, 'loginWithX').mockRejectedValueOnce('raw-login-fail');
    await facade.submitLoginWithX();
    expect(facade.errorMessage()).toBe('Login failed');
    nonErrLoginSpy.mockRestore();

    const emptySessSpy = jest
      .spyOn(adapter, 'listSessions')
      .mockResolvedValueOnce({ items: [], nextCursor: null, totalCount: 0 });
    await facade.submitLoginWithX();
    expect(facade.activeSession()?.title).toBe('Private Lounge #01');
    emptySessSpy.mockRestore();

    const rawSendFailSpy = jest.spyOn(adapter, 'sendMessage').mockRejectedValueOnce('raw-send-fail');
    await facade.sendMessage('Fail check');
    expect(facade.errorMessage()).toBe('Failed to send message');
    rawSendFailSpy.mockRestore();

    const rawLogoutSpy = jest.spyOn(adapter, 'logout').mockRejectedValueOnce('raw-logout-fail');
    await facade.logout();
    expect(facade.errorMessage()).toBe('Logout failed');
    rawLogoutSpy.mockRestore();
  });

  it('supports isolated port injection via LoungeConfigPort without concrete adapter dependency', async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      providers: [
        {
          provide: LoungeConfigPort,
          useValue: {
            getRuntimeConfig: async () => {
              throw new Error('Config unreachable');
            },
          },
        },
        {
          provide: LoungeAuthPort,
          useValue: {
            getCurrentSession: async () => null,
            loginWithX: async () => {
              throw new Error('Blocked');
            },
            signUpWithX: async () => {
              throw 'raw signUp error';
            },
            logout: async () => undefined,
          },
        },
        {
          provide: LoungeAccountPort,
          useValue: {
            getAccountSummary: async () => ({
              user: {
                uid: 'u1',
                xUserId: '1',
                xHandle: '@u1',
                displayName: 'User 1',
                avatarUrl: '',
                status: 'ACTIVE',
                disclaimerConsent: {
                  disclaimerVersion: '2026-11-22',
                  agreedToGeminiTrainingUsage: true,
                  agreedToZeroPiiProhibition: true,
                  agreedToOneWayMemoryIsolation: true,
                  scrolledToBottomAt: '2026-11-22T12:00:00.000Z',
                  consentedAt: '2026-11-22T12:00:01.000Z',
                },
                createdAt: '2026-11-22T12:00:00.000Z',
                updatedAt: '2026-11-22T12:00:00.000Z',
                lastLoginAt: '2026-11-22T12:00:00.000Z',
              },
              subscription: {
                uid: 'u1',
                tier: 'FREE',
                status: 'ACTIVE',
                dailyTurnQuota: 0,
                remainingChatTurns: 0,
                quotaResetAt: '2026-11-23T00:00:00.000Z',
                currentPeriodEnd: '2026-12-22T00:00:00.000Z',
                updatedAt: '2026-11-22T12:00:00.000Z',
              },
              publicXMemoryOneWayActive: true,
              unlockedRewardCount: 0,
              totalRewardCount: 0,
              appVersion: 'v1.45.2',
            }),
          },
        },
        {
          provide: LoungeSessionPort,
          useValue: {
            listSessions: async () => ({ items: [], nextCursor: null, totalCount: 0 }),
            createSession: async () => ({}),
            listMessages: async () => ({ items: [], nextCursor: null, totalCount: 0 }),
            sendMessage: async () => ({}),
          },
        },
        {
          provide: LoungeRewardPort,
          useValue: {
            listRewards: async () => ({ items: [], unlockedCount: 0, totalCount: 0, nextCursor: null }),
          },
        },
      ],
    });

    const facade = TestBed.inject(LoungeFacadeService);
    await facade.loadRuntimeConfig();
    expect(facade.personaBranding().displayName).toBe('AIコンパニオン');
    expect(facade.remainingTurnsPercent()).toBe(0);

    facade.toggleLanguage(); // -> 'en'
    await facade.submitSignUpWithX();
    expect(facade.errorMessage()).toMatch(/scroll to the bottom/i);

    facade.updateDisclaimerScroll(100, 100, 200);
    facade.setDisclaimerChecked(true);
    await facade.submitSignUpWithX();
    expect(facade.errorMessage()).toBe('Sign-up failed');

    facade.toggleSidebar(true);
    expect(facade.isSidebarOpen()).toBe(true);
    facade.toggleSidebar();
    expect(facade.isSidebarOpen()).toBe(false);
  });
});
