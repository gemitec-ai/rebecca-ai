import crypto from 'node:crypto';
import {
  GoogleGenAI,
  ThinkingLevel,
  type Content,
  type Schema,
  type Tool,
  Type,
} from '@google/genai';
import { FieldValue, type Firestore } from '@google-cloud/firestore';
import { COLLECTIONS, type DbCollections } from '@rebecca/db';
import { getActivePersona, createStructuredPersonaSchema, parsePersonaJsonObject } from '@rebecca/persona';
import { composeSystemPrompt } from '@rebecca/prompt';
import {
  createSearchWebTool,
  type DialogueTurn,
  type JsonSchemaPrimitiveType,
  PersonaToolRegistry,
  runToolDialogueLoop,
  type ToolDeclaration,
  type ToolDialogueStepContext,
  type ToolDialogueStepResult,
} from '@rebecca/tools';
import {
  AssetStatus,
  type ConversationLogEntry,
  type LoungeEmotionState,
  type LoungePublicXMemorySnapshot,
  type LoungeTokenUsage,
  type UserCoreProfile,
} from '@rebecca/types';
import type { IDreamingSynthesizer } from '@rebecca/memory';
import { loungeLogger, sanitizeLogInput } from '../../../utils/logger';
import {
  type IBotImageAssetSearchPort,
  type ILoungeChatPipelinePort,
  type ILoungeEmbeddingPort,
  type ILoungeEmotionClassifierPort,
  type IPublicXMemoryReadPort,
  type LoungeChatPipelineInput,
  type LoungeChatPipelineOutput,
  type MatchedBotImageAsset,
} from '../ports/loungeAi.port';
import { computeCosineSimilarity } from '../repositories/loungeSession.repository';

const EMBEDDING_DIMENSIONS = 768;
const EMOTION_VALUES: readonly LoungeEmotionState[] = [
  'NEUTRAL',
  'HAPPY',
  'TEASING',
  'SHY',
  'EXCITED',
  'THOUGHTFUL',
  'SURPRISED',
];

const JSON_SCHEMA_TO_GEMINI_TYPE: Readonly<Record<JsonSchemaPrimitiveType, Type>> = {
  string: Type.STRING,
  number: Type.NUMBER,
  integer: Type.INTEGER,
  boolean: Type.BOOLEAN,
  array: Type.ARRAY,
  object: Type.OBJECT,
};

const LOUNGE_REPLY_SCHEMA = createStructuredPersonaSchema({
  thoughtDescription: 'Short internal monologue before responding (under 120 chars).',
  replyDescription: 'Conversational reply in the requested language and tone.',
  additionalProperties: {
    emotion: {
      type: 'string',
      enum: EMOTION_VALUES,
      description: 'Best matching avatar emotion state for the reply.',
    },
  },
  additionalRequired: ['emotion'],
});

const EMOTION_CLASSIFICATION_SCHEMA = {
  type: 'object',
  properties: {
    emotion: {
      type: 'string',
      enum: EMOTION_VALUES,
      description: 'Emotion state matching the user input.',
    },
  },
  required: ['emotion'],
} as const;

function toGeminiTools(declarations: ReadonlyArray<ToolDeclaration>): Tool[] {
  if (declarations.length === 0) {
    return [];
  }
  return [
    {
      functionDeclarations: declarations.map((decl) => {
        const properties: Record<string, Schema> = {};
        for (const [key, prop] of Object.entries(decl.parameters.properties)) {
          properties[key] = {
            type: JSON_SCHEMA_TO_GEMINI_TYPE[prop.type],
            description: prop.description,
            ...(prop.enum ? { enum: [...prop.enum] } : {}),
          };
        }
        return {
          name: decl.name,
          description: decl.description,
          parameters: {
            type: Type.OBJECT,
            properties,
            required: [...decl.parameters.required],
          },
        };
      }),
    },
  ];
}

function isGeminiContent(value: unknown): value is Content {
  return typeof value === 'object' && value !== null && 'parts' in value;
}

function toGeminiContents(ctx: ToolDialogueStepContext): Content[] {
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
}

