import { Injectable, computed, inject, signal } from '@angular/core';
import type {
  LoungeAccountSummaryDto,
  LoungeMessage,
  LoungePersonaBranding,
  LoungeReward,
  LoungeSession,
} from '@rebecca/types';
import { environment } from '../../../environments/environment';
import { LoungeAccountPort } from '../ports/lounge-account.port';
import { LoungeAuthPort } from '../ports/lounge-auth.port';
import { LoungeConfigPort } from '../ports/lounge-config.port';
import { LoungeRewardPort } from '../ports/lounge-reward.port';
import { LoungeSessionPort } from '../ports/lounge-session.port';

/** Top-level UI views in the Gemitec Private Lounge application. */
export type LoungeActiveView = 'AUTH' | 'CHAT' | 'REWARDS';

/** Authentication tab modes on the X-linked entrance view. */
export type LoungeAuthMode = 'LOGIN' | 'SIGNUP';

/** Supported UI display languages. */
export type LoungeLanguage = 'ja' | 'en';

function resolveFallbackPersonaBranding(): LoungePersonaBranding {
  return { ...environment.persona };
}

/**
 * Signal-driven application facade orchestrating Auth, Chat Stage, Slide-Over Sidebar,
 * scroll-gated disclaimer validation, and Rewards gallery transitions.
 */
@Injectable({ providedIn: 'root' })
export class LoungeFacadeService {
  private readonly configPort = inject(LoungeConfigPort, { optional: true });
  private readonly authPort = inject(LoungeAuthPort);
  private readonly accountPort = inject(LoungeAccountPort);
  private readonly sessionPort = inject(LoungeSessionPort);
  private readonly rewardPort = inject(LoungeRewardPort);

  public readonly activeView = signal<LoungeActiveView>('AUTH');
  public readonly authMode = signal<LoungeAuthMode>('SIGNUP');
  public readonly isSidebarOpen = signal<boolean>(false);
  public readonly lang = signal<LoungeLanguage>('ja');
  public readonly appVersion = signal<string>(environment.appVersion);
  public readonly disclaimerVersion = signal<string>(environment.disclaimerVersion);

  public readonly disclaimerScrollProgress = signal<number>(0);
  public readonly disclaimerScrolledToBottom = signal<boolean>(false);
  public readonly disclaimerScrolledAt = signal<string | null>(null);
  public readonly disclaimerChecked = signal<boolean>(false);

  public readonly isLoading = signal<boolean>(false);
  public readonly errorMessage = signal<string | null>(null);
  public readonly composerDraft = signal<string>('');

  public readonly accountSummary = signal<LoungeAccountSummaryDto | null>(null);
  public readonly activeSession = signal<LoungeSession | null>(null);
  public readonly messages = signal<readonly LoungeMessage[]>([]);
  public readonly rewards = signal<readonly LoungeReward[]>([]);

  public readonly personaBranding = signal<LoungePersonaBranding>(resolveFallbackPersonaBranding());

  public readonly canSubmitSignUp = computed(
    () =>
      !this.isLoading() &&
      this.disclaimerScrolledToBottom() &&
      this.disclaimerChecked(),
  );

  public readonly remainingTurnsPercent = computed(() => {
    const sub = this.accountSummary()?.subscription;
    if (!sub || sub.dailyTurnQuota <= 0) {
      return 0;
    }
    return Math.min(100, Math.max(0, Math.round((sub.remainingChatTurns / sub.dailyTurnQuota) * 100)));
  });

  constructor() {
    void this.loadRuntimeConfig();
  }

  /** Loads runtime version, disclaimer version, and pluggable persona metadata via `LoungeConfigPort`. */
  public async loadRuntimeConfig(): Promise<void> {
    if (!this.configPort) {
      return;
    }
    try {
      const config = await this.configPort.getRuntimeConfig();
      this.appVersion.set(config.appVersion);
      this.disclaimerVersion.set(config.disclaimerVersion);
      this.personaBranding.set(config.persona);
    } catch {
      this.personaBranding.set(resolveFallbackPersonaBranding());
    }
  }

  /** Clears any visible error banner message. */
  public dismissError(): void {
    this.errorMessage.set(null);
  }

  /** Switches between Login and Sign-Up modes on the X-linked entrance card. */
  public setAuthMode(mode: LoungeAuthMode): void {
    this.authMode.set(mode);
    this.errorMessage.set(null);
  }

  /** Toggles between Japanese and English HUD/UI labels and syncs document root language. */
  public toggleLanguage(): void {
    const nextLang: LoungeLanguage = this.lang() === 'ja' ? 'en' : 'ja';
    this.lang.set(nextLang);
    if (typeof document !== 'undefined') {
      document.documentElement.lang = nextLang;
    }
  }

  /** Records scroll progress inside the Sign-Up disclaimer and unlocks agreement at bottom. */
  public updateDisclaimerScroll(scrollTop: number, clientHeight: number, scrollHeight: number): void {
    const maxScroll = Math.max(scrollHeight - clientHeight, 0);
    if (maxScroll === 0) {
      this.disclaimerScrollProgress.set(100);
      this.markDisclaimerScrolledToBottom();
      return;
    }
    const ratio = Math.min(1, Math.max(0, scrollTop / maxScroll));
    this.disclaimerScrollProgress.set(Math.round(ratio * 100));
    if (scrollHeight - scrollTop - clientHeight <= 6) {
      this.markDisclaimerScrolledToBottom();
    }
  }

  /** Toggles the sign-up consent checkbox only when the disclaimer has been scrolled to bottom. */
  public setDisclaimerChecked(checked: boolean): void {
    if (!this.disclaimerScrolledToBottom()) {
      return;
    }
    this.disclaimerChecked.set(checked);
  }

