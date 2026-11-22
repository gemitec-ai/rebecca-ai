import type { LoungeRuntimeConfigDto } from '@rebecca/types';

/**
 * Hexagonal port resolving runtime application version, disclaimer version, and
 * pluggable AI persona branding without hardcoding character traits in Angular code.
 */
export abstract class LoungeConfigPort {
  /** Fetches runtime version and active persona branding metadata from `/api/v1/lounge/config`. */
  public abstract getRuntimeConfig(): Promise<LoungeRuntimeConfigDto>;
}
