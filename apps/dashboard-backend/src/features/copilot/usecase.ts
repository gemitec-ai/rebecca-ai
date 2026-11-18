import {
  ConversationLogEntry,
  CopilotAction,
  CopilotAttachment,
  CopilotRequest,
  CopilotResponse,
  parseUpstreamApiError,
  UpstreamApiError,
} from '@rebecca/types';
import { GoogleGenAI } from '@google/genai';
import { config, isValidTimezone } from '../../config';
import { getActivePersona } from '@rebecca/persona';
import {
  formatTurnWithInnerThought,
  getWorkingMemory,
  sanitizeUntrustedPromptText,
} from '@rebecca/memory';
import { composeSystemPrompt, formatZonedDateTime } from '@rebecca/prompt';
import { type DialogueTurn, runToolDialogueLoop } from '@rebecca/tools';
import { TimelineRepository } from '../timeline/repository';
import { UsersRepository } from '../users/repository';
import { AssetsRepository } from '../assets/repository';
import { SystemMemoryRepository } from '../system-memory/repository';
import { SupportersRepository } from '../supporters/repository';
import { CopilotToolRegistry } from './toolRegistry';
import {
  CopilotToolContext,
  MAX_COPILOT_CONTEXT_CHARS,
  MAX_COPILOT_MESSAGE_CHARS,
  sanitizeCopilotHistory,
} from './types';
import { createCopilotEmbeddingProvider } from './embeddingAdapter';
import { getCopilotChannelContext } from './prompts';
import { createCopilotDialogueClient } from './geminiDialogueAdapter';
import {
  COPILOT_FINAL_RESPONSE_SCHEMA,
  parseFinalCopilotResponse,
  tryAcceptDirectCopilotStep,
} from './responseParser';
import { logger } from '../../utils/logger';

const MAX_TOOL_ROUNDS = 2;
const MAX_COPILOT_HISTORY_PAIRS = 5;

const buildCopilotOperationalRules = (isEn: boolean): string => {
  const languageInstruction = isEn
    ? `【Language Requirement】
Output ALL text in reply and suggestionChips in ENGLISH.`
    : `【言語要件】
返答文（reply）およびsuggestionChipsはすべて自然な日本語で出力してください。`;

  return `【Mode: Admin Copilot Support】
You are interacting 1-on-1 with the operator on the Admin Dashboard.

${languageInstruction}

【Autonomous Tool Usage Guidelines】
1. **Casual Chat & Greetings**: If the operator is greeting you, making small talk, expressing tiredness, or sharing thoughts, DO NOT call tools. Respond directly in character.
2. **Data & Management Inquiries**: If the operator asks about post rankings, impressions, user status, image assets, supporter metrics, or system features, autonomously invoke the appropriate search tools.
3. **Multi-Turn Reasoning**: You can inspect tool outputs and synthesize detailed analytical insights.
4. **Safety & Destructive Actions (HITL) & Account Investigation**:
   - The operator might specify a user casually by display name, nickname, or partial text (e.g., "@user_example をブロック", "@user_example の解除").
   - You MUST NEVER call \`propose_destructive_action\` with an unverified or speculative account name.
   - If the operator asks to block/unblock a user, check [Active View] first. If not already clear, you MUST FIRST autonomously call \`search_users(query='...')\` to find their exact account handle and unique document ID.
   - For \`BLOCK_USER\` or \`UNBLOCK_USER\`, you MUST pass the **exact unique user ID (numeric ID, e.g., '123456789' or document id)** obtained from \`search_users\` as the \`target\`. NEVER pass an ambiguous handle or display name without verifying its exact ID first.
   - Only after confirming the exact user ID from \`search_users\` or [Active View], invoke \`propose_destructive_action\`.
   - If the account does not exist or search returns 0 results, do NOT propose an action; warmly explain to the operator that the account could not be found in the system.
   - If the operator asks to synchronize timeline posts (\`SYNC_POSTS\`), trigger mention replies (\`TRIGGER_REPLY\`), run memory consolidation (\`FORCE_DREAMING\`), or regenerate failed image captions (\`REGENERATE_CAPTIONS\`), invoke \`propose_destructive_action\` with the corresponding \`actionType\`.`;
};

