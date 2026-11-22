import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { Firestore } from '@google-cloud/firestore';
import { getCollections } from '@rebecca/db';
import { getActivePersona } from '@rebecca/persona';
import type { LoungePersonaBranding, LoungeRuntimeConfigDto } from '@rebecca/types';
import {
  createLoungeAuthMiddleware,
  type ILoungeAuthVerifierPort,
} from './middleware/loungeAuth';
import { LoungeAuthController } from './features/auth/controllers/loungeAuth.controller';
import { createLoungeAuthRouter } from './features/auth/routers/loungeAuth.router';
import {
  LoungeAuthRepository,
  type ILoungeAuthRepository,
} from './features/auth/repositories/loungeAuth.repository';
import { LoungeAuthUseCase, type ILoungeAuthUseCase } from './features/auth/usecases/loungeAuth.usecase';
import { LoungeAccountController } from './features/account/controllers/loungeAccount.controller';
import { createLoungeAccountRouter } from './features/account/routers/loungeAccount.router';
import {
  LoungeAccountRepository,
  type ILoungeAccountRepository,
} from './features/account/repositories/loungeAccount.repository';
import {
  LoungeAccountUseCase,
  type ILoungeAccountUseCase,
} from './features/account/usecases/loungeAccount.usecase';
import type {
  ILoungeChatPipelinePort,
  ILoungeEmotionClassifierPort,
  IPublicXMemoryReadPort,
} from './features/sessions/ports/loungeAi.port';
import { LoungeSessionController } from './features/sessions/controllers/loungeSession.controller';
import { createLoungeSessionRouter } from './features/sessions/routers/loungeSession.router';
import {
  LoungeSessionRepository,
  type ILoungeSessionRepository,
} from './features/sessions/repositories/loungeSession.repository';
import {
  LoungeSessionUseCase,
  type ILoungeSessionUseCase,
} from './features/sessions/usecases/loungeSession.usecase';
import { LoungeRewardController } from './features/rewards/controllers/loungeReward.controller';
import { createLoungeRewardRouter } from './features/rewards/routers/loungeReward.router';
import {
  LoungeRewardRepository,
  type ILoungeRewardRepository,
} from './features/rewards/repositories/loungeReward.repository';
import {
  LoungeRewardUseCase,
  type ILoungeRewardUseCase,
} from './features/rewards/usecases/loungeReward.usecase';
import { LoungeNotImplementedError, extractTraceHeader } from './utils/errors';
import { loungeLogger, sanitizeLogInput } from './utils/logger';

/**
 * Resolves package version string dynamically from environment or workspace `package.json`.
 */
export function resolveLoungeAppVersion(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['APP_VERSION']?.trim();
  if (configured) {
    return configured.startsWith('v') ? configured : `v${configured}`;
  }
  try {
    const pkgPath = path.resolve(__dirname, '..', 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.trim()) {
      return `v${parsed.version.trim()}`;
    }
  } catch {
    // Fallback below if running from bundled path without adjacent package.json
  }
  const npmVer = env['npm_package_version']?.trim();
  return npmVer ? `v${npmVer}` : 'v0.0.0';
}

/**
 * Dependency injection container for wiring the Private Lounge BFF Express application.
 */
export interface LoungeAppDependencies {
  readonly authVerifier: ILoungeAuthVerifierPort;
  readonly authUseCase: ILoungeAuthUseCase;
  readonly accountUseCase: ILoungeAccountUseCase;
  readonly sessionUseCase: ILoungeSessionUseCase;
  readonly rewardUseCase: ILoungeRewardUseCase;
  readonly allowedOrigins: readonly string[];
  readonly appVersion: string;
  readonly disclaimerVersion: string;
  readonly personaBranding: LoungePersonaBranding;
  readonly noAuth?: boolean;
  readonly nodeEnv?: string;
  readonly authEmulatorHost?: string;
}

/**
 * Default runtime skeleton dependencies backed by `@rebecca/db`, `@rebecca/persona`,
 * and stubbed AI/auth ports.
 */
