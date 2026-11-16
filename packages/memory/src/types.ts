import type {
  ConversationLogEntry,
  UserCoreProfile,
} from '@rebecca/types';
import type {
  IPersonaDefinition,
  Language,
  PersonaPatternWithVector,
  PromptContext,
} from '@rebecca/persona';

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
export interface MemoryTimeResolver {
  getZonedDateParts(date?: Date, timezone?: string): ZonedDateParts;
  formatZonedDateTime(isoOrDate?: string | Date | null, timezone?: string): string;
}

/**
 * Storage-agnostic projection of a user's persistent memory state.
 */
export interface MemoryUserSnapshot {
  readonly id?: string;
  readonly name?: string;
  readonly username?: string;
  readonly coreProfile?: UserCoreProfile;
  readonly episodicBuffer?: readonly ConversationLogEntry[];
  /** ISO 8601 date or datetime of the user's most recent conversational exchange. */
  readonly lastReplyDate?: string;
  /** ISO 8601 datetime of the user's latest recorded activity. */
  readonly lastSeen?: string;
  /** ISO 8601 datetime of the last completed dreaming consolidation. */
  readonly lastDreamedAt?: string;
}

/**
 * Port for appending completed turn entries to an episodic buffer.
 */
export interface IMemoryEpisodicStore {
  appendEpisodicBuffer(userId: string, log: ConversationLogEntry): Promise<void>;
}

/**
 * Provider-agnostic conversational turn after inner-thought reconstruction.
 * Keeps private `thought` paired with spoken `content` on model turns.
 */
export interface TurnWithInnerThought {
  readonly role: 'user' | 'model';
  readonly text: string;
}

/**
 * Named contextual block appended to composed system instructions by host applications.
 */
export interface PromptSection {
  readonly header?: string;
  readonly body: string;
}

/**
 * Read-only snapshot of an upstream memory channel bridged one-way into a target session.
 */
export interface ReadOnlySourceMemorySnapshot {
  readonly user?: MemoryUserSnapshot | null;
  readonly ragMemories?: readonly string[];
  readonly activitySummary?: string;
}

/**
 * Isolated memory snapshot belonging exclusively to the active target session/channel.
 */
export interface TargetSessionMemorySnapshot {
  readonly user?: MemoryUserSnapshot | null;
  readonly ragMemories?: readonly string[];
}

/**
 * Custom provenance tags applied when merging source and target RAG episodes.
 */
export interface MemoryOverlayLabels {
  readonly sourceTag?: string;
  readonly targetTag?: string;
}

/**
 * Inputs for composing a one-way asymmetric memory overlay (Source Channel -> Target Channel).
 */
export interface AsymmetricOverlayInput {
  readonly sourceMemory?: ReadOnlySourceMemorySnapshot | null;
  readonly targetMemory: TargetSessionMemorySnapshot;
  /** Maximum recent turn pairs to retain from target episodic buffer. Defaults to `10`. */
  readonly workingMemoryLimit?: number;
  /** Maximum recent turn pairs surfaced read-only from source episodic buffer. Defaults to `4`. */
  readonly sourceWorkingMemoryLimit?: number;
  /** Language used for default provenance headers when `labels` is omitted. Defaults to `'ja'`. */
  readonly lang?: Language;
  /** Optional channel-specific provenance tags overriding neutral defaults. */
  readonly labels?: MemoryOverlayLabels;
}

/**
 * Immutable, segregated memory overlay view for downstream prompt synthesis.
 * Source snapshots are defensively cloned and never mutated or written back.
 */
export interface AsymmetricOverlayView {
  readonly targetUser: MemoryUserSnapshot | null;
  readonly sourceUser: MemoryUserSnapshot | null;
  readonly effectiveLastReplyDate?: string;
  readonly targetWorkingMemory: readonly ConversationLogEntry[];
  readonly sourceRecentTurns: readonly ConversationLogEntry[];
  readonly ragMemories: readonly string[];
  readonly activitySummary: string;
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
 * Options for composing a complete multi-tier system prompt for any host channel.
 */
export interface SystemPromptCompositionOptions {
  readonly persona: IPersonaDefinition;
  readonly promptContext: PromptContext;
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
  /** Optional host-specific contextual sections (e.g., social root post, event campaigns). */
  readonly additionalSections?: readonly PromptSection[];
  /** Optional read-only external memory overlay for one-way continuity. */
  readonly readOnlyMemoryOverlay?: ReadOnlyOverlayPromptContext | null;
  /** Optional channel-specific behavioral guidelines appended after context sections. */
  readonly platformGuidelines?: string;
  /** IANA timezone used for clock and birthday evaluation. Defaults to `'Asia/Tokyo'`. */
  readonly timezone?: string;
  /** Reference clock timestamp. Defaults to `new Date()`. */
  readonly now?: Date;
  /** Optional custom time resolver for deterministic testing. */
  readonly timeResolver?: MemoryTimeResolver;
}

/**
 * Persistence port for retrieving consolidation candidates and saving dreaming outputs.
 */
export interface IDreamingMemoryStore<TUser extends MemoryUserSnapshot = MemoryUserSnapshot> {
  listConsolidationCandidates(): Promise<TUser[]>;
  updateCoreProfile(
    userId: string,
    profile: UserCoreProfile,
    retainedBuffer: ConversationLogEntry[],
    lastDreamedAt: string,
  ): Promise<void>;
}

/**
 * LLM synthesis port for integrating episodic buffers into a user's `UserCoreProfile`.
 */
export interface IDreamingSynthesizer {
  generateDreaming(
    systemPrompt: string,
    episodicBuffer: ConversationLogEntry[],
    coreProfile: UserCoreProfile,
  ): Promise<UserCoreProfile>;
}

/**
 * Minimal structured logging port used by memory orchestration engines.
 */
export interface MemoryLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error(message: string, error?: unknown, meta?: Record<string, unknown>): void;
}

