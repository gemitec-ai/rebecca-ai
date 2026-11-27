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
import {
  parseAndValidateDeleteAccountRequest,
  parseAndValidatePreferencesRequest,
  parseAndValidateReconsentRequest,
} from '../validators/loungeAccount.validator';

/**
 * HTTP controller handling `/api/v1/lounge/account` endpoints.
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

  /** Handles `PATCH /api/v1/lounge/account/preferences`. */
  public async updatePreferences(req: LoungeAuthenticatedRequest, res: Response): Promise<void> {
    const traceHeader = extractTraceHeader(req);
    try {
      const { uid } = requireLoungeIdentity(req);
      const payload = parseAndValidatePreferencesRequest(req.body);
      const updatedUser = await this.accountUseCase.updatePreferences(uid, payload, traceHeader);
      res.status(200).json(updatedUser);
    } catch (err) {
      handleLoungeControllerError(res, err, 'PATCH /account/preferences', traceHeader);
    }
  }

  /** Handles `POST /api/v1/lounge/account/consent` (disclaimer re-consent). */
  public async updateConsent(req: LoungeAuthenticatedRequest, res: Response): Promise<void> {
    const traceHeader = extractTraceHeader(req);
    try {
      const { uid } = requireLoungeIdentity(req);
      const payload = parseAndValidateReconsentRequest(req.body);
      const updatedUser = await this.accountUseCase.updateDisclaimerConsent(
        uid,
        payload,
        traceHeader,
      );
      res.status(200).json(updatedUser);
    } catch (err) {
      handleLoungeControllerError(res, err, 'POST /account/consent', traceHeader);
    }
  }

  /** Handles `DELETE /api/v1/lounge/account` (irreversible cascade deletion with no refunds). */
  public async deleteAccount(req: LoungeAuthenticatedRequest, res: Response): Promise<void> {
    const traceHeader = extractTraceHeader(req);
    try {
      const { uid } = requireLoungeIdentity(req);
      const payload = parseAndValidateDeleteAccountRequest(req.body);
      await this.accountUseCase.deleteAccount(uid, payload, traceHeader);
      res.status(204).send();
    } catch (err) {
      handleLoungeControllerError(res, err, 'DELETE /account', traceHeader);
    }
  }
}
