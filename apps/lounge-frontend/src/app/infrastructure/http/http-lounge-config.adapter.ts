import { Injectable, inject } from '@angular/core';
import type {
  LoungeEmotionState,
  LoungeFirebaseWebConfig,
  LoungeLegalUrlsDto,
  LoungePersonaBranding,
  LoungeRuntimeConfigDto,
} from '@rebecca/types';
import { LoungeConfigPort } from '../../core/ports/lounge-config.port';
import { LoungeHttpClientHelper } from './lounge-http-client.helper';

function isValidEmotionAvatarMap(raw: unknown): raw is Record<LoungeEmotionState, string> {
  if (!raw || typeof raw !== 'object') {
    return false;
  }
  const obj = raw as Record<string, unknown>;
  const keys: readonly LoungeEmotionState[] = [
    'NEUTRAL',
    'HAPPY',
    'TEASING',
    'SHY',
    'EXCITED',
    'THOUGHTFUL',
    'SURPRISED',
  ];
  return keys.every((key) => typeof obj[key] === 'string' && obj[key].trim().length > 0);
}

function isValidPersonaBranding(raw: unknown): raw is LoungePersonaBranding {
  if (!raw || typeof raw !== 'object') {
    return false;
  }
  const obj = raw as Record<string, unknown>;
  return (
    typeof obj['displayName'] === 'string' &&
    obj['displayName'].trim().length > 0 &&
    typeof obj['englishName'] === 'string' &&
    obj['englishName'].trim().length > 0 &&
    typeof obj['brandName'] === 'string' &&
    obj['brandName'].trim().length > 0 &&
    typeof obj['avatarPath'] === 'string' &&
    obj['avatarPath'].trim().length > 0 &&
    typeof obj['chatIconPath'] === 'string' &&
    obj['chatIconPath'].trim().length > 0 &&
    isValidEmotionAvatarMap(obj['emotionAvatarPaths'])
  );
}

function isValidHttpUrlString(raw: unknown): raw is string {
  if (typeof raw !== 'string') {
    return false;
  }
  try {
    const parsed = new URL(raw.trim());
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function isValidLegalUrls(raw: unknown): raw is LoungeLegalUrlsDto {
  if (!raw || typeof raw !== 'object') {
    return false;
  }
  const obj = raw as Record<string, unknown>;
  return (
    isValidHttpUrlString(obj['tosUrl']) &&
    isValidHttpUrlString(obj['privacyUrl']) &&
    isValidHttpUrlString(obj['legalUrl'])
  );
}

function isValidFirebaseWebConfig(raw: unknown): raw is LoungeFirebaseWebConfig {
  if (!raw || typeof raw !== 'object') {
    return false;
  }
  const obj = raw as Record<string, unknown>;
  return (
    typeof obj['apiKey'] === 'string' &&
    obj['apiKey'].trim().length > 0 &&
    typeof obj['authDomain'] === 'string' &&
    obj['authDomain'].trim().length > 0 &&
    typeof obj['projectId'] === 'string' &&
    obj['projectId'].trim().length > 0 &&
    typeof obj['appId'] === 'string' &&
    obj['appId'].trim().length > 0
  );
}

/**
 * Thin HTTP adapter implementing `LoungeConfigPort` against `GET /api/v1/lounge/config`
 * with strict runtime schema validation and fail-fast error propagation.
 */
@Injectable({ providedIn: 'root' })
export class HttpLoungeConfigAdapter extends LoungeConfigPort {
  private readonly httpHelper = inject(LoungeHttpClientHelper);

  /** @inheritdoc */
  public async getRuntimeConfig(): Promise<LoungeRuntimeConfigDto> {
    const parsed = await this.httpHelper.get<Partial<LoungeRuntimeConfigDto>>('/config', {
      headers: { Accept: 'application/json' },
    });

    if (
      !parsed ||
      typeof parsed.appVersion !== 'string' ||
      parsed.appVersion.trim().length === 0 ||
      typeof parsed.disclaimerVersion !== 'number' ||
      !Number.isInteger(parsed.disclaimerVersion) ||
      parsed.disclaimerVersion < 1 ||
      !isValidPersonaBranding(parsed.persona)
    ) {
      throw new Error('Invalid runtime configuration received from /api/v1/lounge/config');
    }

    const liveConfig: LoungeRuntimeConfigDto = {
      appVersion: parsed.appVersion.trim(),
      disclaimerVersion: parsed.disclaimerVersion,
      persona: parsed.persona,
      ...(isValidLegalUrls(parsed.legalUrls) ? { legalUrls: parsed.legalUrls } : {}),
      ...(isValidFirebaseWebConfig(parsed.firebase) ? { firebase: parsed.firebase } : {}),
      ...(typeof parsed.useEmulators === 'boolean' ? { useEmulators: parsed.useEmulators } : {}),
      ...(typeof parsed.production === 'boolean' ? { production: parsed.production } : {}),
      ...(typeof parsed.phase2EeaEnabled === 'boolean'
        ? { phase2EeaEnabled: parsed.phase2EeaEnabled }
        : {}),
      ...(typeof parsed.billingEnabled === 'boolean'
        ? { billingEnabled: parsed.billingEnabled }
        : {}),
      ...(typeof parsed.contactEmail === 'string' || parsed.contactEmail === null
        ? { contactEmail: parsed.contactEmail }
        : {}),
    };
    this.httpHelper.setActiveDisclaimerVersion(liveConfig.disclaimerVersion);
    return liveConfig;
  }
}
