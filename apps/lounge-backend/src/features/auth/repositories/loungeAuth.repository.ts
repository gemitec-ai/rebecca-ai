import { COLLECTIONS, assertLoungeRecordOwnedByUid, type DbCollections } from '@rebecca/db';
import type {
  LoungeLanguage,
  LoungeUser,
  LoungeUserDisclaimerConsent,
  LoungeUserDoc,
} from '@rebecca/types';
import { LoungeNotImplementedError } from '../../../utils/errors';

/**
 * Strips server-only Dreaming memory fields (`coreProfile`, `episodicBuffer`, `lastDreamedAt`)
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
  ): Promise<LoungeUserDoc>;
  updateUserDisclaimerConsent(
    uid: string,
    disclaimerConsent: LoungeUserDisclaimerConsent,
  ): Promise<LoungeUserDoc>;
  revokeSession(uid: string): Promise<void>;
  deleteUser(uid: string): Promise<void>;
}

/**
 * Firestore repository skeleton operating strictly against `collections.loungeUsers`
 * with explicit tenant-UID ownership guards.
 */
export class LoungeAuthRepository implements ILoungeAuthRepository {
  constructor(private readonly collections: Pick<DbCollections, 'loungeUsers'>) {}

  /** Finds an isolated Private Lounge user record by Firebase Auth UID. */
  public async findUserByUid(uid: string): Promise<LoungeUserDoc | null> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_USERS);
    void this.collections.loungeUsers;
    throw new LoungeNotImplementedError('LoungeAuthRepository.findUserByUid');
  }

  /** Finds an isolated Private Lounge user record by immutable X user ID. */
  public async findUserByXUserId(xUserId: string): Promise<LoungeUserDoc | null> {
    if (!xUserId.trim()) {
      throw new Error('X user ID must not be empty when querying lounge_users');
    }
    void this.collections.loungeUsers;
    throw new LoungeNotImplementedError('LoungeAuthRepository.findUserByXUserId');
  }

  /** Creates a new `lounge_users` profile together with scroll-verified disclaimer consent. */
  public async createUserWithConsent(
    input: CreateLoungeUserWithConsentInput,
  ): Promise<LoungeUserDoc> {
    assertLoungeRecordOwnedByUid({ uid: input.uid }, input.uid, COLLECTIONS.LOUNGE_USERS);
    void this.collections.loungeUsers;
    throw new LoungeNotImplementedError('LoungeAuthRepository.createUserWithConsent');
  }

  /** Updates the `lastLoginAt` audit timestamp on `lounge_users`. */
  public async recordLoginTimestamp(uid: string, timestampIso: string): Promise<void> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_USERS);
    void this.collections.loungeUsers;
    void timestampIso;
    throw new LoungeNotImplementedError('LoungeAuthRepository.recordLoginTimestamp');
  }

  /** Persists updated UI/AI language, IANA timezone, or onboarding completion state on `lounge_users`. */
  public async updateUserPreferences(
    uid: string,
    language?: LoungeLanguage,
    timezone?: string,
    onboardingCompleted?: boolean,
  ): Promise<LoungeUserDoc> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_USERS);
    void this.collections.loungeUsers;
    void language;
    void timezone;
    void onboardingCompleted;
    throw new LoungeNotImplementedError('LoungeAuthRepository.updateUserPreferences');
  }

  /** Persists re-accepted updated disclaimer consent on `lounge_users`. */
  public async updateUserDisclaimerConsent(
    uid: string,
    disclaimerConsent: LoungeUserDisclaimerConsent,
  ): Promise<LoungeUserDoc> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_USERS);
    void this.collections.loungeUsers;
    void disclaimerConsent;
    throw new LoungeNotImplementedError('LoungeAuthRepository.updateUserDisclaimerConsent');
  }

  /** Revokes active Private Lounge refresh tokens for the signed-out user. */
  public async revokeSession(uid: string): Promise<void> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_USERS);
    void this.collections.loungeUsers;
    throw new LoungeNotImplementedError('LoungeAuthRepository.revokeSession');
  }

  /** Permanently deletes the isolated `lounge_users` profile document for `uid`. */
  public async deleteUser(uid: string): Promise<void> {
    assertLoungeRecordOwnedByUid({ uid }, uid, COLLECTIONS.LOUNGE_USERS);
    void this.collections.loungeUsers;
    throw new LoungeNotImplementedError('LoungeAuthRepository.deleteUser');
  }
}
