/**
 * Optional structured logger port compatible with `@rebecca/logger` and application loggers.
 */
export interface ToolLogger {
  info?(message: string, meta?: unknown): void;
  warn?(message: string, meta?: unknown): void;
  error?(message: string, error?: unknown, meta?: unknown): void;
}

/** Canonical function name for the shared web lookup tool. */
export const SEARCH_WEB_TOOL_NAME = 'search_web';

/** Localized message returned to the model when `search_web` is invoked without a query. */
export const EMPTY_WEB_SEARCH_QUERY_RESULT = '検索クエリが指定されていません。';

/**
 * Provider-agnostic JSON Schema primitive types for tool parameter definitions.
 */
export type JsonSchemaPrimitiveType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'array'
  | 'object';

/**
 * Standard JSON Schema property contract describing a single tool argument.
 */
export interface ToolParameterProperty {
  readonly type: JsonSchemaPrimitiveType;
  readonly description: string;
  readonly enum?: readonly string[];
}

/**
 * Provider-agnostic Function Calling declaration using standard JSON Schema types.
 * Infrastructure adapters (e.g., Gemini, OpenAI, Anthropic) translate this schema
 * into their SDK-specific wire representation at the application boundary.
 */
export interface ToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly parameters: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, ToolParameterProperty>>;
    readonly required: readonly string[];
  };
}

/**
 * Infrastructure port for executing live web search lookups against an external provider.
 */
export interface IWebSearchProvider {
  search(query: string): Promise<string>;
}

/**
 * Executable tool definition paired with its provider-agnostic JSON Schema declaration.
 */
export interface ToolDefinition {
  readonly declaration: ToolDeclaration;
  execute(args: Readonly<Record<string, unknown>> | undefined): Promise<Record<string, unknown>>;
}

/**
 * Canonical `search_web` tool declaration shared across applications.
 */
export const SEARCH_WEB_TOOL_DECLARATION: ToolDeclaration = {
  name: SEARCH_WEB_TOOL_NAME,
  description:
    'Searches the web for up-to-date information, facts, or answers when asked questions or requested to investigate a topic.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search keywords or question to look up on the web',
      },
    },
    required: ['query'],
  },
};

/**
 * Creates a `ToolDefinition` for `search_web` backed by an injected {@link IWebSearchProvider}
 * (or async search function). Normalizes whitespace queries and supplies a deterministic
 * fallback payload when no query string is provided.
 *
 * @param provider - Web search infrastructure adapter or async lookup callback.
 * @returns Configured `ToolDefinition` ready for registration in `PersonaToolRegistry`.
 */
export const createSearchWebTool = (
  provider: IWebSearchProvider | ((query: string) => Promise<string>),
): ToolDefinition => {
  const executeLookup =
    typeof provider === 'function' ? provider : (query: string) => provider.search(query);

  return {
    declaration: SEARCH_WEB_TOOL_DECLARATION,
    execute: async (args) => {
      const rawQuery = args?.query;
      const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
      const result = query ? await executeLookup(query) : EMPTY_WEB_SEARCH_QUERY_RESULT;
      return { result };
    },
  };
};
