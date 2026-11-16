import { precomputedPersonaPatternEmbeddings, rebeccaPersona } from '@rebecca/persona';
import { buildSystemPrompt } from '../../src/core/contextInjector';

jest.mock('../../src/utils/time', () => ({
  getZonedDateParts: jest.fn(),
  formatZonedDateTime: jest.fn(() => '2024-01-01 08:00 JST'),
}));
import { getZonedDateParts, formatZonedDateTime } from '../../src/utils/time';

const createMockZonedParts = (hour: number, month = 1, day = 1) => ({
  year: '2024',
  month: String(month).padStart(2, '0'),
  day: String(day).padStart(2, '0'),
  hour: String(hour).padStart(2, '0'),
  minute: '00',
  second: '00',
  numericYear: 2024,
  numericMonth: month,
  numericDay: day,
  numericHour: hour,
  numericMinute: 0,
});

const stubEmbedder = {
  generateEmbedding: jest.fn().mockResolvedValue([...precomputedPersonaPatternEmbeddings[0].vector]),
};

describe('Context Injector (Unified buildSystemPrompt)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    stubEmbedder.generateEmbedding.mockResolvedValue([
      ...precomputedPersonaPatternEmbeddings[0].vector,
    ]);
  });

  it('should inject early morning context and 120-pattern anchors during 5:00-6:00', async () => {
    (getZonedDateParts as jest.Mock).mockReturnValue(createMockZonedParts(6));
    (formatZonedDateTime as jest.Mock).mockReturnValue('2024-01-01 06:00 JST');

    const { systemInstruction, baseSystemInstruction, personaFewShotPrompt } =
      await buildSystemPrompt({
        persona: rebeccaPersona,
        promptContext: 'chat',
        gemini: stubEmbedder,
        anchoringContext: ['おはよう'],
        includeTemporalContext: true,
        userData: { coreProfile: {}, episodicBuffer: [] },
      });

    expect(personaFewShotPrompt).toContain('【動的Few-Shotペルソナアンカー');
    expect(baseSystemInstruction).toContain('【動的Few-Shotペルソナアンカー');
    expect(systemInstruction).toContain('【状況コンテキスト：早朝】\n現在は早朝です。');
    expect(systemInstruction).toContain('【現在時刻】\n2024-01-01 06:00 JST');
    expect(systemInstruction).toContain('【コンテキスト：マスターとの1対1対話】');
    expect(systemInstruction).not.toContain('ロールアウト記念日（4月24日）】');
  });

  it('should inject morning context during 7:00-10:00', async () => {
    (getZonedDateParts as jest.Mock).mockReturnValue(createMockZonedParts(8));
    (formatZonedDateTime as jest.Mock).mockReturnValue('2024-01-01 08:00 JST');

    const { systemInstruction } = await buildSystemPrompt({
      persona: rebeccaPersona,
      promptContext: 'reply',
      gemini: stubEmbedder,
      anchoringContext: ['こんにちは'],
      includeTemporalContext: true,
      userData: { coreProfile: {}, episodicBuffer: [] },
    });

    expect(systemInstruction).toContain('【状況コンテキスト：朝】\n現在は朝です。');
    expect(systemInstruction).toContain('【現在時刻】\n2024-01-01 08:00 JST');
  });

  it('should inject daytime context during 11:00-16:00', async () => {
    (getZonedDateParts as jest.Mock).mockReturnValue(createMockZonedParts(13));

    const { systemInstruction } = await buildSystemPrompt({
      persona: rebeccaPersona,
      promptContext: 'reply',
      gemini: stubEmbedder,
      anchoringContext: ['お昼'],
      includeTemporalContext: true,
      userData: { coreProfile: {}, episodicBuffer: [] },
    });

    expect(systemInstruction).toContain('【状況コンテキスト：昼】\n現在は昼です。');
  });

  it('should inject evening context during 17:00-21:00', async () => {
    (getZonedDateParts as jest.Mock).mockReturnValue(createMockZonedParts(19));

    const { systemInstruction } = await buildSystemPrompt({
      persona: rebeccaPersona,
      promptContext: 'reply',
      gemini: stubEmbedder,
      anchoringContext: ['お疲れ様'],
      includeTemporalContext: true,
      userData: { coreProfile: {}, episodicBuffer: [] },
    });

    expect(systemInstruction).toContain('【状況コンテキスト：夕方・夜】\n現在は夕方・夜です。');
  });

  it('should inject night context during 22:00-4:00', async () => {
    (getZonedDateParts as jest.Mock).mockReturnValue(createMockZonedParts(23));

    const { systemInstruction } = await buildSystemPrompt({
      persona: rebeccaPersona,
      promptContext: 'reply',
      gemini: stubEmbedder,
      anchoringContext: ['こんばんは'],
      includeTemporalContext: true,
      userData: { coreProfile: {}, episodicBuffer: [] },
    });
    expect(systemInstruction).toContain(
      '【状況コンテキスト：深夜】\n現在は深夜です（相手が眠い・寝ると言わない限り会話を切り上げないこと）。',
    );

    (getZonedDateParts as jest.Mock).mockReturnValue(createMockZonedParts(3));
    const { systemInstruction: latePrompt } = await buildSystemPrompt({
      persona: rebeccaPersona,
      promptContext: 'reply',
      gemini: stubEmbedder,
      anchoringContext: ['眠れない'],
      includeTemporalContext: true,
      userData: { coreProfile: {}, episodicBuffer: [] },
    });
    expect(latePrompt).toContain(
      '【状況コンテキスト：深夜】\n現在は深夜です（相手が眠い・寝ると言わない限り会話を切り上げないこと）。',
    );
  });

  it('should inject Rollout Anniversary (birthday) context on April 24 in Japanese and English', async () => {
    (getZonedDateParts as jest.Mock).mockReturnValue(createMockZonedParts(12, 4, 24));
    (formatZonedDateTime as jest.Mock).mockReturnValue('2024-04-24 12:00 JST');

    const { systemInstruction: jaPrompt } = await buildSystemPrompt({
      persona: rebeccaPersona,
      promptContext: 'reply',
      lang: 'ja',
      gemini: stubEmbedder,
      anchoringContext: ['お誕生日おめでとう！'],
      includeTemporalContext: true,
    });
    expect(jaPrompt).toContain('【特別コンテキスト：あなた自身の誕生日・ロールアウト記念日（4月24日）】');
    expect(jaPrompt).toContain('Unit-001');

    const { systemInstruction: enPrompt } = await buildSystemPrompt({
      persona: rebeccaPersona,
      promptContext: 'reply',
      lang: 'en',
      gemini: stubEmbedder,
      anchoringContext: ['Happy birthday!'],
      includeTemporalContext: true,
    });
    expect(enPrompt).toContain('[Special Day Context: Your Birthday / Rollout Anniversary (April 24)]');
    expect(enPrompt).toContain('Unit-001');
  });

  it('should inject absence context if over 3 days', async () => {
    (getZonedDateParts as jest.Mock).mockReturnValue(createMockZonedParts(12));
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();

    const { systemInstruction } = await buildSystemPrompt({
      persona: rebeccaPersona,
      promptContext: 'reply',
      gemini: stubEmbedder,
      anchoringContext: ['久しぶり'],
      includeTemporalContext: true,
      userData: { coreProfile: {}, episodicBuffer: [], lastReplyDate: fourDaysAgo },
    });

    expect(systemInstruction).toContain('状況コンテキスト：放置');
    expect(systemInstruction).toContain('4日ぶり');
  });

  it('should inject English early morning context when lang is en', async () => {
    (getZonedDateParts as jest.Mock).mockReturnValue(createMockZonedParts(5));

    const { systemInstruction } = await buildSystemPrompt({
      persona: rebeccaPersona,
      promptContext: 'chat',
      lang: 'en',
      gemini: stubEmbedder,
      anchoringContext: ['Good morning'],
      includeTemporalContext: true,
      userData: { coreProfile: {}, episodicBuffer: [] },
    });

    expect(systemInstruction).toContain('[Time Context: Early Morning]\nIt is early morning right now.');
    expect(systemInstruction).toContain('[Context: 1-on-1 Dialogue with Master]');
  });

  it('should inject English morning, daytime, evening, and night contexts when lang is en', async () => {
    (getZonedDateParts as jest.Mock).mockReturnValue(createMockZonedParts(8));
    const morning = await buildSystemPrompt({
      persona: rebeccaPersona,
      promptContext: 'reply',
      lang: 'en',
      gemini: stubEmbedder,
      anchoringContext: ['Hello'],
      includeTemporalContext: true,
    });
    expect(morning.systemInstruction).toContain('[Time Context: Morning]\nIt is morning right now.');

    (getZonedDateParts as jest.Mock).mockReturnValue(createMockZonedParts(14));
    const daytime = await buildSystemPrompt({
      persona: rebeccaPersona,
      promptContext: 'reply',
      lang: 'en',
      gemini: stubEmbedder,
      anchoringContext: ['Lunch time'],
      includeTemporalContext: true,
    });
    expect(daytime.systemInstruction).toContain('[Time Context: Daytime]\nIt is daytime right now.');

    (getZonedDateParts as jest.Mock).mockReturnValue(createMockZonedParts(18));
    const evening = await buildSystemPrompt({
      persona: rebeccaPersona,
      promptContext: 'reply',
      lang: 'en',
      gemini: stubEmbedder,
      anchoringContext: ['Good evening'],
      includeTemporalContext: true,
    });
    expect(evening.systemInstruction).toContain('[Time Context: Evening]\nIt is evening right now.');

    (getZonedDateParts as jest.Mock).mockReturnValue(createMockZonedParts(23));
    const night = await buildSystemPrompt({
      persona: rebeccaPersona,
      promptContext: 'reply',
      lang: 'en',
      gemini: stubEmbedder,
      anchoringContext: ['Late night'],
      includeTemporalContext: true,
    });
    expect(night.systemInstruction).toContain(
      '[Time Context: Late Night]\nIt is late at night right now (do not cut off conversation unless Master mentions sleeping).',
    );
  });

  it('should inject English absence context if over 3 days when lang is en', async () => {
    (getZonedDateParts as jest.Mock).mockReturnValue(createMockZonedParts(12));
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();

    const { systemInstruction } = await buildSystemPrompt({
      persona: rebeccaPersona,
      promptContext: 'reply',
      lang: 'en',
      gemini: stubEmbedder,
      anchoringContext: ['Long time no see'],
      includeTemporalContext: true,
      userData: { coreProfile: {}, episodicBuffer: [], lastReplyDate: fourDaysAgo },
    });

    expect(systemInstruction).toContain('Context: Absence Reaction');
    expect(systemInstruction).toContain('4 days');
  });

  it('should inject interlocutor account info (display name and @username) in Japanese and English', async () => {
    (getZonedDateParts as jest.Mock).mockReturnValue(createMockZonedParts(12));
    const userWithIdentity = {
      name: 'Test Master',
      username: 'test_master_01',
      coreProfile: {},
      episodicBuffer: [],
    };

    const { systemInstruction: jaPrompt } = await buildSystemPrompt({
      persona: rebeccaPersona,
      promptContext: 'reply',
      lang: 'ja',
      gemini: stubEmbedder,
      anchoringContext: ['こんにちは'],
      includeTemporalContext: true,
      userData: userWithIdentity,
    });
    expect(jaPrompt).toContain('【対話相手のアカウント情報（マスター）】');
    expect(jaPrompt).toContain('表示名: Test Master');
    expect(jaPrompt).toContain('XユーザーID: @test_master_01');

    const { systemInstruction: enPrompt } = await buildSystemPrompt({
      persona: rebeccaPersona,
      promptContext: 'reply',
      lang: 'en',
      gemini: stubEmbedder,
      anchoringContext: ['Hello'],
      includeTemporalContext: true,
      userData: userWithIdentity,
    });
    expect(enPrompt).toContain('[Interlocutor Account Info (Master)]');
    expect(enPrompt).toContain('Display Name: Test Master');
    expect(enPrompt).toContain('X Handle: @test_master_01');
  });

  it('should inject parent post context and campaign context in Japanese and English', async () => {
    (getZonedDateParts as jest.Mock).mockReturnValue(createMockZonedParts(12));
    const parentPost = '最近急に寒くなってきたね〜。みんな風邪ひいてない？';

    const { systemInstruction: jaPrompt } = await buildSystemPrompt({
      persona: rebeccaPersona,
      promptContext: 'reply',
      lang: 'ja',
      gemini: stubEmbedder,
      anchoringContext: ['こっちはまだ半袖だよ'],
      includeTemporalContext: true,
      campaignContext: '冬のカフェ企画実施中',
      parentPostContext: parentPost,
    });
    expect(jaPrompt).toContain('【現在進行中のイベント・キャンペーン状況（Special Narrative Event）】');
    expect(jaPrompt).toContain('冬のカフェ企画実施中');
    expect(jaPrompt).toContain('【文脈：ユーザーが返信しているレベッカの元ポスト】');
    expect(jaPrompt).toContain(`「${parentPost}」`);

    const { systemInstruction: enPrompt } = await buildSystemPrompt({
      persona: rebeccaPersona,
      promptContext: 'reply',
      lang: 'en',
      gemini: stubEmbedder,
      anchoringContext: ['Still warm here'],
      includeTemporalContext: true,
      campaignContext: 'Winter cafe tour',
      parentPostContext: 'It is getting chilly lately!',
    });
    expect(enPrompt).toContain('[Current Ongoing Campaign / Special Narrative Event]');
    expect(enPrompt).toContain('Winter cafe tour');
    expect(enPrompt).toContain('[Context: Your Original Post Being Replied To]');
    expect(enPrompt).toContain('"It is getting chilly lately!"');
  });
});
