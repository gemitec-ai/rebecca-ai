/**
 * Optional structured logger contract compatible with `@rebecca/logger` and app loggers.
 */
export interface ToolLogger {
  info?(message: string, meta?: unknown): void;
  warn?(message: string, meta?: unknown): void;
  error?(message: string, error?: unknown, meta?: unknown): void;
}

/** Canonical function name for the shared Google Search Grounding persona tool. */
export const SEARCH_WEB_TOOL_NAME = 'search_web';

/** Localized fallback returned to the model when `search_web` is invoked without a query. */
export const EMPTY_WEB_SEARCH_QUERY_RESULT = '検索クエリが指定されていません。';

/**
 * Minimal schema definition compatible with Gemini Function Calling parameter schemas
 * without coupling `@rebecca/tools` to `@google/genai` runtime binaries.
 */
export interface PersonaFunctionParameterProperty {
  readonly type: string;
  readonly description: string;
  readonly enum?: readonly string[];
}

/**
 * Provider-agnostic FunctionDeclaration contract compatible with Gemini `FunctionDeclaration`.
 */
export interface PersonaFunctionDeclaration {
  readonly name: string;
  readonly description: string;
  readonly parameters: {
    readonly type: string;
    readonly properties: Readonly<Record<string, PersonaFunctionParameterProperty>>;
    readonly required: readonly string[];
  };
}

/**
 * Gemini-compatible tool wrapper containing one or more function declarations.
 */
export interface PersonaFunctionToolGroup {
  readonly functionDeclarations: PersonaFunctionDeclaration[];
}

/**
 * Canonical `search_web` Function Calling declaration shared across Rebecca services.
 */
export const SEARCH_WEB_TOOL_DECLARATION: PersonaFunctionDeclaration = {
  name: SEARCH_WEB_TOOL_NAME,
  description:
    'Searches the web for up-to-date information, facts, or answers when asked questions or requested to investigate a topic.',
  parameters: {
    type: 'OBJECT',
    properties: {
      query: {
        type: 'STRING',
        description: 'Search keywords or question to look up on the web',
      },
    },
    required: ['query'],
  },
};

/**
 * Ready-to-pass tool group containing {@link SEARCH_WEB_TOOL_DECLARATION}.
 */
export const SEARCH_WEB_TOOL: PersonaFunctionToolGroup = {
  functionDeclarations: [SEARCH_WEB_TOOL_DECLARATION],
};

/**
 * Minimal structural interface matching `@google/genai`'s `GoogleGenAI` client for Grounded Search.
 */
export interface IGeminiWebSearchClient {
  models: {
    generateContent(params: {
      model: string;
      contents: Array<{ role: 'user'; parts: Array<{ text: string }> }>;
      config: {
        tools: Array<{ googleSearch: Record<string, never> }>;
        safetySettings: never[];
      };
    }): Promise<{ text?: string }>;
  };
}

/**
 * Executes Google Search Grounding via a Gemini-compatible client for an arbitrary query.
 * Preserves resilient failure isolation so transient web-search errors return descriptive
 * localized status messages rather than crashing active user conversations.
 *
 * @param client - Initialized `GoogleGenAI`-compatible client, or `null` if not configured.
 * @param model - Target Gemini search model identifier.
 * @param query - Search keywords or natural-language question.
 * @param logger - Optional structured logger for transient upstream search warnings.
 * @returns Grounded text summary or a localized fallback status message.
 */
export const executeGoogleWebSearch = async (
  client: IGeminiWebSearchClient | null,
  model: string,
  query: string,
  logger?: ToolLogger,
): Promise<string> => {
  if (!client) {
    return '検索クライアントが未初期化です。';
  }

  const trimmed = query.trim();
  if (!trimmed) {
    return '検索クエリが空です。';
  }

  if (!model.trim()) {
    throw new Error('Cannot execute Google Web Search: search model identifier must not be empty');
  }

  try {
    const res = await client.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: trimmed }] }],
      config: {
        tools: [{ googleSearch: {} }],
        safetySettings: [],
      },
    });
    return res.text?.trim() || '該当する検索結果が見つかりませんでした。';
  } catch (err) {
    logger?.warn?.('[executeWebSearch] Failed to search for query', {
      query: trimmed,
      error: err instanceof Error ? err.message : String(err),
    });
    return '一時的なネットワークまたは検索エラーにより情報を取得できませんでした。';
  }
};
