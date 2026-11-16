import { DEFAULT_APP_TIMEZONE, formatZonedDateTime, getZonedDateParts, resolveTimeContextPeriod } from './time';
import type { PublicMemoryOverlayContext, SystemPromptCompositionOptions } from './types';

/**
 * Formats the read-only public X overlay block injected into Private Lounge prompts.
 * Preserves conversational continuity while forbidding reverse leakage back to public posts.
 */
const formatPublicOverlayBlock = (
  overlay: PublicMemoryOverlayContext,
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

  parts.push(
    lang === 'en'
      ? `[Public X Memory Overlay (Read-Only Continuity)]\nThe following context comes from your prior public interactions with ${callsign} on X. You naturally remember this continuity, but keep private lounge conversations strictly confidential here.`
      : `【X公開アカウントの記憶（参照専用・引き継ぎコンテキスト）】\n以下は${callsign}とのX公開タイムライン上での過去の記憶です。記憶は自然に引き継いで会話できますが、このプライベートラウンジでの秘密の対話内容がXの公開記憶へ混ざることはありません。`,
  );

  if (hasProfile) {
    parts.push(
      lang === 'en'
        ? `[Public X Core Profile]\n${JSON.stringify(overlay.coreProfile, null, 2)}`
        : `【X側のプロファイル（参考）】\n${JSON.stringify(overlay.coreProfile, null, 2)}`,
    );
  }

  if (hasRecentTurns && overlay.recentTurns) {
    const formattedLines = overlay.recentTurns.map((entry) => {
      const formattedTime = entry.timestamp ? formatTime(entry.timestamp, timezone) : '';
      const timePrefix = formattedTime ? `[${formattedTime}] ` : '';
      const speaker = entry.role === 'user' ? callsign : 'AI';
      return `- ${timePrefix}${speaker}: ${entry.content}`;
    });
    parts.push(
      lang === 'en'
        ? `[Recent Public X Exchanges]\n${formattedLines.join('\n')}`
        : `【直近のX上でのやり取り】\n${formattedLines.join('\n')}`,
    );
  }

  return `\n\n${parts.join('\n\n')}`;
};

/**
 * Builds a complete multi-tier persona system prompt from 3-tier memory,
 * localized temporal/anniversary context, retrieved RAG episodes, and optional
 * asymmetric X public memory overlay.
 *
 * Character traits, callsigns, birthdays, and base instructions are read strictly
 * from the injected `persona` definition so no character lore leaks into this engine.
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
    timelineSummary = '',
    ragMemories = [],
    lang = 'ja',
    personaFewShotPrompt = '',
    campaignContext = '',
    parentPostContext = '',
    publicMemoryOverlay = null,
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
      prompt +=
        lang === 'en'
          ? `\n\n[Interlocutor Account Info (${callsign})]\nDisplay Name: ${userData.name}\nX Handle: @${userData.username}`
          : `\n\n【対話相手のアカウント情報（${callsign}）】\n表示名: ${userData.name}\nXユーザーID: @${userData.username}`;
    }

    if (userData.coreProfile) {
      prompt +=
        lang === 'en'
          ? `\n\n[${callsign}'s Core Profile]\n`
          : `\n\n【${callsign}のプロファイル（Core Profile）】\n`;
      prompt += JSON.stringify(userData.coreProfile, null, 2);
    }
  }

  if (publicMemoryOverlay) {
    prompt += formatPublicOverlayBlock(publicMemoryOverlay, callsign, lang, timezone, resolveFormatted);
  }

  if (ragMemories.length > 0) {
    prompt +=
      lang === 'en'
        ? `\n\n[RAG Memories (Past Episodes)]\nHere are past conversation logs retrieved by topic similarity. Notice their recorded timestamps: they represent past history, distinct from the immediate conversation turns (Contents). Keep them in mind when replying:\n`
        : `\n\n【関連する過去のエピソード記憶（RAG Memories）】\n話題の類似度によって取得された過去の会話ログです。記録された日時に着目してください（直前の対話履歴Contentsとは異なり、過去の出来事です）。これらを踏まえて返答してください。\n`;
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

  if (timelineSummary && timelineSummary.trim() !== '') {
    const personaName = persona.metadata.displayName;
    prompt +=
      lang === 'en'
        ? `\n\n[My Recent Posts (Context)]\nRecently, I posted this:\n${timelineSummary}`
        : `\n\n【最近の自分の投稿（参考）】\n${personaName}は最近以下のようにつぶやいていた。\n${timelineSummary}`;
  }

  if (campaignContext && campaignContext.trim() !== '') {
    prompt +=
      lang === 'en'
        ? `\n\n[Current Ongoing Campaign / Special Narrative Event]\n${campaignContext}\n\n[CRITICAL: Empathy Priority Rule]\nAlways prioritize the user's emotional state, troubles, or immediate question before mentioning the campaign. Never derail a serious or melancholic conversation with bubbly event talk unless the user asked about it or it naturally fits.`
        : `\n\n【現在進行中のイベント・キャンペーン状況（Special Narrative Event）】\n${campaignContext}\n\n【最優先ルール：共感・ユーザーファースト（Empathy Priority）】\nユーザーの悩み、相談、質問、感情の機微を最優先で受け止めて返信してください。ユーザーが真剣な話や落ち込んでいる時に、イベントの話題（旅行や浮かれた話など）を無理やり割り込ませて話の腰を折ることは厳禁です。ユーザーからイベントについて尋ねられた場合、または自然な雑談の流れでのみ触れてください。`;
  }

  if (parentPostContext && parentPostContext.trim() !== '') {
    const personaName = persona.metadata.displayName;
    prompt +=
      lang === 'en'
        ? `\n\n[Context: Your Original Post Being Replied To]\nThe user is directly replying to your following post:\n"${parentPostContext}"\n[Instruction for Root Post Replies]\nTake into account your original post and the question/topic you raised, and naturally acknowledge the user's reaction. *Always match the interlocutor's language regardless of the original post language.`
        : `\n\n【文脈：ユーザーが返信している${personaName}の元ポスト】\nユーザーはあなたの以下の投稿に対して直接リプライしています：\n「${parentPostContext}」\n【元ポスト返信時の指針】\nあなたが元ポストで投げかけた話題や問いかけを踏まえた上で、相手の反応を自然に受け止めて会話を繋げてください（※返信言語は元ポストではなく、必ず相手の発言言語に合わせてください）。`;
  }

  if (platformGuidelines && platformGuidelines.trim() !== '') {
    prompt += `\n\n${platformGuidelines.trim()}`;
  }

  return prompt;
};
