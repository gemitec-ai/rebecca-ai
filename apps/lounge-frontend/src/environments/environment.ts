import type { LoungeEnvironment } from './environment.model';

export const environment: LoungeEnvironment = {
  production: false,
  apiBaseUrl: '/api/v1/lounge',
  appVersion: 'v1.45.2',
  disclaimerVersion: '2026-11-22',
  persona: {
    displayName: 'AIコンパニオン',
    englishName: 'AI Companion',
    brandName: 'Gemitec Lounge',
    avatarPath: 'assets/persona_cutout.webp',
  },
};
