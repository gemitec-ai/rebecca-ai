import { Injectable } from '@angular/core';
import type {
  LOUNGE_ERROR_CODE_DISCLAIMER_RECONSENT_REQUIRED,
  LoungeAccountSummaryDto,
  LoungeAuthSessionDto,
  LoungeDeleteAccountRequestDto,
  LoungeEmotionState,
  LoungeGalleryItem,
  LoungeGalleryListResponseDto,
  LoungeLanguage,
  LoungeLoginRequestDto,
  LoungeMessage,
  LoungeMessageListResponseDto,
  LoungePersonaBranding,
  LoungeRuntimeConfigDto,
  LoungeSendMessageRequestDto,
  LoungeSendMessageResponseDto,
  LoungeSession,
  LoungeSignUpRequestDto,
  LoungeSubscription,
  LoungeUpdateDisclaimerConsentRequestDto,
  LoungeUpdatePreferencesRequestDto,
  LoungeUser,
} from '@rebecca/types';
import { environment } from '../../../environments/environment';
import {
  detectInitialLoungeLanguage,
  detectInitialLoungeTimezone,
} from '../i18n/lounge-translations';
import { LoungeAccountPort } from '../ports/lounge-account.port';
import { LoungeAuthPort } from '../ports/lounge-auth.port';
import { LoungeConfigPort } from '../ports/lounge-config.port';
import { LoungeGalleryPort } from '../ports/lounge-gallery.port';
import { LoungeSessionPort } from '../ports/lounge-session.port';

const DISCLAIMER_RECONSENT_REQUIRED_CODE: typeof LOUNGE_ERROR_CODE_DISCLAIMER_RECONSENT_REQUIRED =
  'DISCLAIMER_RECONSENT_REQUIRED';

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

function createInitialMessages(): LoungeMessage[] {
  return [
    {
      id: 'msg_001',
      sessionId: 'uid_preview_001',
      uid: 'uid_preview_001',
      role: 'ASSISTANT',
      content: 'おかえり！今日は1対1でゆっくり話そうね。最近の調子はどう？',
      emotion: 'HAPPY',
      createdAt: '2026-11-22T12:01:00.000Z',
    },
    {
      id: 'msg_002',
      sessionId: 'uid_preview_001',
      uid: 'uid_preview_001',
      role: 'USER',
      content: 'いつもXでありがとう！今日は落ち着いてゆっくり話したくて遊びに来たよ。',
      emotion: 'NEUTRAL',
      createdAt: '2026-11-22T12:04:00.000Z',
    },
    {
      id: 'msg_003',
      sessionId: 'uid_preview_001',
      uid: 'uid_preview_001',
      role: 'ASSISTANT',
      content:
        'ふふ、そう言ってもらえるの素直に嬉しいじゃん！せっかく来てくれたし、今朝の雰囲気にぴったりな1枚見せてあげるね！',
      emotion: 'SURPRISED',
      imageAssetId: 'bot_img_01',
      imageUrl: 'assets/gallery_morning.webp',
      tokenUsage: { promptTokens: 320, candidatesTokens: 78, totalTokens: 398 },
      createdAt: '2026-11-22T12:08:00.000Z',
    },
  ];
}

