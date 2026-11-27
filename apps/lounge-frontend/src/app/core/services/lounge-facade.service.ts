import { Injectable, inject } from '@angular/core';
import type {
  LoungeBillingProductDto,
  LoungeEuWithdrawalRequestDto,
  LoungeLanguage,
  LoungePortalFlow,
  LoungeProductId,
  LoungeSubscriptionStatus,
  LoungeSubscriptionTier,
  LoungeUser,
} from '@rebecca/types';
import type { LoungeLocaleCopy } from '../i18n';
import { LoungeAccountPort } from '../ports/lounge-account.port';
import { LoungeGalleryPort } from '../ports/lounge-gallery.port';
import { LoungeSessionPort } from '../ports/lounge-session.port';
import { LoungeAccountOptionsStore } from '../stores/lounge-account-options.store';
import { LoungeAuthStore, type LoungeAuthMode } from '../stores/lounge-auth.store';
import {
  LOUNGE_BILLING_ORDERS_PAGE_SIZE,
  LoungeBillingStore,
  type LoungeBillingTab,
  type PreCheckoutConsentSubmission,
} from '../stores/lounge-billing.store';
import {
  LOUNGE_CHAT_PAGE_SIZE,
  MAX_LOUNGE_COMPOSER_LENGTH,
  LoungeChatStore,
} from '../stores/lounge-chat.store';
import { LOUNGE_GALLERY_PAGE_SIZE, LoungeGalleryStore } from '../stores/lounge-gallery.store';
import { LoungeShellStore, type LoungeActiveView } from '../stores/lounge-shell.store';

export {
  LOUNGE_BILLING_ORDERS_PAGE_SIZE,
  LOUNGE_CHAT_PAGE_SIZE,
  LOUNGE_GALLERY_PAGE_SIZE,
  MAX_LOUNGE_COMPOSER_LENGTH,
};
export type {
  LoungeActiveView,
  LoungeAuthMode,
  LoungeBillingTab,
  PreCheckoutConsentSubmission,
};

/**
 * Thin unified facade delegating UI presentation needs to dedicated domain stores under `core/stores/`
 * while preserving backward-compatible signal and method contracts across Private Lounge components.
 */
@Injectable({ providedIn: 'root' })
export class LoungeFacadeService {
  private readonly accountPort = inject(LoungeAccountPort);
  private readonly sessionPort = inject(LoungeSessionPort);
  private readonly galleryPort = inject(LoungeGalleryPort);

  private readonly shell = inject(LoungeShellStore);
  private readonly authStore = inject(LoungeAuthStore);
  private readonly accountStore = inject(LoungeAccountOptionsStore);
  private readonly chatStore = inject(LoungeChatStore);
  private readonly galleryStore = inject(LoungeGalleryStore);
  private readonly billingStore = inject(LoungeBillingStore);

  // Shell signals
  public readonly isBootstrapping = this.shell.isBootstrapping;
  public readonly configLoadError = this.shell.configLoadError;
  public readonly activeView = this.shell.activeView;
  public readonly isSidebarOpen = this.shell.isSidebarOpen;
  public readonly lang = this.shell.lang;
  public readonly timezone = this.shell.timezone;
  public readonly appVersion = this.shell.appVersion;
  public readonly disclaimerVersion = this.shell.disclaimerVersion;
  public readonly phase2EeaEnabled = this.shell.phase2EeaEnabled;
  public readonly billingEnabled = this.shell.billingEnabled;
  public readonly contactEmail = this.shell.contactEmail;
  public readonly legalUrls = this.shell.legalUrls;
  public readonly isLoading = this.shell.isLoading;
  public readonly errorMessage = this.shell.errorMessage;
  public readonly personaBranding = this.shell.personaBranding;
  public readonly personaDisplayName = this.shell.personaDisplayName;
  public readonly copy = this.shell.copy;

  // Auth & disclaimer signals
  public readonly authMode = this.authStore.authMode;
  public readonly isReconsentRequired = this.authStore.isReconsentRequired;
  public readonly disclaimerScrollProgress = this.authStore.disclaimerScrollProgress;
  public readonly disclaimerScrolledToBottom = this.authStore.disclaimerScrolledToBottom;
  public readonly disclaimerScrolledAt = this.authStore.disclaimerScrolledAt;
  public readonly disclaimerChecked = this.authStore.disclaimerChecked;
  public readonly nonEeaEligibilityChecked = this.authStore.nonEeaEligibilityChecked;
  public readonly canSubmitSignUp = this.authStore.canSubmitSignUp;

