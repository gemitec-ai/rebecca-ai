import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
  type Router,
} from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { Firestore } from '@google-cloud/firestore';
import { getCollections } from '@rebecca/db';
import { getActivePersona } from '@rebecca/persona';
import {
  CURRENT_LOUNGE_DISCLAIMER_VERSION,
  type LoungeEmotionState,
  type LoungeFirebaseWebConfig,
  type LoungePersonaBranding,
  type LoungeRuntimeConfigDto,
} from '@rebecca/types';
import {
  loadLoungeRuntimeConfig,
  type LoungeRuntimeEnvironmentConfig,
} from './config/loungeConfig';
import {
  createLoungeAuthMiddleware,
  type ILoungeAuthVerifierPort,
} from './middleware/loungeAuth';
import { createLoungeBatchAuthMiddleware } from './middleware/loungeBatchAuth';
import {
  FirebaseLoungeAuthVerifier,
  resolveFirebaseLoungeAuthClient,
} from './features/auth/adapters/firebaseLoungeAuth.verifier';
import { LoungeAuthController } from './features/auth/controllers/loungeAuth.controller';
import { createLoungeAuthRouter } from './features/auth/routers/loungeAuth.router';
import {
  LoungeAuthRepository,
  type ILoungeAuthRepository,
} from './features/auth/repositories/loungeAuth.repository';
import {
  LoungeAuthUseCase,
  type ILoungeAuthUseCase,
} from './features/auth/usecases/loungeAuth.usecase';
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
import {
  FirestoreBotImageVectorSearchAdapter,
  FirestorePublicXMemoryReadAdapter,
  GeminiLoungeAiAdapter,
  LocalEmulatorLoungeAiAdapter,
} from './features/sessions/adapters/geminiLoungeAi.adapters';
import type {
  IBotImageAssetSearchPort,
  ILoungeChatPipelinePort,
  ILoungeEmbeddingPort,
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
import { LoungeGalleryController } from './features/gallery/controllers/loungeGallery.controller';
import { createLoungeGalleryRouter } from './features/gallery/routers/loungeGallery.router';
import {
  LoungeGalleryRepository,
  type ILoungeGalleryRepository,
} from './features/gallery/repositories/loungeGallery.repository';
import {
  LoungeGalleryUseCase,
  type ILoungeGalleryUseCase,
} from './features/gallery/usecases/loungeGallery.usecase';
import {
  LocalTestStripeGatewayAdapter,
  type ILoungeStripeGatewayPort,
} from './features/billing/ports/loungeStripe.port';
import { StripeSdkGatewayAdapter } from './features/billing/adapters/stripeSdkGateway.adapter';
import { LoungeBillingController } from './features/billing/controllers/loungeBilling.controller';
import { createLoungeBillingRouter } from './features/billing/routers/loungeBilling.router';
import {
  LoungeBillingUseCase,
  type ILoungeBillingUseCase,
} from './features/billing/usecases/loungeBilling.usecase';
import {
  FirestoreLoungeDreamingStore,
  LoungeDreamingBatchService,
  createLoungeBatchRouter,
} from './features/dreaming/loungeDreaming.service';
import { extractTraceHeader } from './utils/errors';
import { loungeLogger, sanitizeLogInput } from './utils/logger';

/**
 * Default emotion-to-avatar mapping resolved dynamically for the active persona.
 */
export function buildDefaultEmotionAvatarPaths(): Record<LoungeEmotionState, string> {
  return {
    NEUTRAL: 'assets/avatars/persona_neutral.png',
    HAPPY: 'assets/avatars/persona_happy.png',
    TEASING: 'assets/avatars/persona_teasing.png',
    SHY: 'assets/avatars/persona_shy.png',
    EXCITED: 'assets/avatars/persona_excited.png',
    THOUGHTFUL: 'assets/avatars/persona_thoughtful.png',
    SURPRISED: 'assets/avatars/persona_surprised.png',
  };
}

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
 * Resolves the active positive integer disclaimer version from `DISCLAIMER_VERSION` env var,
 * falling back cleanly to `CURRENT_LOUNGE_DISCLAIMER_VERSION`.
 */
export function resolveDisclaimerVersion(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['DISCLAIMER_VERSION']?.trim();
  if (!raw) {
    return CURRENT_LOUNGE_DISCLAIMER_VERSION;
  }
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed >= 1) {
    return parsed;
  }
  return CURRENT_LOUNGE_DISCLAIMER_VERSION;
}

