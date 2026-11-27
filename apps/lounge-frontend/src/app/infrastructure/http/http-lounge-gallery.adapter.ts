import { Injectable, inject } from '@angular/core';
import type { LoungeGalleryListResponseDto, LoungePaginationQueryDto } from '@rebecca/types';
import { LoungeGalleryPort } from '../../core/ports/lounge-gallery.port';
import { LoungeHttpClientHelper } from './lounge-http-client.helpers';

/**
 * Thin HTTP transport adapter implementing `LoungeGalleryPort`.
 */
@Injectable({ providedIn: 'root' })
export class HttpLoungeGalleryAdapter extends LoungeGalleryPort {
  private readonly httpHelper = inject(LoungeHttpClientHelper);

  /** @inheritdoc */
  public listGallery(query?: LoungePaginationQueryDto): Promise<LoungeGalleryListResponseDto> {
    return this.httpHelper.get<LoungeGalleryListResponseDto>('/gallery', {
      params: this.httpHelper.buildPaginationParams(query),
    });
  }
}
