import type {
  LoungeCreateSessionRequestDto,
  LoungeMessageListResponseDto,
  LoungeSendMessageRequestDto,
  LoungeSendMessageResponseDto,
  LoungeSession,
  LoungeSessionListResponseDto,
} from '@rebecca/types';
import {
  LoungeAuthError,
  LoungeNotFoundError,
  LoungeQuotaExhaustedError,
  LoungeValidationError,
  normalizePaginationLimit,
} from '../../../utils/errors';
import type { ILoungeAccountRepository } from '../../account/repositories/loungeAccount.repository';
import type { ILoungeAuthRepository } from '../../auth/repositories/loungeAuth.repository';
import type { ILoungeRewardRepository } from '../../rewards/repositories/loungeReward.repository';
import type {
  ILoungeChatPipelinePort,
  ILoungeEmotionClassifierPort,
  IPublicXMemoryReadPort,
} from '../ports/loungeAi.port';
import type { ILoungeSessionRepository } from '../repositories/loungeSession.repository';

/** Maximum allowed length of a single user prompt in characters. */
export const MAX_LOUNGE_MESSAGE_LENGTH = 4000;

/** Maximum allowed length of a session title in characters. */
export const MAX_LOUNGE_TITLE_LENGTH = 120;

/**
 * Use case contract for managing isolated Private Lounge sessions and interactive turns.
 */
export interface ILoungeSessionUseCase {
  listSessions(
    uid: string,
    limit?: number,
    startAfterId?: string,
  ): Promise<LoungeSessionListResponseDto>;
  createSession(
    uid: string,
    xUserId: string,
    request: LoungeCreateSessionRequestDto,
  ): Promise<LoungeSession>;
  listMessages(
    uid: string,
    sessionId: string,
    limit?: number,
    startAfterId?: string,
  ): Promise<LoungeMessageListResponseDto>;
  sendMessage(
    uid: string,
    xUserId: string,
    sessionId: string,
    request: LoungeSendMessageRequestDto,
  ): Promise<LoungeSendMessageResponseDto>;
}

/**
 * Coordinates isolated Lounge sessions, account/subscription checks, quota verification,
 * read-only X memory lookup, emotion classification, and Gemini reply generation.
 */
export class LoungeSessionUseCase implements ILoungeSessionUseCase {
  constructor(
    private readonly sessionRepository: ILoungeSessionRepository,
    private readonly authRepository: ILoungeAuthRepository,
    private readonly accountRepository: ILoungeAccountRepository,
    private readonly rewardRepository: ILoungeRewardRepository,
    private readonly publicXMemoryPort: IPublicXMemoryReadPort,
    private readonly emotionClassifier: ILoungeEmotionClassifierPort,
    private readonly chatPipeline: ILoungeChatPipelinePort,
  ) {}

  /** Returns bounded paginated conversation sessions owned by `uid`. */
  public async listSessions(
    uid: string,
    limit?: number,
    startAfterId?: string,
  ): Promise<LoungeSessionListResponseDto> {
    const safeLimit = normalizePaginationLimit(limit);
    return this.sessionRepository.listSessions(uid, safeLimit, startAfterId);
  }

  /**
   * Starts a new Private Lounge thread tagged with read-only Public X memory sync time.
   *
   * @throws LoungeValidationError When `title` exceeds `MAX_LOUNGE_TITLE_LENGTH`.
   */
  public async createSession(
    uid: string,
    xUserId: string,
    request: LoungeCreateSessionRequestDto,
  ): Promise<LoungeSession> {
    const title = request.title?.trim() || 'Private Lounge Session';
    if (title.length > MAX_LOUNGE_TITLE_LENGTH) {
      throw new LoungeValidationError(
        `Session title exceeds maximum length of ${MAX_LOUNGE_TITLE_LENGTH} characters`,
      );
    }
    const snapshot = await this.publicXMemoryPort.readPublicXUserSnapshot(xUserId);
    const syncedAt = snapshot?.syncedAt ?? new Date().toISOString();
    return this.sessionRepository.createSession(uid, title, syncedAt);
  }

