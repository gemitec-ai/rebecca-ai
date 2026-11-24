import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type {
  LOUNGE_ERROR_CODE_DISCLAIMER_RECONSENT_REQUIRED,
  LoungeAccountSummaryDto,
  LoungeApiErrorDto,
  LoungeAuthSessionDto,
  LoungeBillingCatalogDto,
  LoungeBillingOrderItemDto,
  LoungeBillingOrdersResponseDto,
  LoungeBillingReceiptResponseDto,
  LoungeCreateCheckoutRequestDto,
  LoungeCreateCheckoutResponseDto,
  LoungeCreatePortalRequestDto,
  LoungeCreatePortalResponseDto,
  LoungeDeleteAccountRequestDto,
  LoungeEmotionState,
  LoungeEuWithdrawalRequestDto,
  LoungeEuWithdrawalResponseDto,
  LoungeFirebaseWebConfig,
  LoungeGalleryItem,
  LoungeGalleryListResponseDto,
  LoungeLanguage,
  LoungeLoginRequestDto,
  LoungeMessage,
  LoungeMessageListResponseDto,
  LoungePaginationQueryDto,
  LoungePersonaBranding,
  LoungeRuntimeConfigDto,
  LoungeSendMessageRequestDto,
  LoungeSendMessageResponseDto,
  LoungeSession,
  LoungeSignUpRequestDto,
  LoungeSubscription,
  LoungeSubscriptionDetailResponseDto,
  LoungeUpdateDisclaimerConsentRequestDto,
  LoungeUpdatePreferencesRequestDto,
  LoungeUser,
  LoungeVerifyCheckoutRequestDto,
  LoungeVerifyCheckoutResponseDto,
} from '@rebecca/types';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import {
  detectInitialLoungeLanguage,
  detectInitialLoungeTimezone,
} from '../i18n/lounge-translations';
import { LoungeAccountPort } from '../ports/lounge-account.port';
import { LoungeAuthPort } from '../ports/lounge-auth.port';
import { LoungeBillingPort } from '../ports/lounge-billing.port';
import { LoungeConfigPort } from '../ports/lounge-config.port';
import { LoungeGalleryPort } from '../ports/lounge-gallery.port';
import { LoungeSessionPort } from '../ports/lounge-session.port';
import { LoungeAuthService } from '../services/lounge-auth.service';

const DISCLAIMER_RECONSENT_REQUIRED_CODE: typeof LOUNGE_ERROR_CODE_DISCLAIMER_RECONSENT_REQUIRED =
  'DISCLAIMER_RECONSENT_REQUIRED';

const PLACEHOLDER_ID_TOKEN = 'x-session-id-token';

type PreviewScenario =
  | 'session'
  | 'onboarding'
  | 'reconsent'
  | 'mid-session-reconsent'
  | 'billing';

/**
 * Structured client error raised when the active chat turn requires updated disclaimer re-consent.
 */
export class LoungeReconsentRequiredClientError extends Error {
  public readonly code = DISCLAIMER_RECONSENT_REQUIRED_CODE;
  public readonly requiredDisclaimerVersion: number;
  public readonly acceptedDisclaimerVersion: number;

  constructor(requiredDisclaimerVersion: number, acceptedDisclaimerVersion: number) {
    super('Updated disclaimer consent is required before continuing conversation');
    this.name = 'LoungeReconsentRequiredClientError';
    this.requiredDisclaimerVersion = requiredDisclaimerVersion;
    this.acceptedDisclaimerVersion = acceptedDisclaimerVersion;
  }
}

/**
 * Typed HTTP client error propagating BFF status codes and machine-readable error codes cleanly.
 */
export class LoungeClientApiError extends Error {
  public readonly statusCode: number;
  public readonly code?: string;

