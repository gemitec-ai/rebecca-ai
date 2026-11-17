import {
  ConversationLogEntry,
  CopilotAction,
  CopilotAttachment,
  CopilotRequest,
  CopilotResponse,
  parseUpstreamApiError,
} from '@rebecca/types';
import { Content, FunctionDeclaration, GoogleGenAI } from '@google/genai';
import { config, isValidTimezone } from '../../config';
import {
  createStructuredPersonaSchema,
  getActivePersona,
  parsePersonaJsonObject,
} from '@rebecca/persona';
import { formatTurnWithInnerThought } from '@rebecca/memory';
import { composeSystemPrompt, formatZonedDateTime } from '@rebecca/prompt';
import {
  type DialogueTurn,
  type ILLMToolDialogueClient,
  type JsonSchemaPrimitiveType,
  PersonaToolRegistry,
  runToolDialogueLoop,
  type ToolDeclaration,
  type ToolDialogueStepContext,
  type ToolParameterProperty,
  type ToolRoundRecord,
} from '@rebecca/tools';
import { TimelineRepository } from '../timeline/repository';
import { UsersRepository } from '../users/repository';
import { AssetsRepository } from '../assets/repository';
import { SystemMemoryRepository } from '../system-memory/repository';
import { SupportersRepository } from '../supporters/repository';
import { CopilotToolRegistry } from './toolRegistry';
import { CopilotToolContext } from './types';
import { createCopilotEmbeddingProvider } from './embeddingAdapter';
import { getCopilotChannelContext } from './prompts';
import { logger } from '../../utils/logger';

const MAX_TOOL_ROUNDS = 2;

const toNeutralParamType = (geminiType: unknown): JsonSchemaPrimitiveType => {
  const normalized = String(geminiType ?? 'STRING').toLowerCase();
  switch (normalized) {
    case 'number':
    case 'integer':
    case 'boolean':
    case 'array':
    case 'object':
      return normalized;
    default:
      return 'string';
  }
};

const toNeutralToolDeclaration = (decl: FunctionDeclaration): ToolDeclaration => {
  const properties: Record<string, ToolParameterProperty> = {};
  const rawProps = decl.parameters?.properties ?? {};
  for (const [key, prop] of Object.entries(rawProps)) {
    properties[key] = {
      type: toNeutralParamType(prop.type),
      description: prop.description ?? '',
      ...(Array.isArray(prop.enum) ? { enum: prop.enum.map(String) } : {}),
    };
  }
  return {
    name: decl.name ?? '',
    description: decl.description ?? '',
    parameters: {
      type: 'object',
      properties,
      required: Array.isArray(decl.parameters?.required) ? [...decl.parameters.required] : [],
    },
  };
};

const isGeminiContent = (value: unknown): value is Content => {
  return typeof value === 'object' && value !== null && 'parts' in value;
};

const toGeminiContents = (ctx: ToolDialogueStepContext): Content[] => {
  const contents: Content[] = ctx.initialTurns.map((turn) => ({
    role: turn.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: turn.text }],
  }));
  contents.push({ role: 'user', parts: [{ text: ctx.userInput }] });

  for (const round of ctx.rounds) {
    if (isGeminiContent(round.opaqueProviderTurn)) {
      contents.push(round.opaqueProviderTurn);
    }
    contents.push({
      role: 'user',
      parts: round.outcomes.map((outcome) => ({
        functionResponse: {
          name: outcome.name,
          response: outcome.result,
        },
      })),
    });
  }

  return contents;
};

/**
 * Resolves the target IANA time zone for Copilot temporal anchoring, validating any explicit UI
 * override at the boundary or falling back to `config.appTimezone` when omitted.
 *
 * @param requestedTimezone - Optional IANA time zone identifier sent by the client.
 * @returns Validated IANA time zone identifier.
 */
function resolveTargetTimezone(requestedTimezone?: string): string {
  if (requestedTimezone === undefined) {
    return config.appTimezone;
  }
  const trimmed = requestedTimezone.trim();
  if (!isValidTimezone(trimmed)) {
    throw new Error(`Invalid IANA timezone "${requestedTimezone}".`);
  }
  return trimmed;
}

