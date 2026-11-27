import crypto from 'node:crypto';
import { LoungeValidationError } from './errors';

/**
 * HMAC keyring mapping integer key version numbers (`>= 1`) to raw HMAC secrets
 * for anonymizing `lounge_trial_grants` across key rotations without retaining PII.
 */
export interface TrialHmacKeyring {
  readonly activeVersion: number;
  readonly keys: ReadonlyMap<number, string>;
}

/**
 * Computes a single keyed HMAC-SHA256 digest for `xUserId` under `secret`.
 *
 * @throws LoungeValidationError When `xUserId` is empty or whitespace-only.
 */
export function computeTrialHmacDigest(xUserId: string, secret: string): string {
  const normalized = xUserId.trim();
  if (!normalized) {
    throw new LoungeValidationError('X user ID must not be empty when computing grant hash');
  }
  return crypto.createHmac('sha256', secret).update(normalized, 'utf8').digest('hex');
}

/**
 * Computes the active versioned hash `{ keyVersion, hash }` for persisting new grant rows.
 *
 * @throws Error When `keyring.activeVersion` has no secret configured, or `xUserId` is empty.
 */
export function computeActiveTrialGrantHash(
  xUserId: string,
  keyring: TrialHmacKeyring,
): { readonly keyVersion: number; readonly hash: string } {
  const secret = keyring.keys.get(keyring.activeVersion);
  if (!secret) {
    throw new Error(`Missing HMAC secret for active key version ${keyring.activeVersion}`);
  }
  return {
    keyVersion: keyring.activeVersion,
    hash: computeTrialHmacDigest(xUserId, secret),
  };
}

/**
 * Computes digests across every configured key version for `db.getAll(...)` batch lookup.
 *
 * @throws LoungeValidationError When `xUserId` is empty or whitespace-only.
 */
export function computeAllTrialGrantHashes(
  xUserId: string,
  keyring: TrialHmacKeyring,
): ReadonlyArray<{ readonly keyVersion: number; readonly hash: string }> {
  return Array.from(keyring.keys.entries())
    .sort(([a], [b]) => b - a)
    .map(([keyVersion, secret]) => ({
      keyVersion,
      hash: computeTrialHmacDigest(xUserId, secret),
    }));
}
