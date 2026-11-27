import type { LoungeTokenUsage } from '@rebecca/types';
import type {
  IBotImageAssetSearchPort,
  ILoungeImageMatcherPort,
  MatchedBotImageAsset,
} from '../ports/loungeAi.port';

/**
 * Context required by `LoungeIllustrationMatcherService` to evaluate and select a turn illustration.
 */
export interface LoungeIllustrationMatchRequest {
  readonly userPrompt: string;
  readonly thought: string;
  readonly replyText: string;
  readonly recentMessages: ReadonlyArray<{ readonly imageAssetId?: string }>;
  readonly onTokenUsage?: (usage: LoungeTokenUsage) => void;
}

/**
 * Domain service orchestrating the 3-stage autonomous illustration matching pipeline
 * (`planImageSearch` -> vector `findCandidateImages` -> LLM `verifyImageRelevance`).
 */
export interface ILoungeIllustrationMatcherService {
  /**
   * Resolves a verified matching illustration for the completed turn, or `null` when skipped
   * or no candidate passes relevance verification.
   */
  matchIllustration(request: LoungeIllustrationMatchRequest): Promise<MatchedBotImageAsset | null>;
}

/**
 * Encapsulates the 3-stage illustration selection pipeline while deduplicating against
 * illustrations already surfaced in the active recent history window.
 */
export class LoungeIllustrationMatcherService implements ILoungeIllustrationMatcherService {
  constructor(
    private readonly botImageSearchPort: IBotImageAssetSearchPort,
    private readonly imageMatcher: ILoungeImageMatcherPort,
  ) {}

  /**
   * Executes Stage 1 (LLM query inference), Stage 2 (vector asset lookup excluding recent turns),
   * and Stage 3 (LLM caption relevance verification). Propagates errors so callers can compensate
   * un-committed turn reservations atomically.
   */
  public async matchIllustration(
    request: LoungeIllustrationMatchRequest,
  ): Promise<MatchedBotImageAsset | null> {
    const imageSearchQuery = await this.imageMatcher.planImageSearch({
      userPrompt: request.userPrompt,
      thought: request.thought,
      replyText: request.replyText,
      onTokenUsage: request.onTokenUsage,
    });
    if (!imageSearchQuery) {
      return null;
    }

    const recentAssetIds = new Set(
      request.recentMessages
        .map((m) => m.imageAssetId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    );
    const candidates = await this.botImageSearchPort.findCandidateImages(
      imageSearchQuery,
      recentAssetIds,
      3,
    );
    for (const candidate of candidates) {
      const isRelevant = await this.imageMatcher.verifyImageRelevance({
        candidateCaption: candidate.caption,
        replyText: request.replyText,
        thought: request.thought,
        onTokenUsage: request.onTokenUsage,
      });
      if (isRelevant) {
        return candidate;
      }
    }
    return null;
  }
}
