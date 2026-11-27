import {
  Component,
  ElementRef,
  effect,
  inject,
  output,
  viewChild,
} from '@angular/core';
import { LoungeFacadeService } from '../../../core/services/lounge-facade.service';

/**
 * Two-step native `<dialog>` account withdrawal and data-erasure modal with active subscription
 * management redirect, mandatory irreversible/no-refund confirmations, and Stripe failure banner.
 */
@Component({
  selector: 'app-delete-account-modal',
  templateUrl: './delete-account-modal.component.html',
  styleUrl: './delete-account-modal.component.css',
})
export class DeleteAccountModalComponent {
  public readonly facade = inject(LoungeFacadeService);

  public readonly closed = output();

  private readonly deleteModalRef = viewChild<ElementRef<HTMLDialogElement>>('deleteModal');
  private readonly deleteCancelButtonRef =
    viewChild<ElementRef<HTMLButtonElement>>('deleteCancelButton');
  private readonly deleteIrreversibleCheckRef =
    viewChild<ElementRef<HTMLInputElement>>('deleteIrreversibleCheck');

  private prevDeleteStep = 0;

  constructor() {
    effect(() => {
      const deleteStep = this.facade.deleteAccountStep();
      const deleteEl = this.deleteModalRef()?.nativeElement;
      if (deleteStep > 0 && deleteEl && !deleteEl.open) {
        deleteEl.showModal();
      } else if (deleteStep === 0 && deleteEl && deleteEl.open) {
        deleteEl.close();
        deleteEl.returnValue = '';
      }

      if (deleteStep > 0 && this.prevDeleteStep === 0) {
        queueMicrotask(() => {
          this.deleteCancelButtonRef()?.nativeElement.focus();
        });
      } else if (deleteStep === 2 && this.prevDeleteStep === 1) {
        queueMicrotask(() => {
          this.deleteIrreversibleCheckRef()?.nativeElement.focus();
        });
      } else if (deleteStep === 0 && this.prevDeleteStep > 0) {
        this.closed.emit();
      }
      this.prevDeleteStep = deleteStep;
    });
  }

  /** Synchronizes the Step 2 irreversible data-erasure confirmation checkbox. */
  public onDeleteIrreversibleChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    this.facade.setDeleteConfirmIrreversible(target.checked);
  }

  /** Synchronizes the Step 2 no-refund acknowledgement checkbox. */
  public onDeleteNoRefundChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    this.facade.setDeleteConfirmNoRefund(target.checked);
  }

  /** Redirects users from Step 1 deletion modal to Subscription Management without erasing data. */
  public openSubscriptionFromDeleteModal(): void {
    this.facade.closeDeleteAccountModal();
    void this.facade.openBilling('SUBSCRIPTION');
  }

  /** Synchronizes native Escape cancellation on the account deletion `<dialog>`. */
  public onDeleteDialogCancel(event: Event): void {
    event.preventDefault();
    this.facade.closeDeleteAccountModal();
  }

  /** Resets `returnValue` cleanly when `#delete-account-modal` closes natively. */
  public onDeleteDialogClose(): void {
    const el = this.deleteModalRef()?.nativeElement;
    if (el) {
      el.returnValue = '';
    }
    if (this.facade.deleteAccountStep() > 0) {
      this.facade.closeDeleteAccountModal();
    }
  }

  /** Dismisses native `<dialog>` overlay when clicking directly on the modal backdrop margin. */
  public onDialogBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.facade.closeDeleteAccountModal();
    }
  }
}
