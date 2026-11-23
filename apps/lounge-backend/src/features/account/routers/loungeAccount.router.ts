import { Router, type NextFunction, type Response } from 'express';
import type { LoungeAuthenticatedRequest } from '../../../middleware/loungeAuth';
import { LoungeAccountController } from '../controllers/loungeAccount.controller';

/**
 * Mounts `/account` routes behind verified Lounge authentication.
 */
export function createLoungeAccountRouter(
  controller: LoungeAccountController,
  requireAuth: (req: LoungeAuthenticatedRequest, res: Response, next: NextFunction) => Promise<void>,
): Router {
  const router = Router();
  router.get('/', requireAuth, (req: LoungeAuthenticatedRequest, res: Response) =>
    controller.getSummary(req, res),
  );
  router.patch('/preferences', requireAuth, (req: LoungeAuthenticatedRequest, res: Response) =>
    controller.updatePreferences(req, res),
  );
  router.post('/consent', requireAuth, (req: LoungeAuthenticatedRequest, res: Response) =>
    controller.updateConsent(req, res),
  );
  router.delete('/', requireAuth, (req: LoungeAuthenticatedRequest, res: Response) =>
    controller.deleteAccount(req, res),
  );
  return router;
}
