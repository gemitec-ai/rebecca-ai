const mockInitializeApp = jest.fn((_cfg?: unknown, name?: string) => ({ name: name ?? '[DEFAULT]' }));
const mockGetApps = jest.fn(() => [] as { name: string }[]);
const mockGetApp = jest.fn((name?: string) => ({ name: name ?? '[DEFAULT]' }));

const mockAuthInstance: {
  currentUser: {
    uid: string;
    accessToken?: string;
    stsTokenManager?: { accessToken?: string };
    getIdToken: jest.Mock<Promise<string>, [boolean?]>;
  } | null;
  tenantId: string | null;
  authStateReady?: jest.Mock<Promise<void>, []>;
} = {
  currentUser: null,
  tenantId: null,
  authStateReady: jest.fn(async () => undefined),
};

const mockGetAuth = jest.fn(() => mockAuthInstance);
const mockConnectAuthEmulator = jest.fn();
const mockOnAuthStateChanged = jest.fn(
  (_auth: unknown, cb: (user: typeof mockAuthInstance.currentUser) => void) => {
    cb(mockAuthInstance.currentUser);
    return jest.fn();
  },
);
const mockSignInWithCredential = jest.fn(async () => ({
  user: {
    uid: 'uid_emu_001',
    accessToken: 'emu-id-token',
    getIdToken: jest.fn(async () => 'emu-id-token'),
  },
}));
const mockSignInWithPopup = jest.fn(async () => ({
  user: {
    uid: 'uid_live_001',
    accessToken: 'live-id-token',
    getIdToken: jest.fn(async () => 'live-id-token'),
  },
}));
const mockSignOut = jest.fn(async () => {
  mockAuthInstance.currentUser = null;
});
const mockOAuthCredential = jest.fn((params: { readonly idToken: string }) => ({
  providerId: 'twitter.com',
  idToken: params.idToken,
}));
const mockTwitterCredentialFromResult = jest.fn(
  (_result: unknown): { readonly accessToken?: string } | null => ({
    accessToken: 'twitter-oauth-access-token',
  }),
);

jest.mock('firebase/app', () => ({
  initializeApp: (cfg: unknown, name?: string) => mockInitializeApp(cfg, name),
  getApps: () => mockGetApps(),
  getApp: (name?: string) => mockGetApp(name),
}));

jest.mock('firebase/auth', () => {
  class MockOAuthProvider {
    constructor(public readonly providerId: string) {}
    public credential(params: { readonly idToken: string }) {
      return mockOAuthCredential(params);
    }
  }
  class MockTwitterAuthProvider {
    public readonly providerId = 'twitter.com';
    public static credentialFromResult(result: unknown) {
      return mockTwitterCredentialFromResult(result);
    }
  }
  return {
    OAuthProvider: MockOAuthProvider,
    TwitterAuthProvider: MockTwitterAuthProvider,
    connectAuthEmulator: (auth: unknown, url: string, opts: unknown) =>
      mockConnectAuthEmulator(auth, url, opts),
    getAuth: () => mockGetAuth(),
    onAuthStateChanged: (auth: unknown, cb: (user: typeof mockAuthInstance.currentUser) => void) =>
      mockOnAuthStateChanged(auth, cb),
    signInWithCredential: (auth: unknown, cred: unknown) => {
      void auth;
      void cred;
      return mockSignInWithCredential();
    },
    signInWithPopup: (auth: unknown, prov: unknown) => {
      void auth;
      void prov;
      return mockSignInWithPopup();
    },
    signOut: (auth: unknown) => {
      void auth;
      return mockSignOut();
    },
  };
});

import { LoungeAuthService } from './lounge-auth.service';

