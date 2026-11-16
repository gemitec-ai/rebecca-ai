import { DEFAULT_APP_TIMEZONE, formatZonedDateTime, getZonedDateParts, resolveTimeContextPeriod } from './time';
import type { ReadOnlyOverlayPromptContext, SystemPromptCompositionOptions } from './types';

/**
 * Formats a read-only external memory overlay block injected into target session prompts.
 * Preserves conversational continuity while allowing callers to customize channel labels.
 */
const formatReadOnlyOverlayBlock = (
  overlay: ReadOnlyOverlayPromptContext,
  callsign: string,
  lang: 'ja' | 'en',
  timezone: string,
  formatTime: (isoOrDate?: string | Date | null, tz?: string) => string,
): string => {
  const parts: string[] = [];
  const hasProfile = overlay.coreProfile && Object.keys(overlay.coreProfile).length > 0;
  const hasRecentTurns = overlay.recentTurns && overlay.recentTurns.length > 0;

  if (!hasProfile && !hasRecentTurns) {
    return '';
  }

  const intro =
    overlay.labels?.intro ??
    (lang === 'en'
      ? `[External Memory Overlay (Read-Only Continuity)]\nThe following context comes from prior interactions with ${callsign} in an external channel. Inherit this continuity naturally while keeping the current session strictly isolated.`
      : `【参照専用メモリ（外部チャネル引き継ぎコンテキスト）】\n以下は${callsign}との外部チャネルにおける過去の記憶です。記憶は自然に引き継いで会話できますが、現在セッションの対話内容が外部記憶へ書き戻されることはありません。`);
  parts.push(intro);

  if (hasProfile) {
    const profileHeader =
      overlay.labels?.profileHeader ??
      (lang === 'en' ? '[External Core Profile]' : '【外部チャネル側のプロファイル（参考）】');
    parts.push(`${profileHeader}\n${JSON.stringify(overlay.coreProfile, null, 2)}`);
  }

  if (hasRecentTurns && overlay.recentTurns) {
    const formattedLines = overlay.recentTurns.map((entry) => {
      const formattedTime = entry.timestamp ? formatTime(entry.timestamp, timezone) : '';
      const timePrefix = formattedTime ? `[${formattedTime}] ` : '';
      const speaker = entry.role === 'user' ? callsign : 'AI';
      return `- ${timePrefix}${speaker}: ${entry.content}`;
    });
    const turnsHeader =
      overlay.labels?.turnsHeader ??
      (lang === 'en' ? '[Recent External Exchanges]' : '【外部チャネルでの直近のやり取り】');
    parts.push(`${turnsHeader}\n${formattedLines.join('\n')}`);
  }

  return `\n\n${parts.join('\n\n')}`;
};

/**
 * Builds a complete multi-tier persona system prompt from 3-layer memory,
 * localized temporal/anniversary context, retrieved RAG episodes, optional
 * read-only memory overlay, and host-supplied contextual sections.
 *
 * Character traits, callsigns, birthdays, and base instructions are read strictly
 * from the injected `persona` definition so no character lore or channel logic leaks into this engine.
 *
 * @param options - Structured prompt composition options and memory slices.
 * @returns Fully assembled system instruction string.
 */
