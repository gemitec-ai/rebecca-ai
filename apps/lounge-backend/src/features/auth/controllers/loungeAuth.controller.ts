import type { Request, Response } from 'express';
import {
  requireLoungeIdentity,
  type LoungeAuthenticatedRequest,
} from '../../../middleware/loungeAuth';
import {
  DEFAULT_TRUSTED_GEO_HEADER,
  resolveClientGeo,
  type TrustedGeoHeaderName,
} from '../../../utils/clientGeo';
import { extractTraceHeader, handleLoungeControllerError } from '../../../utils/errors';
import type { ILoungeAuthUseCase } from '../usecases/loungeAuth.usecase';
import {
  parseAndValidateLoginRequest,
  parseAndValidateSignUpRequest,
} from '../validators/loungeAuth.validator';

/**
 * HTTP controller handling `/api/v1/lounge/auth/*` endpoints.
 */
export class LoungeAuthController {
  constructor(
    private readonly authUseCase: ILoungeAuthUseCase,
    private readonly defaultGeoCountryCode: string = 'JP',
    private readonly trustedGeoHeader: TrustedGeoHeaderName = DEFAULT_TRUSTED_GEO_HEADER,
  ) {}

  /** Handles `POST /api/v1/lounge/auth/signup`. */
  public async signUp(req: Request, res: Response): Promise<void> {
    const traceHeader = extractTraceHeader(req);
    try {
      const payload = parseAndValidateSignUpRequest(req.body);
      const clientGeo = resolveClientGeo(req.headers as Readonly<Record<string, unknown>>, {
        trustedGeoHeader: this.trustedGeoHeader,
        defaultCountryCode: this.defaultGeoCountryCode,
      });
      const session = await this.authUseCase.signUpWithX(payload, clientGeo, traceHeader);
      res.status(201).json(session);
    } catch (err) {
      handleLoungeControllerError(res, err, 'POST /auth/signup', traceHeader);
    }
  }

  /** Handles `POST /api/v1/lounge/auth/login`. */
  public async login(req: Request, res: Response): Promise<void> {
    const traceHeader = extractTraceHeader(req);
    try {
      const payload = parseAndValidateLoginRequest(req.body);
      const clientGeo = resolveClientGeo(req.headers as Readonly<Record<string, unknown>>, {
        trustedGeoHeader: this.trustedGeoHeader,
        defaultCountryCode: this.defaultGeoCountryCode,
      });
      const session = await this.authUseCase.loginWithX(payload, clientGeo, traceHeader);
      res.status(200).json(session);
    } catch (err) {
      handleLoungeControllerError(res, err, 'POST /auth/login', traceHeader);
    }
  }

  /** Handles `POST /api/v1/lounge/auth/logout`. */
  public async logout(req: LoungeAuthenticatedRequest, res: Response): Promise<void> {
    const traceHeader = extractTraceHeader(req);
    try {
      const { uid } = requireLoungeIdentity(req);
      await this.authUseCase.logout(uid, traceHeader);
      res.status(204).send();
    } catch (err) {
      handleLoungeControllerError(res, err, 'POST /auth/logout', traceHeader);
    }
  }
}
