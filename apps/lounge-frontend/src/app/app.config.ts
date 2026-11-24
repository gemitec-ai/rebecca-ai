import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { ApplicationConfig, provideZonelessChangeDetection } from '@angular/core';
import { LoungeBffAdapter } from './core/adapters/lounge-bff.adapter';
import { loungeAuthInterceptor } from './core/interceptors/lounge-auth.interceptor';
import { LoungeAccountPort } from './core/ports/lounge-account.port';
import { LoungeAuthPort } from './core/ports/lounge-auth.port';
import { LoungeBillingPort } from './core/ports/lounge-billing.port';
import { LoungeConfigPort } from './core/ports/lounge-config.port';
import { LoungeGalleryPort } from './core/ports/lounge-gallery.port';
import { LoungeSessionPort } from './core/ports/lounge-session.port';

/**
 * Angular 22 Zoneless configuration binding Hexagonal Private Lounge ports to `LoungeBffAdapter`.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideHttpClient(withInterceptors([loungeAuthInterceptor])),
    LoungeBffAdapter,
    { provide: LoungeConfigPort, useExisting: LoungeBffAdapter },
    { provide: LoungeAuthPort, useExisting: LoungeBffAdapter },
    { provide: LoungeAccountPort, useExisting: LoungeBffAdapter },
    { provide: LoungeBillingPort, useExisting: LoungeBffAdapter },
    { provide: LoungeSessionPort, useExisting: LoungeBffAdapter },
    { provide: LoungeGalleryPort, useExisting: LoungeBffAdapter },
  ],
};
