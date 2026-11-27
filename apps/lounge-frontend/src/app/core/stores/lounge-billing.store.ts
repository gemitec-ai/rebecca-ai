import { Injectable, inject, signal } from '@angular/core';
import type {
  LoungeBillingCatalogDto,
  LoungeBillingOrderItemDto,
  LoungeBillingProductDto,
  LoungeEuWithdrawalRequestDto,
  LoungePortalFlow,
  LoungeSubscriptionDetailResponseDto,
} from '@rebecca/types';
import { LoungeClientApiError } from '../errors/lounge-client.errors';
import { LoungeBillingPort } from '../ports/lounge-billing.port';
import { isSafeEmulatorXUserId } from '../services/lounge-auth.service';
import { isAllowedStripeRedirectUrl } from '../utils/stripe-redirect-url.validator';
import {
  assertValidPreCheckoutConsent,
  type PreCheckoutConsentSubmission,
} from '../validators/lounge-business.validator';
import { LoungeAccountOptionsStore } from './lounge-account-options.store';
import { LoungeShellStore } from './lounge-shell.store';

/** Three primary tabs inside the Billing & Usage Hub view. */
export type LoungeBillingTab = 'PLANS' | 'SUBSCRIPTION' | 'HISTORY';

/** Bounded Stripe orders page size (`[1, 30]`). */
export const LOUNGE_BILLING_ORDERS_PAGE_SIZE = 20;

export type { PreCheckoutConsentSubmission };

/**
 * Feature store managing Billing Catalog plans, ASCT pre-checkout validation & Checkout creation,
 * Stripe Customer Portal flows, purchase history cursor pagination, receipts, and EEA withdrawal.
 */
@Injectable({ providedIn: 'root' })
export class LoungeBillingStore {
  private readonly billingPort = inject(LoungeBillingPort, { optional: true });
  private readonly shell = inject(LoungeShellStore);
  private readonly accountStore = inject(LoungeAccountOptionsStore);

  public readonly billingTab = signal<LoungeBillingTab>('PLANS');
  public readonly billingCatalog = signal<LoungeBillingCatalogDto | null>(null);
  public readonly billingCatalogError = signal<boolean>(false);
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
  public readonly pendingEuWithdrawal = signal<LoungeEuWithdrawalRequestDto | null>(null);

  /** Clears transient checkout/modal selection state when navigating to a non-Billing view. */
  public clearTransientSelections(): void {
    this.selectedCheckoutProduct.set(null);
    this.pendingEuWithdrawal.set(null);
  }

  /** Navigates into the 3-Tab Billing & Usage Hub view and fetches the requested tab payload. */
  public async openBilling(tab: LoungeBillingTab = 'PLANS'): Promise<void> {
    this.accountStore.optionsSavedNotice.set(null);
    this.clearTransientSelections();
    this.shell.isSidebarOpen.set(false);
    this.shell.activeView.set('BILLING');
    await this.selectBillingTab(tab);
  }

