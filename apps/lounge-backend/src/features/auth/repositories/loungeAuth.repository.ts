import type { Firestore, Transaction } from '@google-cloud/firestore';
import { COLLECTIONS, assertLoungeRecordOwnedByUid, type DbCollections } from '@rebecca/db';
import type {
  LoungeAccountStatus,
  LoungeCreditLotDoc,
  LoungeCurrency,
  LoungeLanguage,
  LoungeSubscriptionDoc,
  LoungeTrialGrantDoc,
  LoungeUser,
  LoungeUserDisclaimerConsent,
  LoungeUserDoc,
} from '@rebecca/types';
import {
  DEFAULT_LOUNGE_TIMEZONE,
  LOUNGE_CREDIT_LOT_VALIDITY_DAYS,
  LOUNGE_DAILY_QUOTA_BY_TIER,
  LOUNGE_TRIAL_GRANT_RETENTION_DAYS,
  computeActiveTrialGrantHash,
  computeAllTrialGrantHashes,
  type TrialHmacKeyring,
} from '../../../config/loungeConfig';
import { LoungeAuthError, LoungeConflictError, LoungeNotFoundError } from '../../../utils/errors';
import {
  createQuotaLedgerEntry,
  nextLocalMidnightAfter,
} from '../../billing/domain/loungeQuota.engine';
import type { IFirebaseAdminAuthLike } from '../adapters/firebaseLoungeAuth.verifier';

const WELCOME_BONUS_TURNS = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Strips server-only Dreaming memory fields (`coreProfile`, `episodicBuffer`, `lastDreamedAt`, `dailySearchCount`)
 * before returning an authenticated user profile across BFF HTTP responses.
 */
export function toPublicLoungeUser(doc: LoungeUserDoc): LoungeUser {
  return {
    uid: doc.uid,
    xUserId: doc.xUserId,
    xHandle: doc.xHandle,
    displayName: doc.displayName,
    avatarUrl: doc.avatarUrl,
    status: doc.status,
    language: doc.language,
    timezone: doc.timezone,
    onboardingCompleted: doc.onboardingCompleted,
    allowServiceImprovementAnalytics: doc.allowServiceImprovementAnalytics,
    ...(doc.countryCode !== undefined ? { countryCode: doc.countryCode } : {}),
    ...(doc.isEeaResident !== undefined ? { isEeaResident: doc.isEeaResident } : {}),
    ...(doc.preferredCurrency !== undefined ? { preferredCurrency: doc.preferredCurrency } : {}),
    disclaimerConsent: doc.disclaimerConsent,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    lastLoginAt: doc.lastLoginAt,
  };
}

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
  readonly language?: LoungeLanguage;
  readonly timezone?: string;
  readonly allowServiceImprovementAnalytics?: boolean;
  readonly countryCode?: string;
  readonly isEeaResident?: boolean;
  readonly preferredCurrency?: LoungeCurrency;
}

/**
 * Persistence boundary for isolated `lounge_users` authentication, preferences, and consent state.
 */
