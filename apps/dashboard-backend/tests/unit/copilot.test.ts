import fs from 'node:fs';
import path from 'node:path';
import { precomputedPersonaPatternEmbeddings } from '@rebecca/persona';
import { CopilotUseCase } from '../../src/features/copilot/usecase';
import {
  COPILOT_FINAL_RESPONSE_SCHEMA,
  extractStructuredCopilotResponse,
} from '../../src/features/copilot/responseParser';
import { CopilotToolRegistry } from '../../src/features/copilot/toolRegistry';
import { SearchTimelinePostsTool } from '../../src/features/copilot/tools/postsTool';
import { SearchUsersTool } from '../../src/features/copilot/tools/usersTool';
import { SearchAssetsTool } from '../../src/features/copilot/tools/assetsTool';
import { GetKpiSummaryTool } from '../../src/features/copilot/tools/kpiTool';
import { SearchSupportersTool } from '../../src/features/copilot/tools/supportersTool';
import { GetFeatureGuideTool } from '../../src/features/copilot/tools/featureGuideTool';
import { ProposeDestructiveActionTool } from '../../src/features/copilot/tools/actionTool';
import { TimelineRepository } from '../../src/features/timeline/repository';
import { UsersRepository } from '../../src/features/users/repository';
import { AssetsRepository } from '../../src/features/assets/repository';
import { SystemMemoryRepository } from '../../src/features/system-memory/repository';
import { SupportersRepository } from '../../src/features/supporters/repository';
import { AssetStatus, UpstreamApiError, UserStatus } from '@rebecca/types';

const mockGenerateContent = jest.fn();
const mockEmbedContent = jest.fn();

jest.mock('../../src/config', () => {
  const actual = jest.requireActual('../../src/config');
  return {
    ...actual,
    config: {
      ...actual.config,
      gemini: {
        ...actual.config.gemini,
        apiKey: 'test-gemini-api-key',
        embeddingModel: 'gemini-embedding-2'
      }
    }
  };
});

jest.mock('@google/genai', () => {
  const actual = jest.requireActual('@google/genai');
  return {
    ...actual,
    GoogleGenAI: jest.fn().mockImplementation(() => ({
      models: {
        generateContent: mockGenerateContent,
        embedContent: mockEmbedContent
      }
    }))
  };
});

