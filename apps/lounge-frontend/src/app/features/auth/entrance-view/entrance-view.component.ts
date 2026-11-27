import {
  Component,
  ElementRef,
  HostListener,
  effect,
  inject,
  input,
  output,
  viewChild,
  viewChildren,
} from '@angular/core';
import type { LoungeSelectOption } from '../../../core/i18n';
import { LoungeFacadeService } from '../../../core/services/lounge-facade.service';
import { LoungeDropdownComponent } from '../../../shared/components/molecules/lounge-dropdown/lounge-dropdown.component';

/**
 * X-linked entrance view orchestrating Hero companion showcase, scroll-gated legal disclaimer
 * sign-up, existing account login, and post-sign-up language/timezone onboarding confirmation.
 */
@Component({
  selector: 'app-entrance-view',
  imports: [LoungeDropdownComponent],
  templateUrl: './entrance-view.component.html',
  styleUrl: './entrance-view.component.css',
})
export class EntranceViewComponent {
  public readonly facade = inject(LoungeFacadeService);

  public readonly languageOptions = input.required<readonly LoungeSelectOption[]>();
  public readonly timezoneOptions = input.required<readonly LoungeSelectOption[]>();
  public readonly formattedVersion = input.required<string>();

  public readonly languageChange = output<string>();
  public readonly timezoneChange = output<string>();

  private readonly authTabButtons = viewChildren<ElementRef<HTMLButtonElement>>('authTabBtn');
  private readonly disclaimerBoxRef = viewChild<ElementRef<HTMLElement>>('disclaimerBox');

  constructor() {
    effect(() => {
      const view = this.facade.activeView();
      const authMode = this.facade.authMode();
      this.facade.lang();
      this.facade.phase2EeaEnabled();
      const boxEl = this.disclaimerBoxRef()?.nativeElement;
      if (view === 'AUTH' && authMode === 'SIGNUP' && boxEl) {
        queueMicrotask(() => {
          this.checkZeroOverflowDisclaimer(boxEl);
        });
      }
    });
  }

  /** Supports roving focus across entrance auth tabs via ArrowLeft, ArrowRight, Home, and End. */
  public onAuthTabKeydown(event: KeyboardEvent, index: number): void {
    const buttons = this.authTabButtons();
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

  /** Automatically unlocks short non-overflowing disclaimer containers on viewport resize. */
  @HostListener('window:resize')
  public onWindowResize(): void {
    const boxEl = this.disclaimerBoxRef()?.nativeElement;
    if (boxEl) {
      this.checkZeroOverflowDisclaimer(boxEl);
    }
  }

  /** Tracks disclaimer scroll depth and enables consent checkboxes at the bottom. */
  public onDisclaimerScroll(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    this.facade.updateDisclaimerScroll(target.scrollTop, target.clientHeight, target.scrollHeight);
  }

  /** Synchronizes consent checkbox state through the facade validation guard. */
  public onConsentChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    this.facade.setDisclaimerChecked(target.checked);
  }

  /** Synchronizes Phase 1 non-EEA residency eligibility checkbox state. */
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