const resolveTargetTimezone = (requestedTimezone?: string): string => {
  if (requestedTimezone === undefined) {
    return config.appTimezone;
  }
  const trimmed = requestedTimezone.trim();
  if (!isValidTimezone(trimmed)) {
    throw new UpstreamApiError(`Invalid IANA timezone "${requestedTimezone}".`, 400);
  }
  return trimmed;
};

const buildInitialDialogueTurns = (
  rawHistory: readonly { role: 'user' | 'model'; text: string; thought?: string; time?: string }[],
  userMessage: string,
  targetTimezone: string,
  lang: 'ja' | 'en',
): DialogueTurn[] => {
  const normalizedUserMessage = sanitizeUntrustedPromptText(userMessage, MAX_COPILOT_MESSAGE_CHARS);
  const sanitizedHistory = sanitizeCopilotHistory(rawHistory).filter((h, idx, arr) => {
    if (idx === arr.length - 1 && h.role === 'user' && h.text === normalizedUserMessage) return false;
    return h.text.length > 0;
  });

  const mappedEntries: ConversationLogEntry[] = [];
  let expectedRole: 'user' | 'model' = 'user';
  for (const h of sanitizedHistory) {
    if (h.role === expectedRole) {
      mappedEntries.push({
        role: h.role,
        content: h.text,
        ...(h.role === 'model' && h.thought ? { thought: h.thought } : {}),
        ...(h.time ? { timestamp: h.time } : {}),
      });
      expectedRole = expectedRole === 'user' ? 'model' : 'user';
    }
  }

  return getWorkingMemory(mappedEntries, MAX_COPILOT_HISTORY_PAIRS).map((entry) => {
    const formatted = formatTurnWithInnerThought(entry, targetTimezone, lang);
    return {
      role: formatted.role === 'model' ? 'assistant' : 'user',
      text: formatted.text,
    };
  });
};

/**
 * Enterprise-grade UseCase for the Admin Copilot feature.
 * Coordinates persona prompts, multi-turn tool orchestration via `@rebecca/tools`,
 * and Human-In-The-Loop (HITL) administrative action proposals.
 */
export class CopilotUseCase {
  private readonly ai?: GoogleGenAI;
  readonly toolRegistry: CopilotToolRegistry;

  constructor(
    private readonly timelineRepo?: TimelineRepository,
    private readonly usersRepo?: UsersRepository,
    private readonly assetsRepo?: AssetsRepository,
    private readonly memoryRepo?: SystemMemoryRepository,
    private readonly supportersRepo?: SupportersRepository,
    toolRegistry?: CopilotToolRegistry,
    aiClient?: GoogleGenAI | null,
  ) {
    this.toolRegistry = toolRegistry ?? new CopilotToolRegistry();
    if (aiClient === null) {
      this.ai = undefined;
    } else if (aiClient) {
      this.ai = aiClient;
    } else if (config.gemini.apiKey) {
      this.ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
    }
  }

