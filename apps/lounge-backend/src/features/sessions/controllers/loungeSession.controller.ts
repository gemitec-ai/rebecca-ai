import type { Response } from 'express';
import type {
  LoungeCreateSessionRequestDto,
  LoungeSendMessageRequestDto,
} from '@rebecca/types';
import {
  requireLoungeIdentity,
  type LoungeAuthenticatedRequest,
} from '../../../middleware/loungeAuth';
import {
  LoungeValidationError,
  extractTraceHeader,
  handleLoungeControllerError,
  normalizePaginationLimit,
  parseStartAfterId,
} from '../../../utils/errors';
import type { ILoungeSessionUseCase } from '../usecases/loungeSession.usecase';

/**
 * HTTP controller handling `/api/v1/lounge/sessions/*` endpoints.
 */
export class LoungeSessionController {
  constructor(private readonly sessionUseCase: ILoungeSessionUseCase) {}

  /** Handles `GET /api/v1/lounge/sessions`. */
  public async listSessions(req: LoungeAuthenticatedRequest, res: Response): Promise<void> {
    const traceHeader = extractTraceHeader(req);
    try {
      const { uid } = requireLoungeIdentity(req);
      const limit = normalizePaginationLimit(req.query['limit']);
      const startAfterId = parseStartAfterId(req.query['startAfterId']);
      const result = await this.sessionUseCase.listSessions(uid, limit, startAfterId);
      res.status(200).json(result);
    } catch (err) {
      handleLoungeControllerError(res, err, 'GET /sessions', traceHeader);
    }
  }

  /** Handles `POST /api/v1/lounge/sessions`. */
  public async createSession(req: LoungeAuthenticatedRequest, res: Response): Promise<void> {
    const traceHeader = extractTraceHeader(req);
    try {
      const identity = requireLoungeIdentity(req);
      const body = (req.body ?? {}) as Partial<LoungeCreateSessionRequestDto>;
      const session = await this.sessionUseCase.createSession(identity.uid, identity.xUserId, {
        title: typeof body.title === 'string' ? body.title : undefined,
      });
      res.status(201).json(session);
    } catch (err) {
      handleLoungeControllerError(res, err, 'POST /sessions', traceHeader);
    }
  }

  /** Handles `GET /api/v1/lounge/sessions/:sessionId/messages`. */
  public async listMessages(req: LoungeAuthenticatedRequest, res: Response): Promise<void> {
    const traceHeader = extractTraceHeader(req);
    try {
      const { uid } = requireLoungeIdentity(req);
      const rawSessionId = req.params['sessionId'];
      const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
      if (!sessionId) {
        throw new LoungeValidationError('Route parameter "sessionId" is required');
      }
      const limit = normalizePaginationLimit(req.query['limit']);
      const startAfterId = parseStartAfterId(req.query['startAfterId']);
      const result = await this.sessionUseCase.listMessages(uid, sessionId, limit, startAfterId);
      res.status(200).json(result);
    } catch (err) {
      handleLoungeControllerError(res, err, 'GET /sessions/:sessionId/messages', traceHeader);
    }
  }

  /** Handles `POST /api/v1/lounge/sessions/:sessionId/messages`. */
  public async sendMessage(req: LoungeAuthenticatedRequest, res: Response): Promise<void> {
    const traceHeader = extractTraceHeader(req);
    try {
      const identity = requireLoungeIdentity(req);
      const rawSessionId = req.params['sessionId'];
      const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
      if (!sessionId) {
        throw new LoungeValidationError('Route parameter "sessionId" is required');
      }
      const body = req.body as Partial<LoungeSendMessageRequestDto> | undefined;
      if (!body || typeof body.content !== 'string') {
        throw new LoungeValidationError('Field "content" must be a string');
      }
      const result = await this.sessionUseCase.sendMessage(
        identity.uid,
        identity.xUserId,
        sessionId,
        { content: body.content },
      );
      res.status(201).json(result);
    } catch (err) {
      handleLoungeControllerError(res, err, 'POST /sessions/:sessionId/messages', traceHeader);
    }
  }
}
