import { Router, type NextFunction, type Response } from 'express';
import type { LoungeAuthenticatedRequest } from '../../../middleware/loungeAuth';
import { LoungeSessionController } from '../controllers/loungeSession.controller';

/**
 * Mounts `/sessions` and `/sessions/:sessionId/messages` routes behind verified Lounge authentication.
 */
export function createLoungeSessionRouter(
  controller: LoungeSessionController,
  requireAuth: (req: LoungeAuthenticatedRequest, res: Response, next: NextFunction) => Promise<void>,
): Router {
  const router = Router();
  router.get('/', requireAuth, (req: LoungeAuthenticatedRequest, res: Response) =>
    controller.listSessions(req, res),
  );
  router.post('/', requireAuth, (req: LoungeAuthenticatedRequest, res: Response) =>
    controller.createSession(req, res),
  );
  router.get(
    '/:sessionId/messages',
    requireAuth,
    (req: LoungeAuthenticatedRequest, res: Response) => controller.listMessages(req, res),
  );
  router.post(
    '/:sessionId/messages',
    requireAuth,
    (req: LoungeAuthenticatedRequest, res: Response) => controller.sendMessage(req, res),
  );
  return router;
}
