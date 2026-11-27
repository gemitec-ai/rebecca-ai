import { createTurnPair } from '@rebecca/memory';
import {
  CURRENT_LOUNGE_DISCLAIMER_VERSION,
  type LoungeMessageListResponseDto,
  type LoungePaginationQueryDto,
  type LoungePrivateMemorySnapshot,
  type LoungeSendMessageRequestDto,
  type LoungeSendMessageResponseDto,
  type LoungeSession,
  type LoungeTokenUsage,
} from '@rebecca/types';
import { requireActiveGeoEligibleUser } from '../../../domain/loungeAccessPolicy';
import {
  type LoungeGeoCompliancePolicy,
  type ResolvedClientGeo,
} from '../../../utils/clientGeo';
import {
  LoungeDisclaimerReconsentRequiredError,
  LoungeQuotaExhaustedError,
  normalizePaginationQuery,
} from '../../../utils/errors';
import { loungeLogger, toSingleLineLog } from '../../../utils/logger';
import { LOUNGE_DAILY_SEARCH_LIMITS } from '../../billing/domain/loungeCatalog.constants';
import type { ILoungeAccountRepository } from '../../account/repositories/loungeAccount.repository';
import type { ILoungeAuthRepository } from '../../auth/repositories/loungeAuth.repository';
import type { ILoungeGalleryRepository } from '../../gallery/repositories/loungeGallery.repository';
import type { ILoungeIllustrationMatcherService } from '../domain/loungeIllustrationMatcher.service';
import type {
  ILoungeChatPipelinePort,
  ILoungeEmbeddingPort,
  ILoungeEmotionClassifierPort,
  IPublicXMemoryReadPort,
} from '../ports/loungeAi.port';
import type { ILoungeSessionRepository } from '../repositories/loungeSession.repository';
import { parseAndValidateSendMessageRequest } from '../validators/loungeSession.validator';

/** Maximum total character budget of raw conversation history injected into Gemini Flash-Lite. */
export const MAX_LOUNGE_HISTORY_WINDOW_CHARS = 3000;

/** Use case contract for the single-session-per-user Private Lounge conversation experience. */
export interface ILoungeSessionUseCase {
  /**
   * Returns or initializes the caller's single continuous Private Lounge conversation session.
   *
   * @throws LoungeAuthError When user profile is missing (`401`) or suspended (`403`).
   * @throws LoungeForbiddenError When Phase 1 Geo-IP policy blocks the region or geo is unavailable (`403`).
   */
  getSession(
    uid: string,
    xUserId: string,
    clientGeo?: ResolvedClientGeo,
    traceHeader?: string,
  ): Promise<LoungeSession>;
  /**
   * Lists paginated messages for the caller's session with unified bounds/cursor validation.
   *
   * @throws LoungeAuthError When user profile is missing (`401`) or suspended (`403`).
   * @throws LoungeForbiddenError When Phase 1 Geo-IP policy blocks the region or geo is unavailable (`403`).
   * @throws LoungeValidationError When cursor validation fails (`400`).
   */
  listMessages(
    uid: string,
    query?: LoungePaginationQueryDto,
    clientGeo?: ResolvedClientGeo,
  ): Promise<LoungeMessageListResponseDto>;
  /**
   * Executes one interactive conversation turn inside the user's single persistent session.
   *
   * @throws LoungeForbiddenError When Phase 1 Geo-IP blocks access (`403`).
   * @throws LoungeValidationError When prompt is invalid (`400`).
   * @throws LoungeAuthError When user profile is missing (`401`) or suspended (`403`).
   * @throws LoungeDisclaimerReconsentRequiredError When disclaimer re-consent is required (`403`).
   * @throws LoungeNotFoundError When subscription record is missing (`404`).
   * @throws LoungeQuotaExhaustedError When daily/purchased turn quota is exhausted or concurrent turn is active (`429`).
   */
  sendMessage(
    uid: string,
    xUserId: string,
    request: LoungeSendMessageRequestDto,
    clientGeo?: ResolvedClientGeo,
    traceHeader?: string,
  ): Promise<LoungeSendMessageResponseDto>;
}

/** Slices trailing history turns to fit strictly within `maxChars` character budget. */
export function sliceRecentMessagesByCharBudget<T extends { readonly content: string }>(
  messages: ReadonlyArray<T>,
  maxChars: number = MAX_LOUNGE_HISTORY_WINDOW_CHARS,
): T[] {
  const selected: T[] = [];
  let accumulated = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (selected.length > 0 && accumulated + msg.content.length > maxChars) {
      break;
    }
    selected.unshift(msg);
    accumulated += msg.content.length;
  }
  return selected;
}

