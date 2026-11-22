import type { LoungeAccountSummaryDto } from '@rebecca/types';

/**
 * Hexagonal port abstracting Private Lounge account, subscription tier, and daily turn quota lookup.
 */
export abstract class LoungeAccountPort {
  /** Fetches profile, subscription tier, remaining chat turns, and sync status. */
  public abstract getAccountSummary(): Promise<LoungeAccountSummaryDto>;
}
