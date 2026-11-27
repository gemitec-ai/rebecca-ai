import type {
  LoungeAccountSummaryDto,
  LoungeDeleteAccountRequestDto,
  LoungeUpdateDisclaimerConsentRequestDto,
  LoungeUpdatePreferencesRequestDto,
  LoungeUser,
} from '@rebecca/types';

/**
 * Hexagonal port abstracting Private Lounge account summary, daily turn quota lookup,
 * locale/timezone preference updates, disclaimer re-consent, and irreversible account withdrawal.
 */
export abstract class LoungeAccountPort {
  /** Fetches profile, subscription tier, remaining chat turns, and gallery progress. */
  public abstract getAccountSummary(): Promise<LoungeAccountSummaryDto>;

  /** Updates user UI/AI language, IANA timezone preferences, or onboarding completion state. */
  public abstract updatePreferences(request: LoungeUpdatePreferencesRequestDto): Promise<LoungeUser>;

  /** Submits scroll-verified user acceptance of an updated disclaimer version. */
  public abstract updateDisclaimerConsent(
    request: LoungeUpdateDisclaimerConsentRequestDto,
  ): Promise<LoungeUser>;

  /** Permanently deletes the account and all associated session/memory/gallery records with no refunds. */
  public abstract deleteAccount(request: LoungeDeleteAccountRequestDto): Promise<void>;
}
