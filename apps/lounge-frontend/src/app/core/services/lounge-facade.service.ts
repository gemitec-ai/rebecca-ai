import { Injectable, computed, inject, signal } from '@angular/core';
import type {
  LoungeAccountSummaryDto,
  LoungeGalleryItem,
  LoungeLanguage,
  LoungeMessage,
  LoungePersonaBranding,
  LoungeSession,
} from '@rebecca/types';
import { environment } from '../../../environments/environment';
import {
  LOUNGE_TRANSLATIONS,
  formatLoungeCopy,
  type LoungeLocaleCopy,
} from '../i18n/lounge-translations';
import { LoungeAccountPort } from '../ports/lounge-account.port';
import { LoungeAuthPort } from '../ports/lounge-auth.port';
import { LoungeConfigPort } from '../ports/lounge-config.port';
import { LoungeGalleryPort } from '../ports/lounge-gallery.port';
import { LoungeSessionPort } from '../ports/lounge-session.port';

/** Top-level UI views in the Gemitec Private Lounge application. */
export type LoungeActiveView = 'AUTH' | 'ONBOARDING' | 'CHAT' | 'GALLERY' | 'OPTIONS';

/** Authentication tab modes on the X-linked entrance view. */
export type LoungeAuthMode = 'LOGIN' | 'SIGNUP';

function resolveFallbackPersonaBranding(): LoungePersonaBranding {
  return {
    ...environment.persona,
    emotionAvatarPaths: { ...environment.persona.emotionAvatarPaths },
  };
}

/**
 * Signal-driven application facade orchestrating Auth, Onboarding locale confirmation,
 * Single-Session Chat, Slide-Over Sidebar, Gallery collection, Options preferences, and
 * 2-step irreversible Account Withdrawal.
 */
@Injectable({ providedIn: 'root' })
export class LoungeFacadeService {
  private readonly configPort = inject(LoungeConfigPort, { optional: true });
  private readonly authPort = inject(LoungeAuthPort);
  private readonly accountPort = inject(LoungeAccountPort);
  private readonly sessionPort = inject(LoungeSessionPort);
  private readonly galleryPort = inject(LoungeGalleryPort);

  public readonly activeView = signal<LoungeActiveView>('AUTH');
  public readonly authMode = signal<LoungeAuthMode>('SIGNUP');
  public readonly isSidebarOpen = signal<boolean>(false);
  public readonly lang = signal<LoungeLanguage>('ja');
  public readonly timezone = signal<string>('Asia/Tokyo');
  public readonly optionsSavedNotice = signal<string | null>(null);
  public readonly appVersion = signal<string>(environment.appVersion);
  public readonly disclaimerVersion = signal<string>(environment.disclaimerVersion);

  public readonly disclaimerScrollProgress = signal<number>(0);
  public readonly disclaimerScrolledToBottom = signal<boolean>(false);
  public readonly disclaimerScrolledAt = signal<string | null>(null);
  public readonly disclaimerChecked = signal<boolean>(false);

  public readonly deleteAccountStep = signal<0 | 1 | 2>(0);
  public readonly deleteConfirmIrreversible = signal<boolean>(false);
  public readonly deleteConfirmNoRefund = signal<boolean>(false);

  public readonly isLoading = signal<boolean>(false);
  public readonly errorMessage = signal<string | null>(null);
  public readonly composerDraft = signal<string>('');

  public readonly accountSummary = signal<LoungeAccountSummaryDto | null>(null);
  public readonly activeSession = signal<LoungeSession | null>(null);
  public readonly messages = signal<readonly LoungeMessage[]>([]);
  public readonly galleryItems = signal<readonly LoungeGalleryItem[]>([]);

  public readonly personaBranding = signal<LoungePersonaBranding>(resolveFallbackPersonaBranding());

  public readonly personaDisplayName = computed(() => {
    const branding = this.personaBranding();
    return this.lang() === 'ja' ? branding.displayName : branding.englishName;
  });

  public readonly copy = computed<LoungeLocaleCopy>(() => LOUNGE_TRANSLATIONS[this.lang()]);

  public readonly canSubmitSignUp = computed(
    () =>
      !this.isLoading() &&
      this.disclaimerScrolledToBottom() &&
      this.disclaimerChecked(),
  );

