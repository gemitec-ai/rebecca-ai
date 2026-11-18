import { Content, GoogleGenAI, Schema, Tool, Type } from '@google/genai';
import type { StructuredPersonaObjectSchema } from '@rebecca/persona';
import type {
  ILLMToolDialogueClient,
  JsonSchemaPrimitiveType,
  ToolDeclaration,
  ToolDialogueStepContext,
} from '@rebecca/tools';

const JSON_SCHEMA_TO_GEMINI_TYPE: Readonly<Record<JsonSchemaPrimitiveType, Type>> = {
  string: Type.STRING,
  number: Type.NUMBER,
  integer: Type.INTEGER,
  boolean: Type.BOOLEAN,
  array: Type.ARRAY,
  object: Type.OBJECT,
};

/**
 * Translates `@rebecca/tools` provider-neutral declarations into Gemini `Tool[]` declarations.
 */
export const toGeminiTools = (declarations: ReadonlyArray<ToolDeclaration>): Tool[] => {
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
};

const isGeminiContent = (value: unknown): value is Content => {
  return typeof value === 'object' && value !== null && 'parts' in value;
};

/**
 * Converts a `@rebecca/tools` step context into Gemini `Content[]`, preserving
 * thought-signature opaque model turns alongside tool invocation responses.
 */
export const toGeminiContents = (ctx: ToolDialogueStepContext): Content[] => {
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
 * Calls `aiClient.models.generateContent` guarded by a clearable timer so slow
 * responses fail cleanly without leaking dangling Node event-loop timers.
 */
const generateContentWithTimeout = async (
  aiClient: GoogleGenAI,
  model: string,
  timeoutMs: number,
  contents: Content[],
  callConfig: Record<string, unknown>,
) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutGuard = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Gemini API call timed out')),
        timeoutMs,
      );
    });
    return await Promise.race([
      aiClient.models.generateContent({
        model,
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

/**
 * Constructs an {@link ILLMToolDialogueClient} adapter bridging `@rebecca/tools`'s
 * dialogue loop onto Gemini Function Calling and schema-constrained JSON synthesis.
 */
export const createCopilotDialogueClient = (options: {
  readonly aiClient: GoogleGenAI;
  readonly model: string;
  readonly timeoutMs: number;
  readonly systemInstruction: string;
  readonly responseSchema: StructuredPersonaObjectSchema;
}): ILLMToolDialogueClient => {
  const { aiClient, model, timeoutMs, systemInstruction, responseSchema } = options;

  const synthesisConfig = {
    systemInstruction: `${systemInstruction}\n\nSynthesize your final response with internal thought (Honne), spoken reply (Tatemae), and 1-3 relevant suggestionChips strictly matching the response JSON schema.`,
    temperature: 0.7,
    responseMimeType: 'application/json',
    responseSchema,
  };

  return {
    generateStep: async (ctx) => {
      const geminiTools = toGeminiTools(ctx.declarations);
      const stepConfig =
        geminiTools.length > 0
          ? {
              systemInstruction,
              temperature: 0.7,
              tools: geminiTools,
            }
          : synthesisConfig;

      const response = await generateContentWithTimeout(
        aiClient,
        model,
        timeoutMs,
        toGeminiContents(ctx),
        stepConfig,
      );

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
};
