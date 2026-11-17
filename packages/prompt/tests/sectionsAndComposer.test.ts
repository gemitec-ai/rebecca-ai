import type { IPersonaDefinition, Language } from '@rebecca/persona';
import {
  assemblePromptSections,
  composeSystemPrompt,
  formatAbsenceSection,
  formatActivitySummarySection,
  formatBirthdaySection,
  formatCoreProfileSection,
  formatCurrentTimeSection,
  formatExtendedTrendSection,
  formatInterlocutorSection,
  formatRagMemoriesSection,
  formatReadOnlyOverlaySection,
  formatTimeBracketSection,
  ZonedDateParts,
} from '../src';

const createSyntheticPersona = (): IPersonaDefinition => ({
  metadata: {
    id: 'synthetic',
    displayName: 'TestPersona',
    englishName: 'TestPersona',
    role: 'Synthetic Assistant',
    toneDescription: 'Friendly test tone',
    localizedTone: { ja: 'フレンドリーなアシスタント', en: 'friendly assistant' },
    affectionateTone: { ja: '温かく親しみやすい', en: 'warm and friendly' },
    socialHandle: '@synthetic_ai',
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
  composePrompt: (channelInstruction: string, lang: Language = 'ja') =>
    channelInstruction.trim() ? `CORE_${lang}\n\n${channelInstruction.trim()}` : `CORE_${lang}`,
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

describe('@rebecca/prompt building blocks and composer', () => {
  const persona = createSyntheticPersona();

  it('assembles arbitrary sections in caller-specified order while filtering empty/null items', () => {
    const assembled = assemblePromptSections([
      'First block',
      null,
      undefined,
      '   ',
      { header: '[Header]', body: 'Body line' },
      { header: '[BlankSkipped]', body: '   ' },
      { body: 'Untitled section' },
    ]);

    expect(assembled).toBe('First block\n\n[Header]\nBody line\n\nUntitled section');
  });

  it('builds individual granular sections cleanly across empty and populated states', () => {
    expect(formatCurrentTimeSection('   ', 'en')).toBeNull();
    expect(formatCurrentTimeSection('2026-01-01 09:00', 'en')).toEqual({
      header: '[Current Time]',
      body: '2026-01-01 09:00',
    });

    expect(formatBirthdaySection(persona, { numericMonth: 4, numericDay: 24 }, 'en')?.header).toContain(
      'April 24',
    );
    expect(formatBirthdaySection(persona, { numericMonth: 4, numericDay: 25 }, 'en')).toBeNull();

    expect(formatInterlocutorSection('User', { name: 'Alice' }, 'en')).toBeNull();
    expect(formatCoreProfileSection('User', undefined, 'en')).toBeNull();
    expect(formatRagMemoriesSection([], 'ja')).toBeNull();
    expect(formatExtendedTrendSection('  ', 'ja')).toBeNull();
    expect(formatActivitySummarySection('', 'ja')).toBeNull();
    expect(formatAbsenceSection(persona, undefined, new Date(), 'en')).toBeNull();
    expect(formatReadOnlyOverlaySection(null, 'User', 'en')).toBeNull();
    expect(formatReadOnlyOverlaySection({ coreProfile: {}, recentTurns: [] }, 'User', 'en')).toBeNull();
  });

  it('composes all memory tiers, anchoring, temporal, and host sections in Japanese', async () => {
    const now = new Date('2026-04-24T05:30:00.000Z');
    const fourDaysAgo = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000).toISOString();
    const samplePattern = {
      id: 9,
      category: 'care',
      trigger: 'morning',
      internal_thought: 'gentle',
      behavior: 'support',
      sample_response: 'Good morning!',
      vector: [1, 0],
    };
    const anchoredPersona: IPersonaDefinition = {
      ...createSyntheticPersona(),
      patternVectors: [samplePattern],
      findTopPatterns: jest.fn(() => [samplePattern]),
      buildFewShotPrompt: jest.fn(() => 'FEW_SHOT_BLOCK'),
    };
    const embedder = { generateEmbedding: jest.fn().mockResolvedValue([1, 0]) };

    const result = await composeSystemPrompt({
      persona: anchoredPersona,
      channelInstruction: 'CHANNEL_RULES_JA',
      lang: 'ja',
      anchoring: {
        embedder,
        contextElements: ['morning greeting'],
      },
      temporal: {
        now,
        timeResolver: fixedTimeResolver(6, 4, 24),
      },
      memory: {
        userData: {
          name: 'Test Master',
          username: 'test_master',
          coreProfile: { topic: 'robotics' },
          lastReplyDate: fourDaysAgo,
        },
        ragMemories: ['Episode 1'],
        extendedPrompt: 'EVOLUTION_TREND',
        activitySummary: 'Posted about studio coffee',
        readOnlyMemoryOverlay: {
          coreProfile: { interest: 'synthwave' },
          recentTurns: [
            { role: 'user', content: 'Hi earlier', timestamp: '2026-04-20T01:00:00.000Z' },
            { role: 'model', content: 'Hey earlier' },
          ],
        },
      },
      additionalSections: [
        { header: '【イベント】', body: 'Summer Fest' },
        { body: 'Trailing untitled section' },
        { header: '【空白スキップ】', body: '   ' },
      ],
      platformGuidelines: 'CUSTOM_GUIDELINES',
    });

    expect(result.personaFewShotPrompt).toBe('FEW_SHOT_BLOCK');
    expect(result.baseSystemInstruction).toContain('CORE_ja\n\nCHANNEL_RULES_JA');
    expect(result.baseSystemInstruction).toContain('FEW_SHOT_BLOCK');
    expect(result.systemInstruction).toContain('CORE_ja\n\nCHANNEL_RULES_JA');
    expect(result.systemInstruction).toContain('Unit-Test-99');
    expect(result.systemInstruction).toContain('FEW_SHOT_BLOCK');
    expect(result.systemInstruction).toContain('表示名: Test Master');
    expect(result.systemInstruction).toContain('ユーザーID: @test_master');
    expect(result.systemInstruction).toContain('"topic": "robotics"');
    expect(result.systemInstruction).toContain('【参照専用メモリ（外部チャネル引き継ぎコンテキスト）】');
    expect(result.systemInstruction).toContain('"interest": "synthwave"');
    expect(result.systemInstruction).toContain('Episode 1');
    expect(result.systemInstruction).toContain('現在は早朝です。');
    expect(result.systemInstruction).toContain('4日ぶりですね。');
    expect(result.systemInstruction).toContain('EVOLUTION_TREND');
    expect(result.systemInstruction).toContain('【最近の活動要約（参考）】');
    expect(result.systemInstruction).toContain('【イベント】\nSummer Fest');
    expect(result.systemInstruction).toContain('Trailing untitled section');
    expect(result.systemInstruction).not.toContain('【空白スキップ】');
    expect(result.systemInstruction).toContain('CUSTOM_GUIDELINES');
  });

  it('handles English localization, custom overlay labels, and absence boundary', async () => {
    const now = new Date('2026-06-10T12:00:00.000Z');
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();

    const { systemInstruction: enPrompt } = await composeSystemPrompt({
      persona,
      channelInstruction: 'EN_CHANNEL_RULES',
      lang: 'en',
      anchoring: {
        embedder: { generateEmbedding: jest.fn() },
        contextElements: [''],
      },
      temporal: {
        now,
        timeResolver: fixedTimeResolver(23, 6, 10),
      },
      memory: {
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
        readOnlyMemoryOverlay: {
          coreProfile: { plan: 'pro' },
          recentTurns: [{ role: 'model', content: 'Welcome back' }],
          labels: {
            intro: '[Custom Overlay Intro]',
            profileHeader: '[Custom Profile]',
            turnsHeader: '[Custom Turns]',
          },
        },
      },
      additionalSections: [{ header: '[Session Context]', body: 'Focus topic' }],
    });

    expect(enPrompt).toContain('CORE_en\n\nEN_CHANNEL_RULES');
    expect(enPrompt).toContain('Member Handle: @member_01');
    expect(enPrompt).toContain('[Time Context: Late Night]');
    expect(enPrompt).toContain('[RAG Memories (Past Episodes)]');
    expect(enPrompt).toContain('[Custom Overlay Intro]');
    expect(enPrompt).toContain('[Custom Profile]');
    expect(enPrompt).toContain('[Custom Turns]');
    expect(enPrompt).toContain('[Custom Summary Header]\nRecent overview:\nEvening summary text');
    expect(enPrompt).not.toContain('[Context: Absence Reaction]');
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
  ] as const)('injects expected time context for hour %i (%s)', async (hour, lang, expectedHeader) => {
    const section = formatTimeBracketSection(hour, lang);
    expect(section.header).toBe(expectedHeader);

    const { systemInstruction } = await composeSystemPrompt({
      persona,
      lang,
      anchoring: {
        embedder: { generateEmbedding: jest.fn() },
        contextElements: [''],
      },
      temporal: {
        timeResolver: fixedTimeResolver(hour, 1, 1),
      },
      memory: {
        userData: { lastReplyDate: 'invalid-date-ignored' },
      },
    });
    expect(systemInstruction).toContain(expectedHeader);
  });

  it('supports lightweight channel-only invocations without temporal or memory slices while keeping anchoring active', async () => {
    const samplePattern = {
      id: 7,
      category: 'support',
      trigger: 'tired',
      internal_thought: 'comfort',
      behavior: 'affirm',
      sample_response: 'You did great!',
      vector: [1, 0],
    };
    const anchoredPersona: IPersonaDefinition = {
      ...createSyntheticPersona(),
      patternVectors: [samplePattern],
      findTopPatterns: jest.fn(() => [samplePattern]),
      buildFewShotPrompt: jest.fn((patterns, lang) => `ANCHOR_${lang}:${patterns[0]?.id ?? 0}`),
    };
    const embedder = { generateEmbedding: jest.fn().mockResolvedValue([1, 0]) };

    const channelResult = await composeSystemPrompt({
      persona: anchoredPersona,
      channelInstruction: 'CHANNEL_X',
      lang: 'ja',
      anchoring: {
        embedder,
        contextElements: ['tired today'],
      },
      additionalSections: [{ header: '[Extra]', body: 'Extra Rule' }],
    });

    expect(channelResult.personaFewShotPrompt).toBe('ANCHOR_ja:7');
    expect(channelResult.baseSystemInstruction).toBe('CORE_ja\n\nCHANNEL_X\n\nANCHOR_ja:7');
    expect(channelResult.systemInstruction).toContain('[Extra]\nExtra Rule');
    expect(channelResult.systemInstruction).not.toContain('【現在時刻】');
  });
});
