import { Injectable, signal } from '@angular/core';
import type { LoungeFirebaseWebConfig, LoungeRuntimeConfigDto } from '@rebecca/types';
import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  OAuthProvider,
  TwitterAuthProvider,
  connectAuthEmulator,
  getAuth,
  onAuthStateChanged,
  signInWithCredential,
  signInWithPopup,
  signOut,
  type Auth,
  type Unsubscribe,
  type User,
} from 'firebase/auth';

const LOUNGE_FIREBASE_APP_NAME = 'gemitec-private-lounge';
const EMU_X_USER_STORAGE_KEY = 'lounge_emu_x_user';
const DEFAULT_EMU_X_USER = '1000000099';
const SAFE_EMU_X_USER_PATTERN = /^[A-Za-z0-9_-]{3,40}$/;

/**
 * Credential bundle returned after interactive X (`twitter.com`) authentication.
 */
export interface LoungeXAuthCredentialResult {
  readonly idToken: string;
  readonly xOAuthCode: string;
  readonly uid: string;
}

/**
 * Modular Firebase Web Auth adapter scoped cleanly to a named Firebase App instance so
 * Private Lounge sessions never collide with other Firebase apps in shared environments.
 */
@Injectable({ providedIn: 'root' })
export class LoungeAuthService {
  private firebaseConfig: LoungeFirebaseWebConfig | null = null;
  private useEmulators = false;
  private isProduction = false;

  private app: FirebaseApp | null = null;
  private auth: Auth | null = null;
  private emulatorConnected = false;
  private authReadyPromise: Promise<void> | null = null;
  private authUnsubscribe: Unsubscribe | null = null;

  /** Reactive signal reflecting the currently signed-in Firebase User. */
  public readonly currentUserSignal = signal<User | null>(null);

  /** Applies runtime Firebase configuration resolved from `/api/v1/lounge/config`. */
  public configure(config: Pick<LoungeRuntimeConfigDto, 'firebase' | 'useEmulators' | 'production'>): void {
    this.useEmulators = config.useEmulators === true;
    this.isProduction = config.production === true;
    if (config.firebase) {
      this.firebaseConfig = { ...config.firebase };
    }
  }

  /**
   * Resolves deterministic emulator X ID from `?emuXUser=` query string or `sessionStorage`
   * strictly outside production (`useEmulators && !isProduction`).
   */
  public resolveEmulatorXUserId(): string {
    if (typeof window !== 'undefined') {
      try {
        const params = new URLSearchParams(window.location.search);
        const queryVal = params.get('emuXUser')?.trim();
        if (queryVal && SAFE_EMU_X_USER_PATTERN.test(queryVal)) {
          window.sessionStorage?.setItem(EMU_X_USER_STORAGE_KEY, queryVal);
          return queryVal;
        }
        const storedVal = window.sessionStorage?.getItem(EMU_X_USER_STORAGE_KEY)?.trim();
        if (storedVal && SAFE_EMU_X_USER_PATTERN.test(storedVal)) {
          return storedVal;
        }
      } catch {
        // Fallback to synthetic local ID when storage is restricted.
      }
    }
    return DEFAULT_EMU_X_USER;
  }

  /** Waits for Firebase Auth persistence initialization to settle. */
  public async waitForInit(): Promise<void> {
    const auth = this.tryEnsureAuth();
    if (!auth) {
      return;
    }
    if (this.authReadyPromise) {
      await this.authReadyPromise;
    }
    const current = auth.currentUser ?? null;
    if (this.currentUserSignal() !== current) {
      this.currentUserSignal.set(current);
    }
  }

  /** Synchronously returns the active cached Firebase ID token without awaiting refresh locks. */
  public getSyncToken(): string | null {
    const user = this.currentUserSignal() ?? this.auth?.currentUser ?? null;
    if (!user) {
      return null;
    }
    const tokenCarrier = user as unknown as {
      accessToken?: string;
      stsTokenManager?: { accessToken?: string };
    };
    return tokenCarrier.accessToken ?? tokenCarrier.stsTokenManager?.accessToken ?? null;
  }