/**
 * Dependency injection container for wiring the Private Lounge BFF Express application.
 */
export interface LoungeAppDependencies {
  readonly authVerifier: ILoungeAuthVerifierPort;
  readonly authUseCase: ILoungeAuthUseCase;
  readonly accountUseCase: ILoungeAccountUseCase;
  readonly sessionUseCase: ILoungeSessionUseCase;
  readonly galleryUseCase: ILoungeGalleryUseCase;
  readonly billingUseCase?: ILoungeBillingUseCase;
  readonly batchRouter?: Router;
  readonly allowedOrigins: readonly string[];
  readonly appVersion: string;
  readonly disclaimerVersion: number;
  readonly personaBranding: LoungePersonaBranding;
  readonly defaultGeoCountryCode?: string;
  readonly firebaseWebConfig?: LoungeFirebaseWebConfig;
  readonly phase2EeaEnabled?: boolean;
  readonly noAuth?: boolean;
  readonly nodeEnv?: string;
  readonly authEmulatorHost?: string;
  readonly useEmulators?: boolean;
}

function createFailClosedProductionStripeGateway(): ILoungeStripeGatewayPort {
  const fail = (): never => {
    throw new Error('STRIPE_SECRET_KEY must be configured in production');
  };
  return {
    ensureCustomer: fail,
    createCheckoutSession: fail,
    retrieveCheckoutSession: fail,
    createPortalSession: fail,
    retrieveSubscription: fail,
    listCharges: fail,
    retrieveCharge: fail,
    resolveInvoiceByPaymentIntent: fail,
    createFullRefund: fail,
    cancelSubscriptionImmediately: fail,
    cancelAndDeleteCustomer: fail,
    constructWebhookEvent: fail,
  };
}

function createFailClosedProductionAiAdapter() {
  const fail = (): never => {
    throw new Error('GEMINI_API_KEY must be configured in production');
  };
  return {
    embedQuery: fail,
    classifyEmotion: fail,
    generateReply: fail,
    generateDreaming: fail,
  };
}

/**
 * Instantiates full production/emulator dependencies backed by Firestore (`10 lounge_* collections`),
 * Firebase Auth, Gemini Flash-Lite + Gemini 3 `search_web`, Stripe SDK `^23.2.0` (test-key enforced outside prod),
 * and `@rebecca/memory` Nightly Batch Dreaming.
 */