export function createSkeletonLoungeDependencies(
  env: NodeJS.ProcessEnv = process.env,
): LoungeAppDependencies {
  const nodeEnv = env['NODE_ENV'];
  const projectId =
    env['GCP_PROJECT_ID']?.trim() ||
    env['GOOGLE_CLOUD_PROJECT']?.trim() ||
    (nodeEnv === 'production' ? undefined : 'demo-rebecca-lounge');
  const firestore = new Firestore(projectId ? { projectId } : undefined);
  const collections = getCollections(firestore);
  const appVersion = resolveLoungeAppVersion(env);
  const disclaimerVersion = env['DISCLAIMER_VERSION']?.trim() || '2026-11-22';

  const activePersona = getActivePersona(env['ACTIVE_PERSONA_ID']);
  const personaBranding: LoungePersonaBranding = {
    displayName: activePersona.metadata.displayName,
    englishName: activePersona.metadata.englishName,
    brandName: activePersona.metadata.brandName,
    avatarPath: 'assets/persona_cutout.webp',
  };

  const configuredOrigins = env['CORS_ALLOWED_ORIGINS']?.trim();
  const allowedOrigins = configuredOrigins
    ? configuredOrigins
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0)
    : nodeEnv === 'production'
      ? []
      : ['http://localhost:4300', 'http://127.0.0.1:4300'];

  const authVerifier: ILoungeAuthVerifierPort = {
    async verifyBearerToken(): Promise<never> {
      throw new LoungeNotImplementedError('ILoungeAuthVerifierPort.verifyBearerToken');
    },
  };
  const publicXMemoryPort: IPublicXMemoryReadPort = {
    async readPublicXUserSnapshot(): Promise<never> {
      throw new LoungeNotImplementedError('IPublicXMemoryReadPort.readPublicXUserSnapshot');
    },
  };
  const emotionClassifier: ILoungeEmotionClassifierPort = {
    async classifyEmotion(): Promise<never> {
      throw new LoungeNotImplementedError('ILoungeEmotionClassifierPort.classifyEmotion');
    },
  };
  const chatPipeline: ILoungeChatPipelinePort = {
    async generateReply(): Promise<never> {
      throw new LoungeNotImplementedError('ILoungeChatPipelinePort.generateReply');
    },
  };

  const authRepository: ILoungeAuthRepository = new LoungeAuthRepository(collections);
  const accountRepository: ILoungeAccountRepository = new LoungeAccountRepository(collections);
  const sessionRepository: ILoungeSessionRepository = new LoungeSessionRepository(collections);
  const rewardRepository: ILoungeRewardRepository = new LoungeRewardRepository(collections);

  return {
    authVerifier,
    authUseCase: new LoungeAuthUseCase(authRepository, authVerifier, appVersion),
    accountUseCase: new LoungeAccountUseCase(
      authRepository,
      accountRepository,
      rewardRepository,
      appVersion,
      personaBranding,
    ),
    sessionUseCase: new LoungeSessionUseCase(
      sessionRepository,
      authRepository,
      accountRepository,
      rewardRepository,
      publicXMemoryPort,
      emotionClassifier,
      chatPipeline,
    ),
    rewardUseCase: new LoungeRewardUseCase(rewardRepository),
    allowedOrigins,
    appVersion,
    disclaimerVersion,
    personaBranding,
    noAuth: env['NO_AUTH'] === 'true',
    nodeEnv,
    authEmulatorHost: env['FIREBASE_AUTH_EMULATOR_HOST'],
  };
}

/**
 * Constructs a configured Express 5 BFF application for `/api/v1/lounge/*`.
 */
export function createLoungeApp(deps: LoungeAppDependencies): Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(
    cors({
      origin: (requestOrigin, callback) => {
        if (!requestOrigin || deps.allowedOrigins.includes(requestOrigin)) {
          callback(null, true);
          return;
        }
        loungeLogger.warn('Rejected CORS request from disallowed origin', {
          origin: sanitizeLogInput(requestOrigin),
        });
        callback(null, false);
      },
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '256kb' }));
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      max: 120,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  const requireAuth = createLoungeAuthMiddleware({
    verifier: deps.authVerifier,
    noAuth: deps.noAuth,
    nodeEnv: deps.nodeEnv,
    authEmulatorHost: deps.authEmulatorHost,
  });

  app.get('/api/v1/lounge/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      service: 'lounge-backend',
      version: deps.appVersion,
    });
  });

  app.get('/api/v1/lounge/config', (_req: Request, res: Response) => {
    const configPayload: LoungeRuntimeConfigDto = {
      appVersion: deps.appVersion,
      disclaimerVersion: deps.disclaimerVersion,
      persona: deps.personaBranding,
    };
    res.status(200).json(configPayload);
  });

  const authController = new LoungeAuthController(deps.authUseCase);
  const accountController = new LoungeAccountController(deps.accountUseCase);
  const sessionController = new LoungeSessionController(deps.sessionUseCase);
  const rewardController = new LoungeRewardController(deps.rewardUseCase);

  app.use('/api/v1/lounge/auth', createLoungeAuthRouter(authController, requireAuth));
  app.use('/api/v1/lounge/account', createLoungeAccountRouter(accountController, requireAuth));
  app.use('/api/v1/lounge/sessions', createLoungeSessionRouter(sessionController, requireAuth));
  app.use('/api/v1/lounge/rewards', createLoungeRewardRouter(rewardController, requireAuth));

  // Express error boundary catching malformed JSON / oversized payloads and unexpected middleware failures
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const traceHeader = extractTraceHeader(req);
    const bodyErr = err as { type?: unknown; status?: unknown };
    if (err instanceof SyntaxError && bodyErr.type === 'entity.parse.failed') {
      loungeLogger.warn('Rejected malformed JSON payload', { path: sanitizeLogInput(req.path) }, traceHeader);
      res.status(400).json({ error: 'Malformed JSON request body' });
      return;
    }
    if (bodyErr.type === 'entity.too.large' || bodyErr.status === 413) {
      loungeLogger.warn('Rejected oversized request payload', { path: sanitizeLogInput(req.path) }, traceHeader);
      res.status(413).json({ error: 'Request payload too large' });
      return;
    }
    const normalized = err instanceof Error ? err : new Error('Unhandled Express middleware failure', { cause: err });
    loungeLogger.error('Unhandled Express middleware error', normalized, { path: sanitizeLogInput(req.path) }, traceHeader);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
