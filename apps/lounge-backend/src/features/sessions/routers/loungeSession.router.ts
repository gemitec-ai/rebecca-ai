import { Router, type NextFunction, type Response } from 'express';
import type { LoungeAuthenticatedRequest } from '../../../middleware/loungeAuth';
import { LoungeSessionController } from '../controllers/loungeSession.controller';

/**
 * Mounts single-session routes (`/session` and `/session/messages`) behind verified Lounge authentication.
 */
export function createLoungeSessionRouter(
  controller: LoungeSessionController,
  requireAuth: (req: LoungeAuthenticatedRequest, res: Response, next: NextFunction) => Promise<void>,
): Router {
  const router = Router();
  router.get('/', requireAuth, (req: LoungeAuthenticatedRequest, res: Response) =>
    controller.getSession(req, res),
  );
  router.get('/messages', requireAuth, (req: LoungeAuthenticatedRequest, res: Response) =>
    controller.listMessages(req, res),
  );
  router.post('/messages', requireAuth, (req: LoungeAuthenticatedRequest, res: Response) =>
    controller.sendMessage(req, res),
  );
  return router;
}
