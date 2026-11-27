import { Component, ElementRef, inject, input, output, viewChild } from '@angular/core';
import type { LoungeSelectOption } from '../../../core/i18n';
import { LoungeFacadeService } from '../../../core/services/lounge-facade.service';
import { LoungeDropdownComponent } from '../../../shared/components/molecules/lounge-dropdown/lounge-dropdown.component';

/**
 * Account preferences and withdrawal view managing UI/conversational language selection,
 * IANA timezone synchronization, service improvement analytics opt-out, and account deletion entry.
 */
@Component({
  selector: 'app-options-view',
  imports: [LoungeDropdownComponent],
  templateUrl: './options-view.component.html',
  styleUrl: './options-view.component.css',
})
export class OptionsViewComponent {
  public readonly facade = inject(LoungeFacadeService);

  public readonly languageOptions = input.required<readonly LoungeSelectOption[]>();
  public readonly timezoneOptions = input.required<readonly LoungeSelectOption[]>();

  public readonly languageChange = output<string>();
  public readonly timezoneChange = output<string>();

  private readonly openDeleteButtonRef =
    viewChild<ElementRef<HTMLButtonElement>>('openDeleteAccountButton');

  /** Restores keyboard focus cleanly back to `#btn-open-delete-account` after canceling deletion. */
  public focusOpenDeleteButton(): void {
    queueMicrotask(() => {
      this.openDeleteButtonRef()?.nativeElement.focus();
    });
  }

  /** Updates opt-out service analytics toggle cleanly in Options. */
  public onAnalyticsOptInChange(event: Event): void {
    if (event.target instanceof HTMLInputElement) {
      void this.facade.setAnalyticsOptIn(event.target.checked);
    }
  }
}
