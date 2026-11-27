import type { Firestore, Transaction } from '@google-cloud/firestore';
import { COLLECTIONS, assertLoungeRecordOwnedByUid, type DbCollections } from '@rebecca/db';
import type {
  LoungeAccountStatus,
  LoungeCreditLotDoc,
  LoungeCurrency,
  LoungeLanguage,
  LoungeSubscriptionDoc,
  LoungeTrialGrantDoc,
  LoungeUserDisclaimerConsent,
  LoungeUserDoc,
} from '@rebecca/types';
import {
  DEFAULT_LOUNGE_TIMEZONE,
  LOUNGE_CREDIT_LOT_VALIDITY_DAYS,
  LOUNGE_DAILY_QUOTA_BY_TIER,
  LOUNGE_WELCOME_BONUS_CREDITS,
  computeTrialGrantRetainUntilIso,
} from '../../billing/domain/loungeCatalog.constants';
import { LoungeAuthError, LoungeConflictError, LoungeNotFoundError } from '../../../utils/errors';
import { parseValidIanaTimezone } from '../../../utils/locale';
import {
  computeActiveTrialGrantHash,
  computeAllTrialGrantHashes,
  type TrialHmacKeyring,
} from '../../../utils/trialGrantHmac';
import {
  createQuotaLedgerEntry,
  nextLocalMidnightAfter,
} from '../../billing/domain/loungeQuota.engine';
import type { IFirebaseIdentityClient } from '../ports/firebaseIdentity.port';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Parameters passed when persisting a newly onboarded X-linked Lounge user.
 */
export interface CreateLoungeUserWithConsentInput {
  readonly uid: string;
  readonly xUserId: string;
  readonly xHandle: string;
  readonly displayName: string;
  readonly avatarUrl: string;
  readonly disclaimerConsent: LoungeUserDisclaimerConsent;
  readonly onboardingCompleted: boolean;
  readonly allowServiceImprovementAnalytics: boolean;
  readonly language?: LoungeLanguage;
  readonly timezone?: string;
  readonly countryCode?: string;
  readonly isEeaResident?: boolean;
  readonly preferredCurrency?: LoungeCurrency;
}

/**
 * Persistence boundary for isolated `lounge_users` authentication, preferences, and consent state.
 */
export interface ILoungeAuthRepository {
  /** Finds a Private Lounge user record by Firebase Auth `uid`, or returns `null` if absent. */
  findUserByUid(uid: string): Promise<LoungeUserDoc | null>;
  /**
   * Finds a Private Lounge user record by linked X user ID, or returns `null` if absent.
   *
   * @throws Error When `xUserId` is empty or whitespace.
   */
  findUserByXUserId(xUserId: string): Promise<LoungeUserDoc | null>;
  /**
   * Atomically creates a user profile, initial `FREE` subscription, and non-PII welcome grant record.
   *
   * @throws LoungeConflictError When UID or X user ID is already registered (`409`).
   * @throws LoungeAuthError When X identity hash carries an active `DISPUTE_BLOCKED` flag (`403`).
   */
  createUserWithConsent(input: CreateLoungeUserWithConsentInput): Promise<LoungeUserDoc>;
  /**
   * Transactionally records login timestamp on an active user record.
   *
   * @throws LoungeNotFoundError When user document does not exist (`404`).
   * @throws LoungeAuthError When user status is not `ACTIVE` (`403`).
   */
  recordLoginTimestamp(uid: string, timestampIso: string): Promise<void>;
  /**
   * Updates user locale, onboarding status, or service-analytics consent transactionally.
   *
   * @throws LoungeNotFoundError When user document does not exist (`404`).
   */
  updateUserPreferences(
    uid: string,
    language?: LoungeLanguage,
    timezone?: string,
    onboardingCompleted?: boolean,
    allowServiceImprovementAnalytics?: boolean,
  ): Promise<LoungeUserDoc>;
  /**
   * Records accepted legal disclaimer version transactionally.
   *
   * @throws LoungeNotFoundError When user document does not exist (`404`).
   */
  updateUserDisclaimerConsent(
    uid: string,
    disclaimerConsent: LoungeUserDisclaimerConsent,
  ): Promise<LoungeUserDoc>;
  /** Transitions lifecycle status (`ACTIVE`, `SUSPENDED`, or `DELETING`) transactionally. */
  updateUserStatus(uid: string, status: LoungeAccountStatus): Promise<void>;
  /**
   * Revokes refresh tokens in Firebase Auth (tolerating missing accounts).
   *
   * @throws Error When Firebase Auth session revocation fails unexpectedly.
   */
  revokeSession(uid: string): Promise<void>;
  /**
   * Deletes Firebase Auth credentials and `lounge_users/{uid}` profile record.
   *
   * @throws Error When Firebase Auth deletion fails unexpectedly.
   */
  deleteUser(uid: string): Promise<void>;
}