export interface ILoungeAuthRepository {
  findUserByUid(uid: string): Promise<LoungeUserDoc | null>;
  findUserByXUserId(xUserId: string): Promise<LoungeUserDoc | null>;
  createUserWithConsent(input: CreateLoungeUserWithConsentInput): Promise<LoungeUserDoc>;
  recordLoginTimestamp(uid: string, timestampIso: string): Promise<void>;
  updateUserPreferences(
    uid: string,
    language?: LoungeLanguage,
    timezone?: string,
    onboardingCompleted?: boolean,
    allowServiceImprovementAnalytics?: boolean,
  ): Promise<LoungeUserDoc>;
  updateUserDisclaimerConsent(
    uid: string,
    disclaimerConsent: LoungeUserDisclaimerConsent,
  ): Promise<LoungeUserDoc>;
  updateUserStatus?(uid: string, status: LoungeAccountStatus): Promise<void>;
  revokeSession(uid: string): Promise<void>;
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
    private readonly firebaseAuth?: Pick<IFirebaseAdminAuthLike, 'revokeRefreshTokens' | 'deleteUser'>,
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
   * and grants the one-time `+20` welcome bonus lot unless previously claimed or dispute-blocked.
   *
   * @throws LoungeConflictError When UID or X user ID is already registered (`409`).
   * @throws LoungeAuthError When the anonymized X hash carries `DISPUTE_BLOCKED` (`403`).
   */
  public async createUserWithConsent(
    input: CreateLoungeUserWithConsentInput,
  ): Promise<LoungeUserDoc> {
    assertLoungeRecordOwnedByUid({ uid: input.uid }, input.uid, COLLECTIONS.LOUNGE_USERS);
    const now = new Date();
    const nowIso = now.toISOString();
    const timezone = input.timezone?.trim() || DEFAULT_LOUNGE_TIMEZONE;
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

      const existingGrants = grantSnaps
        .filter((s) => s.exists)
        .map((s) => s.data())
        .filter((d): d is LoungeTrialGrantDoc => d !== undefined);

      if (existingGrants.some((g) => g.riskStatus === 'DISPUTE_BLOCKED')) {
        throw new LoungeAuthError(
          403,
          'Account registration is blocked due to prior unresolved payment dispute',
          { code: 'DISPUTE_BLOCKED' },
        );
      }

      const priorWelcomeAt = existingGrants.find((g) => Boolean(g.welcomeBonusGrantedAt))?.welcomeBonusGrantedAt;
      const priorTrialAt = existingGrants.find((g) => Boolean(g.trialTicketGrantedAt))?.trialTicketGrantedAt;
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
        allowServiceImprovementAnalytics: input.allowServiceImprovementAnalytics ?? true,
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
        now.getTime() + LOUNGE_CREDIT_LOT_VALIDITY_DAYS * DAY_MS,
      ).toISOString();
      const dailyQuota = LOUNGE_DAILY_QUOTA_BY_TIER.FREE;
      const purchasedRemaining = grantWelcome ? WELCOME_BONUS_TURNS : 0;

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
          initialTurns: WELCOME_BONUS_TURNS,
          remainingTurns: WELCOME_BONUS_TURNS,
          currency: 'NONE',
          unitAmount: 0,
          status: 'ACTIVE',
          purchasedAt: nowIso,
          expiresAt: welcomeExpiresIso,
        };
        const retainUntil = new Date(
          now.getTime() + LOUNGE_TRIAL_GRANT_RETENTION_DAYS * DAY_MS,
        ).toISOString();
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
          deltaPurchased: WELCOME_BONUS_TURNS,
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

  /** Updates the `lastLoginAt` audit timestamp on `lounge_users`. */
  public async recordLoginTimestamp(uid: string, timestampIso: string): Promise<void> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_USERS);
    const ref = this.collections.loungeUsers.doc(uid);
    const snap = await ref.get();
    const existing = snap.data();
    if (!snap.exists || !existing) {
      throw new LoungeNotFoundError(`Private Lounge user "${uid}" not found`);
    }
    await ref.set({ ...existing, lastLoginAt: timestampIso });
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
    if (!this.firebaseAuth) {
      return;
    }
    try {
      await this.firebaseAuth.revokeRefreshTokens(uid);
    } catch (err) {
      if (isFirebaseUserNotFoundError(err)) {
        return;
      }
      throw new Error(`Failed to revoke Firebase Auth session for "${uid}"`, { cause: err });
    }
  }

  /** Permanently deletes `lounge_users/{uid}` and the linked Firebase Auth account (tolerating missing user). */
  public async deleteUser(uid: string): Promise<void> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_USERS);
    await this.collections.loungeUsers.doc(uid).delete();
    if (!this.firebaseAuth) {
      return;
    }
    try {
      await this.firebaseAuth.deleteUser(uid);
    } catch (err) {
      if (isFirebaseUserNotFoundError(err)) {
        return;
      }
      throw new Error(`Failed to delete Firebase Auth user "${uid}"`, { cause: err });
    }
  }
}

function isFirebaseUserNotFoundError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) {
    return false;
  }
  const code = (err as { readonly code?: unknown }).code;
  return code === 'auth/user-not-found';
}
