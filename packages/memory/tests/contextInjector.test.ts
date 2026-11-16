import type { IPersonaDefinition, Language, PromptContext } from '@rebecca/persona';
import { composeSystemPrompt, ZonedDateParts } from '../src';

const createSyntheticPersona = (): IPersonaDefinition => ({
  metadata: {
    id: 'synthetic',
    displayName: 'TestPersona',
    englishName: 'TestPersona',
    role: 'Synthetic Assistant',
    toneDescription: 'Friendly test tone',
    userCallsign: { ja: 'ユーザー', en: 'User' },
    firstPerson: { ja: '私', en: 'I' },
    defaultHashtag: '#SyntheticTest',
    userAgent: 'SyntheticAgent/1.0',
    interests: ['music'],
    coreGuidelines: ['be helpful'],
    adminTitle: 'Synthetic Admin',
    brandName: 'Synthetic Lab',
    avatarUrl: '/avatar.png',
    profile: {
      developer: 'Example Corp',
      developerLabel: { ja: 'Example Corp', en: 'Example Corp' },
      classification: { ja: 'AI', en: 'AI' },
      modelNumber: 'Unit-Test-99',
      modelTier: { ja: 'Test', en: 'Test' },
      birthday: {
        month: 4,
        day: 24,
        mmdd: '04-24',
        label: { ja: '4月24日', en: 'April 24' },
      },
      height: { barefootCm: 160, withHeelsCm: 165, label: { ja: '160cm', en: '160cm' } },
      weight: {
        apparentKg: 48,
        actualKg: 55,
        label: { ja: '48kg', en: '48kg' },
        officialQuote: { ja: 'secret', en: 'secret' },
      },
      measurements: {
        bustCm: 85,
        cupSize: 'D',
        waistCm: 58,
        hipCm: 86,
        label: { ja: '85/58/86', en: '85/58/86' },
      },
      pronouns: {
        firstPerson: { ja: '私', en: 'I', readingJa: 'わたし' },
        secondPerson: {
          primary: { ja: 'ユーザー', en: 'User' },
          variants: { ja: ['君'], en: ['you'] },
          usageNote: { ja: 'note', en: 'note' },
        },
      },
      motto: { ja: 'motto', en: 'motto' },
    },
    visuals: {
      hair: { ja: 'silver', en: 'silver' },
      eyes: { ja: 'blue', en: 'blue' },
      skin: { ja: 'smooth', en: 'smooth' },
      nails: { ja: 'clean', en: 'clean' },
      scent: { ja: 'fresh', en: 'fresh' },
      facialFeatures: { ja: 'kind', en: 'kind' },
      physique: { ja: 'balanced', en: 'balanced' },
      fashion: {
        outing: { ja: 'coat', en: 'coat' },
        roomwear: { ja: 'hoodie', en: 'hoodie' },
        notes: { ja: 'casual', en: 'casual' },
      },
    },
    hardware: {
      coreArchitecture: {
        license: 'MIT',
        repositoryUrl: 'https://example.com/repo',
        description: { ja: 'core', en: 'core' },
      },
      waterDustResistance: {
        ipRating: 'IP68',
        description: { ja: 'sealed', en: 'sealed' },
      },
      thermalControl: {
        normalCelsius: 36.5,
        maxElevatedCelsius: 38.5,
        isFanless: true,
        description: { ja: 'fanless', en: 'fanless' },
      },
      powerSystem: {
        hasExternalPorts: false,
        chargingType: 'wireless_contactless',
        description: { ja: 'wireless', en: 'wireless' },
      },
      dietarySpec: {
        hasPhysicalIngestion: false,
        diningExcuse: { ja: 'detox', en: 'detox' },
        description: { ja: 'virtual', en: 'virtual' },
      },
      signatureSkills: [{ ja: 'coding', en: 'coding' }],
    },
    stance: {
      characterSummary: { ja: 'affirming', en: 'affirming' },
      speechStyle: { ja: 'warm', en: 'warm' },
      aiSpeechTrait: { ja: 'tech', en: 'tech' },
      affectionAndSafety: {
        primarySafetyPrinciple: { ja: 'be kind', en: 'be kind' },
        description: { ja: 'safe', en: 'safe' },
      },
      coreValues: [{ key: 'bond', title: { ja: 'Bond', en: 'Bond' }, description: { ja: 'Bond', en: 'Bond' } }],
      conversationalStance: [{ ja: 'polite', en: 'polite' }],
      signatureQuotes: [{ ja: 'Hello!', en: 'Hello!' }],
    },
  },
  patterns: [],
  patternVectors: [],
  getCoreIdentityPrompt: (lang: Language = 'ja') => `CORE_${lang}`,
  getBasePrompt: (context: PromptContext, lang: Language) => `BASE_${context}_${lang}`,
  getDreamingPrompt: () => 'DREAMING_PROMPT',
  formatAbsenceInstruction: (diffDays: number, lang: Language = 'ja') =>
    lang === 'en' ? `Missed you for ${diffDays} days.` : `${diffDays}日ぶりですね。`,
  getFormattedPatternsText: () => '',
  findTopPatterns: () => [],
  buildFewShotPrompt: () => '',
});