function mapGeminiStepResult(response: {
  text?: string;
  candidates?: Array<{ content?: Content }>;
  functionCalls?: Array<{ name?: string; args?: Record<string, unknown> }>;
}): ToolDialogueStepResult {
  const rawContent = response.candidates?.[0]?.content;
  const toolCalls = (response.functionCalls ?? [])
    .filter(
      (call): call is { name: string; args?: Record<string, unknown> } =>
        typeof call.name === 'string' && call.name.length > 0,
    )
    .map((call) => ({
      name: call.name,
      ...(call.args ? { args: call.args } : {}),
    }));
  return {
    ...(response.text !== undefined ? { text: response.text } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(rawContent ? { opaqueProviderTurn: rawContent } : {}),
  };
}

/** Deterministic 768-dimension unit embedding derived purely from text hashes (used in offline/emulator tests). */
export function buildDeterministicTestEmbedding(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const digest = crypto.createHash('sha256').update(text, 'utf8').digest();
  let normSq = 0;
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i += 1) {
    const byteVal = digest[i % digest.length] / 255;
    const val = (byteVal * 2 - 1) * ((i % 7) + 1);
    vector[i] = val;
    normSq += val * val;
  }
  const norm = Math.sqrt(normSq) || 1;
  return vector.map((v) => Number((v / norm).toFixed(6)));
}

function classifyEmotionByHeuristics(text: string): LoungeEmotionState {
  const lower = text.toLowerCase();
  if (/(!|！|すご|最高|excited|amazing|awesome|yay)/.test(lower)) {
    return 'EXCITED';
  }
  if (/(\?|？|なぜ|どうして|think|wonder|考え)/.test(lower)) {
    return 'THOUGHTFUL';
  }
  if (/(ありがとう|嬉し|楽し|happy|glad|thanks|好き)/.test(lower)) {
    return 'HAPPY';
  }
  if (/(えっ|まさか|surprise|whoa|really)/.test(lower)) {
    return 'SURPRISED';
  }
  if (/(照|shy|blush|embarrass)/.test(lower)) {
    return 'SHY';
  }
  if (/(ふふ|hehe|teas|冗談)/.test(lower)) {
    return 'TEASING';
  }
  return 'NEUTRAL';
}

function parseEmotion(raw: unknown): LoungeEmotionState {
  if (typeof raw === 'string') {
    const upper = raw.trim().toUpperCase();
    const matched = EMOTION_VALUES.find((v) => v === upper);
    if (matched) {
      return matched;
    }
  }
  return 'NEUTRAL';
}

/**
 * Strictly read-only bridge over Public X Bot memory (`users`, `rag_memories`, `conversation_logs`,
 * `system/persona`, `timeline_history`) that never mutates any Public Bot collection.
 */
export class FirestorePublicXMemoryReadAdapter implements IPublicXMemoryReadPort {
  constructor(
    private readonly firestore: Firestore,
    private readonly collections: Pick<
      DbCollections,
      'users' | 'ragMemories' | 'conversationLogs' | 'system' | 'timelineHistory'
    >,
    private readonly isEmulator: boolean = Boolean(process.env['FIRESTORE_EMULATOR_HOST']),
  ) {}