  /** Switches tabs within the Billing & Usage Hub and loads the tab's authoritative server data. */
  public async selectBillingTab(tab: LoungeBillingTab): Promise<void> {
    this.billingTab.set(tab);
    this.pendingEuWithdrawal.set(null);
    if (!this.billingPort || !this.accountStore.accountSummary()) {
      return;
    }
    this.isLoadingBilling.set(true);
    this.shell.errorMessage.set(null);
    if (tab === 'PLANS') {
      this.billingCatalogError.set(false);
    }
    try {
      if (tab === 'PLANS') {
        const catalog = await this.billingPort.getCatalog();
        this.billingCatalog.set(catalog);
      } else if (tab === 'SUBSCRIPTION') {
        const detail = await this.billingPort.getSubscriptionDetail();
        this.subscriptionDetail.set(detail);
        this.accountStore.syncSubscriptionSummary(detail.subscription);
      } else {
        const page = await this.billingPort.listOrders({ limit: LOUNGE_BILLING_ORDERS_PAGE_SIZE });
        this.billingOrders.set(page.orders);
        this.billingOrdersHasMore.set(page.hasMore);
        this.billingOrdersNextCursor.set(page.nextCursor);
      }
    } catch (err) {
      if (tab === 'PLANS') {
        this.billingCatalogError.set(true);
      }
      this.shell.errorMessage.set(this.shell.mapUiError(err, 'errorGeneric'));
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
    if (!product.available || !product.eligible) {
      return;
    }
    this.shell.errorMessage.set(null);
    this.selectedCheckoutProduct.set(product);
  }

  /** Closes the ASCT Art. 12-6 pre-checkout confirmation modal without initiating Stripe Checkout. */
  public closePreCheckoutModal(): void {
    this.selectedCheckoutProduct.set(null);
  }

  /** Creates a Stripe Checkout Session and navigates to the validated external Checkout URL. */
  public async submitCheckout(
    consent: PreCheckoutConsentSubmission,
    navigateExternalUrl: (url: string) => void,
  ): Promise<void> {
    const product = this.selectedCheckoutProduct();
    if (!product || !this.billingPort || this.isLoadingBilling()) {
      return;
    }
    assertValidPreCheckoutConsent(consent);
    let redirectingExternally = false;
    this.isLoadingBilling.set(true);
    this.shell.errorMessage.set(null);
    try {
      const response = await this.billingPort.createCheckout({
        productId: product.productId,
        acceptedPurchaseDisclosure: consent.acceptedPurchaseDisclosure,
        acceptedAutoRenewalOptIn: consent.acceptedAutoRenewalOptIn,
        confirmedAdultOrParentalConsent: consent.confirmedAdultOrParentalConsent,
        ...(consent.euDigitalWaiverAccepted !== undefined
          ? { euDigitalWaiverAccepted: consent.euDigitalWaiverAccepted }
          : {}),
      });
      if (!isAllowedStripeRedirectUrl(response.checkoutUrl, !this.shell.isProductionRuntime())) {
        throw new LoungeClientApiError(
          0,
          'Untrusted Stripe Checkout redirect URL rejected',
          'UNTRUSTED_REDIRECT_URL',
        );
      }
      this.selectedCheckoutProduct.set(null);
      redirectingExternally = true;
      navigateExternalUrl(response.checkoutUrl);
    } catch (err) {
      redirectingExternally = false;
      this.shell.errorMessage.set(this.shell.mapUiError(err, 'errorGeneric'));
    } finally {
      if (!redirectingExternally) {
        this.isLoadingBilling.set(false);
      }
    }
  }

  /** Opens a Stripe Customer Portal flow after verifying the returned portal URL origin. */
  public async openCustomerPortal(
    flow: LoungePortalFlow,
    navigateExternalUrl: (url: string) => void,
  ): Promise<void> {
    if (!this.billingPort || this.isLoadingBilling()) {
      return;
    }
    let redirectingExternally = false;
    this.isLoadingBilling.set(true);
    this.shell.errorMessage.set(null);
    try {
      const response = await this.billingPort.createPortal({ flow });
      if (!isAllowedStripeRedirectUrl(response.portalUrl, !this.shell.isProductionRuntime())) {
        throw new LoungeClientApiError(
          0,
          'Untrusted Stripe Customer Portal URL rejected',
          'UNTRUSTED_REDIRECT_URL',
        );
      }
      redirectingExternally = true;
      navigateExternalUrl(response.portalUrl);
    } catch (err) {
      redirectingExternally = false;
      this.shell.errorMessage.set(this.shell.mapUiError(err, 'errorGeneric'));
    } finally {
      if (!redirectingExternally) {
        this.isLoadingBilling.set(false);
      }
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
    this.shell.errorMessage.set(null);
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
      this.shell.errorMessage.set(this.shell.mapUiError(err, 'errorGeneric'));
    } finally {
      this.isLoadingMoreOrders.set(false);
    }
  }

  /** Opens a Stripe hosted receipt safely in a pre-opened window after URL allowlist verification. */
  public async openOrderReceipt(
    chargeId: string,
    openBlankPopupWindow: () => Window | null,
    navigateExternalUrl: (url: string) => void,
  ): Promise<void> {
    if (!this.billingPort || !chargeId.trim()) {
      return;
    }
    const popup = openBlankPopupWindow();
    this.shell.errorMessage.set(null);
    try {
      const res = await this.billingPort.getOrderReceipt(chargeId);
      if (!isAllowedStripeRedirectUrl(res.receiptUrl, !this.shell.isProductionRuntime())) {
        throw new LoungeClientApiError(
          0,
          'Untrusted Stripe receipt URL rejected',
          'UNTRUSTED_REDIRECT_URL',
        );
      }
      if (popup && !popup.closed) {
        popup.location.replace(res.receiptUrl);
      } else {
        navigateExternalUrl(res.receiptUrl);
      }
    } catch (err) {
      if (popup && !popup.closed) {
        popup.close();
      }
      this.shell.errorMessage.set(this.shell.mapUiError(err, 'errorGeneric'));
    }
  }

  /** Opens inline 2-step confirmation for an eligible Phase 2 EEA 14-day withdrawal action. */
  public requestEuWithdrawalConfirmation(request: LoungeEuWithdrawalRequestDto): void {
    this.pendingEuWithdrawal.set(request);
  }

  /** Dismisses inline Phase 2 EEA withdrawal confirmation without calling the BFF. */
  public cancelEuWithdrawalConfirmation(): void {
    this.pendingEuWithdrawal.set(null);
  }

  /** Confirms and submits the staged Phase 2 EEA withdrawal request. */
  public async confirmPendingEuWithdrawal(): Promise<void> {
    const request = this.pendingEuWithdrawal();
    if (!request) {
      return;
    }
    this.pendingEuWithdrawal.set(null);
    await this.submitEuWithdrawal(request);
  }

  /** Submits Phase 2 EEA 14-day statutory electronic withdrawal and refreshes quota state. */
  public async submitEuWithdrawal(request: LoungeEuWithdrawalRequestDto): Promise<void> {
    if (!this.billingPort || this.isLoadingBilling()) {
      return;
    }
    this.pendingEuWithdrawal.set(null);
    this.isLoadingBilling.set(true);
    this.shell.errorMessage.set(null);
    try {
      const result = await this.billingPort.withdrawEu(request);
      this.accountStore.syncSubscriptionSummary(result.subscription);
      this.billingBannerNotice.set({
        tone: 'success',
        text: this.shell.t('billingEuWithdrawalDoneNotice'),
      });
      const detail = await this.billingPort.getSubscriptionDetail();
      this.subscriptionDetail.set(detail);
    } catch (err) {
      this.shell.errorMessage.set(this.shell.mapUiError(err, 'errorGeneric'));
    } finally {
      this.isLoadingBilling.set(false);
    }
  }

  /** Handles Stripe Checkout / Customer Portal redirect query parameters after session restoration. */
  public async handleBillingRedirectReturn(): Promise<void> {
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
    const emuXUser = params.get('emuXUser')?.trim();
    if (!this.shell.isProductionRuntime() && emuXUser && isSafeEmulatorXUserId(emuXUser)) {
      retainedParams.set('emuXUser', emuXUser);
    }
    const nextSearch = retainedParams.toString();
    const cleanUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}`;
    if (typeof window.history?.replaceState === 'function') {
      window.history.replaceState({}, document.title, cleanUrl);
    }

    if (checkoutParam === 'success') {
      this.shell.activeView.set('BILLING');
      this.billingTab.set('PLANS');
      this.isLoadingBilling.set(true);
      this.billingCatalogError.set(false);
      try {
        if (!sessionId) {
          this.shell.errorMessage.set(this.shell.t('errorCheckoutVerificationMissing'));
        } else {
          const verified = await this.billingPort.verifyCheckout({ sessionId });
          this.accountStore.syncSubscriptionSummary(verified.subscription);
          this.billingBannerNotice.set(
            verified.autoRefundedConflict
              ? { tone: 'warning', text: this.shell.t('billingCheckoutAutoRefundNotice') }
              : { tone: 'success', text: this.shell.t('billingCheckoutSuccessNotice') },
          );
        }
        try {
          const catalog = await this.billingPort.getCatalog();
          this.billingCatalog.set(catalog);
        } catch (catalogErr) {
          this.billingCatalogError.set(true);
          if (!this.shell.errorMessage()) {
            this.shell.errorMessage.set(this.shell.mapUiError(catalogErr, 'errorGeneric'));
          }
        }
      } catch (err) {
        this.shell.errorMessage.set(this.shell.mapUiError(err, 'errorGeneric'));
      } finally {
        this.isLoadingBilling.set(false);
      }
      return;
    }

    if (checkoutParam === 'cancel') {
      this.billingBannerNotice.set({
        tone: 'info',
        text: this.shell.t('billingCheckoutCanceledNotice'),
      });
      await this.openBilling('PLANS');
      return;
    }

    if (portalReturn === '1') {
      this.shell.activeView.set('BILLING');
      this.billingTab.set('SUBSCRIPTION');
      this.isLoadingBilling.set(true);
      try {
        const detail = await this.billingPort.getSubscriptionDetail({ portalReturn: true });
        this.subscriptionDetail.set(detail);
        this.accountStore.syncSubscriptionSummary(detail.subscription);
        this.billingBannerNotice.set({
          tone: 'info',
          text: this.shell.t('billingPortalReturnedNotice'),
        });
      } catch (err) {
        this.shell.errorMessage.set(this.shell.mapUiError(err, 'errorGeneric'));
      } finally {
        this.isLoadingBilling.set(false);
      }
    }
  }

  /** Resets all Billing catalog, order pagination, and modal states on logout or account removal. */
  public reset(): void {
    this.billingTab.set('PLANS');
    this.billingCatalog.set(null);
    this.billingCatalogError.set(false);
    this.subscriptionDetail.set(null);
    this.billingOrders.set([]);
    this.billingOrdersHasMore.set(false);
    this.billingOrdersNextCursor.set(null);
    this.isLoadingBilling.set(false);
    this.isLoadingMoreOrders.set(false);
    this.billingBannerNotice.set(null);
    this.selectedCheckoutProduct.set(null);
    this.pendingEuWithdrawal.set(null);
  }
}
