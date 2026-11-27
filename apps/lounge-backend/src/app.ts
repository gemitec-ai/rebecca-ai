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
import type {
  LoungeFirebaseWebConfig,
  LoungeLegalUrlsDto,
  LoungePersonaBranding,
  LoungeRuntimeConfigDto,
} from '@rebecca/types';
import {
  loadLoungeRuntimeConfig,
  type LoungeRuntimeEnvironmentConfig,
} from './config/loungeConfig';
import {
  createLoungeAuthMiddleware,
} from './middleware/loungeAuth';
import type { ILoungeAuthVerifierPort } from './features/auth/ports/loungeAuthVerifier.port';
import { createLoungeBatchAuthMiddleware } from './middleware/loungeBatchAuth';
import {
  createFirebaseIdentityClient,
  FirebaseLoungeAuthVerifier,
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
import { FirestoreBotImageVectorSearchAdapter } from './features/sessions/adapters/firestoreBotImageVectorSearch.adapter';
import { FirestorePublicXMemoryReadAdapter } from './features/sessions/adapters/firestorePublicXMemoryRead.adapter';
import { GeminiLoungeAiAdapter } from './features/sessions/adapters/geminiLoungeAi.adapters';
import { LocalEmulatorLoungeAiAdapter } from './features/sessions/adapters/localEmulatorLoungeAi.adapter';
import { LoungeIllustrationMatcherService } from './features/sessions/domain/loungeIllustrationMatcher.service';
import type {
  IBotImageAssetSearchPort,
  ILoungeChatPipelinePort,
  ILoungeEmbeddingPort,
  ILoungeEmotionClassifierPort,
  ILoungeImageMatcherPort,
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
import { DisabledLoungeStripeGatewayAdapter } from './features/billing/adapters/disabledLoungeStripeGateway.adapter';
import { LocalTestStripeGatewayAdapter } from './features/billing/adapters/localTestStripeGateway.adapter';
import type { ILoungeStripeGatewayPort } from './features/billing/ports/loungeStripe.port';
import { StripeSdkGatewayAdapter } from './features/billing/adapters/stripeSdkGateway.adapter';
import { LoungeBillingController } from './features/billing/controllers/loungeBilling.controller';
import { FirestoreLoungeBillingRepository } from './features/billing/repositories/loungeBilling.repository';
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
import {
  DEFAULT_TRUSTED_GEO_HEADER,
  type TrustedGeoHeaderName,
} from './utils/clientGeo';
import { extractTraceHeader } from './utils/errors';
import { loungeLogger, toSingleLineLog } from './utils/logger';

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
  readonly legalUrls?: LoungeLegalUrlsDto;
  readonly defaultGeoCountryCode?: string;
  readonly trustedGeoHeader?: TrustedGeoHeaderName;
  readonly firebaseWebConfig?: LoungeFirebaseWebConfig;
  readonly phase2EeaEnabled?: boolean;
  readonly allowDefaultGeoFallback?: boolean;
  readonly isCloudRun?: boolean;
  readonly noAuth?: boolean;
  readonly nodeEnv?: string;
  readonly authEmulatorHost?: string;
  readonly useEmulators?: boolean;
  readonly billingEnabled?: boolean;
  readonly contactEmail?: string | null;
}

/**
 * Instantiates full production/emulator dependencies backed by Firestore (`10 lounge_* collections`),
 * Firebase Auth, Gemini Flash-Lite + Gemini 3 `search_web`, Stripe SDK `^23.2.0` (test-key enforced outside prod),
 * and `@rebecca/memory` Nightly Batch Dreaming.
 */
export function createProductionLoungeDependencies(
  env: NodeJS.ProcessEnv = {},
  overrides: {
    readonly config?: LoungeRuntimeEnvironmentConfig;
    readonly firestore?: Firestore;
    readonly stripeGateway?: ILoungeStripeGatewayPort;
    readonly authVerifier?: ILoungeAuthVerifierPort;
  } = {},
): LoungeAppDependencies {
  const config = overrides.config ?? loadLoungeRuntimeConfig(env);

  const firestore =
    overrides.firestore ??
    new Firestore(config.projectId ? { projectId: config.projectId } : undefined);
  const collections = getCollections(firestore);

  const activePersona = getActivePersona(config.activePersonaId);
  const personaBranding: LoungePersonaBranding = {
    displayName: activePersona.metadata.displayName,
    englishName: activePersona.metadata.englishName,
    brandName: activePersona.metadata.lounge.brandName,
    avatarPath: activePersona.metadata.lounge.avatarPath,
    chatIconPath: activePersona.metadata.lounge.chatIconPath,
    emotionAvatarPaths: activePersona.metadata.lounge.emotionAvatarPaths,
  };

  const useEmulators = config.isLocalEmulatorMode && !config.isProd && !config.isCloudRun;
  const firebaseAuthClient = createFirebaseIdentityClient(
    config.projectId,
    config.firebaseTenantId,
  );
  const authVerifier: ILoungeAuthVerifierPort =
    overrides.authVerifier ??
    new FirebaseLoungeAuthVerifier(firebaseAuthClient, useEmulators);

  let aiAdapter: GeminiLoungeAiAdapter | LocalEmulatorLoungeAiAdapter;
  if (config.geminiApiKey) {
    aiAdapter = new GeminiLoungeAiAdapter({
      apiKey: config.geminiApiKey,
      chatModel: config.geminiChatModel,
      searchModel: config.geminiSearchModel,
      embeddingModel: config.geminiEmbeddingModel,
      maxOutputTokens: config.geminiMaxOutputTokens,
      activePersonaId: config.activePersonaId,
    });
  } else if (useEmulators) {
    aiAdapter = new LocalEmulatorLoungeAiAdapter();
  } else {
    throw new Error('GEMINI_API_KEY is required outside local emulator mode');
  }

  const embeddingPort: ILoungeEmbeddingPort = aiAdapter;
  const emotionClassifier: ILoungeEmotionClassifierPort = aiAdapter;
  const chatPipeline: ILoungeChatPipelinePort = aiAdapter;
  const imageMatcher: ILoungeImageMatcherPort = aiAdapter;

  const publicXMemoryPort: IPublicXMemoryReadPort = new FirestorePublicXMemoryReadAdapter(
    firestore,
    collections,
    useEmulators,
  );
  const botImageSearchPort: IBotImageAssetSearchPort = new FirestoreBotImageVectorSearchAdapter(
    firestore,
    collections,
    embeddingPort,
    config.imageSimilarityThreshold,
    useEmulators,
  );
  const illustrationMatcher = new LoungeIllustrationMatcherService(
    botImageSearchPort,
    imageMatcher,
  );

  let stripeGateway: ILoungeStripeGatewayPort;
  if (overrides.stripeGateway) {
    stripeGateway = overrides.stripeGateway;
  } else if (config.stripeSecretKey) {
    stripeGateway = new StripeSdkGatewayAdapter(config.stripeSecretKey);
  } else if (useEmulators) {
    stripeGateway = new LocalTestStripeGatewayAdapter(config.loungePublicOrigin);
  } else if (!config.billingEnabled) {
    stripeGateway = new DisabledLoungeStripeGatewayAdapter();
  } else {
    throw new Error('STRIPE_SECRET_KEY is required outside local emulator mode');
  }

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
    useEmulators,
  );
  const galleryRepository: ILoungeGalleryRepository = new LoungeGalleryRepository(
    firestore,
    collections,
  );

  const billingRepository = new FirestoreLoungeBillingRepository(firestore, collections);
  const billingUseCase = new LoungeBillingUseCase(
    billingRepository,
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
    isCloudRun: config.isCloudRun,
    batchSecretKey: config.batchSecretKey,
    expectedAudience: config.batchOidcAudience,
    expectedServiceAccountEmail: config.batchOidcServiceAccountEmail,
  });
  const geoPolicy = {
    phase2EeaEnabled: config.phase2EeaEnabled,
    allowDefaultGeoFallback: config.allowDefaultGeoFallback,
  };

  return {
    authVerifier,
    authUseCase: new LoungeAuthUseCase(
      authRepository,
      authVerifier,
      config.appVersion,
      config.disclaimerVersion,
      config.globalDailySignupCap,
      geoPolicy,
    ),
    accountUseCase: new LoungeAccountUseCase(
      authRepository,
      accountRepository,
      galleryRepository,
      sessionRepository,
      config.appVersion,
      stripeGateway,
      personaBranding,
      config.disclaimerVersion,
      config.phase2EeaEnabled,
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
      illustrationMatcher,
      config.disclaimerVersion,
      config.globalDailyTurnCap,
      geoPolicy,
    ),
    galleryUseCase: new LoungeGalleryUseCase(galleryRepository, authRepository),
    billingUseCase,
    batchRouter: createLoungeBatchRouter(dreamingService, batchAuth),
    allowedOrigins: config.corsAllowedOrigins,
    appVersion: config.appVersion,
    disclaimerVersion: config.disclaimerVersion,
    personaBranding,
    legalUrls: config.legalUrls,
    defaultGeoCountryCode: config.defaultGeoCountryCode,
    trustedGeoHeader: config.trustedGeoHeader,
    firebaseWebConfig: config.firebaseWebConfig,
    phase2EeaEnabled: config.phase2EeaEnabled,
    allowDefaultGeoFallback: config.allowDefaultGeoFallback,
    isCloudRun: config.isCloudRun,
    noAuth: config.noAuth,
    nodeEnv: config.nodeEnv,
    authEmulatorHost: config.authEmulatorHost,
    useEmulators,
    billingEnabled: config.billingEnabled,
    contactEmail: config.contactEmail,
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
          origin: toSingleLineLog(requestOrigin),
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

  const trustedGeoHeader = deps.trustedGeoHeader ?? DEFAULT_TRUSTED_GEO_HEADER;
  const billingController = deps.billingUseCase
    ? new LoungeBillingController(
        deps.billingUseCase,
        deps.defaultGeoCountryCode ?? 'JP',
        trustedGeoHeader,
      )
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
      windowMs: 15 * 60 * 1000,
      max: 1500,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  const requireAuth = createLoungeAuthMiddleware({
    verifier: deps.authVerifier,
    noAuth: deps.noAuth,
    nodeEnv: deps.nodeEnv,
    isCloudRun: deps.isCloudRun,
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
      ...(deps.legalUrls ? { legalUrls: deps.legalUrls } : {}),
      ...(deps.firebaseWebConfig ? { firebase: deps.firebaseWebConfig } : {}),
      ...(deps.useEmulators !== undefined ? { useEmulators: deps.useEmulators } : {}),
      ...(deps.nodeEnv !== undefined ? { production: deps.nodeEnv === 'production' } : {}),
      ...(deps.phase2EeaEnabled !== undefined
        ? { phase2EeaEnabled: deps.phase2EeaEnabled }
        : {}),
      ...(deps.billingEnabled !== undefined ? { billingEnabled: deps.billingEnabled } : {}),
      ...(deps.contactEmail !== undefined ? { contactEmail: deps.contactEmail } : {}),
    };
    res.status(200).json(configPayload);
  });

  const authController = new LoungeAuthController(
    deps.authUseCase,
    deps.defaultGeoCountryCode ?? 'JP',
    trustedGeoHeader,
  );
  const accountController = new LoungeAccountController(deps.accountUseCase);
  const sessionController = new LoungeSessionController(
    deps.sessionUseCase,
    deps.defaultGeoCountryCode ?? 'JP',
    trustedGeoHeader,
  );
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
        { path: toSingleLineLog(req.path) },
        traceHeader,
      );
      res.status(400).json({ error: 'Malformed JSON request body' });
      return;
    }
    if (bodyErrType === 'entity.too.large' || bodyErrStatus === 413) {
      loungeLogger.warn(
        'Rejected oversized request payload',
        { path: toSingleLineLog(req.path) },
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
      { path: toSingleLineLog(req.path) },
      traceHeader,
    );
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
