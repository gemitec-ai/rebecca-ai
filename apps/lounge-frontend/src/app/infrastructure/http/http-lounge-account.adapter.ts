import { Injectable, inject } from '@angular/core';
import type {
  LoungeAccountSummaryDto,
  LoungeDeleteAccountRequestDto,
  LoungeUpdateDisclaimerConsentRequestDto,
  LoungeUpdatePreferencesRequestDto,
  LoungeUser,
} from '@rebecca/types';
import { LoungeAccountPort } from '../../core/ports/lounge-account.port';
import { LoungeHttpClientHelper } from './lounge-http-client.helpers';

/**
 * Thin HTTP transport adapter implementing `LoungeAccountPort`.
 */
@Injectable({ providedIn: 'root' })
export class HttpLoungeAccountAdapter extends LoungeAccountPort {
  private readonly httpHelper = inject(LoungeHttpClientHelper);

  /** @inheritdoc */
  public getAccountSummary(): Promise<LoungeAccountSummaryDto> {
    return this.httpHelper.get<LoungeAccountSummaryDto>('/account');
  }

  /** @inheritdoc */
  public updatePreferences(request: LoungeUpdatePreferencesRequestDto): Promise<LoungeUser> {
    return this.httpHelper.patch<LoungeUser>('/account/preferences', request);
  }

  /** @inheritdoc */
  public updateDisclaimerConsent(
    request: LoungeUpdateDisclaimerConsentRequestDto,
  ): Promise<LoungeUser> {
    return this.httpHelper.post<LoungeUser>('/account/consent', request);
  }

  /** @inheritdoc */
  public async deleteAccount(request: LoungeDeleteAccountRequestDto): Promise<void> {
    await this.httpHelper.delete<unknown>('/account', request);
  }
}
