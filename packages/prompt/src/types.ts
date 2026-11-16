import type { IMemoryVectorEmbedder, MemoryLogger, MemoryUserSnapshot } from '@rebecca/memory';
import type { IPersonaDefinition, Language, PersonaPatternWithVector } from '@rebecca/persona';
import type { ConversationLogEntry, UserCoreProfile } from '@rebecca/types';

/**
 * Structured date and time components localized to a specific IANA time zone.
 */
export interface ZonedDateParts {
  readonly year: string;
  readonly month: string;
  readonly day: string;
  readonly hour: string;
  readonly minute: string;
  readonly second: string;
  readonly numericYear: number;
  readonly numericMonth: number;
  readonly numericDay: number;
  readonly numericHour: number;
  readonly numericMinute: number;
}

/**
 * Discrete time-of-day brackets used for situational persona tone injection.
 */
export type TimeContextPeriod =
  | 'early_morning'
  | 'morning'
  | 'daytime'
  | 'evening'
  | 'late_night';

/**
 * Injectable time-resolution strategy for deterministic testing and timezone overrides.
 */
export interface PromptTimeResolver {
  getZonedDateParts(date?: Date, timezone?: string): ZonedDateParts;
  formatZonedDateTime(isoOrDate?: string | Date | null, timezone?: string): string;
}

/**
 * Named contextual block assembled into system instructions by host applications.
 */
export interface PromptSection {
  readonly header?: string;
  readonly body: string;
}

/**
 * Customizable headings and privacy notice for rendering read-only external memory overlays.
 */
export interface ReadOnlyOverlayPromptLabels {
  readonly intro?: string;
  readonly profileHeader?: string;
  readonly turnsHeader?: string;
}

/**
 * Read-only external memory context injected into system prompts without reverse write-back.
 */
export interface ReadOnlyOverlayPromptContext {
  readonly coreProfile?: UserCoreProfile;
  readonly recentTurns?: readonly ConversationLogEntry[];
  readonly labels?: ReadOnlyOverlayPromptLabels;
  readonly displayName?: string;
  readonly username?: string;
}

/**
 * Options for resolving situational persona few-shot anchors via embedding similarity.
 */
export interface SituationalAnchorsOptions {
  readonly embedder: IMemoryVectorEmbedder;
  readonly contextElements: readonly string[];
  /** Target persona used as fallback source for pattern vectors and matchers when not overridden. */
  readonly persona?: Pick<IPersonaDefinition, 'patternVectors' | 'findTopPatterns' | 'buildFewShotPrompt'>;
  readonly patternVectors?: PersonaPatternWithVector[];
  readonly findTopPatterns?: (
    queryVector: number[],
    patternVectors: PersonaPatternWithVector[],
    topK: number,
  ) => ReturnType<IPersonaDefinition['findTopPatterns']>;
  readonly buildFewShotPrompt?: IPersonaDefinition['buildFewShotPrompt'];
  readonly lang?: Language;
  readonly topK?: number;
  readonly logger?: MemoryLogger;
}

/**
 * Mandatory situational anchoring request attached to {@link SystemPromptCompositionOptions}.
 */
export interface PromptAnchoringRequest {
  readonly embedder: IMemoryVectorEmbedder;
  readonly contextElements: readonly string[];
  readonly patternVectors?: PersonaPatternWithVector[];
  readonly topK?: number;
  readonly logger?: MemoryLogger;
}

/**
 * Optional localized temporal and birthday awareness configuration for prompt assembly.
 */
export interface PromptTemporalOptions {
  /** IANA timezone used for clock and birthday evaluation. Defaults to `'Asia/Tokyo'`. */
  readonly timezone?: string;
  /** Reference clock timestamp. Defaults to `new Date()`. */
  readonly now?: Date;
  /** Optional custom time resolver for deterministic testing. */
  readonly timeResolver?: PromptTimeResolver;
  /** Whether to inject time-of-day conversational bracket guidance (`Early Morning`–`Late Night`). Defaults to `true`. */
  readonly includeTimeBracket?: boolean;
  /** Whether to inject rollout anniversary / birthday guidance when dates match. Defaults to `true`. */
  readonly includeBirthday?: boolean;
}

/**
 * Optional Layer 1–3, working memory, RAG, and read-only overlay inputs for stateful dialogues.
 */
export interface PromptMemoryContext {
  readonly userData?: MemoryUserSnapshot | null;
  readonly extendedPrompt?: string;
  readonly activitySummary?: string;
  readonly ragMemories?: readonly string[];
  /** Label prefix used before `@username` in interlocutor metadata (defaults to `'Handle'` / `'ユーザーID'`). */
  readonly accountHandleLabel?: string;
  /** Optional custom heading and lead-in text for Layer 2 `activitySummary`. */
  readonly activitySummaryHeader?: string;
  readonly activitySummaryLead?: string;
  /** Optional read-only external memory overlay for one-way continuity. */
  readonly readOnlyMemoryOverlay?: ReadOnlyOverlayPromptContext | null;
}

/**
 * Single canonical input contract for {@link composeSystemPrompt}.
 * Requires `anchoring` at compile time so every channel and feature consistently grounds
 * Layer 0 persona identity with situational patterns.
 */
export interface SystemPromptCompositionOptions {
  readonly persona: IPersonaDefinition;
  /** Host-supplied channel or application behavioral instruction layered onto Layer 0 identity. */
  readonly channelInstruction?: string;
  readonly lang?: Language;
  readonly anchoring: PromptAnchoringRequest;
  readonly temporal?: PromptTemporalOptions;
  readonly memory?: PromptMemoryContext;
  /** Optional host-specific contextual sections appended after standard sections. */
  readonly additionalSections?: ReadonlyArray<PromptSection | string | null | undefined>;
  /** Optional supplementary guidelines appended at the end of the prompt. */
  readonly platformGuidelines?: string;
}

/**
 * Structured output returned by {@link composeSystemPrompt}.
 */
export interface ComposedSystemPrompt {
  /** Core identity + channel guidelines + resolved 120-pattern situational anchors. */
  readonly baseSystemInstruction: string;
  /** Dynamically selected top-K situational few-shot block from the persona's pattern vectors. */
  readonly personaFewShotPrompt: string;
  /** Complete assembled system instruction including temporal, memory, and channel sections. */
  readonly systemInstruction: string;
}
