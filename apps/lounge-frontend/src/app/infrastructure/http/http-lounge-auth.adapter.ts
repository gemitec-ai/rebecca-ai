import { Injectable, inject } from '@angular/core';
import type {
  LoungeAuthSessionDto,
  LoungeLoginRequestDto,
  LoungeSignUpRequestDto,
} from '@rebecca/types';
import { LoungeAuthPort } from '../../core/ports/lounge-auth.port';
import { LoungeHttpClientHelper } from './lounge-http-client.helpers';

/**
 * Thin HTTP transport adapter implementing `LoungeAuthPort` without Firebase SDK orchestration
 * or business disclaimer validation (handled in `core/`).
 */
@Injectable({ providedIn: 'root' })
export class HttpLoungeAuthAdapter extends LoungeAuthPort {
  private readonly httpHelper = inject(LoungeHttpClientHelper);

  /** @inheritdoc */
  public async getCurrentSession(): Promise<LoungeAuthSessionDto | null> {
    return this.httpHelper.post<LoungeAuthSessionDto | null>('/auth/login', {});
  }

  /** @inheritdoc */
  public async loginWithX(request: LoungeLoginRequestDto): Promise<LoungeAuthSessionDto> {
    const trimmedOAuth = request.xOAuthCode?.trim();
    return this.httpHelper.post<LoungeAuthSessionDto>('/auth/login', {
      idToken: request.idToken.trim(),
      ...(trimmedOAuth ? { xOAuthCode: trimmedOAuth } : {}),
    });
  }

  /** @inheritdoc */
  public async signUpWithX(request: LoungeSignUpRequestDto): Promise<LoungeAuthSessionDto> {
    const trimmedOAuth = request.xOAuthCode?.trim();
    return this.httpHelper.post<LoungeAuthSessionDto>('/auth/signup', {
      ...request,
      idToken: request.idToken.trim(),
      ...(trimmedOAuth ? { xOAuthCode: trimmedOAuth } : {}),
    });
  }

  /** @inheritdoc */
  public async logout(): Promise<void> {
    await this.httpHelper.post<unknown>('/auth/logout', {});
  }
}
