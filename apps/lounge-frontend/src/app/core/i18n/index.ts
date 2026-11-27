import type { LoungeLanguage } from '@rebecca/types';
import type { LoungeLocaleCopy } from './lounge-i18n.types';
import { LOUNGE_COPY_DE } from './dictionaries/de';
import { LOUNGE_COPY_EN } from './dictionaries/en';
import { LOUNGE_COPY_ES } from './dictionaries/es';
import { LOUNGE_COPY_JA } from './dictionaries/ja';
import { LOUNGE_COPY_PT } from './dictionaries/pt';
import { LOUNGE_COPY_TH } from './dictionaries/th';
import { LOUNGE_COPY_VI } from './dictionaries/vi';
import { LOUNGE_COPY_ZH_HK } from './dictionaries/zh-hk';

export type { LoungeLocaleCopy, LoungeSelectOption } from './lounge-i18n.types';
export {
  LOUNGE_LANGUAGE_OPTIONS,
  LOUNGE_TIMEZONE_OPTIONS,
  buildLoungeTimezoneOptions,
  detectInitialLoungeLanguage,
  detectInitialLoungeTimezone,
  formatLoungeCopy,
} from './lounge-locale.util';

/**
 * Full 8-language dictionary covering UI controls, legal disclaimers, options, and error messages.
 */
export const LOUNGE_TRANSLATIONS: Record<LoungeLanguage, LoungeLocaleCopy> = {
  ja: LOUNGE_COPY_JA,
  en: LOUNGE_COPY_EN,
  de: LOUNGE_COPY_DE,
  pt: LOUNGE_COPY_PT,
  es: LOUNGE_COPY_ES,
  'zh-HK': LOUNGE_COPY_ZH_HK,
  vi: LOUNGE_COPY_VI,
  th: LOUNGE_COPY_TH,
};