  // Account & options signals
  public readonly accountSummary = this.accountStore.accountSummary;
  public readonly optionsSavedNotice = this.accountStore.optionsSavedNotice;
  public readonly agreedDisclaimerVersion = this.accountStore.agreedDisclaimerVersion;
  public readonly deleteAccountStep = this.accountStore.deleteAccountStep;
  public readonly deleteConfirmIrreversible = this.accountStore.deleteConfirmIrreversible;
  public readonly deleteConfirmNoRefund = this.accountStore.deleteConfirmNoRefund;
  public readonly deleteStripeError = this.accountStore.deleteStripeError;
  public readonly canConfirmDeleteAccount = this.accountStore.canConfirmDeleteAccount;
  public readonly remainingTurnsPercent = this.accountStore.remainingTurnsPercent;
  public readonly isPastDue = this.accountStore.isPastDue;
  public readonly hasActiveOrCancelingSubscription =
    this.accountStore.hasActiveOrCancelingSubscription;
  public readonly isLowQuotaNudge = this.accountStore.isLowQuotaNudge;
  public readonly isQuotaExhausted = this.accountStore.isQuotaExhausted;

  // Chat signals
  public readonly activeSession = this.chatStore.activeSession;
  public readonly composerDraft = this.chatStore.composerDraft;
  public readonly composerCharCount = this.chatStore.composerCharCount;
  public readonly messages = this.chatStore.messages;
  public readonly isLoadingOlderMessages = this.chatStore.isLoadingOlderMessages;
  public readonly hasMoreMessages = this.chatStore.hasMoreMessages;
  public readonly oldestMessageCursor = this.chatStore.oldestMessageCursor;
  public readonly messagesTotalItems = this.chatStore.messagesTotalItems;
  public readonly latestMessageAnchorSeq = this.chatStore.latestMessageAnchorSeq;

  // Gallery signals
  public readonly galleryItems = this.galleryStore.galleryItems;
  public readonly isLoadingGalleryPage = this.galleryStore.isLoadingGalleryPage;
  public readonly galleryCurrentPage = this.galleryStore.galleryCurrentPage;
  public readonly galleryTotalPages = this.galleryStore.galleryTotalPages;
  public readonly galleryTotalItems = this.galleryStore.galleryTotalItems;
  public readonly galleryCatalogTotalCount = this.galleryStore.galleryCatalogTotalCount;
  public readonly galleryUnlockedCount = this.galleryStore.galleryUnlockedCount;
  public readonly newlyUnlockedGalleryItem = this.galleryStore.newlyUnlockedGalleryItem;
  public readonly newlyUnlockedAssetIds = this.galleryStore.newlyUnlockedAssetIds;

  // Billing signals
  public readonly billingTab = this.billingStore.billingTab;
  public readonly billingCatalog = this.billingStore.billingCatalog;
  public readonly billingCatalogError = this.billingStore.billingCatalogError;
  public readonly subscriptionDetail = this.billingStore.subscriptionDetail;
  public readonly billingOrders = this.billingStore.billingOrders;
  public readonly billingOrdersHasMore = this.billingStore.billingOrdersHasMore;
  public readonly billingOrdersNextCursor = this.billingStore.billingOrdersNextCursor;
  public readonly isLoadingBilling = this.billingStore.isLoadingBilling;
  public readonly isLoadingMoreOrders = this.billingStore.isLoadingMoreOrders;
  public readonly billingBannerNotice = this.billingStore.billingBannerNotice;
  public readonly selectedCheckoutProduct = this.billingStore.selectedCheckoutProduct;
  public readonly pendingEuWithdrawal = this.billingStore.pendingEuWithdrawal;

  /** Promise resolving when initial startup config and silent session restoration finish. */
  public ready: Promise<void>;

  constructor() {
    this.ready = this.initializeLounge();
  }

  /** Retries bootstrap initialization after a `/config` load failure without reloading the browser tab. */
  public retryInitializeLounge(): Promise<void> {
    this.ready = this.initializeLounge();
    return this.ready;
  }

