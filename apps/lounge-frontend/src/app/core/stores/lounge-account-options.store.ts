import { Injectable, computed, inject, signal } from '@angular/core';
import type {
  LoungeAccountSummaryDto,
  LoungeLanguage,
  LoungeSubscription,
  LoungeUser,
} from '@rebecca/types';
import { LoungeAccountPort } from '../ports/lounge-account.port';
import { LoungeAuthService } from '../services/lounge-auth.service';
import { assertValidDeleteAccountRequest } from '../validators/lounge-business.validator';
import { LoungeShellStore } from './lounge-shell.store';

/** Low-turns soft upsell threshold triggering a subtle non-blocking prompt in chat. */
export const LOW_QUOTA_NUDGE_THRESHOLD = 2;

function isStripeCancellationFailedError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'STRIPE_CANCELLATION_FAILED'
  );
}

/**
 * Feature store managing account summary, monotonic locale/timezone/analytics preference updates,
 * onboarding completion, quota HUD signals, and the 2-step irreversible account deletion workflow.
 */
@Injectable({ providedIn: 'root' })
export class LoungeAccountOptionsStore {
  private readonly accountPort = inject(LoungeAccountPort);
  private readonly authService = inject(LoungeAuthService);
  private readonly shell = inject(LoungeShellStore);

  private languageUpdateSeq = 0;
  private timezoneUpdateSeq = 0;
  private analyticsUpdateSeq = 0;
  private analyticsInFlightCount = 0;
  private analyticsRollbackValue: boolean | null = null;

  public readonly accountSummary = signal<LoungeAccountSummaryDto | null>(null);
  public readonly optionsSavedNotice = signal<string | null>(null);
  public readonly deleteAccountStep = signal<0 | 1 | 2>(0);
  public readonly deleteConfirmIrreversible = signal<boolean>(false);
  public readonly deleteConfirmNoRefund = signal<boolean>(false);
  public readonly deleteStripeError = signal<string | null>(null);

  public readonly agreedDisclaimerVersion = computed(
    () => this.accountSummary()?.user.disclaimerConsent.disclaimerVersion ?? 0,
  );

