import type { ConversationLogEntry } from '@rebecca/types';
import { DEFAULT_WORKING_MEMORY_LIMIT, getWorkingMemory } from './workingMemory';
import type {
  AsymmetricOverlayInput,
  AsymmetricOverlayView,
  MemoryUserSnapshot,
} from './types';

/** Default sliding window of recent turns surfaced read-only from the source channel. */
export const DEFAULT_SOURCE_OVERLAY_TURN_LIMIT = 4;

/**
 * Resolves the most recent valid ISO timestamp between two optional date strings.
 */
const resolveLatestIsoTimestamp = (
  primary?: string,
  secondary?: string,
): string | undefined => {
  const primaryMs = primary ? Date.parse(primary) : Number.NaN;
  const secondaryMs = secondary ? Date.parse(secondary) : Number.NaN;

  const hasPrimary = Number.isFinite(primaryMs);
  const hasSecondary = Number.isFinite(secondaryMs);

  if (hasPrimary && hasSecondary) {
    return primaryMs >= secondaryMs ? primary : secondary;
  }
  if (hasPrimary) return primary;
  if (hasSecondary) return secondary;
  return undefined;
};

/**
 * Creates a shallow defensive copy of a user snapshot so downstream prompt composition
 * cannot mutate underlying storage objects.
 */
const cloneUserSnapshot = (
  user: MemoryUserSnapshot | null | undefined,
): MemoryUserSnapshot | null => {
  if (!user) return null;
  return {
    ...user,
    coreProfile: user.coreProfile ? { ...user.coreProfile } : undefined,
    episodicBuffer: user.episodicBuffer ? [...user.episodicBuffer] : undefined,
  };
};

/**
 * Strips blank entries and optionally prefixes memory snippets with provenance tags.
 */
const formatTaggedMemories = (
  memories: readonly string[] | undefined,
  tag: string,
  shouldTag: boolean,
): string[] => {
  if (!memories || memories.length === 0) {
    return [];
  }
  return memories
    .map((m) => m.trim())
    .filter((m) => m.length > 0)
    .map((m) => (shouldTag && tag ? `${tag} ${m}` : m));
};

/**
 * Composes an asymmetric one-way memory overlay between an isolated target session and an
 * optional read-only external source channel.
 *
 * Source snapshots are defensively cloned so target prompt synthesis can inherit prior
 * continuity without mutating or leaking target state back to the source store.
 *
 * @param input - Isolated target session memory combined with optional read-only source snapshot.
 * @returns Immutable overlay view ready for `composeSystemPrompt`.
 */
export const composeAsymmetricMemoryOverlay = (
  input: AsymmetricOverlayInput,
): AsymmetricOverlayView => {
  const workingLimit = input.workingMemoryLimit ?? DEFAULT_WORKING_MEMORY_LIMIT;
  const sourceLimit = input.sourceWorkingMemoryLimit ?? DEFAULT_SOURCE_OVERLAY_TURN_LIMIT;
  const lang = input.lang ?? 'ja';

  const targetUser = cloneUserSnapshot(input.targetMemory.user);
  const sourceUser = cloneUserSnapshot(input.sourceMemory?.user);

  const targetWorkingMemory: readonly ConversationLogEntry[] = getWorkingMemory(
    targetUser?.episodicBuffer,
    workingLimit,
  );
  const sourceRecentTurns: readonly ConversationLogEntry[] = getWorkingMemory(
    sourceUser?.episodicBuffer,
    sourceLimit,
  );

  const defaultSourceTag = lang === 'en' ? '[External Memory]' : '【外部チャネルの記憶】';
  const defaultTargetTag = lang === 'en' ? '[Session Memory]' : '【現在セッションの記憶】';
  const sourceTag = input.labels?.sourceTag ?? defaultSourceTag;
  const targetTag = input.labels?.targetTag ?? defaultTargetTag;

  const rawSourceRag = input.sourceMemory?.ragMemories;
  const rawTargetRag = input.targetMemory.ragMemories;
  const hasSourceRag = Boolean(rawSourceRag && rawSourceRag.some((m) => m.trim().length > 0));

  const mergedRagMemories = [
    ...formatTaggedMemories(rawTargetRag, targetTag, hasSourceRag),
    ...formatTaggedMemories(rawSourceRag, sourceTag, true),
  ];

  const effectiveLastReplyDate = resolveLatestIsoTimestamp(
    targetUser?.lastReplyDate,
    sourceUser?.lastReplyDate,
  );

  const activitySummary = input.sourceMemory?.activitySummary?.trim() ?? '';

  return {
    targetUser,
    sourceUser,
    ...(effectiveLastReplyDate ? { effectiveLastReplyDate } : {}),
    targetWorkingMemory,
    sourceRecentTurns,
    ragMemories: mergedRagMemories,
    activitySummary,
  };
};
