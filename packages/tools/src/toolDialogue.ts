import type { ToolDeclaration, ToolDefinition } from './webSearch';

/**
 * Provider-agnostic conversational role used across LLM dialogue adapters.
 * Adapters map `'assistant'` to provider-specific identifiers (e.g., Gemini `'model'`
 * or Azure OpenAI `'assistant'`) at the application infrastructure boundary.
 */
export type DialogueRole = 'user' | 'assistant';

/**
 * Provider-agnostic conversational turn input consumed by tool dialogue orchestration.
 */
export interface DialogueTurn {
  readonly role: DialogueRole;
  readonly text: string;
}

/**
 * Normalized tool invocation request emitted by an LLM generation step.
 */
export interface ToolCallRequest {
  /** Provider-assigned tool invocation identifier (required by Chat Completions APIs such as Azure OpenAI). */
  readonly id?: string;
  readonly name: string;
  readonly args?: Readonly<Record<string, unknown>>;
}

/**
 * Normalized execution result for a single invoked tool call.
 */
export interface ToolCallOutcome {
  /** Matching invocation identifier echoed from {@link ToolCallRequest.id}. */
  readonly id?: string;
  readonly name: string;
  readonly result: Record<string, unknown>;
}

/**
 * Immutable record of one completed tool-calling round (model calls paired with tool results).
 */
export interface ToolRoundRecord {
  /** Opaque provider-native assistant turn payload (e.g., Gemini Content with thought signatures or OpenAI assistant tool_calls message). */
  readonly opaqueProviderTurn?: unknown;
  readonly calls: ReadonlyArray<ToolCallRequest>;
  readonly outcomes: ReadonlyArray<ToolCallOutcome>;
}

/**
 * Context passed to an infrastructure model adapter on each generation step.
 * Infrastructure adapters translate this provider-agnostic state into SDK payloads.
 */
export interface ToolDialogueStepContext {
  readonly initialTurns: ReadonlyArray<DialogueTurn>;
  readonly userInput: string;
  readonly rounds: ReadonlyArray<ToolRoundRecord>;
  readonly declarations: ReadonlyArray<ToolDeclaration>;
}

/**
 * Provider-agnostic generation outcome returned by an infrastructure model step.
 */
export interface ToolDialogueStepResult {
  readonly text?: string;
  readonly toolCalls?: ReadonlyArray<ToolCallRequest>;
  /** Optional opaque assistant turn object preserved verbatim for subsequent rounds in the same conversation turn. */
  readonly opaqueProviderTurn?: unknown;
}

/**
 * Infrastructure port implemented by host application LLM clients (e.g., Gemini, Azure OpenAI)
 * to execute single-step inference within a provider-agnostic tool loop.
 */
export interface ILLMToolDialogueClient {
  generateStep(context: ToolDialogueStepContext): Promise<ToolDialogueStepResult>;
}

/**
 * Typed error raised when an LLM generation step yields empty or filtered text output.
 */
export class EmptyDialogueResponseError extends Error {
  readonly afterToolExecution: boolean;

  constructor(afterToolExecution: boolean) {
    super(
      afterToolExecution
        ? 'Structured model returned an empty response after tool execution.'
        : 'Structured model returned an empty response or content was filtered.',
    );
    this.name = 'EmptyDialogueResponseError';
    this.afterToolExecution = afterToolExecution;
  }
}

/**
 * Extensible registry mapping canonical tool names to JSON Schema declarations and handlers.
 */