  public readonly canConfirmDeleteAccount = computed(
    () =>
      !this.shell.isLoading() &&
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

  public readonly isPastDue = computed(
    () => this.accountSummary()?.subscription.status === 'PAST_DUE',
  );

  public readonly hasActiveOrCancelingSubscription = computed(() => {
    const status = this.accountSummary()?.subscription.status;
    return status === 'ACTIVE' || status === 'CANCELING';
  });

  public readonly isLowQuotaNudge = computed(() => {
    const sub = this.accountSummary()?.subscription;
    return Boolean(sub && sub.remainingChatTurns > 0 && sub.remainingChatTurns <= LOW_QUOTA_NUDGE_THRESHOLD);
  });

  public readonly isQuotaExhausted = computed(
    () => (this.accountSummary()?.subscription.remainingChatTurns ?? 0) <= 0,
  );

  /** Applies an authoritative account summary loaded during Lounge session hydration. */
  public applyHydratedSummary(summary: LoungeAccountSummaryDto, catalogTotal: number): void {
    this.accountSummary.set({
      ...summary,
      totalGalleryCount: catalogTotal,
    });
    this.shell.lang.set(summary.user.language);
    this.shell.timezone.set(summary.user.timezone);
    this.shell.setDocumentLang(summary.user.language);
    if (summary.persona) {
      this.shell.applyPersonaBranding(summary.persona);
    }
  }

  /** Updates only the embedded `user` record cleanly after onboarding or re-consent changes. */
  public applyUpdatedUser(user: LoungeUser): void {
    this.accountSummary.update((prev) => (prev ? { ...prev, user } : prev));
  }

  /** Synchronizes subscription bucket counters from Billing Hub responses. */
  public syncSubscriptionSummary(subscription: LoungeSubscription): void {
    this.accountSummary.update((prev) => (prev ? { ...prev, subscription } : prev));
  }

  /** Synchronizes gallery totals inside `accountSummary` when Gallery pages load. */
  public syncGalleryTotals(unlockedCount: number, totalCount: number): void {
    this.accountSummary.update((prev) =>
      prev
        ? {
            ...prev,
            unlockedGalleryCount: unlockedCount,
            totalGalleryCount: totalCount,
          }
        : prev,
    );
  }

  /** Updates gallery and subscription summary state after a completed Chat turn. */
  public syncAfterChatTurn(
    unlockedGalleryCount: number,
    catalogTotal: number,
    remainingChatTurns: number,
    subscription?: LoungeSubscription,
  ): void {
    this.accountSummary.update((prev) =>
      prev
        ? {
            ...prev,
            unlockedGalleryCount,
            totalGalleryCount: Math.max(prev.totalGalleryCount, catalogTotal),
            subscription: subscription
              ? subscription
              : {
                  ...prev.subscription,
                  remainingChatTurns,
                },
          }
        : prev,
    );
  }

  /**
   * Updates UI & AI conversation language across 8 supported locales, persisting via
   * `/account/preferences` when already inside the Lounge and rolling back cleanly on failure.
   */
  public async setLanguage(nextLang: LoungeLanguage): Promise<void> {
    const seq = ++this.languageUpdateSeq;
    const rollbackLang = this.accountSummary()?.user.language ?? this.shell.lang();
    this.shell.lang.set(nextLang);
    this.shell.setDocumentLang(nextLang);
    this.optionsSavedNotice.set(null);

    if (this.accountSummary() && this.shell.activeView() !== 'ONBOARDING') {
      try {
        const updatedUser = await this.accountPort.updatePreferences({ language: nextLang });
        if (seq !== this.languageUpdateSeq) {
          return;
        }
        this.applyUpdatedUser(updatedUser);
        this.optionsSavedNotice.set(this.shell.t('optionsSavedNotice'));
      } catch (err) {
        if (seq !== this.languageUpdateSeq) {
          return;
        }
        this.shell.lang.set(rollbackLang);
        this.shell.setDocumentLang(rollbackLang);
        this.shell.errorMessage.set(this.shell.mapUiError(err, 'errorGeneric'));
      }
    }
  }

  /**
   * Updates user IANA timezone preference, persisting via `/account/preferences` when already
   * inside the Lounge and rolling back cleanly if backend persistence rejects.
   */
  public async setTimezone(nextTimezone: string): Promise<void> {
    const seq = ++this.timezoneUpdateSeq;
    const rollbackTimezone = this.accountSummary()?.user.timezone ?? this.shell.timezone();
    this.shell.timezone.set(nextTimezone);
    this.optionsSavedNotice.set(null);

    if (this.accountSummary() && this.shell.activeView() !== 'ONBOARDING') {
      try {
        const updatedUser = await this.accountPort.updatePreferences({ timezone: nextTimezone });
        if (seq !== this.timezoneUpdateSeq) {
          return;
        }
        this.applyUpdatedUser(updatedUser);
        this.optionsSavedNotice.set(this.shell.t('optionsSavedNotice'));
      } catch (err) {
        if (seq !== this.timezoneUpdateSeq) {
          return;
        }
        this.shell.timezone.set(rollbackTimezone);
        this.shell.errorMessage.set(this.shell.mapUiError(err, 'errorGeneric'));
      }
    }
  }

  /**
   * Updates user analytics opt-out preference (`allowServiceImprovementAnalytics`), persisting via
   * `/account/preferences` and rolling back cleanly if the latest request fails.
   */
  public async setAnalyticsOptIn(allowed: boolean): Promise<void> {
    const summary = this.accountSummary();
    if (!summary) {
      return;
    }
    if (this.analyticsInFlightCount === 0) {
      this.analyticsRollbackValue = summary.user.allowServiceImprovementAnalytics;
    }
    this.analyticsInFlightCount += 1;
    const seq = ++this.analyticsUpdateSeq;
    const fallbackValue = summary.user.allowServiceImprovementAnalytics;
    this.optionsSavedNotice.set(null);
    this.accountSummary.update((prev) =>
      prev
        ? {
            ...prev,
            user: { ...prev.user, allowServiceImprovementAnalytics: allowed },
          }
        : prev,
    );

    try {
      const updatedUser = await this.accountPort.updatePreferences({
        allowServiceImprovementAnalytics: allowed,
      });
      if (seq !== this.analyticsUpdateSeq) {
        return;
      }
      this.analyticsRollbackValue = updatedUser.allowServiceImprovementAnalytics;
      this.applyUpdatedUser(updatedUser);
      this.optionsSavedNotice.set(this.shell.t('optionsSavedNotice'));
    } catch (err) {
      if (seq !== this.analyticsUpdateSeq) {
        return;
      }
      const rollbackTo = this.analyticsRollbackValue ?? fallbackValue;
      this.accountSummary.update((prev) =>
        prev
          ? {
              ...prev,
              user: { ...prev.user, allowServiceImprovementAnalytics: rollbackTo },
            }
          : prev,
      );
      this.shell.errorMessage.set(this.shell.mapUiError(err, 'errorGeneric'));
    } finally {
      this.analyticsInFlightCount = Math.max(0, this.analyticsInFlightCount - 1);
      if (this.analyticsInFlightCount === 0) {
        this.analyticsRollbackValue = null;
      }
    }
  }

  /** Completes Sign-Up Step 3 & Step 4 (`language/timezone confirmation -> start chatting`). */
  public async completeOnboarding(): Promise<void> {
    this.shell.isLoading.set(true);
    this.shell.errorMessage.set(null);
    try {
      const updatedUser = await this.accountPort.updatePreferences({
        language: this.shell.lang(),
        timezone: this.shell.timezone(),
        completeOnboarding: true,
      });
      this.applyUpdatedUser(updatedUser);
      this.shell.activeView.set('CHAT');
      this.shell.isSidebarOpen.set(false);
    } catch (err) {
      this.shell.errorMessage.set(this.shell.mapUiError(err, 'errorGeneric'));
    } finally {
      this.shell.isLoading.set(false);
    }
  }

  /** Opens Step 1 of the multi-step Account Deletion confirmation dialog from Options or Re-Consent. */
  public openDeleteAccountModal(): void {
    this.deleteConfirmIrreversible.set(false);
    this.deleteConfirmNoRefund.set(false);
    this.deleteStripeError.set(null);
    this.deleteAccountStep.set(1);
    this.shell.errorMessage.set(null);
  }

  /** Advances from initial deletion warning (Step 1) to final consent checkboxes (Step 2). */
  public proceedToDeleteAccountStep2(): void {
    if (this.deleteAccountStep() === 1) {
      this.deleteStripeError.set(null);
      this.deleteAccountStep.set(2);
    }
  }

  /** Cancels Account Deletion confirmation and resets all checkboxes safely. */
  public closeDeleteAccountModal(): void {
    this.deleteAccountStep.set(0);
    this.deleteConfirmIrreversible.set(false);
    this.deleteConfirmNoRefund.set(false);
    this.deleteStripeError.set(null);
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
   * signing out Firebase Auth and clearing local state cleanly on success (aborting fail-closed on `502`).
   */
  public async confirmDeleteAccount(onDeleted: () => void): Promise<void> {
    if (!this.canConfirmDeleteAccount()) {
      return;
    }
    const payload = {
      confirmedIrreversibleDeletion: true,
      confirmedNoRefundForRemainingTurns: true,
    } as const;
    assertValidDeleteAccountRequest(payload);

    this.shell.isLoading.set(true);
    this.shell.errorMessage.set(null);
    this.deleteStripeError.set(null);
    try {
      await this.accountPort.deleteAccount(payload);
      await this.authService.signOutFirebase().catch(() => undefined);
      onDeleted();
    } catch (err) {
      if (isStripeCancellationFailedError(err)) {
        this.deleteStripeError.set(this.shell.t('deleteModalStripeErrorBanner'));
      } else {
        this.shell.errorMessage.set(this.shell.mapUiError(err, 'errorGeneric'));
      }
    } finally {
      this.shell.isLoading.set(false);
    }
  }

  /** Resets all account, preference sequence, and deletion modal state on logout or account removal. */
  public reset(): void {
    this.languageUpdateSeq += 1;
    this.timezoneUpdateSeq += 1;
    this.analyticsUpdateSeq += 1;
    this.analyticsInFlightCount = 0;
    this.analyticsRollbackValue = null;
    this.accountSummary.set(null);
    this.optionsSavedNotice.set(null);
    this.closeDeleteAccountModal();
  }
}
