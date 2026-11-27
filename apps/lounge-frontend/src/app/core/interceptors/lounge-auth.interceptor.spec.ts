import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { LoungeAuthService } from '../services/lounge-auth.service';
import {
  isTrustedLoungeApiDestination,
  loungeAuthInterceptor,
} from './lounge-auth.interceptor';

describe('loungeAuthInterceptor & isTrustedLoungeApiDestination', () => {
  const originalOriginApi = (globalThis as { Origin?: unknown }).Origin;

  afterEach(() => {
    TestBed.resetTestingModule();
    if (originalOriginApi === undefined) {
      delete (globalThis as { Origin?: unknown }).Origin;
    } else {
      Object.defineProperty(globalThis, 'Origin', {
        value: originalOriginApi,
        configurable: true,
        writable: true,
      });
    }
  });

  it('trusts only /api/v1/lounge paths on the verified origin and rejects non-BFF or external URLs', () => {
    expect(
      isTrustedLoungeApiDestination('/api/v1/lounge/account', {
        windowOrigin: 'https://lounge.example.com',
        apiBaseUrl: '/api/v1/lounge',
      }),
    ).toBe(true);
    expect(
      isTrustedLoungeApiDestination('/api/v1/lounge', {
        windowOrigin: 'https://lounge.example.com',
        apiBaseUrl: '/api/v1/lounge',
      }),
    ).toBe(true);
    expect(
      isTrustedLoungeApiDestination('https://lounge.example.com/api/v1/lounge/session', {
        windowOrigin: 'https://lounge.example.com',
        apiBaseUrl: '/api/v1/lounge',
      }),
    ).toBe(true);

    // Reject same-origin non-BFF assets/portal routes and protocol-relative or external destinations
    expect(
      isTrustedLoungeApiDestination('/assets/persona_cutout.webp', {
        windowOrigin: 'https://lounge.example.com',
        apiBaseUrl: '/api/v1/lounge',
      }),
    ).toBe(false);
    expect(
      isTrustedLoungeApiDestination('/api/v1/dashboard/stats', {
        windowOrigin: 'https://lounge.example.com',
        apiBaseUrl: '/api/v1/lounge',
      }),
    ).toBe(false);
    expect(
      isTrustedLoungeApiDestination('//evil.example/api/v1/lounge/account', {
        windowOrigin: 'https://lounge.example.com',
        apiBaseUrl: '/api/v1/lounge',
      }),
    ).toBe(false);
    expect(
      isTrustedLoungeApiDestination('https://evil.example/api/v1/lounge/account', {
        windowOrigin: 'https://lounge.example.com',
        apiBaseUrl: '/api/v1/lounge',
      }),
    ).toBe(false);
    expect(
      isTrustedLoungeApiDestination('javascript:alert(1)', {
        windowOrigin: 'https://lounge.example.com',
        apiBaseUrl: '/api/v1/lounge',
      }),
    ).toBe(false);
  });

  it('fails closed when no non-opaque origin is available (no hardcoded loopback fallback)', () => {
    expect(
      isTrustedLoungeApiDestination('/api/v1/lounge/account', {
        windowOrigin: '',
        apiBaseUrl: '/api/v1/lounge',
      }),
    ).toBe(false);
    expect(
      isTrustedLoungeApiDestination('/api/v1/lounge/account', {
        windowOrigin: 'null',
        apiBaseUrl: '/api/v1/lounge',
      }),
    ).toBe(false);
    expect(
      isTrustedLoungeApiDestination('/api/v1/lounge/account', {
        windowOrigin: 'https://lounge.example.com',
        apiBaseUrl: 'https://bff.example.com/api/v1/lounge',
      }),
    ).toBe(false);
    expect(
      isTrustedLoungeApiDestination('https://bff.example.com/api/v1/lounge/account', {
        windowOrigin: 'https://lounge.example.com',
        apiBaseUrl: 'https://bff.example.com/api/v1/lounge',
      }),
    ).toBe(true);
    // Trailing slash on absolute URL or blank relative base normalizes without || fallbacks
    expect(
      isTrustedLoungeApiDestination('https://bff.example.com/api/v1/lounge/account', {
        windowOrigin: 'https://lounge.example.com',
        apiBaseUrl: 'https://bff.example.com/',
      }),
    ).toBe(true);
    expect(
      isTrustedLoungeApiDestination('/api/v1/lounge/account', {
        windowOrigin: 'https://lounge.example.com',
        apiBaseUrl: '   ',
      }),
    ).toBe(true);
    // Malformed absolute apiBaseUrl fails closed without falling back to windowOrigin
    expect(
      isTrustedLoungeApiDestination('https://lounge.example.com/api/v1/lounge/account', {
        windowOrigin: 'https://lounge.example.com',
        apiBaseUrl: 'https://[invalid-host/api/v1/lounge',
      }),
    ).toBe(false);
    expect(
      isTrustedLoungeApiDestination('https://lounge.example.com/api/v1/lounge/account', {
        windowOrigin: 'https://lounge.example.com',
        apiBaseUrl: 'http://opaque.invalid/api/v1/lounge',
      }),
    ).toBe(false);
  });

  it('evaluates native Origin.from() safely when available and handles opaque or invalid origin strings', () => {
    const mockOrigin = function MockOrigin(): void {
      // Intentional constructor-shaped mock matching globalThis.Origin
    } as unknown as {
      from: (value: string) => { opaque: boolean; isSameOrigin: (other: { origin: string }) => boolean; origin: string };
    };
    mockOrigin.from = (value: string) => {
      if (value.includes('broken')) {
        throw new Error('Malformed origin');
      }
      const parsed = new URL(value);
      return {
        opaque: value.includes('opaque'),
        isSameOrigin: (other: { origin: string }) => parsed.origin === other.origin,
        origin: parsed.origin,
      };
    };

    Object.defineProperty(globalThis, 'Origin', {
      value: mockOrigin,
      configurable: true,
      writable: true,
    });

    expect(
      isTrustedLoungeApiDestination('https://lounge.example.com/api/v1/lounge/account', {
        windowOrigin: 'https://lounge.example.com',
        apiBaseUrl: '/api/v1/lounge',
      }),
    ).toBe(true);
    expect(
      isTrustedLoungeApiDestination('https://lounge.example.com/api/v1/lounge/account?opaque=1', {
        windowOrigin: 'https://lounge.example.com',
        apiBaseUrl: '/api/v1/lounge',
      }),
    ).toBe(false);
    expect(
      isTrustedLoungeApiDestination('https://lounge.example.com/api/v1/lounge/account?broken=1', {
        windowOrigin: 'https://lounge.example.com',
        apiBaseUrl: '/api/v1/lounge',
      }),
    ).toBe(false);

    // Opaque parsed URL.origin === 'null' in mocked globalThis.Origin fails closed when resolving apiBaseUrl
    const opaqueBaseUrl = 'https://opaque.example/api/v1/lounge';
    expect(
      isTrustedLoungeApiDestination('https://lounge.example.com/api/v1/lounge/account', {
        windowOrigin: 'https://lounge.example.com',
        apiBaseUrl: opaqueBaseUrl,
      }),
    ).toBe(false);
  });

  it('attaches Firebase ID Bearer tokens via async getToken() only on trusted Lounge API requests', async () => {
    const authStub = {
      currentUserSignal: jest.fn(() => ({ uid: 'uid_async' }) as unknown),
      getToken: jest.fn<Promise<string | null>, []>(async () => 'async-token-456'),
    };

    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withInterceptors([loungeAuthInterceptor])),
        provideHttpClientTesting(),
        { provide: LoungeAuthService, useValue: authStub },
      ],
    }).compileComponents();

    const http = TestBed.inject(HttpClient);
    const httpTesting = TestBed.inject(HttpTestingController);

    // Trusted BFF path attaches Bearer token from async getToken()
    const req1 = firstValueFrom(http.get('/api/v1/lounge/account'));
    await Promise.resolve();
    const match1 = httpTesting.expectOne('/api/v1/lounge/account');
    expect(match1.request.headers.get('Authorization')).toBe('Bearer async-token-456');
    match1.flush({});
    await req1;

    // External URL must never receive Authorization header
    const reqExt = firstValueFrom(http.get('https://external.example.com/api/v1/lounge/account'));
    const matchExt = httpTesting.expectOne('https://external.example.com/api/v1/lounge/account');
    expect(matchExt.request.headers.has('Authorization')).toBe(false);
    matchExt.flush({});
    await reqExt;

    // Null async token leaves request unauthenticated cleanly
    authStub.getToken.mockResolvedValueOnce(null);
    const req3 = firstValueFrom(http.get('/api/v1/lounge/gallery'));
    await Promise.resolve();
    const match3 = httpTesting.expectOne('/api/v1/lounge/gallery');
    expect(match3.request.headers.has('Authorization')).toBe(false);
    match3.flush({});
    await req3;

    // Null currentUser skips async getToken lookup cleanly
    authStub.currentUserSignal.mockReturnValue(null);
    const req4 = firstValueFrom(http.get('/api/v1/lounge/config'));
    const match4 = httpTesting.expectOne('/api/v1/lounge/config');
    expect(match4.request.headers.has('Authorization')).toBe(false);
    match4.flush({});
    await req4;

    httpTesting.verify();
  });
});