function createInitialGallery(): LoungeGalleryItem[] {
  return [
    {
      id: 'uid_preview_001_bot_img_01',
      uid: 'uid_preview_001',
      assetId: 'bot_img_01',
      imageUrl: 'assets/gallery_morning.webp',
      unlocked: true,
      unlockedAt: '2026-11-22T12:08:00.000Z',
      sourceSessionId: 'uid_preview_001',
    },
    {
      id: 'uid_preview_001_bot_img_02',
      uid: 'uid_preview_001',
      assetId: 'bot_img_02',
      imageUrl: 'assets/gallery_street.webp',
      unlocked: true,
      unlockedAt: '2026-11-22T12:12:00.000Z',
      sourceSessionId: 'uid_preview_001',
    },
    {
      id: 'uid_preview_001_bot_img_03',
      uid: 'uid_preview_001',
      assetId: 'bot_img_03',
      imageUrl: 'assets/IMG_8649.JPG',
      unlocked: true,
      unlockedAt: '2026-11-22T12:18:00.000Z',
      sourceSessionId: 'uid_preview_001',
    },
    {
      id: 'uid_preview_001_bot_img_04',
      uid: 'uid_preview_001',
      assetId: 'bot_img_04',
      imageUrl: '',
      unlocked: false,
    },
    {
      id: 'uid_preview_001_bot_img_05',
      uid: 'uid_preview_001',
      assetId: 'bot_img_05',
      imageUrl: '',
      unlocked: false,
    },
    {
      id: 'uid_preview_001_bot_img_06',
      uid: 'uid_preview_001',
      assetId: 'bot_img_06',
      imageUrl: '',
      unlocked: false,
    },
  ];
}

/**
 * Architecture skeleton BFF adapter implementing Config, Auth, Account, Session, and Gallery ports.
 * Models 1 X account = 1 user = 1 persistent conversation session and irreversible deletion.
 */
