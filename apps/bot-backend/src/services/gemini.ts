/**
 * @fileoverview Gemini API service wrapper.
 * Provides functions for generating conversational replies, analyzing user profiles,
 * and performing various semantic NLP tasks using Google's generative AI models.
 */

import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import {
  DEFAULT_SELF_REFLECTION_SYSTEM_INSTRUCTION,
  formatHistoryWithInnerThought,
} from '@rebecca/memory';
import {
  parsePersonaJsonObject,
  parsePersonaResponse,
  type StructuredPersonaObjectSchema,
  type StructuredPersonaResponse,
  PERSONA_RESPONSE_SCHEMA,
} from '@rebecca/persona';
import {
  createSearchWebTool,
  type DialogueTurn,
  EmptyDialogueResponseError,
  type ILLMToolDialogueClient,
  PersonaToolRegistry,
  runToolDialogueLoop,
} from '@rebecca/tools';
import { ConversationLogEntry, UserCoreProfile, IGeminiService } from '../types';
import { StructuredNewsPostResponse } from '../features/news/types';
import { StructuredPollPostResponse } from '../features/poll/types';
import { StructuredSupportPostResponse } from '../features/support/types';
import { logger } from '../utils/logger';
import { rethrowUpstreamApiError } from '../utils/httpError';
import {
  mapGeminiDialogueStepResult,
  toGeminiContents,
  toGeminiTools,
} from './geminiDialogueAdapter';
import {
  createStructuredNewsPostSchema,
  STRUCTURED_POLL_POST_SCHEMA,
  STRUCTURED_SUPPORT_POST_SCHEMA,
} from './geminiSchemas';

/**
 * Configuration options required by GeminiService.
 */
export interface GeminiServiceConfig {
  apiKey?: string;
  model: string;
  embeddingModel: string;
  judgeModel?: string;
  languageModel?: string;
  visionModel?: string;
  imageInferenceModel?: string;
  searchModel?: string;
  newsPostModel?: string;
  appTimezone?: string;
  temperature?: number;
  topP?: number;
  thinkingLevel?: ThinkingLevel;
}

/**
 * Encapsulates interactions with Google Gemini Large Language Models.
 * Implements IGeminiService with explicit constructor injection, eliminating ambient config coupling.
 */
export class GeminiService implements IGeminiService {
  private ai: GoogleGenAI | null = null;

  constructor(
    private readonly config: GeminiServiceConfig,
    client?: GoogleGenAI,
  ) {
    if (client) {
      this.ai = client;
    } else if (config.apiKey) {
      this.ai = new GoogleGenAI({ apiKey: config.apiKey });
    }
  }

