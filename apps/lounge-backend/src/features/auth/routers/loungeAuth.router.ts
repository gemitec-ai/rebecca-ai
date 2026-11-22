import { Router, type NextFunction, type Request, type Response } from 'express';
import type { LoungeAuthenticatedRequest } from '../../../middleware/loungeAuth';
import { LoungeAuthController } from '../controllers/loungeAuth.controller';

/**
 * Mounts `/auth/signup`, `/auth/login`, and `/auth/logout` routes.
 */
export function createLoungeAuthRouter(
  controller: LoungeAuthController,
  requireAuth: (req: LoungeAuthenticatedRequest, res: Response, next: NextFunction) => Promise<void>,
): Router {
  const router = Router();
  router.post('/signup', (req: Request, res: Response) => controller.signUp(req, res));
  router.post('/login', (req: Request, res: Response) => controller.login(req, res));
  router.post('/logout', requireAuth, (req: LoungeAuthenticatedRequest, res: Response) =>
    controller.logout(req, res),
  );
  return router;
}