/**
 * Execution tuning options for batch memory consolidation (Layer 3 Dreaming).
 */
export interface DreamingConfig {
  /** Inter-user throttle delay in milliseconds (default `4500` ms). */
  readonly throttleMs?: number;
  /** Number of recent episodic entries retained as sliding window (default `20` = 10 pairs). */
  readonly retainedBufferEntries?: number;
}

/**
 * Summary telemetry returned after a Dreaming batch consolidation run.
 */
export interface DreamingExecutionResult {
  readonly status: 'success' | 'partial_success' | 'failed' | 'skipped';
  readonly reason?: string;
  readonly totalUsers: number;
  readonly processedUsers: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
}

/**
 * Provider port for computing dense text embedding vectors.
 */
export interface IMemoryVectorEmbedder {
  generateEmbedding(text: string): Promise<number[]>;
}

/**
 * Storage port for persisting and retrieving vectorized long-term RAG memory entries.
 */
export interface IMemoryRagStore {
  saveRagMemory(userId: string, text: string, embedding: number[]): Promise<void>;
  findRagMemories(userId: string, queryVector: number[], limit?: number): Promise<string[]>;
}

/**
 * Options for resolving situational persona few-shot anchors.
 */
export interface SituationalAnchorsOptions {
  readonly embedder: IMemoryVectorEmbedder;
  readonly contextElements: readonly string[];
  readonly patternVectors: PersonaPatternWithVector[];
  readonly findTopPatterns: (
    queryVector: number[],
    patternVectors: PersonaPatternWithVector[],
    topK: number,
  ) => ReturnType<IPersonaDefinition['findTopPatterns']>;
  readonly buildFewShotPrompt: IPersonaDefinition['buildFewShotPrompt'];
  readonly lang?: Language;
  readonly topK?: number;
  readonly logger?: MemoryLogger;
}

/**
 * Single conversation log pair inspected during Layer 1 Global Evolution analysis.
 */
export interface EvolutionConversationLog {
  readonly userText: string;
  readonly aiText: string;
  readonly thought?: string;
}

/**
 * Outcome returned by the safety and persona-alignment audit for Layer 1 evolution.
 */
export interface EvolutionAuditResult {
  readonly pass: boolean;
  readonly reason?: string;
}

/**
 * Persistence port for reading recent cross-user interactions and storing the Layer 1 extended prompt.
 */
export interface IEvolutionMemoryStore {
  getRecentConversationLogs(lookbackDays: number): Promise<ReadonlyArray<EvolutionConversationLog>>;
  saveExtendedPrompt(prompt: string): Promise<void>;
}

/**
 * LLM synthesis & audit port for Layer 1 extended persona prompt evolution.
 */
export interface IEvolutionSynthesizer {
  generateEvolutionPrompt(prompt: string): Promise<string | null | undefined>;
  auditEvolutionPrompt(candidatePrompt: string, auditInstruction: string): Promise<EvolutionAuditResult>;
}

/**
 * Execution tuning options for Layer 1 Global Evolution synthesis.
 */
export interface GlobalEvolutionConfig {
  readonly lookbackDays: number;
  /** Optional character length guideline embedded in the synthesis prompt. */
  readonly lengthGuideline?: string;
}

/**
 * Outcome summary returned by Layer 1 Global Evolution execution.
 */
export interface GlobalEvolutionResult {
  readonly status: 'skipped' | 'failed' | 'success' | 'rejected';
  readonly reason?: string;
  readonly prompt?: string;
  readonly candidate?: string;
}

/**
 * Activity item summarized into Layer 2 long-term summary memory.
 */
export interface SelfReflectionActivityEntry {
  readonly text: string;
  readonly thought?: string;
}

/**
 * Persistence port for reading recent persona activities and updating the Layer 2 summary.
 */
export interface ISelfReflectionStore {
  getRecentActivities(limit: number): Promise<ReadonlyArray<SelfReflectionActivityEntry>>;
  getSummary(): Promise<string>;
  saveSummary(summary: string): Promise<void>;
}

/**
 * Synthesis payload passed to {@link ISelfReflectionSynthesizer.generateSummary}.
 */
export interface SelfReflectionSynthesisInput {
  readonly systemInstruction: string;
  readonly prompt: string;
}

/**
 * LLM synthesis port for distilling Layer 2 global activity summaries.
 */
export interface ISelfReflectionSynthesizer {
  generateSummary(input: SelfReflectionSynthesisInput): Promise<string>;
}

/**
 * Execution tuning options for Layer 2 Self-Reflection summarization.
 */
export interface SelfReflectionConfig {
  /** Maximum number of recent activities to fetch for summarization (default `20`). */
  readonly postLimit?: number;
}

/**
 * Outcome summary returned by Layer 2 Self-Reflection execution.
 */
export interface SelfReflectionExecutionResult {
  readonly status: 'success' | 'skipped';
  readonly summary?: string;
  readonly previousSummary?: string;
  readonly postsCount: number;
  readonly reason?: string;
}
