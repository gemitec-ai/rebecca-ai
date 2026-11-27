import type { DecodedIdToken } from 'firebase-admin/auth';

/**
 * Identity provider port encapsulating token verification, session revocation, and account deletion.
 */
export interface IFirebaseIdentityClient {
  /**
   * Verifies a Firebase Auth ID token and optionally checks token revocation status.
   *
   * @throws Error When token signature, expiration, or revocation checks fail.
   */
  verifyIdToken(idToken: string, checkRevoked?: boolean): Promise<DecodedIdToken>;

  /**
   * Revokes all active refresh tokens belonging to `uid`.
   *
   * @throws Error When Firebase Auth session revocation fails.
   */
  revokeRefreshTokens(uid: string): Promise<void>;

  /**
   * Permanently deletes the Firebase Auth user identified by `uid`.
   *
   * @throws Error When Firebase Auth user deletion fails.
   */
  deleteUser(uid: string): Promise<void>;
}
