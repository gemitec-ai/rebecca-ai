import { Injectable, computed, inject, signal } from '@angular/core';
import type {
  LoungeBillingProductDto,
  LoungeLanguage,
  LoungeLegalUrlsDto,
  LoungePersonaBranding,
  LoungeProductId,
  LoungeSubscriptionStatus,
  LoungeSubscriptionTier,
} from '@rebecca/types';
import { environment } from '../../../environments/environment';
import { LoungeClientApiError } from '../errors/lounge-client.errors';
import {
  LOUNGE_TRANSLATIONS,
  detectInitialLoungeLanguage,
  detectInitialLoungeTimezone,
  formatLoungeCopy,
  type LoungeLocaleCopy,
} from '../i18n';
import { LoungeConfigPort } from '../ports/lounge-config.port';
import { LoungeAuthService } from '../services/lounge-auth.service';

/** Top-level UI views in the Private Lounge application. */
export type LoungeActiveView = 'AUTH' | 'ONBOARDING' | 'CHAT' | 'GALLERY' | 'BILLING' | 'OPTIONS';

function cloneInitialPersonaBranding(): LoungePersonaBranding {
  return {
    ...environment.persona,
    emotionAvatarPaths: { ...environment.persona.emotionAvatarPaths },
  };
}

/**
 * Shared application shell state managing runtime configuration, active route view,
 * localized UI dictionaries, sidebar visibility, and sanitized error-message mapping.
 */
@Injectable({ providedIn: 'root' })
export class LoungeShellStore {
  private readonly configPort = inject(LoungeConfigPort, { optional: true });
  private readonly authService = inject(LoungeAuthService);

  public readonly isProductionRuntime = signal<boolean>(environment.production);
  public readonly isBootstrapping = signal<boolean>(true);
  public readonly configLoadError = signal<string | null>(null);
  public readonly activeView = signal<LoungeActiveView>('AUTH');
  public readonly isSidebarOpen = signal<boolean>(false);
  public readonly lang = signal<LoungeLanguage>(detectInitialLoungeLanguage());
  public readonly timezone = signal<string>(detectInitialLoungeTimezone());
  public readonly appVersion = signal<string>(environment.appVersion);
  public readonly disclaimerVersion = signal<number>(environment.disclaimerVersion);
  public readonly phase2EeaEnabled = signal<boolean>(false);
  public readonly billingEnabled = signal<boolean>(true);
  public readonly contactEmail = signal<string | null>(null);
  public readonly legalUrls = signal<LoungeLegalUrlsDto | null>(null);
  public readonly isLoading = signal<boolean>(false);
  public readonly errorMessage = signal<string | null>(null);

  public readonly personaBranding = signal<LoungePersonaBranding>(cloneInitialPersonaBranding());

  public readonly personaDisplayName = computed(() => {
    const branding = this.personaBranding();
    return this.lang() === 'ja' ? branding.displayName : branding.englishName;
  });

  public readonly copy = computed<LoungeLocaleCopy>(() => LOUNGE_TRANSLATIONS[this.lang()]);

  constructor() {
    this.setDocumentLang(this.lang());
  }

  /** Fetches runtime configuration, configures Firebase Auth, and applies branding metadata. */
  public async loadRuntimeConfig(): Promise<void> {
    if (!this.configPort) {
      return;
    }
    const config = await this.configPort.getRuntimeConfig();
    this.appVersion.set(config.appVersion);
    this.disclaimerVersion.set(config.disclaimerVersion);
    this.applyPersonaBranding(config.persona);
    this.legalUrls.set(config.legalUrls ?? null);
    this.phase2EeaEnabled.set(config.phase2EeaEnabled === true);
    if (typeof config.billingEnabled === 'boolean') {
      this.billingEnabled.set(config.billingEnabled);
    }
    if (config.contactEmail !== undefined) {
      this.contactEmail.set(config.contactEmail);
    }
    if (typeof config.production === 'boolean') {
      this.isProductionRuntime.set(config.production);
    }
    this.authService.configure(config);
  }

  /** Updates pluggable persona branding signals and synchronizes `document.title`. */
  public applyPersonaBranding(branding: LoungePersonaBranding): void {
    this.personaBranding.set(branding);
    if (typeof document !== 'undefined') {
      document.title = branding.brandName;
    }
  }

