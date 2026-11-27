import { Injectable, computed, inject, signal } from '@angular/core';
import type { LoungeAuthSessionDto, LoungeUser } from '@rebecca/types';
import { LoungeClientApiError } from '../errors/lounge-client.errors';
import { LoungeAccountPort } from '../ports/lounge-account.port';
import { LoungeAuthPort } from '../ports/lounge-auth.port';
import { LoungeAuthService } from '../services/lounge-auth.service';
import {
  assertValidReconsentSubmission,
  assertValidSignUpConsent,
} from '../validators/lounge-business.validator';
import { LoungeAccountOptionsStore } from './lounge-account-options.store';
import { LoungeShellStore, type LoungeActiveView } from './lounge-shell.store';

/** Authentication tab modes on the X-linked entrance view. */
export type LoungeAuthMode = 'LOGIN' | 'SIGNUP';

/**
 * Feature store orchestrating Firebase X authentication, session restoration,
 * scroll-verified disclaimer consent, mid-session re-consent gating, and logout.
 */
@Injectable({ providedIn: 'root' })
export class LoungeAuthStore {
  private readonly authPort = inject(LoungeAuthPort);
  private readonly accountPort = inject(LoungeAccountPort);
  private readonly authService = inject(LoungeAuthService);
  private readonly shell = inject(LoungeShellStore);
  private readonly accountStore = inject(LoungeAccountOptionsStore);

  public readonly authMode = signal<LoungeAuthMode>('LOGIN');
  public readonly isReconsentRequired = signal<boolean>(false);
  public readonly disclaimerScrollProgress = signal<number>(0);
  public readonly disclaimerScrolledToBottom = signal<boolean>(false);
  public readonly disclaimerScrolledAt = signal<string | null>(null);
  public readonly disclaimerChecked = signal<boolean>(false);
  public readonly nonEeaEligibilityChecked = signal<boolean>(false);

  public readonly canSubmitSignUp = computed(
    () =>
      !this.shell.isLoading() &&
      this.disclaimerScrolledToBottom() &&
      this.disclaimerChecked() &&
      (this.shell.phase2EeaEnabled() || this.nonEeaEligibilityChecked()),
  );

  /**
   * Restores any active Firebase + BFF session silently on startup. When Firebase config is present,
   * waits for Firebase Auth persistence initialization, fetches an ID token, and signs out stale
   * Firebase state cleanly on `401`/`403`/`404`.
   */
  public async restoreSession(): Promise<LoungeAuthSessionDto | null> {
    if (!this.authService.isConfigured()) {
      return this.authPort.getCurrentSession();
    }

    await this.authService.waitForInit();
    const idToken = await this.authService.getToken();
    if (!idToken) {
      return null;
    }

    try {
      return await this.authPort.loginWithX({ idToken });
    } catch (err) {
      if (err instanceof LoungeClientApiError) {
        if (err.statusCode === 401 || err.statusCode === 404) {
          await this.authService.signOutFirebase().catch(() => undefined);
          return null;
        }
        if (err.statusCode === 403) {
          await this.authService.signOutFirebase().catch(() => undefined);
          throw err;
        }
      }
      throw err;
    }
  }