  /** Authenticates an existing X-linked user and hydrates account, chat session, and rewards. */
  public async submitLoginWithX(idToken = 'x-session-id-token'): Promise<void> {
    this.isLoading.set(true);
    this.errorMessage.set(null);
    try {
      await this.authPort.loginWithX({ idToken });
      await this.hydrateAuthenticatedLounge();
      this.activeView.set('CHAT');
      this.isSidebarOpen.set(false);
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Login failed');
    } finally {
      this.isLoading.set(false);
    }
  }

  /** Registers a new X-linked user after enforcing scroll-verified disclaimer consent. */
  public async submitSignUpWithX(
    idToken = 'x-session-id-token',
    xOAuthCode = 'x-oauth-authorization-code',
  ): Promise<void> {
    if (!this.canSubmitSignUp()) {
      this.errorMessage.set(
        this.lang() === 'ja'
          ? '免責事項を最後までスクロールして同意チェックを行ってください。'
          : 'Please scroll to the bottom of the disclaimer and accept all terms.',
      );
      return;
    }
    this.isLoading.set(true);
    this.errorMessage.set(null);
    try {
      const scrolledAt = this.disclaimerScrolledAt() ?? new Date().toISOString();
      await this.authPort.signUpWithX({
        idToken,
        xOAuthCode,
        disclaimerConsent: {
          disclaimerVersion: this.disclaimerVersion(),
          agreedToGeminiTrainingUsage: true,
          agreedToZeroPiiProhibition: true,
          agreedToOneWayMemoryIsolation: true,
          scrolledToBottomAt: scrolledAt,
          consentedAt: new Date().toISOString(),
        },
      });
      await this.hydrateAuthenticatedLounge();
      this.activeView.set('CHAT');
      this.isSidebarOpen.set(false);
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Sign-up failed');
    } finally {
      this.isLoading.set(false);
    }
  }

  /** Opens or closes the Slide-Over Sidebar triggered from the top-left hamburger icon. */
  public toggleSidebar(forceState?: boolean): void {
    this.isSidebarOpen.update((open) => (forceState !== undefined ? forceState : !open));
  }

  /** Navigates between Chat and Rewards views and automatically closes the Sidebar drawer. */
  public navigateTo(view: 'CHAT' | 'REWARDS'): void {
    this.activeView.set(view);
    this.isSidebarOpen.set(false);
  }

  /** Submits a new chat turn to the session port and updates messages, quota, and rewards. */
  public async sendMessage(content: string): Promise<void> {
    const trimmed = content.trim();
    const session = this.activeSession();
    if (!trimmed || !session || this.isLoading()) {
      return;
    }
    this.isLoading.set(true);
    this.errorMessage.set(null);
    try {
      const res = await this.sessionPort.sendMessage(session.id, { content: trimmed });
      this.activeSession.set(res.session);
      this.messages.update((prev) => [...prev, res.userMessage, res.assistantMessage]);

      const unlocked = res.unlockedReward;
      if (unlocked) {
        this.rewards.update((items) => {
          const exists = items.some((item) => item.id === unlocked.id || item.code === unlocked.code);
          return exists
            ? items.map((item) =>
                item.id === unlocked.id || item.code === unlocked.code ? unlocked : item,
              )
            : [unlocked, ...items];
        });
      }

      this.accountSummary.update((prev) =>
        prev
          ? {
              ...prev,
              unlockedRewardCount: unlocked
                ? this.rewards().filter((item) => item.unlocked).length
                : prev.unlockedRewardCount,
              subscription: {
                ...prev.subscription,
                remainingChatTurns: res.remainingChatTurns,
              },
            }
          : prev,
      );
      this.composerDraft.set('');
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      this.isLoading.set(false);
    }
  }

  /** Logs out cleanly, closes the Sidebar drawer, resets all user state, and returns to Auth view. */
  public async logout(): Promise<void> {
    this.isLoading.set(true);
    try {
      await this.authPort.logout();
      this.errorMessage.set(null);
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Logout failed');
    } finally {
      this.accountSummary.set(null);
      this.activeSession.set(null);
      this.messages.set([]);
      this.rewards.set([]);
      this.composerDraft.set('');
      this.disclaimerChecked.set(false);
      this.disclaimerScrolledToBottom.set(false);
      this.disclaimerScrollProgress.set(0);
      this.disclaimerScrolledAt.set(null);
      this.isSidebarOpen.set(false);
      this.activeView.set('AUTH');
      this.authMode.set('LOGIN');
      this.isLoading.set(false);
    }
  }

  private markDisclaimerScrolledToBottom(): void {
    if (!this.disclaimerScrolledToBottom()) {
      this.disclaimerScrolledToBottom.set(true);
      this.disclaimerScrolledAt.set(new Date().toISOString());
    }
  }

  private async hydrateAuthenticatedLounge(): Promise<void> {
    const [summary, sessionsPage, rewardsPage] = await Promise.all([
      this.accountPort.getAccountSummary(),
      this.sessionPort.listSessions(20),
      this.rewardPort.listRewards(50),
    ]);
    this.accountSummary.set(summary);
    if (summary.persona) {
      this.personaBranding.set(summary.persona);
    }
    this.rewards.set(rewardsPage.items);
    const primarySession =
      sessionsPage.items[0] ?? (await this.sessionPort.createSession({ title: 'Private Lounge #01' }));
    this.activeSession.set(primarySession);
    const messagesPage = await this.sessionPort.listMessages(primarySession.id, 50);
    this.messages.set(messagesPage.items);
  }
}