  /** Loads runtime configuration, restores any active session, and handles Stripe redirect returns. */
  public async initializeLounge(): Promise<void> {
    this.shell.isBootstrapping.set(true);
    this.shell.configLoadError.set(null);
    try {
      try {
        await this.shell.loadRuntimeConfig();
      } catch (err) {
        this.shell.configLoadError.set(this.shell.mapUiError(err, 'configLoadErrorBody'));
        this.shell.activeView.set('AUTH');
        return;
      }

      const session = await this.authStore.restoreSession();
      if (session) {
        const activeUser = await this.completeAuthenticatedHydration(session.user);
        this.authStore.resolvePostAuthView(activeUser);
        if (!this.authStore.isReconsentRequired() && activeUser.onboardingCompleted) {
          await this.billingStore.handleBillingRedirectReturn();
        }
      } else {
        this.shell.activeView.set('AUTH');
      }
    } catch (err) {
      this.shell.activeView.set('AUTH');
      if (this.shell.configLoadError() === null) {
        this.shell.errorMessage.set(this.shell.mapUiError(err, 'errorGeneric'));
      }
    } finally {
      this.shell.isBootstrapping.set(false);
    }
  }

  /** Interpolates `{name}` in localized copy templates using current active persona name. */
  public t(key: keyof LoungeLocaleCopy): string {
    return this.shell.t(key);
  }

  /** Returns localized title for any Lounge product or bonus grant identifier. */
  public getProductTitle(productId: LoungeProductId | 'UNKNOWN'): string {
    return this.shell.getProductTitle(productId);
  }

  /** Formats localized product price (`¥1,400/月` vs `¥500`). */
  public formatProductPrice(
    product: Pick<LoungeBillingProductDto, 'mode' | 'formattedPrice'>,
  ): string {
    return this.shell.formatProductPrice(product);
  }

  /** Returns localized label for plan tier (`FREE` / `STANDARD`). */
  public getTierLabel(tier: LoungeSubscriptionTier): string {
    return this.shell.getTierLabel(tier);
  }

  /** Returns localized label for Stripe subscription status (`ACTIVE`, `CANCELING`, etc.). */
  public getSubscriptionStatusLabel(status: LoungeSubscriptionStatus): string {
    return this.shell.getSubscriptionStatusLabel(status);
  }

  /** Loads runtime version, disclaimer version, legal URLs, and pluggable persona metadata. */
  public loadRuntimeConfig(): Promise<void> {
    return this.shell.loadRuntimeConfig();
  }

  /** Clears any visible error banner message. */
  public dismissError(): void {
    this.shell.dismissError();
  }

  /** Switches between Login and Sign-Up modes on the X-linked entrance card. */
  public setAuthMode(mode: LoungeAuthMode): void {
    this.authStore.setAuthMode(mode);
  }

  /** Updates UI & AI conversation language across 8 supported locales. */
  public setLanguage(nextLang: LoungeLanguage): Promise<void> {
    return this.accountStore.setLanguage(nextLang);
  }

  /** Updates user IANA timezone preference. */
  public setTimezone(nextTimezone: string): Promise<void> {
    return this.accountStore.setTimezone(nextTimezone);
  }

  /** Updates user analytics opt-out preference (`allowServiceImprovementAnalytics`). */
  public setAnalyticsOptIn(allowed: boolean): Promise<void> {
    return this.accountStore.setAnalyticsOptIn(allowed);
  }

  /** Records scroll progress inside the Sign-Up disclaimer and unlocks agreement at bottom. */
  public updateDisclaimerScroll(scrollTop: number, clientHeight: number, scrollHeight: number): void {
    this.authStore.updateDisclaimerScroll(scrollTop, clientHeight, scrollHeight);
  }

  /** Toggles the sign-up consent checkbox only when the disclaimer has been scrolled to bottom. */
  public setDisclaimerChecked(checked: boolean): void {
    this.authStore.setDisclaimerChecked(checked);
  }

  /** Toggles the Phase 1 non-EEA/UK/CH residency confirmation checkbox when scroll is completed. */
  public setNonEeaEligibilityChecked(checked: boolean): void {
    this.authStore.setNonEeaEligibilityChecked(checked);
  }

  /** Authenticates an existing X-linked user and routes to RECONSENT, ONBOARDING, or CHAT cleanly. */
  public submitLoginWithX(idToken = ''): Promise<void> {
    return this.authStore.submitLoginWithX(idToken, async (sessionUser) => {
      const activeUser = await this.completeAuthenticatedHydration(sessionUser);
      this.authStore.resolvePostAuthView(activeUser);
    });
  }

  /** Completes scroll-verified sign-up with X and transitions to `ONBOARDING` or `CHAT`. */
  public submitSignUpWithX(idToken = '', xOAuthCode?: string): Promise<void> {
    return this.authStore.submitSignUpWithX(idToken, xOAuthCode, async (sessionUser) => {
      const activeUser = await this.completeAuthenticatedHydration(sessionUser);
      this.authStore.resolvePostAuthView(activeUser);
    });
  }

