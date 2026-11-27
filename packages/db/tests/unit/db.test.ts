import { Timestamp } from '@google-cloud/firestore';
import {
  COLLECTIONS,
  assertLoungeRecordOwnedByUid,
  createUserScopedLoungeAccountDb,
  createUserScopedLoungeDb,
  createUserScopedLoungeGalleryDb,
  createUserScopedLoungeSessionDb,
  getCollections,
  userConverter,
  conversationLogConverter,
  timelinePostConverter,
  ragMemoryConverter,
  imageDocConverter,
  processedFollowerConverter,
  listInteractionConverter,
  rateLimitConverter,
  personaConverter,
  xApiStateConverter,
  campaignDocConverter,
  adminUserConverter,
  loungeUserConverter,
  loungeSubscriptionConverter,
  loungeSessionConverter,
  loungeMessageConverter,
  loungeRagMemoryConverter,
  loungeGalleryConverter,
  loungeProcessedEventConverter,
  loungeCreditLotConverter,
  loungeQuotaLedgerConverter,
  loungeTrialGrantConverter,
} from '../../src/index';
import {
  UserStatus,
  PostStatus,
  AssetStatus,
  FirestoreUser,
  TimelinePost,
  ImageDoc,
  ProcessedFollower,
  CampaignDoc,
  LoungeUserDoc,
  LoungeSubscriptionDoc,
  LoungeSessionDoc,
  LoungeMessageDoc,
  LoungeProcessedEventDoc,
  LoungeRagMemoryDoc,
  LoungeGalleryItemDoc,
  LoungeCreditLotDoc,
  LoungeQuotaLedgerDoc,
  LoungeTrialGrantDoc,
  toPublicLoungeCreditLot,
  toPublicLoungeMessage,
  toPublicLoungeSubscription,
} from '@rebecca/types';

