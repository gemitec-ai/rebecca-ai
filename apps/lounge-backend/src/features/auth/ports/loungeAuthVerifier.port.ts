/**
 * Verified identity extracted from a Firebase/X-linked Bearer ID token.
 */
export interface LoungeVerifiedIdentity {
  readonly uid: string;
  readonly xUserId: string;
  readonly xHandle: string;
  readonly displayName: string;
  readonly avatarUrl: string;
}

/**
 * Hexagonal port for validating Private Lounge client ID tokens.
 */
export interface ILoungeAuthVerifierPort {
  /**
   * Verifies the Firebase/X-linked Bearer ID token and returns the authenticated identity.
   *
   * @throws LoungeAuthError When signature verification, revocation check, or identity extraction fails.
   */
  verifyBearerToken(idToken: string): Promise<LoungeVerifiedIdentity>;
}
