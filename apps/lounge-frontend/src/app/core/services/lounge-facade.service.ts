import { Injectable, computed, inject, signal } from '@angular/core';
import type {
  LOUNGE_ERROR_CODE_DISCLAIMER_RECONSENT_REQUIRED,
  LoungeAccountSummaryDto,
  LoungeBillingCatalogDto,
  LoungeBillingOrderItemDto,
  LoungeBillingProductDto,
  LoungeEuWithdrawalRequestDto,
  LoungeGalleryItem,
  LoungeLanguage,
  LoungeMessage,
  LoungePersonaBranding,
  LoungePortalFlow,
  LoungeSession,
  LoungeSubscriptionDetailResponseDto,
  LoungeUser,
} from '@rebecca/types';
import { environment } from '../../../environments/environment';
import {
  LOUNGE_TRANSLATIONS,
  detectInitialLoungeLanguage,
  detectInitialLoungeTimezone,
  formatLoungeCopy,
  type LoungeLocaleCopy,
} from '../i18n/lounge-translations';
import { LoungeAccountPort } from '../ports/lounge-account.port';
import { LoungeAuthPort } from '../ports/lounge-auth.port';
import { LoungeBillingPort } from '../ports/lounge-billing.port';
import { LoungeConfigPort } from '../ports/lounge-config.port';
import { LoungeGalleryPort } from '../ports/lounge-gallery.port';
import { LoungeSessionPort } from '../ports/lounge-session.port';
import { isAllowedStripeRedirectUrl } from '../utils/lounge-url-security';

/** Top-level UI views in the Gemitec Private Lounge application. */
export type LoungeActiveView = 'AUTH' | 'ONBOARDING' | 'CHAT' | 'GALLERY' | 'BILLING' | 'OPTIONS';

/** Authentication tab modes on the X-linked entrance view. */
export type LoungeAuthMode = 'LOGIN' | 'SIGNUP';

/** Three primary tabs inside the Billing & Usage Hub view. */
export type LoungeBillingTab = 'PLANS' | 'SUBSCRIPTION' | 'HISTORY';

/** Fixed page size for upward chat history pagination (`desc` windowing). */
export const LOUNGE_CHAT_PAGE_SIZE = 20;

/** Fixed page size for numbered Gallery collection pagination (12 slots/page). */
export const LOUNGE_GALLERY_PAGE_SIZE = 12;

/** Maximum allowed composer character count enforced on client and backend. */
export const MAX_LOUNGE_COMPOSER_LENGTH = 1500;

/** Low-turns soft upsell threshold triggering a subtle non-blocking prompt in chat. */
export const LOW_QUOTA_NUDGE_THRESHOLD = 2;

/** Bounded Stripe orders page size (`[1, 30]`). */
export const LOUNGE_BILLING_ORDERS_PAGE_SIZE = 20;

/** ASCT Art. 12-6 checkboxes collected inside the pre-checkout confirmation modal. */
export interface PreCheckoutConsentSubmission {
  readonly acceptedPurchaseDisclosure: boolean;
  readonly acceptedAutoRenewalOptIn: boolean;
  readonly confirmedAdultOrParentalConsent: boolean;
  readonly euDigitalWaiverAccepted?: boolean;
}

const DISCLAIMER_RECONSENT_REQUIRED_CODE: typeof LOUNGE_ERROR_CODE_DISCLAIMER_RECONSENT_REQUIRED =
  'DISCLAIMER_RECONSENT_REQUIRED';

function isReconsentRequiredError(
  err: unknown,
): err is { readonly code: string; readonly requiredDisclaimerVersion?: number } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === DISCLAIMER_RECONSENT_REQUIRED_CODE
  );
}

function isStripeCancellationFailedError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'STRIPE_CANCELLATION_FAILED'
  );
}

function resolveFallbackPersonaBranding(): LoungePersonaBranding {
  return {
    ...environment.persona,
    emotionAvatarPaths: { ...environment.persona.emotionAvatarPaths },
  };
}

/**
 * Signal-driven application facade orchestrating Bootstrapping Auto-Resume, Auth (`LOGIN`-first),
 * Integer-Versioned Re-Consent Gate, Onboarding locale confirmation, Single-Session Chat with
 * Gallery Unlock Juice, 3-Tab Billing Hub, Slide-Over Sidebar, Gallery, Options, and 2-step Withdrawal.
 */