describe('LoungeAuthService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.sessionStorage.clear();
    window.history.replaceState({}, '', '/');
    mockGetApps.mockReturnValue([]);
    mockAuthInstance.currentUser = null;
    mockAuthInstance.tenantId = null;
    mockAuthInstance.authStateReady = jest.fn(async () => undefined);
    mockTwitterCredentialFromResult.mockReturnValue({
      accessToken: 'twitter-oauth-access-token',
    });
  });

  it('throws cleanly when Firebase configuration is missing and handles uninitialized tokens', async () => {
    const svc = new LoungeAuthService();
    await expect(svc.waitForInit()).resolves.toBeUndefined();
    expect(await svc.getToken(false)).toBeNull();
    await expect(svc.authenticateWithX()).rejects.toThrow(/Firebase Web configuration is missing/i);
    await expect(svc.signOutFirebase()).resolves.toBeUndefined();
  });

  it('authenticates in emulator mode with ?emuXUser= and sessionStorage under private-lounge app', async () => {
    window.history.replaceState({}, '', '/?emuXUser=emu_user_42');
    const svc = new LoungeAuthService();
    svc.configure({
      production: false,
      useEmulators: true,
      firebase: {
        apiKey: 'demo-key',
        authDomain: 'localhost',
        projectId: 'demo-project',
        appId: '1:123:web:abc',
        tenantId: 'tenant-1',
      },
    });

    await svc.waitForInit();
    expect(mockInitializeApp).toHaveBeenCalledWith(expect.any(Object), 'private-lounge');
    expect(mockConnectAuthEmulator).toHaveBeenCalledWith(
      mockAuthInstance,
      'http://127.0.0.1:9099',
      { disableWarnings: true },
    );
    expect(mockAuthInstance.tenantId).toBe('tenant-1');

    const result = await svc.authenticateWithX();
    expect(result).toEqual({
      idToken: 'emu-id-token',
      xOAuthCode: 'emu_x_oauth_emu_user_42',
      uid: 'uid_emu_001',
    });
    expect(window.sessionStorage.getItem('lounge_emu_x_user')).toBe('emu_user_42');

    // Reads cached sessionStorage ID when query parameter disappears
    window.history.replaceState({}, '', '/');
    expect(svc.resolveEmulatorXUserId()).toBe('emu_user_42');

    // Invalid query falls back after clearing storage
    window.sessionStorage.clear();
    window.history.replaceState({}, '', '/?emuXUser=invalid!@');
    expect(svc.resolveEmulatorXUserId()).toBe('1000000099');
  });

  it('reuses existing named Firebase app and supports live TwitterAuthProvider without dummy xOAuthCode', async () => {
    mockGetApps.mockReturnValue([{ name: 'private-lounge' }]);
    mockTwitterCredentialFromResult.mockReturnValueOnce(null);

    const svc = new LoungeAuthService();
    svc.configure({
      production: true,
      useEmulators: false,
      firebase: {
        apiKey: 'live-key',
        authDomain: 'auth.example.com',
        projectId: 'live-project',
        appId: '1:999:web:xyz',
      },
    });

    const resWithoutOAuthToken = await svc.authenticateWithX();
    expect(mockGetApp).toHaveBeenCalledWith('private-lounge');
    expect(mockSignInWithPopup).toHaveBeenCalledTimes(1);
    expect(resWithoutOAuthToken).toEqual({
      idToken: 'live-id-token',
      uid: 'uid_live_001',
    });
    expect('xOAuthCode' in resWithoutOAuthToken).toBe(false);

    mockTwitterCredentialFromResult.mockReturnValueOnce({ accessToken: 'real-oauth-token' });
    const resWithOAuthToken = await svc.authenticateWithX();
    expect(resWithOAuthToken.xOAuthCode).toBe('real-oauth-token');

    await svc.signOutFirebase();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(svc.currentUserSignal()).toBeNull();
  });

  it('always resolves tokens via official user.getIdToken(), clears timers, and cleans up timed-out popups', async () => {
    const svc = new LoungeAuthService();
    svc.configure({
      production: true,
      useEmulators: false,
      firebase: {
        apiKey: 'live-key',
        authDomain: 'auth.example.com',
        projectId: 'live-project',
        appId: '1:999:web:xyz',
      },
    });
    await svc.waitForInit();

    mockAuthInstance.currentUser = {
      uid: 'uid_cached',
      stsTokenManager: { accessToken: 'stale-internal-token' },
      getIdToken: jest.fn(async (force?: boolean) => (force ? 'forced-fresh-token' : 'fresh-sdk-token')),
    };
    svc.currentUserSignal.set(mockAuthInstance.currentUser as never);

    expect(await svc.getToken(false)).toBe('fresh-sdk-token');
    expect(mockAuthInstance.currentUser.getIdToken).toHaveBeenCalledWith(false);
    expect(await svc.getToken(true)).toBe('forced-fresh-token');
    expect(mockAuthInstance.currentUser.getIdToken).toHaveBeenCalledWith(true);

    mockAuthInstance.currentUser.getIdToken.mockRejectedValueOnce(new Error('network error'));
    expect(await svc.getToken(true)).toBeNull();

    // Timeout guard clears timer on timeout and prevents post-timeout popup signIn mutation
    jest.useFakeTimers();
    try {
      mockAuthInstance.currentUser.getIdToken.mockImplementationOnce(
        () => new Promise<string>(() => undefined),
      );
      const tokenTimeoutPromise = svc.getToken(false);
      jest.advanceTimersByTime(3000);
      expect(await tokenTimeoutPromise).toBeNull();

      svc.currentUserSignal.set(null);
      let resolvePopup!: (value: {
        user: { uid: string; getIdToken: jest.Mock<Promise<string>, [boolean?]> };
      }) => void;
      mockSignInWithPopup.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePopup = resolve as typeof resolvePopup;
          }) as ReturnType<typeof mockSignInWithPopup>,
      );

      const authPromise = svc.authenticateWithX();
      const caught = authPromise.catch((e: unknown) => e);
      jest.advanceTimersByTime(25000);
      const err = await caught;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/timed out/i);

      // Even if popup resolves later after timeout, user is signed out and signal stays null
      resolvePopup({
        user: {
          uid: 'uid_late',
          getIdToken: jest.fn(async () => 'late-token'),
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(mockSignOut).toHaveBeenCalled();
      expect(svc.currentUserSignal()).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