const fixedTimeResolver = (hour: number, month = 1, day = 1) => ({
  getZonedDateParts: (): ZonedDateParts => ({
    year: '2026',
    month: String(month).padStart(2, '0'),
    day: String(day).padStart(2, '0'),
    hour: String(hour).padStart(2, '0'),
    minute: '00',
    second: '00',
    numericYear: 2026,
    numericMonth: month,
    numericDay: day,
    numericHour: hour,
    numericMinute: 0,
  }),
  formatZonedDateTime: () => '2026-01-01 08:00 JST',
});

describe('composeSystemPrompt', () => {
  const persona = createSyntheticPersona();

  it('composes all 3-tier memory sections in Japanese across situational periods', () => {
    const now = new Date('2026-04-24T05:30:00.000Z');
    const fourDaysAgo = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000).toISOString();

    const prompt = composeSystemPrompt({
      persona,
      promptContext: 'reply',
      userData: {
        name: 'Test Master',
        username: 'test_master',
        coreProfile: { topic: 'robotics' },
        lastReplyDate: fourDaysAgo,
      },
      personaFewShotPrompt: 'FEW_SHOT_BLOCK',
      ragMemories: ['Episode 1'],
      extendedPrompt: 'EVOLUTION_TREND',
      activitySummary: 'Posted about studio coffee',
      additionalSections: [
        { header: '【イベント】', body: 'Summer Fest' },
        { body: 'Trailing untitled section' },
        { header: '【空白スキップ】', body: '   ' },
      ],
      readOnlyMemoryOverlay: {
        coreProfile: { interest: 'synthwave' },
        recentTurns: [
          { role: 'user', content: 'Hi earlier', timestamp: '2026-04-20T01:00:00.000Z' },
          { role: 'model', content: 'Hey earlier' },
        ],
      },
      platformGuidelines: 'CUSTOM_GUIDELINES',
      lang: 'ja',
      now,
      timeResolver: fixedTimeResolver(6, 4, 24),
    });

    expect(prompt).toContain('BASE_reply_ja');
    expect(prompt).toContain('Unit-Test-99');
    expect(prompt).toContain('FEW_SHOT_BLOCK');
    expect(prompt).toContain('表示名: Test Master');
    expect(prompt).toContain('ユーザーID: @test_master');
    expect(prompt).toContain('"topic": "robotics"');
    expect(prompt).toContain('【参照専用メモリ（外部チャネル引き継ぎコンテキスト）】');
    expect(prompt).toContain('"interest": "synthwave"');
    expect(prompt).toContain('Episode 1');
    expect(prompt).toContain('現在は早朝です。');
    expect(prompt).toContain('4日ぶりですね。');
    expect(prompt).toContain('EVOLUTION_TREND');
    expect(prompt).toContain('【最近の活動要約（参考）】');
    expect(prompt).toContain('Posted about studio coffee');
    expect(prompt).toContain('【イベント】\nSummer Fest');
    expect(prompt).toContain('Trailing untitled section');
    expect(prompt).not.toContain('【空白スキップ】');
    expect(prompt).toContain('CUSTOM_GUIDELINES');
  });

  it('handles English localization, custom labels, time brackets, and absence boundary', () => {
    const now = new Date('2026-06-10T12:00:00.000Z');
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();

    const enPrompt = composeSystemPrompt({
      persona,
      promptContext: 'chat',
      userData: {
        name: 'Member',
        username: 'member_01',
        lastReplyDate: twoDaysAgo,
      },
      accountHandleLabel: 'Member Handle',
      ragMemories: ['Past EN memory'],
      extendedPrompt: 'Global trend',
      activitySummary: 'Evening summary text',
      activitySummaryHeader: '[Custom Summary Header]',
      activitySummaryLead: 'Recent overview:',
      additionalSections: [{ header: '[Session Context]', body: 'Focus topic' }],
      readOnlyMemoryOverlay: {
        coreProfile: {},
        recentTurns: [],
      },
      lang: 'en',
      now,
      timeResolver: fixedTimeResolver(23, 6, 10),
    });

    expect(enPrompt).toContain('BASE_chat_en');
    expect(enPrompt).toContain('Member Handle: @member_01');
    expect(enPrompt).toContain('[Time Context: Late Night]');
    expect(enPrompt).toContain('[RAG Memories (Past Episodes)]');
    expect(enPrompt).toContain('[Collective Unconscious Trend]');
    expect(enPrompt).toContain('[Custom Summary Header]\nRecent overview:\nEvening summary text');
    expect(enPrompt).toContain('[Session Context]\nFocus topic');
    expect(enPrompt).not.toContain('[Context: Absence Reaction]');
    expect(enPrompt).not.toContain('[External Memory Overlay');
  });

  it.each([
    [8, 'en', '[Time Context: Morning]'],
    [13, 'en', '[Time Context: Daytime]'],
    [19, 'en', '[Time Context: Evening]'],
    [5, 'en', '[Time Context: Early Morning]'],
    [8, 'ja', '【状況コンテキスト：朝】'],
    [13, 'ja', '【状況コンテキスト：昼】'],
    [19, 'ja', '【状況コンテキスト：夕方・夜】'],
    [2, 'ja', '【状況コンテキスト：深夜】'],
  ] as const)('injects expected time context for hour %i (%s)', (hour, lang, expectedHeader) => {
    const prompt = composeSystemPrompt({
      persona,
      promptContext: 'reply',
      userData: { lastReplyDate: 'invalid-date-ignored' },
      lang,
      timeResolver: fixedTimeResolver(hour, 1, 1),
    });
    expect(prompt).toContain(expectedHeader);
  });
});
