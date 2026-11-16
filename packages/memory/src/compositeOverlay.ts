import type { ConversationLogEntry } from '@rebecca/types';
import { DEFAULT_WORKING_MEMORY_LIMIT, getWorkingMemory } from './workingMemory';
import type {
  ComposedMemoryOverlay,
  CompositeMemoryOverlayInput,
  MemoryUserSnapshot,
} from './types';

/** Default sliding window of recent public X turns surfaced read-only in private sessions. */
export const DEFAULT_PUBLIC_OVERLAY_TURN_LIMIT = 4;

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
 * cannot mutate underlying public or private store objects.
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
 * Strips empty entries and optionally annotates memory snippets with channel provenance tags.
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
    .map((m) => (shouldTag ? `${tag} ${m}` : m));
};

/**
 * Composes an asymmetric one-way memory overlay for Private Lounge sessions.
 *
 * Architectural Invariant:
 * - **Public X -> Private Lounge (Read-Only)**: Bridges X account identity, public `coreProfile`,
 *   recent public turns, public `rag_memories`, and `timeline_history` summary into private context.
 * - **Zero Reverse Flow**: Public objects are defensively cloned and never modified or written back.
 *
 * @param input - Isolated private session memory combined with optional read-only public X snapshot.
 * @returns Immutable overlay view ready for `composeSystemPrompt`.
 */
export const composeAsymmetricMemoryOverlay = (
  input: CompositeMemoryOverlayInput,
): ComposedMemoryOverlay => {
  const workingLimit = input.workingMemoryLimit ?? DEFAULT_WORKING_MEMORY_LIMIT;
  const publicLimit = input.publicWorkingMemoryLimit ?? DEFAULT_PUBLIC_OVERLAY_TURN_LIMIT;
  const lang = input.lang ?? 'ja';

  const privateUser = cloneUserSnapshot(input.privateMemory.user);
  const publicUser = cloneUserSnapshot(input.publicMemory?.user);

  const privateWorkingMemory: readonly ConversationLogEntry[] = getWorkingMemory(
    privateUser?.episodicBuffer,
    workingLimit,
  );
  const publicRecentTurns: readonly ConversationLogEntry[] = getWorkingMemory(
    publicUser?.episodicBuffer,
    publicLimit,
  );

  const publicTag = lang === 'en' ? '[Public X Memory]' : '【X公開対話の記憶】';
  const privateTag = lang === 'en' ? '[Private Lounge Memory]' : '【ラウンジ秘密対話の記憶】';

  const rawPublicRag = input.publicMemory?.ragMemories;
  const rawPrivateRag = input.privateMemory.ragMemories;
  const hasPublicRag = Boolean(rawPublicRag && rawPublicRag.some((m) => m.trim().length > 0));

  const mergedRagMemories = [
    ...formatTaggedMemories(rawPrivateRag, privateTag, hasPublicRag),
    ...formatTaggedMemories(rawPublicRag, publicTag, true),
  ];

  const effectiveLastReplyDate = resolveLatestIsoTimestamp(
    privateUser?.lastReplyDate,
    publicUser?.lastReplyDate,
  );

  const timelineSummary = input.publicMemory?.timelineSummary?.trim() ?? '';

  return {
    privateUser,
    publicUser,
    ...(effectiveLastReplyDate ? { effectiveLastReplyDate } : {}),
    privateWorkingMemory,
    publicRecentTurns,
    ragMemories: mergedRagMemories,
    timelineSummary,
  };
};