  /** Submits scroll-verified re-acceptance when the disclaimer version has increased. */
  public submitDisclaimerReconsent(): Promise<void> {
    return this.authStore.submitDisclaimerReconsent();
  }

  /** Completes Sign-Up Step 3 & Step 4 (`language/timezone confirmation -> start chatting`). */
  public completeOnboarding(): Promise<void> {
    return this.accountStore.completeOnboarding();
  }

  /** Opens or closes the Slide-Over Sidebar triggered from the top-left hamburger icon. */
  public toggleSidebar(forceState?: boolean): void {
    this.shell.toggleSidebar(forceState);
  }

  /** Navigates across authenticated Lounge views and closes the Sidebar drawer automatically. */
  public navigateTo(view: 'CHAT' | 'GALLERY' | 'BILLING' | 'OPTIONS'): void {
    if (view === 'BILLING') {
      void this.openBilling('PLANS');
      return;
    }
    this.accountStore.optionsSavedNotice.set(null);
    this.billingStore.clearTransientSelections();
    if (view === 'GALLERY') {
      this.galleryStore.onEnterGallery(Boolean(this.chatStore.activeSession()));
    }
    this.shell.activeView.set(view);
    this.shell.isSidebarOpen.set(false);
  }

  /** Navigates into the 3-Tab Billing & Usage Hub view and fetches the requested tab payload. */
  public openBilling(tab: LoungeBillingTab = 'PLANS'): Promise<void> {
    return this.billingStore.openBilling(tab);
  }

  /** Switches tabs within the Billing & Usage Hub and loads the tab's authoritative server data. */
  public selectBillingTab(tab: LoungeBillingTab): Promise<void> {
    return this.billingStore.selectBillingTab(tab);
  }

  /** Dismisses any transient checkout/portal notice banner shown inside the Billing Hub. */
  public dismissBillingBanner(): void {
    this.billingStore.dismissBillingBanner();
  }

  /** Opens the ASCT Art. 12-6 pre-checkout confirmation modal for a specific product card. */
  public openPreCheckoutModal(product: LoungeBillingProductDto): void {
    this.billingStore.openPreCheckoutModal(product);
  }

  /** Closes the ASCT Art. 12-6 pre-checkout confirmation modal without initiating Stripe Checkout. */
  public closePreCheckoutModal(): void {
    this.billingStore.closePreCheckoutModal();
  }

  /** Creates a Stripe Checkout Session and navigates to the validated external Checkout URL. */
  public submitCheckout(consent: PreCheckoutConsentSubmission): Promise<void> {
    return this.billingStore.submitCheckout(consent, (url) => this.navigateExternalUrl(url));
  }

  /** Opens a Stripe Customer Portal flow after verifying the returned portal URL origin. */
  public openCustomerPortal(flow: LoungePortalFlow = 'default'): Promise<void> {
    return this.billingStore.openCustomerPortal(flow, (url) => this.navigateExternalUrl(url));
  }

  /** Appends the next cursor page of Stripe Charge-backed purchase history items. */
  public loadMoreOrders(): Promise<void> {
    return this.billingStore.loadMoreOrders();
  }

  /** Opens a Stripe hosted receipt safely across Safari/iOS popup blockers. */
  public openOrderReceipt(chargeId: string): Promise<void> {
    return this.billingStore.openOrderReceipt(
      chargeId,
      () => this.openBlankPopupWindow(),
      (url) => this.navigateExternalUrl(url),
    );
  }

  /** Opens inline 2-step confirmation for an eligible Phase 2 EEA 14-day withdrawal action. */
  public requestEuWithdrawalConfirmation(request: LoungeEuWithdrawalRequestDto): void {
    this.billingStore.requestEuWithdrawalConfirmation(request);
  }

  /** Dismisses inline Phase 2 EEA withdrawal confirmation without calling the BFF. */
  public cancelEuWithdrawalConfirmation(): void {
    this.billingStore.cancelEuWithdrawalConfirmation();
  }

  /** Confirms and submits the staged Phase 2 EEA withdrawal request. */
  public confirmPendingEuWithdrawal(): Promise<void> {
    return this.billingStore.confirmPendingEuWithdrawal();
  }

  /** Submits Phase 2 EEA 14-day statutory electronic withdrawal and refreshes quota state. */
  public submitEuWithdrawal(request: LoungeEuWithdrawalRequestDto): Promise<void> {
    return this.billingStore.submitEuWithdrawal(request);
  }

