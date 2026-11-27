import {
  Component,
  ElementRef,
  effect,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { LoungeFacadeService } from '../../../core/services/lounge-facade.service';

/**
 * Fullscreen illustration native `<dialog>` lightbox modal rendered in the browser top layer
 * with native Escape dismissal and close-button initial focus.
 */
@Component({
  selector: 'app-gallery-lightbox-modal',
  templateUrl: './gallery-lightbox-modal.component.html',
  styleUrl: './gallery-lightbox-modal.component.css',
})
export class GalleryLightboxModalComponent {
  public readonly facade = inject(LoungeFacadeService);

  public readonly imageUrl = input<string | null>(null);
  public readonly closed = output();

  private readonly lightboxModalRef = viewChild<ElementRef<HTMLDialogElement>>('lightboxModal');
  private readonly closeLightboxButtonRef =
    viewChild<ElementRef<HTMLButtonElement>>('closeLightboxButton');

  constructor() {
    effect(() => {
      const previewUrl = this.imageUrl();
      const lightboxEl = this.lightboxModalRef()?.nativeElement;
      if (previewUrl && lightboxEl && !lightboxEl.open) {
        lightboxEl.showModal();
        queueMicrotask(() => {
          this.closeLightboxButtonRef()?.nativeElement.focus();
        });
      } else if (!previewUrl && lightboxEl && lightboxEl.open) {
        lightboxEl.close();
        lightboxEl.returnValue = '';
      }
    });
  }

  /** Synchronizes native Escape cancellation on the gallery lightbox `<dialog>`. */
  public onLightboxDialogCancel(event: Event): void {
    event.preventDefault();
    this.close();
  }

  /** Resets `returnValue` cleanly when `#gallery-lightbox-modal` closes natively. */
  public onLightboxDialogClose(): void {
    const el = this.lightboxModalRef()?.nativeElement;
    if (el) {
      el.returnValue = '';
    }
    if (this.imageUrl() !== null) {
      this.close();
    }
  }

  /** Dismisses native `<dialog>` overlay when clicking directly on the modal backdrop margin. */
  public onDialogBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.close();
    }
  }

  /** Closes the native lightbox dialog cleanly and notifies the parent shell. */
  public close(): void {
    const el = this.lightboxModalRef()?.nativeElement;
    if (el && el.open) {
      el.close();
      el.returnValue = '';
    }
    this.closed.emit();
  }
}