  /** Reads Public X profile, RAG vectors, recent turns, and Layer 1-3 self memory read-only. */
  public async readPublicXMemorySnapshot(
    xUserId: string,
    queryEmbedding: readonly number[],
  ): Promise<LoungePublicXMemorySnapshot | null> {
    const trimmed = xUserId.trim();
    if (!trimmed) {
      return null;
    }

    const [userSnap, personaSnap, recentLogsSnap, recentPostsSnap] = await Promise.all([
      this.collections.users.doc(trimmed).get(),
      this.collections.system.doc('persona').get(),
      this.collections.conversationLogs
        .where('userId', '==', trimmed)
        .orderBy('timestamp', 'desc')
        .limit(6)
        .get(),
      this.collections.timelineHistory
        .orderBy('timestamp', 'desc')
        .limit(5)
        .get(),
    ]);

    const userData = userSnap.data();
    const personaData = personaSnap.data() as
      | { readonly extended_prompt?: string; readonly timeline_summary?: string }
      | undefined;

    let userVectorMemories: string[] = [];
    if (queryEmbedding.length > 0) {
      try {
        const ragSnap = await this.firestore
          .collection(COLLECTIONS.RAG_MEMORIES)
          .where('userId', '==', trimmed)
          .findNearest({
            vectorField: 'embedding',
            queryVector: FieldValue.vector([...queryEmbedding]),
            limit: 4,
            distanceMeasure: 'COSINE',
          })
          .get();
        userVectorMemories = ragSnap.docs
          .map((d) => String(d.data()['text'] ?? '').trim())
          .filter((t) => t.length > 0);
      } catch (err) {
        if (this.isEmulator) {
          const fallbackSnap = await this.collections.ragMemories
            .where('userId', '==', trimmed)
            .limit(40)
            .get();
          userVectorMemories = fallbackSnap.docs
            .map((d) => d.data())
            .map((doc) => ({
              text: doc.text,
              score: computeCosineSimilarity(queryEmbedding, doc.embedding ?? []),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 4)
            .map((entry) => entry.text)
            .filter((t) => t.length > 0);
        } else {
          loungeLogger.warn('Failed Public X vector RAG read (continuing without X RAG)', {
            reason: sanitizeLogInput(err instanceof Error ? err.message : String(err)),
          });
        }
      }
    }

    const userRecentTurns: ConversationLogEntry[] = recentLogsSnap.docs
      .reverse()
      .flatMap((d) => {
        const raw = d.data();
        const pair: ConversationLogEntry[] = [];
        if (typeof raw.userText === 'string' && raw.userText.trim()) {
          pair.push({ role: 'user', content: raw.userText, timestamp: raw.timestamp });
        }
        if (typeof raw.aiText === 'string' && raw.aiText.trim()) {
          pair.push({
            role: 'model',
            content: raw.aiText,
            ...(raw.thought ? { thought: raw.thought } : {}),
            timestamp: raw.timestamp,
          });
        }
        return pair;
      });

    const personaLayer3RecentPosts = recentPostsSnap.docs
      .map((d) => d.data().text)
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0);

    if (
      !userData &&
      userRecentTurns.length === 0 &&
      userVectorMemories.length === 0 &&
      !personaData?.extended_prompt &&
      !personaData?.timeline_summary &&
      personaLayer3RecentPosts.length === 0
    ) {
      return null;
    }

    return {
      xUserId: trimmed,
      userStructuredProfile: userData?.coreProfile ?? null,
      userRecentTurns,
      userVectorMemories,
      personaLayer1ExtendedPrompt: personaData?.extended_prompt ?? '',
      personaLayer2TimelineSummary: personaData?.timeline_summary ?? '',
      personaLayer3RecentPosts,
      syncedAt: new Date().toISOString(),
    };
  }
}

/**
 * Vector-only Bot artwork matcher querying `collections.images` (never invokes LLM re-ranking)
 * with deterministic cosine fallback for local Firestore Emulator environments.
 */
export class FirestoreBotImageVectorSearchAdapter implements IBotImageAssetSearchPort {
  constructor(
    private readonly firestore: Firestore,
    private readonly collections: Pick<DbCollections, 'images'>,
    private readonly embeddingPort: ILoungeEmbeddingPort,
    private readonly similarityThreshold: number = 0.45,
    private readonly isEmulator: boolean = Boolean(process.env['FIRESTORE_EMULATOR_HOST']),
  ) {}

