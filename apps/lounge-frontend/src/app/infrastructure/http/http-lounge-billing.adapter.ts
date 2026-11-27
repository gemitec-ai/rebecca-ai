import { HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type {
  LoungeBillingCatalogDto,
  LoungeBillingOrdersResponseDto,
  LoungeBillingReceiptResponseDto,
  LoungeCreateCheckoutRequestDto,
  LoungeCreateCheckoutResponseDto,
  LoungeCreatePortalRequestDto,
  LoungeCreatePortalResponseDto,
  LoungeEuWithdrawalRequestDto,
  LoungeEuWithdrawalResponseDto,
  LoungeSubscriptionDetailResponseDto,
  LoungeVerifyCheckoutRequestDto,
  LoungeVerifyCheckoutResponseDto,
} from '@rebecca/types';
import { LoungeBillingPort } from '../../core/ports/lounge-billing.port';
import { LoungeHttpClientHelper } from './lounge-http-client.helper';

/**
 * Thin HTTP transport adapter implementing `LoungeBillingPort`.
 */
@Injectable({ providedIn: 'root' })
export class HttpLoungeBillingAdapter extends LoungeBillingPort {
  private readonly httpHelper = inject(LoungeHttpClientHelper);

  /** @inheritdoc */
  public getCatalog(): Promise<LoungeBillingCatalogDto> {
    return this.httpHelper.get<LoungeBillingCatalogDto>('/billing/catalog');
  }

  /** @inheritdoc */
  public createCheckout(
    request: LoungeCreateCheckoutRequestDto,
  ): Promise<LoungeCreateCheckoutResponseDto> {
    return this.httpHelper.post<LoungeCreateCheckoutResponseDto>('/billing/checkout', request);
  }

  /** @inheritdoc */
  public verifyCheckout(
    request: LoungeVerifyCheckoutRequestDto,
  ): Promise<LoungeVerifyCheckoutResponseDto> {
    return this.httpHelper.post<LoungeVerifyCheckoutResponseDto>(
      '/billing/checkout/verify',
      request,
    );
  }

  /** @inheritdoc */
  public createPortal(
    request: LoungeCreatePortalRequestDto,
  ): Promise<LoungeCreatePortalResponseDto> {
    return this.httpHelper.post<LoungeCreatePortalResponseDto>('/billing/portal', request);
  }

  /** @inheritdoc */
  public getSubscriptionDetail(options?: {
    readonly portalReturn?: boolean;
  }): Promise<LoungeSubscriptionDetailResponseDto> {
    let params = new HttpParams();
    if (options?.portalReturn) {
      params = params.set('portalReturn', '1');
    }
    return this.httpHelper.get<LoungeSubscriptionDetailResponseDto>('/billing/subscription', {
      params,
    });
  }

  /** @inheritdoc */
  public withdrawEu(
    request: LoungeEuWithdrawalRequestDto,
  ): Promise<LoungeEuWithdrawalResponseDto> {
    return this.httpHelper.post<LoungeEuWithdrawalResponseDto>('/billing/eu-withdrawal', request);
  }

  /** @inheritdoc */
  public listOrders(query?: {
    readonly limit?: number;
    readonly startingAfter?: string;
  }): Promise<LoungeBillingOrdersResponseDto> {
    let params = new HttpParams();
    if (query?.limit !== undefined) {
      params = params.set('limit', String(query.limit));
    }
    if (query?.startingAfter) {
      params = params.set('startingAfter', query.startingAfter);
    }
    return this.httpHelper.get<LoungeBillingOrdersResponseDto>('/billing/orders', { params });
  }

  /** @inheritdoc */
  public getOrderReceipt(chargeId: string): Promise<LoungeBillingReceiptResponseDto> {
    return this.httpHelper.get<LoungeBillingReceiptResponseDto>(
      `/billing/orders/${encodeURIComponent(chargeId)}/receipt`,
    );
  }
}
