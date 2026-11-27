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
import type { LoungeSelectOption } from '../../../core/services/lounge-translations';
import { LoungeFacadeService } from '../../../core/services/lounge-facade.service';
import { LoungeDropdownComponent } from '../../../shared/components/molecules/lounge-dropdown/lounge-dropdown.component';

/**
 * Non-dismissible native `<dialog>` Terms & Disclaimer Re-Consent gate overlaid in the
 * browser top layer above the user's preserved Lounge session whenever `DISCLAIMER_VERSION`
 * exceeds their accepted version. Presents three choices: Agree & Continue, Log Out, or Delete Account.
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

  private readonly dialogRef = viewChild<ElementRef<HTMLDialogElement>>('reconsentDialog');
  private readonly disclaimerBoxRef = viewChild<ElementRef<HTMLElement>>('disclaimerBox');
  private readonly deleteAccountButtonRef =
    viewChild<ElementRef<HTMLButtonElement>>('reconsentDeleteButton');

  constructor() {
    effect(() => {
      this.facade.lang();
      this.facade.disclaimerVersion();
      this.facade.phase2EeaEnabled();
      const dialogEl = this.dialogRef()?.nativeElement;
      const boxEl = this.disclaimerBoxRef()?.nativeElement;
      if (dialogEl && !dialogEl.open) {
        dialogEl.showModal();
      }
      if (boxEl) {
        queueMicrotask(() => {
          this.checkZeroOverflowDisclaimer(boxEl);
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

  /** Prevents Escape dismissal on the mandatory non-dismissible re-consent modal. */
  public onDialogCancel(event: Event): void {
    event.preventDefault();
  }

  /** Resets native dialog `returnValue` cleanly on close. */
  public onDialogClose(): void {
    const dialogEl = this.dialogRef()?.nativeElement;
    if (dialogEl) {
      dialogEl.returnValue = '';
    }
  }

  /** Re-evaluates zero-overflow disclaimer unlock when the viewport size changes. */
  @HostListener('window:resize')
  public onWindowResize(): void {
    const boxEl = this.disclaimerBoxRef()?.nativeElement;
    if (boxEl) {
      this.checkZeroOverflowDisclaimer(boxEl);
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

  /** Synchronizes the Phase 1 non-EEA residency confirmation checkbox state. */
  public onNonEeaChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    this.facade.setNonEeaEligibilityChecked(target.checked);
  }

  private checkZeroOverflowDisclaimer(boxEl: HTMLElement): void {
    if (boxEl.clientHeight > 0 && boxEl.scrollHeight <= boxEl.clientHeight) {
      this.facade.updateDisclaimerScroll(boxEl.scrollTop, boxEl.clientHeight, boxEl.scrollHeight);
    }
  }
}
