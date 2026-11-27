import type { LoungeUserDoc } from '@rebecca/types';
import type { ILoungeAuthRepository } from '../features/auth/repositories/loungeAuth.repository';
import {
  assertGeoEligibleForPhase,
  type LoungeGeoCompliancePolicy,
  type ResolvedClientGeo,
} from '../utils/clientGeo';
import { LoungeAuthError } from '../utils/errors';

/** Optional localized/endpoint-specific error strings for active-user access guards. */
export interface LoungeUserGuardMessages {
  readonly notFoundMessage?: string;
  readonly inactiveMessage?: string;
}

/**
 * Verifies that `user` exists and has `status === 'ACTIVE'`.
 *
 * @throws LoungeAuthError `401` when `user` is missing, or `403` when `user.status !== 'ACTIVE'`.
 */
export function assertActiveLoungeUserStatus(
  user: LoungeUserDoc | null | undefined,
  messages: LoungeUserGuardMessages = {},
): LoungeUserDoc {
  if (!user) {
    throw new LoungeAuthError(401, messages.notFoundMessage ?? 'Private Lounge user profile not found');
  }
  if (user.status !== 'ACTIVE') {
    throw new LoungeAuthError(403, messages.inactiveMessage ?? 'Private Lounge account is suspended');
  }
  return user;
}

/**
 * Loads `lounge_users/{uid}` and enforces existence + `status === 'ACTIVE'`.
 *
 * @throws LoungeAuthError `401` when profile is missing, or `403` when inactive/suspended.
 */
export async function requireActiveLoungeUser(
  userReader: Pick<ILoungeAuthRepository, 'findUserByUid'>,
  uid: string,
  messages?: LoungeUserGuardMessages,
): Promise<LoungeUserDoc> {
  const user = await userReader.findUserByUid(uid);
  return assertActiveLoungeUserStatus(user, messages);
}

/**
 * Loads an active Private Lounge user profile and enforces Phase 1/2 Geo-IP eligibility
 * against both the request's trusted Geo-IP origin and the stored `isEeaResident` flag.
 *
 * @throws LoungeAuthError `401` when profile is missing, or `403` when inactive/suspended.
 * @throws LoungeForbiddenError `403` when Geo-IP fails Phase 1/2 regional eligibility (`GEO_BLOCKED` / `GEO_UNAVAILABLE`).
 */
export async function requireActiveGeoEligibleUser(
  userReader: Pick<ILoungeAuthRepository, 'findUserByUid'>,
  uid: string,
  clientGeo: ResolvedClientGeo | undefined,
  geoPolicy: LoungeGeoCompliancePolicy,
  messages?: LoungeUserGuardMessages,
): Promise<LoungeUserDoc> {
  const user = await requireActiveLoungeUser(userReader, uid, messages);
  assertGeoEligibleForPhase(clientGeo, geoPolicy, user.isEeaResident);
  return user;
}
