import type { Request, Response } from 'express';
import {
  requireLoungeIdentity,
  type LoungeAuthenticatedRequest,
} from '../../../middleware/loungeAuth';
import {
  DEFAULT_TRUSTED_GEO_HEADER,
  resolveClientGeo,
  type TrustedGeoHeaderName,
} from '../../../utils/clientGeo';
import {
  extractTraceHeader,
  handleLoungeControllerError,
  LoungeValidationError,
} from '../../../utils/errors';
import type { ILoungeBillingUseCase } from '../usecases/loungeBilling.usecase';
import {
  parseAndValidateCreateCheckoutRequest,
  parseAndValidateEuWithdrawalRequest,
  parseAndValidatePortalRequest,
  parseAndValidateVerifyCheckoutRequest,
  parseOrdersQueryParams,
} from '../validators/loungeBilling.validator';

/** Strictly parses `portalReturn` query string (`0`, `1`, `true`, `false`, or omitted). */
export function parseSubscriptionQueryParams(
  rawQuery: Readonly<Record<string, unknown>>,
): { readonly portalReturn: boolean } {
  const raw = rawQuery['portalReturn'];
  if (raw === undefined) {
    return { portalReturn: false };
  }
  if (raw === '1' || raw === 'true') {
    return { portalReturn: true };
  }
  if (raw === '0' || raw === 'false') {
    return { portalReturn: false };
  }
  throw new LoungeValidationError(
    'Query parameter "portalReturn" must be one of: 0, 1, true, false',
  );
}

/**
 * HTTP controller exposing the 9 Private Lounge Stripe billing, portal, order history, and webhook routes.
 */
export class LoungeBillingController {
  constructor(
    private readonly billingUseCase: ILoungeBillingUseCase,
    private readonly defaultGeoCountryCode: string = 'JP',
    private readonly trustedGeoHeader: TrustedGeoHeaderName = DEFAULT_TRUSTED_GEO_HEADER,
  ) {}

  /** Handles `GET /api/v1/lounge/billing/catalog`. */
  public async getCatalog(req: LoungeAuthenticatedRequest, res: Response): Promise<void> {
    const traceHeader = extractTraceHeader(req);
    try {
      const { uid } = requireLoungeIdentity(req);
      const geo = resolveClientGeo(req.headers as Readonly<Record<string, unknown>>, {
        trustedGeoHeader: this.trustedGeoHeader,
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
        trustedGeoHeader: this.trustedGeoHeader,
        defaultCountryCode: this.defaultGeoCountryCode,
      });
      const result = await this.billingUseCase.createCheckoutSession(uid, payload, geo, traceHeader);
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
      const result = await this.billingUseCase.verifyCheckoutSession(uid, sessionId, traceHeader);
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
        trustedGeoHeader: this.trustedGeoHeader,
        defaultCountryCode: this.defaultGeoCountryCode,
      });
      const { portalReturn } = parseSubscriptionQueryParams(
        req.query as Readonly<Record<string, unknown>>,
      );
      const result = await this.billingUseCase.getSubscriptionDetail(uid, {
        portalReturn,
        clientGeo: geo,
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
        trustedGeoHeader: this.trustedGeoHeader,
        defaultCountryCode: this.defaultGeoCountryCode,
      });
      const result = await this.billingUseCase.withdrawEuContract(uid, payload, geo, traceHeader);
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
      const result = await this.billingUseCase.handleStripeWebhook(req.body, signature, traceHeader);
      res.status(200).json(result);
    } catch (err) {
      handleLoungeControllerError(res, err, 'POST /webhooks/stripe', traceHeader);
    }
  }
}