  constructor(statusCode: number, message: string, code?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LoungeClientApiError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function isValidEmotionAvatarMap(raw: unknown): raw is Record<LoungeEmotionState, string> {
  if (!raw || typeof raw !== 'object') {
    return false;
  }
  const obj = raw as Record<string, unknown>;
  const keys: LoungeEmotionState[] = [
    'NEUTRAL',
    'HAPPY',
    'TEASING',
    'SHY',
    'EXCITED',
    'THOUGHTFUL',
    'SURPRISED',
  ];
  return keys.every((key) => typeof obj[key] === 'string' && obj[key].trim().length > 0);
}

function isValidPersonaBranding(raw: unknown): raw is LoungePersonaBranding {
  if (!raw || typeof raw !== 'object') {
    return false;
  }
  const obj = raw as Record<string, unknown>;
  return (
    typeof obj['displayName'] === 'string' &&
    obj['displayName'].trim().length > 0 &&
    typeof obj['englishName'] === 'string' &&
    obj['englishName'].trim().length > 0 &&
    typeof obj['brandName'] === 'string' &&
    obj['brandName'].trim().length > 0 &&
    typeof obj['avatarPath'] === 'string' &&
    obj['avatarPath'].trim().length > 0 &&
    typeof obj['chatIconPath'] === 'string' &&
    obj['chatIconPath'].trim().length > 0 &&
    isValidEmotionAvatarMap(obj['emotionAvatarPaths'])
  );
}

function isValidFirebaseWebConfig(raw: unknown): raw is LoungeFirebaseWebConfig {
  if (!raw || typeof raw !== 'object') {
    return false;
  }
  const obj = raw as Record<string, unknown>;
  return (
    typeof obj['apiKey'] === 'string' &&
    obj['apiKey'].trim().length > 0 &&
    typeof obj['authDomain'] === 'string' &&
    obj['authDomain'].trim().length > 0 &&
    typeof obj['projectId'] === 'string' &&
    obj['projectId'].trim().length > 0 &&
    typeof obj['appId'] === 'string' &&
    obj['appId'].trim().length > 0
  );
}

function createInitialMessages(): LoungeMessage[] {
  const historyTemplates: readonly (
    | {
        readonly role: 'USER';
        readonly content: string;
      }
    | {
        readonly role: 'ASSISTANT';
        readonly emotion: LoungeEmotionState;
        readonly content: string;
        readonly imageAssetId?: string;
        readonly imageUrl?: string;
      }
  )[] = [
    {
      role: 'ASSISTANT',
      emotion: 'HAPPY',
      content: 'おかえり！ここが二人だけのプライベートルームだよ。まずはゆっくり話そうね。',
    },
    {
      role: 'USER',
      content: 'はじめまして！ずっとXのポスト見てたから、こうしてお話しできて嬉しいな。',
    },
    {
      role: 'ASSISTANT',
      emotion: 'EXCITED',
      content: 'えへへ、見つけてくれてありがとう！タイムラインよりもっとリラックスして話そっ。',
    },
    {
      role: 'USER',
      content: '最近仕事が忙しくて、夜の時間帯にほっと一息つきたいなって思ってて。',
    },
    {
      role: 'ASSISTANT',
      emotion: 'THOUGHTFUL',
      content: '毎日おつかれさまだよ〜！無理しすぎないで、疲れた時はわたしのとこ寄ってね。',
    },
    {
      role: 'USER',
      content: 'ありがとう。そういえば前にXに載せてた街歩きのコーデすごく可愛かったよ。',
    },
    {
      role: 'ASSISTANT',
      emotion: 'HAPPY',
      content: 'わ、覚えててくれたの！？お気に入りのパープルニット、こっちでも写真見せてあげるね！',
      imageAssetId: 'bot_img_02',
      imageUrl: 'assets/gallery_street.webp',
    },
    {
      role: 'USER',
      content: 'めっちゃ似合ってる！夜のライトと背景の雰囲気も最高だね。',
    },
    {
      role: 'ASSISTANT',
      emotion: 'SHY',
      content: 'そ、そこまで褒められるとちょっと照れるじゃん…でも素直に嬉しいかも！',
    },
    {
      role: 'USER',
      content: '他にも休みの日とかよく出かけるの？',
    },
    {
      role: 'ASSISTANT',
      emotion: 'TEASING',
      content: 'うん！最近はセレクトショップ巡りにハマっててさ、気になる服見つけるとすぐ試着しちゃうんだよね〜。',
    },
    {
      role: 'USER',
      content: 'いいなあ、今度どんな服選んでるのか教えてよ。',
    },
    {
      role: 'ASSISTANT',
      emotion: 'EXCITED',
      content: 'ちょうど試着室の前で撮ったやつ残ってた！じゃん、どうかな？',
      imageAssetId: 'bot_img_03',
      imageUrl: 'assets/IMG_8649.JPG',
    },
    {
      role: 'USER',
      content: '大人っぽくてクールだし、スタイル抜群だね！',
    },
    {
      role: 'ASSISTANT',
      emotion: 'HAPPY',
      content: 'やった〜！君にそう言ってもらえると選んだ甲斐があるよ。',
    },
    {
      role: 'USER',
      content: '夏っぽい明るい写真もあったりする？気分転換に見たいな。',
    },
    {
      role: 'ASSISTANT',
      emotion: 'HAPPY',
      content: 'もちろん！晴れた日のビーチで撮った爽やかな1枚、特別にどうぞっ！',
      imageAssetId: 'bot_img_04',
      imageUrl: 'assets/gallery_beach.webp',
    },
    {
      role: 'USER',
      content: '青空と海が眩しくて元気になるね！',
    },
    {
      role: 'ASSISTANT',
      emotion: 'TEASING',
      content: 'でしょでしょ？画面越しでもリゾート気分味わえたなら大成功だね♪',
    },
    {
      role: 'USER',
      content: 'オフの日の自然体な雰囲気も見てみたいな。',
    },
    {
      role: 'ASSISTANT',
      emotion: 'SHY',
      content: 'えっ、普段の感じも気になるの？じゃあちょっとリラックスしてる時のやつだけ特別に…！',
      imageAssetId: 'bot_img_05',
      imageUrl: 'assets/IMG_8653.JPG',
    },
    {
      role: 'USER',
      content: 'すごく自然で距離が近く感じるよ、見せてくれてありがとう。',
    },
    {
      role: 'ASSISTANT',
      emotion: 'HAPPY',
      content: 'プライベートラウンジだけのひみつのコレクション、少しずつ増えてくのも楽しみだよね！',
    },
    {
      role: 'ASSISTANT',
      emotion: 'HAPPY',
      content: 'おかえり！今日は1対1でゆっくり話そうね。最近の調子はどう？',
    },
    {
      role: 'USER',
      content: 'いつもXでありがとう！今日は落ち着いてゆっくり話したくて遊びに来たよ。',
    },
    {
      role: 'ASSISTANT',
      emotion: 'SURPRISED',
      content:
        'ふふ、そう言ってもらえるの素直に嬉しいじゃん！せっかく来てくれたし、今朝の雰囲気にぴったりな1枚見せてあげるね！',
      imageAssetId: 'bot_img_01',
      imageUrl: 'assets/gallery_morning.webp',
    },
  ];

  const baseMs = Date.parse('2026-11-21T10:00:00.000Z');
  return historyTemplates.map((entry, idx) => {
    const seq = String(idx + 1).padStart(3, '0');
    const createdAt = new Date(baseMs + idx * 120_000).toISOString();
    if (entry.role === 'USER') {
      return {
        id: `msg_${seq}`,
        sessionId: 'uid_preview_001',
        uid: 'uid_preview_001',
        role: 'USER',
        content: entry.content,
        emotion: 'NEUTRAL',
        createdAt,
      };
    }
    return {
      id: `msg_${seq}`,
      sessionId: 'uid_preview_001',
      uid: 'uid_preview_001',
      role: 'ASSISTANT',
      content: entry.content,
      emotion: entry.emotion,
      ...(entry.imageAssetId && entry.imageUrl
        ? {
            imageAssetId: entry.imageAssetId,
            imageUrl: entry.imageUrl,
          }
        : {}),
      tokenUsage: { promptTokens: 240 + idx * 4, candidatesTokens: 64, totalTokens: 304 + idx * 4 },
      createdAt,
    };
  });
}

function createInitialGallery(): LoungeGalleryItem[] {
  const unlockedSeeds: readonly {
    readonly assetId: string;
    readonly imageUrl: string;
    readonly unlockedAt: string;
  }[] = [
    {
      assetId: 'bot_img_01',
      imageUrl: 'assets/gallery_morning.webp',
      unlockedAt: '2026-11-22T12:08:00.000Z',
    },
    {
      assetId: 'bot_img_02',
      imageUrl: 'assets/gallery_street.webp',
      unlockedAt: '2026-11-22T12:12:00.000Z',
    },
    {
      assetId: 'bot_img_03',
      imageUrl: 'assets/IMG_8649.JPG',
      unlockedAt: '2026-11-22T12:18:00.000Z',
    },
    {
      assetId: 'bot_img_04',
      imageUrl: 'assets/gallery_beach.webp',
      unlockedAt: '2026-11-22T12:24:00.000Z',
    },
    {
      assetId: 'bot_img_05',
      imageUrl: 'assets/IMG_8653.JPG',
      unlockedAt: '2026-11-22T12:30:00.000Z',
    },
  ];

  const items: LoungeGalleryItem[] = [];
  for (let idx = 0; idx < 18; idx++) {
    const seq = String(idx + 1).padStart(2, '0');
    const assetId = `bot_img_${seq}`;
    const unlockedSeed = unlockedSeeds[idx];
    if (unlockedSeed) {
      items.push({
        id: `uid_preview_001_${unlockedSeed.assetId}`,
        uid: 'uid_preview_001',
        assetId: unlockedSeed.assetId,
        imageUrl: unlockedSeed.imageUrl,
        unlocked: true,
        unlockedAt: unlockedSeed.unlockedAt,
        sourceSessionId: 'uid_preview_001',
      });
    } else {
      items.push({
        id: `uid_preview_001_${assetId}`,
        uid: 'uid_preview_001',
        assetId,
        imageUrl: '',
        unlocked: false,
      });
    }
  }
  return items;
}

/**
 * Production HTTP BFF adapter implementing Config, Auth, Account, Billing, Session, and Gallery ports.
 * Falls back to self-contained fixtures strictly outside production when `?previewScenario=` is present.
 */
@Injectable({ providedIn: 'root' })
export class LoungeBffAdapter
  implements
    LoungeConfigPort,
    LoungeAuthPort,
    LoungeAccountPort,
    LoungeBillingPort,
    LoungeSessionPort,
    LoungeGalleryPort
{
  private readonly http = inject(HttpClient);
  private readonly authService = inject(LoungeAuthService);
  private readonly apiBaseUrl = environment.apiBaseUrl;

  private resolvedRuntimeConfig: LoungeRuntimeConfigDto | null = null;
  private previewUser: LoungeUser | null = null;
  private midSessionBumpPending = false;
  private messageSeq = 0;
  private preferredLanguage: LoungeLanguage = detectInitialLoungeLanguage();
  private preferredTimezone = detectInitialLoungeTimezone();

  private previewSubscription: LoungeSubscription = {
    uid: 'uid_preview_001',
    tier: 'FREE',
    status: 'NONE',
    billingCurrency: 'JPY',
    dailyTurnQuota: 5,
    dailyRemainingTurns: 5,
    purchasedRemainingTurns: 20,
    remainingChatTurns: 25,
    earliestLotExpiresAt: '2027-05-21T10:00:00.000Z',
    lastDailyResetAt: '2026-11-22T00:00:00.000Z',
    lastQuotaResetTimezone: 'Asia/Tokyo',
    nextDailyResetAt: '2026-11-23T00:00:00.000Z',
    currentPeriodEnd: '2026-12-22T00:00:00.000Z',
    trialTicketUsed: false,
    cancelAtPeriodEnd: false,
    updatedAt: '2026-11-22T12:00:00.000Z',
  };

  private previewOrders: LoungeBillingOrderItemDto[] = [
    {
      chargeId: 'ch_preview_001',
      productId: 'CHARGE_TICKET_100',
      status: 'COMPLETED',
      amountMinor: 500,
      refundedAmountMinor: 0,
      currency: 'JPY',
      createdAt: '2026-11-21T12:00:00.000Z',
      receiptAvailable: true,
      remainingTurns: 20,
      initialTurns: 100,
      lotStatus: 'ACTIVE',
      expiresAt: '2027-05-20T12:00:00.000Z',
    },
  ];

  private previewSession: LoungeSession = {
    id: 'uid_preview_001',
    uid: 'uid_preview_001',
    title: 'Private Lounge',
    messageCount: 26,
    currentEmotion: 'SURPRISED',
    publicXMemorySyncedAt: '2026-11-22T12:00:00.000Z',
    lastMessagePreview:
      'ふふ、そう言ってもらえるの素直に嬉しいじゃん！せっかく来てくれたし、今朝の雰囲気にぴったりな1枚見せてあげるね！',
    createdAt: '2026-11-21T10:00:00.000Z',
    updatedAt: '2026-11-22T12:08:00.000Z',
  };

  private previewMessages: LoungeMessage[] = createInitialMessages();
  private previewGalleryItems: LoungeGalleryItem[] = createInitialGallery();

  /** @inheritdoc */
  public async getRuntimeConfig(): Promise<LoungeRuntimeConfigDto> {
    const fallbackConfig: LoungeRuntimeConfigDto = {
      appVersion: environment.appVersion,
      disclaimerVersion: environment.disclaimerVersion,
      persona: {
        ...environment.persona,
        emotionAvatarPaths: { ...environment.persona.emotionAvatarPaths },
      },
      production: environment.production,
      useEmulators: !environment.production,
      phase2EeaEnabled: false,
    };

    try {
      const parsed = await firstValueFrom(
        this.http.get<Partial<LoungeRuntimeConfigDto>>(`${this.apiBaseUrl}/config`, {
          headers: { Accept: 'application/json' },
        }),
      );
      if (
        parsed &&
        typeof parsed.appVersion === 'string' &&
        typeof parsed.disclaimerVersion === 'number' &&
        Number.isInteger(parsed.disclaimerVersion) &&
        parsed.disclaimerVersion >= 1 &&
        isValidPersonaBranding(parsed.persona)
      ) {
        const liveConfig: LoungeRuntimeConfigDto = {
          appVersion: parsed.appVersion,
          disclaimerVersion: parsed.disclaimerVersion,
          persona: parsed.persona,
          ...(isValidFirebaseWebConfig(parsed.firebase) ? { firebase: parsed.firebase } : {}),
          ...(typeof parsed.useEmulators === 'boolean' ? { useEmulators: parsed.useEmulators } : {}),
          ...(typeof parsed.production === 'boolean' ? { production: parsed.production } : {}),
          ...(typeof parsed.phase2EeaEnabled === 'boolean'
            ? { phase2EeaEnabled: parsed.phase2EeaEnabled }
            : {}),
        };
        this.resolvedRuntimeConfig = liveConfig;
        this.authService.configure(liveConfig);
        return liveConfig;
      }
    } catch {
      // Fallback safely when runtime endpoint is unavailable (offline preview/unit harness).
    }

    this.resolvedRuntimeConfig = fallbackConfig;
    this.authService.configure(fallbackConfig);
    return fallbackConfig;
  }

  /** @inheritdoc */
  public async getCurrentSession(): Promise<LoungeAuthSessionDto | null> {
    if (this.isPreviewScenarioActive()) {
      if (!this.previewUser) {
        this.previewUser = this.resolvePreviewScenarioUser();
      }
      if (!this.previewUser) {
        return null;
      }
      return {
        user: this.previewUser,
        appVersion: this.resolvedRuntimeConfig?.appVersion ?? environment.appVersion,
        issuedAt: this.previewUser.lastLoginAt,
      };
    }

    await this.authService.waitForInit();
    const idToken = await this.authService.getToken();
    if (!idToken) {
      return null;
    }

    try {
      return await firstValueFrom(
        this.http.post<LoungeAuthSessionDto>(`${this.apiBaseUrl}/auth/login`, { idToken }),
      );
    } catch (err) {
      const mapped = this.mapHttpError(err);
      if (
        mapped instanceof LoungeClientApiError &&
        (mapped.statusCode === 401 || mapped.statusCode === 403 || mapped.statusCode === 404)
      ) {
        await this.authService.signOutFirebase().catch(() => undefined);
        return null;
      }
      throw mapped;
    }
  }

  /** @inheritdoc */
  public async loginWithX(request: LoungeLoginRequestDto): Promise<LoungeAuthSessionDto> {
    if (this.isPreviewScenarioActive()) {
      const now = new Date().toISOString();
      this.previewUser = this.createPreviewUser(now, true);
      return {
        user: this.previewUser,
        appVersion: this.resolvedRuntimeConfig?.appVersion ?? environment.appVersion,
        issuedAt: now,
      };
    }

    const useProvidedToken =
      request.idToken.trim().length > 0 && request.idToken !== PLACEHOLDER_ID_TOKEN;
    const creds = useProvidedToken
      ? { idToken: request.idToken, xOAuthCode: request.xOAuthCode }
      : await this.authService.authenticateWithX();

    try {
      return await firstValueFrom(
        this.http.post<LoungeAuthSessionDto>(`${this.apiBaseUrl}/auth/login`, {
          idToken: creds.idToken,
          ...(creds.xOAuthCode ? { xOAuthCode: creds.xOAuthCode } : {}),
        }),
      );
    } catch (err) {
      const mapped = this.mapHttpError(err);
      if (mapped instanceof LoungeClientApiError && mapped.statusCode === 404) {
        await this.authService.signOutFirebase().catch(() => undefined);
      }
      throw mapped;
    }
  }

  /** @inheritdoc */
  public async signUpWithX(request: LoungeSignUpRequestDto): Promise<LoungeAuthSessionDto> {
    if (
      !request.disclaimerConsent.agreedToGeminiTrainingUsage ||
      !request.disclaimerConsent.agreedToZeroPiiProhibition ||
      !request.disclaimerConsent.agreedToOneWayMemoryIsolation
    ) {
      throw new Error('Mandatory disclaimer terms must be accepted before sign-up');
    }

    if (this.isPreviewScenarioActive()) {
      if (this.previewUser) {
        throw new Error('An account linked to this X account is already registered');
      }
      if (request.language) {
        this.preferredLanguage = request.language;
      }
      if (request.timezone) {
        this.preferredTimezone = request.timezone;
      }
      const now = new Date().toISOString();
      this.previewUser = {
        ...this.createPreviewUser(now, false),
        disclaimerConsent: request.disclaimerConsent,
      };
      return {
        user: this.previewUser,
        appVersion: this.resolvedRuntimeConfig?.appVersion ?? environment.appVersion,
        issuedAt: now,
      };
    }

    const useProvidedToken =
      request.idToken.trim().length > 0 && request.idToken !== PLACEHOLDER_ID_TOKEN;
    const creds = useProvidedToken
      ? { idToken: request.idToken, xOAuthCode: request.xOAuthCode }
      : await this.authService.authenticateWithX();

    try {
      return await firstValueFrom(
        this.http.post<LoungeAuthSessionDto>(`${this.apiBaseUrl}/auth/signup`, {
          ...request,
          idToken: creds.idToken,
          xOAuthCode: creds.xOAuthCode,
        }),
      );
    } catch (err) {
      const mapped = this.mapHttpError(err);
      if (mapped instanceof LoungeClientApiError && mapped.statusCode === 409) {
        await this.authService.signOutFirebase().catch(() => undefined);
      }
      throw mapped;
    }
  }

  /** @inheritdoc */
  public async logout(): Promise<void> {
    if (this.isPreviewScenarioActive()) {
      this.previewUser = null;
      this.midSessionBumpPending = false;
      return;
    }

    try {
      await firstValueFrom(this.http.post(`${this.apiBaseUrl}/auth/logout`, {}));
    } catch {
      // Best-effort BFF logout before clearing local Firebase session state.
    } finally {
      await this.authService.signOutFirebase().catch(() => undefined);
    }
  }

  /** @inheritdoc */
  public async getAccountSummary(): Promise<LoungeAccountSummaryDto> {
    if (this.isPreviewScenarioActive()) {
      const activeUser = this.previewUser ?? this.createPreviewUser(new Date().toISOString());
      const unlockedCount = this.previewGalleryItems.filter((item) => item.unlocked).length;
      return {
        user: activeUser,
        subscription: this.previewSubscription,
        persona: this.resolvedRuntimeConfig?.persona ?? {
          ...environment.persona,
          emotionAvatarPaths: { ...environment.persona.emotionAvatarPaths },
        },
        unlockedGalleryCount: unlockedCount,
        totalGalleryCount: this.previewGalleryItems.length,
        appVersion: this.resolvedRuntimeConfig?.appVersion ?? environment.appVersion,
      };
    }

    try {
      return await firstValueFrom(
        this.http.get<LoungeAccountSummaryDto>(`${this.apiBaseUrl}/account`),
      );
    } catch (err) {
      throw this.mapHttpError(err);
    }
  }

  /** @inheritdoc */
  public async updatePreferences(request: LoungeUpdatePreferencesRequestDto): Promise<LoungeUser> {
    if (this.isPreviewScenarioActive()) {
      if (request.language) {
        this.preferredLanguage = request.language;
      }
      if (request.timezone) {
        this.preferredTimezone = request.timezone;
      }
      const now = new Date().toISOString();
      const baseUser = this.previewUser ?? this.createPreviewUser(now, true);
      this.previewUser = {
        ...baseUser,
        language: this.preferredLanguage,
        timezone: this.preferredTimezone,
        onboardingCompleted:
          request.completeOnboarding !== undefined
            ? request.completeOnboarding
            : baseUser.onboardingCompleted,
        allowServiceImprovementAnalytics:
          request.allowServiceImprovementAnalytics !== undefined
            ? request.allowServiceImprovementAnalytics
            : baseUser.allowServiceImprovementAnalytics,
        updatedAt: now,
      };
      return this.previewUser;
    }

    try {
      return await firstValueFrom(
        this.http.patch<LoungeUser>(`${this.apiBaseUrl}/account/preferences`, request),
      );
    } catch (err) {
      throw this.mapHttpError(err);
    }
  }

  /** @inheritdoc */
  public async updateDisclaimerConsent(
    request: LoungeUpdateDisclaimerConsentRequestDto,
  ): Promise<LoungeUser> {
    if (
      !request.disclaimerConsent.agreedToGeminiTrainingUsage ||
      !request.disclaimerConsent.agreedToZeroPiiProhibition ||
      !request.disclaimerConsent.agreedToOneWayMemoryIsolation
    ) {
      throw new Error('Mandatory disclaimer clauses must be accepted');
    }
    const requiredVersion = this.getActiveRequiredDisclaimerVersion();
    if (request.disclaimerConsent.disclaimerVersion !== requiredVersion) {
      throw new Error(`Disclaimer consent must match active version ${requiredVersion}`);
    }

    if (this.isPreviewScenarioActive()) {
      const now = new Date().toISOString();
      const baseUser = this.previewUser ?? this.createPreviewUser(now, true);
      this.previewUser = {
        ...baseUser,
        disclaimerConsent: request.disclaimerConsent,
        updatedAt: now,
      };
      return this.previewUser;
    }

    try {
      return await firstValueFrom(
        this.http.post<LoungeUser>(`${this.apiBaseUrl}/account/consent`, request),
      );
    } catch (err) {
      throw this.mapHttpError(err);
    }
  }

  /** @inheritdoc */
  public async deleteAccount(request: LoungeDeleteAccountRequestDto): Promise<void> {
    if (!request.confirmedIrreversibleDeletion || !request.confirmedNoRefundForRemainingTurns) {
      throw new Error('Both irreversible deletion and no-refund confirmations are required');
    }

    if (this.isPreviewScenarioActive()) {
      this.previewUser = null;
      this.midSessionBumpPending = false;
      this.previewMessages = createInitialMessages();
      this.previewGalleryItems = createInitialGallery();
      this.previewSession = {
        ...this.previewSession,
        messageCount: this.previewMessages.length,
        currentEmotion: 'SURPRISED',
        lastMessagePreview: this.previewMessages[this.previewMessages.length - 1]?.content ?? '',
        updatedAt: new Date().toISOString(),
      };
      this.previewSubscription = {
        ...this.previewSubscription,
        remainingChatTurns: 25,
        updatedAt: new Date().toISOString(),
      };
      return;
    }

    try {
      await firstValueFrom(
        this.http.delete(`${this.apiBaseUrl}/account`, { body: request }),
      );
      await this.authService.signOutFirebase().catch(() => undefined);
    } catch (err) {
      throw this.mapHttpError(err);
    }
  }

  /** @inheritdoc */
  public async getCatalog(): Promise<LoungeBillingCatalogDto> {
    if (this.isPreviewScenarioActive()) {
      const sub = this.previewSubscription;
      const isSubActive = sub.status === 'ACTIVE' || sub.status === 'CANCELING';
      return {
        currency: 'JPY',
        currencyLocked: true,
        countryCode: 'JP',
        isEeaResident: false,
        phase2EeaEnabled: false,
        trialEligible: !sub.trialTicketUsed,
        subscriptionStatus: sub.status,
        products: [
          {
            productId: 'TRIAL_TICKET_100',
            mode: 'payment',
            currency: 'JPY',
            unitAmountMinor: 200,
            formattedPrice: '¥200',
            grantedTurns: 100,
            validityDays: 180,
            taxInclusive: true,
            promotionCodesAllowed: false,
            eligible: !sub.trialTicketUsed,
            ...(sub.trialTicketUsed ? { ineligibleReason: 'TRIAL_ALREADY_USED' } : {}),
          },
          {
            productId: 'CHARGE_TICKET_100',
            mode: 'payment',
            currency: 'JPY',
            unitAmountMinor: 500,
            formattedPrice: '¥500',
            grantedTurns: 100,
            validityDays: 180,
            taxInclusive: true,
            promotionCodesAllowed: true,
            eligible: true,
          },
          {
            productId: 'STANDARD_MONTHLY',
            mode: 'subscription',
            currency: 'JPY',
            unitAmountMinor: 1400,
            formattedPrice: '¥1,400',
            grantedTurns: 100,
            validityDays: null,
            taxInclusive: true,
            promotionCodesAllowed: false,
            eligible: !isSubActive,
            ...(isSubActive ? { ineligibleReason: 'SUBSCRIPTION_ALREADY_ACTIVE' } : {}),
          },
        ],
      };
    }

    try {
      return await firstValueFrom(
        this.http.get<LoungeBillingCatalogDto>(`${this.apiBaseUrl}/billing/catalog`),
      );
    } catch (err) {
      throw this.mapHttpError(err);
    }
  }

  /** @inheritdoc */
  public async createCheckout(
    request: LoungeCreateCheckoutRequestDto,
  ): Promise<LoungeCreateCheckoutResponseDto> {
    if (this.isPreviewScenarioActive()) {
      const sessionId = `cs_preview_${Date.now()}`;
      const origin = typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:4300';
      return {
        checkoutUrl: `${origin}/?checkout=success&session_id=${encodeURIComponent(sessionId)}`,
        sessionIdMasked: `${sessionId.slice(0, 6)}...${sessionId.slice(-4)}`,
      };
    }

    try {
      return await firstValueFrom(
        this.http.post<LoungeCreateCheckoutResponseDto>(`${this.apiBaseUrl}/billing/checkout`, request),
      );
    } catch (err) {
      throw this.mapHttpError(err);
    }
  }

  /** @inheritdoc */
  public async verifyCheckout(
    request: LoungeVerifyCheckoutRequestDto,
  ): Promise<LoungeVerifyCheckoutResponseDto> {
    if (this.isPreviewScenarioActive()) {
      this.previewSubscription = {
        ...this.previewSubscription,
        purchasedRemainingTurns: this.previewSubscription.purchasedRemainingTurns + 100,
        remainingChatTurns: this.previewSubscription.remainingChatTurns + 100,
        trialTicketUsed: true,
        updatedAt: new Date().toISOString(),
      };
      return { subscription: this.previewSubscription, verified: true };
    }

    try {
      return await firstValueFrom(
        this.http.post<LoungeVerifyCheckoutResponseDto>(
          `${this.apiBaseUrl}/billing/checkout/verify`,
          request,
        ),
      );
    } catch (err) {
      throw this.mapHttpError(err);
    }
  }

  /** @inheritdoc */
  public async createPortal(
    request: LoungeCreatePortalRequestDto,
  ): Promise<LoungeCreatePortalResponseDto> {
    if (this.isPreviewScenarioActive()) {
      const origin = typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:4300';
      return { portalUrl: `${origin}/?portal_return=1&flow=${encodeURIComponent(request.flow)}` };
    }

    try {
      return await firstValueFrom(
        this.http.post<LoungeCreatePortalResponseDto>(`${this.apiBaseUrl}/billing/portal`, request),
      );
    } catch (err) {
      throw this.mapHttpError(err);
    }
  }

  /** @inheritdoc */
  public async getSubscriptionDetail(options?: {
    readonly portalReturn?: boolean;
  }): Promise<LoungeSubscriptionDetailResponseDto> {
    if (this.isPreviewScenarioActive()) {
      return {
        subscription: this.previewSubscription,
        quotaBreakdown: {
          dailyTurnQuota: this.previewSubscription.dailyTurnQuota,
          dailyRemainingTurns: this.previewSubscription.dailyRemainingTurns,
          purchasedRemainingTurns: this.previewSubscription.purchasedRemainingTurns,
          remainingChatTurns: this.previewSubscription.remainingChatTurns,
          activeLots: [],
          nextDailyResetAt: this.previewSubscription.nextDailyResetAt,
          consumptionOrder: ['DAILY', 'LOT_FIFO'],
          phase2EuWithdrawalEligible: false,
        },
      };
    }

    let params = new HttpParams();
    if (options?.portalReturn) {
      params = params.set('portalReturn', '1');
    }
    try {
      return await firstValueFrom(
        this.http.get<LoungeSubscriptionDetailResponseDto>(
          `${this.apiBaseUrl}/billing/subscription`,
          { params },
        ),
      );
    } catch (err) {
      throw this.mapHttpError(err);
    }
  }

  /** @inheritdoc */
  public async withdrawEu(
    request: LoungeEuWithdrawalRequestDto,
  ): Promise<LoungeEuWithdrawalResponseDto> {
    if (this.isPreviewScenarioActive()) {
      return {
        withdrawnAt: new Date().toISOString(),
        refundedAmountMinor: 500,
        currency: 'JPY',
        revokedTurns: 100,
        receiptEmailDispatched: true,
        subscription: this.previewSubscription,
      };
    }

    try {
      return await firstValueFrom(
        this.http.post<LoungeEuWithdrawalResponseDto>(
          `${this.apiBaseUrl}/billing/eu-withdrawal`,
          request,
        ),
      );
    } catch (err) {
      throw this.mapHttpError(err);
    }
  }

  /** @inheritdoc */
  public async listOrders(query?: {
    readonly limit?: number;
    readonly startingAfter?: string;
  }): Promise<LoungeBillingOrdersResponseDto> {
    if (this.isPreviewScenarioActive()) {
      return { orders: this.previewOrders, nextCursor: null, hasMore: false };
    }

    let params = new HttpParams();
    if (query?.limit !== undefined) {
      params = params.set('limit', String(query.limit));
    }
    if (query?.startingAfter) {
      params = params.set('startingAfter', query.startingAfter);
    }
    try {
      return await firstValueFrom(
        this.http.get<LoungeBillingOrdersResponseDto>(`${this.apiBaseUrl}/billing/orders`, {
          params,
        }),
      );
    } catch (err) {
      throw this.mapHttpError(err);
    }
  }

  /** @inheritdoc */
  public async getOrderReceipt(chargeId: string): Promise<LoungeBillingReceiptResponseDto> {
    if (this.isPreviewScenarioActive()) {
      return { receiptUrl: 'https://pay.stripe.com/receipts/preview/ch_preview_001' };
    }

    try {
      return await firstValueFrom(
        this.http.get<LoungeBillingReceiptResponseDto>(
          `${this.apiBaseUrl}/billing/orders/${encodeURIComponent(chargeId)}/receipt`,
        ),
      );
    } catch (err) {
      throw this.mapHttpError(err);
    }
  }

  /** @inheritdoc */
  public async getSession(): Promise<LoungeSession> {
    if (this.isPreviewScenarioActive()) {
      return this.previewSession;
    }

    try {
      return await firstValueFrom(this.http.get<LoungeSession>(`${this.apiBaseUrl}/session`));
    } catch (err) {
      throw this.mapHttpError(err);
    }
  }

  /** @inheritdoc */
  public async listMessages(query?: LoungePaginationQueryDto): Promise<LoungeMessageListResponseDto> {
    if (this.isPreviewScenarioActive()) {
      return this.listPreviewMessages(query);
    }

    let params = new HttpParams();
    if (query?.page !== undefined) {
      params = params.set('page', String(query.page));
    }
    if (query?.limit !== undefined) {
      params = params.set('limit', String(query.limit));
    }
    if (query?.cursor) {
      params = params.set('cursor', query.cursor);
    }
    try {
      return await firstValueFrom(
        this.http.get<LoungeMessageListResponseDto>(`${this.apiBaseUrl}/session/messages`, {
          params,
        }),
      );
    } catch (err) {
      throw this.mapHttpError(err);
    }
  }

  /** @inheritdoc */
  public async sendMessage(
    request: LoungeSendMessageRequestDto,
  ): Promise<LoungeSendMessageResponseDto> {
    const trimmed = request.content.trim();
    if (!trimmed) {
      throw new Error('Message content cannot be empty');
    }

    if (this.isPreviewScenarioActive()) {
      return this.sendPreviewMessage(trimmed);
    }

    try {
      return await firstValueFrom(
        this.http.post<LoungeSendMessageResponseDto>(`${this.apiBaseUrl}/session/messages`, {
          content: trimmed,
        }),
      );
    } catch (err) {
      throw this.mapHttpError(err);
    }
  }

  /** @inheritdoc */
  public async listGallery(query?: LoungePaginationQueryDto): Promise<LoungeGalleryListResponseDto> {
    if (this.isPreviewScenarioActive()) {
      return this.listPreviewGallery(query);
    }

    let params = new HttpParams();
    if (query?.page !== undefined) {
      params = params.set('page', String(query.page));
    }
    if (query?.limit !== undefined) {
      params = params.set('limit', String(query.limit));
    }
    if (query?.cursor) {
      params = params.set('cursor', query.cursor);
    }
    try {
      return await firstValueFrom(
        this.http.get<LoungeGalleryListResponseDto>(`${this.apiBaseUrl}/gallery`, { params }),
      );
    } catch (err) {
      throw this.mapHttpError(err);
    }
  }

  private mapHttpError(err: unknown): Error {
    if (err instanceof HttpErrorResponse) {
      const payload =
        typeof err.error === 'object' && err.error !== null
          ? (err.error as Partial<LoungeApiErrorDto>)
          : null;
      const errorCode = typeof payload?.code === 'string' ? payload.code : undefined;
      if (errorCode === DISCLAIMER_RECONSENT_REQUIRED_CODE) {
        return new LoungeReconsentRequiredClientError(
          typeof payload?.requiredDisclaimerVersion === 'number'
            ? payload.requiredDisclaimerVersion
            : this.getActiveRequiredDisclaimerVersion(),
          typeof payload?.acceptedDisclaimerVersion === 'number'
            ? payload.acceptedDisclaimerVersion
            : 0,
        );
      }
      const message =
        typeof payload?.error === 'string' && payload.error.trim().length > 0
          ? payload.error.trim()
          : err.message || `HTTP ${err.status}`;
      return new LoungeClientApiError(err.status, message, errorCode, { cause: err });
    }
    if (err instanceof Error) {
      return err;
    }
    return new Error('Unexpected Private Lounge BFF client error', { cause: err });
  }

  private isPreviewScenarioActive(): boolean {
    return this.resolvePreviewScenarioParam() !== null;
  }

  private resolvePreviewScenarioParam(): PreviewScenario | null {
    if (environment.production || typeof window === 'undefined' || !window.location?.search) {
      return null;
    }
    const scenario = new URLSearchParams(window.location.search).get('previewScenario');
    if (
      scenario === 'session' ||
      scenario === 'onboarding' ||
      scenario === 'reconsent' ||
      scenario === 'mid-session-reconsent' ||
      scenario === 'billing'
    ) {
      return scenario;
    }
    return null;
  }

  private getActiveRequiredDisclaimerVersion(): number {
    return this.resolvedRuntimeConfig?.disclaimerVersion ?? environment.disclaimerVersion;
  }

  private resolvePreviewScenarioUser(): LoungeUser | null {
    const scenario = this.resolvePreviewScenarioParam();
    if (!scenario) {
      return null;
    }
    const now = new Date().toISOString();
    const baseUser = this.createPreviewUser(now, scenario !== 'onboarding');
    if (scenario === 'reconsent') {
      return {
        ...baseUser,
        disclaimerConsent: {
          ...baseUser.disclaimerConsent,
          disclaimerVersion: 0,
        },
      };
    }
    if (scenario === 'mid-session-reconsent') {
      this.midSessionBumpPending = true;
    }
    return baseUser;
  }

  private createPreviewUser(now: string, onboardingCompleted = true): LoungeUser {
    return {
      uid: 'uid_preview_001',
      xUserId: '1000000001',
      xHandle: '@cyber_runner_01',
      displayName: 'Cyber Runner 01',
      avatarUrl: 'assets/gemitec_icon.svg',
      status: 'ACTIVE',
      language: this.preferredLanguage,
      timezone: this.preferredTimezone,
      onboardingCompleted,
      allowServiceImprovementAnalytics: true,
      countryCode: 'JP',
      isEeaResident: false,
      preferredCurrency: 'JPY',
      disclaimerConsent: {
        disclaimerVersion: this.getActiveRequiredDisclaimerVersion(),
        agreedToGeminiTrainingUsage: true,
        agreedToZeroPiiProhibition: true,
        agreedToOneWayMemoryIsolation: true,
        scrolledToBottomAt: now,
        consentedAt: now,
      },
      createdAt: '2026-11-21T10:00:00.000Z',
      updatedAt: now,
      lastLoginAt: now,
    };
  }

  private listPreviewMessages(query?: LoungePaginationQueryDto): LoungeMessageListResponseDto {
    const rawLimit = query?.limit;
    const limit =
      typeof rawLimit === 'number' && Number.isFinite(rawLimit)
        ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100)
        : 20;
    const totalItems = this.previewMessages.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / limit));

