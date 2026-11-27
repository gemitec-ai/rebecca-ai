import type { Response } from 'express';
import {
  requireLoungeIdentity,
  type LoungeAuthenticatedRequest,
} from '../../../middleware/loungeAuth';
import {
  DEFAULT_TRUSTED_GEO_HEADER,
  resolveClientGeo,
  type TrustedGeoHeaderName,
} from '../../../utils/clientGeo';
import {
  extractTraceHeader,
  handleLoungeControllerError,
  normalizePaginationQuery,
} from '../../../utils/errors';
import type { ILoungeSessionUseCase } from '../usecases/loungeSession.usecase';
import { parseAndValidateSendMessageRequest } from '../validators/loungeSession.validator';

/**
 * HTTP controller handling `/api/v1/lounge/session` and `/api/v1/lounge/session/messages`.
 */
export class LoungeSessionController {
  constructor(
    private readonly sessionUseCase: ILoungeSessionUseCase,
    private readonly defaultGeoCountryCode: string = 'JP',
    private readonly trustedGeoHeader: TrustedGeoHeaderName = DEFAULT_TRUSTED_GEO_HEADER,
  ) {}

  /** Handles `GET /api/v1/lounge/session`. */
  public async getSession(req: LoungeAuthenticatedRequest, res: Response): Promise<void> {
    const traceHeader = extractTraceHeader(req);
    try {
      const identity = requireLoungeIdentity(req);
      const clientGeo = resolveClientGeo(req.headers as Readonly<Record<string, unknown>>, {
        trustedGeoHeader: this.trustedGeoHeader,
        defaultCountryCode: this.defaultGeoCountryCode,
      });
      const session = await this.sessionUseCase.getSession(
        identity.uid,
        identity.xUserId,
        clientGeo,
        traceHeader,
      );
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
      const clientGeo = resolveClientGeo(req.headers as Readonly<Record<string, unknown>>, {
        trustedGeoHeader: this.trustedGeoHeader,
        defaultCountryCode: this.defaultGeoCountryCode,
      });
      const query = normalizePaginationQuery({
        page: req.query['page'],
        limit: req.query['limit'],
        cursor: req.query['cursor'],
      });
      const result = await this.sessionUseCase.listMessages(uid, query, clientGeo);
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
      const clientGeo = resolveClientGeo(req.headers as Readonly<Record<string, unknown>>, {
        trustedGeoHeader: this.trustedGeoHeader,
        defaultCountryCode: this.defaultGeoCountryCode,
      });
      const result = await this.sessionUseCase.sendMessage(
        identity.uid,
        identity.xUserId,
        parsedBody,
        clientGeo,
        traceHeader,
      );
      res.status(201).json(result);
    } catch (err) {
      handleLoungeControllerError(res, err, 'POST /session/messages', traceHeader);
    }
  }
}
