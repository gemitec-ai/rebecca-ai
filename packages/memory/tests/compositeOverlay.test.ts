import { composeAsymmetricMemoryOverlay, PublicMemorySnapshot } from '../src';

describe('composeAsymmetricMemoryOverlay', () => {
  it('bridges read-only public X memories into private session without mutating public inputs', () => {
    const publicUserBuffer = [
      { role: 'user' as const, content: 'x-msg-1' },
      { role: 'model' as const, content: 'x-reply-1', thought: 'x-thought-1' },
    ];
    const publicSnapshot: PublicMemorySnapshot = {
      user: {
        id: 'x_user_001',
        name: 'Test User',
        username: 'test_user',
        coreProfile: { hobby: 'music' },
        episodicBuffer: publicUserBuffer,
        lastReplyDate: '2026-11-10T10:00:00.000Z',
      },
      ragMemories: ['User likes jazz', '  '],
      timelineSummary: '  Posted about studio practice  ',
    };

    const overlay = composeAsymmetricMemoryOverlay({
      publicMemory: publicSnapshot,
      privateMemory: {
        user: {
          id: 'x_user_001',
          coreProfile: { secretPreference: 'late-night talks' },
          episodicBuffer: [
            { role: 'user', content: 'priv-1' },
            { role: 'model', content: 'priv-reply-1' },
          ],
          lastReplyDate: '2026-11-12T10:00:00.000Z',
        },
        ragMemories: ['Private shared secret'],
      },
      lang: 'en',
    });

    expect(overlay.privateWorkingMemory).toHaveLength(2);
    expect(overlay.publicRecentTurns).toHaveLength(2);
    expect(overlay.effectiveLastReplyDate).toBe('2026-11-12T10:00:00.000Z');
    expect(overlay.timelineSummary).toBe('Posted about studio practice');
    expect(overlay.ragMemories).toEqual([
      '[Private Lounge Memory] Private shared secret',
      '[Public X Memory] User likes jazz',
    ]);

    // Verify defensive copy preserves public isolation even if private overlay fields are inspected/mutated
    expect(overlay.publicUser).not.toBe(publicSnapshot.user);
    expect(overlay.publicUser?.coreProfile).toEqual({ hobby: 'music' });
  });

  it('handles missing public memory cleanly without adding redundant tags to private RAG memories', () => {
    const overlay = composeAsymmetricMemoryOverlay({
      publicMemory: null,
      privateMemory: {
        user: {
          id: 'x_user_002',
          coreProfile: {},
          episodicBuffer: [],
        },
        ragMemories: ['Only private memory', ''],
      },
    });

    expect(overlay.publicUser).toBeNull();
    expect(overlay.publicRecentTurns).toEqual([]);
    expect(overlay.privateWorkingMemory).toEqual([]);
    expect(overlay.effectiveLastReplyDate).toBeUndefined();
    expect(overlay.ragMemories).toEqual(['Only private memory']);
  });

  it('uses public lastReplyDate when private lastReplyDate is missing or older, and ignores invalid dates', () => {
    const fromPublicOnly = composeAsymmetricMemoryOverlay({
      publicMemory: {
        user: {
          lastReplyDate: '2026-11-14T08:00:00.000Z',
        },
      },
      privateMemory: {
        user: {
          lastReplyDate: 'invalid-date',
        },
      },
      lang: 'ja',
    });
    expect(fromPublicOnly.effectiveLastReplyDate).toBe('2026-11-14T08:00:00.000Z');

    const privateOnly = composeAsymmetricMemoryOverlay({
      publicMemory: {
        user: {
          lastReplyDate: '2026-11-01T00:00:00.000Z',
        },
        ragMemories: ['X episode'],
      },
      privateMemory: {
        user: {
          lastReplyDate: '2026-11-15T00:00:00.000Z',
        },
        ragMemories: ['Private episode'],
      },
      lang: 'ja',
    });
    expect(privateOnly.effectiveLastReplyDate).toBe('2026-11-15T00:00:00.000Z');
    expect(privateOnly.ragMemories).toEqual([
      '【ラウンジ秘密対話の記憶】 Private episode',
      '【X公開対話の記憶】 X episode',
    ]);
  });
});
