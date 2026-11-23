import {
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import type { LoungeSelectOption } from '../../../core/i18n/lounge-translations';
import { LoungeFacadeService } from '../../../core/services/lounge-facade.service';
import { LoungeDropdownComponent } from '../lounge-dropdown/lounge-dropdown.component';

/**
 * Non-dismissible, clickwrap-verified Terms & Disclaimer Re-Consent popup dialog overlaid above
 * the user's preserved Lounge session whenever `DISCLAIMER_VERSION` exceeds their accepted version.
 * Presents three transparent user choices: Agree & Continue, Log Out, or Decline & Delete Account.
 */
@Component({
  selector: 'app-reconsent-modal',
  imports: [LoungeDropdownComponent],
  templateUrl: './reconsent-modal.component.html',
  styleUrl: './reconsent-modal.component.css',
})
export class ReconsentModalComponent {
  public readonly facade = inject(LoungeFacadeService);

  public readonly languageOptions = input.required<readonly LoungeSelectOption[]>();

  public readonly languageChange = output<string>();
  public readonly requestDeleteAccount = output();

  public readonly versionSuffixLabel = computed(() => {
    const previous = this.facade.agreedDisclaimerVersion();
    const current = this.facade.disclaimerVersion();
    if (previous > 0 && previous < current) {
      return `v${previous} → v${current}`;
    }
    return `v${current}`;
  });

  private readonly modalDialogRef = viewChild<ElementRef<HTMLElement>>('modalDialog');
  private readonly modalCardRef = viewChild<ElementRef<HTMLElement>>('modalCard');
  private readonly disclaimerBoxRef = viewChild<ElementRef<HTMLElement>>('disclaimerBox');
  private readonly deleteAccountButtonRef =
    viewChild<ElementRef<HTMLButtonElement>>('reconsentDeleteButton');

  private hasFocusedInitialCard = false;

  constructor() {
    effect(() => {
      this.facade.lang();
      this.facade.disclaimerVersion();
      const boxEl = this.disclaimerBoxRef()?.nativeElement;
      const cardEl = this.modalCardRef()?.nativeElement;
      if (boxEl) {
        queueMicrotask(() => {
          this.checkZeroOverflowDisclaimer(boxEl);
          if (!this.hasFocusedInitialCard && cardEl && this.facade.deleteAccountStep() === 0) {
            this.hasFocusedInitialCard = true;
            cardEl.focus();
          }
        });
      }
    });
  }

  /** Restores keyboard focus cleanly back to `#btn-reconsent-delete` after canceling account deletion. */
  public focusDeleteButton(): void {
    queueMicrotask(() => {
      this.deleteAccountButtonRef()?.nativeElement.focus();
    });
  }

  /** Re-evaluates zero-overflow disclaimer unlock when the viewport size changes. */
  @HostListener('window:resize')
  public onWindowResize(): void {
    const boxEl = this.disclaimerBoxRef()?.nativeElement;
    if (boxEl) {
      this.checkZeroOverflowDisclaimer(boxEl);
    }
  }

  /**
   * Prevents Escape dismissal on the mandatory re-consent gate and keeps Tab navigation trapped
   * inside `#reconsent-modal` whenever `#delete-account-modal` is not layered on top.
   */
  @HostListener('document:keydown', ['$event'])
  public onDocumentKeydown(event: KeyboardEvent): void {
    if (this.facade.deleteAccountStep() > 0) {
      return;
    }
    const dialogEl = this.modalDialogRef()?.nativeElement;
    if (!dialogEl) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      return;
    }
    if (event.key === 'Tab') {
      this.trapFocusWithinDialog(event, dialogEl);
    }
  }

  /** Forwards scroll metrics from `#reconsent-scroll-box` into `LoungeFacadeService`. */
  public onDisclaimerScroll(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    this.facade.updateDisclaimerScroll(target.scrollTop, target.clientHeight, target.scrollHeight);
  }

  /** Synchronizes the explicit clickwrap consent checkbox state via `LoungeFacadeService`. */
  public onConsentChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    this.facade.setDisclaimerChecked(target.checked);
  }

  private checkZeroOverflowDisclaimer(boxEl: HTMLElement): void {
    if (boxEl.clientHeight > 0 && boxEl.scrollHeight <= boxEl.clientHeight) {
      this.facade.updateDisclaimerScroll(boxEl.scrollTop, boxEl.clientHeight, boxEl.scrollHeight);
    }
  }

  private trapFocusWithinDialog(event: KeyboardEvent, container: HTMLElement): void {
    const focusables = Array.from(
      container.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusables.length === 0) {
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    const activeIndex = active instanceof HTMLElement ? focusables.indexOf(active) : -1;

    if (event.shiftKey) {
      if (activeIndex <= 0) {
        event.preventDefault();
        last.focus();
      }
      return;
    }

    if (activeIndex === -1 || activeIndex === focusables.length - 1) {
      event.preventDefault();
      first.focus();
    }
  }
}
