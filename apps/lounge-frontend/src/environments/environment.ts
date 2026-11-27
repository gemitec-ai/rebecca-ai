import type { LoungeEmotionState } from '@rebecca/types';
import type { LoungeEnvironment } from './environment.model';

const DEFAULT_EMOTION_AVATARS: Record<LoungeEmotionState, string> = {
  NEUTRAL: 'assets/avatars/persona_neutral.png',
  HAPPY: 'assets/avatars/persona_happy.png',
  TEASING: 'assets/avatars/persona_teasing.png',
  SHY: 'assets/avatars/persona_shy.png',
  EXCITED: 'assets/avatars/persona_excited.png',
  THOUGHTFUL: 'assets/avatars/persona_thoughtful.png',
  SURPRISED: 'assets/avatars/persona_surprised.png',
};

export const environment: LoungeEnvironment = {
  production: false,
  apiBaseUrl: '/api/v1/lounge',
  appVersion: 'v1.45.2',
  disclaimerVersion: 1,
  persona: {
    displayName: 'AIコンパニオン',
    englishName: 'AI Companion',
    brandName: 'Private Lounge',
    avatarPath: 'assets/persona_cutout.webp',
    chatIconPath: 'assets/avatars/persona_icon.png',
    emotionAvatarPaths: DEFAULT_EMOTION_AVATARS,
  },
};