/**
 * Firestore repository operating against `lounge_users`, `lounge_subscriptions`,
 * `lounge_credit_lots`, `lounge_quota_ledger`, and non-PII `lounge_trial_grants`.
 */
export class LoungeAuthRepository implements ILoungeAuthRepository {
  constructor(
    private readonly firestore: Firestore,
    private readonly collections: Pick<
      DbCollections,
      | 'loungeUsers'
      | 'loungeSubscriptions'
      | 'loungeCreditLots'
      | 'loungeQuotaLedger'
      | 'loungeTrialGrants'
    >,
    private readonly trialHmacKeyring: TrialHmacKeyring,
    private readonly firebaseAuth: Pick<IFirebaseIdentityClient, 'revokeRefreshTokens' | 'deleteUser'>,
  ) {}

  /** Finds an isolated Private Lounge user record by Firebase Auth UID. */
  public async findUserByUid(uid: string): Promise<LoungeUserDoc | null> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_USERS);
    const snap = await this.collections.loungeUsers.doc(uid).get();
    if (!snap.exists) {
      return null;
    }
    const user = snap.data();
    return user ? assertLoungeRecordOwnedByUid(user, uid, COLLECTIONS.LOUNGE_USERS) : null;
  }

  /** Finds an isolated Private Lounge user record by immutable X user ID. */
  public async findUserByXUserId(xUserId: string): Promise<LoungeUserDoc | null> {
    const trimmed = xUserId.trim();
    if (!trimmed) {
      throw new Error('X user ID must not be empty when querying lounge_users');
    }
    const querySnap = await this.collections.loungeUsers
      .where('xUserId', '==', trimmed)
      .limit(1)
      .get();
    if (querySnap.empty) {
      return null;
    }
    return querySnap.docs[0].data();
  }

  /**
   * Transactionally registers a 1:1 X-linked user, creates an initial `FREE` subscription row,
   * and grants the one-time `+20` welcome bonus lot unless previously claimed or dispute-blocked
   * within the active 3-year `lounge_trial_grants.retainUntil` retention window.
   *
   * @throws LoungeConflictError When UID or X user ID is already registered (`409`).
   * @throws LoungeAuthError When an active non-expired X hash carries `DISPUTE_BLOCKED` (`403`).
   */
  public async createUserWithConsent(
    input: CreateLoungeUserWithConsentInput,
  ): Promise<LoungeUserDoc> {
    assertLoungeRecordOwnedByUid({ uid: input.uid }, input.uid, COLLECTIONS.LOUNGE_USERS);
    const now = new Date();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const trimmedTimezone = input.timezone?.trim();
    const timezone =
      trimmedTimezone !== undefined && trimmedTimezone.length > 0
        ? parseValidIanaTimezone(trimmedTimezone)
        : DEFAULT_LOUNGE_TIMEZONE;
    const language = input.language ?? 'ja';
    const nextResetIso = nextLocalMidnightAfter(now, timezone);

    const activeHash = computeActiveTrialGrantHash(input.xUserId, this.trialHmacKeyring);
    const allHashes = computeAllTrialGrantHashes(input.xUserId, this.trialHmacKeyring);

    return this.firestore.runTransaction(async (tx: Transaction) => {
      const userRef = this.collections.loungeUsers.doc(input.uid);
      const xQuery = this.collections.loungeUsers
        .where('xUserId', '==', input.xUserId)
        .limit(1);
      const grantRefs = allHashes.map((h) => this.collections.loungeTrialGrants.doc(h.hash));

      const [userSnap, xSnap, ...grantSnaps] = await Promise.all([
        tx.get(userRef),
        tx.get(xQuery),
        ...grantRefs.map((ref) => tx.get(ref)),
      ]);

      if (userSnap.exists || !xSnap.empty) {
        throw new LoungeConflictError('An account linked to this X account is already registered');
      }

      // Exclude grants past retainUntil even before Firestore's asynchronous TTL worker sweeps them.
      const activeGrants = grantSnaps
        .filter((s) => s.exists)
        .map((s) => s.data())
        .filter((d): d is LoungeTrialGrantDoc => {
          if (!d) return false;
          const retainMs = Date.parse(d.retainUntil);
          return Number.isFinite(retainMs) && retainMs > nowMs;
        });

      if (activeGrants.some((g) => g.riskStatus === 'DISPUTE_BLOCKED')) {
        throw new LoungeAuthError(
          403,
          'Account registration is blocked due to prior unresolved payment dispute',
          { code: 'DISPUTE_BLOCKED' },
        );
      }

      const priorWelcomeAt = activeGrants.find((g) => Boolean(g.welcomeBonusGrantedAt))?.welcomeBonusGrantedAt;
      const priorTrialAt = activeGrants.find((g) => Boolean(g.trialTicketGrantedAt))?.trialTicketGrantedAt;
      const grantWelcome = !priorWelcomeAt;

      const userDoc: LoungeUserDoc = {
        uid: input.uid,
        xUserId: input.xUserId,
        xHandle: input.xHandle,
        displayName: input.displayName,
        avatarUrl: input.avatarUrl,
        status: 'ACTIVE',
        language,
        timezone,
        onboardingCompleted: input.onboardingCompleted,
        allowServiceImprovementAnalytics: input.allowServiceImprovementAnalytics,
        ...(input.countryCode !== undefined ? { countryCode: input.countryCode } : {}),
        ...(input.isEeaResident !== undefined ? { isEeaResident: input.isEeaResident } : {}),
        ...(input.preferredCurrency !== undefined
          ? { preferredCurrency: input.preferredCurrency }
          : {}),
        disclaimerConsent: input.disclaimerConsent,
        createdAt: nowIso,
        updatedAt: nowIso,
        lastLoginAt: nowIso,
      };

      const welcomeExpiresIso = new Date(
        nowMs + LOUNGE_CREDIT_LOT_VALIDITY_DAYS * DAY_MS,
      ).toISOString();
      const dailyQuota = LOUNGE_DAILY_QUOTA_BY_TIER.FREE;
      const purchasedRemaining = grantWelcome ? LOUNGE_WELCOME_BONUS_CREDITS : 0;

      const subDoc: LoungeSubscriptionDoc = {
        uid: input.uid,
        tier: 'FREE',
        status: 'NONE',
        ...(input.preferredCurrency !== undefined
          ? { billingCurrency: input.preferredCurrency }
          : {}),
        dailyTurnQuota: dailyQuota,
        dailyRemainingTurns: dailyQuota,
        purchasedRemainingTurns: purchasedRemaining,
        remainingChatTurns: dailyQuota + purchasedRemaining,
        earliestLotExpiresAt: grantWelcome ? welcomeExpiresIso : null,
        lastDailyResetAt: nowIso,
        lastQuotaResetTimezone: timezone,
        nextDailyResetAt: nextResetIso,
        currentPeriodEnd: nowIso,
        trialTicketUsed: Boolean(priorTrialAt),
        cancelAtPeriodEnd: false,
        todaysConsumedDailyTurns: 0,
        todaysSearchCount: 0,
        updatedAt: nowIso,
      };

      tx.set(userRef, userDoc);
      tx.set(this.collections.loungeSubscriptions.doc(input.uid), subDoc);

      if (grantWelcome) {
        const welcomeLotId = `welcome_${input.uid}`;
        const welcomeLot: LoungeCreditLotDoc = {
          id: welcomeLotId,
          uid: input.uid,
          productId: 'WELCOME_BONUS_20',
          isPaid: false,
          initialTurns: LOUNGE_WELCOME_BONUS_CREDITS,
          remainingTurns: LOUNGE_WELCOME_BONUS_CREDITS,
          currency: 'NONE',
          unitAmount: 0,
          status: 'ACTIVE',
          purchasedAt: nowIso,
          expiresAt: welcomeExpiresIso,
        };
        const retainUntil = computeTrialGrantRetainUntilIso(now);
        const trialGrant: LoungeTrialGrantDoc = {
          xUserIdHash: activeHash.hash,
          keyVersion: activeHash.keyVersion,
          riskStatus: 'OK',
          welcomeBonusGrantedAt: nowIso,
          ...(priorTrialAt ? { trialTicketGrantedAt: priorTrialAt } : {}),
          retainUntil,
        };
        const welcomeLedger = createQuotaLedgerEntry({
          uid: input.uid,
          deltaType: 'GRANT_WELCOME',
          deltaDaily: 0,
          deltaPurchased: LOUNGE_WELCOME_BONUS_CREDITS,
          balanceTotalAfter: subDoc.remainingChatTurns,
          lotId: welcomeLotId,
          referenceId: welcomeLotId,
          now,
        });

        tx.set(this.collections.loungeCreditLots.doc(welcomeLotId), welcomeLot);
        tx.set(this.collections.loungeTrialGrants.doc(activeHash.hash), trialGrant);
        tx.set(this.collections.loungeQuotaLedger.doc(welcomeLedger.id), welcomeLedger);
      }

      return userDoc;
    });
  }

  /**
   * Transactionally updates `lastLoginAt` on `lounge_users` while verifying the account remains `ACTIVE`.
   *
   * @throws LoungeNotFoundError When `lounge_users/{uid}` does not exist (`404`).
   * @throws LoungeAuthError When account status is not `ACTIVE` (`403`).
   */
  public async recordLoginTimestamp(uid: string, timestampIso: string): Promise<void> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_USERS);
    const ref = this.collections.loungeUsers.doc(uid);
    await this.firestore.runTransaction(async (tx: Transaction) => {
      const snap = await tx.get(ref);
      const existing = snap.data();
      if (!snap.exists || !existing) {
        throw new LoungeNotFoundError(`Private Lounge user "${uid}" not found`);
      }
      if (existing.status !== 'ACTIVE') {
        throw new LoungeAuthError(403, 'Private Lounge account is suspended');
      }
      tx.set(ref, { ...existing, lastLoginAt: timestampIso });
    });
  }

  /** Persists updated language, IANA timezone, onboarding completion, or analytics opt-out on `lounge_users`. */
  public async updateUserPreferences(
    uid: string,
    language?: LoungeLanguage,
    timezone?: string,
    onboardingCompleted?: boolean,
    allowServiceImprovementAnalytics?: boolean,
  ): Promise<LoungeUserDoc> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_USERS);
    const ref = this.collections.loungeUsers.doc(uid);
    return this.firestore.runTransaction(async (tx: Transaction) => {
      const snap = await tx.get(ref);
      const existing = snap.data();
      if (!snap.exists || !existing) {
        throw new LoungeNotFoundError(`Private Lounge user "${uid}" not found`);
      }
      const updated: LoungeUserDoc = {
        ...existing,
        ...(language !== undefined ? { language } : {}),
        ...(timezone !== undefined ? { timezone } : {}),
        ...(onboardingCompleted !== undefined ? { onboardingCompleted } : {}),
        ...(allowServiceImprovementAnalytics !== undefined
          ? { allowServiceImprovementAnalytics }
          : {}),
        updatedAt: new Date().toISOString(),
      };
      tx.set(ref, updated);
      return updated;
    });
  }

  /** Persists re-accepted updated disclaimer consent on `lounge_users`. */
  public async updateUserDisclaimerConsent(
    uid: string,
    disclaimerConsent: LoungeUserDisclaimerConsent,
  ): Promise<LoungeUserDoc> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_USERS);
    const ref = this.collections.loungeUsers.doc(uid);
    return this.firestore.runTransaction(async (tx: Transaction) => {
      const snap = await tx.get(ref);
      const existing = snap.data();
      if (!snap.exists || !existing) {
        throw new LoungeNotFoundError(`Private Lounge user "${uid}" not found`);
      }
      const updated: LoungeUserDoc = {
        ...existing,
        disclaimerConsent,
        updatedAt: new Date().toISOString(),
      };
      tx.set(ref, updated);
      return updated;
    });
  }

  /** Updates lifecycle status (`ACTIVE`, `SUSPENDED`, or `DELETING`) on `lounge_users`. */
  public async updateUserStatus(uid: string, status: LoungeAccountStatus): Promise<void> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_USERS);
    const ref = this.collections.loungeUsers.doc(uid);
    await this.firestore.runTransaction(async (tx: Transaction) => {
      const snap = await tx.get(ref);
      const existing = snap.data();
      if (!snap.exists || !existing) {
        return;
      }
      tx.set(ref, {
        ...existing,
        status,
        updatedAt: new Date().toISOString(),
      });
    });
  }

  /** Revokes active Private Lounge refresh tokens via Firebase Auth (ignores missing user on cleanup). */
  public async revokeSession(uid: string): Promise<void> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_USERS);
    try {
      await this.firebaseAuth.revokeRefreshTokens(uid);
    } catch (err) {
      if (isFirebaseUserNotFoundError(err)) {
        return;
      }
      throw new Error(`Failed to revoke Firebase Auth session for "${uid}"`, { cause: err });
    }
  }

  /**
   * Permanently deletes Firebase Auth credentials BEFORE deleting `lounge_users/{uid}` so
   * interrupted deletions remain authorized for idempotent retries.
   *
   * @throws Error When Firebase Auth deletion fails for reasons other than `auth/user-not-found`.
   */
  public async deleteUser(uid: string): Promise<void> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_USERS);
    try {
      await this.firebaseAuth.deleteUser(uid);
    } catch (err) {
      if (!isFirebaseUserNotFoundError(err)) {
        throw new Error(`Failed to delete Firebase Auth user "${uid}"`, { cause: err });
      }
    }
    await this.collections.loungeUsers.doc(uid).delete();
  }
}

function isFirebaseUserNotFoundError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) {
    return false;
  }
  const code = (err as { readonly code?: unknown }).code;
  return code === 'auth/user-not-found';
}