  /** Synchronous popup pre-open helper (Safari-safe before `await`, overridable in tests). */
  public openBlankPopupWindow(): Window | null {
    if (typeof window === 'undefined' || typeof window.open !== 'function') {
      return null;
    }
    const popup = window.open('', '_blank');
    if (popup) {
      try {
        popup.opener = null;
      } catch {
        // Read-only opener in hardened sandboxes is harmless.
      }
    }
    return popup;
  }

  /** External top-level navigation helper (overridable in unit tests to avoid JSDOM errors). */
  public navigateExternalUrl(url: string): void {
    if (typeof window !== 'undefined' && window.location) {
      window.location.assign(url);
    }
  }

  /** Loads a specific 1-based Gallery page via the unified bounded pagination contract. */
  public loadGalleryPage(page: number): Promise<void> {
    return this.galleryStore.loadGalleryPage(page, Boolean(this.chatStore.activeSession()));
  }

  /** Prepends the next older slice of conversation turns via `oldestMessageCursor`. */
  public loadOlderMessages(): Promise<boolean> {
    return this.chatStore.loadOlderMessages();
  }

  /** Dismisses the celebratory New Gallery Unlock toast notification cleanly. */
  public dismissUnlockedGalleryNotice(): void {
    this.galleryStore.dismissUnlockedGalleryNotice();
  }

  /** Returns whether the given Bot asset ID was unlocked during the active session turn. */
  public isNewlyUnlockedAsset(assetId?: string): boolean {
    return this.galleryStore.isNewlyUnlockedAsset(assetId);
  }

  /** Submits a new chat turn in the user's single session and updates messages, quota, and Gallery. */
  public sendMessage(content: string): Promise<void> {
    return this.chatStore.sendMessage(content, (requiredVersion) => {
      this.authStore.triggerMidSessionReconsent(requiredVersion);
    });
  }

  /** Opens Step 1 of the multi-step Account Deletion confirmation dialog from Options or Re-Consent. */
  public openDeleteAccountModal(): void {
    this.accountStore.openDeleteAccountModal();
  }

  /** Advances from initial deletion warning (Step 1) to final consent checkboxes (Step 2). */
  public proceedToDeleteAccountStep2(): void {
    this.accountStore.proceedToDeleteAccountStep2();
  }

  /** Cancels Account Deletion confirmation and resets all checkboxes safely. */
  public closeDeleteAccountModal(): void {
    this.accountStore.closeDeleteAccountModal();
  }

  /** Toggles mandatory acknowledgement that all data erasure is permanent and unrecoverable. */
  public setDeleteConfirmIrreversible(checked: boolean): void {
    this.accountStore.setDeleteConfirmIrreversible(checked);
  }

  /** Toggles mandatory acknowledgement that no refunds apply for paid plans or unused turns. */
  public setDeleteConfirmNoRefund(checked: boolean): void {
    this.accountStore.setDeleteConfirmNoRefund(checked);
  }

  /** Executes irreversible cascade deletion via `DELETE /account` once Step 2 checkboxes are checked. */
  public confirmDeleteAccount(): Promise<void> {
    return this.accountStore.confirmDeleteAccount(() => this.resetAllLocalStores('SIGNUP'));
  }

  /** Logs out cleanly, resets all user state, closes the Sidebar drawer, and returns to Login view. */
  public logout(): Promise<void> {
    return this.authStore.logout(() => this.resetAllLocalStores('LOGIN'));
  }

  private async completeAuthenticatedHydration(fallbackUser: LoungeUser): Promise<LoungeUser> {
    const [summary, session, galleryPage, messagesPage] = await Promise.all([
      this.accountPort.getAccountSummary(),
      this.sessionPort.getSession(),
      this.galleryPort.listGallery({ page: 1, limit: LOUNGE_GALLERY_PAGE_SIZE }),
      this.sessionPort.listMessages({ page: 1, limit: LOUNGE_CHAT_PAGE_SIZE }),
    ]);
    const catalogTotal = Math.max(summary.totalGalleryCount, galleryPage.summary.totalCount);
    this.accountStore.applyHydratedSummary(summary, catalogTotal);
    this.galleryStore.hydrateInitialGallery(galleryPage, catalogTotal);
    this.chatStore.hydrateInitialChat(session, messagesPage);
    return this.accountStore.accountSummary()?.user ?? fallbackUser;
  }

  private resetAllLocalStores(nextAuthMode: LoungeAuthMode): void {
    this.accountStore.reset();
    this.chatStore.reset();
    this.galleryStore.reset();
    this.billingStore.reset();
    this.authStore.reset(nextAuthMode);
    this.shell.isSidebarOpen.set(false);
    this.shell.activeView.set('AUTH');
  }
}
