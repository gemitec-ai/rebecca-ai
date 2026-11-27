import crypto from 'node:crypto';
import type { IDreamingSynthesizer } from '@rebecca/memory';
import type {
  ConversationLogEntry,
  LoungeEmotionState,
  UserCoreProfile,
} from '@rebecca/types';
import type {
  ILoungeChatPipelinePort,
  ILoungeEmbeddingPort,
  ILoungeEmotionClassifierPort,
  ILoungeImageMatcherPort,
  LoungeChatPipelineInput,
  LoungeChatPipelineOutput,
} from '../ports/loungeAi.port';
import { parseAndNormalizeCoreProfile } from './geminiLoungeAi.adapter';

const EMBEDDING_DIMENSIONS = 768;

/** Deterministic 768-dimension unit embedding derived from text hashes (used in local emulator/unit tests). */
export function buildDeterministicTestEmbedding(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const digest = crypto.createHash('sha256').update(text, 'utf8').digest();
  let normSq = 0;
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i += 1) {
    const byteVal = digest[i % digest.length] / 255;
    const val = (byteVal * 2 - 1) * ((i % 7) + 1);
    vector[i] = val;
    normSq += val * val;
  }
  const norm = Math.sqrt(normSq) || 1;
  return vector.map((v) => Number((v / norm).toFixed(6)));
}

/**
 * Character-agnostic deterministic local emulator AI adapter used STRICTLY when
 * `isLocalEmulatorMode === true` and `GEMINI_API_KEY` is omitted.
 */
export class LocalEmulatorLoungeAiAdapter
  implements
    ILoungeEmbeddingPort,
    ILoungeEmotionClassifierPort,
    ILoungeChatPipelinePort,
    ILoungeImageMatcherPort,
    IDreamingSynthesizer
{
  public async embedQuery(text: string): Promise<number[]> {
    return text.trim() ? buildDeterministicTestEmbedding(text) : [];
  }

  public async classifyEmotion(): Promise<LoungeEmotionState> {
    return 'NEUTRAL';
  }

  public async planImageSearch(): Promise<string | null> {
    return null;
  }

  public async verifyImageRelevance(): Promise<boolean> {
    return true;
  }

  public async generateReply(input: LoungeChatPipelineInput): Promise<LoungeChatPipelineOutput> {
    const trimmedPrompt = input.userPrompt.trim().slice(0, 60);
    const replyText = `[Emulator ${input.responseLanguage}] Response for: "${trimmedPrompt}"`;
    const promptTokens = Math.max(12, Math.ceil(input.userPrompt.length / 2));
    const candidatesTokens = Math.max(12, Math.ceil(replyText.length / 2));
    return {
      thought: `[Emulator] Processed ${trimmedPrompt.length} chars.`,
      replyText,
      tokenUsage: {
        promptTokens,
        candidatesTokens,
        totalTokens: promptTokens + candidatesTokens,
      },
      usedWebSearch: false,
    };
  }

  public async generateDreaming(
    _systemPrompt: string,
    episodicBuffer: ConversationLogEntry[],
    coreProfile: UserCoreProfile,
  ): Promise<UserCoreProfile> {
    const readStringArray = (rawVal: unknown): string[] =>
      Array.isArray(rawVal)
        ? rawVal
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
        : [];
    const extractedTopics = episodicBuffer
      .slice(-3)
      .map((entry) => entry.content.trim().slice(0, 40))
      .filter((topic) => topic.length > 0);
    return parseAndNormalizeCoreProfile({
      attributes: readStringArray(coreProfile['attributes']),
      preferences: Array.from(
        new Set([...readStringArray(coreProfile['preferences']), ...extractedTopics]),
      ),
      concerns: readStringArray(coreProfile['concerns']),
      important_memories: readStringArray(coreProfile['important_memories']),
    });
  }
}
