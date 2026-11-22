import { Router, type NextFunction, type Response } from 'express';
import type { LoungeAuthenticatedRequest } from '../../../middleware/loungeAuth';
import { LoungeRewardController } from '../controllers/loungeReward.controller';

/**
 * Mounts `/rewards` routes behind verified Lounge authentication.
 */
export function createLoungeRewardRouter(
  controller: LoungeRewardController,
  requireAuth: (req: LoungeAuthenticatedRequest, res: Response, next: NextFunction) => Promise<void>,
): Router {
  const router = Router();
  router.get('/', requireAuth, (req: LoungeAuthenticatedRequest, res: Response) =>
    controller.listRewards(req, res),
  );
  return router;
}