export function createProductionLoungeDependencies(
  env: NodeJS.ProcessEnv = process.env,
  overrides: {
    readonly config?: LoungeRuntimeEnvironmentConfig;
    readonly firestore?: Firestore;
    readonly stripeGateway?: ILoungeStripeGatewayPort;
    readonly authVerifier?: ILoungeAuthVerifierPort;
  } = {},
): LoungeAppDependencies {
  const appVersion = resolveLoungeAppVersion(env);
  const disclaimerVersion = resolveDisclaimerVersion(env);
  const config =
    overrides.config ?? loadLoungeRuntimeConfig(env, appVersion, disclaimerVersion);

  const firestore =
    overrides.firestore ??
    new Firestore(config.projectId ? { projectId: config.projectId } : undefined);
  const collections = getCollections(firestore);

  const activePersona = getActivePersona(config.activePersonaId);
  const personaBranding: LoungePersonaBranding = {
    displayName: activePersona.metadata.displayName,
    englishName: activePersona.metadata.englishName,
    brandName: activePersona.metadata.brandName,
    avatarPath: 'assets/persona_cutout.webp',
    chatIconPath: 'assets/avatars/persona_icon.png',
    emotionAvatarPaths: buildDefaultEmotionAvatarPaths(),
  };

  const useEmulators = Boolean(config.authEmulatorHost || config.firestoreEmulatorHost);
  const firebaseAuthClient = resolveFirebaseLoungeAuthClient(
    config.projectId,
    config.firebaseTenantId,
  );
  const authVerifier: ILoungeAuthVerifierPort =
    overrides.authVerifier ??
    new FirebaseLoungeAuthVerifier(firebaseAuthClient, Boolean(config.authEmulatorHost));

  const aiAdapter = config.geminiApiKey
    ? new GeminiLoungeAiAdapter({
        apiKey: config.geminiApiKey,
        chatModel: config.geminiChatModel,
        searchModel: config.geminiSearchModel,
        embeddingModel: config.geminiEmbeddingModel,
        maxOutputTokens: config.geminiMaxOutputTokens,
        activePersonaId: config.activePersonaId,
      })
    : config.isProd
      ? createFailClosedProductionAiAdapter()
      : new LocalEmulatorLoungeAiAdapter();

  const embeddingPort: ILoungeEmbeddingPort = aiAdapter;
  const emotionClassifier: ILoungeEmotionClassifierPort = aiAdapter;
  const chatPipeline: ILoungeChatPipelinePort = aiAdapter;

  const publicXMemoryPort: IPublicXMemoryReadPort = new FirestorePublicXMemoryReadAdapter(
    firestore,
    collections,
    Boolean(config.firestoreEmulatorHost),
  );
  const botImageSearchPort: IBotImageAssetSearchPort = new FirestoreBotImageVectorSearchAdapter(
    firestore,
    collections,
    embeddingPort,
    config.imageSimilarityThreshold,
    Boolean(config.firestoreEmulatorHost),
  );

  const stripeGateway: ILoungeStripeGatewayPort =
    overrides.stripeGateway ??
    (config.stripeSecretKey
      ? new StripeSdkGatewayAdapter(config.stripeSecretKey)
      : config.isProd
        ? createFailClosedProductionStripeGateway()
        : new LocalTestStripeGatewayAdapter(config.loungePublicOrigin));

  const authRepository: ILoungeAuthRepository = new LoungeAuthRepository(
    firestore,
    collections,
    config.trialHmacKeyring,
    firebaseAuthClient,
  );
  const accountRepository: ILoungeAccountRepository = new LoungeAccountRepository(
    firestore,
    collections,
  );
  const sessionRepository: ILoungeSessionRepository = new LoungeSessionRepository(
    firestore,
    collections,
    Boolean(config.firestoreEmulatorHost),
  );
  const galleryRepository: ILoungeGalleryRepository = new LoungeGalleryRepository(
    firestore,
    collections,
  );

  const billingUseCase = new LoungeBillingUseCase(
    firestore,
    collections,
    stripeGateway,
    config,
  );

  const dreamingStore = new FirestoreLoungeDreamingStore(firestore, collections);
  const dreamingService = new LoungeDreamingBatchService(
    dreamingStore,
    aiAdapter,
    config.activePersonaId,
    config.isProd ? 4500 : 0,
  );
  const batchAuth = createLoungeBatchAuthMiddleware({
    nodeEnv: config.nodeEnv,
    batchSecretKey: config.batchSecretKey,
  });

  return {
    authVerifier,
    authUseCase: new LoungeAuthUseCase(
      authRepository,
      authVerifier,
      config.appVersion,
      config.disclaimerVersion,
      config.globalDailySignupCap,
    ),
    accountUseCase: new LoungeAccountUseCase(
      authRepository,
      accountRepository,
      galleryRepository,
      sessionRepository,
      config.appVersion,
      personaBranding,
      config.disclaimerVersion,
      stripeGateway,
    ),
    sessionUseCase: new LoungeSessionUseCase(
      sessionRepository,
      authRepository,
      accountRepository,
      galleryRepository,
      embeddingPort,
      publicXMemoryPort,
      emotionClassifier,
      chatPipeline,
      botImageSearchPort,
      config.disclaimerVersion,
      config.globalDailyTurnCap,
    ),
    galleryUseCase: new LoungeGalleryUseCase(galleryRepository, authRepository),
    billingUseCase,
    batchRouter: createLoungeBatchRouter(dreamingService, batchAuth),
    allowedOrigins: config.corsAllowedOrigins,
    appVersion: config.appVersion,
    disclaimerVersion: config.disclaimerVersion,
    personaBranding,
    defaultGeoCountryCode: config.defaultGeoCountryCode,
    firebaseWebConfig: config.firebaseWebConfig,
    phase2EeaEnabled: config.phase2EeaEnabled,
    noAuth: config.noAuth,
    nodeEnv: config.nodeEnv,
    authEmulatorHost: config.authEmulatorHost,
    useEmulators,
  };
}

