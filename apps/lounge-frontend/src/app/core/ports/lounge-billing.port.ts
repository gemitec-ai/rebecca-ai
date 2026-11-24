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

/**
 * Hexagonal port abstracting Stripe Billing Catalog, ASCT Checkout creation/verification,
 * Customer Portal sessions, Quota Breakdown, Cursor Purchase History, Hosted Receipts,
 * and Phase 2 EEA statutory withdrawal.
 */
export abstract class LoungeBillingPort {
  /** Fetches geo-locked currency catalog, product eligibility, and pricing. */
  public abstract getCatalog(): Promise<LoungeBillingCatalogDto>;

  /** Creates a Stripe Checkout Session after statutory ASCT pre-checkout consent. */
  public abstract createCheckout(
    request: LoungeCreateCheckoutRequestDto,
  ): Promise<LoungeCreateCheckoutResponseDto>;

  /** Synchronously verifies a completed Checkout Session on return to apply turns without polling. */
  public abstract verifyCheckout(
    request: LoungeVerifyCheckoutRequestDto,
  ): Promise<LoungeVerifyCheckoutResponseDto>;

  /** Creates a single-use Stripe Customer Portal session deep-linked to the requested flow. */
  public abstract createPortal(
    request: LoungeCreatePortalRequestDto,
  ): Promise<LoungeCreatePortalResponseDto>;

  /** Fetches current subscription status, FIFO lot breakdown, and 14d/3d expiry warning. */
  public abstract getSubscriptionDetail(options?: {
    readonly portalReturn?: boolean;
  }): Promise<LoungeSubscriptionDetailResponseDto>;

  /** Executes Phase 2 EEA statutory 14-day electronic withdrawal when enabled and eligible. */
  public abstract withdrawEu(
    request: LoungeEuWithdrawalRequestDto,
  ): Promise<LoungeEuWithdrawalResponseDto>;

  /** Lists Stripe Charge-backed purchase history using bounded cursor pagination. */
  public abstract listOrders(query?: {
    readonly limit?: number;
    readonly startingAfter?: string;
  }): Promise<LoungeBillingOrdersResponseDto>;

  /** Resolves an ownership-verified hosted Stripe receipt URL for a specific charge. */
  public abstract getOrderReceipt(chargeId: string): Promise<LoungeBillingReceiptResponseDto>;
}