  /** Synchronizes `<html lang>` cleanly when the active UI locale changes. */
  public setDocumentLang(nextLang: LoungeLanguage): void {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = nextLang;
    }
  }

  /** Interpolates `{name}` in localized copy templates using current active persona name. */
  public t(key: keyof LoungeLocaleCopy): string {
    return formatLoungeCopy(this.copy()[key], this.personaDisplayName());
  }

  /** Clears any visible error banner message. */
  public dismissError(): void {
    this.errorMessage.set(null);
  }

  /** Opens or closes the Slide-Over Sidebar triggered from the top-left hamburger icon. */
  public toggleSidebar(forceState?: boolean): void {
    this.isSidebarOpen.update((open) => (forceState !== undefined ? forceState : !open));
  }

  /** Returns localized title for any Lounge product or bonus grant identifier. */
  public getProductTitle(productId: LoungeProductId | 'UNKNOWN'): string {
    if (productId === 'TRIAL_TICKET_100') {
      return this.t('billingTrialTitle');
    }
    if (productId === 'CHARGE_TICKET_100') {
      return this.t('billingChargeTitle');
    }
    if (productId === 'STANDARD_MONTHLY') {
      return this.t('billingStandardTitle');
    }
    if (productId === 'WELCOME_BONUS_20') {
      return this.t('productWelcomeBonusTitle');
    }
    return this.t('productUnknownTitle');
  }

  /** Formats localized product price (`¥1,400/月` vs `¥500`). */
  public formatProductPrice(
    product: Pick<LoungeBillingProductDto, 'mode' | 'formattedPrice'>,
  ): string {
    return product.mode === 'subscription'
      ? `${product.formattedPrice}${this.t('billingStandardUnitSuffix')}`
      : product.formattedPrice;
  }

  /** Returns localized label for plan tier (`FREE` / `STANDARD`). */
  public getTierLabel(tier: LoungeSubscriptionTier): string {
    return tier === 'STANDARD' ? this.t('tierStandardLabel') : this.t('tierFreeLabel');
  }

  /** Returns localized label for Stripe subscription status (`ACTIVE`, `CANCELING`, etc.). */
  public getSubscriptionStatusLabel(status: LoungeSubscriptionStatus): string {
    switch (status) {
      case 'ACTIVE':
        return this.t('subStatusActiveLabel');
      case 'CANCELING':
        return this.t('subStatusCancelingLabel');
      case 'CANCELED':
        return this.t('subStatusCanceledLabel');
      case 'PAST_DUE':
        return this.t('subStatusPastDueLabel');
      case 'NONE':
        return this.t('subStatusNoneLabel');
    }
  }

  /** Maps backend API error codes and HTTP statuses cleanly into localized copy without leaking internals. */
  public mapUiError(err: unknown, fallbackKey: keyof LoungeLocaleCopy = 'errorGeneric'): string {
    const code =
      err instanceof LoungeClientApiError
        ? err.code
        : typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code?: unknown }).code)
          : undefined;
    switch (code) {
      case 'GEO_BLOCKED':
        return this.t('geoBlockedError');
      case 'GEO_UNAVAILABLE':
        return this.t('geoUnavailableError');
      case 'DISPUTE_BLOCKED':
        return this.t('billingDisputeBlockedNotice');
      case 'QUOTA_EXHAUSTED':
        return this.t('quotaExhaustedBanner');
      case 'COMING_SOON':
        return this.t('errorBillingComingSoon');
      case 'TRIAL_ALREADY_USED':
        return this.t('errorTrialAlreadyUsed');
      case 'SUBSCRIPTION_ALREADY_ACTIVE':
        return this.t('errorSubscriptionAlreadyActive');
      case 'EU_WITHDRAWAL_UNAVAILABLE':
        return this.t('errorEuWithdrawalUnavailable');
      case 'STRIPE_CANCELLATION_FAILED':
        return this.t('deleteModalStripeErrorBanner');
      case 'UNTRUSTED_REDIRECT_URL':
        return this.t('errorUntrustedRedirectUrl');
      default:
        break;
    }
    if (err instanceof LoungeClientApiError) {
      if (err.statusCode === 0) {
        return this.t('errorNetwork');
      }
      if (err.statusCode === 401) {
        return this.t('errorUnauthorized');
      }
      if (err.statusCode === 403) {
        return this.t('errorForbidden');
      }
      if (err.statusCode === 409) {
        return this.t('errorAccountConflict');
      }
      if (err.statusCode === 429) {
        return this.t('errorRateLimited');
      }
    }
    return this.t(fallbackKey);
  }
}
