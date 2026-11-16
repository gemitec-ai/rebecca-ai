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
 * Storage-agnostic projection of a user's persistent memory record.
 * Compatible with both public X `FirestoreUser` and isolated private Lounge user profiles.
 */
export interface MemoryUserSnapshot {
  readonly id?: string;
  readonly name?: string;
  readonly username?: string;
  readonly coreProfile?: UserCoreProfile;
  readonly episodicBuffer?: readonly ConversationLogEntry[];
  /** ISO 8601 date/datetime of the user's most recent conversational exchange. */
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
 * Provider-agnostic conversational turn after Tatemae/Honne reconstruction.
 * Keeps `thought` (inner monologue) paired with `content` (spoken reply) on model turns.
 */
export interface TurnWithInnerThought {
  readonly role: 'user' | 'model';
  readonly text: string;
}

/**
 * Read-only snapshot of public X Bot memories bridged one-way into a private session.
 */
export interface PublicMemorySnapshot {
  readonly user?: MemoryUserSnapshot | null;
  readonly ragMemories?: readonly string[];
  readonly timelineSummary?: string;
}

/**
 * Isolated private-session memory snapshot belonging strictly to the target private channel.
 */
export interface PrivateMemorySnapshot {
  readonly user?: MemoryUserSnapshot | null;
  readonly ragMemories?: readonly string[];
}

/**
 * Inputs for composing an asymmetric one-way memory overlay (Public X -> Private Session).
 */
export interface CompositeMemoryOverlayInput {
  readonly publicMemory?: PublicMemorySnapshot | null;
  readonly privateMemory: PrivateMemorySnapshot;
  /** Maximum recent turn pairs to retain from private episodic buffer. Defaults to 10. */
  readonly workingMemoryLimit?: number;
  /** Maximum recent turn pairs to surface read-only from public X episodic buffer. Defaults to 4. */
  readonly publicWorkingMemoryLimit?: number;
  /** Language used when annotating merged memory headers. Defaults to 'ja'. */
  readonly lang?: Language;
}

/**
 * Immutable, strictly segregated memory overlay view for private session prompt synthesis.
 * Never mutates public snapshots or writes private data back into public memory stores.
 */
export interface ComposedMemoryOverlay {
  readonly privateUser: MemoryUserSnapshot | null;
  readonly publicUser: MemoryUserSnapshot | null;
  readonly effectiveLastReplyDate?: string;
  readonly privateWorkingMemory: readonly ConversationLogEntry[];
  readonly publicRecentTurns: readonly ConversationLogEntry[];
  readonly ragMemories: readonly string[];
  readonly timelineSummary: string;
}

/**
 * Read-only public X context injected into Private Lounge system prompts.
 */
export interface PublicMemoryOverlayContext {
  readonly coreProfile?: UserCoreProfile;
  readonly recentTurns?: readonly ConversationLogEntry[];
  readonly displayName?: string;
  readonly username?: string;
}

/**
 * Options for composing a full 3-tier system prompt for either public or private channels.
 */
export interface SystemPromptCompositionOptions {
  readonly persona: IPersonaDefinition;
  readonly promptContext: PromptContext;
  readonly userData: MemoryUserSnapshot | null;
  readonly extendedPrompt?: string;
  readonly timelineSummary?: string;
  readonly ragMemories?: readonly string[];
  readonly lang?: Language;
  readonly personaFewShotPrompt?: string;
  readonly campaignContext?: string;
  readonly parentPostContext?: string;
  /** Read-only X public memory overlay for one-way continuity in private sessions. */
  readonly publicMemoryOverlay?: PublicMemoryOverlayContext | null;
  /** Optional channel-specific platform guidelines appended at the end of the prompt. */
  readonly platformGuidelines?: string;
  /** IANA timezone used for clock and birthday evaluation. Defaults to 'Asia/Tokyo'. */
  readonly timezone?: string;
  /** Reference clock timestamp. Defaults to `new Date()`. */
  readonly now?: Date;
  /** Optional custom time resolver (useful for deterministic unit tests). */
  readonly timeResolver?: MemoryTimeResolver;
}

/**
 * Persistence port for reading unconsolidated user memories and saving dreaming results.
 */
export interface IDreamingMemoryStore<TUser extends MemoryUserSnapshot = MemoryUserSnapshot> {
  getAllUsers(): Promise<TUser[]>;
  updateCoreProfile(
    userId: string,
    profile: UserCoreProfile,
    retainedBuffer: ConversationLogEntry[],
    lastDreamedAt: string,
  ): Promise<void>;
}

/**
 * LLM synthesis port for integrating episodic buffers into a user's CoreProfile.
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
 * Execution tuning options for batch memory consolidation (Dreaming).
 */
export interface DreamingConfig {
  /** Inter-user throttle delay in milliseconds (default 4500ms for 15 RPM quota safety). */
  readonly throttleMs?: number;
  /** Number of recent episodic entries retained as sliding window (default 20 = 10 pairs). */
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
 * Outcome returned by the LLM-as-a-Judge safety & persona alignment audit for Layer 1 evolution.
 */
export interface EvolutionAuditResult {
  readonly pass: boolean;
  readonly reason?: string;
}

/**
 * Persistence port for reading recent multi-user interactions and storing the Layer 1 extended prompt.
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
 * Activity item (e.g., timeline post or lounge broadcast) summarized into Layer 2 memory.
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
 * LLM synthesis port for distilling Layer 2 global activity summaries.
 */
export interface ISelfReflectionSynthesizer {
  generateSummary(prompt: string): Promise<string>;
}

/**
 * Execution tuning options for Layer 2 Self-Reflection summarization.
 */
export interface SelfReflectionConfig {
  /** Maximum number of recent activities to fetch for summarization (default 20). */
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