/**
 * Enterprise-grade UseCase for the Admin Copilot feature.
 * Coordinates Rebecca persona prompts, autonomous Gemini function-calling ReAct loops,
 * and safety-gated Human-In-The-Loop (HITL) administrative action proposals.
 */
export class CopilotUseCase {
  private ai?: GoogleGenAI;
  readonly toolRegistry: CopilotToolRegistry;

  constructor(
    private readonly timelineRepo?: TimelineRepository,
    private readonly usersRepo?: UsersRepository,
    private readonly assetsRepo?: AssetsRepository,
    private readonly memoryRepo?: SystemMemoryRepository,
    private readonly supportersRepo?: SupportersRepository,
    toolRegistry?: CopilotToolRegistry,
    aiClient?: GoogleGenAI
  ) {
    this.toolRegistry = toolRegistry ?? new CopilotToolRegistry();
    if (aiClient) {
      this.ai = aiClient;
    } else if (config.gemini.apiKey) {
      this.ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
    }
  }

  /**
   * Processes an admin chat interaction with autonomous multi-turn tool execution.
   *
   * @param request - The chat request containing message, UI context, and conversation history.
   * @returns Structured CopilotResponse with reply, visual attachments, actions, and suggestion chips.
   */
  async processChat(request: CopilotRequest): Promise<CopilotResponse> {
    const userMessage = (request.message ?? '').trim();
    if (!userMessage) {
      throw new Error('User message is required and cannot be empty');
    }

    const targetTimezone = resolveTargetTimezone(request.timezone);
    const currentContext = request.currentContext ?? 'Global Dashboard';
    const rawHistory = request.history ?? [];
    const isEn = request.language === 'en';

    const toolContext: CopilotToolContext = {
      timelineRepo: this.timelineRepo,
      usersRepo: this.usersRepo,
      assetsRepo: this.assetsRepo,
      memoryRepo: this.memoryRepo,
      supportersRepo: this.supportersRepo,
      isEn
    };

    if (!this.ai) {
      return {
        reply: isEn
          ? 'Rebecca AI connection key is not configured.'
          : 'レベッカAIの接続キーが設定されていません。',
        actionRequired: null,
        suggestionChips: isEn ? ['Retry'] : ['もう一度試す']
      };
    }

    try {
      return await this.executeReActLoop(userMessage, currentContext, rawHistory, toolContext, isEn, targetTimezone);
    } catch (err) {
      const upstream = parseUpstreamApiError(err);
      if (upstream && (upstream.statusCode === 429 || (upstream.statusCode >= 400 && upstream.statusCode < 500))) {
        logger.warn('Copilot Gemini API call rate-limited or rejected', {
          statusCode: upstream.statusCode,
          message: upstream.message,
        });
      } else {
        logger.error('Gemini autonomous agent loop failed in Copilot', err);
      }
      return {
        reply: isEn
          ? 'A temporary communication error occurred with the Rebecca AI thinking engine. Please wait a moment and try talking to me again!♡'
          : 'レベッカAIの思考エンジンとの通信中に一時的なエラーが発生したみたい。少し時間を置いてからもう一度話しかけてね♡',
        actionRequired: null,
        suggestionChips: isEn
          ? ['Retry', 'Refresh page']
          : ['もう一度試す', 'ページを再読み込み']
      };
    }
  }

