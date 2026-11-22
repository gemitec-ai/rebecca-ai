import type { DbCollections } from '@rebecca/db';
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
  ): Promise<LoungeUserDoc>;
  revokeSession(uid: string): Promise<void>;
  deleteUser(uid: string): Promise<void>;
}

/**
 * Firestore repository skeleton operating strictly against `collections.loungeUsers`.
 */
export class LoungeAuthRepository implements ILoungeAuthRepository {
  constructor(private readonly collections: Pick<DbCollections, 'loungeUsers'>) {}

  /** Finds an isolated Private Lounge user record by Firebase Auth UID. */
  public async findUserByUid(uid: string): Promise<LoungeUserDoc | null> {
    void this.collections.loungeUsers;
    void uid;
    throw new LoungeNotImplementedError('LoungeAuthRepository.findUserByUid');
  }

  /** Finds an isolated Private Lounge user record by immutable X user ID. */
  public async findUserByXUserId(xUserId: string): Promise<LoungeUserDoc | null> {
    void this.collections.loungeUsers;
    void xUserId;
    throw new LoungeNotImplementedError('LoungeAuthRepository.findUserByXUserId');
  }

  /** Creates a new `lounge_users` profile together with scroll-verified disclaimer consent. */
  public async createUserWithConsent(
    input: CreateLoungeUserWithConsentInput,
  ): Promise<LoungeUserDoc> {
    void this.collections.loungeUsers;
    void input;
    throw new LoungeNotImplementedError('LoungeAuthRepository.createUserWithConsent');
  }

  /** Updates the `lastLoginAt` audit timestamp on `lounge_users`. */
  public async recordLoginTimestamp(uid: string, timestampIso: string): Promise<void> {
    void this.collections.loungeUsers;
    void uid;
    void timestampIso;
    throw new LoungeNotImplementedError('LoungeAuthRepository.recordLoginTimestamp');
  }

  /** Persists updated UI/AI language or IANA timezone preferences on `lounge_users`. */
  public async updateUserPreferences(
    uid: string,
    language?: LoungeLanguage,
    timezone?: string,
  ): Promise<LoungeUserDoc> {
    void this.collections.loungeUsers;
    void uid;
    void language;
    void timezone;
    throw new LoungeNotImplementedError('LoungeAuthRepository.updateUserPreferences');
  }

  /** Revokes active Private Lounge refresh tokens for the signed-out user. */
  public async revokeSession(uid: string): Promise<void> {
    void this.collections.loungeUsers;
    void uid;
    throw new LoungeNotImplementedError('LoungeAuthRepository.revokeSession');
  }

  /** Permanently deletes the isolated `lounge_users` profile document for `uid`. */
  public async deleteUser(uid: string): Promise<void> {
    void this.collections.loungeUsers;
    void uid;
    throw new LoungeNotImplementedError('LoungeAuthRepository.deleteUser');
  }
}
