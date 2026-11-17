import { Content, Schema, Tool, Type } from '@google/genai';
import type {
  JsonSchemaPrimitiveType,
  ToolDeclaration,
  ToolDialogueStepContext,
  ToolDialogueStepResult,
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
 * Converts provider-neutral tool declarations from `@rebecca/tools` into Gemini SDK `Tool[]`.
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
 * Converts a `@rebecca/tools` step context (prior dialogue turns + executed tool rounds)
 * into Gemini SDK `Content[]` including opaque thought-signature turns and function responses.
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
 * Extracts normalized `@rebecca/tools` step results from a raw Gemini `generateContent` response.
 */
export const mapGeminiDialogueStepResult = (response: {
  text?: string;
  candidates?: Array<{ content?: Content }>;
  functionCalls?: Array<{ name?: string; args?: Record<string, unknown> }>;
}): ToolDialogueStepResult => {
  const rawModelContent = response.candidates?.[0]?.content;
  const mappedCalls = (response.functionCalls ?? [])
    .filter((call): call is { name: string; args?: Record<string, unknown> } =>
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
};