  /**
   * Runs the autonomous ReAct (Reason + Act) tool execution loop with Gemini.
   */
  private async executeReActLoop(
    userMessage: string,
    currentContext: string,
    rawHistory: { role: 'user' | 'model'; text: string; thought?: string; time?: string }[],
    toolContext: CopilotToolContext,
    isEn: boolean,
    targetTimezone: string
  ): Promise<CopilotResponse> {
    if (!this.ai) {
      throw new Error('GoogleGenAI client is not initialized');
    }

    const aiClient = this.ai;
    const activePersona = getActivePersona(config.persona.activeId);
    const targetLang = isEn ? 'en' : 'ja';

    const languageInstruction = isEn
      ? `【Language Requirement】
Output ALL text in reply and suggestionChips in ENGLISH.`
      : `【言語要件】
返答文（reply）およびsuggestionChipsはすべて自然な日本語で出力してください。`;

    const copilotOperationalRules = `【Mode: Admin Copilot Support】
You are interacting 1-on-1 with the operator on the Admin Dashboard.

${languageInstruction}

【Autonomous Tool Usage Guidelines】
1. **Casual Chat & Greetings**: If the operator is greeting you, making small talk, expressing tiredness, or sharing thoughts, DO NOT call tools. Respond directly in character.
2. **Data & Management Inquiries**: If the operator asks about post rankings, impressions, user status, image assets, supporter metrics, or system features, autonomously invoke the appropriate search tools.
3. **Multi-Turn Reasoning**: You can inspect tool outputs and synthesize detailed analytical insights.
4. **Safety & Destructive Actions (HITL) & Account Investigation**:
   - The operator might specify a user casually by display name, nickname, or partial text (e.g., "AKINAをブロック", "AKINA復活で").
   - You MUST NEVER call \`propose_destructive_action\` with an unverified or speculative account name.
   - If the operator asks to block/unblock a user, check [Active View] first. If not already clear, you MUST FIRST autonomously call \`search_users(query='...')\` to find their exact account handle and unique document ID.
   - For \`BLOCK_USER\` or \`UNBLOCK_USER\`, you MUST pass the **exact unique user ID (numeric ID, e.g., '123456789' or document id)** obtained from \`search_users\` as the \`target\`. NEVER pass an ambiguous handle or display name without verifying its exact ID first.
   - Only after confirming the exact user ID from \`search_users\` or [Active View], invoke \`propose_destructive_action\`.
   - If the account does not exist or search returns 0 results, do NOT propose an action; warmly explain to the operator that the account could not be found in the system.
   - If the operator asks to synchronize timeline posts (\`SYNC_POSTS\`), trigger mention replies (\`TRIGGER_REPLY\`), run memory consolidation (\`FORCE_DREAMING\`), or regenerate failed image captions (\`REGENERATE_CAPTIONS\`), invoke \`propose_destructive_action\` with the corresponding \`actionType\`.
5. **Final Output Schema (Honne & Tatemae)**: You must provide your final answer strictly as a valid JSON object matching the schema: {"thought": "<your inner monologue / true feelings in character, max 150 chars>", "reply": "<your conversational answer>", "suggestionChips": ["<chip 1>", "<chip 2>", "<chip 3>"]}. Do NOT wrap the JSON in backticks or markdown code fences (e.g. no \`\`\`json). Output raw JSON only.`;

    const { systemInstruction } = await composeSystemPrompt({
      persona: activePersona,
      channelInstruction: getCopilotChannelContext(targetLang),
      lang: targetLang,
      temporal: {
        timezone: targetTimezone,
        includeTimeBracket: true,
      },
      anchoring: {
        embedder: createCopilotEmbeddingProvider(aiClient),
        contextElements: [
          currentContext ? `【表示画面コンテキスト】\n${currentContext}` : '',
          `【管理者からのメッセージ】\n${userMessage}`,
        ],
        logger,
      },
      additionalSections: [copilotOperationalRules],
    });

    const finalResponseSchema = createStructuredPersonaSchema({
      thoughtDescription:
        'Inner thoughts, true feelings, and emotional reflection based on the active persona (Honne, within 150 characters).',
      replyDescription: 'Conversational reply embodying the active persona (Tatemae).',
      additionalProperties: {
        suggestionChips: {
          type: 'array',
          items: { type: 'string' },
          description: '1 to 3 relevant follow-up prompt chips for the user.',
        },
      },
      additionalRequired: ['suggestionChips'],
    });

    // 1. Build sanitized alternating history preserving Tatemae/Honne working memory continuity
    const priorHistory = rawHistory.filter((h, idx) => {
      if (idx === rawHistory.length - 1 && h.text === userMessage) return false;
      return typeof h.text === 'string' && h.text.trim().length > 0;
    });

    const initialTurns: DialogueTurn[] = [];
    let expectedRole: 'user' | 'model' = 'user';
    for (const h of priorHistory.slice(-6)) {
      const role = h.role === 'model' ? 'model' : 'user';
      if (role === expectedRole) {
        const entry: ConversationLogEntry = {
          role,
          content: h.text,
          ...(role === 'model' && h.thought ? { thought: h.thought } : {}),
          ...(h.time ? { timestamp: h.time } : {}),
        };
        const formatted = formatTurnWithInnerThought(entry, targetTimezone);
        initialTurns.push({
          role: formatted.role === 'model' ? 'assistant' : 'user',
          text: formatted.text,
        });
        expectedRole = expectedRole === 'user' ? 'model' : 'user';
      }
    }

    // 2. Latest user turn
    const currentTimestampZoned = formatZonedDateTime(new Date(), targetTimezone);
    const userInput = `[Active View: ${currentContext}] [Current Time: ${currentTimestampZoned}]\n\n${userMessage}`;

    const accumulatedAttachments: CopilotAttachment[] = [];
    let proposedAction: CopilotAction | null = null;

    const resolveFinalAttachments = (
      accumulated: CopilotAttachment[],
      action: CopilotAction | null
    ): CopilotAttachment[] | undefined => {
      if (accumulated.length === 0) return undefined;

      // Deduplicate by type and id
      const unique = Array.from(
        new Map(accumulated.map(a => [`${a.type}:${a.id}`, a])).values()
      );

      // If an administrative action is proposed targeting a specific entity, isolate to that targeted entity
      if (action?.payload?.userId) {
        const targetUserId = String(action.payload.userId);
        const hasTargetUser = unique.some(a => a.type === 'user' && a.id === targetUserId);
        if (hasTargetUser) {
          return unique.filter(a => a.type !== 'user' || a.id === targetUserId);
        }
      } else if (action?.payload?.postId) {
        const targetPostId = String(action.payload.postId);
        const hasTargetPost = unique.some(a => a.type === 'post' && a.id === targetPostId);
        if (hasTargetPost) {
          return unique.filter(a => a.type !== 'post' || a.id === targetPostId);
        }
      }

      return unique;
    };

    const generateContentWithTimeout = async (
      contents: Content[],
      callConfig: Record<string, unknown>,
    ) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeoutGuard = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Gemini API call timed out')),
            config.gemini.timeoutMs,
          );
        });
        return await Promise.race([
          aiClient.models.generateContent({
            model: config.gemini.model,
            contents,
            config: callConfig,
          }),
          timeoutGuard,
        ]);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    };

    const rawDeclarations = this.toolRegistry.getFunctionDeclarations();
    const adaptedRegistry = new PersonaToolRegistry();
    for (const decl of rawDeclarations) {
      const neutralDecl = toNeutralToolDeclaration(decl);
      adaptedRegistry.register({
        declaration: neutralDecl,
        execute: async (args) => {
          const toolResult = await this.toolRegistry.execute(
            neutralDecl.name,
            args ?? {},
            toolContext,
          );
          if (toolResult.attachments && toolResult.attachments.length > 0) {
            accumulatedAttachments.push(...toolResult.attachments);
          }
          if (toolResult.actionRequired) {
            proposedAction = toolResult.actionRequired;
          }
          const rawData = toolResult.data;
          if (rawData && typeof rawData === 'object' && !Array.isArray(rawData)) {
            return rawData as Record<string, unknown>;
          }
          return { result: rawData };
        },
      });
    }

    const synthesisConfig = {
      systemInstruction: `${systemInstruction}\n\nSynthesize your final response with internal thought (Honne), spoken reply (Tatemae), and 1-3 relevant suggestionChips strictly in JSON matching the response schema.`,
      temperature: 0.7,
      responseMimeType: 'application/json',
      responseSchema: finalResponseSchema,
    };

    let latestRounds: ReadonlyArray<ToolRoundRecord> = [];

    const dialogueClient: ILLMToolDialogueClient = {
      generateStep: async (ctx) => {
        latestRounds = ctx.rounds;
        const geminiContents = toGeminiContents(ctx);
        const stepConfig =
          ctx.declarations.length > 0
            ? {
                systemInstruction,
                temperature: 0.7,
                tools: [{ functionDeclarations: rawDeclarations }],
              }
            : synthesisConfig;

        const response = await generateContentWithTimeout(geminiContents, stepConfig);
        const rawModelContent = response.candidates?.[0]?.content;
        const mappedCalls = (response.functionCalls ?? [])
          .filter(
            (call): call is { name: string; args?: Record<string, unknown> } =>
              typeof call.name === 'string' && call.name.length > 0,
          )
          .map((call) => ({
            name: call.name,
            args: call.args,
          }));

        return {
          text: mappedCalls.length === 0 ? response.text : undefined,
          toolCalls: mappedCalls,
          opaqueProviderTurn: rawModelContent,
        };
      },
    };

    return await runToolDialogueLoop<Promise<CopilotResponse>>({
      initialTurns,
      userInput,
      toolRegistry: adaptedRegistry,
      maxToolRounds: MAX_TOOL_ROUNDS,
      client: dialogueClient,
      parseOutput: async (rawText) => {
        const extracted = extractStructuredCopilotResponse(rawText);

        // Fast path: if the step already yielded valid Honne/Tatemae JSON + chips, return directly
        if (extracted.thought && extracted.reply && extracted.suggestionChips.length > 0) {
          const action = proposedAction ?? extracted.actionRequired ?? null;
          return {
            thought: extracted.thought,
            reply: extracted.reply,
            attachments: resolveFinalAttachments(accumulatedAttachments, action),
            actionRequired: action,
            suggestionChips: extracted.suggestionChips,
          };
        }

        // Otherwise (whether 0 tool rounds or 1+ tool rounds ending with unstructured text or omitted fields),
        // synthesize via schema-constrained Phase 2 preserving accumulated tool rounds while excluding
        // any incomplete model text turn.
        const cleanSynthesisContents = toGeminiContents({
          initialTurns,
          userInput,
          rounds: latestRounds,
          declarations: [],
        });
        const synthesisResponse = await generateContentWithTimeout(
          cleanSynthesisContents,
          synthesisConfig,
        );
        const finalExtracted = extractStructuredCopilotResponse(
          synthesisResponse.text?.trim() ?? '',
        );

        if (!finalExtracted.reply.trim() || !finalExtracted.thought?.trim()) {
          throw new Error('Copilot structured synthesis returned incomplete Honne/Tatemae payload');
        }

        const action = proposedAction ?? finalExtracted.actionRequired ?? null;
        return {
          thought: finalExtracted.thought,
          reply: finalExtracted.reply,
          attachments: resolveFinalAttachments(accumulatedAttachments, action),
          actionRequired: action,
          suggestionChips: finalExtracted.suggestionChips,
        };
      },
    });
  }
}

