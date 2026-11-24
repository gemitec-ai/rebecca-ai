import { Component, ElementRef, computed, inject, viewChildren } from '@angular/core';
import type {
  LoungeBillingOrderItemDto,
  LoungeBillingProductDto,
  LoungeOrderStatus,
  LoungeProductId,
} from '@rebecca/types';
import {
  LoungeFacadeService,
  type LoungeBillingTab,
} from '../../../core/services/lounge-facade.service';
import { PreCheckoutModalComponent } from '../pre-checkout-modal/pre-checkout-modal.component';

const BILLING_TABS: readonly LoungeBillingTab[] = ['PLANS', 'SUBSCRIPTION', 'HISTORY'];

/**
 * 3-tab Billing & Usage Hub (`Plans & Top-Ups`, `Subscription & Balance`, `Purchase History`)
 * implementing WAI-ARIA tabbed panel semantics, Stripe Customer Portal delegation, and
 * ASCT Art. 12-6 pre-checkout confirmation.
 */
@Component({
  selector: 'app-billing-hub',
  imports: [PreCheckoutModalComponent],
  templateUrl: './billing-hub.component.html',
  styleUrl: './billing-hub.component.css',
})
export class BillingHubComponent {
  public readonly facade = inject(LoungeFacadeService);

  public readonly tabs = BILLING_TABS;
  private readonly tabButtons = viewChildren<ElementRef<HTMLButtonElement>>('tabBtn');

  public readonly isAccountSuspended = computed(
    () => this.facade.accountSummary()?.user.status === 'SUSPENDED',
  );

  public readonly isGeoBlocked = computed(() => {
    const catalog = this.facade.billingCatalog();
    return Boolean(catalog && catalog.isEeaResident && !catalog.phase2EeaEnabled);
  });

  public readonly hasStripeCustomerHistory = computed(() => {
    const summary = this.facade.accountSummary();
    const detail = this.facade.subscriptionDetail();
    const orders = this.facade.billingOrders();
    if (!summary) {
      return false;
    }
    const sub = summary.subscription;
    return (
      sub.status !== 'NONE' ||
      sub.trialTicketUsed ||
      orders.length > 0 ||
      Boolean(detail?.quotaBreakdown.activeLots.some((lot) => lot.isPaid))
    );
  });

  public readonly canOpenCancelPortal = computed(() => {
    const status = this.facade.accountSummary()?.subscription.status;
    return status === 'ACTIVE' || status === 'PAST_DUE';
  });

  /** Returns deterministic tab element ID used for `aria-labelledby`. */
  public tabId(tab: LoungeBillingTab): string {
    return `billing-tab-${tab.toLowerCase()}`;
  }

  /** Returns localized label for each Billing Hub tab. */
  public tabLabel(tab: LoungeBillingTab): string {
    if (tab === 'PLANS') {
      return this.facade.t('billingTabPlans');
    }
    if (tab === 'SUBSCRIPTION') {
      return this.facade.t('billingTabSubscription');
    }
    return this.facade.t('billingTabHistory');
  }

  /** Activates a Billing Hub tab on click or Enter/Space (selection by activation). */
  public selectTab(tab: LoungeBillingTab): void {
    void this.facade.selectBillingTab(tab);
  }

  /** Supports roving focus across single-row tabs via `ArrowLeft`, `ArrowRight`, `Home`, and `End`. */
  public onTabKeydown(event: KeyboardEvent, index: number): void {
    const buttons = this.tabButtons();
    if (buttons.length === 0) {
      return;
    }
    let nextIndex = -1;
    if (event.key === 'ArrowRight') {
      nextIndex = (index + 1) % buttons.length;
    } else if (event.key === 'ArrowLeft') {
      nextIndex = (index - 1 + buttons.length) % buttons.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = buttons.length - 1;
    }
    if (nextIndex >= 0) {
      event.preventDefault();
      buttons[nextIndex]?.nativeElement.focus();
    }
  }

  /** Returns localized title for any Lounge product identifier. */
  public getProductTitle(productId: LoungeProductId | 'UNKNOWN'): string {
    if (productId === 'TRIAL_TICKET_100') {
      return this.facade.t('billingTrialTitle');
    }
    if (productId === 'CHARGE_TICKET_100') {
      return this.facade.t('billingChargeTitle');
    }
    if (productId === 'STANDARD_MONTHLY') {
      return this.facade.t('billingStandardTitle');
    }
    if (productId === 'WELCOME_BONUS_20') {
      return 'Welcome Bonus (+20)';
    }
    return 'Stripe Payment';
  }

  /** Returns localized description for a purchasable product card. */
  public getProductDescription(product: LoungeBillingProductDto): string {
    if (product.productId === 'TRIAL_TICKET_100') {
      return this.facade.t('billingTrialDesc');
    }
    if (product.productId === 'CHARGE_TICKET_100') {
      return this.facade.t('billingChargeDesc');
    }
    return this.facade.t('billingStandardDesc');
  }

  /** Formats localized price string (`¥1,400/月` vs `¥500` / `$9.50/mo`). */
  public formatProductPrice(product: LoungeBillingProductDto): string {
    return product.mode === 'subscription'
      ? `${product.formattedPrice}${this.facade.t('billingStandardUnitSuffix')}`
      : product.formattedPrice;
  }

  /** Formats minor currency units for Stripe Charge order rows (JPY is zero-decimal, USD is /100). */
  public formatOrderAmount(order: Pick<LoungeBillingOrderItemDto, 'amountMinor' | 'currency'>): string {
    const value = order.currency === 'JPY' ? order.amountMinor : order.amountMinor / 100;
    try {
      return new Intl.NumberFormat(this.facade.lang() === 'ja' ? 'ja-JP' : 'en-US', {
        style: 'currency',
        currency: order.currency,
        minimumFractionDigits: order.currency === 'JPY' ? 0 : 2,
        maximumFractionDigits: order.currency === 'JPY' ? 0 : 2,
      }).format(value);
    } catch {
      return `${order.currency} ${value}`;
    }
  }

  /** Returns localized status label for Stripe Charge rows across all normalized statuses. */
  public getOrderStatusLabel(status: LoungeOrderStatus): string {
    switch (status) {
      case 'COMPLETED':
        return this.facade.t('orderStatusPaid');
      case 'REFUNDED':
        return this.facade.t('orderStatusRefunded');
      case 'PARTIAL_REFUNDED':
        return this.facade.t('orderStatusPartiallyRefunded');
      case 'DISPUTED':
        return this.facade.t('orderStatusDisputed');
      case 'FAILED':
        return this.facade.t('orderStatusFailed');
      case 'PENDING':
        return 'PENDING';
    }
  }

  /** Formats ISO timestamps consistently in the user's configured IANA timezone and locale. */
  public formatDateTime(iso: string | null | undefined): string {
    if (!iso) {
      return '—';
    }
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) {
      return iso;
    }
    try {
      return new Intl.DateTimeFormat(this.facade.lang(), {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: this.facade.timezone(),
      }).format(parsed);
    } catch {
      return parsed.toISOString().slice(0, 16).replace('T', ' ');
    }
  }

  /** Triggers Phase 2 EEA statutory 14-day withdrawal when explicitly enabled and eligible. */
  public requestEuSubscriptionWithdrawal(subscriptionId: string): void {
    void this.facade.submitEuWithdrawal({
      targetType: 'SUBSCRIPTION',
      targetId: subscriptionId,
      confirmedWithdrawal: true,
    });
  }
}