export class PersonaToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  /**
   * Registers a new tool definition.
   *
   * @param tool - Executable tool paired with its JSON Schema declaration.
   * @returns `this` for fluent chaining.
   * @throws Error when declaration name is blank or already registered.
   */
  register(tool: ToolDefinition): this {
    const name = tool.declaration.name.trim();
    if (!name) {
      throw new Error('Cannot register tool with an empty name');
    }
    if (this.tools.has(name)) {
      throw new Error(`Tool "${name}" is already registered`);
    }
    this.tools.set(name, tool);
    return this;
  }

  /**
   * Returns `true` when a registered tool matches `name`.
   */
  has(name: string | undefined): boolean {
    return typeof name === 'string' && this.tools.has(name);
  }

  /**
   * Returns all registered JSON Schema tool declarations in insertion order.
   */
  getDeclarations(): ToolDeclaration[] {
    return Array.from(this.tools.values(), (entry) => entry.declaration);
  }

  /**
   * Executes a registered tool by name with model-supplied arguments.
   *
   * @param name - Registered tool name.
   * @param args - Parsed arguments from model tool-call output.
   * @returns JSON-serializable result object returned to the model.
   * @throws Error if `name` is not registered.
   */
  async execute(
    name: string,
    args: Readonly<Record<string, unknown>> | undefined,
  ): Promise<Record<string, unknown>> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool requested: "${name}"`);
    }
    return tool.execute(args);
  }
}

/**
 * Configuration options for {@link runToolDialogueLoop}.
 */
export interface RunToolDialogueOptions<TOutput> {
  readonly initialTurns: ReadonlyArray<DialogueTurn>;
  readonly userInput: string;
  readonly toolRegistry?: PersonaToolRegistry;
  /** Maximum consecutive tool-calling rounds before forcing final text generation. Defaults to `1`. */
  readonly maxToolRounds?: number;
  /** Model step executor callback or {@link ILLMToolDialogueClient} adapter instance. */
  readonly client: ILLMToolDialogueClient | ((context: ToolDialogueStepContext) => Promise<ToolDialogueStepResult>);
  /**
   * Pure parser transforming final raw model text into `TOutput` (must never perform I/O).
   */
  readonly parseOutput: (rawText: string, afterToolExecution: boolean) => TOutput;
  /**
   * Optional pure fast-path validator evaluated when a step with active tool declarations
   * concludes without requesting further tool calls. If it returns `undefined`, the loop formally
   * transitions to the final constrained step (`declarations: []`) preserving accumulated `rounds`.
   */
  readonly tryAcceptStepOutput?: (rawText: string, afterToolExecution: boolean) => TOutput | undefined;
}

/**
 * Orchestrates a provider-agnostic multi-turn tool-calling loop and final output parsing:
 * 1. Invokes the injected LLM adapter with active JSON Schema tool declarations.
 * 2. Executes all valid registered tool calls emitted in the round and records correlated `id`/outcomes.
 * 3. Forces a final generation step without tool declarations when tool rounds exhaust or
 *    when `tryAcceptStepOutput` declines an unvalidated intermediate response.
 * 4. Delegates final raw text validation and parsing to the pure `parseOutput` callback.
 *
 * @param options - Preformatted neutral turns, user input, optional registry, LLM adapter, and parser.
 * @returns Parsed structured output produced by `parseOutput`.
 * @throws {@link EmptyDialogueResponseError} when the final model text is empty or whitespace.
 */
export const runToolDialogueLoop = async <TOutput>(
  options: RunToolDialogueOptions<TOutput>,
): Promise<TOutput> => {
  const {
    initialTurns,
    userInput,
    toolRegistry,
    maxToolRounds = 1,
    client,
    parseOutput,
    tryAcceptStepOutput,
  } = options;

  const generateStep =
    typeof client === 'function' ? client : (ctx: ToolDialogueStepContext) => client.generateStep(ctx);

  const declarations = toolRegistry ? toolRegistry.getDeclarations() : [];
  const rounds: ToolRoundRecord[] = [];

  if (toolRegistry && declarations.length > 0 && maxToolRounds > 0) {
    for (let roundIndex = 0; roundIndex < maxToolRounds; roundIndex++) {
      const step = await generateStep({
        initialTurns,
        userInput,
        rounds: [...rounds],
        declarations,
      });

      const executableCalls = (step.toolCalls ?? []).filter(
        (call) => Boolean(call.name) && toolRegistry.has(call.name),
      );

      if (executableCalls.length === 0) {
        const trimmed = step.text?.trim();
        if (tryAcceptStepOutput) {
          if (trimmed) {
            const accepted = tryAcceptStepOutput(trimmed, rounds.length > 0);
            if (accepted !== undefined) {
              return accepted;
            }
          }
          break;
        }
        if (!trimmed) {
          throw new EmptyDialogueResponseError(rounds.length > 0);
        }
        return parseOutput(trimmed, rounds.length > 0);
      }

      const outcomes: ToolCallOutcome[] = [];
      for (const call of executableCalls) {
        const result = await toolRegistry.execute(call.name, call.args);
        outcomes.push({
          id: call.id,
          name: call.name,
          result,
        });
      }

      rounds.push({
        opaqueProviderTurn: step.opaqueProviderTurn,
        calls: executableCalls,
        outcomes,
      });
    }
  }

  const finalStep = await generateStep({
    initialTurns,
    userInput,
    rounds: [...rounds],
    declarations: [],
  });

  const finalTrimmed = finalStep.text?.trim();
  if (!finalTrimmed) {
    throw new EmptyDialogueResponseError(rounds.length > 0);
  }
  return parseOutput(finalTrimmed, rounds.length > 0);
};
