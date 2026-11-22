import { ApplicationConfig, provideZonelessChangeDetection } from '@angular/core';
import { LoungeBffAdapter } from './core/adapters/lounge-bff.adapter';
import { LoungeAccountPort } from './core/ports/lounge-account.port';
import { LoungeAuthPort } from './core/ports/lounge-auth.port';
import { LoungeConfigPort } from './core/ports/lounge-config.port';
import { LoungeRewardPort } from './core/ports/lounge-reward.port';
import { LoungeSessionPort } from './core/ports/lounge-session.port';

/**
 * Angular 22 Zoneless configuration binding Hexagonal Private Lounge ports to `LoungeBffAdapter`.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    LoungeBffAdapter,
    { provide: LoungeConfigPort, useExisting: LoungeBffAdapter },
    { provide: LoungeAuthPort, useExisting: LoungeBffAdapter },
    { provide: LoungeAccountPort, useExisting: LoungeBffAdapter },
    { provide: LoungeSessionPort, useExisting: LoungeBffAdapter },
    { provide: LoungeRewardPort, useExisting: LoungeBffAdapter },
  ],
};