    const trimmedCursor = typeof query?.cursor === 'string' ? query.cursor.trim() : '';
    if (trimmedCursor.length > 0) {
      const cursorIndex = this.previewMessages.findIndex((msg) => msg.id === trimmedCursor);
      if (cursorIndex <= 0) {
        return {
          data: [],
          meta: {
            currentPage: totalPages,
            limit,
            totalItems,
            totalPages,
            nextCursor: null,
            hasMore: false,
          },
        };
      }
      const startIdx = Math.max(0, cursorIndex - limit);
      const data = this.previewMessages.slice(startIdx, cursorIndex);
      const hasMore = startIdx > 0;
      const nextCursor = hasMore && data.length > 0 ? data[0].id : null;
      const page = totalItems === 0 ? 1 : Math.min(totalPages, Math.ceil((totalItems - startIdx) / limit));
      return {
        data,
        meta: { currentPage: page, limit, totalItems, totalPages, nextCursor, hasMore },
      };
    }

    const rawPage = query?.page;
    const page =
      typeof rawPage === 'number' && Number.isFinite(rawPage)
        ? Math.max(1, Math.trunc(rawPage))
        : 1;
    const endIdx = Math.max(0, totalItems - (page - 1) * limit);
    const startIdx = Math.max(0, endIdx - limit);
    const data = this.previewMessages.slice(startIdx, endIdx);
    const hasMore = startIdx > 0;
    const nextCursor = hasMore && data.length > 0 ? data[0].id : null;
    return {
      data,
      meta: { currentPage: page, limit, totalItems, totalPages, nextCursor, hasMore },
    };
  }

  private sendPreviewMessage(trimmed: string): LoungeSendMessageResponseDto {
    if (this.midSessionBumpPending) {
      this.midSessionBumpPending = false;
      const baseConfig = this.resolvedRuntimeConfig ?? {
        appVersion: environment.appVersion,
        disclaimerVersion: environment.disclaimerVersion,
        persona: {
          ...environment.persona,
          emotionAvatarPaths: { ...environment.persona.emotionAvatarPaths },
        },
      };
      this.resolvedRuntimeConfig = {
        ...baseConfig,
        disclaimerVersion: baseConfig.disclaimerVersion + 1,
      };
    }
    const requiredVersion = this.getActiveRequiredDisclaimerVersion();
    const acceptedVersion = this.previewUser?.disclaimerConsent.disclaimerVersion ?? requiredVersion;
    if (this.previewUser && acceptedVersion < requiredVersion) {
      throw new LoungeReconsentRequiredClientError(requiredVersion, acceptedVersion);
    }
    if (this.previewSubscription.remainingChatTurns <= 0) {
      throw new Error('Daily chat turn quota exhausted');
    }

    const now = new Date().toISOString();
    const sessionId = this.previewSession.id;
    const turnSeq = ++this.messageSeq;
    const userMessage: LoungeMessage = {
      id: `msg_${Date.now()}_${turnSeq}_u`,
      sessionId,
      uid: 'uid_preview_001',
      role: 'USER',
      content: trimmed,
      emotion: 'NEUTRAL',
      createdAt: now,
    };

    const replyMap: Record<LoungeLanguage, string> = {
      ja: `なるほど、「${trimmed.slice(0, 28)}」だねっ！せっかく二人きりだし、もっとゆっくり話聞かせてよ。`,
      en: `Got it — "${trimmed.slice(0, 28)}"! Since it's just us here, tell me more about it.`,
      de: `Verstehe – „${trimmed.slice(0, 28)}“! Erzähl mir gerne noch mehr davon.`,
      pt: `Entendi — "${trimmed.slice(0, 28)}"! Como estamos só nós dois aqui, me conta mais!`,
      es: `¡Entiendo — "${trimmed.slice(0, 28)}"! Aprovechemos nuestro espacio para charlar más.`,
      'zh-HK': `明晒，「${trimmed.slice(0, 28)}」嘛！難得一對一傾計，講多啲俾我聽呀。`,
      vi: `Mình hiểu rồi — "${trimmed.slice(0, 28)}"! Kể cho mình nghe thêm đi nhé.`,
      th: `เข้าใจแล้วจ้า — "${trimmed.slice(0, 28)}"! เล่าให้ฟังต่ออีกได้เลยนะ`,
    };

    const nextLockedIndex = this.previewGalleryItems.findIndex((item) => !item.unlocked);
    let unlockedGalleryItem: LoungeGalleryItem | undefined;
    if (nextLockedIndex >= 0) {
      const target = this.previewGalleryItems[nextLockedIndex];
      const previewImages = ['assets/gallery_beach.webp', 'assets/IMG_8653.JPG', 'assets/IMG_8673.JPG'];
      const assetPath = previewImages[nextLockedIndex % previewImages.length];
      const unlocked: LoungeGalleryItem = {
        ...target,
        imageUrl: assetPath,
        unlocked: true,
        unlockedAt: now,
        sourceSessionId: sessionId,
      };
      unlockedGalleryItem = unlocked;
      this.previewGalleryItems = this.previewGalleryItems.map((item, idx) =>
        idx === nextLockedIndex ? unlocked : item,
      );
    }

    const assistantMessage: LoungeMessage = {
      id: `msg_${Date.now()}_${turnSeq}_a`,
      sessionId,
      uid: 'uid_preview_001',
      role: 'ASSISTANT',
      content: replyMap[this.preferredLanguage],
      emotion: 'EXCITED',
      ...(unlockedGalleryItem
        ? {
            imageAssetId: unlockedGalleryItem.assetId,
            imageUrl: unlockedGalleryItem.imageUrl,
          }
        : {}),
      tokenUsage: { promptTokens: 280, candidatesTokens: 54, totalTokens: 334 },
      createdAt: now,
    };

    this.previewMessages = [...this.previewMessages, userMessage, assistantMessage];
    const nextDaily = Math.max(0, this.previewSubscription.dailyRemainingTurns - 1);
    const nextPurchased =
      this.previewSubscription.dailyRemainingTurns > 0
        ? this.previewSubscription.purchasedRemainingTurns
        : Math.max(0, this.previewSubscription.purchasedRemainingTurns - 1);
    this.previewSubscription = {
      ...this.previewSubscription,
      dailyRemainingTurns: nextDaily,
      purchasedRemainingTurns: nextPurchased,
      remainingChatTurns: nextDaily + nextPurchased,
      updatedAt: now,
    };
    this.previewSession = {
      ...this.previewSession,
      messageCount: this.previewMessages.length,
      currentEmotion: assistantMessage.emotion,
      lastMessagePreview: assistantMessage.content,
      updatedAt: now,
    };

    return {
      session: this.previewSession,
      userMessage,
      assistantMessage,
      remainingChatTurns: this.previewSubscription.remainingChatTurns,
      subscription: this.previewSubscription,
      ...(unlockedGalleryItem ? { unlockedGalleryItem } : {}),
    };
  }

  private listPreviewGallery(query?: LoungePaginationQueryDto): LoungeGalleryListResponseDto {
    const rawLimit = query?.limit;
    const limit =
      typeof rawLimit === 'number' && Number.isFinite(rawLimit)
        ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100)
        : 20;
    const totalItems = this.previewGalleryItems.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / limit));
    const unlockedCount = this.previewGalleryItems.filter((item) => item.unlocked).length;

    let startIdx: number;
    let resolvedPage: number;
    const trimmedCursor = typeof query?.cursor === 'string' ? query.cursor.trim() : '';
    if (trimmedCursor.length > 0) {
      const cursorIdx = this.previewGalleryItems.findIndex((item) => item.id === trimmedCursor);
      if (cursorIdx === -1) {
        return {
          data: [],
          meta: {
            currentPage: totalPages,
            limit,
            totalItems,
            totalPages,
            nextCursor: null,
            hasMore: false,
          },
          summary: { unlockedCount, totalCount: totalItems },
        };
      }
      startIdx = cursorIdx + 1;
      resolvedPage = Math.min(totalPages, Math.floor(startIdx / limit) + 1);
    } else {
      const rawPage = query?.page;
      resolvedPage =
        typeof rawPage === 'number' && Number.isFinite(rawPage)
          ? Math.max(1, Math.trunc(rawPage))
          : 1;
      startIdx = (resolvedPage - 1) * limit;
    }

    const endIdx = Math.min(totalItems, startIdx + limit);
    const data = startIdx < totalItems ? this.previewGalleryItems.slice(startIdx, endIdx) : [];
    const hasMore = endIdx < totalItems;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;

    return {
      data,
      meta: {
        currentPage: resolvedPage,
        limit,
        totalItems,
        totalPages,
        nextCursor,
        hasMore,
      },
      summary: { unlockedCount, totalCount: totalItems },
    };
  }
}
