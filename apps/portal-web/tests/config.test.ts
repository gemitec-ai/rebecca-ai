import {
  activePortalConfig,
  generateThemeCssVariables,
} from '../src/config';
import { formatObfuscatedSupportEmail } from '../src/utils/contactEmail';
import { PortalBrandConfig } from '@rebecca/types';

describe('Portal Brand Configuration', () => {
  it('should expose a valid active portal configuration', () => {
    expect(activePortalConfig.characterId).toBe('rebecca');
    expect(activePortalConfig.displayName).toBe('全肯定AIレベッカ');
    expect(activePortalConfig.englishName).toBe('Rebecca AI');
    expect(activePortalConfig.theme.primary).toBe('#ff2a85');
    expect(activePortalConfig.organizationName).toBe('Gemitec');
    expect(activePortalConfig.social.xUrl).toContain('x.com');
    expect(activePortalConfig.assets.cutoutImage).toBeTruthy();
    expect(activePortalConfig.support.enabled).toBe(true);
  });

  it('should format obfuscated support email without synthesizing fake fallback addresses', () => {
    expect(formatObfuscatedSupportEmail('support@example.org')).toBe('support [at mark] example.org');
    expect(formatObfuscatedSupportEmail('')).toBe('');
    expect(formatObfuscatedSupportEmail(undefined)).toBe('');
    expect(formatObfuscatedSupportEmail(null)).toBe('');
    expect(() =>
      formatObfuscatedSupportEmail('contact@example.com', { rejectPlaceholderDomains: true }),
    ).toThrow(/Refusing synthetic placeholder SUPPORT_CONTACT_EMAIL/);
  });

  it('should generate valid CSS custom properties from brand config', () => {
    const mockConfig: PortalBrandConfig = {
      ...activePortalConfig,
      theme: {
        primary: '#123456',
        primaryLight: '#abcdef',
        primaryGlow: 'rgba(0,0,0,0.5)',
        secondary: '#654321',
        accent: '#fedcba',
        background: '#000000',
        backgroundCard: '#111111',
        textPrimary: '#ffffff',
        textSecondary: '#888888',
      },
    };

    const css = generateThemeCssVariables(mockConfig);
    expect(css).toContain('--color-primary: #123456;');
    expect(css).toContain('--color-secondary: #654321;');
    expect(css).toContain('--color-bg: #000000;');
  });
});
