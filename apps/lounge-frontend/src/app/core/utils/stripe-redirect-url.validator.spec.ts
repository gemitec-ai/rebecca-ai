import { isAllowedStripeRedirectUrl } from './stripe-redirect-url.validator';

describe('isAllowedStripeRedirectUrl', () => {
  const originalOriginApi = (globalThis as { Origin?: unknown }).Origin;

  afterEach(() => {
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

  it('permits official HTTPS Stripe checkout, portal, and receipt origins', () => {
    expect(isAllowedStripeRedirectUrl('https://checkout.stripe.com/c/pay/cs_test_123')).toBe(true);
    expect(isAllowedStripeRedirectUrl('https://billing.stripe.com/p/session/test_456')).toBe(true);
    expect(isAllowedStripeRedirectUrl('https://pay.stripe.com/receipts/payment/ch_123')).toBe(true);
    expect(isAllowedStripeRedirectUrl('https://invoice.stripe.com/i/acct_1')).toBe(true);
    expect(isAllowedStripeRedirectUrl('https://receipt.stripe.com/r/1')).toBe(true);
  });

  it('rejects empty, malformed, non-HTTPS, opaque, or lookalike hostnames', () => {
    expect(isAllowedStripeRedirectUrl('')).toBe(false);
    expect(isAllowedStripeRedirectUrl('   ')).toBe(false);
    expect(isAllowedStripeRedirectUrl('not-a-valid-url')).toBe(false);
    expect(isAllowedStripeRedirectUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedStripeRedirectUrl('data:text/html,<script>1</script>')).toBe(false);
    expect(isAllowedStripeRedirectUrl('http://checkout.stripe.com/c/pay/cs_1')).toBe(false);
    expect(isAllowedStripeRedirectUrl('https://checkout.stripe.com.attacker.example/pay')).toBe(false);
    expect(isAllowedStripeRedirectUrl('https://evil.example/checkout.stripe.com')).toBe(false);
  });

  it('supports native Origin.from() checks when globalThis.Origin is present and rejects opaque or failing origins', () => {
    const mockOrigin = function MockOrigin(): void {
      // Intentional constructor-shaped mock matching globalThis.Origin
    } as unknown as {
      from: (value: string) => { opaque: boolean; isSameOrigin: (other: { origin: string }) => boolean; origin: string };
    };
    mockOrigin.from = (value: string) => {
      if (value.includes('throws')) {
        throw new Error('Invalid origin');
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

    expect(isAllowedStripeRedirectUrl('https://checkout.stripe.com/c/pay/cs_1')).toBe(true);
    expect(isAllowedStripeRedirectUrl('https://checkout.stripe.com/opaque')).toBe(false);
    expect(isAllowedStripeRedirectUrl('https://checkout.stripe.com/throws')).toBe(false);
  });

  it('permits loopback redirect URLs strictly when allowLocalOrigin is true', () => {
    expect(isAllowedStripeRedirectUrl('http://127.0.0.1:4300/?checkout=success', false)).toBe(
      false,
    );
    expect(isAllowedStripeRedirectUrl('http://127.0.0.1:4300/?checkout=success', true)).toBe(true);
    expect(isAllowedStripeRedirectUrl('http://localhost:4300/?portal_return=1', true)).toBe(true);
    expect(isAllowedStripeRedirectUrl('http://attacker.example/?checkout=success', true)).toBe(
      false,
    );
  });
});
