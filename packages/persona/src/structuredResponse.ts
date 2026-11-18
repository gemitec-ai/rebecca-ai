import { StructuredPersonaResponse } from './types';

/**
 * Provider-neutral JSON Schema field descriptor compatible with Gemini `responseSchema`
 * and OpenAPI-style structured generation contracts.
 */
export interface StructuredPersonaSchemaField {
  readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly items?: StructuredPersonaSchemaField;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly properties?: Readonly<Record<string, StructuredPersonaSchemaField>>;
  readonly required?: readonly string[];
}

/**
 * Canonical JSON Schema contract enforcing dual-layer Honne (`thought`) and Tatemae (`reply` / spoken field)
 * structured outputs across all persona-speaking channels.
 */
export interface StructuredPersonaObjectSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, StructuredPersonaSchemaField>>;
  readonly required: readonly string[];
}

/**
 * Configuration options for composing a channel- or feature-specific Honne & Tatemae response schema.
 */
export interface CreateStructuredPersonaSchemaOptions {
  /** Custom description overriding the default `thought` (Honne) field guidance. */
  readonly thoughtDescription?: string;
  /** Spoken/public output property name (Tatemae). Defaults to `'reply'`. */
  readonly replyFieldName?: string;
  /** Description for the spoken output property. */
  readonly replyDescription?: string;
  /** Additional feature-specific schema fields merged alongside `thought` and the spoken output field. */
  readonly additionalProperties?: Readonly<Record<string, StructuredPersonaSchemaField>>;
  /** Additional required property names beyond `thought` and the spoken output field. */
  readonly additionalRequired?: readonly string[];
}

const DEFAULT_THOUGHT_DESCRIPTION =
  'Inner thoughts, true feelings, and emotional shifts based on the persona.';
const DEFAULT_REPLY_DESCRIPTION = 'The actual reply intended for the user.';

/**
 * Constructs a strict JSON Schema that enforces both internal monologue (`thought`, Honne)
 * and external spoken output (`reply` or `replyFieldName`, Tatemae) as mandatory properties.
 *
 * Callers can extend the schema with feature-specific fields (such as news headlines,
 * poll choices, or dashboard suggestion chips) without risking accidental omission of `thought`.
 *
 * @param options - Optional field descriptions and extra feature-specific schema properties.
 * @returns Structured JSON Schema object with `'thought'` and the spoken output field guaranteed in `required`.
 * @throws Error if `replyFieldName` is blank, equals `'thought'`, or `additionalProperties` attempts to override core fields.
 */
export const createStructuredPersonaSchema = (
  options: CreateStructuredPersonaSchemaOptions = {},
): StructuredPersonaObjectSchema => {
  const replyFieldName = (options.replyFieldName ?? 'reply').trim();
  if (!replyFieldName || replyFieldName === 'thought') {
    throw new Error('replyFieldName must be a non-empty string distinct from "thought".');
  }

  const additionalProperties = options.additionalProperties ?? {};
  if (Object.hasOwn(additionalProperties, 'thought') || Object.hasOwn(additionalProperties, replyFieldName)) {
    throw new Error(
      `additionalProperties must not override mandatory Honne/Tatemae fields ("thought", "${replyFieldName}").`,
    );
  }

  const properties: Record<string, StructuredPersonaSchemaField> = {
    thought: {
      type: 'string',
      description: options.thoughtDescription?.trim() || DEFAULT_THOUGHT_DESCRIPTION,
    },
    [replyFieldName]: {
      type: 'string',
      description: options.replyDescription?.trim() || DEFAULT_REPLY_DESCRIPTION,
    },
    ...additionalProperties,
  };

  const required = Array.from(
    new Set(['thought', replyFieldName, ...(options.additionalRequired ?? [])]),
  );

  return {
    type: 'object',
    properties,
    required,
  };
};

/**
 * Canonical Gemini Structured Outputs schema for standard Persona reply generation (`thought` + `reply`).
 */
export const PERSONA_RESPONSE_SCHEMA = createStructuredPersonaSchema();

/**
 * Sanitizes JSON strings output by LLMs by:
 * 1. Stripping markdown code fences (```json ... ``` or ``` ... ```)
 * 2. Trimming leading/trailing whitespace
 * 3. Escaping raw unescaped control characters (newlines, carriage returns, tabs) inside string literals
 *    to prevent `SyntaxError: Unterminated string in JSON`.
 *
 * @param raw - The raw text received from the model.
 * @returns A cleaned JSON string ready for `JSON.parse`.
 */
export const cleanJsonString = (raw: string): string => {
  if (!raw || typeof raw !== 'string') {
    return '';
  }

  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?/i, '').trimStart();
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.slice(0, -3).trimEnd();
  }

  // Fast path: if already valid JSON, return immediately
  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch {
    // Fallback: escape raw control characters inside JSON string literals
    let result = '';
    let inString = false;
    let isEscaped = false;

    for (let i = 0; i < cleaned.length; i++) {
      const char = cleaned[i];
      if (inString) {
        if (isEscaped) {
          result += char;
          isEscaped = false;
        } else if (char === '\\') {
          result += char;
          isEscaped = true;
        } else if (char === '"') {
          result += char;
          inString = false;
        } else if (char === '\n') {
          result += '\\n';
        } else if (char === '\r') {
          result += '\\r';
        } else if (char === '\t') {
          result += '\\t';
        } else if (char === '\b') {
          result += '\\b';
        } else if (char === '\f') {
          result += '\\f';
        } else if (char.charCodeAt(0) < 0x20) {
          result += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
        } else {
          result += char;
        }
      } else {
        if (char === '"') {
          inString = true;
        }
        result += char;
      }
    }
    return result;
  }
};

/**
 * Parses an LLM text response into a plain JSON object record, handling markdown code fences,
 * unescaped control characters inside strings, and outermost `{ ... }` extraction when JSON
 * is surrounded by conversational prose.
 *
 * @param raw - Raw text returned by the LLM.
 * @returns Parsed JSON object record, or `null` if extraction fails or parsed value is not an object.
 */
export const parsePersonaJsonObject = (raw: string): Record<string, unknown> | null => {
  if (!raw || typeof raw !== 'string') {
    return null;
  }

  const cleaned = cleanJsonString(raw);
  if (!cleaned) {
    return null;
  }

  const tryParseRecord = (candidate: string): Record<string, unknown> | null => {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Ignore parse failure to allow outermost brace fallback
    }
    return null;
  };

  const direct = tryParseRecord(cleaned);
  if (direct) {
    return direct;
  }

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return tryParseRecord(cleanJsonString(cleaned.slice(firstBrace, lastBrace + 1)));
  }

  return null;
};

/**
 * Parses structured persona responses (`thought` + `reply`) from Gemini.
 * Fails cleanly by returning empty strings when the output is not valid JSON conforming to the schema.
 *
 * @param raw - Raw structured output string from Gemini.
 * @returns Normalized `{ thought, reply }` pair.
 */
export const parsePersonaResponse = (raw: string): StructuredPersonaResponse => {
  const parsed = parsePersonaJsonObject(raw);
  if (!parsed) {
    return { thought: '', reply: '' };
  }

  const thought = typeof parsed['thought'] === 'string' ? parsed['thought'].trim() : '';
  const reply = typeof parsed['reply'] === 'string' ? parsed['reply'].trim() : '';

  return { thought, reply };
};
