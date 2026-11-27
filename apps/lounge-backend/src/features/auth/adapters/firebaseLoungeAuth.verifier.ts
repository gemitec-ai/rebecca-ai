import { getApp, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth, type DecodedIdToken } from 'firebase-admin/auth';
import type {
  ILoungeAuthVerifierPort,
  LoungeVerifiedIdentity,
} from '../ports/loungeAuthVerifier.port';
import { LoungeAuthError } from '../../../utils/errors';
import type { IFirebaseIdentityClient } from '../ports/firebaseIdentity.port';

/** Ensures a named or default Firebase identity app exists and returns a tenant-aware client. */
export function createFirebaseIdentityClient(
  projectId: string,
  tenantId?: string,
  appName = 'lounge-bff-auth',
): IFirebaseIdentityClient {
  let app: App;
  const existing = getApps().find((candidate) => candidate.name === appName);
  if (existing) {
    app = existing;
  } else {
    app =
      getApps().length > 0 && !projectId
        ? getApp()
        : initializeApp(projectId ? { projectId } : undefined, appName);
  }
  const baseAuth: Auth = getAuth(app);
  return tenantId ? baseAuth.tenantManager().authForTenant(tenantId) : baseAuth;
}

function readStringClaim(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function extractTwitterProviderId(decoded: DecodedIdToken): string | undefined {
  const firebaseMeta = decoded.firebase as
    | { readonly identities?: Readonly<Record<string, unknown>> }
    | undefined;
  const identities = firebaseMeta?.identities;
  if (identities && Array.isArray(identities['twitter.com'])) {
    const first = identities['twitter.com'][0];
    if (typeof first === 'string' && first.trim().length > 0) {
      return first.trim();
    }
  }
  const claims = decoded as Readonly<Record<string, unknown>>;
  return readStringClaim(claims, 'xUserId');
}

function normalizeHandle(raw: string | undefined, fallbackUid: string): string {
  const cleaned = raw?.replace(/^@+/, '').trim();
  const base = cleaned && cleaned.length > 0 ? cleaned : `member_${fallbackUid.slice(0, 8)}`;
  return `@${base}`;
}

/**
 * Firebase Authentication verifier validating RS256 / Auth Emulator JWTs
 * and extracting mandatory 1:1 X (`twitter.com`) identity metadata.
 */
export class FirebaseLoungeAuthVerifier implements ILoungeAuthVerifierPort {
  constructor(
    private readonly authClient: IFirebaseIdentityClient,
    private readonly isEmulator: boolean = false,
  ) {}

  /**
   * Verifies an incoming Firebase ID token (with revocation check outside Auth Emulator)
   * and maps it to a typed `LoungeVerifiedIdentity`.
   *
   * @throws LoungeAuthError When token verification fails or X provider identity is absent.
   */
  public async verifyBearerToken(idToken: string): Promise<LoungeVerifiedIdentity> {
    let decoded: DecodedIdToken;
    try {
      decoded = await this.authClient.verifyIdToken(idToken, !this.isEmulator);
    } catch (err) {
      throw new LoungeAuthError(401, 'Invalid or expired authentication token', { cause: err });
    }

    const claims = decoded as Readonly<Record<string, unknown>>;
    const xUserId =
      extractTwitterProviderId(decoded) ??
      (this.isEmulator ? readStringClaim(claims, 'x_user_id') ?? `emu_${decoded.uid}` : undefined);

    if (!xUserId) {
      throw new LoungeAuthError(403, 'Firebase account must be linked to an X (Twitter) provider');
    }

    const rawHandle = readStringClaim(claims, 'xHandle') ?? readStringClaim(claims, 'screen_name');
    const displayName =
      readStringClaim(claims, 'name') ??
      readStringClaim(claims, 'xHandle') ??
      `Member ${decoded.uid.slice(0, 6)}`;
    const avatarUrl = readStringClaim(claims, 'picture') ?? 'assets/gemitec_icon.svg';

    return {
      uid: decoded.uid,
      xUserId,
      xHandle: normalizeHandle(rawHandle, decoded.uid),
      displayName,
      avatarUrl,
    };
  }
}
