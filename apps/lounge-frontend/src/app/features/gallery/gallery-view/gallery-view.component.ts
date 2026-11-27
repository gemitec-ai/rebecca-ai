import { Component, inject, input, output } from '@angular/core';
import { LoungeFacadeService } from '../../../core/services/lounge-facade.service';
import { LoungePaginationComponent } from '../../../shared/components/molecules/lounge-pagination/lounge-pagination.component';
import type { LoungeImagePreviewEvent } from '../../chat/chat-view/chat-view.component';

/**
 * Paginated Gallery collection view displaying unlocked companion illustrations
 * with bounded page navigation and fullscreen lightbox preview triggers.
 */
@Component({
  selector: 'app-gallery-view',
  imports: [LoungePaginationComponent],
  templateUrl: './gallery-view.component.html',
  styleUrl: './gallery-view.component.css',
})
export class GalleryViewComponent {
  public readonly facade = inject(LoungeFacadeService);

  public readonly unlockedGalleryCount = input.required<number>();
  public readonly totalGalleryCount = input.required<number>();
  public readonly galleryPageSize = input.required<number>();

  public readonly imagePreviewRequested = output<LoungeImagePreviewEvent>();
  public readonly pageChange = output<number>();
}
