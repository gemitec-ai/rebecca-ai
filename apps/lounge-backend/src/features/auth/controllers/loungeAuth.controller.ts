import type { Request, Response } from 'express';
import type { LoungeLoginRequestDto, LoungeSignUpRequestDto } from '@rebecca/types';
import {
  requireLoungeIdentity,
  type LoungeAuthenticatedRequest,
} from '../../../middleware/loungeAuth';
import {
  LoungeValidationError,
  extractTraceHeader,
  handleLoungeControllerError,
} from '../../../utils/errors';
import {
  parseAndValidateSignUpConsent,
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
      const body = req.body as Partial<LoungeSignUpRequestDto> | undefined;
      if (!body || typeof body.idToken !== 'string' || typeof body.xOAuthCode !== 'string') {
        throw new LoungeValidationError('Invalid sign-up request payload');
      }
      const disclaimerConsent = parseAndValidateSignUpConsent(body.disclaimerConsent);
      const session = await this.authUseCase.signUpWithX({
        idToken: body.idToken,
        xOAuthCode: body.xOAuthCode,
        disclaimerConsent,
      });
      res.status(201).json(session);
    } catch (err) {
      handleLoungeControllerError(res, err, 'POST /auth/signup', traceHeader);
    }
  }

  /** Handles `POST /api/v1/lounge/auth/login`. */
  public async login(req: Request, res: Response): Promise<void> {
    const traceHeader = extractTraceHeader(req);
    try {
      const body = req.body as Partial<LoungeLoginRequestDto> | undefined;
      if (!body || typeof body.idToken !== 'string') {
        throw new LoungeValidationError('Invalid login request payload');
      }
      const session = await this.authUseCase.loginWithX({
        idToken: body.idToken,
        xOAuthCode: typeof body.xOAuthCode === 'string' ? body.xOAuthCode : undefined,
      });
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
