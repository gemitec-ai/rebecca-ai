import type { Response } from 'express';
import {
  requireLoungeIdentity,
  type LoungeAuthenticatedRequest,
} from '../../../middleware/loungeAuth';
import {
  extractTraceHeader,
  handleLoungeControllerError,
  normalizePaginationLimit,
  parseStartAfterId,
} from '../../../utils/errors';
import type { ILoungeGalleryUseCase } from '../usecases/loungeGallery.usecase';

/**
 * HTTP controller handling `GET /api/v1/lounge/gallery`.
 */
export class LoungeGalleryController {
  constructor(private readonly galleryUseCase: ILoungeGalleryUseCase) {}

  /** Handles `GET /api/v1/lounge/gallery`. */
  public async listGallery(req: LoungeAuthenticatedRequest, res: Response): Promise<void> {
    const traceHeader = extractTraceHeader(req);
    try {
      const { uid } = requireLoungeIdentity(req);
      const limit = normalizePaginationLimit(req.query['limit']);
      const startAfterId = parseStartAfterId(req.query['startAfterId']);
      const result = await this.galleryUseCase.listGallery(uid, limit, startAfterId);
      res.status(200).json(result);
    } catch (err) {
      handleLoungeControllerError(res, err, 'GET /gallery', traceHeader);
    }
  }
}