  /** Matches the semantically closest available Bot artwork for `replyText` and `emotion`. */
  public async findBestMatchingImage(
    replyText: string,
    emotion: LoungeEmotionState,
  ): Promise<MatchedBotImageAsset | null> {
    const queryVector = await this.embeddingPort.embedQuery(`${emotion}: ${replyText.slice(0, 300)}`);
    if (queryVector.length === 0) {
      return null;
    }

    try {
      const snap = await this.firestore
        .collection(COLLECTIONS.IMAGES)
        .findNearest({
          vectorField: 'embedding',
          queryVector: FieldValue.vector(queryVector),
          limit: 6,
          distanceMeasure: 'COSINE',
          distanceResultField: 'vectorDistance',
        })
        .get();

      for (const doc of snap.docs) {
        const raw = doc.data() as {
          readonly url?: unknown;
          readonly status?: unknown;
          readonly vectorDistance?: unknown;
        };
        const status = typeof raw.status === 'string' ? raw.status.toUpperCase() : undefined;
        if (status === AssetStatus.FAILED || status === AssetStatus.PROCESSING || status === AssetStatus.PENDING) {
          continue;
        }
        const imageUrl = typeof raw.url === 'string' ? raw.url.trim() : '';
        if (!imageUrl) {
          continue;
        }
        const distance = typeof raw.vectorDistance === 'number' ? raw.vectorDistance : 1;
        const similarity = 1 - distance;
        if (similarity >= this.similarityThreshold) {
          return {
            assetId: doc.id,
            imageUrl,
          };
        }
      }
      if (!snap.empty || !this.isEmulator) {
        return null;
      }
    } catch (err) {
      if (!this.isEmulator) {
        loungeLogger.warn('Bot image vector lookup failed cleanly (skipping illustration)', {
          reason: sanitizeLogInput(err instanceof Error ? err.message : String(err)),
        });
        return null;
      }
    }

    // Emulator deterministic cosine similarity fallback
    const allSnap = await this.collections.images.limit(50).get();
    let bestMatch: { readonly item: MatchedBotImageAsset; readonly score: number } | null = null;
    for (const doc of allSnap.docs) {
      const img = doc.data();
      const status = typeof img.status === 'string' ? img.status.toUpperCase() : undefined;
      if (status === AssetStatus.FAILED || status === AssetStatus.PROCESSING || status === AssetStatus.PENDING) {
        continue;
      }
      if (!img.url || !Array.isArray(img.embedding) || img.embedding.length === 0) {
        continue;
      }
      const score = computeCosineSimilarity(queryVector, img.embedding);
      if (score >= this.similarityThreshold && (!bestMatch || score > bestMatch.score)) {
        bestMatch = {
          item: {
            assetId: doc.id,
            imageUrl: img.url,
          },
          score,
        };
      }
    }
    return bestMatch ? bestMatch.item : null;
  }
}

/**
 * Gemini Flash-Lite (`ThinkingLevel.MINIMAL`, `maxOutputTokens <= 450`) + Gemini 3 `search_web` +
 * `gemini-embedding-2` (768-dim) adapter + Dreaming synthesizer backed by `@rebecca/persona` & `@rebecca/prompt`.
 */
export class GeminiLoungeAiAdapter
  implements
    ILoungeEmbeddingPort,
    ILoungeEmotionClassifierPort,
    ILoungeChatPipelinePort,
    IDreamingSynthesizer
{
  private readonly ai: GoogleGenAI;

  constructor(
    private readonly options: {
      readonly apiKey: string;
      readonly chatModel: string;
      readonly searchModel: string;
      readonly embeddingModel: string;
      readonly maxOutputTokens: number;
      readonly activePersonaId: string;
    },
    client?: GoogleGenAI,
  ) {
    this.ai = client ?? new GoogleGenAI({ apiKey: options.apiKey });
  }

  /** Computes 768-dim semantic embedding via `gemini-embedding-2`. */
  public async embedQuery(text: string): Promise<number[]> {
    const trimmed = text.trim();
    if (!trimmed) {
      return [];
    }
    const response = await this.ai.models.embedContent({
      model: this.options.embeddingModel,
      contents: trimmed,
      config: {
        outputDimensionality: EMBEDDING_DIMENSIONS,
      },
    });
    return response.embeddings?.[0]?.values ?? [];
  }

  /** Classifies the user's message into one of 7 Lounge emotion states using Flash-Lite minimal thinking. */
  public async classifyEmotion(text: string): Promise<LoungeEmotionState> {
    const trimmed = text.trim();
    if (!trimmed) {
      return 'NEUTRAL';
    }
    try {
      const response = await this.ai.models.generateContent({
        model: this.options.chatModel,
        contents: `Classify the emotional tone of this message into one enum value:\n${trimmed.slice(0, 500)}`,
        config: {
          maxOutputTokens: 60,
          responseMimeType: 'application/json',
          responseSchema: EMOTION_CLASSIFICATION_SCHEMA as unknown as Schema,
          thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        },
      });
      const parsed = response.text ? parsePersonaJsonObject(response.text) : null;
      return parseEmotion(parsed?.['emotion']);
    } catch {
      return classifyEmotionByHeuristics(trimmed);
    }
  }

  /** Executes Gemini 3 Google Search grounding for `search_web` tool calls ($14 / 1k prompts). */
  public async executeWebSearch(query: string): Promise<string> {
    const trimmed = query.trim();
    if (!trimmed) {
      return '検索クエリが指定されていません。';
    }
    try {
      const response = await this.ai.models.generateContent({
        model: this.options.searchModel,
        contents: [{ role: 'user', parts: [{ text: trimmed }] }],
        config: {
          tools: [{ googleSearch: {} }],
          safetySettings: [],
        },
      });
      return response.text?.trim() || '該当する検索結果が見つかりませんでした。';
    } catch (err) {
      loungeLogger.warn('Lounge search_web grounding failed gracefully', {
        reason: sanitizeLogInput(err instanceof Error ? err.message : String(err)),
      });
      return '一時的な検索エラーのため最新情報を取得できませんでした。';
    }
  }

  /**
   * Composes multi-layer persona prompt via `@rebecca/prompt` and generates structured JSON response
   * (`thought`, `reply`, `emotion`) via Flash-Lite `ThinkingLevel.MINIMAL` and optional `search_web` loop.
   */
  public async generateReply(input: LoungeChatPipelineInput): Promise<LoungeChatPipelineOutput> {
    const persona = getActivePersona(this.options.activePersonaId);
    const langForPrompt = input.responseLanguage === 'ja' ? 'ja' : 'en';

    const composed = await composeSystemPrompt({
      persona,
      channelInstruction: `${input.localePromptDirective}\nKeep replies warm, natural, and concise for Private Lounge 1-on-1 chat.`,
      lang: langForPrompt,
      anchoring: {
        embedder: { generateEmbedding: (txt: string) => this.embedQuery(txt) },
        contextElements: [input.userPrompt],
        topK: 3,
      },
      temporal: {
        timezone: input.userTimezone,
      },
      memory: {
        userData: {
          id: input.uid,
          coreProfile: input.privateMemory.coreProfile,
          lastDreamedAt: input.privateMemory.lastDreamedAt,
        },
        ragMemories: input.privateMemory.vectorMemories.map((m) => m.summary),
        readOnlyMemoryOverlay: input.publicXMemory
          ? {
              coreProfile: input.publicXMemory.userStructuredProfile ?? undefined,
              recentTurns: input.publicXMemory.userRecentTurns,
            }
          : undefined,
      },
      additionalSections: [input.memoryPromptDirective],
    });

    const initialTurns: DialogueTurn[] = input.privateMemory.recentRawMessages.map((msg) => ({
      role: msg.role === 'ASSISTANT' ? 'assistant' : 'user',
      text: msg.content,
    }));

    let usedWebSearch = false;
    let promptTokens = 0;
    let candidatesTokens = 0;
    let totalTokens = 0;

    const toolRegistry = new PersonaToolRegistry().register(
      createSearchWebTool({
        search: async (query: string) => {
          usedWebSearch = true;
          return this.executeWebSearch(query);
        },
      }),
    );

    const runLoop = async (allowTools: boolean) =>
      runToolDialogueLoop({
        initialTurns,
        userInput: input.userPrompt,
        toolRegistry: allowTools ? toolRegistry : new PersonaToolRegistry(),
        maxToolRounds: allowTools ? 1 : 0,
        client: {
          generateStep: async (ctx) => {
            const genAiTools = toGeminiTools(ctx.declarations);
            const response = await this.ai.models.generateContent({
              model: this.options.chatModel,
              contents: toGeminiContents(ctx),
              config: {
                systemInstruction: composed.systemInstruction,
                maxOutputTokens: this.options.maxOutputTokens,
                responseMimeType: 'application/json',
                responseSchema: LOUNGE_REPLY_SCHEMA as unknown as Schema,
                safetySettings: [],
                thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
                ...(genAiTools.length > 0 ? { tools: genAiTools } : {}),
              },
            });
            const usage = response.usageMetadata;
            promptTokens += usage?.promptTokenCount ?? 0;
            candidatesTokens += usage?.candidatesTokenCount ?? 0;
            totalTokens += usage?.totalTokenCount ?? 0;
            return mapGeminiStepResult(response);
          },
        },
        parseOutput: (rawText) => {
          const parsed = parsePersonaJsonObject(rawText);
          if (!parsed || typeof parsed['reply'] !== 'string' || !parsed['reply'].trim()) {
            throw new Error('Gemini Lounge returned empty or malformed structured reply');
          }
          return {
            replyText: parsed['reply'].trim(),
            emotion: parseEmotion(parsed['emotion']),
          };
        },
      });

    let result: { readonly replyText: string; readonly emotion: LoungeEmotionState };
    if (input.allowWebSearch) {
      try {
        result = await runLoop(true);
      } catch (toolErr) {
        loungeLogger.warn('Lounge tool loop failed; retrying reply generation without web search tool', {
          reason: sanitizeLogInput(toolErr instanceof Error ? toolErr.message : String(toolErr)),
        });
        result = await runLoop(false);
      }
    } else {
      result = await runLoop(false);
    }

    const tokenUsage: LoungeTokenUsage = {
      promptTokens,
      candidatesTokens,
      totalTokens,
    };

    return {
      replyText: result.replyText,
      emotion: result.emotion,
      tokenUsage,
      usedWebSearch,
    };
  }

  /** Synthesizes consolidated long-term `UserCoreProfile` during Nightly Batch Dreaming. */
  public async generateDreaming(
    systemPrompt: string,
    episodicBuffer: ConversationLogEntry[],
    coreProfile: UserCoreProfile,
  ): Promise<UserCoreProfile> {
    const prompt = `【過去のCore Profile】\n${JSON.stringify(coreProfile)}\n\n【新しいエピソード】\n${JSON.stringify(episodicBuffer)}\n\nJSONオブジェクトのみ出力してください。`;
    const response = await this.ai.models.generateContent({
      model: this.options.chatModel,
      contents: prompt,
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: 800,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
      },
    });
    const parsed = response.text ? parsePersonaJsonObject(response.text) : null;
    if (!parsed) {
      return coreProfile;
    }
    return parsed as UserCoreProfile;
  }
}