  /**
   * Generates an updated core profile by assimilating recent episodic memories.
   *
   * @param systemPrompt - The system instruction defining the profiling and dreaming protocol.
   * @param episodicBuffer - A collection of recent conversation logs not yet integrated into the profile.
   * @param coreProfile - The user's existing core profile data.
   * @returns A promise that resolves to the newly synthesized core profile.
   */
  async generateDreaming(
    systemPrompt: string,
    episodicBuffer: ConversationLogEntry[],
    coreProfile: UserCoreProfile
  ): Promise<UserCoreProfile> {
    if (!this.ai) {
      throw new Error('Gemini API client not initialized');
    }
    try {
      const prompt = `
        【過去のCore Profile】
        ${JSON.stringify(coreProfile || {}, null, 2)}
        
        【今日の未統合ログ】
        ${JSON.stringify(episodicBuffer || [], null, 2)}
        `;

      const response = await this.ai.models.generateContent({
        model: this.config.model,
        contents: prompt,
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: 'application/json',
          safetySettings: [] as never[],
        },
      });

      return JSON.parse(response.text || '{}');
    } catch (error) {
      return rethrowUpstreamApiError(error, 'Error in Dreaming generation');
    }
  }

  /**
   * Analyzes conversation logs to extract user trends and issues, outputting an evolution prompt for the AI persona.
   *
   * @param prompt - The formatted prompt containing the logs and instructions.
   * @returns A promise that resolves to the newly generated evolution prompt text.
   */
  async generateEvolutionPrompt(prompt: string): Promise<string> {
    if (!this.ai) return '';

    try {
      const response = await this.ai.models.generateContent({
        model: this.config.model,
        contents: prompt,
        config: {
          safetySettings: [] as never[],
        },
      });
      return response.text?.trim() || '';
    } catch (e) {
      return rethrowUpstreamApiError(e, 'Error in Evolution generation');
    }
  }

  /**
   * Audits a generated evolution prompt to ensure it adheres to safety and persona guidelines.
   *
   * @param candidatePrompt - The candidate prompt to evaluate.
   * @param auditInstruction - The audit rules and prompt structure.
   * @returns A promise resolving to the audit result, indicating pass/fail status and an optional reason.
   */
  async auditEvolutionPrompt(
    candidatePrompt: string,
    auditInstruction: string
  ): Promise<{ pass: boolean; reason?: string }> {
    if (!this.ai) return { pass: true };

    try {
      const response = await this.ai.models.generateContent({
        model: this.config.judgeModel || this.config.model,
        contents: auditInstruction,
        config: {
          responseMimeType: 'application/json',
        },
      });
      const parsed = response.text ? parsePersonaJsonObject(response.text) : null;
      if (!parsed || typeof parsed['pass'] !== 'boolean') {
        return { pass: false, reason: 'Invalid audit JSON response' };
      }
      return {
        pass: parsed['pass'],
        ...(typeof parsed['reason'] === 'string' ? { reason: parsed['reason'] } : {}),
      };
    } catch (e) {
      logger.error('Error in Evolution audit', e);
      return { pass: false, reason: 'Audit API Error' };
    }
  }

  /**
   * Analyzes a user's social media profile description to extract attributes and preferences.
   *
   * @param prompt - The formatted prompt including instructions and the description.
   * @returns A promise that resolves to an object containing extracted attributes and preferences.
   */
  async analyzeUserProfile(prompt: string): Promise<UserCoreProfile> {
    if (!this.ai || !prompt) return {} as UserCoreProfile;
    try {
      const response = await this.ai.models.generateContent({
        model: this.config.model,
        contents: prompt,
        config: { responseMimeType: 'application/json' },
      });
      return JSON.parse(response.text || '{}');
    } catch (e) {
      logger.error('Error analyzing user profile', e);
      return {} as UserCoreProfile;
    }
  }

  /**
   * Executes a constrained structured JSON generation request via Gemini and returns
   * the parsed JSON object record, applying unified guardrails and error propagation.
   */
  private async executeStructuredJsonGeneration(options: {
    systemInstruction: string;
    prompt: string | string[];
    responseSchema: StructuredPersonaObjectSchema;
    operationErrorLabel: string;
    targetLabel: string;
    model?: string;
    maxOutputTokens?: number;
    errorContext?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    if (!this.ai) {
      throw new Error('Gemini API client not initialized');
    }
    const contentStr = Array.isArray(options.prompt) ? options.prompt.join('\n') : options.prompt;
    if (!contentStr || !contentStr.trim()) {
      throw new Error(`Prompt cannot be empty for ${options.targetLabel} generation`);
    }

    try {
      const response = await this.ai.models.generateContent({
        model: options.model ?? this.config.model,
        contents: contentStr,
        config: {
          systemInstruction: options.systemInstruction,
          maxOutputTokens: options.maxOutputTokens ?? 1000,
          responseMimeType: 'application/json',
          responseSchema: options.responseSchema,
          safetySettings: [] as never[],
          temperature: this.config.temperature ?? 1.20,
          topP: this.config.topP ?? 0.95,
          thinkingConfig: {
            thinkingLevel: this.config.thinkingLevel ?? ThinkingLevel.MEDIUM,
          },
        },
      });

      const rawText = response.text?.trim();
      if (!rawText) {
        throw new Error(`Gemini API returned empty response for ${options.targetLabel}`);
      }

      const parsed = parsePersonaJsonObject(rawText);
      if (!parsed) {
        throw new Error(`Gemini API returned malformed response schema for ${options.targetLabel}`);
      }
      return parsed;
    } catch (e) {
      return rethrowUpstreamApiError(e, options.operationErrorLabel, options.errorContext);
    }
  }

  /**
   * Internal helper to generate structured persona post (thought + reply) via Gemini.
   */
  private async generateStructuredPostInternal(
    systemInstruction: string,
    prompt: string | string[],
    maxOutputTokens: number = 1000,
  ): Promise<StructuredPersonaResponse> {
    const parsed = await this.executeStructuredJsonGeneration({
      systemInstruction,
      prompt,
      responseSchema: PERSONA_RESPONSE_SCHEMA,
      operationErrorLabel: 'Error generating structured timeline post',
      targetLabel: 'structured post',
      maxOutputTokens,
    });

    const thought = typeof parsed['thought'] === 'string' ? parsed['thought'].trim() : '';
    const reply = typeof parsed['reply'] === 'string' ? parsed['reply'].trim() : '';
    if (!reply) {
      throw new Error('Gemini API returned structured response with empty reply');
    }
    return { thought, reply };
  }

  /**
   * Generates a structured news post (inner thought, public tweet text, and selected headline)
   * based on news headlines and persona instructions, constrained to candidate headlines via enum.
   *
   * @param systemInstruction - System instruction defining character persona and behavior.
   * @param prompt - Contextual prompt containing headlines, timeline summary, and guidelines.
   * @param candidateHeadlines - Array of candidate headline titles to constrain selectedTitle.
   * @returns A promise resolving to the strongly-typed StructuredNewsPostResponse.
   */
  async generateStructuredNewsPost(
    systemInstruction: string,
    prompt: string | string[],
    candidateHeadlines: string[],
  ): Promise<StructuredNewsPostResponse> {
    if (!candidateHeadlines || candidateHeadlines.length === 0) {
      throw new Error('Candidate headlines cannot be empty for structured news post generation');
    }

    const parsed = await this.executeStructuredJsonGeneration({
      systemInstruction,
      prompt,
      responseSchema: createStructuredNewsPostSchema(candidateHeadlines),
      operationErrorLabel: 'Error generating structured news post',
      targetLabel: 'structured news post',
      model: this.config.newsPostModel || this.config.model,
    });

    if (
      typeof parsed['thought'] !== 'string' ||
      typeof parsed['reply'] !== 'string' ||
      typeof parsed['selectedTitle'] !== 'string'
    ) {
      throw new Error('Gemini API returned malformed response schema for structured news post');
    }

    const trimmedReply = parsed['reply'].trim();
    if (!trimmedReply) {
      throw new Error('Gemini API returned structured news post with empty reply');
    }

    return {
      selectedTitle: parsed['selectedTitle'].trim(),
      thought: parsed['thought'].trim(),
      reply: trimmedReply,
    };
  }

  /**
   * Generates a structured poll post (inner thought, public tweet text, and 3-4 poll options).
   *
   * @param systemInstruction - System instruction defining character persona and behavior.
   * @param prompt - Contextual prompt containing past polls and persona context.
   * @returns A promise resolving to the strongly-typed StructuredPollPostResponse.
   */
  async generateStructuredPollPost(
    systemInstruction: string,
    prompt: string | string[],
  ): Promise<StructuredPollPostResponse> {
    const parsed = await this.executeStructuredJsonGeneration({
      systemInstruction,
      prompt,
      responseSchema: STRUCTURED_POLL_POST_SCHEMA,
      operationErrorLabel: 'Error generating structured poll post',
      targetLabel: 'structured poll post',
    });

    if (
      typeof parsed['thought'] !== 'string' ||
      typeof parsed['reply'] !== 'string' ||
      !Array.isArray(parsed['options'])
    ) {
      throw new Error('Gemini API returned malformed response schema for structured poll post');
    }

    const trimmedReply = parsed['reply'].trim();
    if (!trimmedReply) {
      throw new Error('Gemini API returned structured poll post with empty reply');
    }

    const validOptions = parsed['options']
      .filter((opt: unknown): opt is string => typeof opt === 'string' && opt.trim().length > 0)
      .map((opt: string) => opt.trim().slice(0, 25))
      .slice(0, 4);

    if (validOptions.length < 2) {
      throw new Error('Gemini API returned fewer than 2 valid poll options');
    }

    return {
      thought: parsed['thought'].trim(),
      reply: trimmedReply,
      options: validOptions,
    };
  }

  /**
   * Generates a structured support appreciation post (inner thought and dynamic replyBody).
   *
   * @param systemInstruction - System instruction defining character persona and behavior.
   * @param prompt - Contextual prompt containing supporter details and guidelines.
   * @returns A promise resolving to StructuredSupportPostResponse.
   */
  async generateStructuredSupportPost(
    systemInstruction: string,
    prompt: string
  ): Promise<StructuredSupportPostResponse> {
    const parsed = await this.executeStructuredJsonGeneration({
      systemInstruction,
      prompt,
      responseSchema: STRUCTURED_SUPPORT_POST_SCHEMA,
      operationErrorLabel: 'Failed to generate structured support post via Gemini',
      targetLabel: 'structured support post',
      errorContext: { promptLength: prompt.length },
    });

    if (
      typeof parsed['thought'] !== 'string' ||
      typeof parsed['replyBody'] !== 'string'
    ) {
      throw new Error('Gemini API returned malformed response schema for structured support post');
    }

    const trimmedReply = parsed['replyBody'].trim();
    if (!trimmedReply) {
      throw new Error('Gemini API returned structured support post with empty replyBody');
    }

    return {
      thought: parsed['thought'].trim(),
      replyBody: trimmedReply,
    };
  }

  /**
   * Generates a structured timeline post (inner thought and public tweet text) based on situational context.
   */
  async generateStructuredTimelinePost(
    systemInstruction: string,
    prompt: string | string[]
  ): Promise<StructuredPersonaResponse> {
    return this.generateStructuredPostInternal(systemInstruction, prompt, 1000);
  }

  /**
   * Summarizes the latest timeline events and integrates them with a previous summary context.
   *
   * @param prompt - The formatted instruction containing recent posts and previous summary.
   * @returns A promise resolving to the updated timeline summary string.
   * @throws Error if client is uninitialized, prompt is invalid, or generation fails.
   */
  async generateTimelineSummary(
    prompt: string | string[],
    systemInstruction: string = DEFAULT_SELF_REFLECTION_SYSTEM_INSTRUCTION,
  ): Promise<string> {
    if (!this.ai) {
      throw new Error('Gemini API client not initialized');
    }
    const contentStr = Array.isArray(prompt) ? prompt.join('\n') : prompt;
    if (!contentStr || contentStr.trim().length === 0) {
      throw new Error('[GeminiService] Prompt for timeline summary cannot be empty.');
    }

    try {
      const response = await this.ai.models.generateContent({
        model: this.config.model,
        contents: contentStr,
        config: {
          systemInstruction,
          maxOutputTokens: 400,
        },
      });
      const summary = response.text?.trim();
      if (!summary) {
        throw new Error('[GeminiService] Gemini returned empty response for timeline summary.');
      }
      return summary;
    } catch (e) {
      return rethrowUpstreamApiError(e, '[GeminiService] Failed to generate timeline summary');
    }
  }

  /**
   * Computes a vector embedding for the provided text.
   *
   * @param text - The text to process.
   * @returns A promise resolving to an array of numbers representing the embedding vector.
   */
  async generateEmbedding(text: string): Promise<number[]> {
    if (!this.ai || !text) return [];
    try {
      const response = await this.ai.models.embedContent({
        model: this.config.embeddingModel,
        contents: text,
        config: {
          outputDimensionality: 768,
        },
      });
      const values = response.embeddings?.[0]?.values;
      return values || [];
    } catch (e) {
      logger.error('Error generating embedding', e);
      return [];
    }
  }

  /**
   * Extracts a concise search query based on conversational context and the newest user input.
   *
   * @param contextOrPrompt - The conversational context or formatted prompt.
   * @param userInput - The user input.
   * @returns A promise resolving to a refined search query string.
   */
  async generateSearchQuery(contextOrPrompt: string, userInput?: string): Promise<string> {
    if (!this.ai) return userInput || contextOrPrompt || '';
    try {
      const prompt = userInput ? `Context: ${contextOrPrompt}\nUser: ${userInput}` : contextOrPrompt;
      const response = await this.ai.models.generateContent({
        model: this.config.model,
        contents: prompt,
        config: { maxOutputTokens: 50 },
      });
      return response.text?.trim() || userInput || '';
    } catch (e) {
      logger.error('Error generating search query', e);
      return userInput || '';
    }
  }

  /**
   * Detects whether the provided text is predominantly Japanese or English.
   *
   * @param prompt - The formatted instruction and text.
   * @returns A promise resolving to the language code ('ja' or 'en').
   */
  async detectLanguage(prompt: string): Promise<'ja' | 'en'> {
    if (!this.ai || !prompt) return 'ja';
    try {
      const response = await this.ai.models.generateContent({
        model: this.config.languageModel || this.config.model,
        contents: prompt,
        config: { maxOutputTokens: 300 },
      });
      const lang = response.text?.trim().toLowerCase() || 'ja';
      return lang.includes('en') ? 'en' : 'ja';
    } catch (e) {
      logger.error('Error detecting language', e);
      return 'ja';
    }
  }

  /**
   * Analyzes an image buffer and generates a detailed descriptive caption in Japanese.
   *
   * @param imageBuffer - The image data buffer to process.
   * @param mimeType - The MIME type of the image.
   * @param prompt - The instruction prompt.
   * @returns A promise resolving to a generated descriptive caption.
   */
  async analyzeImageCaption(
    imageBuffer: Buffer,
    mimeType: string,
    prompt: string = 'この画像に写っているキャラクターの服装、ポーズ、表情、背景、シチュエーションを日本語で詳細に説明してください。'
  ): Promise<string> {
    if (!this.ai) return '';
    try {
      const response = await this.ai.models.generateContent({
        model: this.config.visionModel || this.config.model,
        contents: [
          {
            inlineData: {
              data: imageBuffer.toString('base64'),
              mimeType: mimeType,
            },
          },
          prompt,
        ],
        config: {
          maxOutputTokens: 500,
        },
      });
      return response.text?.trim() || '';
    } catch (e) {
      logger.error('Error analyzing image caption', e);
      return '';
    }
  }

  /**
   * Infers an image search query based on a tweet's intent and context.
   *
   * @param prompt - The formatted prompt containing rules and context.
   * @returns A promise resolving to a search query string or null if an image is deemed unnecessary.
   */
  async inferImageSearchQuery(prompt: string): Promise<string | null> {
    if (!this.ai) return null;
    try {
      const response = await this.ai.models.generateContent({
        model: this.config.imageInferenceModel || this.config.model,
        contents: prompt,
        config: {
          maxOutputTokens: 100,
        },
      });
      const result = response.text?.trim() || null;
      return result === 'null' ? null : result;
    } catch (e) {
      return rethrowUpstreamApiError(e, 'Error inferring image search query');
    }
  }

  /**
   * Verifies whether a candidate image is contextually relevant to the generated post text (LLM Re-ranking).
   *
   * @param imageCaption - The description/caption of the image candidate.
   * @param postText - The generated post text to be published.
   * @returns A promise resolving to true if contextually aligned, false otherwise.
   */
  async verifyImageRelevance(imageCaption: string, postText: string): Promise<boolean> {
    if (!this.ai || !imageCaption || !postText) return false;
    try {
      const prompt = `あなたはAIキャラクターのSNS投稿と添付画像の文脈調和を判定するモデレーターAIです。
画像データベースには「キャラクター自身が様々な衣装・シチュエーションで描かれたイラスト」が登録されています。
以下の「投稿テキスト」に対し、「画像」がキャラクター自身の投稿行動や発言の背景情景として自然に調和しているかを判定してください。

【判定方針】
1. 合格（relevant: true）とする基準:
   - 投稿で語られている中心的な行動・体験・シチュエーション（趣味、イベント、作業、日常の過ごし方等）と、画像に描かれた活動・環境・感情が自然に結びついていること。
   - 細部の属性（特定の競技名や道具の種類など）が完全に同一でなくとも、投稿全体の主旨や感情のトーン（応援、演奏、くつろぎ、配信など）として自然なリアクション・活動風景として成立していれば許容します。

2. 厳格に不合格（relevant: false）とする基準:
   - 投稿の主旨や活動と、画像の状況・アクティビティが明らかに乖離または矛盾していること。
   - 投稿の感情や場面（真剣な話題、静かな日常など）に対して、画像の衣装やシチュエーション（過度な戦闘装備、場違いなリゾート等）が突飛で不自然なこと。
   - 投稿内容に一切関係のない無関係な単独ポーズやシチュエーション。

※「キャラクターが写っていれば何でもよい」という安易な判定は避け、投稿の話題と画像のアクティビティ・場面設定の整合性を厳密に評価してください。

【投稿テキスト】
${postText}

【画像キャプション】
${imageCaption}

出力はJSON形式で、以下のスキーマに従ってください：
{
  "relevant": true または false,
  "reason": "判定理由（短文）"
}`;

      const response = await this.ai.models.generateContent({
        model: this.config.judgeModel || this.config.model,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
        },
      });

      const parsed = response.text ? parsePersonaJsonObject(response.text) : null;
      return parsed?.['relevant'] === true;
    } catch (e) {
      return rethrowUpstreamApiError(e, 'Error verifying image relevance');
    }
  }

  /**
   * Executes Google Search Grounding for an arbitrary user query.
   *
   * @param query - Search keywords or question to look up.
   * @returns Grounded search summary or localized fallback message.
   */
  async executeWebSearch(query: string): Promise<string> {
    if (!this.ai) {
      return '検索クライアントが未初期化です。';
    }

    const trimmed = query.trim();
    if (!trimmed) {
      return '検索クエリが空です。';
    }

    const searchModel = this.config.searchModel ?? this.config.model;
    try {
      const res = await this.ai.models.generateContent({
        model: searchModel,
        contents: [{ role: 'user', parts: [{ text: trimmed }] }],
        config: {
          tools: [{ googleSearch: {} }],
          safetySettings: [],
        },
      });
      return res.text?.trim() || '該当する検索結果が見つかりませんでした。';
    } catch (err) {
      logger.warn('[executeWebSearch] Failed to search for query', {
        query: trimmed,
        error: err instanceof Error ? err.message : String(err),
      });
      return '一時的なネットワークまたは検索エラーにより情報を取得できませんでした。';
    }
  }

  /**
   * Generates a structured conversational reply with internal monologue using Gemini API Structured Outputs.
   * Delegates Tatemae/Honne turn reconstruction to `@rebecca/memory` and provider-agnostic
   * `search_web` tool dialogue orchestration to `@rebecca/tools`.
   *
   * @param systemInstruction - The system persona and behavioral guidelines.
   * @param history - Conversation history log entries.
   * @param userInput - The most recent text input provided by the user.
   * @returns A promise resolving to StructuredPersonaResponse ({ thought, reply }).
   */
  async generateStructuredReply(
    systemInstruction: string,
    history: ConversationLogEntry[],
    userInput: string
  ): Promise<StructuredPersonaResponse> {
    if (!this.ai) {
      throw new Error('Gemini API client not initialized');
    }

    const aiClient = this.ai;
    const baseConfig = {
      systemInstruction: systemInstruction,
      maxOutputTokens: 1000,
      responseMimeType: 'application/json',
      responseSchema: PERSONA_RESPONSE_SCHEMA,
      safetySettings: [] as never[],
      temperature: this.config.temperature ?? 1.20,
      topP: this.config.topP ?? 0.95,
      thinkingConfig: {
        thinkingLevel: this.config.thinkingLevel ?? ThinkingLevel.MEDIUM,
      },
    };

    const initialTurns: DialogueTurn[] = formatHistoryWithInnerThought(
      history,
      this.config.appTimezone,
    ).map((turn) => ({
      role: turn.role === 'model' ? 'assistant' : 'user',
      text: turn.text,
    }));

    const toolRegistry = new PersonaToolRegistry().register(
      createSearchWebTool({ search: (q) => this.executeWebSearch(q) }),
    );

    const dialogueClient: ILLMToolDialogueClient = {
      generateStep: async (ctx) => {
        const genAiTools = toGeminiTools(ctx.declarations);
        const response = await aiClient.models.generateContent({
          model: this.config.model,
          contents: toGeminiContents(ctx),
          config: genAiTools.length > 0 ? { ...baseConfig, tools: genAiTools } : baseConfig,
        });

        return mapGeminiDialogueStepResult(response);
      },
    };

    try {
      return await runToolDialogueLoop({
        initialTurns,
        userInput,
        toolRegistry,
        maxToolRounds: 1,
        client: dialogueClient,
        parseOutput: (rawText, afterToolExecution) => {
          const parsed = parsePersonaResponse(rawText);
          if (!parsed.reply || !parsed.reply.trim()) {
            throw new Error(
              afterToolExecution
                ? 'Gemini API returned structured response with empty reply after function execution.'
                : 'Gemini API returned structured response with empty reply.',
            );
          }
          return parsed;
        },
      });
    } catch (error) {
      if (error instanceof EmptyDialogueResponseError) {
        return rethrowUpstreamApiError(
          new Error(
            error.afterToolExecution
              ? 'Gemini API returned empty structured response after function execution.'
              : 'Gemini API returned empty structured response or content was filtered.',
            { cause: error },
          ),
          'Error generating structured reply with Gemini',
        );
      }
      return rethrowUpstreamApiError(error, 'Error generating structured reply with Gemini');
    }
  }
}
