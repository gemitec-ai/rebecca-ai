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
 * Mandatory situational anchoring request attached to grounded prompt builders.
 */
export interface PromptAnchoringRequest {
  readonly embedder: IMemoryVectorEmbedder;
  readonly contextElements: readonly string[];
  readonly patternVectors?: PersonaPatternWithVector[];
  readonly topK?: number;
  readonly logger?: MemoryLogger;
}

/**
 * Options for composing a channel prompt that guarantees 120-pattern situational anchoring.
 */
export interface AnchoredChannelPromptOptions {
  readonly persona: IPersonaDefinition;
  readonly channelInstruction?: string;
  readonly lang?: Language;
  readonly anchoring: PromptAnchoringRequest;
  readonly additionalSections?: ReadonlyArray<PromptSection | string | null | undefined>;
}

/**
 * Result returned by {@link composeAnchoredChannelPrompt}.
 */
export interface AnchoredChannelPromptResult {
  readonly basePrompt: string;
  readonly personaFewShotPrompt: string;
  readonly systemInstruction: string;
}

/**
 * Options for composing a complete multi-tier persona system prompt with memory injections.
 */
export interface PromptCompositionOptions {
  readonly persona: IPersonaDefinition;
  /** Host-supplied channel or application behavioral instruction layered onto Layer 0 identity. */
  readonly channelInstruction?: string;
  readonly userData: MemoryUserSnapshot | null;
  readonly extendedPrompt?: string;
  readonly activitySummary?: string;
  readonly ragMemories?: readonly string[];
  readonly lang?: Language;
  readonly personaFewShotPrompt?: string;
  /** Label prefix used before `@username` in interlocutor metadata (defaults to `'Handle'` / `'ユーザーID'`). */
  readonly accountHandleLabel?: string;
  /** Optional custom heading and lead-in text for Layer 2 `activitySummary`. */
  readonly activitySummaryHeader?: string;
  readonly activitySummaryLead?: string;
  /** Optional host-specific contextual sections appended cleanly. */
  readonly additionalSections?: readonly PromptSection[];
  /** Optional read-only external memory overlay for one-way continuity. */
  readonly readOnlyMemoryOverlay?: ReadOnlyOverlayPromptContext | null;
  /** Optional supplementary guidelines appended after contextual sections. */
  readonly platformGuidelines?: string;
  /** IANA timezone used for clock and birthday evaluation. Defaults to `'Asia/Tokyo'`. */
  readonly timezone?: string;
  /** Reference clock timestamp. Defaults to `new Date()`. */
  readonly now?: Date;
  /** Optional custom time resolver for deterministic testing. */
  readonly timeResolver?: PromptTimeResolver;
}

/**
 * Options for {@link composeGroundedSystemPrompt}, enforcing compile-time anchoring inputs
 * so host applications cannot omit the persona's situational pattern dataset.
 */
export interface GroundedSystemPromptOptions
  extends Omit<PromptCompositionOptions, 'personaFewShotPrompt'> {
  readonly anchoring: PromptAnchoringRequest;
}
