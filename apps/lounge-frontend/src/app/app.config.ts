import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { ApplicationConfig, provideZonelessChangeDetection } from '@angular/core';
import { loungeAuthInterceptor } from './core/interceptors/lounge-auth.interceptor';
import { LoungeAccountPort } from './core/ports/lounge-account.port';
import { LoungeAuthPort } from './core/ports/lounge-auth.port';
import { LoungeBillingPort } from './core/ports/lounge-billing.port';
import { LoungeConfigPort } from './core/ports/lounge-config.port';
import { LoungeGalleryPort } from './core/ports/lounge-gallery.port';
import { LoungeSessionPort } from './core/ports/lounge-session.port';
import { HttpLoungeAccountAdapter } from './infrastructure/http/http-lounge-account.adapter';
import { HttpLoungeAuthAdapter } from './infrastructure/http/http-lounge-auth.adapter';
import { HttpLoungeBillingAdapter } from './infrastructure/http/http-lounge-billing.adapter';
import { HttpLoungeConfigAdapter } from './infrastructure/http/http-lounge-config.adapter';
import { HttpLoungeGalleryAdapter } from './infrastructure/http/http-lounge-gallery.adapter';
import { HttpLoungeSessionAdapter } from './infrastructure/http/http-lounge-session.adapter';

/**
 * Angular 22 Zoneless configuration binding each Hexagonal Private Lounge port to its dedicated thin HTTP adapter.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideHttpClient(withInterceptors([loungeAuthInterceptor])),
    { provide: LoungeConfigPort, useExisting: HttpLoungeConfigAdapter },
    { provide: LoungeAuthPort, useExisting: HttpLoungeAuthAdapter },
    { provide: LoungeAccountPort, useExisting: HttpLoungeAccountAdapter },
    { provide: LoungeBillingPort, useExisting: HttpLoungeBillingAdapter },
    { provide: LoungeSessionPort, useExisting: HttpLoungeSessionAdapter },
    { provide: LoungeGalleryPort, useExisting: HttpLoungeGalleryAdapter },
  ],
};
