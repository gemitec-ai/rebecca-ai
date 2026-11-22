import type { Request, Response } from 'express';
import {
  requireLoungeIdentity,
  type LoungeAuthenticatedRequest,
} from '../../../middleware/loungeAuth';
import { extractTraceHeader, handleLoungeControllerError } from '../../../utils/errors';
import {
  parseAndValidateLoginRequest,
  parseAndValidateSignUpRequest,
  type ILoungeAuthUseCase,
} from '../usecases/loungeAuth.usecase';

/**
 * HTTP controller handling `/api/v1/lounge/auth/*` endpoints.
 */
export class LoungeAuthController {
  constructor(private readonly authUseCase: ILoungeAuthUseCase) {}

  /** Handles `POST /api/v1/lounge/auth/signup`. */
  public async signUp(req: Request, res: Response): Promise<void> {
    const traceHeader = extractTraceHeader(req);
    try {
      const payload = parseAndValidateSignUpRequest(req.body);
      const session = await this.authUseCase.signUpWithX(payload);
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
      const session = await this.authUseCase.loginWithX(payload);
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
      await this.authUseCase.logout(uid);
      res.status(204).send();
    } catch (err) {
      handleLoungeControllerError(res, err, 'POST /auth/logout', traceHeader);
    }
  }
}
