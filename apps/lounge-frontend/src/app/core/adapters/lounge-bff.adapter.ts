import { Injectable } from '@angular/core';
import type {
  LoungeAccountSummaryDto,
  LoungeAuthSessionDto,
  LoungeCreateSessionRequestDto,
  LoungeLoginRequestDto,
  LoungeMessage,
  LoungeMessageListResponseDto,
  LoungePersonaBranding,
  LoungeReward,
  LoungeRewardListResponseDto,
  LoungeRuntimeConfigDto,
  LoungeSendMessageRequestDto,
  LoungeSendMessageResponseDto,
  LoungeSession,
  LoungeSessionListResponseDto,
  LoungeSignUpRequestDto,
  LoungeSubscription,
  LoungeUser,
} from '@rebecca/types';
import { environment } from '../../../environments/environment';
import { LoungeAccountPort } from '../ports/lounge-account.port';
import { LoungeAuthPort } from '../ports/lounge-auth.port';
import { LoungeConfigPort } from '../ports/lounge-config.port';
import { LoungeRewardPort } from '../ports/lounge-reward.port';
import { LoungeSessionPort } from '../ports/lounge-session.port';

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
    obj['avatarPath'].trim().length > 0
  );
}

/**
 * Architecture skeleton BFF adapter implementing Config, Auth, Account, Session, and Reward ports.
 * Resolves live runtime persona config from `/api/v1/lounge/config` when hosted alongside BFF
 * and serves deterministic isolated preview data matching `/api/v1/lounge/*` OpenAPI DTO contracts
 * until full HTTP transport is wired.
 */
