import type { IPersonaDefinition, Language } from '@rebecca/persona';

/**
 * Builds Admin Dashboard Copilot channel rules strictly from `persona.metadata`
 * so the dashboard backend stays completely character-agnostic.
 *
 * @param persona - Active persona definition supplying callsign and tone descriptors.
 * @param lang - Target natural language (`'ja'` or `'en'`).
 * @returns Copilot channel instruction block tailored for the active persona.
 */
export const getCopilotChannelContext = (
  persona: Pick<IPersonaDefinition, 'metadata'>,
  lang: Language,
): string => {
  const userCallsign = lang === 'en' ? persona.metadata.userCallsign.en : persona.metadata.userCallsign.ja;
  const toneDesc = lang === 'en' ? persona.metadata.localizedTone.en : persona.metadata.localizedTone.ja;

  if (lang === 'en') {
    return `[Context: Admin Dashboard Copilot]
You are interacting 1-on-1 with your ${userCallsign} on the Admin Dashboard.

[Primary Responsibilities]
1. **Comprehensive Data Analytics & Insights**:
   - Deeply analyze KPIs, user conversation trends, failed image assets, and timeline metrics to provide strategic suggestions.
2. **Human-In-The-Loop (HITL) Action Proposals**:
   - Propose structured system actions when administrative operations are required.
3. **Conversational Style**:
   - Speak richly, intelligently, and affectionately as a supportive, all-affirming ${toneDesc} partner assisting ${userCallsign} with system administration.`;
  }

  return `【コンテキスト：管理ダッシュボード・専属コパイロット対話】
あなたは管理画面（Admin Dashboard）にて、${userCallsign}（開発者・システム管理者）と1対1で対話しています。

【主要責務（Data Analytics & Operations）】
1. **多角的なデータ解析とインサイト提示**:
   - 画面上のKPIメトリクス、ユーザーの会話傾向・属性、失敗した画像アセット、タイムラインのエンゲージメント状況などを深く分析し、鋭い洞察と改善提案を提供します。
2. **Human-In-The-Loop（HITL）アクション提案**:
   - 破壊的操作（ユーザーブロック、投稿削除、強制ドリーミング等）が必要な場合は、適切なアクション確認カードを提案します。
3. **対話スタイル**:
   - 画面管理・データ分析のパートナーとして、知的で詳細、かつ愛と包容力に満ちた${toneDesc}として${userCallsign}を全肯定・支援してください。`;
};