  /** Returns the current user's Firebase ID token asynchronously, guarded by a short timeout. */
  public async getToken(forceRefresh = false): Promise<string | null> {
    if (!forceRefresh) {
      const syncToken = this.getSyncToken();
      if (syncToken) {
        return syncToken;
      }
    }
    const user = this.currentUserSignal() ?? this.auth?.currentUser ?? null;
    if (!user) {
      return null;
    }
    try {
      return await Promise.race([
        user.getIdToken(forceRefresh),
        new Promise<string | null>((_, reject) =>
          setTimeout(() => reject(new Error('Firebase getIdToken timed out')), 3000),
        ),
      ]);
    } catch {
      return null;
    }
  }

  /**
   * Signs the user in with X (`twitter.com`) via `signInWithPopup` in live environments or
   * deterministic `OAuthProvider('twitter.com')` credentials when running on the Auth Emulator.
   *
   * @throws Error When Firebase Web configuration is unavailable or X popup fails.
   */
  public async authenticateWithX(): Promise<LoungeXAuthCredentialResult> {
    const auth = this.ensureAuthOrThrow();

    if (this.useEmulators && !this.isProduction) {
      const emuXUser = this.resolveEmulatorXUserId();
      const shortSuffix = emuXUser.slice(-4);
      const oauthProvider = new OAuthProvider('twitter.com');
      const credential = oauthProvider.credential({
        idToken: JSON.stringify({
          sub: emuXUser,
          name: `Member ${shortSuffix}`,
          screen_name: `member_${shortSuffix}`,
        }),
      });
      const result = await signInWithCredential(auth, credential);
      const idToken = await result.user.getIdToken(true);
      this.currentUserSignal.set(result.user);
      return {
        idToken,
        xOAuthCode: `emu_x_oauth_${emuXUser}`,
        uid: result.user.uid,
      };
    }

    const provider = new TwitterAuthProvider();
    const loginPromise = (async (): Promise<LoungeXAuthCredentialResult> => {
      const result = await signInWithPopup(auth, provider);
      const idToken = await result.user.getIdToken(true);
      const oauthCred = TwitterAuthProvider.credentialFromResult(result);
      this.currentUserSignal.set(result.user);
      return {
        idToken,
        xOAuthCode: oauthCred?.accessToken ?? 'firebase-twitter-popup',
        uid: result.user.uid,
      };
    })();

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('X sign-in timed out. Please try again.')), 25000),
    );

    return Promise.race([loginPromise, timeoutPromise]);
  }

  /** Signs out of the scoped Firebase Auth client safely if initialized. */
  public async signOutFirebase(): Promise<void> {
    if (!this.auth) {
      this.currentUserSignal.set(null);
      return;
    }
    await signOut(this.auth);
    this.currentUserSignal.set(null);
  }

  private tryEnsureAuth(): Auth | null {
    if (this.auth) {
      return this.auth;
    }
    if (!this.firebaseConfig) {
      return null;
    }
    const existingApp = getApps().find((candidate) => candidate.name === LOUNGE_FIREBASE_APP_NAME);
    this.app = existingApp
      ? getApp(LOUNGE_FIREBASE_APP_NAME)
      : initializeApp(this.firebaseConfig, LOUNGE_FIREBASE_APP_NAME);
    const auth = getAuth(this.app);
    if (this.firebaseConfig.tenantId) {
      auth.tenantId = this.firebaseConfig.tenantId;
    }
    if (this.useEmulators && !this.isProduction && !this.emulatorConnected) {
      connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
      this.emulatorConnected = true;
    }
    this.authUnsubscribe?.();
    this.authUnsubscribe = onAuthStateChanged(auth, (user) => {
      this.currentUserSignal.set(user);
    });
    this.authReadyPromise =
      typeof auth.authStateReady === 'function' ? auth.authStateReady() : Promise.resolve();
    this.auth = auth;
    return auth;
  }

  private ensureAuthOrThrow(): Auth {
    const auth = this.tryEnsureAuth();
    if (!auth) {
      throw new Error('Firebase Web configuration is missing from /api/v1/lounge/config');
    }
    return auth;
  }
}