  /** Switches between Login and Sign-Up modes on the X-linked entrance card. */
  public setAuthMode(mode: LoungeAuthMode): void {
    if (this.authMode() !== mode) {
      this.resetDisclaimerScrollState();
    }
    this.authMode.set(mode);
    this.shell.errorMessage.set(null);
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
    this.disclaimerScrollProgress.set(Math.min(100, Math.round(ratio * 100)));
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

  /** Toggles the Phase 1 non-EEA/UK/CH residency confirmation checkbox when scroll is completed. */
  public setNonEeaEligibilityChecked(checked: boolean): void {
    if (!this.disclaimerScrolledToBottom()) {
      return;
    }
    this.nonEeaEligibilityChecked.set(checked);
  }

  /** Authenticates an existing X-linked user, delegating Firebase popup auth when configured. */
  public async submitLoginWithX(
    idToken: string,
    onAuthenticated: (user: LoungeUser) => Promise<void>,
  ): Promise<void> {
    this.shell.isLoading.set(true);
    this.shell.errorMessage.set(null);
    try {
      const providedToken = idToken.trim();
      const creds: { readonly idToken: string; readonly xOAuthCode?: string } =
        providedToken.length > 0
          ? { idToken: providedToken }
          : this.authService.isConfigured()
            ? await this.authService.authenticateWithX()
            : { idToken: '' };

      let authSession: LoungeAuthSessionDto;
      try {
        authSession = await this.authPort.loginWithX({
          idToken: creds.idToken,
          ...(creds.xOAuthCode ? { xOAuthCode: creds.xOAuthCode } : {}),
        });
      } catch (err) {
        await this.authService.signOutFirebase().catch(() => undefined);
        throw err;
      }

      await onAuthenticated(authSession.user);
      this.shell.isSidebarOpen.set(false);
    } catch (err) {
      this.shell.errorMessage.set(this.shell.mapUiError(err, 'errorGeneric'));
    } finally {
      this.shell.isLoading.set(false);
    }
  }

  /** Completes scroll-verified sign-up with X, enforcing business disclaimer rules before transport. */
  public async submitSignUpWithX(
    idToken: string,
    xOAuthCode: string | undefined,
    onAuthenticated: (user: LoungeUser) => Promise<void>,
  ): Promise<void> {
    if (!this.canSubmitSignUp()) {
      this.shell.errorMessage.set(this.shell.t('scrollRequiredError'));
      return;
    }
    this.shell.isLoading.set(true);
    this.shell.errorMessage.set(null);
    try {
      const scrolledAt = this.disclaimerScrolledAt() ?? new Date().toISOString();
      const disclaimerConsent = {
        disclaimerVersion: this.shell.disclaimerVersion(),
        agreedToGeminiTrainingUsage: true,
        agreedToZeroPiiProhibition: true,
        agreedToOneWayMemoryIsolation: true,
        ...(!this.shell.phase2EeaEnabled() ? { agreedToNonEeaEligibility: true } : {}),
        scrolledToBottomAt: scrolledAt,
        consentedAt: new Date().toISOString(),
      };
      assertValidSignUpConsent(disclaimerConsent, this.shell.phase2EeaEnabled());

      const providedToken = idToken.trim();
      const providedOAuth = xOAuthCode?.trim();
      const creds =
        providedToken.length > 0
          ? { idToken: providedToken, xOAuthCode: providedOAuth }
          : this.authService.isConfigured()
            ? await this.authService.authenticateWithX()
            : { idToken: '', xOAuthCode: providedOAuth };

      let authSession: LoungeAuthSessionDto;
      try {
        authSession = await this.authPort.signUpWithX({
          idToken: creds.idToken,
          ...(creds.xOAuthCode ? { xOAuthCode: creds.xOAuthCode } : {}),
          language: this.shell.lang(),
          timezone: this.shell.timezone(),
          disclaimerConsent,
        });
      } catch (err) {
        await this.authService.signOutFirebase().catch(() => undefined);
        throw err;
      }

      await onAuthenticated(authSession.user);
      this.shell.isSidebarOpen.set(false);
    } catch (err) {
      this.shell.errorMessage.set(this.shell.mapUiError(err, 'errorGeneric'));
    } finally {
      this.shell.isLoading.set(false);
    }
  }

  /** Submits scroll-verified re-acceptance when the disclaimer version has increased. */
  public async submitDisclaimerReconsent(): Promise<void> {
    if (!this.canSubmitSignUp()) {
      this.shell.errorMessage.set(this.shell.t('scrollRequiredError'));
      return;
    }
    this.shell.isLoading.set(true);
    this.shell.errorMessage.set(null);
    try {
      const scrolledAt = this.disclaimerScrolledAt() ?? new Date().toISOString();
      const disclaimerConsent = {
        disclaimerVersion: this.shell.disclaimerVersion(),
        agreedToGeminiTrainingUsage: true,
        agreedToZeroPiiProhibition: true,
        agreedToOneWayMemoryIsolation: true,
        ...(!this.shell.phase2EeaEnabled() ? { agreedToNonEeaEligibility: true } : {}),
        scrolledToBottomAt: scrolledAt,
        consentedAt: new Date().toISOString(),
      };
      assertValidReconsentSubmission(
        disclaimerConsent,
        this.shell.disclaimerVersion(),
        this.shell.phase2EeaEnabled(),
      );

      const updatedUser = await this.accountPort.updateDisclaimerConsent({ disclaimerConsent });
      this.accountStore.applyUpdatedUser(updatedUser);
      this.resolvePostAuthView(updatedUser);
    } catch (err) {
      this.shell.errorMessage.set(this.shell.mapUiError(err, 'errorGeneric'));
    } finally {
      this.shell.isLoading.set(false);
    }
  }

  /** Activates the blocking re-consent overlay mid-session while preserving unsent composer draft. */
  public triggerMidSessionReconsent(requiredVersion?: number): void {
    if (
      typeof requiredVersion === 'number' &&
      Number.isInteger(requiredVersion) &&
      requiredVersion >= 1
    ) {
      this.shell.disclaimerVersion.set(requiredVersion);
    }
    this.resetDisclaimerScrollState();
    this.shell.isSidebarOpen.set(false);
    this.isReconsentRequired.set(true);
    this.shell.errorMessage.set(null);
  }

  /** Routes authenticated users to `CHAT` or `ONBOARDING` and enforces disclaimer re-consent. */
  public resolvePostAuthView(user: LoungeUser): void {
    const nextView: LoungeActiveView = user.onboardingCompleted ? 'CHAT' : 'ONBOARDING';
    this.shell.activeView.set(nextView);

    if (user.disclaimerConsent.disclaimerVersion < this.shell.disclaimerVersion()) {
      this.resetDisclaimerScrollState();
      this.shell.isSidebarOpen.set(false);
      this.isReconsentRequired.set(true);
      return;
    }
    this.isReconsentRequired.set(false);
  }

  /** Logs out cleanly from both BFF and Firebase Auth before resetting all local stores. */
  public async logout(onResetLocalState: () => void): Promise<void> {
    this.shell.isLoading.set(true);
    try {
      await this.authPort.logout();
      this.shell.errorMessage.set(null);
    } catch (err) {
      this.shell.errorMessage.set(this.shell.mapUiError(err, 'errorGeneric'));
    } finally {
      await this.authService.signOutFirebase().catch(() => undefined);
      onResetLocalState();
      this.shell.isLoading.set(false);
    }
  }

  /** Resets disclaimer scroll tracking and checkbox signals. */
  public resetDisclaimerScrollState(): void {
    this.disclaimerChecked.set(false);
    this.nonEeaEligibilityChecked.set(false);
    this.disclaimerScrolledToBottom.set(false);
    this.disclaimerScrollProgress.set(0);
    this.disclaimerScrolledAt.set(null);
  }

  /** Resets auth mode and re-consent overlay state on session termination. */
  public reset(nextAuthMode: LoungeAuthMode): void {
    this.resetDisclaimerScrollState();
    this.isReconsentRequired.set(false);
    this.authMode.set(nextAuthMode);
  }

  private markDisclaimerScrolledToBottom(): void {
    if (!this.disclaimerScrolledToBottom()) {
      this.disclaimerScrolledToBottom.set(true);
      this.disclaimerScrolledAt.set(new Date().toISOString());
    }
  }
}