@Injectable({ providedIn: 'root' })
export class LoungeBffAdapter
  implements LoungeConfigPort, LoungeAuthPort, LoungeAccountPort, LoungeSessionPort, LoungeRewardPort
{
  private resolvedRuntimeConfig: LoungeRuntimeConfigDto | null = null;
  private user: LoungeUser | null = null;

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
    id: 'sess_lounge_001',
    uid: 'uid_preview_001',
    title: 'NEON LOUNGE // SESSION #01',
    messageCount: 3,
    currentEmotion: 'TEASING',
    publicXMemorySyncedAt: '2026-11-22T12:00:00.000Z',
    lastMessagePreview: '公開Xのみんなには内緒だからねっ。',
    createdAt: '2026-11-22T12:00:00.000Z',
    updatedAt: '2026-11-22T12:08:00.000Z',
  };

  private messages: LoungeMessage[] = [
    {
      id: 'msg_001',
      sessionId: 'sess_lounge_001',
      uid: 'uid_preview_001',
      role: 'ASSISTANT',
      content:
        'おかえり！ここは Gemitec の暗号化プライベートラウンジ。公開Xの記憶はちゃんと持ってきたけど、ここでの会話は外に絶対漏れないから安心してね。',
      emotion: 'HAPPY',
      createdAt: '2026-11-22T12:01:00.000Z',
    },
    {
      id: 'msg_002',
      sessionId: 'sess_lounge_001',
      uid: 'uid_preview_001',
      role: 'USER',
      content: 'いつもXでリプありがとう！今日は特別にラウンジへ遊びに来たよ。',
      emotion: 'NEUTRAL',
      createdAt: '2026-11-22T12:04:00.000Z',
    },
    {
      id: 'msg_003',
      sessionId: 'sess_lounge_001',
      uid: 'uid_preview_001',
      role: 'ASSISTANT',
      content:
        'ふふ、よく来てくれたじゃんっ！Xだと文字数とか人目とか気になるけど、ここでは二人きりだし。さっき撮っておいた朝のオフショット、リワード棚に入れておいたから後で見てみてよ！',
      emotion: 'TEASING',
      unlockedRewardId: 'uid_preview_001_RW-01',
      tokenUsage: { promptTokens: 320, candidatesTokens: 78, totalTokens: 398 },
      createdAt: '2026-11-22T12:08:00.000Z',
    },
  ];

  private readonly rewards: LoungeReward[] = [
    {
      id: 'uid_preview_001_RW-01',
      uid: 'uid_preview_001',
      code: 'RW-01',
      titleJa: '朝の陽だまりオフショット',
      titleEn: 'Morning Sunlight Off-Shot',
      descriptionJa: '初回のプライベートログイン記念として共有された特別スナップ。',
      descriptionEn: 'Unlocked upon completing your first Private Lounge link.',
      emotionTag: 'HAPPY',
      rarity: 'UR',
      previewAssetPath: 'assets/gallery_morning.webp',
      unlocked: true,
      unlockedAt: '2026-11-22T12:08:00.000Z',
      sourceSessionId: 'sess_lounge_001',
    },
    {
      id: 'uid_preview_001_RW-02',
      uid: 'uid_preview_001',
      code: 'RW-02',
      titleJa: '渋谷ナイト・サイバーストリート',
      titleEn: 'Cyber Neon Street Walk',
      descriptionJa: '「Xでも音楽の話してくれたよね」と共鳴レベルが上がった瞬間に解放。',
      descriptionEn: 'Unlocked when syncing shared music & tech memories.',
      emotionTag: 'TEASING',
      rarity: 'SSR',
      previewAssetPath: 'assets/gallery_street.webp',
      unlocked: true,
      unlockedAt: '2026-11-22T12:12:00.000Z',
      sourceSessionId: 'sess_lounge_001',
    },
    {
      id: 'uid_preview_001_RW-03',
      uid: 'uid_preview_001',
      code: 'RW-03',
      titleJa: 'トワイライト・オーシャンブリーズ',
      titleEn: 'Twilight Ocean Breeze',
      descriptionJa: 'サポーターパス継続特典として解放されたプライベート思い出カット。',
      descriptionEn: 'Unlocked with active Supporter Pass resonance milestone.',
      emotionTag: 'SHY',
      rarity: 'SSR',
      previewAssetPath: 'assets/gallery_beach.webp',
      unlocked: true,
      unlockedAt: '2026-11-22T12:18:00.000Z',
      sourceSessionId: 'sess_lounge_001',
    },
    {
      id: 'uid_preview_001_RW-04',
      uid: 'uid_preview_001',
      code: 'RW-04',
      titleJa: '深夜のカフェラテ・シークレット',
      titleEn: 'Midnight Espresso Secret',
      descriptionJa: '解禁条件：親愛度共鳴ランク EXCITED 到達で暗号解除。',
      descriptionEn: 'Condition: Reach EXCITED resonance state in private dialogue.',
      emotionTag: 'EXCITED',
      rarity: 'UR',
      previewAssetPath: '',
      unlocked: false,
    },
    {
      id: 'uid_preview_001_RW-05',
      uid: 'uid_preview_001',
      code: 'RW-05',
      titleJa: 'Gemitec ラボ・ホログラス衣装',
      titleEn: 'Gemitec Hologlass Lab Ver.',
      descriptionJa: '解禁条件：技術トピックについて5ターン以上語り合うと解除。',
      descriptionEn: 'Condition: Discuss tech projects for 5 turns in Private Lounge.',
      emotionTag: 'THOUGHTFUL',
      rarity: 'SR',
      previewAssetPath: '',
      unlocked: false,
    },
    {
      id: 'uid_preview_001_RW-06',
      uid: 'uid_preview_001',
      code: 'RW-06',
      titleJa: 'VIP ミッドナイト・セレブレーション',
      titleEn: 'VIP Midnight Celebration',
      descriptionJa: '解禁条件：累計30ターンの対話達成で特別解放。',
      descriptionEn: 'Condition: Complete 30 private turns to decrypt illustration.',
      emotionTag: 'HAPPY',
      rarity: 'UR',
      previewAssetPath: '',
      unlocked: false,
    },
  ];

  /** @inheritdoc */
  public async getRuntimeConfig(): Promise<LoungeRuntimeConfigDto> {
    const fallbackConfig: LoungeRuntimeConfigDto = {
      appVersion: environment.appVersion,
      disclaimerVersion: environment.disclaimerVersion,
      persona: { ...environment.persona },
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
        typeof parsed.disclaimerVersion === 'string' &&
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
      // Static preview or offline mode falls back to configured environment placeholder.
    }

    this.resolvedRuntimeConfig = fallbackConfig;
    return fallbackConfig;
  }

  /** @inheritdoc */
  public async getCurrentSession(): Promise<LoungeAuthSessionDto | null> {
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
    const now = new Date().toISOString();
    this.user = {
      ...this.createPreviewUser(now),
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
  }

  /** @inheritdoc */
  public async getAccountSummary(): Promise<LoungeAccountSummaryDto> {
    const activeUser = this.user ?? this.createPreviewUser(new Date().toISOString());
    const unlockedCount = this.rewards.filter((item) => item.unlocked).length;
    return {
      user: activeUser,
      subscription: this.subscription,
      persona: this.resolvedRuntimeConfig?.persona ?? { ...environment.persona },
      publicXMemoryOneWayActive: true,
      unlockedRewardCount: unlockedCount,
      totalRewardCount: this.rewards.length,
      appVersion: this.resolvedRuntimeConfig?.appVersion ?? environment.appVersion,
    };
  }

  /** @inheritdoc */
  public async listSessions(): Promise<LoungeSessionListResponseDto> {
    return {
      items: [this.session],
      nextCursor: null,
      totalCount: 1,
    };
  }

  /** @inheritdoc */
  public async createSession(request: LoungeCreateSessionRequestDto): Promise<LoungeSession> {
    const now = new Date().toISOString();
    this.messages = [];
    this.session = {
      ...this.session,
      id: `sess_${Date.now()}`,
      title: request.title?.trim() || 'NEON LOUNGE // NEW SESSION',
      messageCount: 0,
      currentEmotion: 'NEUTRAL',
      lastMessagePreview: '',
      createdAt: now,
      updatedAt: now,
    };
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
    sessionId: string,
    request: LoungeSendMessageRequestDto,
  ): Promise<LoungeSendMessageResponseDto> {
    const trimmed = request.content.trim();
    if (!trimmed) {
      throw new Error('Message content cannot be empty');
    }
    if (this.subscription.remainingChatTurns <= 0) {
      throw new Error('Daily chat turn quota exhausted');
    }

    const now = new Date().toISOString();
    const userMessage: LoungeMessage = {
      id: `msg_${Date.now()}_u`,
      sessionId,
      uid: 'uid_preview_001',
      role: 'USER',
      content: trimmed,
      emotion: 'NEUTRAL',
      createdAt: now,
    };
    const assistantMessage: LoungeMessage = {
      id: `msg_${Date.now()}_a`,
      sessionId,
      uid: 'uid_preview_001',
      role: 'ASSISTANT',
      content: `なるほど、「${trimmed.slice(0, 28)}」だねっ！プライベートラウンジだから、もっと深く話聞かせてよ。`,
      emotion: 'EXCITED',
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
    };
  }

  /** @inheritdoc */
  public async listRewards(): Promise<LoungeRewardListResponseDto> {
    const unlockedCount = this.rewards.filter((item) => item.unlocked).length;
    return {
      items: [...this.rewards],
      unlockedCount,
      totalCount: this.rewards.length,
      nextCursor: null,
    };
  }

  private createPreviewUser(now: string): LoungeUser {
    return {
      uid: 'uid_preview_001',
      xUserId: '1000000001',
      xHandle: '@cyber_runner_01',
      displayName: 'Cyber Runner 01',
      avatarUrl: 'assets/gemitec_icon.svg',
      status: 'ACTIVE',
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
