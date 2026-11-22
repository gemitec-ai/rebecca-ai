import type { Response } from 'express';
import {
  requireLoungeIdentity,
  type LoungeAuthenticatedRequest,
} from '../../../middleware/loungeAuth';
import {
  extractTraceHeader,
  handleLoungeControllerError,
} from '../../../utils/errors';
import type { ILoungeAccountUseCase } from '../usecases/loungeAccount.usecase';

/**
 * HTTP controller handling `GET /api/v1/lounge/account`.
 */
export class LoungeAccountController {
  constructor(private readonly accountUseCase: ILoungeAccountUseCase) {}

  /** Handles `GET /api/v1/lounge/account`. */
  public async getSummary(req: LoungeAuthenticatedRequest, res: Response): Promise<void> {
    const traceHeader = extractTraceHeader(req);
    try {
      const { uid } = requireLoungeIdentity(req);
      const summary = await this.accountUseCase.getAccountSummary(uid);
      res.status(200).json(summary);
    } catch (err) {
      handleLoungeControllerError(res, err, 'GET /account', traceHeader);
    }
  }
}
