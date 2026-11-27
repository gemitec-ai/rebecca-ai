import { Router, type NextFunction, type Response } from 'express';
import type { LoungeAuthenticatedRequest } from '../../../middleware/loungeAuth';
import { LoungeGalleryController } from '../controllers/loungeGallery.controller';

/**
 * Mounts `/gallery` routes behind verified Lounge authentication.
 */
export function createLoungeGalleryRouter(
  controller: LoungeGalleryController,
  requireAuth: (req: LoungeAuthenticatedRequest, res: Response, next: NextFunction) => Promise<void>,
): Router {
  const router = Router();
  router.get('/', requireAuth, (req: LoungeAuthenticatedRequest, res: Response) =>
    controller.listGallery(req, res),
  );
  return router;
}
