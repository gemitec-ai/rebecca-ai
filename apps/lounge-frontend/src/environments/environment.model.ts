import type { LoungePersonaBranding } from '@rebecca/types';

/**
 * Environment configuration contract for the Gemitec Private Lounge SPA.
 */
export interface LoungeEnvironment {
  readonly production: boolean;
  readonly apiBaseUrl: string;
  readonly appVersion: string;
  readonly disclaimerVersion: string;
  readonly persona: LoungePersonaBranding;
}
