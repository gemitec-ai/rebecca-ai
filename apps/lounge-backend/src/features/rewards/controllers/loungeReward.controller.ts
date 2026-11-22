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
import type { ILoungeRewardUseCase } from '../usecases/loungeReward.usecase';

/**
 * HTTP controller handling `GET /api/v1/lounge/rewards`.
 */
export class LoungeRewardController {
  constructor(private readonly rewardUseCase: ILoungeRewardUseCase) {}

  /** Handles `GET /api/v1/lounge/rewards`. */
  public async listRewards(req: LoungeAuthenticatedRequest, res: Response): Promise<void> {
    const traceHeader = extractTraceHeader(req);
    try {
      const { uid } = requireLoungeIdentity(req);
      const limit = normalizePaginationLimit(req.query['limit']);
      const startAfterId = parseStartAfterId(req.query['startAfterId']);
      const result = await this.rewardUseCase.listRewards(uid, limit, startAfterId);
      res.status(200).json(result);
    } catch (err) {
      handleLoungeControllerError(res, err, 'GET /rewards', traceHeader);
    }
  }
}
