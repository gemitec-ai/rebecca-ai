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
import {
  parseAndValidateSendMessageRequest,
  type ILoungeSessionUseCase,
} from '../usecases/loungeSession.usecase';

/**
 * HTTP controller handling `/api/v1/lounge/session` and `/api/v1/lounge/session/messages`.
 */
export class LoungeSessionController {
  constructor(private readonly sessionUseCase: ILoungeSessionUseCase) {}

  /** Handles `GET /api/v1/lounge/session`. */
  public async getSession(req: LoungeAuthenticatedRequest, res: Response): Promise<void> {
    const traceHeader = extractTraceHeader(req);
    try {
      const identity = requireLoungeIdentity(req);
      const session = await this.sessionUseCase.getSession(identity.uid, identity.xUserId);
      res.status(200).json(session);
    } catch (err) {
      handleLoungeControllerError(res, err, 'GET /session', traceHeader);
    }
  }

  /** Handles `GET /api/v1/lounge/session/messages`. */
  public async listMessages(req: LoungeAuthenticatedRequest, res: Response): Promise<void> {
    const traceHeader = extractTraceHeader(req);
    try {
      const { uid } = requireLoungeIdentity(req);
      const limit = normalizePaginationLimit(req.query['limit']);
      const startAfterId = parseStartAfterId(req.query['startAfterId']);
      const result = await this.sessionUseCase.listMessages(uid, limit, startAfterId);
      res.status(200).json(result);
    } catch (err) {
      handleLoungeControllerError(res, err, 'GET /session/messages', traceHeader);
    }
  }

  /** Handles `POST /api/v1/lounge/session/messages`. */
  public async sendMessage(req: LoungeAuthenticatedRequest, res: Response): Promise<void> {
    const traceHeader = extractTraceHeader(req);
    try {
      const identity = requireLoungeIdentity(req);
      const parsedBody = parseAndValidateSendMessageRequest(req.body);
      const result = await this.sessionUseCase.sendMessage(
        identity.uid,
        identity.xUserId,
        parsedBody,
      );
      res.status(201).json(result);
    } catch (err) {
      handleLoungeControllerError(res, err, 'POST /session/messages', traceHeader);
    }
  }
}
