import {
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import type { LoungeBillingProductDto } from '@rebecca/types';
import { LoungeFacadeService } from '../../../core/services/lounge-facade.service';

/**
 * Native `<dialog>` pre-checkout disclosure modal fulfilling Japanese Specified Commercial
 * Transactions Act (ASCT Art. 12-6) and EU consumer confirmation requirements with
 * default-unchecked consent checkboxes and zero focus-trap boilerplate.
 */
@Component({
  selector: 'app-pre-checkout-modal',
  templateUrl: './pre-checkout-modal.component.html',
  styleUrl: './pre-checkout-modal.component.css',
})
export class PreCheckoutModalComponent {
  public readonly facade = inject(LoungeFacadeService);

  public readonly product = input<LoungeBillingProductDto | null>(null);
  public readonly isEeaResident = input<boolean>(false);
  public readonly phase2EeaEnabled = input<boolean>(false);

  private readonly dialogRef = viewChild<ElementRef<HTMLDialogElement>>('preCheckoutDialog');

  public readonly checkedDisclosure = signal<boolean>(false);
  public readonly checkedAutoRenew = signal<boolean>(false);
  public readonly checkedAdultConsent = signal<boolean>(false);
  public readonly checkedEuWaiver = signal<boolean>(false);

  public readonly needsEuWaiver = computed(
    () => this.isEeaResident() && this.phase2EeaEnabled(),
  );

  public readonly canProceed = computed(() => {
    const activeProduct = this.product();
    if (!activeProduct || this.facade.isLoadingBilling()) {
      return false;
    }
    const baseOk =
      this.checkedDisclosure() && this.checkedAutoRenew() && this.checkedAdultConsent();
    return this.needsEuWaiver() ? baseOk && this.checkedEuWaiver() : baseOk;
  });

  public readonly productTitle = computed(() => {
    const prod = this.product();
    if (!prod) {
      return '';
    }
    if (prod.productId === 'TRIAL_TICKET_100') {
      return this.facade.t('billingTrialTitle');
    }
    if (prod.productId === 'CHARGE_TICKET_100') {
      return this.facade.t('billingChargeTitle');
    }
    return this.facade.t('billingStandardTitle');
  });

  public readonly formattedTotalPrice = computed(() => {
    const prod = this.product();
    if (!prod) {
      return '';
    }
    return prod.mode === 'subscription'
      ? `${prod.formattedPrice}${this.facade.t('billingStandardUnitSuffix')}`
      : prod.formattedPrice;
  });

  constructor() {
    effect(() => {
      const currentProduct = this.product();
      const dialogEl = this.dialogRef()?.nativeElement;
      if (currentProduct) {
        this.checkedDisclosure.set(false);
        this.checkedAutoRenew.set(false);
        this.checkedAdultConsent.set(false);
        this.checkedEuWaiver.set(false);
        if (dialogEl && !dialogEl.open) {
          if (typeof dialogEl.showModal === 'function') {
            dialogEl.showModal();
          } else {
            dialogEl.setAttribute('open', '');
          }
        }
      } else if (dialogEl && dialogEl.open) {
        if (typeof dialogEl.close === 'function') {
          dialogEl.close();
        } else {
          dialogEl.removeAttribute('open');
        }
        dialogEl.returnValue = '';
      }
    });
  }

  /** Synchronizes native `Esc` / cancel dismissal with facade state cleanly. */
  public onDialogCancel(event: Event): void {
    event.preventDefault();
    this.cancel();
  }

  /** Updates primary price/terms acknowledgement checkbox state. */
  public onDisclosureChange(event: Event): void {
    if (event.target instanceof HTMLInputElement) {
      this.checkedDisclosure.set(event.target.checked);
    }
  }

  /** Updates subscription auto-renewal or non-refundable one-time purchase checkbox state. */
  public onAutoRenewChange(event: Event): void {
    if (event.target instanceof HTMLInputElement) {
      this.checkedAutoRenew.set(event.target.checked);
    }
  }

  /** Updates majority age / guardian consent checkbox state. */
  public onAdultConsentChange(event: Event): void {
    if (event.target instanceof HTMLInputElement) {
      this.checkedAdultConsent.set(event.target.checked);
    }
  }

  /** Updates Phase 2 EEA digital withdrawal acknowledgement checkbox state. */
  public onEuWaiverChange(event: Event): void {
    if (event.target instanceof HTMLInputElement) {
      this.checkedEuWaiver.set(event.target.checked);
    }
  }

  /** Cancels checkout preview and returns focus natively to triggering card button. */
  public cancel(): void {
    const dialogEl = this.dialogRef()?.nativeElement;
    if (dialogEl && dialogEl.open) {
      if (typeof dialogEl.close === 'function') {
        dialogEl.close('cancel');
      } else {
        dialogEl.removeAttribute('open');
      }
      dialogEl.returnValue = '';
    }
    this.facade.closePreCheckoutModal();
  }

  /** Submits explicit ASCT checkboxes to initiate Stripe Checkout creation. */
  public async proceed(): Promise<void> {
    if (!this.canProceed()) {
      return;
    }
    await this.facade.submitCheckout({
      acceptedPurchaseDisclosure: true,
      acceptedAutoRenewalOptIn: true,
      confirmedAdultOrParentalConsent: true,
      ...(this.needsEuWaiver() ? { euDigitalWaiverAccepted: this.checkedEuWaiver() } : {}),
    });
  }
}
