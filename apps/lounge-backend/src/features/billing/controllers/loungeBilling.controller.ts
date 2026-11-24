import type { Request, Response } from 'express';
import { resolveClientGeo } from '../../../config/loungeConfig';
import {
  requireLoungeIdentity,
  type LoungeAuthenticatedRequest,
} from '../../../middleware/loungeAuth';
import {
  extractTraceHeader,
  handleLoungeControllerError,
  LoungeValidationError,
} from '../../../utils/errors';
import {
  parseAndValidateCreateCheckoutRequest,
  parseAndValidateEuWithdrawalRequest,
  parseAndValidatePortalRequest,
  parseAndValidateVerifyCheckoutRequest,
  parseOrdersQueryParams,
  type ILoungeBillingUseCase,
} from '../usecases/loungeBilling.usecase';

/**
 * HTTP controller exposing the 9 Private Lounge Stripe billing, portal, order history, and webhook routes.
 */
export class LoungeBillingController {
  constructor(
    private readonly billingUseCase: ILoungeBillingUseCase,
    private readonly defaultGeoCountryCode: string = 'JP',
  ) {}

  /** Handles `GET /api/v1/lounge/billing/catalog`. */
  public async getCatalog(req: LoungeAuthenticatedRequest, res: Response): Promise<void> {
    const traceHeader = extractTraceHeader(req);
    try {
      const { uid } = requireLoungeIdentity(req);
      const geo = resolveClientGeo(req.headers as Readonly<Record<string, unknown>>, {
        defaultCountryCode: this.defaultGeoCountryCode,
      });
      const result = await this.billingUseCase.getCatalog(uid, geo);
      res.status(200).json(result);
    } catch (err) {
      handleLoungeControllerError(res, err, 'GET /billing/catalog', traceHeader);
    }
  }

  /** Handles `POST /api/v1/lounge/billing/checkout`. */
  public async createCheckout(req: LoungeAuthenticatedRequest, res: Response): Promise<void> {
    const traceHeader = extractTraceHeader(req);
    try {
      const { uid } = requireLoungeIdentity(req);
      const payload = parseAndValidateCreateCheckoutRequest(req.body);
      const geo = resolveClientGeo(req.headers as Readonly<Record<string, unknown>>, {
        defaultCountryCode: this.defaultGeoCountryCode,
      });
      const result = await this.billingUseCase.createCheckoutSession(uid, payload, geo);
      res.status(200).json(result);
    } catch (err) {
      handleLoungeControllerError(res, err, 'POST /billing/checkout', traceHeader);
    }
  }

  /** Handles `POST /api/v1/lounge/billing/checkout/verify`. */
  public async verifyCheckout(req: LoungeAuthenticatedRequest, res: Response): Promise<void> {
    const traceHeader = extractTraceHeader(req);
    try {
      const { uid } = requireLoungeIdentity(req);
      const { sessionId } = parseAndValidateVerifyCheckoutRequest(req.body);
      const result = await this.billingUseCase.verifyCheckoutSession(uid, sessionId);
      res.status(200).json(result);
    } catch (err) {
      handleLoungeControllerError(res, err, 'POST /billing/checkout/verify', traceHeader);
    }
  }

  /** Handles `POST /api/v1/lounge/billing/portal`. */
  public async createPortal(req: LoungeAuthenticatedRequest, res: Response): Promise<void> {
    const traceHeader = extractTraceHeader(req);
    try {
      const { uid } = requireLoungeIdentity(req);
      const payload = parseAndValidatePortalRequest(req.body);
      const result = await this.billingUseCase.createPortalSession(uid, payload);
      res.status(200).json(result);
    } catch (err) {
      handleLoungeControllerError(res, err, 'POST /billing/portal', traceHeader);
    }
  }

  /** Handles `GET /api/v1/lounge/billing/subscription`. */
  public async getSubscription(req: LoungeAuthenticatedRequest, res: Response): Promise<void> {
    const traceHeader = extractTraceHeader(req);
    try {
      const { uid } = requireLoungeIdentity(req);
      const geo = resolveClientGeo(req.headers as Readonly<Record<string, unknown>>, {
        defaultCountryCode: this.defaultGeoCountryCode,
      });
      const portalReturn = req.query['portalReturn'] === '1' || req.query['portalReturn'] === 'true';
      const result = await this.billingUseCase.getSubscriptionDetail(uid, {
        portalReturn,
        isEeaResident: geo.isEeaResident,
      });
      res.status(200).json(result);
    } catch (err) {
      handleLoungeControllerError(res, err, 'GET /billing/subscription', traceHeader);
    }
  }

  /** Handles `POST /api/v1/lounge/billing/eu-withdrawal`. */
  public async withdrawEu(req: LoungeAuthenticatedRequest, res: Response): Promise<void> {
    const traceHeader = extractTraceHeader(req);
    try {
      const { uid } = requireLoungeIdentity(req);
      const payload = parseAndValidateEuWithdrawalRequest(req.body);
      const geo = resolveClientGeo(req.headers as Readonly<Record<string, unknown>>, {
        defaultCountryCode: this.defaultGeoCountryCode,
      });
      const result = await this.billingUseCase.withdrawEuContract(uid, payload, geo);
      res.status(200).json(result);
    } catch (err) {
      handleLoungeControllerError(res, err, 'POST /billing/eu-withdrawal', traceHeader);
    }
  }

  /** Handles `GET /api/v1/lounge/billing/orders`. */
  public async listOrders(req: LoungeAuthenticatedRequest, res: Response): Promise<void> {
    const traceHeader = extractTraceHeader(req);
    try {
      const { uid } = requireLoungeIdentity(req);
      const query = parseOrdersQueryParams(req.query as Readonly<Record<string, unknown>>);
      const result = await this.billingUseCase.listOrders(uid, query);
      res.status(200).json(result);
    } catch (err) {
      handleLoungeControllerError(res, err, 'GET /billing/orders', traceHeader);
    }
  }

  /** Handles `GET /api/v1/lounge/billing/orders/:chargeId/receipt`. */
  public async getReceipt(req: LoungeAuthenticatedRequest, res: Response): Promise<void> {
    const traceHeader = extractTraceHeader(req);
    try {
      const { uid } = requireLoungeIdentity(req);
      const chargeId = typeof req.params['chargeId'] === 'string' ? req.params['chargeId'] : '';
      const result = await this.billingUseCase.getOrderReceipt(uid, chargeId);
      res.status(200).json(result);
    } catch (err) {
      handleLoungeControllerError(res, err, 'GET /billing/orders/:chargeId/receipt', traceHeader);
    }
  }

  /**
   * Handles `POST /api/v1/lounge/webhooks/stripe` using the unparsed raw request Buffer.
   * Must be mounted before `express.json()` and global rate limiting.
   */
  public async handleWebhook(req: Request, res: Response): Promise<void> {
    const traceHeader = extractTraceHeader(req);
    try {
      const signature = req.headers['stripe-signature'];
      if (typeof signature !== 'string' || !signature.trim()) {
        throw new LoungeValidationError('Missing stripe-signature header');
      }
      if (!Buffer.isBuffer(req.body)) {
        throw new LoungeValidationError('Webhook payload must be raw unparsed bytes');
      }
      const result = await this.billingUseCase.handleStripeWebhook(req.body, signature);
      res.status(200).json(result);
    } catch (err) {
      handleLoungeControllerError(res, err, 'POST /webhooks/stripe', traceHeader);
    }
  }
}
