import { LoungeConflictError } from '../../../utils/errors';
import type {
  ILoungeStripeGatewayPort,
  LoungeStripeChargeRecord,
  LoungeStripeCheckoutSession,
  LoungeStripeResolvedInvoice,
  LoungeStripeSubscriptionSnapshot,
  LoungeStripeWebhookEvent,
} from '../ports/loungeStripe.port';

/**
 * Safe disabled gateway active when billing is launched in Free-only Coming Soon mode without Stripe credentials.
 * Fails closed (`409 COMING_SOON`) on checkout/portal/webhook calls while returning empty read-only order/invoice lists.
 */
export class DisabledLoungeStripeGatewayAdapter implements ILoungeStripeGatewayPort {
  public readonly isConfigured = false;

  private throwComingSoon(): never {
    throw new LoungeConflictError('Stripe billing is currently in preparation', {
      code: 'COMING_SOON',
    });
  }

  public async ensureCustomer(): Promise<{ readonly customerId: string }> {
    return this.throwComingSoon();
  }

  public async createCheckoutSession(): Promise<{ readonly id: string; readonly url: string }> {
    return this.throwComingSoon();
  }

  public async retrieveCheckoutSession(): Promise<LoungeStripeCheckoutSession> {
    return this.throwComingSoon();
  }

  public async createPortalSession(): Promise<{ readonly url: string }> {
    return this.throwComingSoon();
  }

  public async retrieveSubscription(): Promise<LoungeStripeSubscriptionSnapshot> {
    return this.throwComingSoon();
  }

  public async listCharges(): Promise<{
    readonly charges: LoungeStripeChargeRecord[];
    readonly hasMore: boolean;
  }> {
    return { charges: [], hasMore: false };
  }

  public async retrieveCharge(): Promise<LoungeStripeChargeRecord> {
    return this.throwComingSoon();
  }

  public async resolveInvoiceByPaymentIntent(): Promise<LoungeStripeResolvedInvoice | null> {
    return null;
  }

  public async resolvePaymentIntentByInvoice(): Promise<string | null> {
    return null;
  }

  public async createFullRefund(): Promise<{ readonly refundId: string }> {
    return this.throwComingSoon();
  }

  public async cancelSubscriptionImmediately(): Promise<void> {
    return undefined;
  }

  public async cancelAndDeleteCustomer(): Promise<void> {
    return undefined;
  }

  public constructWebhookEvent(): LoungeStripeWebhookEvent {
    return this.throwComingSoon();
  }
}
