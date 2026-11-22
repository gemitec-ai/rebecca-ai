import type { DbCollections } from '@rebecca/db';
import type { LoungeUser, LoungeUserDisclaimerConsent } from '@rebecca/types';
import { LoungeNotImplementedError } from '../../../utils/errors';

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
}

/**
 * Persistence boundary for isolated `lounge_users` authentication and consent state.
 */
export interface ILoungeAuthRepository {
  findUserByUid(uid: string): Promise<LoungeUser | null>;
  findUserByXUserId(xUserId: string): Promise<LoungeUser | null>;
  createUserWithConsent(input: CreateLoungeUserWithConsentInput): Promise<LoungeUser>;
  recordLoginTimestamp(uid: string, timestampIso: string): Promise<void>;
  revokeSession(uid: string): Promise<void>;
}

/**
 * Firestore repository skeleton operating strictly against `collections.loungeUsers`.
 */
export class LoungeAuthRepository implements ILoungeAuthRepository {
  constructor(private readonly collections: Pick<DbCollections, 'loungeUsers'>) {}

  /** Finds an isolated Private Lounge user record by Firebase Auth UID. */
  public async findUserByUid(uid: string): Promise<LoungeUser | null> {
    void this.collections.loungeUsers;
    void uid;
    throw new LoungeNotImplementedError('LoungeAuthRepository.findUserByUid');
  }

  /** Finds an isolated Private Lounge user record by immutable X user ID. */
  public async findUserByXUserId(xUserId: string): Promise<LoungeUser | null> {
    void this.collections.loungeUsers;
    void xUserId;
    throw new LoungeNotImplementedError('LoungeAuthRepository.findUserByXUserId');
  }

  /** Creates a new `lounge_users` profile together with scroll-verified disclaimer consent. */
  public async createUserWithConsent(
    input: CreateLoungeUserWithConsentInput,
  ): Promise<LoungeUser> {
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

  /** Revokes active Private Lounge refresh tokens for the signed-out user. */
  public async revokeSession(uid: string): Promise<void> {
    void this.collections.loungeUsers;
    void uid;
    throw new LoungeNotImplementedError('LoungeAuthRepository.revokeSession');
  }
}