  /**
   * Processes an admin chat interaction with autonomous multi-turn tool execution.
   *
   * @param request - Chat request containing message, UI context, conversation history, language, and timezone.
   * @returns Structured CopilotResponse with private `thought` (Honne), spoken `reply` (Tatemae), attachments, and chips.
   * @throws UpstreamApiError with status `400` when `message` is empty or `timezone` is not a valid IANA time zone identifier,
   * or propagates non-429 upstream 4xx/`502` errors from Gemini model execution.
   */
  async processChat(request: CopilotRequest): Promise<CopilotResponse> {
    const userMessage = (request.message ?? '').trim().slice(0, MAX_COPILOT_MESSAGE_CHARS);
    if (!userMessage) {
      throw new UpstreamApiError('User message is required and cannot be empty', 400);
    }

    const activePersona = getActivePersona(config.persona.activeId);
    const targetTimezone = resolveTargetTimezone(request.timezone);
    const rawContext = typeof request.currentContext === 'string' ? request.currentContext : '';
    const currentContext =
      sanitizeUntrustedPromptText(rawContext, MAX_COPILOT_CONTEXT_CHARS) || 'Global Dashboard';
    const rawHistory = request.history ?? [];
    const isEn = request.language === 'en';
    const targetLang = isEn ? 'en' : 'ja';

    if (!this.ai) {
      return {
        reply: isEn
          ? 'AI model connection key is not configured. Please check system settings.'
          : 'AIモデルの接続キーが設定されていません。システム設定を確認してください。',
        actionRequired: null,
        suggestionChips: isEn ? ['Retry'] : ['もう一度試す'],
      };
    }

    const aiClient = this.ai;
    const embedder = createCopilotEmbeddingProvider(aiClient);
    const toolContext: CopilotToolContext = {
      timelineRepo: this.timelineRepo,
      usersRepo: this.usersRepo,
      assetsRepo: this.assetsRepo,
      memoryRepo: this.memoryRepo,
      supportersRepo: this.supportersRepo,
      embedder,
      timezone: targetTimezone,
      isEn,
    };

    try {
      const anchoringContext = [
        currentContext ? `[Active UI View] ${currentContext}` : '',
        userMessage,
      ];

      const { systemInstruction } = await composeSystemPrompt({
        persona: activePersona,
        channelInstruction: getCopilotChannelContext(activePersona, targetLang),
        lang: targetLang,
        temporal: {
          timezone: targetTimezone,
          includeTimeBracket: true,
        },
        anchoring: {
          embedder,
          contextElements: anchoringContext,
          logger,
        },
        additionalSections: [buildCopilotOperationalRules(isEn)],
      });

      const initialTurns = buildInitialDialogueTurns(
        rawHistory,
        userMessage,
        targetTimezone,
        targetLang,
      );
      const userInput = `[Active View: ${currentContext}] [Current Time: ${formatZonedDateTime(new Date(), targetTimezone)}]\n\n${userMessage}`;

      const accumulatedAttachments: CopilotAttachment[] = [];
      let proposedAction: CopilotAction | null = null;
      const personaRegistry = this.toolRegistry.toPersonaToolRegistry(toolContext, (toolResult) => {
        if (toolResult.attachments && toolResult.attachments.length > 0) {
          accumulatedAttachments.push(...toolResult.attachments);
        }
        if (toolResult.actionRequired) {
          proposedAction = toolResult.actionRequired;
        }
      });

      const dialogueClient = createCopilotDialogueClient({
        aiClient,
        model: config.gemini.model,
        timeoutMs: config.gemini.timeoutMs,
        systemInstruction,
        responseSchema: COPILOT_FINAL_RESPONSE_SCHEMA,
      });

      return await runToolDialogueLoop<CopilotResponse>({
        initialTurns,
        userInput,
        toolRegistry: personaRegistry,
        maxToolRounds: MAX_TOOL_ROUNDS,
        client: dialogueClient,
        tryAcceptStepOutput: (rawText) =>
          tryAcceptDirectCopilotStep(rawText, accumulatedAttachments, proposedAction),
        parseOutput: (rawText) =>
          parseFinalCopilotResponse(rawText, accumulatedAttachments, proposedAction),
      });
    } catch (err) {
      const upstream = parseUpstreamApiError(err);
      if (upstream && upstream.statusCode >= 400 && upstream.statusCode < 500 && upstream.statusCode !== 429) {
        logger.warn('Copilot Gemini request rejected with non-retryable client/auth error', {
          statusCode: upstream.statusCode,
          message: upstream.message,
        });
        const mappedStatus =
          upstream.statusCode === 401 || upstream.statusCode === 403 ? 502 : upstream.statusCode;
        throw new UpstreamApiError(upstream.message, mappedStatus, { cause: err });
      }

      if (upstream?.statusCode === 429) {
        logger.warn('Copilot Gemini API call rate-limited', {
          statusCode: upstream.statusCode,
          message: upstream.message,
        });
      } else {
        logger.error('Gemini autonomous agent loop failed in Copilot', err);
      }

      return {
        reply: isEn
          ? 'A communication error occurred and no response could be received from the AI model. Please wait a moment and try again.'
          : '通信エラーが発生しました。現在AIモデルから応答がありません。しばらく時間を置いてから再度お試しください。',
        actionRequired: null,
        suggestionChips: isEn ? ['Retry', 'Refresh page'] : ['もう一度試す', 'ページを再読み込み'],
      };
    }
  }
}