/**
 * Coordinates the single persistent Private Lounge thread per user, two-layer memory assembly,
 * autonomous `search_web` loop, post-reply LLM emotion classification, 3-stage illustration matching,
 * and atomic quota reservation/compensation.
 */
export class LoungeSessionUseCase implements ILoungeSessionUseCase {
  private readonly inFlightUids = new Set<string>();
  private dailyTurnUtcDate = new Date().toISOString().slice(0, 10);
  private dailyTurnCount = 0;

  constructor(
    private readonly sessionRepository: ILoungeSessionRepository,
    private readonly authRepository: ILoungeAuthRepository,
    private readonly accountRepository: ILoungeAccountRepository,
    private readonly galleryRepository: ILoungeGalleryRepository,
    private readonly embeddingPort: ILoungeEmbeddingPort,
    private readonly publicXMemoryPort: IPublicXMemoryReadPort,
    private readonly emotionClassifier: ILoungeEmotionClassifierPort,
    private readonly chatPipeline: ILoungeChatPipelinePort,
    private readonly illustrationMatcher: ILoungeIllustrationMatcherService,
    private readonly requiredDisclaimerVersion: number = CURRENT_LOUNGE_DISCLAIMER_VERSION,
    private readonly globalDailyTurnCap: number = 50000,
    private readonly geoPolicy: LoungeGeoCompliancePolicy = {
      phase2EeaEnabled: false,
      allowDefaultGeoFallback: true,
    },
  ) {}

  /**
   * Returns (or initializes) the caller's single continuous Private Lounge conversation session
   * after verifying regional Phase 1/2 compliance. Avoids reading Public X collections if the session already exists.
   *
   * @throws LoungeAuthError When user profile is missing (`401`) or suspended (`403`).
   * @throws LoungeForbiddenError When Phase 1 blocks EEA/UK/CH regions (`403 GEO_BLOCKED`) or Geo-IP is unavailable (`403 GEO_UNAVAILABLE`).
   */
  public async getSession(
    uid: string,
    xUserId: string,
    clientGeo?: ResolvedClientGeo,
    traceHeader?: string,
  ): Promise<LoungeSession> {
    const user = await requireActiveGeoEligibleUser(
      this.authRepository,
      uid,
      clientGeo,
      this.geoPolicy,
    );
    const existing = await this.sessionRepository.findSessionByUid(uid);
    if (existing) {
      return existing;
    }
    const snapshot = await this.publicXMemoryPort.readPublicXMemorySnapshot(
      xUserId,
      [],
      user.timezone,
    );
    const syncedAt = snapshot?.syncedAt ?? new Date().toISOString();
    const session = await this.sessionRepository.getOrCreateSingletonSession(uid, syncedAt);
    loungeLogger.info('Initialized Private Lounge singleton session', { uid }, traceHeader);
    return session;
  }

  /**
   * Lists paginated messages for the caller's single persistent Private Lounge session using
   * unified pagination bounds (`page`, `[1, 100]` `limit`, optional `cursor`) after Geo-IP checks.
   *
   * @throws LoungeAuthError When user profile is missing (`401`) or suspended (`403`).
   * @throws LoungeForbiddenError When Phase 1 blocks EEA/UK/CH regions (`403 GEO_BLOCKED`) or Geo-IP is unavailable (`403 GEO_UNAVAILABLE`).
   * @throws LoungeValidationError When pagination cursor is invalid (`400`).
   */
  public async listMessages(
    uid: string,
    query?: LoungePaginationQueryDto,
    clientGeo?: ResolvedClientGeo,
  ): Promise<LoungeMessageListResponseDto> {
    await requireActiveGeoEligibleUser(this.authRepository, uid, clientGeo, this.geoPolicy);
    const safeQuery = normalizePaginationQuery(query);
    return this.sessionRepository.listMessages(uid, safeQuery);
  }