describe('@rebecca/db Unit Tests', () => {
  describe('COLLECTIONS constants', () => {
    it('should define all required collection names correctly', () => {
      expect(COLLECTIONS.USERS).toBe('users');
      expect(COLLECTIONS.CONVERSATION_LOGS).toBe('conversation_logs');
      expect(COLLECTIONS.TIMELINE_HISTORY).toBe('timeline_history');
      expect(COLLECTIONS.RAG_MEMORIES).toBe('rag_memories');
      expect(COLLECTIONS.RATE_LIMITS).toBe('rate_limits');
      expect(COLLECTIONS.SYSTEM).toBe('system');
      expect(COLLECTIONS.SYSTEM_STATS).toBe('system_stats');
      expect(COLLECTIONS.PROCESSED_MENTIONS).toBe('processed_mentions');
      expect(COLLECTIONS.IMAGES).toBe('images');
      expect(COLLECTIONS.PROCESSED_FOLLOWERS).toBe('processed_followers');
      expect(COLLECTIONS.LIST_INTERACTION_HISTORY).toBe('list_interaction_history');
      expect(COLLECTIONS.CAMPAIGNS).toBe('campaigns');
    });
  });

  describe('userConverter', () => {
    it('toFirestore should return plain document data', () => {
      const user: FirestoreUser = {
        id: 'u1',
        name: 'User 1',
        username: 'user1',
        avatarUrl: 'https://avatar.png',
        status: UserStatus.ACTIVE,
        firstSeen: '2026-01-01T00:00:00Z',
        lastSeen: '2026-01-02T00:00:00Z',
        coreProfile: { persona: 'Friendly' },
        episodicBuffer: [{ role: 'user', content: 'hello' }],
      };
      expect(userConverter.toFirestore(user)).toEqual(user);
    });

    it('fromFirestore should map snapshot data correctly with defaults', () => {
      const mockSnapshot = {
        id: 'u1',
        data: () => ({
          name: 'User 1',
          username: 'user1',
          avatarUrl: 'https://avatar.png',
          status: UserStatus.ACTIVE,
          firstSeen: '2026-01-01T00:00:00Z',
          lastSeen: '2026-01-02T00:00:00Z',
        }),
      } as any;

      const result = userConverter.fromFirestore(mockSnapshot);
      expect(result.id).toBe('u1');
      expect(result.name).toBe('User 1');
      expect(result.username).toBe('user1');
      expect(result.coreProfile).toEqual({});
      expect(result.episodicBuffer).toEqual([]);
    });

    it('fromFirestore should handle snake_case and missing fields', () => {
      const mockSnapshot = {
        id: 'u2',
        data: () => ({
          first_seen: '2026-02-01T00:00:00Z',
          last_seen: '2026-02-02T00:00:00Z',
          last_reply_date: '2026-02-03T00:00:00Z',
          daily_reply_count: 5,
        }),
      } as any;

      const result = userConverter.fromFirestore(mockSnapshot);
      expect(result.id).toBe('u2');
      expect(result.name).toBe('');
      expect(result.username).toBe('');
      expect(result.avatarUrl).toBe('');
      expect(result.firstSeen).toBe('2026-02-01T00:00:00Z');
      expect(result.lastSeen).toBe('2026-02-02T00:00:00Z');
      expect(result.lastReplyDate).toBe('2026-02-03T00:00:00Z');
      expect(result.dailyReplyCount).toBe(5);
    });

    it('fromFirestore should fallback lastSeen to last_reply_date when both lastSeen and last_seen are missing', () => {
      const mockSnapshot = {
        id: 'u3',
        data: () => ({
          last_reply_date: '2026-03-01T00:00:00Z',
        }),
      } as any;

      const result = userConverter.fromFirestore(mockSnapshot);
      expect(result.lastSeen).toBe('2026-03-01T00:00:00Z');
    });
  });

  describe('conversationLogConverter', () => {
    it('toFirestore should convert expireAt string to Timestamp', () => {
      const iso = '2026-05-01T12:00:00.000Z';
      const log = {
        userId: 'u1',
        userText: 'hello',
        aiText: 'hi',
        timestamp: '2026-04-01T12:00:00.000Z',
        expireAt: iso,
      };
      const result = conversationLogConverter.toFirestore(log);
      expect(result.expireAt).toBeInstanceOf(Timestamp);
    });

    it('toFirestore should handle null/empty expireAt', () => {
      const log = {
        userId: 'u1',
        userText: 'hello',
        aiText: 'hi',
        timestamp: '2026-04-01T12:00:00.000Z',
      };
      const result = conversationLogConverter.toFirestore(log as any);
      expect(result.expireAt).toBeNull();
    });

    it('fromFirestore should convert Timestamp to ISO string', () => {
      const d = new Date('2026-05-01T12:00:00.000Z');
      const mockSnapshot = {
        data: () => ({
          userId: 'u1',
          userText: 'hello',
          aiText: 'hi',
          timestamp: '2026-04-01T12:00:00.000Z',
          expireAt: Timestamp.fromDate(d),
        }),
      } as any;

      const result = conversationLogConverter.fromFirestore(mockSnapshot);
      expect(result.expireAt).toBe(d.toISOString());
    });

    it('fromFirestore should handle null/Date/string expireAt', () => {
      const d = new Date('2026-05-01T12:00:00.000Z');
      const mockSnapshot1 = {
        data: () => ({
          userId: 'u1',
          expireAt: d,
        }),
      } as any;
      expect(conversationLogConverter.fromFirestore(mockSnapshot1).expireAt).toBe(d.toISOString());

      const mockSnapshot2 = {
        data: () => ({
          userId: 'u1',
          expireAt: 'already-iso',
        }),
      } as any;
      expect(conversationLogConverter.fromFirestore(mockSnapshot2).expireAt).toBe('already-iso');

      const mockSnapshot3 = {
        data: () => ({
          userId: 'u1',
          expireAt: null,
        }),
      } as any;
      expect(conversationLogConverter.fromFirestore(mockSnapshot3).expireAt).toBe('');
    });
  });

  describe('timelinePostConverter', () => {
    it('toFirestore should convert expireAt correctly and default numeric/array fields', () => {
      const post: TimelinePost = {
        text: 'test tweet',
        timestamp: '2026-04-01T00:00:00Z',
        expireAt: '2026-05-01T00:00:00Z',
        status: PostStatus.SUCCESS,
        impressions: 10,
        likes: 2,
        reposts: 1,
        replies: 0,
        mediaUrls: ['https://example.com/image.png'],
        tweetId: 't1',
        authorId: 'a1',
        authorName: 'Rebecca',
        authorHandle: 'rebecca_ai',
        authorAvatarUrl: '',
      };
      const data = timelinePostConverter.toFirestore(post);
      expect(data.expireAt).toBeInstanceOf(Timestamp);
      expect(data.reposts).toBe(1);
      expect(data.mediaUrls).toEqual(['https://example.com/image.png']);
      expect(data.tweetId).toBe('t1');
    });

    it('toFirestore should handle null expireAt and undefined optional fields', () => {
      const emptyPost: TimelinePost = {
        text: 'test empty',
        timestamp: '2026-04-01T00:00:00Z',
        expireAt: '',
      };
      const emptyData = timelinePostConverter.toFirestore(emptyPost);
      expect(emptyData.reposts).toBe(0);
      expect(emptyData.mediaUrls).toEqual([]);
      expect(emptyData.tweetId).toBe('');
      expect(emptyData.expireAt).toBeNull();
    });

    it('fromFirestore should map document fields strictly to canonical TimelinePost', () => {
      const mockSnapshot = {
        data: () => ({
          text: 'tweet',
          tweetId: 't1',
          timestamp: '2026-04-01T00:00:00Z',
          expireAt: null,
          status: PostStatus.SUCCESS,
          impressions: 10,
          likes: 2,
          reposts: 7,
          replies: 0,
          mediaUrls: ['https://image.png'],
          authorId: 'a1',
          authorName: 'Rebecca',
          authorHandle: 'rebecca_ai',
          authorAvatarUrl: '',
          postType: 'news',
          newsTitle: 'IT Passport',
          newsEmbedding: [0.1, 0.2],
          thought: '実は私も気になる話題ね',
        }),
      } as any;

      const post = timelinePostConverter.fromFirestore(mockSnapshot);
      expect(post.mediaUrls).toEqual(['https://image.png']);
      expect(post.tweetId).toBe('t1');
      expect(post.reposts).toBe(7);
      expect(post.postType).toBe('news');
      expect(post.newsTitle).toBe('IT Passport');
      expect(post.newsEmbedding).toEqual([0.1, 0.2]);
      expect(post.thought).toBe('実は私も気になる話題ね');
    });

    it('fromFirestore should fallback gracefully for missing fields', () => {
      const mockSnapshot = {
        data: () => ({}),
      } as any;

      const post = timelinePostConverter.fromFirestore(mockSnapshot);
      expect(post.text).toBe('');
      expect(post.tweetId).toBe('');
      expect(post.timestamp).toBe('');
      expect(post.mediaUrls).toEqual([]);
      expect(post.reposts).toBe(0);
      expect(post.expireAt).toBe('');
    });
  });

  describe('ragMemoryConverter', () => {
    it('toFirestore and fromFirestore should passthrough data correctly', () => {
      const memory = {
        userId: 'u1',
        text: 'User likes coffee',
        embedding: [0.1, 0.2, 0.3],
        timestamp: '2026-04-01T00:00:00Z',
      };
      expect(ragMemoryConverter.toFirestore(memory)).toEqual(memory);

      const mockSnapshot = {
        data: () => memory,
      } as any;
      expect(ragMemoryConverter.fromFirestore(mockSnapshot)).toEqual(memory);
    });
  });

  describe('imageDocConverter', () => {
    it('toFirestore should convert lastUsedAt to Timestamp or null', () => {
      const image: ImageDoc = {
        url: 'https://img.jpg',
        filename: 'img.jpg',
        caption: 'caption',
        embedding: [0.1],
        lastUsedAt: '2026-04-01T00:00:00Z',
        useCount: 1,
        status: AssetStatus.SUCCESS,
      };
      const result = imageDocConverter.toFirestore(image);
      expect(result.lastUsedAt).toBeInstanceOf(Timestamp);

      const imageNoDate: ImageDoc = { ...image, lastUsedAt: null };
      expect(imageDocConverter.toFirestore(imageNoDate).lastUsedAt).toBeNull();

      const imageInvalidDate: ImageDoc = { ...image, lastUsedAt: 'invalid-date' };
      expect(imageDocConverter.toFirestore(imageInvalidDate).lastUsedAt).toBeNull();
    });

    it('fromFirestore should map lastUsedAt to ISO string or null', () => {
      const d = new Date('2026-04-01T00:00:00Z');
      const mockSnapshot = {
        data: () => ({
          url: 'https://img.jpg',
          filename: 'img.jpg',
          caption: 'caption',
          embedding: [0.1],
          lastUsedAt: Timestamp.fromDate(d),
          status: AssetStatus.SUCCESS,
        }),
      } as any;

      const img = imageDocConverter.fromFirestore(mockSnapshot);
      expect(img.lastUsedAt).toBe(d.toISOString());
      expect(img.useCount).toBe(0);
      expect(img.createdAt).toBeUndefined();

      const withCreatedAt = imageDocConverter.fromFirestore({
        data: () => ({
          url: 'https://img.jpg',
          caption: 'caption',
          embedding: [0.1],
          createdAt: Timestamp.fromDate(d),
        }),
      } as any);
      expect(withCreatedAt.createdAt).toBe(d.toISOString());
    });
  });

  describe('adminUserConverter', () => {
    it('serializes and deserializes AdminUser fail-fast on invalid RBAC fields', () => {
      const admin = {
        uid: 'adm_1',
        email: 'admin@example.com',
        role: 'ADMIN' as const,
        status: 'ACTIVE' as const,
        createdAt: '2026-11-22T12:00:00.000Z',
      };
      const raw = adminUserConverter.toFirestore(admin);
      expect(raw['createdAt']).toBeInstanceOf(Timestamp);
      expect(adminUserConverter.fromFirestore({ id: 'adm_1', data: () => raw } as any)).toEqual(admin);
      expect(
        adminUserConverter.fromFirestore({
          id: 'adm_fallback_uid',
          data: () => ({ email: 'a@example.com', role: 'ADMIN', status: 'REVOKED', createdAt: '2026-11-22T12:00:00.000Z' }),
        } as any).uid,
      ).toBe('adm_fallback_uid');
      expect(() =>
        adminUserConverter.fromFirestore({
          id: 'bad_role',
          data: () => ({ email: 'a@example.com', role: 'USER', status: 'ACTIVE', createdAt: '2026-11-22T12:00:00.000Z' }),
        } as any),
      ).toThrow(/Invalid enum value "USER" for "role"/);
    });
  });

  describe('processedFollowerConverter & listInteractionConverter', () => {
    it('processedFollowerConverter should convert data correctly', () => {
      const follower: ProcessedFollower = { userId: 'f1', timestamp: '2026-04-01T00:00:00Z', listStatus: 'ADDED' };
      expect(processedFollowerConverter.toFirestore(follower)).toEqual(follower);
      expect(processedFollowerConverter.fromFirestore({ data: () => follower } as any)).toEqual(follower);

      const skippedFollower: ProcessedFollower = { userId: 'f2', timestamp: '2026-01-01T00:00:00Z', listStatus: 'SKIPPED' };
      expect(processedFollowerConverter.toFirestore(skippedFollower)).toEqual(skippedFollower);
      expect(processedFollowerConverter.fromFirestore({ data: () => skippedFollower } as any)).toEqual(skippedFollower);
    });

    it('listInteractionConverter should convert lastInteractionAt correctly', () => {
      const interaction = { userId: 'u1', lastInteractionAt: '2026-04-01T00:00:00Z' };
      const data = listInteractionConverter.toFirestore(interaction);
      expect(data.lastInteractionAt).toBeInstanceOf(Timestamp);

      const mockSnapshot = {
        data: () => ({ userId: 'u1', lastInteractionAt: Timestamp.fromDate(new Date('2026-04-01T00:00:00Z')) }),
      } as any;
      expect(listInteractionConverter.fromFirestore(mockSnapshot).lastInteractionAt).toBe('2026-04-01T00:00:00.000Z');
    });
  });

  describe('pass-through converters', () => {
    it('rateLimitConverter, personaConverter, xApiStateConverter should passthrough data', () => {
      const raw = { foo: 'bar', count: 1 };
      expect(rateLimitConverter.toFirestore(raw as any)).toEqual(raw);
      expect(rateLimitConverter.fromFirestore({ data: () => raw } as any)).toEqual(raw);
      expect(personaConverter.toFirestore(raw as any)).toEqual(raw);
      expect(xApiStateConverter.toFirestore(raw as any)).toEqual(raw);
    });
  });

  describe('campaignDocConverter', () => {
    it('toFirestore should serialize campaign document correctly', () => {
      const campaign: CampaignDoc = {
        title: 'Hawaii Trip 2026',
        description: 'Summer holiday in Hawaii',
        status: 'active',
        isPaused: false,
        startDate: '2026-07-01',
        endDate: '2026-07-07',
        dailySlotTimes: ['08:00', '12:00', '19:00'],
        masterContext: 'Rebecca is vacationing in Honolulu.',
        replyContextSummary: 'Currently enjoying Honolulu beach with iced latte.',
        slots: [
          {
            slotId: 'slot-1',
            dayNumber: 1,
            timePeriod: 'morning',
            scheduledTime: '2026-07-01T08:00:00Z',
            theme: 'Arrival at Daniel K. Inouye Airport',
            mediaUrl: 'https://storage.googleapis.com/rebecca-ai-gal-images/campaigns/c1/img1.png',
            captionPromptHint: 'Excited about the ocean breeze',
            fixedTextOverride: 'Aloha Hawaii!',
            isFixedText: true,
            status: 'pending',
          },
        ],
        totalSlotsCount: 21,
        completedSlotsCount: 0,
        isAnnualRecurring: false,
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:00.000Z',
      };

      const result = campaignDocConverter.toFirestore(campaign);
      expect(result['title']).toBe('Hawaii Trip 2026');
      expect(result['status']).toBe('active');
      expect(result['isPaused']).toBe(false);
      expect(result['slots']).toHaveLength(1);
      expect(result['slots'][0].slotId).toBe('slot-1');
      expect(result['slots'][0].isFixedText).toBe(true);
      expect(result['slots'][0].fixedTextOverride).toBe('Aloha Hawaii!');
      expect(result['slots'][0].mediaUrl).toBe('https://storage.googleapis.com/rebecca-ai-gal-images/campaigns/c1/img1.png');
    });

    it('fromFirestore should deserialize campaign snapshot with document id', () => {
      const mockSnapshot = {
        id: 'camp_12345',
        data: () => ({
          title: 'Hawaii Trip 2026',
          status: 'scheduled',
          isPaused: false,
          startDate: '2026-07-01',
          endDate: '2026-07-07',
          dailySlotTimes: ['08:00', '12:00', '19:00'],
          masterContext: 'Rebecca in Hawaii',
          replyContextSummary: 'At beach',
          slots: [
            {
              slotId: 'slot-1',
              dayNumber: 1,
              timePeriod: 'morning',
              scheduledTime: '2026-07-01T08:00:00Z',
              theme: 'Arrival',
              isFixedText: true,
              fixedTextOverride: 'Welcome to Hawaii!',
              status: 'pending',
            },
          ],
          totalSlotsCount: 21,
          completedSlotsCount: 0,
          isAnnualRecurring: true,
          recurringApprovedYear: 2026,
          createdAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
        }),
      } as any;

      const campaign = campaignDocConverter.fromFirestore(mockSnapshot);
      expect(campaign.id).toBe('camp_12345');
      expect(campaign.title).toBe('Hawaii Trip 2026');
      expect(campaign.isAnnualRecurring).toBe(true);
      expect(campaign.recurringApprovedYear).toBe(2026);
      expect(campaign.slots).toHaveLength(1);
      expect(campaign.slots[0].theme).toBe('Arrival');
      expect(campaign.slots[0].isFixedText).toBe(true);
      expect(campaign.slots[0].fixedTextOverride).toBe('Welcome to Hawaii!');
    });

    it('toFirestore should serialize campaign document with optional recurring fields', () => {
      const campaign: CampaignDoc = {
        title: 'Spring Festival',
        status: 'scheduled',
        isPaused: true,
        startDate: '2027-03-01',
        endDate: '2027-03-05',
        dailySlotTimes: ['09:00', '18:00'],
        masterContext: 'Spring trip',
        replyContextSummary: 'Spring holiday',
        slots: [],
        totalSlotsCount: 10,
        completedSlotsCount: 5,
        isAnnualRecurring: true,
        recurringApprovedYear: 2027,
        createdAt: '2027-01-01T00:00:00.000Z',
        updatedAt: '2027-01-01T00:00:00.000Z',
      };

      const result = campaignDocConverter.toFirestore(campaign);
      expect(result['title']).toBe('Spring Festival');
      expect(result['recurringApprovedYear']).toBe(2027);
      expect(result['description']).toBeUndefined();
      expect(result['slots']).toEqual([]);
    });

    it('toFirestore should omit createdAt when undefined for partial merge updates', () => {
      const campaign = {
        title: 'Spring Festival',
        status: 'draft' as const,
        isPaused: false,
        startDate: '2027-03-01',
        endDate: '2027-03-05',
        dailySlotTimes: ['09:00'],
        masterContext: '',
        replyContextSummary: '',
        slots: [],
        totalSlotsCount: 1,
        completedSlotsCount: 0,
        isAnnualRecurring: false,
        updatedAt: '2027-01-01T00:00:00.000Z',
      } as unknown as CampaignDoc;

      const result = campaignDocConverter.toFirestore(campaign);
      expect(result['createdAt']).toBeUndefined();
    });

    it('toFirestore should only include defined fields for partial updates (e.g. pause toggle)', () => {
      const partialCampaign = {
        isPaused: true,
        updatedAt: '2027-01-01T12:00:00.000Z',
      } as unknown as CampaignDoc;

      const result = campaignDocConverter.toFirestore(partialCampaign);
      expect(result).toEqual({
        isPaused: true,
        updatedAt: '2027-01-01T12:00:00.000Z',
      });
      expect(result['title']).toBeUndefined();
    });

    it('fromFirestore should throw an error when mandatory fields are missing', () => {
      const mockCorruptedSnapshot = {
        id: 'camp_empty',
        data: () => ({
          title: 'Minimal Campaign',
          // missing startDate, endDate, status
        }),
      } as any;

      expect(() => campaignDocConverter.fromFirestore(mockCorruptedSnapshot)).toThrow(
        'Corrupted Campaign document [camp_empty]: missing required root fields',
      );
    });

    it('fromFirestore should throw an error when slots contain invalid or missing fields', () => {
      const mockSnapshot = {
        id: 'camp_invalid_slot',
        data: () => ({
          title: 'Invalid Slot Campaign',
          startDate: '2026-07-01',
          endDate: '2026-07-05',
          status: 'scheduled',
          slots: [
            {
              slotId: 'slot-1',
              // missing dayNumber, timePeriod, etc.
            },
          ],
        }),
      } as any;

      expect(() => campaignDocConverter.fromFirestore(mockSnapshot)).toThrow(
        'Corrupted CampaignSlot at index 0 in document [camp_invalid_slot]: missing required slot fields',
      );
    });

    it('fromFirestore should throw an error when slots is not an array', () => {
      const mockSnapshot = {
        id: 'camp_no_slots',
        data: () => ({
          title: 'No Slots',
          startDate: '2026-07-01',
          endDate: '2026-07-05',
          status: 'draft',
          slots: null,
        }),
      } as any;

      expect(() => campaignDocConverter.fromFirestore(mockSnapshot)).toThrow(
        'Corrupted Campaign document [camp_no_slots]: slots must be an array.',
      );
    });
  });

  describe('getCollections', () => {
    it('should return typed collection references bound to converters', () => {
      const mockWithConverter = jest.fn().mockImplementation((c) => ({ converter: c }));
      const mockCollection = jest.fn().mockReturnValue({ withConverter: mockWithConverter });
      const mockDb = { collection: mockCollection } as any;

      const collections = getCollections(mockDb);

      expect(mockCollection).toHaveBeenCalledWith(COLLECTIONS.USERS);
      expect(mockCollection).toHaveBeenCalledWith(COLLECTIONS.CONVERSATION_LOGS);
      expect(mockCollection).toHaveBeenCalledWith(COLLECTIONS.TIMELINE_HISTORY);
      expect(mockCollection).toHaveBeenCalledWith(COLLECTIONS.RAG_MEMORIES);
      expect(mockCollection).toHaveBeenCalledWith(COLLECTIONS.IMAGES);
      expect(mockCollection).toHaveBeenCalledWith(COLLECTIONS.PROCESSED_FOLLOWERS);
      expect(mockCollection).toHaveBeenCalledWith(COLLECTIONS.LIST_INTERACTION_HISTORY);
      expect(mockCollection).toHaveBeenCalledWith(COLLECTIONS.RATE_LIMITS);
      expect(mockCollection).toHaveBeenCalledWith(COLLECTIONS.SYSTEM);
      expect(mockCollection).toHaveBeenCalledWith(COLLECTIONS.SYSTEM_STATS);
      expect(mockCollection).toHaveBeenCalledWith(COLLECTIONS.PROCESSED_MENTIONS);
      expect(mockCollection).toHaveBeenCalledWith(COLLECTIONS.CAMPAIGNS);

      expect(mockCollection).toHaveBeenCalledWith(COLLECTIONS.LOUNGE_USERS);
      expect(mockCollection).toHaveBeenCalledWith(COLLECTIONS.LOUNGE_SUBSCRIPTIONS);
      expect(mockCollection).toHaveBeenCalledWith(COLLECTIONS.LOUNGE_SESSIONS);
      expect(mockCollection).toHaveBeenCalledWith(COLLECTIONS.LOUNGE_MESSAGES);
      expect(mockCollection).toHaveBeenCalledWith(COLLECTIONS.LOUNGE_RAG_MEMORIES);
      expect(mockCollection).toHaveBeenCalledWith(COLLECTIONS.LOUNGE_GALLERY);
      expect(mockCollection).toHaveBeenCalledWith(COLLECTIONS.LOUNGE_PROCESSED_EVENTS);
      expect(mockCollection).toHaveBeenCalledWith(COLLECTIONS.LOUNGE_CREDIT_LOTS);
      expect(mockCollection).toHaveBeenCalledWith(COLLECTIONS.LOUNGE_QUOTA_LEDGER);
      expect(mockCollection).toHaveBeenCalledWith(COLLECTIONS.LOUNGE_TRIAL_GRANTS);

      expect(collections.users).toEqual({ converter: userConverter });
      expect(collections.adminUsers).toEqual({ converter: adminUserConverter });
      expect(collections.loungeUsers).toEqual({ converter: loungeUserConverter });
      expect(collections.loungeSubscriptions).toEqual({ converter: loungeSubscriptionConverter });
      expect(collections.loungeSessions).toEqual({ converter: loungeSessionConverter });
      expect(collections.loungeMessages).toEqual({ converter: loungeMessageConverter });
      expect(collections.loungeRagMemories).toEqual({ converter: loungeRagMemoryConverter });
      expect(collections.loungeGallery).toEqual({ converter: loungeGalleryConverter });
      expect(collections.loungeProcessedEvents).toEqual({ converter: loungeProcessedEventConverter });
      expect(collections.loungeCreditLots).toEqual({ converter: loungeCreditLotConverter });
      expect(collections.loungeQuotaLedger).toEqual({ converter: loungeQuotaLedgerConverter });
      expect(collections.loungeTrialGrants).toEqual({ converter: loungeTrialGrantConverter });
    });
  });

  describe('Isolated Private Lounge COLLECTIONS & Converters', () => {
    it('defines ten isolated lounge_* collection names distinct from public bot collections', () => {
      expect(COLLECTIONS.LOUNGE_USERS).toBe('lounge_users');
      expect(COLLECTIONS.LOUNGE_SUBSCRIPTIONS).toBe('lounge_subscriptions');
      expect(COLLECTIONS.LOUNGE_SESSIONS).toBe('lounge_sessions');
      expect(COLLECTIONS.LOUNGE_MESSAGES).toBe('lounge_messages');
      expect(COLLECTIONS.LOUNGE_RAG_MEMORIES).toBe('lounge_rag_memories');
      expect(COLLECTIONS.LOUNGE_GALLERY).toBe('lounge_gallery');
      expect(COLLECTIONS.LOUNGE_PROCESSED_EVENTS).toBe('lounge_processed_events');
      expect(COLLECTIONS.LOUNGE_CREDIT_LOTS).toBe('lounge_credit_lots');
      expect(COLLECTIONS.LOUNGE_QUOTA_LEDGER).toBe('lounge_quota_ledger');
      expect(COLLECTIONS.LOUNGE_TRIAL_GRANTS).toBe('lounge_trial_grants');
      expect(COLLECTIONS.LOUNGE_USERS).not.toBe(COLLECTIONS.USERS);
      expect(COLLECTIONS.LOUNGE_RAG_MEMORIES).not.toBe(COLLECTIONS.RAG_MEMORIES);
      expect(COLLECTIONS.LOUNGE_PROCESSED_EVENTS).not.toBe(COLLECTIONS.PROCESSED_MENTIONS);
    });

    it('serializes and deserializes loungeUserConverter with integer disclaimerVersion and onboardingCompleted', () => {
      const user: LoungeUserDoc = {
        uid: 'uid_lounge_001',
        xUserId: '100020003000',
        xHandle: '@user_001',
        displayName: 'Cyber Runner 01',
        avatarUrl: 'https://example.com/avatar.png',
        status: 'ACTIVE',
        language: 'zh-HK',
        timezone: 'Asia/Hong_Kong',
        onboardingCompleted: false,
        allowServiceImprovementAnalytics: true,
        disclaimerConsent: {
          disclaimerVersion: 1,
          agreedToGeminiTrainingUsage: true,
          agreedToZeroPiiProhibition: true,
          agreedToOneWayMemoryIsolation: true,
          scrolledToBottomAt: '2026-11-22T12:00:00.000Z',
          consentedAt: '2026-11-22T12:00:05.000Z',
        },
        createdAt: '2026-11-22T12:00:05.000Z',
        updatedAt: '2026-11-22T12:00:05.000Z',
        lastLoginAt: '2026-11-22T12:05:00.000Z',
      };

      const raw = loungeUserConverter.toFirestore(user);
      expect(raw['createdAt']).toBeInstanceOf(Timestamp);
      expect(raw['disclaimerConsent']['scrolledToBottomAt']).toBeInstanceOf(Timestamp);

      const roundTrip = loungeUserConverter.fromFirestore({
        id: 'uid_lounge_001',
        data: () => raw,
      } as any);
      expect(roundTrip).toEqual(user);

      const userWithDreamingMemory: LoungeUserDoc = {
        ...user,
        coreProfile: { hobbies: ['Synthwave'] },
        episodicBuffer: [
          {
            role: 'user',
            content: 'コーヒーが好き',
            timestamp: '2026-11-22T12:01:00.000Z',
          },
          {
            role: 'model',
            content: 'ブラック派なんだ！',
            thought: '覚えておこう',
            timestamp: '2026-11-22T12:02:00.000Z',
          },
        ],
        lastDreamedAt: '2026-11-22T13:00:00.000Z',
      };
      const rawDream = loungeUserConverter.toFirestore(userWithDreamingMemory);
      expect(rawDream['lastDreamedAt']).toBeInstanceOf(Timestamp);
      expect(
        loungeUserConverter.fromFirestore({ id: 'uid_lounge_001', data: () => rawDream } as any),
      ).toEqual(userWithDreamingMemory);

      expect(() =>
        loungeUserConverter.fromFirestore({
          id: 'bad_core',
          data: () => ({ ...raw, coreProfile: ['not-object'] }),
        } as any),
      ).toThrow(/Invalid non-object field "coreProfile"/);

      expect(() =>
        loungeUserConverter.fromFirestore({
          id: 'bad_buf',
          data: () => ({ ...raw, episodicBuffer: 'not-array' }),
        } as any),
      ).toThrow(/Invalid non-array field "episodicBuffer"/);

      expect(() =>
        loungeUserConverter.fromFirestore({
          id: 'bad_buf_null',
          data: () => ({ ...raw, episodicBuffer: [null] }),
        } as any),
      ).toThrow(/Corrupted episodicBuffer entry at index 0/);

      expect(() =>
        loungeUserConverter.fromFirestore({
          id: 'bad_buf_role',
          data: () => ({ ...raw, episodicBuffer: [{ role: 'admin', content: 'hi' }] }),
        } as any),
      ).toThrow(/Corrupted episodicBuffer entry at index 0/);

      expect(() =>
        loungeUserConverter.toFirestore({ ...user, createdAt: 'not-a-date' }),
      ).toThrow(/Invalid ISO 8601 datetime string/);
      expect(() =>
        loungeUserConverter.fromFirestore({ id: 'bad', data: () => ({ xHandle: '@x' }) } as any),
      ).toThrow(/Invalid or missing string field "xUserId"/);
      expect(() =>
        loungeUserConverter.fromFirestore({
          id: 'bad',
          data: () => ({
            ...raw,
            disclaimerConsent: null,
          }),
        } as any),
      ).toThrow(/Missing "disclaimerConsent" object/);

      expect(() =>
        loungeUserConverter.fromFirestore({
          id: 'uid_bad_avatar',
          data: () => ({ ...raw, avatarUrl: null }),
        } as any),
      ).toThrow(/Invalid non-string field "avatarUrl"/);

      expect(() =>
        loungeUserConverter.fromFirestore({
          id: 'uid_bad_bool',
          data: () => ({
            ...raw,
            disclaimerConsent: {
              ...raw['disclaimerConsent'],
              agreedToGeminiTrainingUsage: 'false',
            },
          }),
        } as any),
      ).toThrow(/Invalid or missing boolean field "disclaimerConsent.agreedToGeminiTrainingUsage"/);

      expect(() =>
        loungeUserConverter.fromFirestore({
          id: 'uid_bad_status',
          data: () => ({ ...raw, status: 'UNKNOWN_STATUS' }),
        } as any),
      ).toThrow(/Invalid enum value "UNKNOWN_STATUS" for "status"/);

      expect(() =>
        loungeUserConverter.fromFirestore({
          id: 'uid_bad_lang',
          data: () => ({ ...raw, language: 'fr' }),
        } as any),
      ).toThrow(/Invalid enum value "fr" for "language"/);

      const incompleteUserRaw = { ...raw };
      delete incompleteUserRaw['onboardingCompleted'];
      expect(() =>
        loungeUserConverter.fromFirestore({
          id: 'uid_missing_onboarding',
          data: () => incompleteUserRaw,
        } as any),
      ).toThrow(/Invalid or missing boolean field "onboardingCompleted"/);

      const missingLangRaw = { ...raw };
      delete missingLangRaw['language'];
      expect(() =>
        loungeUserConverter.fromFirestore({
          id: 'uid_missing_lang',
          data: () => missingLangRaw,
        } as any),
      ).toThrow(/Invalid or missing string field "language"/);

      expect(() =>
        loungeUserConverter.fromFirestore({
          id: 'uid_bad_disclaimer_ver',
          data: () => ({
            ...raw,
            disclaimerConsent: { ...raw['disclaimerConsent'], disclaimerVersion: '1' },
          }),
        } as any),
      ).toThrow(/Invalid positive integer field "disclaimerConsent.disclaimerVersion"/);

      expect(() =>
        loungeUserConverter.fromFirestore({
          id: 'uid_bad_iso',
          data: () => ({ ...raw, lastLoginAt: 'not-a-valid-date' }),
        } as any),
      ).toThrow(/Invalid or missing datetime field "lastLoginAt"/);
    });

    it('serializes and deserializes loungeSubscriptionConverter with hybrid quota, legacy migration, and DTO projection', () => {
      const baseSub: LoungeSubscriptionDoc = {
        uid: 'uid_lounge_001',
        tier: 'STANDARD',
        status: 'ACTIVE',
        dailyTurnQuota: 100,
        dailyRemainingTurns: 80,
        purchasedRemainingTurns: 25,
        remainingChatTurns: 105,
        earliestLotExpiresAt: null,
        lastDailyResetAt: '2026-11-22T00:00:00.000Z',
        lastQuotaResetTimezone: 'Asia/Tokyo',
        nextDailyResetAt: '2026-11-23T00:00:00.000Z',
        currentPeriodEnd: '2026-12-22T12:00:00.000Z',
        trialTicketUsed: false,
        cancelAtPeriodEnd: false,
        todaysConsumedDailyTurns: 20,
        updatedAt: '2026-11-22T12:05:00.000Z',
      };
      const rawWithoutStripe = loungeSubscriptionConverter.toFirestore(baseSub);
      expect('stripeCustomerId' in rawWithoutStripe).toBe(false);
      expect(
        loungeSubscriptionConverter.fromFirestore({ id: 'uid_lounge_001', data: () => rawWithoutStripe } as any),
      ).toEqual(baseSub);

      const withStripe: LoungeSubscriptionDoc = {
        ...baseSub,
        billingCurrency: 'JPY',
        earliestLotExpiresAt: '2027-05-20T00:00:00.000Z',
        stripeCustomerId: 'cus_test_001',
        stripeSubscriptionId: 'sub_test_001',
        stripeScheduleId: 'sub_sched_test_001',
        lastProcessedInvoiceId: 'in_test_001',
        todaysSearchCount: 2,
      };
      const rawWithStripe = loungeSubscriptionConverter.toFirestore(withStripe);
      expect(rawWithStripe['stripeCustomerId']).toBe('cus_test_001');
      expect(rawWithStripe['earliestLotExpiresAt']).toBeInstanceOf(Timestamp);
      const parsedWithStripe = loungeSubscriptionConverter.fromFirestore({
        id: 'uid_lounge_001',
        data: () => rawWithStripe,
      } as any);
      expect(parsedWithStripe).toEqual(withStripe);

      const publicProjection = toPublicLoungeSubscription(parsedWithStripe);
      expect('stripeCustomerId' in publicProjection).toBe(false);
      expect('stripeSubscriptionId' in publicProjection).toBe(false);
      expect('stripeScheduleId' in publicProjection).toBe(false);
      expect('lastProcessedInvoiceId' in publicProjection).toBe(false);
      expect('todaysConsumedDailyTurns' in publicProjection).toBe(false);
      expect(publicProjection.remainingChatTurns).toBe(105);

      expect(() =>
        loungeSubscriptionConverter.fromFirestore({
          id: 'uid_legacy_001',
          data: () => ({
            tier: 'SUPPORTER',
            status: 'ACTIVE',
            dailyTurnQuota: 30,
            remainingChatTurns: 24,
            quotaResetAt: '2026-11-23T00:00:00.000Z',
            currentPeriodEnd: '2026-12-22T12:00:00.000Z',
            updatedAt: '2026-11-22T12:05:00.000Z',
          }),
        } as any),
      ).toThrow(/Invalid enum value "SUPPORTER" for "tier"/);

      const missingQuotaFieldRaw = { ...rawWithoutStripe };
      delete missingQuotaFieldRaw['trialTicketUsed'];
      expect(() =>
        loungeSubscriptionConverter.fromFirestore({
          id: 'uid_missing_trial_flag',
          data: () => missingQuotaFieldRaw,
        } as any),
      ).toThrow(/Invalid or missing boolean field "trialTicketUsed"/);

      expect(() =>
        loungeSubscriptionConverter.fromFirestore({
          id: 'bad',
          data: () => ({ ...rawWithoutStripe, dailyTurnQuota: '30' }),
        } as any),
      ).toThrow(/Invalid or missing numeric field "dailyTurnQuota"/);
    });

    it('serializes and deserializes loungeSessionConverter, loungeMessageConverter, loungeRagMemoryConverter, and loungeGalleryConverter', () => {
      const session: LoungeSessionDoc = {
        id: 'sess_001',
        uid: 'uid_lounge_001',
        title: 'Midnight Cyber Lounge',
        messageCount: 4,
        currentEmotion: 'SURPRISED',
        publicXMemorySyncedAt: '2026-11-22T12:00:00.000Z',
        lastMessagePreview: 'テスト',
        createdAt: '2026-11-22T12:00:00.000Z',
        updatedAt: '2026-11-22T12:10:00.000Z',
        archivedAt: '2026-11-22T13:00:00.000Z',
      };
      const rawSession = loungeSessionConverter.toFirestore(session);
      expect(rawSession['archivedAt']).toBeInstanceOf(Timestamp);
      expect(
        loungeSessionConverter.fromFirestore({ id: 'sess_001', data: () => rawSession } as any),
      ).toEqual(session);

      const message: LoungeMessageDoc = {
        id: 'msg_001',
        sessionId: 'sess_001',
        uid: 'uid_lounge_001',
        role: 'ASSISTANT',
        content: 'こんにちは',
        thought: 'Internal reasoning context',
        emotion: 'HAPPY',
        imageAssetId: 'img_asset_01',
        imageUrl: 'assets/gallery_morning.webp',
        tokenUsage: { promptTokens: 120, candidatesTokens: 60, totalTokens: 180 },
        createdAt: '2026-11-22T12:02:00.000Z',
      };
      const rawMsg = loungeMessageConverter.toFirestore(message);
      expect(rawMsg['thought']).toBe('Internal reasoning context');
      const roundTripMessage = loungeMessageConverter.fromFirestore({
        id: 'msg_001',
        data: () => rawMsg,
      } as any);
      expect(roundTripMessage).toEqual(message);
      const publicMsg = toPublicLoungeMessage(roundTripMessage);
      expect('thought' in publicMsg).toBe(false);
      expect(publicMsg.content).toBe('こんにちは');

      const minimalMsg: LoungeMessageDoc = {
        id: 'msg_002',
        sessionId: 'sess_001',
        uid: 'uid_lounge_001',
        role: 'USER',
        content: 'やあ',
        emotion: 'NEUTRAL',
        createdAt: '2026-11-22T12:01:00.000Z',
      };
      const rawMinimalMsg = loungeMessageConverter.toFirestore(minimalMsg);
      expect('tokenUsage' in rawMinimalMsg).toBe(false);
      expect('imageAssetId' in rawMinimalMsg).toBe(false);
      expect('imageUrl' in rawMinimalMsg).toBe(false);
      expect(
        loungeMessageConverter.fromFirestore({ id: 'msg_002', data: () => rawMinimalMsg } as any),
      ).toEqual(minimalMsg);

      const rag: LoungeRagMemoryDoc = {
        id: 'mem_001',
        uid: 'uid_lounge_001',
        sessionId: 'sess_001',
        category: 'PROMISE',
        summary: 'Prefers dark roast coffee',
        embedding: [0.12, 0.34, 0.56],
        salienceScore: 0.92,
        createdAt: '2026-11-22T12:03:00.000Z',
        updatedAt: '2026-11-22T12:03:00.000Z',
      };
      const rawRag = loungeRagMemoryConverter.toFirestore(rag);
      expect(typeof (rawRag['embedding'] as { toArray?: unknown }).toArray).toBe('function');
      expect(
        loungeRagMemoryConverter.fromFirestore({ id: 'mem_001', data: () => rawRag } as any),
      ).toEqual(rag);
      const emptyRagRaw = loungeRagMemoryConverter.toFirestore({ ...rag, embedding: [] });
      expect(emptyRagRaw['embedding']).toEqual([]);

      // VectorValue with toArray() and empty embedding fallback are decoded cleanly
      expect(
        loungeRagMemoryConverter.fromFirestore({
          id: 'mem_vec',
          data: () => ({ ...rawRag, embedding: { toArray: () => [0.5, 0.25] } }),
        } as any).embedding,
      ).toEqual([0.5, 0.25]);
      expect(
        loungeRagMemoryConverter.fromFirestore({
          id: 'mem_legacy',
          data: () => ({ ...rawRag, embedding: undefined }),
        } as any).embedding,
      ).toEqual([]);
      expect(() =>
        loungeRagMemoryConverter.fromFirestore({
          id: 'mem_bad_vec',
          data: () => ({ ...rawRag, embedding: 'invalid' }),
        } as any),
      ).toThrow(/Invalid non-array field "embedding"/);
      expect(() =>
        loungeRagMemoryConverter.fromFirestore({
          id: 'mem_nan_vec',
          data: () => ({ ...rawRag, embedding: [Number.NaN] }),
        } as any),
      ).toThrow(/Invalid non-numeric embedding element/);

      const galleryItem: LoungeGalleryItemDoc = {
        id: 'uid_lounge_001_img_asset_01',
        uid: 'uid_lounge_001',
        assetId: 'img_asset_01',
        imageUrl: 'assets/gallery_morning.webp',
        unlocked: true,
        unlockedAt: '2026-11-22T12:05:00.000Z',
        sourceSessionId: 'sess_001',
      };
      const rawGallery = loungeGalleryConverter.toFirestore(galleryItem);
      expect(rawGallery['unlockedAt']).toBeInstanceOf(Timestamp);
      expect(
        loungeGalleryConverter.fromFirestore({
          id: 'uid_lounge_001_img_asset_01',
          data: () => rawGallery,
        } as any),
      ).toEqual(galleryItem);

      expect(() =>
        loungeRagMemoryConverter.fromFirestore({
          id: 'bad',
          data: () => ({ ...rawRag, updatedAt: null }),
        } as any),
      ).toThrow(/Invalid or missing datetime field "updatedAt"/);

      const minimalSession: LoungeSessionDoc = {
        id: 'sess_min',
        uid: 'uid_lounge_001',
        title: 'Minimal Session',
        messageCount: 0,
        currentEmotion: 'NEUTRAL',
        publicXMemorySyncedAt: '2026-11-22T12:00:00.000Z',
        lastMessagePreview: '',
        createdAt: '2026-11-22T12:00:00.000Z',
        updatedAt: '2026-11-22T12:00:00.000Z',
      };
      const rawMinSession = loungeSessionConverter.toFirestore(minimalSession);
      expect('archivedAt' in rawMinSession).toBe(false);
      expect(() =>
        loungeSessionConverter.fromFirestore({
          id: 'sess_bad_preview',
          data: () => ({ ...rawMinSession, lastMessagePreview: 123 }),
        } as any),
      ).toThrow(/Invalid non-string field "lastMessagePreview"/);

      const lockedGallery: LoungeGalleryItemDoc = {
        id: 'uid_lounge_001_img_asset_02',
        uid: 'uid_lounge_001',
        assetId: 'img_asset_02',
        imageUrl: '',
        unlocked: false,
      };
      const rawLocked = loungeGalleryConverter.toFirestore(lockedGallery);
      expect('unlockedAt' in rawLocked).toBe(false);
      expect('sourceSessionId' in rawLocked).toBe(false);
      expect(
        loungeGalleryConverter.fromFirestore({
          id: 'uid_lounge_001_img_asset_02',
          data: () => rawLocked,
        } as any),
      ).toEqual(lockedGallery);

      expect(() =>
        loungeGalleryConverter.fromFirestore({
          id: 'uid_bad_unlock',
          data: () => ({ ...rawLocked, unlocked: 'false' }),
        } as any),
      ).toThrow(/Invalid or missing boolean field "unlocked"/);

      expect(() =>
        loungeMessageConverter.fromFirestore({
          id: 'msg_bad_content',
          data: () => ({ ...rawMinimalMsg, content: 99, tokenUsage: null }),
        } as any),
      ).toThrow(/Invalid non-string field "content"/);

      // Strict optional field type rejection prevents silently ignoring corrupted data
      expect(() =>
        loungeSubscriptionConverter.fromFirestore({
          id: 'sub_bad_stripe',
          data: () => ({
            ...loungeSubscriptionConverter.toFirestore({
              uid: 'uid_lounge_001',
              tier: 'FREE',
              status: 'NONE',
              dailyTurnQuota: 5,
              dailyRemainingTurns: 5,
              purchasedRemainingTurns: 0,
              remainingChatTurns: 5,
              earliestLotExpiresAt: null,
              lastDailyResetAt: '2026-11-22T00:00:00.000Z',
              lastQuotaResetTimezone: 'Asia/Tokyo',
              nextDailyResetAt: '2026-11-23T00:00:00.000Z',
              currentPeriodEnd: '2026-12-22T12:00:00.000Z',
              trialTicketUsed: false,
              cancelAtPeriodEnd: false,
              todaysConsumedDailyTurns: 0,
              updatedAt: '2026-11-22T12:05:00.000Z',
            }),
            stripeCustomerId: 12345,
          }),
        } as any),
      ).toThrow(/Invalid non-string optional field "stripeCustomerId"/);

      expect(() =>
        loungeMessageConverter.fromFirestore({
          id: 'msg_bad_usage',
          data: () => ({ ...rawMinimalMsg, tokenUsage: ['corrupt'] }),
        } as any),
      ).toThrow(/Invalid non-object field "tokenUsage"/);

      expect(() =>
        loungeMessageConverter.fromFirestore({
          id: 'msg_bad_asset',
          data: () => ({ ...rawMinimalMsg, imageAssetId: 777 }),
        } as any),
      ).toThrow(/Invalid non-string optional field "imageAssetId"/);

      expect(() =>
        loungeGalleryConverter.fromFirestore({
          id: 'gal_bad_source',
          data: () => ({ ...rawLocked, sourceSessionId: { nested: true } }),
        } as any),
      ).toThrow(/Invalid non-string optional field "sourceSessionId"/);

      // Isolated lounge_processed_events idempotency serialization
      const processedEvent: LoungeProcessedEventDoc = {
        eventId: 'evt_test_001',
        eventType: 'checkout.session.completed',
        uid: 'uid_lounge_001',
        processedAt: '2026-11-23T01:00:00.000Z',
      };
      const rawEvt = loungeProcessedEventConverter.toFirestore(processedEvent);
      expect(rawEvt['processedAt']).toBeInstanceOf(Timestamp);
      expect(
        loungeProcessedEventConverter.fromFirestore({
          id: 'evt_test_001',
          data: () => rawEvt,
        } as any),
      ).toEqual(processedEvent);
      const minimalEvt: LoungeProcessedEventDoc = {
        eventId: 'evt_test_002',
        eventType: 'quota.daily_reset',
        processedAt: '2026-11-23T01:00:00.000Z',
      };
      const rawMinEvt = loungeProcessedEventConverter.toFirestore(minimalEvt);
      expect('uid' in rawMinEvt).toBe(false);
      expect(
        loungeProcessedEventConverter.fromFirestore({
          id: 'evt_test_002',
          data: () => rawMinEvt,
        } as any),
      ).toEqual(minimalEvt);

      expect(COLLECTIONS.LOUNGE_PROCESSED_EVENTS).not.toBe(COLLECTIONS.PROCESSED_EVENTS);
      expect(() =>
        loungeProcessedEventConverter.fromFirestore({
          id: 'evt_bad_uid',
          data: () => ({ ...rawMinEvt, uid: 12345 }),
        } as any),
      ).toThrow(/Invalid non-string optional field "uid"/);
      expect(() =>
        loungeProcessedEventConverter.fromFirestore({
          id: 'evt_bad_ts',
          data: () => ({ ...rawMinEvt, processedAt: 12345 }),
        } as any),
      ).toThrow(/Invalid or missing datetime field "processedAt"/);

      const ttlEvent: LoungeProcessedEventDoc = {
        eventId: 'evt_ttl_001',
        eventType: 'invoice.paid',
        uid: 'uid_lounge_001',
        targetId: 'in_test_001',
        processedAt: '2026-11-23T01:00:00.000Z',
        expireAt: '2027-02-21T01:00:00.000Z',
      };
      const rawTtlEvt = loungeProcessedEventConverter.toFirestore(ttlEvent);
      expect(rawTtlEvt['expireAt']).toBeInstanceOf(Timestamp);
      expect(
        loungeProcessedEventConverter.fromFirestore({
          id: 'evt_ttl_001',
          data: () => rawTtlEvt,
        } as any),
      ).toEqual(ttlEvent);
    });

    it('serializes and deserializes loungeCreditLotConverter, loungeQuotaLedgerConverter, and non-PII loungeTrialGrantConverter', () => {
      const lot: LoungeCreditLotDoc = {
        id: 'cs_test_001',
        uid: 'uid_lounge_001',
        productId: 'CHARGE_TICKET_100',
        isPaid: true,
        initialTurns: 100,
        remainingTurns: 75,
        currency: 'JPY',
        unitAmount: 500,
        status: 'ACTIVE',
        stripePaymentIntentId: 'pi_test_001',
        purchasedAt: '2026-11-22T12:00:00.000Z',
        expiresAt: '2027-05-21T12:00:00.000Z',
      };
      const rawLot = loungeCreditLotConverter.toFirestore(lot);
      expect(rawLot['purchasedAt']).toBeInstanceOf(Timestamp);
      expect(rawLot['expiresAt']).toBeInstanceOf(Timestamp);
      const parsedLot = loungeCreditLotConverter.fromFirestore({
        id: 'cs_test_001',
        data: () => rawLot,
      } as any);
      expect(parsedLot).toEqual(lot);
      const publicLot = toPublicLoungeCreditLot(parsedLot);
      expect('stripePaymentIntentId' in publicLot).toBe(false);

      expect(() =>
        loungeCreditLotConverter.fromFirestore({
          id: 'lot_bad_neg',
          data: () => ({ ...rawLot, remainingTurns: -1 }),
        } as any),
      ).toThrow(/Invalid non-negative integer field "remainingTurns"/);

      const ledger: LoungeQuotaLedgerDoc = {
        id: 'ledger_001',
        uid: 'uid_lounge_001',
        deltaType: 'RESERVE_LOT',
        deltaDaily: 0,
        deltaPurchased: -1,
        balanceTotalAfter: 74,
        lotId: 'cs_test_001',
        referenceId: 'msg_001',
        createdAt: '2026-11-22T12:05:00.000Z',
        expireAt: '2027-05-21T12:05:00.000Z',
      };
      const rawLedger = loungeQuotaLedgerConverter.toFirestore(ledger);
      expect(rawLedger['expireAt']).toBeInstanceOf(Timestamp);
      expect(
        loungeQuotaLedgerConverter.fromFirestore({
          id: 'ledger_001',
          data: () => rawLedger,
        } as any),
      ).toEqual(ledger);

      const grant: LoungeTrialGrantDoc = {
        xUserIdHash: 'hmac_digest_v1',
        keyVersion: 1,
        riskStatus: 'OK',
        welcomeBonusGrantedAt: '2026-11-22T12:00:00.000Z',
        trialTicketGrantedAt: '2026-11-22T12:30:00.000Z',
        retainUntil: '2029-11-22T12:00:00.000Z',
      };
      const rawGrant = loungeTrialGrantConverter.toFirestore(grant);
      expect(rawGrant['retainUntil']).toBeInstanceOf(Timestamp);
      expect(
        loungeTrialGrantConverter.fromFirestore({
          id: 'hmac_digest_v1',
          data: () => rawGrant,
        } as any),
      ).toEqual(grant);

      expect(() =>
        loungeTrialGrantConverter.toFirestore({
          ...grant,
          uid: 'uid_leak',
        } as unknown as LoungeTrialGrantDoc),
      ).toThrow(/Forbidden PII field "uid"/);

      expect(() =>
        loungeTrialGrantConverter.fromFirestore({
          id: 'hmac_leak',
          data: () => ({ ...rawGrant, stripeSessionId: 'cs_leak' }),
        } as any),
      ).toThrow(/Forbidden PII field "stripeSessionId"/);
    });

    it('enforces multi-tenant uid isolation via createUserScopedLoungeDb and assertLoungeRecordOwnedByUid', () => {
      const mockWhere = jest.fn().mockReturnValue({ scoped: true });
      const mockDoc = jest.fn((id: string) => ({ docId: id }));
      const scopedCollections = {
        loungeUsers: { doc: mockDoc } as any,
        loungeSubscriptions: { doc: mockDoc } as any,
        loungeSessions: { doc: mockDoc } as any,
        loungeMessages: { where: mockWhere } as any,
        loungeRagMemories: { where: mockWhere } as any,
        loungeGallery: { doc: mockDoc, where: mockWhere } as any,
        loungeCreditLots: { doc: mockDoc, where: mockWhere } as any,
        loungeQuotaLedger: { where: mockWhere } as any,
      };

      expect(() => createUserScopedLoungeDb(scopedCollections, '   ')).toThrow(
        /empty uid/,
      );
      const scoped = createUserScopedLoungeDb(scopedCollections, 'uid_owner_01');
      expect(scoped.userDoc()).toEqual({ docId: 'uid_owner_01' });
      expect(scoped.subscriptionDoc()).toEqual({ docId: 'uid_owner_01' });
      expect(scoped.sessionDoc()).toEqual({ docId: 'uid_owner_01' });
      expect(scoped.galleryDoc('img_01')).toEqual({ docId: 'uid_owner_01_img_01' });
      expect(scoped.creditLotDoc('cs_01')).toEqual({ docId: 'cs_01' });
      expect(scoped.messagesQuery()).toEqual({ scoped: true });
      expect(scoped.ragMemoriesQuery()).toEqual({ scoped: true });
      expect(scoped.galleryQuery()).toEqual({ scoped: true });
      expect(scoped.creditLotsQuery()).toEqual({ scoped: true });
      expect(scoped.quotaLedgerQuery()).toEqual({ scoped: true });
      expect(mockWhere).toHaveBeenNthCalledWith(1, 'uid', '==', 'uid_owner_01');
      expect(mockWhere).toHaveBeenNthCalledWith(2, 'uid', '==', 'uid_owner_01');
      expect(mockWhere).toHaveBeenNthCalledWith(3, 'uid', '==', 'uid_owner_01');
      expect(mockWhere).toHaveBeenNthCalledWith(4, 'uid', '==', 'uid_owner_01');
      expect(mockWhere).toHaveBeenNthCalledWith(5, 'uid', '==', 'uid_owner_01');

      const ownedRecord = { uid: 'uid_owner_01', content: 'hi' };
      expect(scoped.assertOwned(ownedRecord, COLLECTIONS.LOUNGE_MESSAGES)).toBe(ownedRecord);
      expect(() =>
        scoped.assertOwned({ uid: 'uid_other_02' }, COLLECTIONS.LOUNGE_MESSAGES),
      ).toThrow(/Cross-tenant access blocked/);
      expect(() =>
        assertLoungeRecordOwnedByUid({ uid: 'uid_owner_01' }, '', COLLECTIONS.LOUNGE_USERS),
      ).toThrow(/must not be empty/);

      // Minimal per-slice scoped builders enforce matching isolation without unrelated collection requirements
      const accountScoped = createUserScopedLoungeAccountDb(scopedCollections, 'uid_owner_01');
      expect(accountScoped.subscriptionDoc()).toEqual({ docId: 'uid_owner_01' });
      expect(accountScoped.creditLotDoc('cs_02')).toEqual({ docId: 'cs_02' });
      expect(accountScoped.assertOwned(ownedRecord, COLLECTIONS.LOUNGE_SUBSCRIPTIONS)).toBe(
        ownedRecord,
      );

      const galleryScoped = createUserScopedLoungeGalleryDb(scopedCollections, 'uid_owner_01');
      expect(galleryScoped.userDoc()).toEqual({ docId: 'uid_owner_01' });
      expect(galleryScoped.galleryDoc('img_02')).toEqual({ docId: 'uid_owner_01_img_02' });

      const sessionScoped = createUserScopedLoungeSessionDb(scopedCollections, 'uid_owner_01');
      expect(sessionScoped.userDoc()).toEqual({ docId: 'uid_owner_01' });
      expect(sessionScoped.sessionDoc()).toEqual({ docId: 'uid_owner_01' });
      expect(() => createUserScopedLoungeAccountDb(scopedCollections, '')).toThrow(/empty uid/);
      expect(() => createUserScopedLoungeGalleryDb(scopedCollections, ' ')).toThrow(/empty uid/);
      expect(() => createUserScopedLoungeSessionDb(scopedCollections, '')).toThrow(/empty uid/);
    });
  });
});
