import { Injectable, inject } from '@angular/core';
import type {
  LoungeMessageListResponseDto,
  LoungePaginationQueryDto,
  LoungeSendMessageRequestDto,
  LoungeSendMessageResponseDto,
  LoungeSession,
} from '@rebecca/types';
import { LoungeSessionPort } from '../../core/ports/lounge-session.port';
import { LoungeHttpClientHelper } from './lounge-http-client.helpers';

/**
 * Thin HTTP transport adapter implementing `LoungeSessionPort`.
 */
@Injectable({ providedIn: 'root' })
export class HttpLoungeSessionAdapter extends LoungeSessionPort {
  private readonly httpHelper = inject(LoungeHttpClientHelper);

  /** @inheritdoc */
  public getSession(): Promise<LoungeSession> {
    return this.httpHelper.get<LoungeSession>('/session');
  }

  /** @inheritdoc */
  public listMessages(query?: LoungePaginationQueryDto): Promise<LoungeMessageListResponseDto> {
    return this.httpHelper.get<LoungeMessageListResponseDto>('/session/messages', {
      params: this.httpHelper.buildPaginationParams(query),
    });
  }

  /** @inheritdoc */
  public sendMessage(
    request: LoungeSendMessageRequestDto,
  ): Promise<LoungeSendMessageResponseDto> {
    return this.httpHelper.post<LoungeSendMessageResponseDto>('/session/messages', {
      content: request.content,
    });
  }
}