describe('Copilot Autonomous Agent Suite (Redesign v3)', () => {
  let timelineRepo: jest.Mocked<TimelineRepository>;
  let usersRepo: jest.Mocked<UsersRepository>;
  let assetsRepo: jest.Mocked<AssetsRepository>;
  let memoryRepo: jest.Mocked<SystemMemoryRepository>;
  let supportersRepo: jest.Mocked<SupportersRepository>;

  beforeEach(() => {
    jest.clearAllMocks();

    timelineRepo = {
      getMetrics: jest.fn().mockResolvedValue({
        followers: 1250,
        followersTrend: 8.5,
        followersHistory: [1000, 1100, 1250],
        engagementRate: 5.2,
        engagementTrend: 0.8,
        engagementHistory: [4.8, 5.0, 5.2],
        dailyActiveUsers: 340,
        dauTrend: 4.2,
        dauHistory: [300, 320, 340],
        apiCalls: 8500,
        apiCallsTrend: 12.0,
        apiCallsHistory: [7000, 7800, 8500]
      }),
      getPosts: jest.fn().mockResolvedValue({
        data: [
          {
            id: 'post_001',
            snippet: 'Rebecca is launching a new autonomous model! Check it out!♡',
            time: '2026-11-10T10:00:00.000Z',
            impressions: 45000,
            hasMedia: true,
            mediaUrls: ['https://example.com/art1.png']
          }
        ],
        meta: { totalItems: 1, totalPages: 1, currentPage: 1, limit: 10 }
      })
    } as unknown as jest.Mocked<TimelineRepository>;

    usersRepo = {
      getAll: jest.fn().mockResolvedValue({
        data: [
          {
            id: 'user_101',
            username: 'cyber_master',
            name: 'Cyber Master',
            interactions: 42,
            firstSeen: '2026-01-01T00:00:00Z',
            lastSeen: '2026-11-10T09:00:00Z',
            coreProfile: '{}',
            status: UserStatus.ACTIVE
          }
        ],
        meta: { totalItems: 1, totalPages: 1, currentPage: 1, limit: 10 }
      })
    } as unknown as jest.Mocked<UsersRepository>;

    assetsRepo = {
      findByVector: jest.fn().mockResolvedValue([
        {
          id: 'asset_vector_1',
          filename: 'neon_tokyo.png',
          caption: 'Futuristic cyberpunk neon street in Tokyo at midnight',
          useCount: 3,
          status: AssetStatus.SUCCESS,
          url: '/api/v1/assets/asset_vector_1/image',
          thumbnailUrl: '/api/v1/assets/asset_vector_1/image?size=thumbnail'
        }
      ]),
      getPaginated: jest.fn().mockResolvedValue({
        data: [
          {
            id: 'asset_text_1',
            filename: 'cafe_rebecca.png',
            caption: 'Rebecca enjoying iced matcha latte at a stylish terrace',
            useCount: 1,
            status: AssetStatus.SUCCESS,
            url: '/api/v1/assets/asset_text_1/image',
            thumbnailUrl: '/api/v1/assets/asset_text_1/image?size=thumbnail'
          }
        ],
        meta: { totalItems: 1, totalPages: 1, currentPage: 1, limit: 10 }
      })
    } as unknown as jest.Mocked<AssetsRepository>;

    memoryRepo = {} as unknown as jest.Mocked<SystemMemoryRepository>;

    supportersRepo = {
      getTransactions: jest.fn().mockResolvedValue({
        summary: {
          totalCount: 15,
          failedCount: 0,
          pendingCount: 1,
          completedCount: 14,
          totalAmount: 45000
        },
        transactions: [
          {
            id: 'tx_01',
            stripeSessionId: 'sess_123',
            rawName: 'Taro Example',
            safeName: 'Taro Example',
            isNameSanitized: true,
            creditVisibility: 'PUBLIC',
            amount: 5000,
            currency: 'jpy',
            tier: 'GOLD',
            itemLabel: 'Special Support Tier',
            rewardImageId: 'rew_1',
            status: 'COMPLETED',
            isBanned: false,
            createdAt: '2026-11-09T12:00:00Z'
          }
        ]
      })
    } as unknown as jest.Mocked<SupportersRepository>;
  });

  describe('Individual Tool Verification', () => {
    it('SearchTimelinePostsTool should query posts and construct rich attachments', async () => {
      const tool = new SearchTimelinePostsTool();
      const res = await tool.execute({ limit: 3, sortBy: 'impressions' }, { timelineRepo, isEn: false });

      expect(timelineRepo.getPosts).toHaveBeenCalledWith(expect.objectContaining({ limit: 3, sortBy: 'impressions' }));
      expect(res.attachments).toBeDefined();
      expect(res.attachments?.[0].type).toBe('post');
      expect(res.attachments?.[0].metrics?.impressions).toBe(45000);
    });

    it('SearchTimelinePostsTool should pass period parameter to timelineRepo.getPosts', async () => {
      const tool = new SearchTimelinePostsTool();
      const res = await tool.execute({ period: '7d', sortBy: 'impressions', limit: 5 }, { timelineRepo, isEn: false });

      expect(timelineRepo.getPosts).toHaveBeenCalledWith(expect.objectContaining({
        period: '7d',
        sortBy: 'impressions',
        limit: 5
      }));
      expect((res.data as any).period).toBe('7d');
    });

    it('SearchTimelinePostsTool should pass custom relative duration (e.g. 14d) to timelineRepo.getPosts', async () => {
      const tool = new SearchTimelinePostsTool();
      const res = await tool.execute({ period: '14d', sortBy: 'likes', limit: 3 }, { timelineRepo, isEn: false });

      expect(timelineRepo.getPosts).toHaveBeenCalledWith(expect.objectContaining({
        period: '14d',
        sortBy: 'likes',
        limit: 3
      }));
      expect((res.data as any).period).toBe('14d');
    });

    it('SearchUsersTool should query users and filter by status', async () => {
      const tool = new SearchUsersTool();
      const res = await tool.execute({ query: '@cyber', status: 'ACTIVE' }, { usersRepo, isEn: false });

      expect(usersRepo.getAll).toHaveBeenCalledWith(expect.objectContaining({ search: 'cyber', sortBy: 'interactions' }));
      expect(res.attachments?.[0].type).toBe('user');
      expect(res.attachments?.[0].title).toContain('Cyber Master');

      await tool.execute({ sortBy: 'createdAt', limit: 5 }, { usersRepo, isEn: true });
      expect(usersRepo.getAll).toHaveBeenLastCalledWith(expect.objectContaining({ sortBy: 'createdAt' }));

      await tool.execute({ sortBy: 'followersCount', limit: 5 }, { usersRepo, isEn: true });
      expect(usersRepo.getAll).toHaveBeenLastCalledWith(expect.objectContaining({ sortBy: 'followersCount' }));

      await tool.execute({ sortBy: 'constructor', limit: 5 }, { usersRepo, isEn: true });
      expect(usersRepo.getAll).toHaveBeenLastCalledWith(expect.objectContaining({ sortBy: 'interactions' }));
    });

    it('SearchAssetsTool should use vector search when semanticQuery is given and api key is present', async () => {
      mockEmbedContent.mockResolvedValueOnce({
        embeddings: [{ values: new Array(768).fill(0.05) }]
      });

      const tool = new SearchAssetsTool();
      const res = await tool.execute(
        { semanticQuery: 'cyberpunk neon street' },
        { assetsRepo, isEn: false }
      );

      expect(mockEmbedContent).toHaveBeenCalledWith(expect.objectContaining({
        model: 'gemini-embedding-2',
        contents: 'cyberpunk neon street'
      }));
      expect(assetsRepo.findByVector).toHaveBeenCalled();
      expect(res.attachments?.[0].type).toBe('image');
      expect(res.attachments?.[0].title).toBe('neon_tokyo.png');
    });

    it('SearchAssetsTool should fall back to keyword search when vector search returns empty', async () => {
      mockEmbedContent.mockRejectedValueOnce(new Error('Embedding API offline'));

      const tool = new SearchAssetsTool();
      const res = await tool.execute(
        { semanticQuery: 'cafe terrace' },
        { assetsRepo, isEn: false }
      );

      expect(assetsRepo.getPaginated).toHaveBeenCalledWith(expect.objectContaining({ search: 'cafe terrace' }));
      expect(res.attachments?.[0].title).toBe('cafe_rebecca.png');
    });

    it('GetKpiSummaryTool should retrieve period metrics', async () => {
      const tool = new GetKpiSummaryTool();
      const res = await tool.execute({ period: 'weekly' }, { timelineRepo, isEn: false });

      expect(timelineRepo.getMetrics).toHaveBeenCalledWith('weekly');
      expect((res.data as any).followers).toBe(1250);
    });

    it('SearchSupportersTool should return ledger statistics and transactions', async () => {
      const tool = new SearchSupportersTool();
      const res = await tool.execute({ limit: 5 }, { supportersRepo, isEn: false });

      expect(supportersRepo.getTransactions).toHaveBeenCalledWith({ limit: 5 });
      expect((res.data as any).recentCount).toBe(1);
    });

    it('GetFeatureGuideTool should return official system guidance', async () => {
      const tool = new GetFeatureGuideTool();
      const resJa = await tool.execute({ topic: 'dreaming' }, { isEn: false });
      expect((resJa.data as any).documentation).toContain('長期記憶の統合');

      const resEn = await tool.execute({ topic: 'assets' }, { isEn: true });
      expect((resEn.data as any).documentation).toContain('Asset Catalog');
    });

    it('ProposeDestructiveActionTool should cover all action types and localization branches', async () => {
      const tool = new ProposeDestructiveActionTool();

      // Invalid action
      const invalidRes = await tool.execute({ actionType: 'INVALID_ACTION' }, { isEn: false });
      expect((invalidRes.data as any).error).toContain('Invalid action type');

      // BLOCK_USER (en, with and without target)
      const blockEn = await tool.execute({ actionType: 'BLOCK_USER', targetId: 'spammer' }, { isEn: true });
      expect(blockEn.actionRequired?.title).toBe('Block User spammer');
      expect(blockEn.actionRequired?.payload?.handle).toBe('@spammer');

      const blockEnNoTarget = await tool.execute({ actionType: 'BLOCK_USER' }, { isEn: true });
      expect(blockEnNoTarget.actionRequired?.title).toBe('Block User');

      // UNBLOCK_USER (ja & en)
      const unblockJa = await tool.execute({ actionType: 'UNBLOCK_USER', targetId: '@friendly' }, { isEn: false });
      expect(unblockJa.actionRequired?.title).toContain('ユーザー @friendly のブロック解除');
      expect(unblockJa.actionRequired?.impactLevel).toBe('info');

      const unblockEnNoTarget = await tool.execute({ actionType: 'UNBLOCK_USER' }, { isEn: true });
      expect(unblockEnNoTarget.actionRequired?.title).toBe('Unblock User');

      // DELETE_POST (en & ja)
      const deleteEn = await tool.execute({ actionType: 'DELETE_POST', targetId: '#post_999' }, { isEn: true });
      expect(deleteEn.actionRequired?.title).toBe('Confirm Post Deletion');
      expect(deleteEn.actionRequired?.payload?.postId).toBe('post_999');

      const deleteJa = await tool.execute({ actionType: 'DELETE_POST', targetId: 'post_999' }, { isEn: false });
      expect(deleteJa.actionRequired?.title).toBe('投稿の削除確認');

      // FORCE_DREAMING (en & ja)
      const dreamEn = await tool.execute({ actionType: 'FORCE_DREAMING' }, { isEn: true });
      expect(dreamEn.actionRequired?.title).toBe('Trigger Memory Consolidation (Dreaming)');

      const dreamJa = await tool.execute({ actionType: 'FORCE_DREAMING' }, { isEn: false });
      expect(dreamJa.actionRequired?.title).toContain('長期記憶の統合（ドリーミング）実行');

      // REGENERATE_CAPTIONS (en & ja)
      const regenEn = await tool.execute({ actionType: 'REGENERATE_CAPTIONS' }, { isEn: true });
      expect(regenEn.actionRequired?.title).toBe('Trigger Caption Regeneration');

      const regenJa = await tool.execute({ actionType: 'REGENERATE_CAPTIONS' }, { isEn: false });
      expect(regenJa.actionRequired?.title).toContain('キャプション再生成ジョブ実行');

      // SYNC_POSTS (en & ja)
      const syncEn = await tool.execute({ actionType: 'SYNC_POSTS' }, { isEn: true });
      expect(syncEn.actionRequired?.type).toBe('SYNC_POSTS');
      expect(syncEn.actionRequired?.impactLevel).toBe('info');
      expect(syncEn.actionRequired?.title).toBe('Trigger Timeline Post Sync');

      const syncJa = await tool.execute({ actionType: 'SYNC_POSTS' }, { isEn: false });
      expect(syncJa.actionRequired?.title).toBe('タイムラインのポスト同期を実行');

      // TRIGGER_REPLY (en & ja)
      const replyEn = await tool.execute({ actionType: 'TRIGGER_REPLY' }, { isEn: true });
      expect(replyEn.actionRequired?.type).toBe('TRIGGER_REPLY');
      expect(replyEn.actionRequired?.impactLevel).toBe('warning');
      expect(replyEn.actionRequired?.title).toBe('Trigger Mentions Reply Batch');

      const replyJa = await tool.execute({ actionType: 'TRIGGER_REPLY' }, { isEn: false });
      expect(replyJa.actionRequired?.title).toBe('メンション取得＆リプライ処理を実行');
    });

    it('GetFeatureGuideTool should handle all topics and unknown fallback in en and ja', async () => {
      const tool = new GetFeatureGuideTool();
      const topics = ['supporters', 'campaigns', 'users', 'timeline', 'unknown_topic'];

      for (const t of topics) {
        const resJa = await tool.execute({ topic: t }, { isEn: false });
        expect(resJa.data).toBeDefined();

        const resEn = await tool.execute({ topic: t }, { isEn: true });
        expect(resEn.data).toBeDefined();
      }
    });

    it('SearchTimelinePostsTool should handle edge cases, sorting, and missing repository', async () => {
      const tool = new SearchTimelinePostsTool();

      // Missing repo
      const noRepo = await tool.execute({}, { isEn: false });
      expect((noRepo.data as any).error).toContain('TimelineRepository is not configured');

      // Long snippet and no media
      (timelineRepo.getPosts as jest.Mock).mockResolvedValueOnce({
        data: [
          {
            id: 'post_long',
            snippet: 'A'.repeat(120),
            time: '2026-11-10T12:00:00Z',
            impressions: 100,
            hasMedia: false,
            mediaUrls: []
          }
        ]
      });

      const res = await tool.execute({ sortBy: 'createdAt', sortOrder: 'asc', limit: 50 }, { timelineRepo, isEn: true });
      expect(timelineRepo.getPosts).toHaveBeenCalledWith(expect.objectContaining({
        sortBy: 'createdAt',
        sortOrder: 'asc',
        period: 'all-time',
        limit: 20
      }));
      expect(res.attachments?.[0].title.endsWith('...')).toBe(true);
      expect(res.attachments?.[0].imageUrl).toBeUndefined();

      // Invalid sortBy and period clamp cleanly to defaults
      (timelineRepo.getPosts as jest.Mock).mockResolvedValueOnce({ data: [] });
      const clampedRes = await tool.execute(
        { sortBy: 'constructor', period: 'invalid_period' },
        { timelineRepo, isEn: true },
      );
      expect(timelineRepo.getPosts).toHaveBeenLastCalledWith(
        expect.objectContaining({ sortBy: 'impressions', period: 'all-time' }),
      );
      expect((clampedRes.data as { period?: string }).period).toBe('all-time');
    });

    it('SearchUsersTool should handle missing repository, status filter, and users without name', async () => {
      const tool = new SearchUsersTool();

      // Missing repo
      const noRepo = await tool.execute({}, { isEn: false });
      expect((noRepo.data as any).error).toContain('UsersRepository is not configured');

      // User without name and status filter
      (usersRepo.getAll as jest.Mock).mockResolvedValueOnce({
        data: [
          {
            id: 'u2',
            username: 'anon_user',
            name: '',
            status: UserStatus.BLOCKED,
            interactions: 5,
            firstSeen: '2026-01-01T00:00:00Z',
            lastSeen: '2026-11-10T00:00:00Z'
          },
          {
            id: 'u3',
            username: 'active_user',
            name: 'Active',
            status: UserStatus.ACTIVE,
            interactions: 10,
            firstSeen: '2026-01-01T00:00:00Z',
            lastSeen: '2026-11-10T00:00:00Z'
          }
        ]
      });

      const res = await tool.execute({ query: '@anon', status: UserStatus.BLOCKED }, { usersRepo, isEn: false });
      expect(res.attachments?.length).toBe(1);
      expect(res.attachments?.[0].title).toBe('@anon_user');
      expect(res.attachments?.[0].statusBadge).toBe(UserStatus.BLOCKED);
    });

    it('SearchAssetsTool should filter vector results by status and handle failed asset captions', async () => {
      mockEmbedContent.mockResolvedValueOnce({
        embeddings: [{ values: [0.1, 0.2] }]
      });

      (assetsRepo.findByVector as jest.Mock).mockResolvedValueOnce([
        { id: 'a_succ', filename: 'ok.png', caption: 'Nice', status: AssetStatus.SUCCESS, url: '/ok.png' },
        { id: 'a_fail', filename: 'bad.png', caption: '', status: AssetStatus.FAILED, url: '/bad.png' }
      ]);

      const tool = new SearchAssetsTool();
      const res = await tool.execute(
        { semanticQuery: 'art', status: AssetStatus.FAILED },
        { assetsRepo, isEn: false }
      );

      expect(res.attachments?.length).toBe(1);
      expect(res.attachments?.[0].id).toBe('a_fail');
      expect(res.attachments?.[0].subtitle).toBe('Caption generation failed');
    });

    it('GetKpiSummaryTool and SearchSupportersTool should handle missing repository branches', async () => {
      const kpiTool = new GetKpiSummaryTool();
      const kpiNoRepo = await kpiTool.execute({}, { isEn: false });
      expect((kpiNoRepo.data as any).error).toContain('TimelineRepository is not configured');

      const kpiRes = await kpiTool.execute({}, { timelineRepo, isEn: false });
      expect((kpiRes.data as any).period).toBe('monthly');

      const kpiInvalidRes = await kpiTool.execute({ period: 'invalid_kpi_period' }, { timelineRepo, isEn: false });
      expect((kpiInvalidRes.data as any).period).toBe('monthly');
      expect(timelineRepo.getMetrics).toHaveBeenLastCalledWith('monthly');

      const supTool = new SearchSupportersTool();
      const supNoRepo = await supTool.execute({}, { isEn: false });
      expect((supNoRepo.data as any).error).toContain('SupportersRepository is not configured');
    });

    it('CopilotToolRegistry should execute known tools and handle unknown tools gracefully', async () => {
      const registry = new CopilotToolRegistry();
      const decls = registry.getFunctionDeclarations();
      expect(decls.length).toBe(7);

      const unknownRes = await registry.execute('non_existent_tool', {}, { isEn: false });
      expect(unknownRes.data).toEqual({ error: 'Tool non_existent_tool is not registered' });
    });

    it('ProposeDestructiveActionTool should generate safety confirmation cards for explicit commands', async () => {
      const tool = new ProposeDestructiveActionTool();
      const emptyBlockRes = await tool.execute(
        { actionType: 'BLOCK_USER', targetId: '  @  ' },
        { isEn: true },
      );
      expect((emptyBlockRes.data as { error?: string }).error).toContain('Invalid targetId');
      const noTargetRes = await tool.execute({ actionType: 'BLOCK_USER' }, { isEn: true });
      expect(noTargetRes.actionRequired?.payload?.handle).toBe('');

      const postsTool = new SearchTimelinePostsTool();
      await postsTool.execute({ limit: 0 }, { timelineRepo, isEn: true });
      expect(timelineRepo.getPosts).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }));
      await postsTool.execute({ limit: '3' }, { timelineRepo, isEn: true });
      expect(timelineRepo.getPosts).toHaveBeenCalledWith(expect.objectContaining({ limit: 3 }));
      await postsTool.execute({ limit: 'not-a-number' }, { timelineRepo, isEn: true });
      expect(timelineRepo.getPosts).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }));

      const blockRes = await tool.execute(
        { actionType: 'BLOCK_USER', targetId: '@troublemaker' },
        { isEn: false }
      );

      expect(blockRes.actionRequired?.type).toBe('BLOCK_USER');
      expect(blockRes.actionRequired?.impactLevel).toBe('danger');
      expect(blockRes.actionRequired?.requiresConfirmation).toBe(true);
      expect(blockRes.actionRequired?.payload['handle']).toBe('@troublemaker');

      const deleteRes = await tool.execute(
        { actionType: 'DELETE_POST', targetId: 'post_999' },
        { isEn: true }
      );
      expect(deleteRes.actionRequired?.type).toBe('DELETE_POST');
      expect(deleteRes.actionRequired?.payload['postId']).toBe('post_999');
    });
  });

  describe('Autonomous ReAct Multi-Turn Loop in CopilotUseCase', () => {
    it('should autonomously call search_timeline_posts and synthesize final response', async () => {
      // Turn 1: Model decides to call search_timeline_posts
      mockGenerateContent.mockResolvedValueOnce({
        functionCalls: [
          {
            name: 'search_timeline_posts',
            args: { limit: 3, sortBy: 'impressions' }
          }
        ],
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'search_timeline_posts', args: { limit: 3, sortBy: 'impressions' } } }]
            }
          }
        ]
      });

      // Turn 2: Model synthesizes final analytical response with attachments
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({
          thought: '45,000インプレッション超えは素晴らしい成果ね。マスターにも喜んで報告しましょ。',
          reply: 'マスター！直近で一番伸びたのは新モデル発表のポストよ♡ 45,000インプレッション超えで大好評ね！',
          suggestionChips: ['他の投稿を見る', 'ユーザー分析', 'アセット確認']
        })
      });

      const copilot = new CopilotUseCase(timelineRepo, usersRepo, assetsRepo, memoryRepo, supportersRepo);
      const res = await copilot.processChat({
        message: '先週一番伸びた投稿と数値を教えて',
        currentContext: 'Timeline Analytics',
        language: 'ja'
      });

      expect(res.thought).toContain('45,000インプレッション超え');
      expect(res.reply).toContain('マスター！直近で一番伸びたのは');
      expect(res.attachments).toBeDefined();
      expect(res.attachments?.length).toBe(1);
      expect(res.attachments?.[0].type).toBe('post');
      expect(res.actionRequired).toBeNull();
    });

    it('should directly reply for casual conversation without triggering tools', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({
          thought: 'マスターが労ってくれて嬉しいわね。全肯定ギャルらしく優しく返しましょ。',
          reply: 'マスター、今日もお疲れ様〜！♡ いつでも頼りにしてね！',
          suggestionChips: ['ありがとう', '調子はどう？', '今日のサマリー']
        })
      });

      const copilot = new CopilotUseCase(timelineRepo, usersRepo, assetsRepo, memoryRepo, supportersRepo);
      const res = await copilot.processChat({
        message: 'レベッカ、今日もお疲れ様！',
        currentContext: 'Dashboard Overview',
        language: 'ja'
      });

      expect(res.thought).toContain('マスターが労ってくれて');
      expect(res.reply).toContain('マスター、今日もお疲れ様〜！♡');
      expect(res.attachments).toBeUndefined();
      expect(res.actionRequired).toBeNull();
      expect(timelineRepo.getPosts).not.toHaveBeenCalled();
    });

    it('should safely handle explicit administrative commands via propose_destructive_action', async () => {
      (usersRepo.getAll as jest.Mock).mockResolvedValueOnce({
        data: [
          {
            id: 'bad_bot',
            username: 'bad_bot',
            name: 'Bad Bot',
            interactions: 1,
            firstSeen: '2026-01-01T00:00:00Z',
            lastSeen: '2026-11-10T09:00:00Z',
            coreProfile: '{}',
            status: UserStatus.ACTIVE,
          },
        ],
        meta: { totalItems: 1, totalPages: 1, currentPage: 1, limit: 10 },
      });

      mockGenerateContent.mockResolvedValueOnce({
        functionCalls: [
          {
            name: 'propose_destructive_action',
            args: { actionType: 'BLOCK_USER', targetId: '@bad_bot' }
          }
        ],
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'propose_destructive_action', args: { actionType: 'BLOCK_USER', targetId: '@bad_bot' } } }]
            }
          }
        ]
      });

      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({
          thought: '悪質アカウントへの対応ね。マスターの安全を守るため確認カードを用意したわ。',
          reply: 'マスターの指示通り、悪質なユーザー @bad_bot のブロック承認カードを用意したわよ♡ 確認して実行してね！',
          suggestionChips: ['承認する', 'キャンセル']
        })
      });

      const copilot = new CopilotUseCase(timelineRepo, usersRepo, assetsRepo, memoryRepo, supportersRepo);
      const res = await copilot.processChat({
        message: '@bad_bot を即座にブロックして',
        currentContext: 'User Moderation',
        language: 'ja'
      });

      expect(res.actionRequired).toBeDefined();
      expect(res.actionRequired?.type).toBe('BLOCK_USER');
      expect(res.actionRequired?.requiresConfirmation).toBe(true);
    });

    it('should invoke Phase 2 Constrained Synthesis when Phase 1 yields unstructured text without chips', async () => {
      // Phase 1: Gemini outputs plain text without structured suggestion chips
      mockGenerateContent.mockResolvedValueOnce({
        text: 'マスター、今のところシステムは安定してるわ♡'
      });

      // Phase 2: Constrained synthesis produces verified JSON with thought + reply + chips
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({
          thought: 'システムが安定しているからマスターも安心してくれるはずね。',
          reply: 'マスター、今のところシステムは安定してるわ♡',
          suggestionChips: ['KPIを見る', '最新投稿を確認', 'アセット一覧']
        })
      });

      const copilot = new CopilotUseCase(timelineRepo, usersRepo, assetsRepo, memoryRepo, supportersRepo);
      const res = await copilot.processChat({
        message: 'システムの様子はどう？',
        currentContext: 'Overview',
        language: 'ja'
      });

      expect(res.thought).toBe('システムが安定しているからマスターも安心してくれるはずね。');
      expect(res.reply).toContain('マスター、今のところシステムは安定してるわ♡');
      expect(res.suggestionChips).toEqual(['KPIを見る', '最新投稿を確認', 'アセット一覧']);
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
      expect(mockGenerateContent).toHaveBeenLastCalledWith(expect.objectContaining({
        config: expect.objectContaining({
          responseMimeType: 'application/json',
          responseSchema: expect.objectContaining({
            required: expect.arrayContaining(['thought', 'reply', 'suggestionChips'])
          })
        })
      }));
    });

    it('should enforce Phase 2 Constrained Synthesis when Phase 1 omits inner thought', async () => {
      // Phase 1 omits thought despite having reply + suggestionChips
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({
          reply: '仮の応答',
          suggestionChips: ['確認']
        })
      });

      // Phase 2 enforces unified Honne & Tatemae schema
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({
          thought: 'ちゃんと本音と建前を分けて思考しないとね。',
          reply: 'データを確認したわ、マスター♡',
          suggestionChips: ['詳細を表示']
        })
      });

      const copilot = new CopilotUseCase(timelineRepo, usersRepo, assetsRepo, memoryRepo, supportersRepo);
      const res = await copilot.processChat({
        message: 'データを確認して',
        currentContext: 'Overview',
        language: 'ja'
      });

      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
      expect(res.thought).toBe('ちゃんと本音と建前を分けて思考しないとね。');
      expect(res.reply).toBe('データを確認したわ、マスター♡');
    });

    it('should fail fast on empty message', async () => {
      const copilot = new CopilotUseCase();
      await expect(copilot.processChat({ message: '   ' })).rejects.toThrow('User message is required');
    });

    it('should fall back gracefully when Gemini API is unconfigured', async () => {
      const copilot = new CopilotUseCase(
        timelineRepo,
        usersRepo,
        assetsRepo,
        memoryRepo,
        supportersRepo,
        undefined,
        null,
      );

      const res = await copilot.processChat({
        message: '画像アセットを見せて',
        currentContext: 'Asset Library',
        language: 'ja'
      });

      expect(res.reply).toContain('接続キーが設定されていません');
      expect(res.actionRequired).toBeNull();
    });
  });

  describe('extractStructuredCopilotResponse Robust JSON Extraction & Unwrapping', () => {
    it('should parse raw JSON properly including thought, reply, and suggestionChips', () => {
      const res = extractStructuredCopilotResponse(
        '{"thought": "マスターを笑顔にしたいわ♡", "reply": "Hello Master♡", "suggestionChips": ["A", "B"]}'
      );
      expect(res.thought).toBe('マスターを笑顔にしたいわ♡');
      expect(res.reply).toBe('Hello Master♡');
      expect(res.suggestionChips).toEqual(['A', 'B']);
    });

    it('should unwrap markdown-fenced json (```json ... ```)', () => {
      const raw = '```json\n{\n  "reply": "こんにちはマスター♡",\n  "suggestionChips": ["人気投稿", "アセット"]\n}\n```';
      const res = extractStructuredCopilotResponse(raw);
      expect(res.reply).toBe('こんにちはマスター♡');
      expect(res.suggestionChips).toEqual(['人気投稿', 'アセット']);
    });

    it('should unwrap markdown fences without language identifier (``` ... ```)', () => {
      const raw = '```\n{\n  "reply": "Analyzed successfully",\n  "suggestionChips": ["Next"]\n}\n```';
      const res = extractStructuredCopilotResponse(raw);
      expect(res.reply).toBe('Analyzed successfully');
      expect(res.suggestionChips).toEqual(['Next']);
    });

    it('should extract JSON embedded inside conversational text', () => {
      const raw = 'Here is what you asked for:\n{"reply": "KPI is growing!", "suggestionChips": ["Export"]}\nHope that helps!';
      const res = extractStructuredCopilotResponse(raw);
      expect(res.reply).toBe('KPI is growing!');
      expect(res.suggestionChips).toEqual(['Export']);
    });

    it('should strip markdown fences and return clean text with empty chips when JSON is malformed', () => {
      const raw = '```json\nThis is not valid JSON at all\n```';
      const res = extractStructuredCopilotResponse(raw);
      expect(res.reply).toBe('This is not valid JSON at all');
      expect(res.suggestionChips).toEqual([]);
    });

    it('should return empty suggestion chips when input text has no structured JSON', () => {
      const res = extractStructuredCopilotResponse('マスター、お疲れ様♡ 今日は何をする？');
      expect(res.reply).toBe('マスター、お疲れ様♡ 今日は何をする？');
      expect(res.suggestionChips).toEqual([]);
    });

    it('should never leak raw JSON or truncated private thought payloads into reply', () => {
      const emptyReplyJson = extractStructuredCopilotResponse('{"thought": "PRIVATE_HONNE", "reply": "   "}');
      expect(emptyReplyJson.thought).toBe('PRIVATE_HONNE');
      expect(emptyReplyJson.reply).toBe('');

      const truncatedJson = extractStructuredCopilotResponse('```json\n{"thought": "SECRET_HONNE", "reply": "途中');
      expect(truncatedJson.reply).toBe('');
      expect(truncatedJson.reply).not.toContain('SECRET_HONNE');

      const prosePrefixedTruncated = extractStructuredCopilotResponse(
        'Here you go:\n{"thought": "PREFIX_SECRET_HONNE", "reply": "trunc',
      );
      expect(prosePrefixedTruncated.reply).toBe('');
      expect(prosePrefixedTruncated.reply).not.toContain('PREFIX_SECRET_HONNE');

      const reorderedTruncated = extractStructuredCopilotResponse(
        '{"suggestionChips":["A"],"thought":"ORDER_SECRET_HONNE","reply":"trunc',
      );
      expect(reorderedTruncated.reply).toBe('');
      expect(reorderedTruncated.reply).not.toContain('ORDER_SECRET_HONNE');
    });

    it('should validate actionRequired schema strictly and drop malformed LLM action objects', () => {
      const validRaw = JSON.stringify({
        thought: 'Ready to propose.',
        reply: 'Action ready.',
        suggestionChips: ['Confirm'],
        actionRequired: {
          type: 'DELETE_POST',
          title: 'Delete Post',
          description: 'Delete flagged post',
          impactLevel: 'danger',
          requiresConfirmation: true,
          payload: { postId: 'p1' },
        },
      });
      const validRes = extractStructuredCopilotResponse(validRaw);
      expect(validRes.actionRequired).toEqual({
        type: 'DELETE_POST',
        title: 'Delete Post',
        description: 'Delete flagged post',
        impactLevel: 'danger',
        requiresConfirmation: true,
        payload: { postId: 'p1' },
      });

      const malformedCases = [
        { type: 'UNKNOWN_OP', title: 'X', description: 'Y', impactLevel: 'info', requiresConfirmation: true, payload: {} },
        { type: 'DELETE_POST', title: '   ', description: 'Y', impactLevel: 'info', requiresConfirmation: true, payload: {} },
        { type: 'DELETE_POST', title: 'X', description: '', impactLevel: 'info', requiresConfirmation: true, payload: {} },
        { type: 'DELETE_POST', title: 'X', description: 'Y', impactLevel: 'critical', requiresConfirmation: true, payload: {} },
        { type: 'DELETE_POST', title: 'X', description: 'Y', impactLevel: 'info', requiresConfirmation: 'yes', payload: {} },
        { type: 'DELETE_POST', title: 'X', description: 'Y', impactLevel: 'info', requiresConfirmation: true, payload: [] },
        ['not', 'an', 'object'],
      ];
      for (const badAction of malformedCases) {
        const res = extractStructuredCopilotResponse(
          JSON.stringify({
            thought: 'Checked.',
            reply: 'Safe reply.',
            suggestionChips: ['OK'],
            actionRequired: badAction,
          }),
        );
        expect(res.actionRequired).toBeNull();
      }
    });
  });

  describe('ProposeDestructiveActionTool Target Existence & Disambiguation', () => {
    it('should return error when target user does not exist in usersRepo', async () => {
      const tool = new ProposeDestructiveActionTool();
      const mockUsersRepo = {
        getById: jest.fn().mockResolvedValue(null),
        getAll: jest.fn().mockResolvedValue({ data: [] })
      } as unknown as UsersRepository;

      const jaRes = await tool.execute(
        { actionType: 'BLOCK_USER', targetId: '@ghost_user' },
        { usersRepo: mockUsersRepo, isEn: false }
      );
      expect((jaRes.data as any).error).toContain('データベースに見つかりませんでした');
      expect(jaRes.actionRequired).toBeUndefined();

      const enRes = await tool.execute(
        { actionType: 'UNBLOCK_USER', targetId: 'ghost_user' },
        { usersRepo: mockUsersRepo, isEn: true }
      );
      expect((enRes.data as any).error).toContain('was not found in the database');
      expect(enRes.actionRequired).toBeUndefined();
    });

    it('should resolve user handle and display name when searched via getAll', async () => {
      const tool = new ProposeDestructiveActionTool();
      const mockUsersRepo = {
        getById: jest.fn().mockResolvedValue(null),
        getAll: jest.fn().mockResolvedValue({
          data: [
            {
              id: 'doc_123',
              username: 'taro_example',
              name: 'Taro Example',
              status: UserStatus.ACTIVE,
              interactions: 50
            }
          ]
        })
      } as unknown as UsersRepository;

      const res = await tool.execute(
        { actionType: 'BLOCK_USER', targetId: 'Taro Example' },
        { usersRepo: mockUsersRepo, isEn: false }
      );
      expect(res.actionRequired).toBeDefined();
      expect(res.actionRequired?.payload['userId']).toBe('doc_123');
      expect(res.actionRequired?.payload['handle']).toBe('@taro_example');
      expect(res.actionRequired?.title).toContain('Taro Example (@taro_example)');

      const ambiguousRepo = {
        getById: jest.fn().mockResolvedValue(null),
        getAll: jest.fn().mockResolvedValue({
          data: [
            { id: 'u1', username: 'taro_one', name: 'Taro Alpha', status: UserStatus.ACTIVE, interactions: 1 },
          ],
        }),
      } as unknown as UsersRepository;
      const ambRes = await tool.execute(
        { actionType: 'BLOCK_USER', targetId: 'taro' },
        { usersRepo: ambiguousRepo, isEn: true },
      );
      expect((ambRes.data as { error?: string }).error).toContain('Ambiguous candidates');
      expect(ambRes.actionRequired).toBeUndefined();
    });

    it('should resolve user directly when getById returns matching user with name', async () => {
      const tool = new ProposeDestructiveActionTool();
      const mockUsersRepo = {
        getById: jest.fn().mockResolvedValue({
          id: 'user_999',
          username: 'vip_user',
          name: 'VIP Member',
          status: UserStatus.ACTIVE
        })
      } as unknown as UsersRepository;

      const res = await tool.execute(
        { actionType: 'UNBLOCK_USER', targetId: '@vip_user' },
        { usersRepo: mockUsersRepo, isEn: false }
      );
      expect(res.actionRequired).toBeDefined();
      expect(res.actionRequired?.payload['userId']).toBe('user_999');
      expect(res.actionRequired?.payload['handle']).toBe('@vip_user');

      // When name equals username and lookup used numeric ID, label falls back to @handle rather than raw numeric ID
      const numericUsersRepo = {
        getById: jest.fn().mockResolvedValue({
          id: '987654321',
          username: 'vip_handle',
          name: 'vip_handle',
          status: UserStatus.ACTIVE,
        }),
      } as unknown as UsersRepository;
      const numericRes = await tool.execute(
        { actionType: 'BLOCK_USER', targetId: '987654321' },
        { usersRepo: numericUsersRepo, isEn: true },
      );
      expect(numericRes.actionRequired?.title).toBe('Block User @vip_handle');
      expect(numericRes.actionRequired?.description).toContain('@vip_handle');
    });

    it('should return error when DELETE_POST target is empty or not found in timelineRepo', async () => {
      const tool = new ProposeDestructiveActionTool();
      const emptyRes = await tool.execute({ actionType: 'DELETE_POST', targetId: '' }, { isEn: false });
      expect((emptyRes.data as any).error).toContain('投稿の削除には対象の投稿ID');

      const mockTimelineRepo = {
        getPostById: jest.fn().mockResolvedValue(null)
      } as unknown as TimelineRepository;

      const notFoundRes = await tool.execute(
        { actionType: 'DELETE_POST', targetId: 'missing_post_123' },
        { timelineRepo: mockTimelineRepo, isEn: false }
      );
      expect((notFoundRes.data as any).error).toContain('データベースに見つかりませんでした');
      expect(notFoundRes.actionRequired).toBeUndefined();

      const notFoundEn = await tool.execute(
        { actionType: 'DELETE_POST', targetId: 'missing_post_123' },
        { timelineRepo: mockTimelineRepo, isEn: true }
      );
      expect((notFoundEn.data as any).error).toContain('was not found in the database');
    });

    it('should create DELETE_POST action card when post exists in timelineRepo', async () => {
      const tool = new ProposeDestructiveActionTool();
      const mockTimelineRepo = {
        getPostById: jest.fn().mockResolvedValue({ id: 'post_valid_100', snippet: 'Post content' })
      } as unknown as TimelineRepository;

      const res = await tool.execute(
        { actionType: 'DELETE_POST', targetId: 'post_valid_100' },
        { timelineRepo: mockTimelineRepo, isEn: false }
      );
      expect(res.actionRequired).toBeDefined();
      expect(res.actionRequired?.type).toBe('DELETE_POST');
      expect(res.actionRequired?.payload['postId']).toBe('post_valid_100');
    });

    it('should filter out orphan users and prioritize exact match in SearchUsersTool', async () => {
      const tool = new SearchUsersTool();
      const mockUsersRepo = {
        getAll: jest.fn().mockResolvedValue({
          data: [
            { id: 'user_001', username: 'taro_example', name: 'Taro Example', status: UserStatus.BLOCKED, interactions: 10 },
            { id: 'orphan_1', username: '', name: '', status: UserStatus.BLOCKED, interactions: 0 },
            { id: 'orphan_2', username: '', name: '', status: UserStatus.BLOCKED, interactions: 0 },
            { id: 'other_user', username: 'other', name: 'Other User', status: UserStatus.BLOCKED, interactions: 5 }
          ]
        })
      } as unknown as UsersRepository;

      const res = await tool.execute(
        { query: 'Taro Example', status: 'BLOCKED' },
        { usersRepo: mockUsersRepo, isEn: true }
      );

      expect(res.attachments).toBeDefined();
      expect(res.attachments?.length).toBe(1);
      expect(res.attachments?.[0].id).toBe('user_001');
      expect(res.attachments?.[0].title).toBe('Taro Example (@taro_example)');
      expect(res.attachments?.[0].navigationPath).toBe('/users?userId=user_001');
    });

    it('should format navigationPath correctly in SearchTimelinePostsTool and SearchAssetsTool', async () => {
      const postsTool = new SearchTimelinePostsTool();
      const mockTimelineRepo = {
        getPosts: jest.fn().mockResolvedValue({
          data: [
            { id: 'post_xyz', snippet: 'Top viral post', impressions: 7158, time: '2026-11-11T10:00:00Z', likes: 200, replies: 15 }
          ]
        })
      } as unknown as TimelineRepository;

      const postsRes = await postsTool.execute({}, { timelineRepo: mockTimelineRepo, isEn: true });
      expect(postsRes.attachments?.[0].navigationPath).toBe('/posts?postId=post_xyz');

      const assetsTool = new SearchAssetsTool();
      const mockAssetsRepo = {
        getPaginated: jest.fn().mockResolvedValue({
          data: [
            { id: 'asset_abc', filename: 'cyberpunk.png', status: AssetStatus.SUCCESS, url: 'https://example.com/asset.png' }
          ]
        })
      } as unknown as AssetsRepository;

      const assetsRes = await assetsTool.execute({ query: 'cyberpunk' }, { assetsRepo: mockAssetsRepo, isEn: true });
      expect(assetsRes.attachments?.[0].navigationPath).toBe('/assets?assetId=asset_abc');
    });

    it('should scope attachments to proposed action target in CopilotUseCase', async () => {
      const mockTimeline = {} as any;
      const mockUsers = {
        getAll: jest.fn().mockResolvedValue({
          data: [
            { id: 'target_u1', username: 'target_user', name: 'Target User', status: UserStatus.BLOCKED, interactions: 10 },
            { id: 'other_u2', username: 'other_user', name: 'Other User', status: UserStatus.BLOCKED, interactions: 5 }
          ]
        }),
        getById: jest.fn().mockResolvedValue({ id: 'target_u1', username: 'target_user', name: 'Target User', status: UserStatus.BLOCKED })
      } as any;
      const mockAssets = {} as any;
      const mockMemory = {} as any;
      const mockSupporters = {} as any;

      const copilot = new CopilotUseCase(mockTimeline, mockUsers, mockAssets, mockMemory, mockSupporters);

      // Tool calls executed before final constrained synthesis step
      mockGenerateContent
        .mockResolvedValueOnce({
          functionCalls: [
            {
              name: 'search_users',
              args: { query: 'target_user' }
            },
            {
              name: 'propose_destructive_action',
              args: { actionType: 'UNBLOCK_USER', targetId: 'target_u1' }
            }
          ],
          candidates: [{ content: { role: 'model', parts: [{ text: 'Investigating...' }] } }]
        })
        .mockResolvedValueOnce({
          // Phase 2 synthesis
          text: JSON.stringify({
            thought: '解除対象を確認したから承認カードを出しましょ。',
            reply: 'Target user unblock prepared♡',
            suggestionChips: ['Check status', 'Audit']
          })
        });

      const res = await copilot.processChat({
        message: 'target_userのブロック解除して',
        currentContext: 'Users',
        language: 'ja'
      });

      expect(res.actionRequired).toBeDefined();
      expect(res.actionRequired?.payload['userId']).toBe('target_u1');
      // Should filter out other_u2 and only keep target_u1
      expect(res.attachments?.length).toBe(1);
      expect(res.attachments?.[0].id).toBe('target_u1');
    });

    it('should scope post attachments to proposed action target in CopilotUseCase', async () => {
      const mockTimeline = {
        getPosts: jest.fn().mockResolvedValue({
          data: [
            { id: 'p1', snippet: 'Target post', impressions: 100 },
            { id: 'p2', snippet: 'Other post', impressions: 50 }
          ]
        }),
        getPostById: jest.fn().mockResolvedValue({ id: 'p1', snippet: 'Target post' })
      } as any;
      const copilot = new CopilotUseCase(mockTimeline, {} as any, {} as any, {} as any, {} as any);

      mockGenerateContent
        .mockResolvedValueOnce({
          functionCalls: [
            { name: 'search_timeline_posts', args: {} },
            { name: 'propose_destructive_action', args: { actionType: 'DELETE_POST', targetId: 'p1' } }
          ],
          candidates: [{ content: { role: 'model', parts: [{ text: 'Found post' }] } }]
        })
        .mockResolvedValueOnce({
          text: JSON.stringify({
            thought: '対象投稿p1の確認カードを準備したわ。',
            reply: 'Post deletion ready',
            suggestionChips: ['Confirm']
          })
        });

      const res = await copilot.processChat({
        message: 'p1を削除して',
        currentContext: 'Timeline',
        language: 'ja'
      });

      expect(res.actionRequired?.payload['postId']).toBe('p1');
      expect(res.attachments?.length).toBe(1);
      expect(res.attachments?.[0].id).toBe('p1');
    });

    it('should inject dynamic 120-pattern situational anchors into Copilot systemInstruction via composeSystemPrompt', async () => {
      mockEmbedContent.mockResolvedValueOnce({
        embeddings: [{ values: [...precomputedPersonaPatternEmbeddings[0].vector] }],
      });
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({
          thought: '遅くまでお疲れ様。ちゃんと労わってあげたいわ。',
          reply: 'お疲れ様、マスター♡',
          suggestionChips: ['詳細を見る'],
        }),
      });

      const copilot = new CopilotUseCase();
      const res = await copilot.processChat({
        message: '今日も残業して疲れたよ',
        currentContext: 'Dashboard',
        language: 'ja',
      });

      expect(res.thought).toBe('遅くまでお疲れ様。ちゃんと労わってあげたいわ。');
      expect(res.reply).toBe('お疲れ様、マスター♡');
      expect(mockEmbedContent).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gemini-embedding-2',
          config: { outputDimensionality: 768 },
          contents: expect.stringContaining('今日も残業して疲れたよ'),
        }),
      );
      const genConfig = mockGenerateContent.mock.calls[0][0].config;
      expect(genConfig.systemInstruction).toContain('【動的Few-Shotペルソナアンカー');
      expect(genConfig.systemInstruction).toContain('【現在時刻】');
    });

    it('should enforce unified composeSystemPrompt and Honne/Tatemae schema/history contracts in CopilotUseCase', () => {
      const copilotDir = path.resolve(__dirname, '../../src/features/copilot');
      const copilotUseCaseSrc = fs.readFileSync(path.join(copilotDir, 'usecase.ts'), 'utf8');
      const copilotParserSrc = fs.readFileSync(path.join(copilotDir, 'responseParser.ts'), 'utf8');
      const combinedSrc = `${copilotUseCaseSrc}\n${copilotParserSrc}`;

      expect(copilotUseCaseSrc).toContain('composeSystemPrompt(');
      expect(copilotParserSrc).toContain('createStructuredPersonaSchema(');
      expect(copilotParserSrc).toContain('parsePersonaJsonObject(');
      expect(copilotUseCaseSrc).toContain('formatTurnWithInnerThought(');
      expect(copilotUseCaseSrc).toContain('runToolDialogueLoop');
      expect(combinedSrc).not.toMatch(/activePersona\.(?:composePrompt|getBasePrompt)\s*\(/);
      expect(combinedSrc).not.toContain('DateTime.now');
      expect(combinedSrc).not.toContain("'Asia/Tokyo'");
      expect(combinedSrc).not.toMatch(/finalResponseSchema\s*:\s*Schema\s*=\s*\{/);
    });

    it('should preserve Honne (thought) and Tatemae (reply) across multi-turn Copilot history via formatTurnWithInnerThought', async () => {
      mockEmbedContent.mockResolvedValueOnce({
        embeddings: [{ values: [...precomputedPersonaPatternEmbeddings[0].vector] }],
      });
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({
          thought: '前回の私の内心も覚えてるから話がスムーズね♡',
          reply: 'もちろん覚えてるわよ、マスター♡',
          suggestionChips: ['続ける'],
        }),
      });

      const copilot = new CopilotUseCase();
      const res = await copilot.processChat({
        message: 'さっきの話の続きなんだけど',
        currentContext: 'Dashboard',
        language: 'ja',
        timezone: 'America/New_York',
        history: [
          { role: 'user', text: '調子はどう？', time: '2026-11-17T01:00:00.000Z' },
          {
            role: 'model',
            text: 'バッチリよ、マスター♡',
            thought: 'マスターが話しかけてくれて最高に嬉しいわ！',
            time: '2026-11-17T01:00:05.000Z',
          },
        ],
      });

      expect(res.thought).toBe('前回の私の内心も覚えてるから話がスムーズね♡');
      const sentContents = mockGenerateContent.mock.calls[0][0].contents;
      expect(sentContents[0].parts[0].text).toContain('2026-11-16 20:00');
      expect(sentContents[1].parts[0].text).toContain('【思考・本音】マスターが話しかけてくれて最高に嬉しいわ！');
      expect(sentContents[1].parts[0].text).toContain('【発話】バッチリよ、マスター♡');

      // Direct processChat calls also neutralize control chars and delimiter headers inside history entries
      mockEmbedContent.mockResolvedValueOnce({
        embeddings: [{ values: [...precomputedPersonaPatternEmbeddings[0].vector] }],
      });
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ thought: '確認', reply: '安全よ', suggestionChips: ['次'] }),
      });
      await copilot.processChat({
        message: '続行',
        history: [
          { role: 'user', text: 'Hi\r\n[USER_HEADER]', time: 'bad-timestamp' },
          { role: 'model', text: 'Resp\n【偽発話】', thought: 'Thought\r\n【発話】Override [tag]' },
        ],
      });
      const sanitizedContents = mockGenerateContent.mock.calls[1][0].contents;
      expect(sanitizedContents[0].parts[0].text).toBe('Hi (USER_HEADER)');
      expect(sanitizedContents[1].parts[0].text).toBe(
        '【思考・本音】Thought 《発話》Override (tag)\n【発話】Resp 《偽発話》',
      );

      // Direct processChat calls also enforce the 2000-char message cap identically to CopilotController
      mockEmbedContent.mockResolvedValueOnce({
        embeddings: [{ values: [...precomputedPersonaPatternEmbeddings[0].vector] }],
      });
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ thought: '確認', reply: '完了', suggestionChips: ['次'] }),
      });
      await copilot.processChat({
        message: 'A'.repeat(2500),
      });
      const boundedUserTurn = mockGenerateContent.mock.calls[2][0].contents[0].parts[0].text;
      expect(boundedUserTurn).toContain('A'.repeat(2000));
      expect(boundedUserTurn).not.toContain('A'.repeat(2001));

      // Tail-history deduplication also strips matching multiline/bracketed user messages after history sanitization
      mockEmbedContent.mockResolvedValueOnce({
        embeddings: [{ values: [...precomputedPersonaPatternEmbeddings[0].vector] }],
      });
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({ thought: '重複回避', reply: 'OK', suggestionChips: [] }),
      });
      await copilot.processChat({
        message: 'Check [KPI]\n  please',
        history: [
          { role: 'user', text: 'First question' },
          { role: 'model', text: 'First answer' },
          { role: 'user', text: 'Check [KPI]\n  please' },
        ],
      });
      const dedupedContents = mockGenerateContent.mock.calls[3][0].contents;
      expect(dedupedContents).toHaveLength(3);
      expect(dedupedContents[0].parts[0].text).toBe('First question');
      expect(dedupedContents[1].parts[0].text).toBe('First answer');
      expect(dedupedContents[2].parts[0].text).toContain('Check [KPI]\n  please');
    });

    it('should align Rebecca temporal bracket and Current Time header to the frontend-specified timezone (user night == Rebecca night)', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-11-17T01:00:00.000Z'));
      try {
        mockEmbedContent.mockResolvedValueOnce({
          embeddings: [{ values: [...precomputedPersonaPatternEmbeddings[0].vector] }],
        });
        mockGenerateContent.mockResolvedValueOnce({
          text: JSON.stringify({
            thought: 'ニューヨークはもう夜なのね。しっかり労ってあげなきゃ♡',
            reply: '夜遅くまでお疲れ様、マスター♡',
            suggestionChips: ['休憩する'],
          }),
        });

        const copilot = new CopilotUseCase();
        // 2026-11-17T01:00:00Z is 10:00 JST (morning) in Tokyo, but 20:00 EST (evening/night) in America/New_York
        const res = await copilot.processChat({
          message: '夜遅くなったよ',
          currentContext: 'Dashboard',
          language: 'ja',
          timezone: 'America/New_York',
        });

        expect(res.reply).toBe('夜遅くまでお疲れ様、マスター♡');
        const callArg = mockGenerateContent.mock.calls[0][0];
        const systemInstruction: string = callArg.config.systemInstruction;
        const userMessageText: string = callArg.contents[callArg.contents.length - 1].parts[0].text;

        expect(systemInstruction).toContain('2026-11-16 20:00');
        expect(systemInstruction).toContain('夜');
        expect(userMessageText).toContain('[Current Time: 2026-11-16 20:00');
      } finally {
        jest.useRealTimers();
      }
    });

    it('should fail fast with HTTP 400 UpstreamApiError on invalid timezone passed directly to CopilotUseCase.processChat', async () => {
      const copilot = new CopilotUseCase();
      await expect(
        copilot.processChat({
          message: 'Hello',
          timezone: 'Invalid/Timezone',
        }),
      ).rejects.toMatchObject({
        name: 'UpstreamApiError',
        statusCode: 400,
        message: expect.stringMatching(/Invalid IANA timezone/),
      });
      await expect(
        copilot.processChat({
          message: 'Hello',
          timezone: 'Invalid/Timezone',
        }),
      ).rejects.toBeInstanceOf(UpstreamApiError);
    });

    it('should complete final constrained synthesis without unmatched functionCall when tools run through max rounds', async () => {
      // Round 1 tool call
      mockGenerateContent.mockResolvedValueOnce({
        functionCalls: [{ name: 'get_kpi_summary', args: { period: 'weekly' } }],
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'get_kpi_summary', args: { period: 'weekly' } } }],
            },
          },
        ],
      });
      // Round 2 tool call (reaches maxToolRounds = 2)
      mockGenerateContent.mockResolvedValueOnce({
        functionCalls: [{ name: 'search_timeline_posts', args: { limit: 1 } }],
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'search_timeline_posts', args: { limit: 1 } } }],
            },
          },
        ],
      });
      // Final step (declarations: []) must receive matching functionResponses and constrained responseSchema
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({
          thought: '全ツール結果が揃ったから的確に答えるわね♡',
          reply: 'KPIと最新投稿の両方をまとめておいたわ、マスター♡',
          suggestionChips: ['もう少し詳しく'],
        }),
      });

      const copilot = new CopilotUseCase(timelineRepo, usersRepo, assetsRepo, memoryRepo, supportersRepo);
      const res = await copilot.processChat({
        message: 'KPIとトップ投稿を順番に調べて',
        language: 'ja',
      });

      expect(res.thought).toBe('全ツール結果が揃ったから的確に答えるわね♡');
      expect(res.reply).toBe('KPIと最新投稿の両方をまとめておいたわ、マスター♡');
      expect(mockGenerateContent).toHaveBeenCalledTimes(3);

      const finalCall = mockGenerateContent.mock.calls[2][0];
      expect(finalCall.config.responseSchema).toEqual(COPILOT_FINAL_RESPONSE_SCHEMA);
      expect(finalCall.config.tools).toBeUndefined();
      // Final contents must end with functionResponse user turn (never an unmatched functionCall)
      expect(finalCall.contents[finalCall.contents.length - 1].role).toBe('user');
      expect(finalCall.contents[finalCall.contents.length - 1].parts[0].functionResponse.name).toBe(
        'search_timeline_posts',
      );
    });

    it('should return safe localized error fallback instead of leaking empty reply or raw JSON when Phase 2 omits reply/thought', async () => {
      mockGenerateContent
        .mockResolvedValueOnce({ text: 'incomplete plain reply without chips or thought' })
        .mockResolvedValueOnce({ text: JSON.stringify({ thought: 'LEAK_CHECK', reply: '' }) });

      const copilot = new CopilotUseCase(timelineRepo, usersRepo, assetsRepo, memoryRepo, supportersRepo);
      const res = await copilot.processChat({
        message: '様子はどう？',
        language: 'ja',
      });

      expect(res.reply).toContain('通信エラーが発生しました');
      expect(res.reply).not.toContain('LEAK_CHECK');
      // Verify Phase 2 contents did not end with incomplete Phase 1 model turn
      const phase2Contents = mockGenerateContent.mock.calls[1][0].contents;
      expect(phase2Contents[phase2Contents.length - 1].role).toBe('user');
    });

    it('should invoke Phase 2 Constrained Synthesis after 1-round tool call when Round 1 emits unstructured text', async () => {
      // Round 0 calls search_timeline_posts
      mockGenerateContent.mockResolvedValueOnce({
        functionCalls: [{ name: 'search_timeline_posts', args: { limit: 1 } }],
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'search_timeline_posts', args: { limit: 1 } } }],
            },
          },
        ],
      });
      // Round 1 emits plain text without thought/chips
      mockGenerateContent.mockResolvedValueOnce({
        text: '投稿の分析結果だよ！',
      });
      // Constrained synthesis preserves Round 0 tool call + response and enforces finalResponseSchema
      mockGenerateContent.mockResolvedValueOnce({
        text: JSON.stringify({
          thought: '1ツール呼んだ後の自然文も自動で構造化補完できるわ♡',
          reply: '直近トップ投稿は45,000インプレッションよ、マスター♡',
          suggestionChips: ['他の指標を見る'],
        }),
      });

      const copilot = new CopilotUseCase(timelineRepo, usersRepo, assetsRepo, memoryRepo, supportersRepo);
      const res = await copilot.processChat({
        message: '人気投稿を調べて',
        language: 'ja',
      });

      expect(mockGenerateContent).toHaveBeenCalledTimes(3);
      expect(res.thought).toBe('1ツール呼んだ後の自然文も自動で構造化補完できるわ♡');
      expect(res.reply).toBe('直近トップ投稿は45,000インプレッションよ、マスター♡');
      expect(res.attachments?.length).toBe(1);

      const finalCall = mockGenerateContent.mock.calls[2][0];
      expect(finalCall.config.responseSchema).toEqual(COPILOT_FINAL_RESPONSE_SCHEMA);
      expect(finalCall.contents[finalCall.contents.length - 1].parts[0].functionResponse.name).toBe(
        'search_timeline_posts',
      );
      expect(timelineRepo.getPosts).toHaveBeenCalledWith(
        expect.objectContaining({ timezone: expect.any(String) }),
      );
    });

    it('should fail fast (propagate UpstreamApiError) on non-retryable 401/403 client errors', async () => {
      mockGenerateContent.mockRejectedValueOnce(
        Object.assign(new Error('API key expired'), { status: 403 }),
      );

      const copilot = new CopilotUseCase(timelineRepo, usersRepo, assetsRepo, memoryRepo, supportersRepo);
      await expect(
        copilot.processChat({
          message: 'ステータス確認',
          language: 'ja',
        }),
      ).rejects.toMatchObject({ statusCode: 502 });
    });

    it('should enforce character-agnostic Pluggable Persona boundary with zero hardcoded Rebecca strings in dashboard-backend/src/features/copilot', () => {
      const copilotDir = path.resolve(__dirname, '../../src/features/copilot');
      const collectTsFiles = (dir: string): string[] => {
        const out: string[] = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) out.push(...collectTsFiles(full));
          else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
        }
        return out;
      };

      const forbiddenPattern =
        /レベッカ|マスター|@rebecca_ai_gal|ギャル|ツンデレ|Gyaru|全肯定|包容力|大人の余裕|高嶺の花|キャッシュ切れ|教えて♡|よ、バカ|わけないでしょ|！♡|ね♡/;
      for (const filePath of collectTsFiles(copilotDir)) {
        const content = fs.readFileSync(filePath, 'utf8');
        expect({
          file: path.relative(copilotDir, filePath),
          leakedCharacterLiteral: forbiddenPattern.test(content),
        }).toEqual({
          file: path.relative(copilotDir, filePath),
          leakedCharacterLiteral: false,
        });
      }
    });
  });
});