/**
 * Safely extracts and parses JSON payload containing Honne (`thought`), Tatemae (`reply`),
 * suggestion chips, and optional action from Gemini output using `@rebecca/persona`'s shared parser.
 * Never leaks raw or truncated JSON payloads containing private `thought` back into `reply`.
 */
export function extractStructuredCopilotResponse(
  rawText: string
): {
  thought?: string;
  reply: string;
  suggestionChips: string[];
  actionRequired?: CopilotAction | null;
} {
  const cleaned = rawText.trim();
  const parsedObj = parsePersonaJsonObject(cleaned);

  let thoughtText: string | undefined;
  let replyText = '';
  let suggestionChips: string[] = [];
  let actionRequired: CopilotAction | null = null;

  if (parsedObj) {
    if (typeof parsedObj['thought'] === 'string' && parsedObj['thought'].trim().length > 0) {
      thoughtText = parsedObj['thought'].trim();
    }
    if (typeof parsedObj['reply'] === 'string' && parsedObj['reply'].trim().length > 0) {
      replyText = parsedObj['reply'].trim();
    }
    if (Array.isArray(parsedObj['suggestionChips'])) {
      suggestionChips = parsedObj['suggestionChips'].filter(
        (s): s is string => typeof s === 'string' && s.trim().length > 0,
      );
    }
    const candidateAction = parsedObj['actionRequired'];
    if (candidateAction && typeof candidateAction === 'object' && !Array.isArray(candidateAction)) {
      actionRequired = candidateAction as CopilotAction;
    }
  } else {
    // Strip markdown fences for genuine plain conversational text, while blocking
    // leakage of malformed/truncated JSON payloads containing `"thought"` or `"reply"`.
    const strippedFences = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const looksLikeStructuredJsonPayload = /\{\s*"(?:thought|reply)"\s*:/.test(strippedFences);
    if (!looksLikeStructuredJsonPayload) {
      replyText = strippedFences;
    }
  }

  return {
    ...(thoughtText !== undefined ? { thought: thoughtText } : {}),
    reply: replyText,
    suggestionChips,
    actionRequired
  };
}