/**
 * Deterministic non-production AI adapter used when `GEMINI_API_KEY` is absent in local dev or E2E suites.
 * Never consumes production quota or external network calls while exercising real pipeline paths.
 */
export class LocalEmulatorLoungeAiAdapter
  implements
    ILoungeEmbeddingPort,
    ILoungeEmotionClassifierPort,
    ILoungeChatPipelinePort,
    IDreamingSynthesizer
{
  public async embedQuery(text: string): Promise<number[]> {
    return text.trim() ? buildDeterministicTestEmbedding(text) : [];
  }

  public async classifyEmotion(text: string): Promise<LoungeEmotionState> {
    return classifyEmotionByHeuristics(text);
  }

  public async generateReply(input: LoungeChatPipelineInput): Promise<LoungeChatPipelineOutput> {
    const emotion = classifyEmotionByHeuristics(input.userPrompt);
    const trimmedPrompt = input.userPrompt.trim().slice(0, 60);
    const replyByLang: Record<LoungeChatPipelineInput['responseLanguage'], string> = {
      ja: `「${trimmedPrompt}」について話してくれてありがとう！プライベートラウンジでいつでも続きを聞かせてね。`,
      en: `Thanks for sharing "${trimmedPrompt}"! Tell me more anytime here in Private Lounge.`,
      de: `Danke für "${trimmedPrompt}"! Erzähl mir in der Private Lounge jederzeit gern mehr.`,
      pt: `Valeu por contar "${trimmedPrompt}"! Pode continuar me contando aqui no Private Lounge.`,
      es: `¡Gracias por contar "${trimmedPrompt}"! Cuéntame más cuando quieras aquí en el Private Lounge.`,
      'zh-HK': `多謝你同我講「${trimmedPrompt}」！隨時喺 Private Lounge 繼續傾偈呀。`,
      vi: `Cảm ơn bạn đã chia sẻ "${trimmedPrompt}"! Cứ trò chuyện thêm bất cứ lúc nào nhé.`,
      th: `ขอบคุณที่เล่าเรื่อง "${trimmedPrompt}" นะ คุยต่อได้เสมอใน Private Lounge เลย`,
    };
    const replyText = replyByLang[input.responseLanguage] ?? replyByLang.en;
    const promptTokens = Math.max(12, Math.ceil(input.userPrompt.length / 2));
    const candidatesTokens = Math.max(12, Math.ceil(replyText.length / 2));
    return {
      replyText,
      emotion,
      tokenUsage: {
        promptTokens,
        candidatesTokens,
        totalTokens: promptTokens + candidatesTokens,
      },
      usedWebSearch: Boolean(input.allowWebSearch && /search|news|調べ|検索|天気/i.test(input.userPrompt)),
    };
  }

  public async generateDreaming(
    _systemPrompt: string,
    episodicBuffer: ConversationLogEntry[],
    coreProfile: UserCoreProfile,
  ): Promise<UserCoreProfile> {
    return {
      ...coreProfile,
      recentTopics: episodicBuffer.slice(-3).map((e) => e.content.slice(0, 40)),
    } as UserCoreProfile;
  }
}
