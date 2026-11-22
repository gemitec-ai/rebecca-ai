import type {
  LoungeAccountSummaryDto,
  LoungeDeleteAccountRequestDto,
  LoungeUpdatePreferencesRequestDto,
  LoungeUser,
} from '@rebecca/types';

/**
 * Hexagonal port abstracting Private Lounge account summary, daily turn quota lookup,
 * locale/timezone preference updates, and irreversible account withdrawal.
 */
export abstract class LoungeAccountPort {
  /** Fetches profile, subscription tier, remaining chat turns, and gallery progress. */
  public abstract getAccountSummary(): Promise<LoungeAccountSummaryDto>;

  /** Updates user UI/AI language and IANA timezone preferences. */
  public abstract updatePreferences(request: LoungeUpdatePreferencesRequestDto): Promise<LoungeUser>;

  /** Permanently deletes the account and all associated session/memory/gallery records with no refunds. */
  public abstract deleteAccount(request: LoungeDeleteAccountRequestDto): Promise<void>;
}