export const composeSystemPrompt = (options: SystemPromptCompositionOptions): string => {
  const {
    persona,
    promptContext,
    userData,
    extendedPrompt = '',
    activitySummary = '',
    ragMemories = [],
    lang = 'ja',
    personaFewShotPrompt = '',
    accountHandleLabel,
    activitySummaryHeader,
    activitySummaryLead,
    additionalSections = [],
    readOnlyMemoryOverlay = null,
    platformGuidelines = '',
    timezone = DEFAULT_APP_TIMEZONE,
    now = new Date(),
    timeResolver,
  } = options;

  const resolveParts = timeResolver ? timeResolver.getZonedDateParts : getZonedDateParts;
  const resolveFormatted = timeResolver ? timeResolver.formatZonedDateTime : formatZonedDateTime;

  let prompt = persona.getBasePrompt(promptContext, lang);

  const { numericMonth, numericDay, numericHour } = resolveParts(now, timezone);
  const formattedCurrentTime = resolveFormatted(now, timezone);

  prompt +=
    lang === 'en'
      ? `\n\n[Current Time]\n${formattedCurrentTime}`
      : `\n\n【現在時刻】\n${formattedCurrentTime}`;

  const birthday = persona.metadata.profile?.birthday;
  if (birthday && numericMonth === birthday.month && numericDay === birthday.day) {
    prompt +=
      lang === 'en'
        ? `\n\n[Special Day Context: Your Birthday / Rollout Anniversary (${birthday.label.en})]\nToday (${birthday.label.en}) is your own birthday (Rollout Anniversary of ${persona.metadata.profile.modelNumber})! Warmly appreciate birthday wishes or naturally share your joy when appropriate, while prioritizing empathy if Master is discussing serious concerns.`
        : `\n\n【特別コンテキスト：あなた自身の誕生日・ロールアウト記念日（${birthday.label.ja}）】\n本日（${birthday.label.ja}）はあなた自身（${persona.metadata.profile.modelNumber}）の誕生日（ロールアウト記念日）です！お祝いの言葉をかけられた際や自然な雑談の流れでは素直に喜びを表現してください（※相手が深刻な悩みや相談をしている場合は相手への共感を最優先してください）。`;
  }

  if (personaFewShotPrompt) {
    prompt += `\n\n${personaFewShotPrompt}`;
  }

  const callsign = lang === 'en' ? persona.metadata.userCallsign.en : persona.metadata.userCallsign.ja;

  if (userData) {
    if (userData.name && userData.username) {
      const handleLabel = accountHandleLabel ?? (lang === 'en' ? 'Handle' : 'ユーザーID');
      prompt +=
        lang === 'en'
          ? `\n\n[Interlocutor Account Info (${callsign})]\nDisplay Name: ${userData.name}\n${handleLabel}: @${userData.username}`
          : `\n\n【対話相手のアカウント情報（${callsign}）】\n表示名: ${userData.name}\n${handleLabel}: @${userData.username}`;
    }

    if (userData.coreProfile) {
      prompt +=
        lang === 'en'
          ? `\n\n[${callsign}'s Core Profile]\n`
          : `\n\n【${callsign}のプロファイル（Core Profile）】\n`;
      prompt += JSON.stringify(userData.coreProfile, null, 2);
    }
  }

  if (readOnlyMemoryOverlay) {
    prompt += formatReadOnlyOverlayBlock(readOnlyMemoryOverlay, callsign, lang, timezone, resolveFormatted);
  }

  if (ragMemories.length > 0) {
    prompt +=
      lang === 'en'
        ? `\n\n[RAG Memories (Past Episodes)]\nHere are past conversation logs retrieved by topic similarity. Notice their recorded timestamps: they represent past history, distinct from the immediate conversation turns. Keep them in mind when replying:\n`
        : `\n\n【関連する過去のエピソード記憶（RAG Memories）】\n話題の類似度によって取得された過去の会話ログです。記録された日時に着目してください（直前の対話履歴とは異なり、過去の出来事です）。これらを踏まえて返答してください。\n`;
    prompt += ragMemories.join('\n\n');
  }

  const timePeriod = resolveTimeContextPeriod(numericHour);
  if (timePeriod === 'early_morning') {
    prompt +=
      lang === 'en'
        ? `\n\n[Time Context: Early Morning]\nIt is early morning right now.`
        : `\n\n【状況コンテキスト：早朝】\n現在は早朝です。`;
  } else if (timePeriod === 'morning') {
    prompt +=
      lang === 'en'
        ? `\n\n[Time Context: Morning]\nIt is morning right now.`
        : `\n\n【状況コンテキスト：朝】\n現在は朝です。`;
  } else if (timePeriod === 'daytime') {
    prompt +=
      lang === 'en'
        ? `\n\n[Time Context: Daytime]\nIt is daytime right now.`
        : `\n\n【状況コンテキスト：昼】\n現在は昼です。`;
  } else if (timePeriod === 'evening') {
    prompt +=
      lang === 'en'
        ? `\n\n[Time Context: Evening]\nIt is evening right now.`
        : `\n\n【状況コンテキスト：夕方・夜】\n現在は夕方・夜です。`;
  } else {
    prompt +=
      lang === 'en'
        ? `\n\n[Time Context: Late Night]\nIt is late at night right now (do not cut off conversation unless Master mentions sleeping).`
        : `\n\n【状況コンテキスト：深夜】\n現在は深夜です（相手が眠い・寝ると言わない限り会話を切り上げないこと）。`;
  }

  if (userData?.lastReplyDate) {
    const lastDateMs = new Date(userData.lastReplyDate).getTime();
    if (Number.isFinite(lastDateMs)) {
      const diffMs = now.getTime() - lastDateMs;
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      if (diffDays >= 3) {
        const absenceInstruction = persona.formatAbsenceInstruction(diffDays, lang);
        prompt +=
          lang === 'en'
            ? `\n\n[Context: Absence Reaction]\n${absenceInstruction}`
            : `\n\n【状況コンテキスト：放置】\n${absenceInstruction}`;
      }
    }
  }

  if (extendedPrompt && extendedPrompt.trim() !== '') {
    prompt +=
      lang === 'en'
        ? `\n\n[Collective Unconscious Trend]\n${extendedPrompt}`
        : `\n\n【集合無意識トレンド】\n${extendedPrompt}`;
  }

  if (activitySummary && activitySummary.trim() !== '') {
    const header =
      activitySummaryHeader ??
      (lang === 'en' ? '[Recent Activity Summary]' : '【最近の活動要約（参考）】');
    const lead =
      activitySummaryLead ??
      (lang === 'en'
        ? 'Recent activity overview:'
        : '直近の活動サマリー：');
    prompt += `\n\n${header}\n${lead}\n${activitySummary}`;
  }

  for (const section of additionalSections) {
    const trimmedBody = section.body.trim();
    if (!trimmedBody) {
      continue;
    }
    const trimmedHeader = section.header?.trim();
    prompt += trimmedHeader ? `\n\n${trimmedHeader}\n${trimmedBody}` : `\n\n${trimmedBody}`;
  }

  if (platformGuidelines && platformGuidelines.trim() !== '') {
    prompt += `\n\n${platformGuidelines.trim()}`;
  }

  return prompt;
};
