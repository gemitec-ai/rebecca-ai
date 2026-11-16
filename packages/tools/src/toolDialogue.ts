import { DEFAULT_APP_TIMEZONE, formatHistoryWithInnerThought } from '@rebecca/memory';
import { parsePersonaResponse, type StructuredPersonaResponse } from '@rebecca/persona';
import type { ConversationLogEntry } from '@rebecca/types';
import {
  EMPTY_WEB_SEARCH_QUERY_RESULT,
  SEARCH_WEB_TOOL_DECLARATION,
  type PersonaFunctionDeclaration,
  type PersonaFunctionToolGroup,
} from './webSearch';

/**
 * Provider-agnostic conversational content part compatible with Gemini `Part`.
 */
export interface DialogueContentPart {
  readonly text?: string;
  readonly functionCall?: {
    readonly name?: string;
    readonly args?: Readonly<Record<string, unknown>>;
  };
  readonly functionResponse?: {
    readonly name?: string;
    readonly response?: Readonly<Record<string, unknown>>;
  };
}

/**
 * Provider-agnostic conversational turn message compatible with Gemini `Content`.
 */
export interface DialogueContentMessage {
  readonly role?: string;
  readonly parts?: DialogueContentPart[];
}

/**
 * Abstracted single model generation step returned by an LLM adapter.
 */
export interface DialogueModelStepResult {
  readonly text?: string;
  readonly functionCalls?: ReadonlyArray<{
    readonly name?: string;
    readonly args?: Readonly<Record<string, unknown>>;
  }>;
  readonly modelContent?: DialogueContentMessage;
}

/**
 * Definition for an executable Function Calling tool registered for persona conversations.
 */
export interface PersonaToolDefinition {
  readonly declaration: PersonaFunctionDeclaration;
  execute(args: Readonly<Record<string, unknown>> | undefined): Promise<Record<string, unknown>>;
}

/**
 * Creates a reusable `PersonaToolDefinition` wrapping the canonical `search_web` declaration
 * and a caller-supplied search runner (e.g., `executeGoogleWebSearch`).
 *
 * @param searchRunner - Async search implementation taking a trimmed query string.
 * @returns Configured `PersonaToolDefinition` for `search_web`.
 */
export const createSearchWebTool = (
  searchRunner: (query: string) => Promise<string>,
): PersonaToolDefinition => ({
  declaration: SEARCH_WEB_TOOL_DECLARATION,
  execute: async (args) => {
    const rawQuery = args?.query;
    const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
    const result = query ? await searchRunner(query) : EMPTY_WEB_SEARCH_QUERY_RESULT;
    return { result };
  },
});

/**
 * Extensible registry of Function Calling tools available to the persona during generation.
 * Shared between X Bot (`search_web`) and Private Lounge (`search_web` + session tools).
 */
export class PersonaToolRegistry {
  private readonly tools = new Map<string, PersonaToolDefinition>();

  /**
   * Registers a new persona tool declaration and execution handler.
   *
   * @param tool - Tool definition to register.
   * @returns `this` for fluent builder chaining.
   * @throws Error if another tool with the same name is already registered.
   */
  register(tool: PersonaToolDefinition): this {
    const name = tool.declaration.name.trim();
    if (!name) {
      throw new Error('Cannot register persona tool with empty name');
    }
    if (this.tools.has(name)) {
      throw new Error(`Persona tool "${name}" is already registered`);
    }
    this.tools.set(name, tool);
    return this;
  }

  /**
   * Checks whether a callable tool with the given name exists in this registry.
   */
  has(name: string | undefined): boolean {
    return typeof name === 'string' && this.tools.has(name);
  }

  /**
   * Returns all registered Function Calling declarations in insertion order.
   */
  getDeclarations(): PersonaFunctionDeclaration[] {
    return Array.from(this.tools.values(), (entry) => entry.declaration);
  }

  /**
   * Exports Gemini-compatible `tools` array, or `[]` when no tools are registered.
   */
  toToolGroups(): PersonaFunctionToolGroup[] {
    const declarations = this.getDeclarations();
    if (declarations.length === 0) {
      return [];
    }
    return [{ functionDeclarations: declarations }];
  }