@Injectable({ providedIn: 'root' })
export class LoungeFacadeService {
  private readonly configPort = inject(LoungeConfigPort, { optional: true });
  private readonly authPort = inject(LoungeAuthPort);
  private readonly accountPort = inject(LoungeAccountPort);
  private readonly billingPort = inject(LoungeBillingPort, { optional: true });
  private readonly sessionPort = inject(LoungeSessionPort);
  private readonly galleryPort = inject(LoungeGalleryPort);

  private isProductionRuntime: boolean = environment.production;

  public readonly isBootstrapping = signal<boolean>(true);
  public readonly activeView = signal<LoungeActiveView>('AUTH');
  public readonly authMode = signal<LoungeAuthMode>('LOGIN');
  public readonly isReconsentRequired = signal<boolean>(false);
  public readonly isSidebarOpen = signal<boolean>(false);
  public readonly lang = signal<LoungeLanguage>(detectInitialLoungeLanguage());
  public readonly timezone = signal<string>(detectInitialLoungeTimezone());
  public readonly optionsSavedNotice = signal<string | null>(null);
  public readonly appVersion = signal<string>(environment.appVersion);
  public readonly disclaimerVersion = signal<number>(environment.disclaimerVersion);
  public readonly agreedDisclaimerVersion = computed(
    () => this.accountSummary()?.user.disclaimerConsent.disclaimerVersion ?? 0,
  );

  public readonly disclaimerScrollProgress = signal<number>(0);
  public readonly disclaimerScrolledToBottom = signal<boolean>(false);
  public readonly disclaimerScrolledAt = signal<string | null>(null);
  public readonly disclaimerChecked = signal<boolean>(false);

  public readonly deleteAccountStep = signal<0 | 1 | 2>(0);
  public readonly deleteConfirmIrreversible = signal<boolean>(false);
  public readonly deleteConfirmNoRefund = signal<boolean>(false);
  public readonly deleteStripeError = signal<string | null>(null);

  public readonly isLoading = signal<boolean>(false);
  public readonly errorMessage = signal<string | null>(null);
  public readonly composerDraft = signal<string>('');

  public readonly accountSummary = signal<LoungeAccountSummaryDto | null>(null);
  public readonly activeSession = signal<LoungeSession | null>(null);

  public readonly billingTab = signal<LoungeBillingTab>('PLANS');
  public readonly billingCatalog = signal<LoungeBillingCatalogDto | null>(null);
  public readonly subscriptionDetail = signal<LoungeSubscriptionDetailResponseDto | null>(null);
  public readonly billingOrders = signal<readonly LoungeBillingOrderItemDto[]>([]);
  public readonly billingOrdersHasMore = signal<boolean>(false);
  public readonly billingOrdersNextCursor = signal<string | null>(null);
  public readonly isLoadingBilling = signal<boolean>(false);
  public readonly isLoadingMoreOrders = signal<boolean>(false);
  public readonly billingBannerNotice = signal<{
    readonly tone: 'info' | 'warning' | 'success';
    readonly text: string;
  } | null>(null);
  public readonly selectedCheckoutProduct = signal<LoungeBillingProductDto | null>(null);
  public readonly messages = signal<readonly LoungeMessage[]>([]);
  public readonly isLoadingOlderMessages = signal<boolean>(false);
  public readonly hasMoreMessages = signal<boolean>(false);
  public readonly oldestMessageCursor = signal<string | null>(null);
  public readonly messagesTotalItems = signal<number>(0);
  public readonly latestMessageAnchorSeq = signal<number>(0);

  public readonly galleryItems = signal<readonly LoungeGalleryItem[]>([]);
  public readonly isLoadingGalleryPage = signal<boolean>(false);
  public readonly galleryCurrentPage = signal<number>(1);
  public readonly galleryTotalPages = signal<number>(1);
  public readonly galleryTotalItems = signal<number>(0);
  public readonly galleryUnlockedCount = signal<number>(0);
  public readonly newlyUnlockedGalleryItem = signal<LoungeGalleryItem | null>(null);
  public readonly newlyUnlockedAssetIds = signal<readonly string[]>([]);
  private readonly unlockedGalleryItemIds = new Set<string>();
  private galleryNeedsRefresh = false;

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

  public readonly composerCharCount = computed(() => this.composerDraft().length);

  /** Promise resolving when initial startup config and silent session restoration finish. */
  public readonly ready: Promise<void>;

