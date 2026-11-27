interface OriginConstructorLike {
  from(value: string): {
    readonly opaque?: boolean;
    isSameOrigin(other: unknown): boolean;
  };
}

function readNativeOriginApi(): OriginConstructorLike | null {
  if (typeof globalThis !== 'object' || globalThis === null || !('Origin' in globalThis)) {
    return null;
  }
  const candidate = (globalThis as { Origin?: unknown }).Origin;
  if (typeof candidate === 'function' && 'from' in candidate) {
    return candidate as unknown as OriginConstructorLike;
  }
  return null;
}

/**
 * Verifies whether two URLs share an exact, non-opaque origin using `Origin.from()`
 * when available, falling back cleanly to `new URL()` origin comparison.
 */
export function isSameTrustedOrigin(candidateUrl: string, trustedOriginUrl: string): boolean {
  try {
    const originApi = readNativeOriginApi();
    if (originApi) {
      const candidateOrigin = originApi.from(candidateUrl);
      const trustedOrigin = originApi.from(trustedOriginUrl);
      if (candidateOrigin.opaque || trustedOrigin.opaque) {
        return false;
      }
      return candidateOrigin.isSameOrigin(trustedOrigin);
    }
    const parsedCandidate = new URL(candidateUrl);
    const parsedTrusted = new URL(trustedOriginUrl);
    return (
      parsedCandidate.origin !== 'null' &&
      parsedTrusted.origin !== 'null' &&
      parsedCandidate.origin === parsedTrusted.origin
    );
  } catch {
    return false;
  }
}