@Injectable({ providedIn: 'root' })
export class LoungeBffAdapter
  implements LoungeConfigPort, LoungeAuthPort, LoungeAccountPort, LoungeSessionPort, LoungeGalleryPort
{
  private resolvedRuntimeConfig: LoungeRuntimeConfigDto | null = null;
  private user: LoungeUser | null = null;
  private midSessionBumpPending = false;
  private preferredLanguage: LoungeLanguage = detectInitialLoungeLanguage();
  private preferredTimezone = detectInitialLoungeTimezone();

  private subscription: LoungeSubscription = {
    uid: 'uid_preview_001',
    tier: 'SUPPORTER',
    status: 'ACTIVE',
    dailyTurnQuota: 30,
    remainingChatTurns: 24,
    quotaResetAt: '2026-11-23T00:00:00.000Z',
    currentPeriodEnd: '2026-12-22T00:00:00.000Z',
    updatedAt: '2026-11-22T12:00:00.000Z',
  };

  private session: LoungeSession = {
    id: 'uid_preview_001',
    uid: 'uid_preview_001',
    title: 'Private Lounge',
    messageCount: 3,
    currentEmotion: 'TEASING',
    publicXMemorySyncedAt: '2026-11-22T12:00:00.000Z',
    lastMessagePreview: '今朝の雰囲気にぴったりな1枚見せてあげるね！',
    createdAt: '2026-11-22T12:00:00.000Z',
    updatedAt: '2026-11-22T12:08:00.000Z',
  };

  private messages: LoungeMessage[] = createInitialMessages();
  private galleryItems: LoungeGalleryItem[] = createInitialGallery();

  /** @inheritdoc */
  public async getRuntimeConfig(): Promise<LoungeRuntimeConfigDto> {
    const fallbackConfig: LoungeRuntimeConfigDto = {
      appVersion: environment.appVersion,
      disclaimerVersion: environment.disclaimerVersion,
      persona: {
        ...environment.persona,
        emotionAvatarPaths: { ...environment.persona.emotionAvatarPaths },
      },
    };

    if (typeof fetch !== 'function') {
      this.resolvedRuntimeConfig = fallbackConfig;
      return fallbackConfig;
    }

    try {
      const response = await fetch(`${environment.apiBaseUrl}/config`, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        this.resolvedRuntimeConfig = fallbackConfig;
        return fallbackConfig;
      }
      const parsed = (await response.json()) as Partial<LoungeRuntimeConfigDto> | null;
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
        };
        this.resolvedRuntimeConfig = liveConfig;
        return liveConfig;
      }
    } catch {
      // Offline/static preview falls back cleanly to configured environment placeholder.
    }

    this.resolvedRuntimeConfig = fallbackConfig;
    return fallbackConfig;
  }

  /** @inheritdoc */
  public async getCurrentSession(): Promise<LoungeAuthSessionDto | null> {
    if (!this.user) {
      this.user = this.resolvePreviewScenarioUser();
    }
    if (!this.user) {
      return null;
    }
    return {
      user: this.user,
      appVersion: this.resolvedRuntimeConfig?.appVersion ?? environment.appVersion,
      issuedAt: this.user.lastLoginAt,
    };
  }

  /** @inheritdoc */
  public async loginWithX(_request: LoungeLoginRequestDto): Promise<LoungeAuthSessionDto> {
    const now = new Date().toISOString();
    this.user = this.createPreviewUser(now);
    return {
      user: this.user,
      appVersion: this.resolvedRuntimeConfig?.appVersion ?? environment.appVersion,
      issuedAt: now,
    };
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
    if (this.user) {
      throw new Error('An account linked to this X account is already registered');
    }
    if (request.language) {
      this.preferredLanguage = request.language;
    }
    if (request.timezone) {
      this.preferredTimezone = request.timezone;
    }
    const now = new Date().toISOString();
    this.user = {
      ...this.createPreviewUser(now, false),
      disclaimerConsent: request.disclaimerConsent,
    };
    return {
      user: this.user,
      appVersion: this.resolvedRuntimeConfig?.appVersion ?? environment.appVersion,
      issuedAt: now,
    };
  }

  /** @inheritdoc */
  public async logout(): Promise<void> {
    this.user = null;
    this.midSessionBumpPending = false;
  }

  /** @inheritdoc */
  public async getAccountSummary(): Promise<LoungeAccountSummaryDto> {
    const activeUser = this.user ?? this.createPreviewUser(new Date().toISOString());
    const unlockedCount = this.galleryItems.filter((item) => item.unlocked).length;
    return {
      user: activeUser,
      subscription: this.subscription,
      persona: this.resolvedRuntimeConfig?.persona ?? {
        ...environment.persona,
        emotionAvatarPaths: { ...environment.persona.emotionAvatarPaths },
      },
      unlockedGalleryCount: unlockedCount,
      totalGalleryCount: this.galleryItems.length,
      appVersion: this.resolvedRuntimeConfig?.appVersion ?? environment.appVersion,
    };
  }

  /** @inheritdoc */
  public async updatePreferences(request: LoungeUpdatePreferencesRequestDto): Promise<LoungeUser> {
    if (request.language) {
      this.preferredLanguage = request.language;
    }
    if (request.timezone) {
      this.preferredTimezone = request.timezone;
    }
    const now = new Date().toISOString();
    const baseUser = this.user ?? this.createPreviewUser(now, true);
    this.user = {
      ...baseUser,
      language: this.preferredLanguage,
      timezone: this.preferredTimezone,
      onboardingCompleted:
        request.completeOnboarding !== undefined
          ? request.completeOnboarding
          : baseUser.onboardingCompleted,
      updatedAt: now,
    };
    return this.user;
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
    const now = new Date().toISOString();
    const baseUser = this.user ?? this.createPreviewUser(now, true);
    this.user = {
      ...baseUser,
      disclaimerConsent: request.disclaimerConsent,
      updatedAt: now,
    };
    return this.user;
  }

  /** @inheritdoc */
  public async deleteAccount(request: LoungeDeleteAccountRequestDto): Promise<void> {
    if (!request.confirmedIrreversibleDeletion || !request.confirmedNoRefundForRemainingTurns) {
      throw new Error('Both irreversible deletion and no-refund confirmations are required');
    }
    this.user = null;
    this.midSessionBumpPending = false;
    this.messages = createInitialMessages();
    this.galleryItems = createInitialGallery();
    this.session = {
      ...this.session,
      messageCount: this.messages.length,
      currentEmotion: 'SURPRISED',
      lastMessagePreview: this.messages[this.messages.length - 1]?.content ?? '',
      updatedAt: new Date().toISOString(),
    };
    this.subscription = {
      ...this.subscription,
      remainingChatTurns: 24,
      updatedAt: new Date().toISOString(),
    };
  }

  /** @inheritdoc */
  public async getSession(): Promise<LoungeSession> {
    return this.session;
  }

  /** @inheritdoc */
  public async listMessages(): Promise<LoungeMessageListResponseDto> {
    return {
      items: [...this.messages],
      nextCursor: null,
      totalCount: this.messages.length,
    };
  }

  /** @inheritdoc */
  public async sendMessage(
    request: LoungeSendMessageRequestDto,
  ): Promise<LoungeSendMessageResponseDto> {
    const trimmed = request.content.trim();
    if (!trimmed) {
      throw new Error('Message content cannot be empty');
    }
    if (this.midSessionBumpPending) {
      this.midSessionBumpPending = false;
      const baseConfig: LoungeRuntimeConfigDto = this.resolvedRuntimeConfig ?? {
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
    const acceptedVersion = this.user?.disclaimerConsent.disclaimerVersion ?? requiredVersion;
    if (this.user && acceptedVersion < requiredVersion) {
      throw new LoungeReconsentRequiredClientError(requiredVersion, acceptedVersion);
    }
    if (this.subscription.remainingChatTurns <= 0) {
      throw new Error('Daily chat turn quota exhausted');
    }

    const now = new Date().toISOString();
    const sessionId = this.session.id;
    const userMessage: LoungeMessage = {
      id: `msg_${Date.now()}_u`,
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

    const nextLockedIndex = this.galleryItems.findIndex((item) => !item.unlocked);
    let unlockedGalleryItem: LoungeGalleryItem | undefined;
    if (nextLockedIndex >= 0) {
      const target = this.galleryItems[nextLockedIndex];
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
      this.galleryItems = this.galleryItems.map((item, idx) =>
        idx === nextLockedIndex ? unlocked : item,
      );
    }

    const assistantMessage: LoungeMessage = {
      id: `msg_${Date.now()}_a`,
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

    this.messages = [...this.messages, userMessage, assistantMessage];
    this.subscription = {
      ...this.subscription,
      remainingChatTurns: this.subscription.remainingChatTurns - 1,
      updatedAt: now,
    };
    this.session = {
      ...this.session,
      messageCount: this.messages.length,
      currentEmotion: assistantMessage.emotion,
      lastMessagePreview: assistantMessage.content,
      updatedAt: now,
    };

    return {
      session: this.session,
      userMessage,
      assistantMessage,
      remainingChatTurns: this.subscription.remainingChatTurns,
      ...(unlockedGalleryItem ? { unlockedGalleryItem } : {}),
    };
  }

  /** @inheritdoc */
  public async listGallery(): Promise<LoungeGalleryListResponseDto> {
    const unlockedCount = this.galleryItems.filter((item) => item.unlocked).length;
    return {
      items: [...this.galleryItems],
      unlockedCount,
      totalCount: this.galleryItems.length,
      nextCursor: null,
    };
  }

  private getActiveRequiredDisclaimerVersion(): number {
    return this.resolvedRuntimeConfig?.disclaimerVersion ?? environment.disclaimerVersion;
  }

  private resolvePreviewScenarioUser(): LoungeUser | null {
    if (typeof window === 'undefined' || !window.location?.search) {
      return null;
    }
    const params = new URLSearchParams(window.location.search);
    const scenario = params.get('previewScenario');
    if (
      scenario !== 'session' &&
      scenario !== 'onboarding' &&
      scenario !== 'reconsent' &&
      scenario !== 'mid-session-reconsent'
    ) {
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
      disclaimerConsent: {
        disclaimerVersion: this.resolvedRuntimeConfig?.disclaimerVersion ?? environment.disclaimerVersion,
        agreedToGeminiTrainingUsage: true,
        agreedToZeroPiiProhibition: true,
        agreedToOneWayMemoryIsolation: true,
        scrolledToBottomAt: now,
        consentedAt: now,
      },
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
    };
  }
}