  constructor() {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = this.lang();
    }
    this.ready = this.initializeLounge();
  }

  /**
   * Loads runtime configuration and silently checks `authPort.getCurrentSession()` before clearing
   * the startup splash state so authenticated users jump directly to their active screen without flicker.
   */
  public async initializeLounge(): Promise<void> {
    this.isBootstrapping.set(true);
    try {
      await this.loadRuntimeConfig();
      const session = await this.authPort.getCurrentSession();
      if (session) {
        await this.hydrateAuthenticatedLounge();
        const activeUser = this.accountSummary()?.user ?? session.user;
        this.resolvePostAuthView(activeUser);
        if (!this.isReconsentRequired() && activeUser.onboardingCompleted) {
          await this.handleBillingRedirectReturn();
        }
      } else {
        this.activeView.set('AUTH');
      }
    } catch {
      this.activeView.set('AUTH');
    } finally {
      this.isBootstrapping.set(false);
    }
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
      if (typeof config.production === 'boolean') {
        this.isProductionRuntime = config.production;
      }
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

  /**
   * Updates user analytics opt-out preference (`allowServiceImprovementAnalytics`), persisting via
   * `/account/preferences` and rolling back cleanly if backend persistence rejects.
   */
  public async setAnalyticsOptIn(allowed: boolean): Promise<void> {
    const summary = this.accountSummary();
    if (!summary) {
      return;
    }
    const previousValue = summary.user.allowServiceImprovementAnalytics;
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
      this.accountSummary.update((prev) => (prev ? { ...prev, user: updatedUser } : prev));
      this.optionsSavedNotice.set(this.t('optionsSavedNotice'));
    } catch (err) {
      this.accountSummary.update((prev) =>
        prev
          ? {
              ...prev,
              user: { ...prev.user, allowServiceImprovementAnalytics: previousValue },
            }
          : prev,
      );
      this.errorMessage.set(
        err instanceof Error ? err.message : 'Failed to update analytics preference',
      );
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

  /** Authenticates an existing X-linked user and routes to RECONSENT, ONBOARDING, or CHAT cleanly. */
  public async submitLoginWithX(idToken = 'x-session-id-token'): Promise<void> {
    this.isLoading.set(true);
    this.errorMessage.set(null);
    try {
      const authSession = await this.authPort.loginWithX({ idToken });
      await this.hydrateAuthenticatedLounge();
      this.resolvePostAuthView(this.accountSummary()?.user ?? authSession.user);
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
      const authSession = await this.authPort.signUpWithX({
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
      this.resolvePostAuthView(this.accountSummary()?.user ?? authSession.user);
      this.isSidebarOpen.set(false);
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Sign-up failed');
    } finally {
      this.isLoading.set(false);
    }
  }

  /**
   * Submits scroll-verified re-acceptance when the legal/privacy disclaimer version has increased,
   * unlocking `ONBOARDING` (if incomplete) or returning cleanly to `CHAT`.
   */
  public async submitDisclaimerReconsent(): Promise<void> {
    if (!this.canSubmitSignUp()) {
      this.errorMessage.set(this.t('scrollRequiredError'));
      return;
    }
    this.isLoading.set(true);
    this.errorMessage.set(null);
    try {
      const scrolledAt = this.disclaimerScrolledAt() ?? new Date().toISOString();
      const updatedUser = await this.accountPort.updateDisclaimerConsent({
        disclaimerConsent: {
          disclaimerVersion: this.disclaimerVersion(),
          agreedToGeminiTrainingUsage: true,
          agreedToZeroPiiProhibition: true,
          agreedToOneWayMemoryIsolation: true,
          scrolledToBottomAt: scrolledAt,
          consentedAt: new Date().toISOString(),
        },
      });
      this.accountSummary.update((prev) => (prev ? { ...prev, user: updatedUser } : prev));
      this.resolvePostAuthView(updatedUser);
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Failed to update consent');
    } finally {
      this.isLoading.set(false);
    }
  }

  /**
   * Completes Sign-Up Step 3 & Step 4 (`言語・タイムゾーン確定 -> 使用開始`) and marks `onboardingCompleted = true`.
   */
  public async completeOnboarding(): Promise<void> {
    this.isLoading.set(true);
    this.errorMessage.set(null);
    try {
      const updatedUser = await this.accountPort.updatePreferences({
        language: this.lang(),
        timezone: this.timezone(),
        completeOnboarding: true,
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
  public navigateTo(view: 'CHAT' | 'GALLERY' | 'BILLING' | 'OPTIONS'): void {
    if (view === 'BILLING') {
      void this.openBilling('PLANS');
      return;
    }
    this.optionsSavedNotice.set(null);
    this.selectedCheckoutProduct.set(null);
    if (view === 'GALLERY') {
      this.newlyUnlockedGalleryItem.set(null);
      if (this.galleryNeedsRefresh) {
        void this.loadGalleryPage(1);
      }
    }
    this.activeView.set(view);
    this.isSidebarOpen.set(false);
  }

  /** Navigates into the 3-Tab Billing & Usage Hub view and fetches the requested tab payload. */
  public async openBilling(tab: LoungeBillingTab = 'PLANS'): Promise<void> {
    this.optionsSavedNotice.set(null);
    this.selectedCheckoutProduct.set(null);
    this.isSidebarOpen.set(false);
    this.activeView.set('BILLING');
    await this.selectBillingTab(tab);
  }

  /** Switches tabs within the Billing & Usage Hub and loads the tab's authoritative server data. */
  public async selectBillingTab(tab: LoungeBillingTab): Promise<void> {
    this.billingTab.set(tab);
    if (!this.billingPort || !this.accountSummary()) {
      return;
    }
    this.isLoadingBilling.set(true);
    this.errorMessage.set(null);
    try {
      if (tab === 'PLANS') {
        const catalog = await this.billingPort.getCatalog();
        this.billingCatalog.set(catalog);
      } else if (tab === 'SUBSCRIPTION') {
        const detail = await this.billingPort.getSubscriptionDetail();
        this.subscriptionDetail.set(detail);
        this.syncSubscriptionSummary(detail.subscription);
      } else {
        const page = await this.billingPort.listOrders({ limit: LOUNGE_BILLING_ORDERS_PAGE_SIZE });
        this.billingOrders.set(page.orders);
        this.billingOrdersHasMore.set(page.hasMore);
        this.billingOrdersNextCursor.set(page.nextCursor);
      }
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Failed to load billing details');
    } finally {
      this.isLoadingBilling.set(false);
    }
  }

  /** Dismisses any transient checkout/portal notice banner shown inside the Billing Hub. */
  public dismissBillingBanner(): void {
    this.billingBannerNotice.set(null);
  }

  /** Opens the ASCT Art. 12-6 pre-checkout confirmation modal for a specific product card. */
  public openPreCheckoutModal(product: LoungeBillingProductDto): void {
    if (!product.eligible) {
      return;
    }
    this.errorMessage.set(null);
    this.selectedCheckoutProduct.set(product);
  }

  /** Closes the ASCT Art. 12-6 pre-checkout confirmation modal without initiating Stripe Checkout. */
  public closePreCheckoutModal(): void {
    this.selectedCheckoutProduct.set(null);
  }

  /** Creates a Stripe Checkout Session and navigates to the validated external Checkout URL. */
  public async submitCheckout(consent: PreCheckoutConsentSubmission): Promise<void> {
    const product = this.selectedCheckoutProduct();
    if (!product || !this.billingPort || this.isLoadingBilling()) {
      return;
    }
    if (
      !consent.acceptedPurchaseDisclosure ||
      !consent.acceptedAutoRenewalOptIn ||
      !consent.confirmedAdultOrParentalConsent
    ) {
      throw new Error('All required pre-checkout disclosures must be accepted');
    }
    this.isLoadingBilling.set(true);
    this.errorMessage.set(null);
    try {
      const response = await this.billingPort.createCheckout({
        productId: product.productId,
        acceptedPurchaseDisclosure: true,
        acceptedAutoRenewalOptIn: true,
        confirmedAdultOrParentalConsent: true,
        ...(consent.euDigitalWaiverAccepted !== undefined
          ? { euDigitalWaiverAccepted: consent.euDigitalWaiverAccepted }
          : {}),
      });
      if (!isAllowedStripeRedirectUrl(response.checkoutUrl, !this.isProductionRuntime)) {
        throw new Error('Untrusted Stripe Checkout redirect URL rejected');
      }
      this.selectedCheckoutProduct.set(null);
      this.navigateExternalUrl(response.checkoutUrl);
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Failed to start checkout');
    } finally {
      this.isLoadingBilling.set(false);
    }
  }

  /** Opens a Stripe Customer Portal flow after verifying the returned portal URL origin. */
  public async openCustomerPortal(flow: LoungePortalFlow = 'default'): Promise<void> {
    if (!this.billingPort || this.isLoadingBilling()) {
      return;
    }
    this.isLoadingBilling.set(true);
    this.errorMessage.set(null);
    try {
      const response = await this.billingPort.createPortal({ flow });
      if (!isAllowedStripeRedirectUrl(response.portalUrl, !this.isProductionRuntime)) {
        throw new Error('Untrusted Stripe Customer Portal URL rejected');
      }
      this.navigateExternalUrl(response.portalUrl);
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Failed to open Stripe portal');
    } finally {
      this.isLoadingBilling.set(false);
    }
  }

  /** Appends the next cursor page of Stripe Charge-backed purchase history items. */
  public async loadMoreOrders(): Promise<void> {
    if (
      !this.billingPort ||
      this.isLoadingMoreOrders() ||
      !this.billingOrdersHasMore() ||
      !this.billingOrdersNextCursor()
    ) {
      return;
    }
    const startingAfter = this.billingOrdersNextCursor();
    if (!startingAfter) {
      this.billingOrdersHasMore.set(false);
      return;
    }
    this.isLoadingMoreOrders.set(true);
    this.errorMessage.set(null);
    try {
      const page = await this.billingPort.listOrders({
        limit: LOUNGE_BILLING_ORDERS_PAGE_SIZE,
        startingAfter,
      });
      this.billingOrders.update((prev) => {
        const seen = new Set(prev.map((order) => order.chargeId));
        const nextItems = page.orders.filter((order) => !seen.has(order.chargeId));
        return nextItems.length > 0 ? [...prev, ...nextItems] : prev;
      });
      this.billingOrdersHasMore.set(page.hasMore);
      this.billingOrdersNextCursor.set(page.nextCursor);
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Failed to load more orders');
    } finally {
      this.isLoadingMoreOrders.set(false);
    }
  }

  /**
   * Opens a Stripe hosted receipt safely across Safari/iOS popup blockers by synchronously opening
   * a blank tab before awaiting the BFF receipt endpoint, then validating the Stripe origin URL.
   */
  public async openOrderReceipt(chargeId: string): Promise<void> {
    if (!this.billingPort || !chargeId.trim()) {
      return;
    }
    const popup = this.openBlankPopupWindow();
    this.errorMessage.set(null);
    try {
      const res = await this.billingPort.getOrderReceipt(chargeId);
      if (!isAllowedStripeRedirectUrl(res.receiptUrl, !this.isProductionRuntime)) {
        throw new Error('Untrusted Stripe receipt URL rejected');
      }
      if (popup && !popup.closed) {
        popup.location.replace(res.receiptUrl);
      } else {
        this.navigateExternalUrl(res.receiptUrl);
      }
    } catch (err) {
      if (popup && !popup.closed) {
        popup.close();
      }
      this.errorMessage.set(err instanceof Error ? err.message : 'Failed to open receipt');
    }
  }

  /** Submits Phase 2 EEA 14-day statutory electronic withdrawal and refreshes quota state. */
  public async submitEuWithdrawal(request: LoungeEuWithdrawalRequestDto): Promise<void> {
    if (!this.billingPort || this.isLoadingBilling()) {
      return;
    }
    this.isLoadingBilling.set(true);
    this.errorMessage.set(null);
    try {
      const result = await this.billingPort.withdrawEu(request);
      this.syncSubscriptionSummary(result.subscription);
      this.billingBannerNotice.set({
        tone: 'success',
        text: this.t('billingEuWithdrawalDoneNotice'),
      });
      const detail = await this.billingPort.getSubscriptionDetail();
      this.subscriptionDetail.set(detail);
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'EEA withdrawal request failed');
    } finally {
      this.isLoadingBilling.set(false);
    }
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
  public async loadGalleryPage(page: number): Promise<void> {
    if (!Number.isFinite(page)) {
      return;
    }
    const targetPage = Math.max(1, Math.trunc(page));
    if (this.isLoadingGalleryPage() || !this.activeSession()) {
      return;
    }
    this.isLoadingGalleryPage.set(true);
    this.errorMessage.set(null);
    try {
      const res = await this.galleryPort.listGallery({
        page: targetPage,
        limit: LOUNGE_GALLERY_PAGE_SIZE,
      });
      if (res.summary.unlockedCount === 0) {
        this.unlockedGalleryItemIds.clear();
      }
      for (const item of res.data) {
        if (item.unlocked) {
          this.unlockedGalleryItemIds.add(item.id);
          this.unlockedGalleryItemIds.add(item.assetId);
        }
      }
      this.galleryItems.set(res.data);
      this.galleryCurrentPage.set(res.meta.currentPage);
      this.galleryTotalPages.set(res.meta.totalPages);
      this.galleryTotalItems.set(res.meta.totalItems);
      this.galleryUnlockedCount.set(res.summary.unlockedCount);
      this.galleryNeedsRefresh = false;
      this.accountSummary.update((prev) =>
        prev
          ? {
              ...prev,
              unlockedGalleryCount: res.summary.unlockedCount,
              totalGalleryCount: res.summary.totalCount,
            }
          : prev,
      );
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Failed to load gallery page');
    } finally {
      this.isLoadingGalleryPage.set(false);
    }
  }

  /**
   * Prepends the next older slice of conversation turns via `oldestMessageCursor`,
   * deduplicating by message ID and preserving `latestMessageAnchorSeq`.
   */
  public async loadOlderMessages(): Promise<boolean> {
    if (this.isLoadingOlderMessages() || !this.hasMoreMessages()) {
      return false;
    }
    const cursor = this.oldestMessageCursor();
    if (!cursor) {
      this.hasMoreMessages.set(false);
      return false;
    }
    this.isLoadingOlderMessages.set(true);
    try {
      const page = await this.sessionPort.listMessages({
        limit: LOUNGE_CHAT_PAGE_SIZE,
        cursor,
      });
      this.messages.update((prev) => {
        const existingIds = new Set(prev.map((msg) => msg.id));
        const older = page.data.filter((msg) => !existingIds.has(msg.id));
        return older.length > 0 ? [...older, ...prev] : prev;
      });
      this.hasMoreMessages.set(page.meta.hasMore);
      this.oldestMessageCursor.set(page.meta.nextCursor);
      this.messagesTotalItems.set(page.meta.totalItems);
      return page.data.length > 0;
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Failed to load older messages');
      return false;
    } finally {
      this.isLoadingOlderMessages.set(false);
    }
  }

  /** Dismisses the celebratory New Gallery Unlock toast notification cleanly. */
  public dismissUnlockedGalleryNotice(): void {
    this.newlyUnlockedGalleryItem.set(null);
  }

  /** Returns whether the given Bot asset ID was unlocked during the active session turn. */
  public isNewlyUnlockedAsset(assetId?: string): boolean {
    return Boolean(assetId && this.newlyUnlockedAssetIds().includes(assetId));
  }

  /** Submits a new chat turn in the user's single session and updates messages, quota, and Gallery. */
  public async sendMessage(content: string): Promise<void> {
    const trimmed = content.trim().slice(0, MAX_LOUNGE_COMPOSER_LENGTH);
    if (!trimmed || !this.activeSession() || this.isLoading()) {
      return;
    }
    this.isLoading.set(true);
    this.errorMessage.set(null);
    try {
      const res = await this.sessionPort.sendMessage({ content: trimmed });
      this.activeSession.set(res.session);
      this.messages.update((prev) => [...prev, res.userMessage, res.assistantMessage]);
      this.messagesTotalItems.update((count) => Math.max(count + 2, this.messages().length));
      this.latestMessageAnchorSeq.update((seq) => seq + 1);

      const unlocked = res.unlockedGalleryItem;
      let nextUnlockedCount = this.galleryUnlockedCount();
      let nextTotalCount = this.galleryTotalItems();
      if (unlocked) {
        const alreadyUnlocked =
          this.unlockedGalleryItemIds.has(unlocked.assetId) ||
          this.unlockedGalleryItemIds.has(unlocked.id) ||
          this.newlyUnlockedAssetIds().includes(unlocked.assetId) ||
          this.galleryItems().some(
            (item) =>
              (item.id === unlocked.id || item.assetId === unlocked.assetId) && item.unlocked,
          );
        let updatedInPlace = false;
        let insertedOnPage1 = false;
        this.galleryItems.update((items) => {
          const exists = items.some(
            (item) => item.id === unlocked.id || item.assetId === unlocked.assetId,
          );
          if (exists) {
            updatedInPlace = true;
            return items.map((item) =>
              item.id === unlocked.id || item.assetId === unlocked.assetId ? unlocked : item,
            );
          }
          if (this.galleryCurrentPage() === 1 && this.galleryTotalItems() < LOUNGE_GALLERY_PAGE_SIZE) {
            insertedOnPage1 = true;
            return [unlocked, ...items];
          }
          return items;
        });
        if (insertedOnPage1) {
          nextTotalCount += 1;
          this.galleryTotalItems.set(nextTotalCount);
          this.galleryTotalPages.set(Math.max(1, Math.ceil(nextTotalCount / LOUNGE_GALLERY_PAGE_SIZE)));
        } else if (!updatedInPlace) {
          this.galleryNeedsRefresh = true;
        }
        if (unlocked.unlocked) {
          this.unlockedGalleryItemIds.add(unlocked.id);
          this.unlockedGalleryItemIds.add(unlocked.assetId);
        }
        if (!alreadyUnlocked && unlocked.unlocked) {
          nextUnlockedCount += 1;
          this.galleryUnlockedCount.set(nextUnlockedCount);
          this.newlyUnlockedGalleryItem.set(unlocked);
          this.newlyUnlockedAssetIds.update((ids) =>
            ids.includes(unlocked.assetId) ? ids : [...ids, unlocked.assetId],
          );
        }
      }

      this.accountSummary.update((prev) =>
        prev
          ? {
              ...prev,
              unlockedGalleryCount: nextUnlockedCount,
              totalGalleryCount: Math.max(prev.totalGalleryCount, nextTotalCount),
              subscription: res.subscription
                ? res.subscription
                : {
                    ...prev.subscription,
                    remainingChatTurns: res.remainingChatTurns,
                  },
            }
          : prev,
      );
      this.composerDraft.set('');
    } catch (err) {
      if (isReconsentRequiredError(err)) {
        const serverVersion = err.requiredDisclaimerVersion;
        if (
          typeof serverVersion === 'number' &&
          Number.isInteger(serverVersion) &&
          serverVersion >= 1
        ) {
          this.disclaimerVersion.set(serverVersion);
        }
        this.resetDisclaimerScrollState();
        this.isSidebarOpen.set(false);
        this.isReconsentRequired.set(true);
        this.errorMessage.set(null);
        return;
      }
      this.errorMessage.set(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      this.isLoading.set(false);
    }
  }

  /** Opens Step 1 of the multi-step Account Deletion confirmation dialog from Options. */
  public openDeleteAccountModal(): void {
    this.deleteConfirmIrreversible.set(false);
    this.deleteConfirmNoRefund.set(false);
    this.deleteStripeError.set(null);
    this.deleteAccountStep.set(1);
    this.errorMessage.set(null);
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
   * wiping local session state and returning cleanly to Sign-Up view (aborting fail-closed on `502`).
   */
  public async confirmDeleteAccount(): Promise<void> {
    if (!this.canConfirmDeleteAccount()) {
      return;
    }
    this.isLoading.set(true);
    this.errorMessage.set(null);
    this.deleteStripeError.set(null);
    try {
      await this.accountPort.deleteAccount({
        confirmedIrreversibleDeletion: true,
        confirmedNoRefundForRemainingTurns: true,
      });
      this.resetLocalSessionState('SIGNUP');
    } catch (err) {
      if (isStripeCancellationFailedError(err)) {
        this.deleteStripeError.set(this.t('deleteModalStripeErrorBanner'));
      } else {
        this.errorMessage.set(err instanceof Error ? err.message : 'Account deletion failed');
      }
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
    this.isLoadingOlderMessages.set(false);
    this.hasMoreMessages.set(false);
    this.oldestMessageCursor.set(null);
    this.messagesTotalItems.set(0);
    this.latestMessageAnchorSeq.set(0);
    this.galleryItems.set([]);
    this.isLoadingGalleryPage.set(false);
    this.galleryCurrentPage.set(1);
    this.galleryTotalPages.set(1);
    this.galleryTotalItems.set(0);
    this.galleryUnlockedCount.set(0);
    this.newlyUnlockedGalleryItem.set(null);
    this.newlyUnlockedAssetIds.set([]);
    this.unlockedGalleryItemIds.clear();
    this.galleryNeedsRefresh = false;
    this.composerDraft.set('');
    this.optionsSavedNotice.set(null);
    this.billingTab.set('PLANS');
    this.billingCatalog.set(null);
    this.subscriptionDetail.set(null);
    this.billingOrders.set([]);
    this.billingOrdersHasMore.set(false);
    this.billingOrdersNextCursor.set(null);
    this.isLoadingBilling.set(false);
    this.isLoadingMoreOrders.set(false);
    this.billingBannerNotice.set(null);
    this.selectedCheckoutProduct.set(null);
    this.resetDisclaimerScrollState();
    this.isReconsentRequired.set(false);
    this.closeDeleteAccountModal();
    this.isSidebarOpen.set(false);
    this.activeView.set('AUTH');
    this.authMode.set(nextAuthMode);
  }

  private syncSubscriptionSummary(subscription: LoungeAccountSummaryDto['subscription']): void {
    this.accountSummary.update((prev) =>
      prev
        ? {
            ...prev,
            subscription,
          }
        : prev,
    );
  }

  private async handleBillingRedirectReturn(): Promise<void> {
    if (typeof window === 'undefined' || !window.location?.search || !this.billingPort) {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const checkoutParam = params.get('checkout');
    const sessionId = params.get('session_id')?.trim();
    const portalReturn = params.get('portal_return');
    if (!checkoutParam && portalReturn !== '1') {
      return;
    }

    const retainedParams = new URLSearchParams();
    const previewScenario = params.get('previewScenario');
    if (previewScenario) {
      retainedParams.set('previewScenario', previewScenario);
    }
    const emuXUser = params.get('emuXUser');
    if (emuXUser) {
      retainedParams.set('emuXUser', emuXUser);
    }
    const nextSearch = retainedParams.toString();
    const cleanUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}`;
    if (typeof window.history?.replaceState === 'function') {
      window.history.replaceState({}, document.title, cleanUrl);
    }

    if (checkoutParam === 'success' && sessionId) {
      this.activeView.set('BILLING');
      this.isLoadingBilling.set(true);
      try {
        const verified = await this.billingPort.verifyCheckout({ sessionId });
        this.syncSubscriptionSummary(verified.subscription);
        this.billingBannerNotice.set(
          verified.autoRefundedConflict
            ? { tone: 'warning', text: this.t('billingCheckoutAutoRefundNotice') }
            : { tone: 'success', text: this.t('billingCheckoutSuccessNotice') },
        );
        await this.selectBillingTab('PLANS');
      } catch (err) {
        this.errorMessage.set(err instanceof Error ? err.message : 'Checkout verification failed');
      } finally {
        this.isLoadingBilling.set(false);
      }
      return;
    }

    if (checkoutParam === 'cancel') {
      this.billingBannerNotice.set({
        tone: 'info',
        text: this.t('billingCheckoutCanceledNotice'),
      });
      await this.openBilling('PLANS');
      return;
    }

    if (portalReturn === '1') {
      this.activeView.set('BILLING');
      this.billingTab.set('SUBSCRIPTION');
      this.isLoadingBilling.set(true);
      try {
        const detail = await this.billingPort.getSubscriptionDetail({ portalReturn: true });
        this.subscriptionDetail.set(detail);
        this.syncSubscriptionSummary(detail.subscription);
        this.billingBannerNotice.set({
          tone: 'info',
          text: this.t('billingPortalReturnedNotice'),
        });
      } catch (err) {
        this.errorMessage.set(
          err instanceof Error ? err.message : 'Failed to synchronize Stripe portal status',
        );
      } finally {
        this.isLoadingBilling.set(false);
      }
    }
  }

  private resetDisclaimerScrollState(): void {
    this.disclaimerChecked.set(false);
    this.disclaimerScrolledToBottom.set(false);
    this.disclaimerScrollProgress.set(0);
    this.disclaimerScrolledAt.set(null);
  }

  private resolvePostAuthView(user: LoungeUser): void {
    const nextView: LoungeActiveView = user.onboardingCompleted ? 'CHAT' : 'ONBOARDING';
    this.activeView.set(nextView);

    if (user.disclaimerConsent.disclaimerVersion < this.disclaimerVersion()) {
      this.resetDisclaimerScrollState();
      this.isSidebarOpen.set(false);
      this.isReconsentRequired.set(true);
      return;
    }
    this.isReconsentRequired.set(false);
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
      this.galleryPort.listGallery({ page: 1, limit: LOUNGE_GALLERY_PAGE_SIZE }),
      this.sessionPort.listMessages({ page: 1, limit: LOUNGE_CHAT_PAGE_SIZE }),
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
    this.unlockedGalleryItemIds.clear();
    for (const item of galleryPage.data) {
      if (item.unlocked) {
        this.unlockedGalleryItemIds.add(item.id);
        this.unlockedGalleryItemIds.add(item.assetId);
      }
    }
    this.galleryItems.set(galleryPage.data);
    this.galleryCurrentPage.set(galleryPage.meta.currentPage);
    this.galleryTotalPages.set(galleryPage.meta.totalPages);
    this.galleryTotalItems.set(galleryPage.meta.totalItems);
    this.galleryUnlockedCount.set(galleryPage.summary.unlockedCount);
    this.galleryNeedsRefresh = false;

    this.activeSession.set(session);
    this.messages.set(messagesPage.data);
    this.hasMoreMessages.set(messagesPage.meta.hasMore);
    this.oldestMessageCursor.set(messagesPage.meta.nextCursor);
    this.messagesTotalItems.set(messagesPage.meta.totalItems);
    this.latestMessageAnchorSeq.update((seq) => seq + 1);
  }
}