  /**
   * Dispatches a registered tool handler by name.
   *
   * @throws Error if no tool with `name` is registered.
   */
  async execute(
    name: string,
    args: Readonly<Record<string, unknown>> | undefined,
  ): Promise<Record<string, unknown>> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown persona tool requested: "${name}"`);
    }
    return tool.execute(args);
  }
}

/**
 * Options for running a Tatemae/Honne structured dialogue turn with Function Calling support.
 */
export interface RunStructuredDialogueOptions {
  readonly history: readonly ConversationLogEntry[];
  readonly userInput: string;
  readonly timezone?: string;
  readonly toolRegistry?: PersonaToolRegistry;
  /** Maximum consecutive tool-calling rounds before forcing final text generation. Defaults to `1`. */
  readonly maxToolRounds?: number;
  readonly generateStep: (
    contents: DialogueContentMessage[],
    tools: PersonaFunctionToolGroup[],
  ) => Promise<DialogueModelStepResult>;
}

/**
 * Parses and validates `{ thought, reply }` JSON from raw structured model output.
 */
const parseAndValidatePersonaOutput = (
  rawText: string | undefined,
  afterToolExecution: boolean,
): StructuredPersonaResponse => {
  const trimmed = rawText?.trim();
  const suffix = afterToolExecution ? ' after function execution' : '';
  if (!trimmed) {
    throw new Error(
      `Gemini API returned empty structured response${afterToolExecution ? ' after function execution.' : ' or content was filtered.'}`,
    );
  }
  const parsed = parsePersonaResponse(trimmed);
  if (!parsed.reply || !parsed.reply.trim()) {
    throw new Error(`Gemini API returned structured response with empty reply${suffix}.`);
  }
  return parsed;
};

/**
 * Orchestrates a complete Tatemae/Honne structured conversation turn:
 * 1. Reconstructs recent history with `【思考・本音】` / `【発話】` framing via `@rebecca/memory`.
 * 2. Invokes the injected model step with optional `PersonaToolRegistry` tool groups.
 * 3. Executes any matching registered tool call (such as `search_web`) and re-prompts for final JSON output.
 * 4. Parses and validates non-empty `reply` before returning `{ thought, reply }`.
 *
 * @param options - Dialogue history, user input, optional tool registry, and model step adapter.
 * @returns Validated structured persona response `{ thought, reply }`.
 */
export const runStructuredDialogueWithTools = async (
  options: RunStructuredDialogueOptions,
): Promise<StructuredPersonaResponse> => {
  const {
    history,
    userInput,
    timezone = DEFAULT_APP_TIMEZONE,
    toolRegistry,
    maxToolRounds = 1,
    generateStep,
  } = options;

  const formattedTurns = formatHistoryWithInnerThought(history, timezone);
  const contents: DialogueContentMessage[] = formattedTurns.map((turn) => ({
    role: turn.role,
    parts: [{ text: turn.text }],
  }));
  contents.push({ role: 'user', parts: [{ text: userInput }] });

  const allToolGroups = toolRegistry ? toolRegistry.toToolGroups() : [];
  let executedToolCall = false;

  if (allToolGroups.length > 0 && maxToolRounds > 0) {
    for (let round = 0; round < maxToolRounds; round++) {
      const step = await generateStep(contents, allToolGroups);
      const functionCall = step.functionCalls?.[0];

      if (!functionCall || !functionCall.name || !toolRegistry?.has(functionCall.name)) {
        return parseAndValidatePersonaOutput(step.text, executedToolCall);
      }

      const toolResult = await toolRegistry.execute(functionCall.name, functionCall.args);

      if (step.modelContent) {
        contents.push(step.modelContent);
      }

      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: functionCall.name,
              response: toolResult,
            },
          },
        ],
      });

      executedToolCall = true;
    }
  }

  const finalStep = await generateStep(contents, []);
  return parseAndValidatePersonaOutput(finalStep.text, executedToolCall);
};