/**
 * Constructs a configured Express 5 BFF application for `/api/v1/lounge/*`.
 * Mounts Stripe webhooks using `express.raw` BEFORE `express.json()` and global rate limiting.
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
  // Prevent browser or proxy caching on all /api/v1/lounge/* responses including early parser/rate-limit rejections.
  app.use('/api/v1/lounge', (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const billingController = deps.billingUseCase
    ? new LoungeBillingController(deps.billingUseCase, deps.defaultGeoCountryCode ?? 'JP')
    : null;

  // CRITICAL: Stripe webhooks require unparsed raw body bytes BEFORE express.json() and global IP rate limiting.
  if (billingController) {
    app.post(
      '/api/v1/lounge/webhooks/stripe',
      express.raw({ type: 'application/json', limit: '256kb' }),
      (req: Request, res: Response) => billingController.handleWebhook(req, res),
    );
  }

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
      ...(deps.firebaseWebConfig ? { firebase: deps.firebaseWebConfig } : {}),
      ...(deps.useEmulators !== undefined ? { useEmulators: deps.useEmulators } : {}),
      ...(deps.nodeEnv !== undefined ? { production: deps.nodeEnv === 'production' } : {}),
      ...(deps.phase2EeaEnabled !== undefined
        ? { phase2EeaEnabled: deps.phase2EeaEnabled }
        : {}),
    };
    res.status(200).json(configPayload);
  });

  const authController = new LoungeAuthController(
    deps.authUseCase,
    deps.defaultGeoCountryCode ?? 'JP',
  );
  const accountController = new LoungeAccountController(deps.accountUseCase);
  const sessionController = new LoungeSessionController(deps.sessionUseCase);
  const galleryController = new LoungeGalleryController(deps.galleryUseCase);

  app.use('/api/v1/lounge/auth', createLoungeAuthRouter(authController, requireAuth));
  app.use('/api/v1/lounge/account', createLoungeAccountRouter(accountController, requireAuth));
  app.use('/api/v1/lounge/session', createLoungeSessionRouter(sessionController, requireAuth));
  app.use('/api/v1/lounge/gallery', createLoungeGalleryRouter(galleryController, requireAuth));

  if (billingController) {
    app.use('/api/v1/lounge/billing', createLoungeBillingRouter(billingController, requireAuth));
  }
  if (deps.batchRouter) {
    app.use('/api/v1/lounge/batch', deps.batchRouter);
  }

  // Express error boundary catching malformed JSON / oversized payloads and unexpected middleware failures
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const traceHeader = extractTraceHeader(req);
    const bodyErrType =
      typeof err === 'object' && err !== null && 'type' in err
        ? (err as { type?: unknown }).type
        : undefined;
    const bodyErrStatus =
      typeof err === 'object' && err !== null && 'status' in err
        ? (err as { status?: unknown }).status
        : undefined;
    if (err instanceof SyntaxError && bodyErrType === 'entity.parse.failed') {
      loungeLogger.warn(
        'Rejected malformed JSON payload',
        { path: sanitizeLogInput(req.path) },
        traceHeader,
      );
      res.status(400).json({ error: 'Malformed JSON request body' });
      return;
    }
    if (bodyErrType === 'entity.too.large' || bodyErrStatus === 413) {
      loungeLogger.warn(
        'Rejected oversized request payload',
        { path: sanitizeLogInput(req.path) },
        traceHeader,
      );
      res.status(413).json({ error: 'Request payload too large' });
      return;
    }
    const normalized =
      err instanceof Error ? err : new Error('Unhandled Express middleware failure', { cause: err });
    loungeLogger.error(
      'Unhandled Express middleware error',
      normalized,
      { path: sanitizeLogInput(req.path) },
      traceHeader,
    );
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
