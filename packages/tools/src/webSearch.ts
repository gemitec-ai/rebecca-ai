/** Canonical function name for the shared web lookup tool. */
export const SEARCH_WEB_TOOL_NAME = 'search_web';

/** Default localized fallback returned when `search_web` is invoked without a query. */
export const DEFAULT_EMPTY_WEB_SEARCH_QUERY_RESULT = '検索クエリが指定されていません。';

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
 * Infrastructure adapters (Gemini, Azure OpenAI, Bedrock, etc.) translate this contract
 * into their wire schema representation at the application boundary.
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
 * Optional configuration overrides for {@link createSearchWebTool}.
 */
export interface SearchWebToolOptions {
  /** Message returned to the model when `query` is missing or whitespace-only. */
  readonly emptyQueryResult?: string;
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
 * (or async lookup callback). Normalizes whitespace queries and returns a configurable fallback
 * message when no query string is provided.
 *
 * @param provider - Web search infrastructure adapter or async lookup callback.
 * @param options - Optional localized fallback message overrides.
 * @returns Configured `ToolDefinition` ready for registration in `PersonaToolRegistry`.
 */
export const createSearchWebTool = (
  provider: IWebSearchProvider | ((query: string) => Promise<string>),
  options?: SearchWebToolOptions,
): ToolDefinition => {
  const executeLookup =
    typeof provider === 'function' ? provider : (query: string) => provider.search(query);
  const emptyQueryResult = options?.emptyQueryResult ?? DEFAULT_EMPTY_WEB_SEARCH_QUERY_RESULT;

  return {
    declaration: SEARCH_WEB_TOOL_DECLARATION,
    execute: async (args) => {
      const rawQuery = args?.query;
      const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
      const result = query ? await executeLookup(query) : emptyQueryResult;
      return { result };
    },
  };
};
