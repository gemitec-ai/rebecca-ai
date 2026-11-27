import { Router, type NextFunction, type Response } from 'express';
import type { LoungeAuthenticatedRequest } from '../../../middleware/loungeAuth';
import { LoungeBillingController } from '../controllers/loungeBilling.controller';

/**
 * Mounts authenticated `/api/v1/lounge/billing/*` REST routes.
 */
export function createLoungeBillingRouter(
  controller: LoungeBillingController,
  requireAuth: (req: LoungeAuthenticatedRequest, res: Response, next: NextFunction) => Promise<void>,
): Router {
  const router = Router();
  router.get('/catalog', requireAuth, (req: LoungeAuthenticatedRequest, res: Response) =>
    controller.getCatalog(req, res),
  );
  router.post('/checkout', requireAuth, (req: LoungeAuthenticatedRequest, res: Response) =>
    controller.createCheckout(req, res),
  );
  router.post('/checkout/verify', requireAuth, (req: LoungeAuthenticatedRequest, res: Response) =>
    controller.verifyCheckout(req, res),
  );
  router.post('/portal', requireAuth, (req: LoungeAuthenticatedRequest, res: Response) =>
    controller.createPortal(req, res),
  );
  router.get('/subscription', requireAuth, (req: LoungeAuthenticatedRequest, res: Response) =>
    controller.getSubscription(req, res),
  );
  router.post('/eu-withdrawal', requireAuth, (req: LoungeAuthenticatedRequest, res: Response) =>
    controller.withdrawEu(req, res),
  );
  router.get('/orders', requireAuth, (req: LoungeAuthenticatedRequest, res: Response) =>
    controller.listOrders(req, res),
  );
  router.get(
    '/orders/:chargeId/receipt',
    requireAuth,
    (req: LoungeAuthenticatedRequest, res: Response) => controller.getReceipt(req, res),
  );
  return router;
}