  /**
   * Executes one interactive conversation turn inside the user's single persistent session.
   *
   * @throws LoungeForbiddenError When Phase 1 blocks EEA/UK/CH regions (`403 GEO_BLOCKED`) or Geo-IP is unavailable (`403 GEO_UNAVAILABLE`).
   * @throws LoungeValidationError When prompt is empty or exceeds `MAX_LOUNGE_MESSAGE_LENGTH`.
   * @throws LoungeAuthError When user account is missing/suspended.
   * @throws LoungeDisclaimerReconsentRequiredError When accepted disclaimer version is below required version (`403`).
   * @throws LoungeNotFoundError When subscription does not exist.
   * @throws LoungeQuotaExhaustedError When daily `remainingChatTurns` is 0 or less.
   */
  public async sendMessage(
    uid: string,
    xUserId: string,
    request: LoungeSendMessageRequestDto,
    clientGeo?: ResolvedClientGeo,
    traceHeader?: string,
  ): Promise<LoungeSendMessageResponseDto> {
    const { content } = parseAndValidateSendMessageRequest(request);

    const todayUtc = new Date().toISOString().slice(0, 10);
    if (todayUtc !== this.dailyTurnUtcDate) {
      this.dailyTurnUtcDate = todayUtc;
      this.dailyTurnCount = 0;
    }
    if (this.dailyTurnCount >= this.globalDailyTurnCap) {
      throw new LoungeQuotaExhaustedError('Service daily turn capacity reached; please retry later');
    }
    if (this.inFlightUids.has(uid)) {
      throw new LoungeQuotaExhaustedError('A response is currently being generated; please wait a moment');
    }

    // Reserve global circuit-breaker slot & per-user turn lock synchronously before awaiting I/O.
    this.dailyTurnCount += 1;
    this.inFlightUids.add(uid);
    let reservationReceipt: Awaited<ReturnType<ILoungeAccountRepository['reserveTurnForSession']>> | null = null;
    let turnCommitted = false;

    try {
      const user = await requireActiveGeoEligibleUser(
        this.authRepository,
        uid,
        clientGeo,
        this.geoPolicy,
      );

      if (user.disclaimerConsent.disclaimerVersion < this.requiredDisclaimerVersion) {
        throw new LoungeDisclaimerReconsentRequiredError(
          this.requiredDisclaimerVersion,
          user.disclaimerConsent.disclaimerVersion,
        );
      }

      const turnReferenceId = `turn_${Date.now()}_${uid.slice(0, 8)}`;
      reservationReceipt = await this.accountRepository.reserveTurnForSession(uid, turnReferenceId);

      const activeSub = reservationReceipt.subscription;
      const isPaidSearchEligible =
        (activeSub.tier === 'STANDARD' &&
          (activeSub.status === 'ACTIVE' || activeSub.status === 'CANCELING')) ||
        reservationReceipt.source === 'LOT' ||
        activeSub.purchasedRemainingTurns > 0;
      const maxSearchPerDay = isPaidSearchEligible
        ? LOUNGE_DAILY_SEARCH_LIMITS.PAID_OR_STANDARD
        : LOUNGE_DAILY_SEARCH_LIMITS.FREE;
      const allowWebSearch = reservationReceipt.todaysSearchCount < maxSearchPerDay;

      const [queryEmbedding, recentMessagesRaw, existingSession] = await Promise.all([
        this.embeddingPort.embedQuery(content),
        this.sessionRepository.listRecentMessages(uid, 20),
        this.sessionRepository.findSessionByUid(uid),
      ]);
      const recentMessages = sliceRecentMessagesByCharBudget(
        recentMessagesRaw,
        MAX_LOUNGE_HISTORY_WINDOW_CHARS,
      );

      const [privateRagMemories, publicXMemory] = await Promise.all([
        this.sessionRepository.searchPrivateRagMemoriesByVector(uid, queryEmbedding, 4),
        this.publicXMemoryPort.readPublicXMemorySnapshot(xUserId, queryEmbedding, user.timezone),
      ]);

      const session =
        existingSession ??
        (await this.sessionRepository.getOrCreateSingletonSession(
          uid,
          publicXMemory?.syncedAt ?? new Date().toISOString(),
        ));

      let lastReplyAt: string | undefined;
      for (let i = recentMessages.length - 1; i >= 0; i -= 1) {
        if (recentMessages[i].role === 'ASSISTANT') {
          lastReplyAt = recentMessages[i].createdAt;
          break;
        }
      }
      if (!lastReplyAt && session.messageCount > 0) {
        lastReplyAt = session.updatedAt;
      }

      const privateMemory: LoungePrivateMemorySnapshot = {
        coreProfile: user.coreProfile ?? {},
        recentRawMessages: recentMessages,
        vectorMemories: privateRagMemories,
        lastDreamedAt: user.lastDreamedAt,
        ...(lastReplyAt ? { lastReplyAt } : {}),
      };

      const pipelineResult = await this.chatPipeline.generateReply({
        uid,
        session,
        userPrompt: content,
        userDisplayName: user.displayName,
        userXHandle: user.xHandle,
        queryEmbedding,
        privateMemory,
        publicXMemory,
        responseLanguage: user.language,
        userTimezone: user.timezone,
        allowWebSearch,
      });

      const totalTokenUsage: LoungeTokenUsage = {
        promptTokens: pipelineResult.tokenUsage.promptTokens,
        candidatesTokens: pipelineResult.tokenUsage.candidatesTokens,
        totalTokens: pipelineResult.tokenUsage.totalTokens,
      };
      const addTokenUsage = (usage: LoungeTokenUsage): void => {
        totalTokenUsage.promptTokens += usage.promptTokens;
        totalTokenUsage.candidatesTokens += usage.candidatesTokens;
        totalTokenUsage.totalTokens += usage.totalTokens;
      };

      const assistantEmotion = await this.emotionClassifier.classifyEmotion({
        userPrompt: content,
        thought: pipelineResult.thought,
        replyText: pipelineResult.replyText,
        onTokenUsage: addTokenUsage,
      });

      const matchedImage = await this.illustrationMatcher.matchIllustration({
        userPrompt: content,
        thought: pipelineResult.thought,
        replyText: pipelineResult.replyText,
        recentMessages,
        onTokenUsage: addTokenUsage,
      });

      const persisted = await this.sessionRepository.appendMessagePair({
        uid,
        sessionId: session.id,
        userContent: content,
        userEmotion: 'NEUTRAL',
        assistantContent: pipelineResult.replyText,
        assistantThought: pipelineResult.thought,
        assistantEmotion,
        assistantTokenUsage: totalTokenUsage,
        imageAssetId: matchedImage?.assetId,
        imageUrl: matchedImage?.imageUrl,
        publicXMemorySyncedAt: publicXMemory?.syncedAt,
      });

      // Turn is permanently committed in Firestore; post-commit enrichment must never refund or fail the request.
      turnCommitted = true;
      reservationReceipt = null;

      const unlockedGalleryItem = matchedImage
        ? ((await this.galleryRepository
            .unlockGalleryItem(uid, matchedImage.assetId, matchedImage.imageUrl, session.id)
            .catch((galleryErr) => {
              loungeLogger.warn(
                'Gallery unlock failed cleanly after reply commit',
                {
                  uid,
                  assetId: matchedImage.assetId,
                  reason: toSingleLineLog(
                    galleryErr instanceof Error ? galleryErr.message : String(galleryErr),
                  ),
                },
                traceHeader,
              );
              return null;
            })) ?? undefined)
        : undefined;

      let latestSubscription = activeSub;
      if (pipelineResult.usedWebSearch) {
        const refreshedSub = await this.accountRepository
          .incrementDailySearchCount(uid)
          .catch((searchErr) => {
            loungeLogger.warn(
              'Daily search count increment failed cleanly after reply commit',
              {
                uid,
                reason: toSingleLineLog(
                  searchErr instanceof Error ? searchErr.message : String(searchErr),
                ),
              },
              traceHeader,
            );
            return null;
          });
        if (refreshedSub) {
          latestSubscription = refreshedSub;
        }
      }

      const turnSummary = `User: ${content.slice(0, 300)}\nAssistant: ${pipelineResult.replyText.slice(0, 300)}`;
      const turnTimestamp = persisted.assistantMessage.createdAt;
      const computedTurnEmbedding = await this.embeddingPort.embedQuery(turnSummary).catch(() => []);
      const turnEmbedding =
        computedTurnEmbedding.length > 0 ? computedTurnEmbedding : queryEmbedding;
      await this.sessionRepository
        .indexPrivateTurnMemory({
          uid,
          sessionId: session.id,
          category: 'EPISODE',
          summary: turnSummary,
          embedding: turnEmbedding,
          salienceScore: matchedImage ? 0.85 : 0.65,
          episodicEntries: createTurnPair(
            content,
            pipelineResult.replyText,
            pipelineResult.thought,
            turnTimestamp,
          ),
        })
        .catch((indexErr) => {
          loungeLogger.warn(
            'Private RAG turn indexing failed after reply commit',
            {
              uid,
              reason: toSingleLineLog(
                indexErr instanceof Error ? indexErr.message : String(indexErr),
              ),
            },
            traceHeader,
          );
        });

      return {
        session: persisted.session,
        userMessage: persisted.userMessage,
        assistantMessage: persisted.assistantMessage,
        remainingChatTurns: latestSubscription.remainingChatTurns,
        subscription: latestSubscription,
        ...(unlockedGalleryItem ? { unlockedGalleryItem } : {}),
      };
    } catch (err) {
      if (!turnCommitted) {
        this.dailyTurnCount = Math.max(0, this.dailyTurnCount - 1);
      }
      if (reservationReceipt) {
        await this.accountRepository
          .compensateTurnForSession(reservationReceipt)
          .catch((compErr) => {
            loungeLogger.error(
              'Failed to compensate reserved chat turn after pipeline failure',
              compErr instanceof Error ? compErr : new Error(String(compErr)),
              { uid },
              traceHeader,
            );
          });
      }
      throw err;
    } finally {
      this.inFlightUids.delete(uid);
    }
  }
}
