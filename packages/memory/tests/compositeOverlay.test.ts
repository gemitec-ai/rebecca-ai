import { composeAsymmetricMemoryOverlay, ReadOnlySourceMemorySnapshot } from '../src';

describe('composeAsymmetricMemoryOverlay', () => {
  it('bridges read-only source memories into target session without mutating source inputs', () => {
    const sourceBuffer = [
      { role: 'user' as const, content: 'src-msg-1' },
      { role: 'model' as const, content: 'src-reply-1', thought: 'src-thought-1' },
    ];
    const sourceSnapshot: ReadOnlySourceMemorySnapshot = {
      user: {
        id: 'user_001',
        name: 'Test User',
        username: 'test_user',
        coreProfile: { hobby: 'music' },
        episodicBuffer: sourceBuffer,
        lastReplyDate: '2026-11-10T10:00:00.000Z',
      },
      ragMemories: ['User likes jazz', '  '],
      activitySummary: '  Posted about studio practice  ',
    };

    const overlay = composeAsymmetricMemoryOverlay({
      sourceMemory: sourceSnapshot,
      targetMemory: {
        user: {
          id: 'user_001',
          coreProfile: { preference: 'late-night talks' },
          episodicBuffer: [
            { role: 'user', content: 'target-1' },
            { role: 'model', content: 'target-reply-1' },
          ],
          lastReplyDate: '2026-11-12T10:00:00.000Z',
        },
        ragMemories: ['Target shared memory'],
      },
      lang: 'en',
    });

    expect(overlay.targetWorkingMemory).toHaveLength(2);
    expect(overlay.sourceRecentTurns).toHaveLength(2);
    expect(overlay.effectiveLastReplyDate).toBe('2026-11-12T10:00:00.000Z');
    expect(overlay.activitySummary).toBe('Posted about studio practice');
    expect(overlay.ragMemories).toEqual([
      '[Session Memory] Target shared memory',
      '[External Memory] User likes jazz',
    ]);

    expect(overlay.sourceUser).not.toBe(sourceSnapshot.user);
    expect(overlay.sourceUser?.coreProfile).toEqual({ hobby: 'music' });
  });

  it('supports custom channel provenance labels', () => {
    const overlay = composeAsymmetricMemoryOverlay({
      sourceMemory: {
        ragMemories: ['From channel A'],
      },
      targetMemory: {
        ragMemories: ['In channel B'],
      },
      labels: {
        sourceTag: '[Channel A]',
        targetTag: '[Channel B]',
      },
    });

    expect(overlay.ragMemories).toEqual([
      '[Channel B] In channel B',
      '[Channel A] From channel A',
    ]);
  });

  it('handles missing source memory cleanly without adding redundant tags to target RAG memories', () => {
    const overlay = composeAsymmetricMemoryOverlay({
      sourceMemory: null,
      targetMemory: {
        user: {
          id: 'user_002',
          coreProfile: {},
          episodicBuffer: [],
        },
        ragMemories: ['Only target memory', ''],
      },
    });

    expect(overlay.sourceUser).toBeNull();
    expect(overlay.sourceRecentTurns).toEqual([]);
    expect(overlay.targetWorkingMemory).toEqual([]);
    expect(overlay.effectiveLastReplyDate).toBeUndefined();
    expect(overlay.ragMemories).toEqual(['Only target memory']);
  });

  it('uses source lastReplyDate when target lastReplyDate is missing or older, and ignores invalid dates', () => {
    const fromSourceOnly = composeAsymmetricMemoryOverlay({
      sourceMemory: {
        user: {
          lastReplyDate: '2026-11-14T08:00:00.000Z',
        },
      },
      targetMemory: {
        user: {
          lastReplyDate: 'invalid-date',
        },
      },
      lang: 'ja',
    });
    expect(fromSourceOnly.effectiveLastReplyDate).toBe('2026-11-14T08:00:00.000Z');

    const targetNewer = composeAsymmetricMemoryOverlay({
      sourceMemory: {
        user: {
          lastReplyDate: '2026-11-01T00:00:00.000Z',
        },
        ragMemories: ['Source episode'],
      },
      targetMemory: {
        user: {
          lastReplyDate: '2026-11-15T00:00:00.000Z',
        },
        ragMemories: ['Target episode'],
      },
      lang: 'ja',
    });
    expect(targetNewer.effectiveLastReplyDate).toBe('2026-11-15T00:00:00.000Z');
    expect(targetNewer.ragMemories).toEqual([
      '【現在セッションの記憶】 Target episode',
      '【外部チャネルの記憶】 Source episode',
    ]);
  });
});