  public readonly canConfirmDeleteAccount = computed(
    () =>
      !this.isLoading() &&
      this.deleteAccountStep() === 2 &&
      this.deleteConfirmIrreversible() &&
      this.deleteConfirmNoRefund(),
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

  /** Interpolates `{name}` in localized copy templates using current active persona name. */
  public t(key: keyof LoungeLocaleCopy): string {
    return formatLoungeCopy(this.copy()[key], this.personaDisplayName());
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

  /**
   * Updates UI & AI conversation language across 8 supported locales, persisting via
   * `/account/preferences` when already inside the Lounge and rolling back cleanly on failure.
   */
  public async setLanguage(nextLang: LoungeLanguage): Promise<void> {
    const previousLang = this.lang();
    this.lang.set(nextLang);
    if (typeof document !== 'undefined') {
      document.documentElement.lang = nextLang;
    }
    this.optionsSavedNotice.set(null);

    if (this.accountSummary() && this.activeView() !== 'ONBOARDING') {
      try {
        const updatedUser = await this.accountPort.updatePreferences({ language: nextLang });
        this.accountSummary.update((prev) => (prev ? { ...prev, user: updatedUser } : prev));
        this.optionsSavedNotice.set(this.t('optionsSavedNotice'));
      } catch (err) {
        this.lang.set(previousLang);
        if (typeof document !== 'undefined') {
          document.documentElement.lang = previousLang;
        }
        this.errorMessage.set(err instanceof Error ? err.message : 'Failed to update language');
      }
    }
  }

  /**
   * Updates user IANA timezone preference, persisting via `/account/preferences` when already
   * inside the Lounge and rolling back cleanly if backend persistence rejects.
   */
  public async setTimezone(nextTimezone: string): Promise<void> {
    const previousTimezone = this.timezone();
    this.timezone.set(nextTimezone);
    this.optionsSavedNotice.set(null);

    if (this.accountSummary() && this.activeView() !== 'ONBOARDING') {
      try {
        const updatedUser = await this.accountPort.updatePreferences({ timezone: nextTimezone });
        this.accountSummary.update((prev) => (prev ? { ...prev, user: updatedUser } : prev));
        this.optionsSavedNotice.set(this.t('optionsSavedNotice'));
      } catch (err) {
        this.timezone.set(previousTimezone);
        this.errorMessage.set(err instanceof Error ? err.message : 'Failed to update timezone');
      }
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

  /** Authenticates an existing X-linked user and opens their persistent Private Lounge Chat session. */
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

  /**
   * Completes Step 1 & Step 2 of Sign-Up (`同意 -> X連携`), enforcing scroll-verified terms and
   * 1:1 X linkage, then transitions to `ONBOARDING` so the user confirms Language & Timezone.
   */
  public async submitSignUpWithX(
    idToken = 'x-session-id-token',
    xOAuthCode = 'x-oauth-authorization-code',
  ): Promise<void> {
    if (!this.canSubmitSignUp()) {
      this.errorMessage.set(this.t('scrollRequiredError'));
      return;
    }
    this.isLoading.set(true);
    this.errorMessage.set(null);
    try {
      const scrolledAt = this.disclaimerScrolledAt() ?? new Date().toISOString();
      await this.authPort.signUpWithX({
        idToken,
        xOAuthCode,
        language: this.lang(),
        timezone: this.timezone(),
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
      this.activeView.set('ONBOARDING');
      this.isSidebarOpen.set(false);
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Sign-up failed');
    } finally {
      this.isLoading.set(false);
    }
  }

  /**
   * Completes Sign-Up Step 3 & Step 4 (`言語・タイムゾーン確定 -> 使用開始`) and enters Chat.
   */
  public async completeOnboarding(): Promise<void> {
    this.isLoading.set(true);
    this.errorMessage.set(null);
    try {
      const updatedUser = await this.accountPort.updatePreferences({
        language: this.lang(),
        timezone: this.timezone(),
      });
      this.accountSummary.update((prev) => (prev ? { ...prev, user: updatedUser } : prev));
      this.activeView.set('CHAT');
      this.isSidebarOpen.set(false);
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Failed to confirm setup');
    } finally {
      this.isLoading.set(false);
    }
  }

  /** Opens or closes the Slide-Over Sidebar triggered from the top-left hamburger icon. */
  public toggleSidebar(forceState?: boolean): void {
    this.isSidebarOpen.update((open) => (forceState !== undefined ? forceState : !open));
  }

  /** Navigates across authenticated Lounge views and closes the Sidebar drawer automatically. */
  public navigateTo(view: 'CHAT' | 'GALLERY' | 'OPTIONS'): void {
    this.optionsSavedNotice.set(null);
    this.activeView.set(view);
    this.isSidebarOpen.set(false);
  }

  /** Submits a new chat turn in the user's single session and updates messages, quota, and Gallery. */
  public async sendMessage(content: string): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed || !this.activeSession() || this.isLoading()) {
      return;
    }
    this.isLoading.set(true);
    this.errorMessage.set(null);
    try {
      const res = await this.sessionPort.sendMessage({ content: trimmed });
      this.activeSession.set(res.session);
      this.messages.update((prev) => [...prev, res.userMessage, res.assistantMessage]);

      const unlocked = res.unlockedGalleryItem;
      if (unlocked) {
        this.galleryItems.update((items) => {
          const exists = items.some(
            (item) => item.id === unlocked.id || item.assetId === unlocked.assetId,
          );
          return exists
            ? items.map((item) =>
                item.id === unlocked.id || item.assetId === unlocked.assetId ? unlocked : item,
              )
            : [unlocked, ...items];
        });
      }

      this.accountSummary.update((prev) =>
        prev
          ? {
              ...prev,
              unlockedGalleryCount: unlocked
                ? this.galleryItems().filter((item) => item.unlocked).length
                : prev.unlockedGalleryCount,
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

  /** Opens Step 1 of the multi-step Account Deletion confirmation dialog from Options. */
  public openDeleteAccountModal(): void {
    this.deleteConfirmIrreversible.set(false);
    this.deleteConfirmNoRefund.set(false);
    this.deleteAccountStep.set(1);
    this.errorMessage.set(null);
  }

  /** Advances from initial deletion warning (Step 1) to final consent checkboxes (Step 2). */
  public proceedToDeleteAccountStep2(): void {
    if (this.deleteAccountStep() === 1) {
      this.deleteAccountStep.set(2);
    }
  }

  /** Cancels Account Deletion confirmation and resets all checkboxes safely. */
  public closeDeleteAccountModal(): void {
    this.deleteAccountStep.set(0);
    this.deleteConfirmIrreversible.set(false);
    this.deleteConfirmNoRefund.set(false);
  }

  /** Toggles mandatory acknowledgement that all data erasure is permanent and unrecoverable. */
  public setDeleteConfirmIrreversible(checked: boolean): void {
    this.deleteConfirmIrreversible.set(checked);
  }

  /** Toggles mandatory acknowledgement that no refunds apply for paid plans or unused turns. */
  public setDeleteConfirmNoRefund(checked: boolean): void {
    this.deleteConfirmNoRefund.set(checked);
  }

  /**
   * Executes irreversible cascade deletion via `DELETE /account` once Step 2 checkboxes are checked,
   * wiping local session state and returning cleanly to Sign-Up view.
   */
  public async confirmDeleteAccount(): Promise<void> {
    if (!this.canConfirmDeleteAccount()) {
      return;
    }
    this.isLoading.set(true);
    this.errorMessage.set(null);
    try {
      await this.accountPort.deleteAccount({
        confirmedIrreversibleDeletion: true,
        confirmedNoRefundForRemainingTurns: true,
      });
      this.resetLocalSessionState('SIGNUP');
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Account deletion failed');
    } finally {
      this.isLoading.set(false);
    }
  }

  /** Logs out cleanly, resets all user state, closes the Sidebar drawer, and returns to Login view. */
  public async logout(): Promise<void> {
    this.isLoading.set(true);
    try {
      await this.authPort.logout();
      this.errorMessage.set(null);
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Logout failed');
    } finally {
      this.resetLocalSessionState('LOGIN');
      this.isLoading.set(false);
    }
  }

  private resetLocalSessionState(nextAuthMode: LoungeAuthMode): void {
    this.accountSummary.set(null);
    this.activeSession.set(null);
    this.messages.set([]);
    this.galleryItems.set([]);
    this.composerDraft.set('');
    this.optionsSavedNotice.set(null);
    this.disclaimerChecked.set(false);
    this.disclaimerScrolledToBottom.set(false);
    this.disclaimerScrollProgress.set(0);
    this.disclaimerScrolledAt.set(null);
    this.closeDeleteAccountModal();
    this.isSidebarOpen.set(false);
    this.activeView.set('AUTH');
    this.authMode.set(nextAuthMode);
  }

  private markDisclaimerScrolledToBottom(): void {
    if (!this.disclaimerScrolledToBottom()) {
      this.disclaimerScrolledToBottom.set(true);
      this.disclaimerScrolledAt.set(new Date().toISOString());
    }
  }

  private async hydrateAuthenticatedLounge(): Promise<void> {
    const [summary, session, galleryPage, messagesPage] = await Promise.all([
      this.accountPort.getAccountSummary(),
      this.sessionPort.getSession(),
      this.galleryPort.listGallery(50),
      this.sessionPort.listMessages(50),
    ]);
    this.accountSummary.set(summary);
    this.lang.set(summary.user.language);
    this.timezone.set(summary.user.timezone);
    if (typeof document !== 'undefined') {
      document.documentElement.lang = summary.user.language;
    }
    if (summary.persona) {
      this.personaBranding.set(summary.persona);
    }
    this.galleryItems.set(galleryPage.items);
    this.activeSession.set(session);
    this.messages.set(messagesPage.items);
  }
}