  /** Lists paginated messages for a session verified to belong to `uid`. */
  public async listMessages(
    uid: string,
    sessionId: string,
    limit?: number,
    startAfterId?: string,
  ): Promise<LoungeMessageListResponseDto> {
    const session = await this.sessionRepository.getSessionById(sessionId);
    if (!session || session.uid !== uid) {
      throw new LoungeNotFoundError(`Lounge session "${sessionId}" was not found`);
    }
    const safeLimit = normalizePaginationLimit(limit);
    return this.sessionRepository.listMessages(sessionId, safeLimit, startAfterId);
  }

  /**
   * Validates prompt, user/subscription status, and quota, reads one-way X context,
   * generates assistant reply, unlocks triggered rewards, and persists the turn pair.
   * Note: Concrete Firestore implementation should wrap quota reservation and message
   * persistence in a transaction or idempotency key guard to prevent concurrent races.
   *
   * @throws LoungeValidationError When prompt is empty or exceeds `MAX_LOUNGE_MESSAGE_LENGTH`.
   * @throws LoungeAuthError When user account or subscription status is not `ACTIVE`.
   * @throws LoungeNotFoundError When `sessionId` or subscription does not exist or mismatches owner.
   * @throws LoungeQuotaExhaustedError When daily `remainingChatTurns` is 0 or less.
   */
  public async sendMessage(
    uid: string,
    xUserId: string,
    sessionId: string,
    request: LoungeSendMessageRequestDto,
  ): Promise<LoungeSendMessageResponseDto> {
    const content = request.content.trim();
    if (!content) {
      throw new LoungeValidationError('Message content must not be empty');
    }
    if (content.length > MAX_LOUNGE_MESSAGE_LENGTH) {
      throw new LoungeValidationError(
        `Message content exceeds maximum length of ${MAX_LOUNGE_MESSAGE_LENGTH} characters`,
      );
    }

    const user = await this.authRepository.findUserByUid(uid);
    if (!user) {
      throw new LoungeAuthError(401, 'Private Lounge user profile not found');
    }
    if (user.status !== 'ACTIVE') {
      throw new LoungeAuthError(403, 'Private Lounge account is suspended');
    }

    const session = await this.sessionRepository.getSessionById(sessionId);
    if (!session || session.uid !== uid) {
      throw new LoungeNotFoundError(`Lounge session "${sessionId}" was not found`);
    }

    const subscription = await this.accountRepository.getSubscriptionByUid(uid);
    if (!subscription) {
      throw new LoungeNotFoundError(`Lounge subscription for user "${uid}" was not found`);
    }
    if (subscription.status !== 'ACTIVE') {
      throw new LoungeAuthError(403, 'Lounge subscription is not active');
    }
    if (subscription.remainingChatTurns <= 0) {
      throw new LoungeQuotaExhaustedError('Daily chat turn quota has been exhausted');
    }

    const [userEmotion, recentPage, privateRagMemories, publicXSnapshot] = await Promise.all([
      this.emotionClassifier.classifyEmotion(content),
      this.sessionRepository.listMessages(sessionId, 20),
      this.sessionRepository.listRagMemories(uid, 10),
      this.publicXMemoryPort.readPublicXUserSnapshot(xUserId),
    ]);

    const pipelineResult = await this.chatPipeline.generateReply({
      uid,
      session,
      userPrompt: content,
      recentMessages: recentPage.items,
      privateRagMemories,
      publicXSnapshot,
    });

    const updatedSub = await this.accountRepository.decrementRemainingTurns(uid);
    const unlockedReward = pipelineResult.unlockedRewardCode
      ? await this.rewardRepository.unlockReward(uid, pipelineResult.unlockedRewardCode, sessionId)
      : undefined;

    const persisted = await this.sessionRepository.appendMessagePair({
      uid,
      sessionId,
      userContent: content,
      userEmotion,
      assistantContent: pipelineResult.replyText,
      assistantEmotion: pipelineResult.emotion,
      assistantTokenUsage: pipelineResult.tokenUsage,
      unlockedRewardId: unlockedReward?.id,
    });

    return {
      session: persisted.session,
      userMessage: persisted.userMessage,
      assistantMessage: persisted.assistantMessage,
      remainingChatTurns: updatedSub.remainingChatTurns,
      ...(unlockedReward ? { unlockedReward } : {}),
    };
  }
}
