/**
 * @rebecca/db – Collection names, Firestore converters, and typed collection references.
 *
 * DESIGN PRINCIPLES:
 *  - Zero initialisation: this package never calls `new Firestore()`.
 *    The caller (app layer) owns the Firestore instance and passes it in.
 *  - Single source of truth for collection name strings.
 *    Eliminating magic string literals prevents typos and eases renames.
 *  - Full type-safety via FirestoreDataConverter<T>.
 *    Every read/write goes through a converter, so TypeScript catches
 *    mismatches at compile time rather than at runtime.
 *  - Timestamp ↔ ISO-string bridge:
 *    `@rebecca/types` exposes Firestore-agnostic ISO strings for fields
 *    that are stored as Firestore Timestamps on disk (expireAt, lastUsedAt,
 *    lastInteractionAt).  Converters handle the translation transparently.
 */

import {
  Firestore,
  FieldValue,
  Timestamp,
  FirestoreDataConverter,
  DocumentData,
  QueryDocumentSnapshot,
} from '@google-cloud/firestore';

import {
  LOUNGE_SUPPORTED_LANGUAGES,
  type AdminRole,
  type AdminUser,
  type AdminUserStatus,
  type ProcessedEvent,
} from '@rebecca/types';
import {
  COLLECTIONS,
  type ConversationLogEntry,
  type UserCoreProfile,
  type FirestoreUser,
  type RawConversationLog,
  type TimelinePost,
  type RagMemory,
  type ImageDoc,
  type ProcessedFollower,
  type ListInteraction,
  type RateLimitDoc,
  type PersonaDoc,
  type XApiStateDoc,
  type CampaignDoc,
  type CampaignSlot,
  type SlotTimePeriod,
  type CampaignSlotStatus,
  type CampaignStatus,
  type RewardImageDoc,
  type SupportTransactionDoc,
  type LoungeAccountStatus,
  type LoungeCreditCurrency,
  type LoungeCreditLotDoc,
  type LoungeCreditLotStatus,
  type LoungeCurrency,
  type LoungeEmotionState,
  type LoungeGalleryItemDoc,
  type LoungeMemoryCategory,
  type LoungeMessageDoc,
  type LoungeProcessedEventDoc,
  type LoungeQuotaDeltaType,
  type LoungeQuotaLedgerDoc,
  type LoungeRagMemoryDoc,
  type LoungeSenderRole,
  type LoungeSessionDoc,
  type LoungeSubscriptionDoc,
  type LoungeSubscriptionStatus,
  type LoungeSubscriptionTier,
  type LoungeTokenUsage,
  type LoungeTrialGrantDoc,
  type LoungeUserDisclaimerConsent,
  type LoungeUserDoc,
} from './schema';

// ---------------------------------------------------------------------------
// Helper: safe Timestamp → ISO string conversion
// ---------------------------------------------------------------------------

/**
 * Converts a Firestore Timestamp, JavaScript Date, ISO string, or null/undefined
 * to a standardized ISO 8601 string.
 *
 * This utility isolates the `@rebecca/types` package from `@google-cloud/firestore` dependencies
 * by ensuring that Firestore Timestamps are serialized into portable strings before leaving the
 * database layer.
 *
 * @param value - The temporal value to convert. Can be a Firestore Timestamp, Date object, string, or nullish.
 * @returns An ISO 8601 string representation of the date, or `null` if the input is nullish.
 */
function toIsoString(value: Timestamp | Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return value; // already a string
}

// ---------------------------------------------------------------------------
// Firestore data converters
// ---------------------------------------------------------------------------

/**
 * Converter for the `users` collection.
 * FirestoreUser fields are all JSON-safe, so no Timestamp translation is needed.
 */
const userConverter: FirestoreDataConverter<FirestoreUser> = {
  toFirestore(user: FirestoreUser): DocumentData {
    return { ...user };
  },
  fromFirestore(snapshot: QueryDocumentSnapshot): FirestoreUser {
    const data = snapshot.data();
    return {
      id: snapshot.id,
      name: data['name'] ?? '',
      username: data['username'] ?? '',
      avatarUrl: data['avatarUrl'] ?? '',
      status: data['status'],
      firstSeen: toIsoString(data['firstSeen'] ?? data['first_seen']) ?? '',
      lastSeen: toIsoString(data['lastSeen'] ?? data['last_seen'] ?? data['last_reply_date']) ?? '',
      lastDreamedAt: toIsoString(data['lastDreamedAt'] ?? data['last_dreamed_at']) ?? undefined,
      coreProfile: data['coreProfile'] ?? {},
      working_memory: data['working_memory'],
      episodicBuffer: data['episodicBuffer'] ?? [],
      lastReplyDate: data['lastReplyDate'] ?? data['last_reply_date'],
      dailyReplyCount: data['dailyReplyCount'] ?? data['daily_reply_count'],
    };
  },
};

/**
 * Converter for the `conversation_logs` collection.
 * Translates the Firestore Timestamp `expireAt` ↔ ISO string on read/write.
 */
const conversationLogConverter: FirestoreDataConverter<RawConversationLog> = {
  toFirestore(log: RawConversationLog): DocumentData {
    return {
      ...log,
      thought: log.thought ?? null,
      expireAt: log.expireAt ? Timestamp.fromDate(new Date(log.expireAt)) : null,
    };
  },
  fromFirestore(snapshot: QueryDocumentSnapshot): RawConversationLog {
    const data = snapshot.data();
    return {
      userId: data['userId'],
      userText: data['userText'],
      aiText: data['aiText'],
      thought: data['thought'],
      timestamp: data['timestamp'],
      expireAt: toIsoString(data['expireAt']) ?? '',
    };
  },
};

/**
 * Converter for the `timeline_history` collection.
 * Translates Firestore Timestamp `expireAt` ↔ ISO string on read/write.
 */
const timelinePostConverter: FirestoreDataConverter<TimelinePost> = {
  toFirestore(post: TimelinePost): DocumentData {
    return {
      ...post,
      thought: post.thought ?? null,
      reposts: Number(post.reposts ?? 0),
      mediaUrls: post.mediaUrls ?? [],
      tweetId: post.tweetId ?? '',
      expireAt: post.expireAt ? Timestamp.fromDate(new Date(post.expireAt)) : null,
    };
  },
  fromFirestore(snapshot: QueryDocumentSnapshot): TimelinePost {
    const data = snapshot.data();
    return {
      text: String(data['text'] ?? ''),
      thought: data['thought'],
      tweetId: String(data['tweetId'] ?? ''),
      timestamp: String(data['timestamp'] ?? ''),
      expireAt: toIsoString(data['expireAt']) ?? '',
      status: data['status'],
      impressions: Number(data['impressions'] ?? 0),
      likes: Number(data['likes'] ?? 0),
      reposts: Number(data['reposts'] ?? 0),
      replies: Number(data['replies'] ?? 0),
      mediaUrls: (Array.isArray(data['mediaUrls']) ? data['mediaUrls'] : []) as string[],
      authorId: data['authorId'],
      authorName: data['authorName'],
      authorHandle: data['authorHandle'],
      authorAvatarUrl: data['authorAvatarUrl'],
      assetId: data['assetId'],
      postType: data['postType'],
      newsTitle: data['newsTitle'],
      newsEmbedding: data['newsEmbedding'],
      anniversaryTitle: data['anniversaryTitle'],
      poll: data['poll'],
      pollResultStatus: data['pollResultStatus'],
      pollResultTweetId: data['pollResultTweetId'],
    };
  },
};

/**
 * Converter for the `rag_memories` collection.
 * Note: the `embedding` field is stored as a Firestore VectorValue (via FieldValue.vector()),
 * not a plain number[]. Reads return the raw data; writes use the caller's FieldValue.vector().
 * The embedding field is typed as number[] in @rebecca/types for portability, but
 * the actual stored value may be a VectorValue on read. skipLibCheck handles this.
 */
const ragMemoryConverter: FirestoreDataConverter<RagMemory> = {
  toFirestore(memory: RagMemory): DocumentData {
    // embedding must be set by the caller using FieldValue.vector() AFTER converter.
    // We pass it through and let Firestore accept whatever value is provided.
    return { ...memory };
  },
  fromFirestore(snapshot: QueryDocumentSnapshot): RagMemory {
    const data = snapshot.data();
    return {
      userId: data['userId'],
      text: data['text'],
      embedding: data['embedding'] as number[],
      timestamp: data['timestamp'],
    };
  },
};

/**
 * Converter for the `images` collection.
 * Translates Firestore Timestamp `lastUsedAt` ↔ ISO string.
 */
const imageDocConverter: FirestoreDataConverter<ImageDoc> = {
  toFirestore(image: ImageDoc): DocumentData {
    const data: DocumentData = { ...image };
    if (image.lastUsedAt !== undefined) {
      if (image.lastUsedAt) {
        const parsedDate = new Date(image.lastUsedAt);
        data['lastUsedAt'] = !isNaN(parsedDate.getTime())
          ? Timestamp.fromDate(parsedDate)
          : null;
      } else {
        data['lastUsedAt'] = null;
      }
    }
    return data;
  },
  fromFirestore(snapshot: QueryDocumentSnapshot): ImageDoc {
    const data = snapshot.data();
    return {
      url: data['url'],
      filename: data['filename'],
      caption: data['caption'],
      embedding: data['embedding'] as number[],
      lastUsedAt: toIsoString(data['lastUsedAt']),
      useCount: data['useCount'] ?? 0,
      status: data['status'],
      createdAt: toIsoString(data['createdAt']) ?? undefined,
    };
  },
};

/**
 * Converter for the `processed_followers` collection.
 */
const processedFollowerConverter: FirestoreDataConverter<ProcessedFollower> = {
  toFirestore(follower: ProcessedFollower): DocumentData {
    return { ...follower };
  },
  fromFirestore(snapshot: QueryDocumentSnapshot): ProcessedFollower {
    const data = snapshot.data();
    return {
      userId: data['userId'],
      timestamp: data['timestamp'],
      listStatus: data['listStatus'] ?? 'ADDED',
    };
  },
};

/**
 * Converter for the `list_interaction_history` collection.
 * Translates Firestore Timestamp `lastInteractionAt` ↔ ISO string.
 */
const listInteractionConverter: FirestoreDataConverter<ListInteraction> = {
  toFirestore(interaction: ListInteraction): DocumentData {
    return {
      ...interaction,
      lastInteractionAt: interaction.lastInteractionAt
        ? Timestamp.fromDate(new Date(interaction.lastInteractionAt))
        : null,
    };
  },
  fromFirestore(snapshot: QueryDocumentSnapshot): ListInteraction {
    const data = snapshot.data();
    return {
      userId: data['userId'],
      lastInteractionAt: toIsoString(data['lastInteractionAt']) ?? '',
    };
  },
};

/**
 * Creates a generic, pass-through FirestoreDataConverter for documents that do not require
 * specific serialization logic.
 *
 * This is useful for simple counter or flag documents (e.g., rate_limits, system_stats) where
 * the data is read and written as raw `DocumentData` and contains dynamic fields like
 * `FieldValue.increment` or `FieldValue.serverTimestamp`.
 *
 * @template T - The generic type representing the shape of the document data.
 * @returns A FirestoreDataConverter typed for `T` that performs no translation.
 */
function makePassThroughConverter<T extends DocumentData>(): FirestoreDataConverter<T> {
  return {
    toFirestore: (data: T) => data,
    fromFirestore: (snapshot: QueryDocumentSnapshot) => snapshot.data() as T,
  };
}

const ADMIN_ROLES: readonly AdminRole[] = ['ADMIN'];
const ADMIN_USER_STATUSES: readonly AdminUserStatus[] = ['ACTIVE', 'REVOKED'];

/**
 * Validated converter for the `admin_users` RBAC authorization collection.
 * Rejects malformed or missing role/status/email/createdAt fields fail-fast.
 */
const adminUserConverter: FirestoreDataConverter<AdminUser> = {
  toFirestore(admin: AdminUser): DocumentData {
    return {
      ...(admin.uid !== undefined ? { uid: admin.uid } : {}),
      email: admin.email,
      role: admin.role,
      status: admin.status,
      createdAt: toRequiredFirestoreTimestamp(admin.createdAt, 'createdAt'),
    };
  },
  fromFirestore(snapshot: QueryDocumentSnapshot): AdminUser {
    const data = snapshot.data();
    const id = snapshot.id;
    const uid = toOptionalString(data['uid'], COLLECTIONS.ADMIN_USERS, id, 'uid');
    return {
      uid: uid ?? id,
      email: toRequiredString(data['email'], COLLECTIONS.ADMIN_USERS, id, 'email'),
      role: toRequiredEnum(data['role'], ADMIN_ROLES, COLLECTIONS.ADMIN_USERS, id, 'role'),
      status: toRequiredEnum(
        data['status'],
        ADMIN_USER_STATUSES,
        COLLECTIONS.ADMIN_USERS,
        id,
        'status',
      ),
      createdAt: toRequiredLoungeIso(data['createdAt'], COLLECTIONS.ADMIN_USERS, id, 'createdAt'),
    };
  },
};

export const rateLimitConverter = makePassThroughConverter<RateLimitDoc>();
export const personaConverter = makePassThroughConverter<PersonaDoc>();
export const xApiStateConverter = makePassThroughConverter<XApiStateDoc>();

/**
 * Converter for the `campaigns` collection.
 */
const campaignDocConverter: FirestoreDataConverter<CampaignDoc> = {
  toFirestore(campaign: CampaignDoc): DocumentData {
    const data: DocumentData = {};
    if (campaign.title !== undefined) {
      data['title'] = campaign.title;
    }
    if (campaign.status !== undefined) {
      data['status'] = campaign.status;
    }
    if (campaign.isPaused !== undefined) {
      data['isPaused'] = Boolean(campaign.isPaused);
    }
    if (campaign.startDate !== undefined) {
      data['startDate'] = campaign.startDate;
    }
    if (campaign.endDate !== undefined) {
      data['endDate'] = campaign.endDate;
    }
    if (campaign.dailySlotTimes !== undefined) {
      data['dailySlotTimes'] = Array.isArray(campaign.dailySlotTimes) ? campaign.dailySlotTimes : [];
    }
    if (campaign.masterContext !== undefined) {
      data['masterContext'] = campaign.masterContext ?? '';
    }
    if (campaign.replyContextSummary !== undefined) {
      data['replyContextSummary'] = campaign.replyContextSummary ?? '';
    }
    if (campaign.slots !== undefined) {
      data['slots'] = Array.isArray(campaign.slots)
        ? campaign.slots.map((slot: CampaignSlot) => ({
            slotId: slot.slotId,
            dayNumber: slot.dayNumber,
            timePeriod: slot.timePeriod,
            scheduledTime: slot.scheduledTime,
            theme: slot.theme,
            mediaUrl: slot.mediaUrl ?? null,
            captionPromptHint: slot.captionPromptHint ?? null,
            fixedTextOverride: slot.fixedTextOverride ?? null,
            isFixedText: Boolean(slot.isFixedText),
            status: slot.status,
            postedTweetId: slot.postedTweetId ?? null,
            postedAt: slot.postedAt ?? null,
            errorReason: slot.errorReason ?? null,
          }))
        : [];
    }
    if (campaign.totalSlotsCount !== undefined) {
      data['totalSlotsCount'] = Number(campaign.totalSlotsCount ?? 0);
    }
    if (campaign.completedSlotsCount !== undefined) {
      data['completedSlotsCount'] = Number(campaign.completedSlotsCount ?? 0);
    }
    if (campaign.isAnnualRecurring !== undefined) {
      data['isAnnualRecurring'] = Boolean(campaign.isAnnualRecurring);
    }
    if (campaign.updatedAt !== undefined) {
      data['updatedAt'] = campaign.updatedAt;
    }
    if (campaign.createdAt !== undefined) {
      data['createdAt'] = campaign.createdAt;
    }
    if (campaign.description !== undefined) {
      data['description'] = campaign.description;
    }
    if (campaign.hashtag !== undefined) {
      data['hashtag'] = campaign.hashtag;
    }
    if (campaign.recurringApprovedYear !== undefined) {
      data['recurringApprovedYear'] = campaign.recurringApprovedYear;
    }

    return data;
  },
  fromFirestore(snapshot: QueryDocumentSnapshot): CampaignDoc {
    const data = snapshot.data();

    // Enforce mandatory document fields - fail fast on schema corruption rather than masking
    if (
      typeof data['title'] !== 'string' ||
      typeof data['startDate'] !== 'string' ||
      typeof data['endDate'] !== 'string' ||
      typeof data['status'] !== 'string'
    ) {
      throw new Error(
        `Corrupted Campaign document [${snapshot.id}]: missing required root fields (title, startDate, endDate, status).`,
      );
    }

    const rawSlots = data['slots'];
    if (!Array.isArray(rawSlots)) {
      throw new Error(`Corrupted Campaign document [${snapshot.id}]: slots must be an array.`);
    }

    const slots: CampaignSlot[] = rawSlots.map((s, index): CampaignSlot => {
      if (
        !s ||
        typeof s['slotId'] !== 'string' ||
        typeof s['dayNumber'] !== 'number' ||
        typeof s['timePeriod'] !== 'string' ||
        typeof s['scheduledTime'] !== 'string' ||
        typeof s['theme'] !== 'string' ||
        typeof s['status'] !== 'string'
      ) {
        throw new Error(
          `Corrupted CampaignSlot at index ${index} in document [${snapshot.id}]: missing required slot fields (slotId, dayNumber, timePeriod, scheduledTime, theme, status).`,
        );
      }

      return {
        slotId: s['slotId'],
        dayNumber: s['dayNumber'],
        timePeriod: s['timePeriod'] as SlotTimePeriod,
        scheduledTime: s['scheduledTime'],
        theme: s['theme'],
        mediaUrl: typeof s['mediaUrl'] === 'string' ? s['mediaUrl'] : undefined,
        captionPromptHint: typeof s['captionPromptHint'] === 'string' ? s['captionPromptHint'] : undefined,
        fixedTextOverride: typeof s['fixedTextOverride'] === 'string' ? s['fixedTextOverride'] : undefined,
        isFixedText: Boolean(s['isFixedText']),
        status: s['status'] as CampaignSlotStatus,
        postedTweetId: typeof s['postedTweetId'] === 'string' ? s['postedTweetId'] : undefined,
        postedAt:
          toIsoString(s['postedAt'] as Timestamp | Date | string | null | undefined) ??
          (typeof s['postedAt'] === 'string' ? s['postedAt'] : undefined),
        errorReason: typeof s['errorReason'] === 'string' ? s['errorReason'] : undefined,
      };
    });

    const createdAtIso = toIsoString(data['createdAt']);
    const updatedAtIso = toIsoString(data['updatedAt']);

    return {
      id: snapshot.id,
      title: data['title'],
      description: typeof data['description'] === 'string' ? data['description'] : undefined,
      status: data['status'] as CampaignStatus,
      isPaused: Boolean(data['isPaused']),
      startDate: data['startDate'],
      endDate: data['endDate'],
      dailySlotTimes: Array.isArray(data['dailySlotTimes']) ? (data['dailySlotTimes'] as string[]) : [],
      masterContext: typeof data['masterContext'] === 'string' ? data['masterContext'] : '',
      replyContextSummary: typeof data['replyContextSummary'] === 'string' ? data['replyContextSummary'] : '',
      hashtag: typeof data['hashtag'] === 'string' ? data['hashtag'] : undefined,
      slots,
      totalSlotsCount: typeof data['totalSlotsCount'] === 'number' ? data['totalSlotsCount'] : slots.length,
      completedSlotsCount:
        typeof data['completedSlotsCount'] === 'number'
          ? data['completedSlotsCount']
          : slots.filter((s) => s.status === 'posted').length,
      isAnnualRecurring: Boolean(data['isAnnualRecurring']),
      recurringApprovedYear:
        data['recurringApprovedYear'] != null ? Number(data['recurringApprovedYear']) : undefined,
      createdAt: createdAtIso ?? (typeof data['createdAt'] === 'string' ? data['createdAt'] : new Date().toISOString()),
      updatedAt: updatedAtIso ?? (typeof data['updatedAt'] === 'string' ? data['updatedAt'] : new Date().toISOString()),
    };
  },
};

// ---------------------------------------------------------------------------
// Isolated Private Lounge Converters & Schema Guards
// ---------------------------------------------------------------------------

const LOUNGE_ACCOUNT_STATUSES: readonly LoungeAccountStatus[] = ['ACTIVE', 'SUSPENDED', 'DELETING'];
const LOUNGE_SUBSCRIPTION_TIERS: readonly LoungeSubscriptionTier[] = ['FREE', 'STANDARD'];
const LOUNGE_SUBSCRIPTION_STATUSES: readonly LoungeSubscriptionStatus[] = [
  'NONE',
  'ACTIVE',
  'CANCELING',
  'PAST_DUE',
  'CANCELED',
];
const LOUNGE_CURRENCIES: readonly LoungeCurrency[] = ['JPY', 'USD'];
const LOUNGE_CREDIT_CURRENCIES: readonly LoungeCreditCurrency[] = ['NONE', 'JPY', 'USD'];
const LOUNGE_CREDIT_LOT_PRODUCTS: ReadonlyArray<LoungeCreditLotDoc['productId']> = [
  'WELCOME_BONUS_20',
  'TRIAL_TICKET_100',
  'CHARGE_TICKET_100',
];
const LOUNGE_CREDIT_LOT_STATUSES: readonly LoungeCreditLotStatus[] = [
  'ACTIVE',
  'EXHAUSTED',
  'EXPIRED',
  'REVOKED',
];
const LOUNGE_QUOTA_DELTA_TYPES: readonly LoungeQuotaDeltaType[] = [
  'RESERVE_DAILY',
  'RESERVE_LOT',
  'COMPENSATION_REFUND',
  'GRANT_WELCOME',
  'GRANT_LOT',
  'DAILY_RESET',
  'REFUND_CLAWBACK',
  'UPGRADE_TOPUP',
];
const LOUNGE_TRIAL_RISK_STATUSES: ReadonlyArray<LoungeTrialGrantDoc['riskStatus']> = [
  'OK',
  'DISPUTE_BLOCKED',
];
const LOUNGE_EMOTION_STATES: readonly LoungeEmotionState[] = [
  'NEUTRAL',
  'HAPPY',
  'TEASING',
  'SHY',
  'EXCITED',
  'THOUGHTFUL',
  'SURPRISED',
];
const LOUNGE_SENDER_ROLES: readonly LoungeSenderRole[] = ['USER', 'ASSISTANT', 'SYSTEM'];
const LOUNGE_MEMORY_CATEGORIES: readonly LoungeMemoryCategory[] = [
  'EPISODE',
  'PREFERENCE',
  'PROMISE',
  'NICKNAME',
];

function toRequiredFirestoreTimestamp(iso: string, fieldName: string): Timestamp {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ISO 8601 datetime string for Lounge field "${fieldName}"`);
  }
  return Timestamp.fromDate(parsed);
}

function toRequiredLoungeIso(
  value: Timestamp | Date | string | null | undefined,
  collectionName: string,
  docId: string,
  fieldName: string,
): string {
  const iso = toIsoString(value);
  if (typeof iso !== 'string' || !iso || Number.isNaN(Date.parse(iso))) {
    throw new Error(
      `Invalid or missing datetime field "${fieldName}" in ${collectionName} doc "${docId}"`,
    );
  }
  return iso;
}

function toOptionalLoungeIso(
  value: Timestamp | Date | string | null | undefined,
  collectionName: string,
  docId: string,
  fieldName: string,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return toRequiredLoungeIso(value, collectionName, docId, fieldName);
}

function toRequiredString(
  value: unknown,
  collectionName: string,
  docId: string,
  fieldName: string,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `Invalid or missing string field "${fieldName}" in ${collectionName} doc "${docId}"`,
    );
  }
  return value;
}

function toValidatedString(
  value: unknown,
  collectionName: string,
  docId: string,
  fieldName: string,
): string {
  if (typeof value !== 'string') {
    throw new Error(
      `Invalid non-string field "${fieldName}" in ${collectionName} doc "${docId}"`,
    );
  }
  return value;
}

function toRequiredBoolean(
  value: unknown,
  collectionName: string,
  docId: string,
  fieldName: string,
): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(
      `Invalid or missing boolean field "${fieldName}" in ${collectionName} doc "${docId}"`,
    );
  }
  return value;
}

function toRequiredEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  collectionName: string,
  docId: string,
  fieldName: string,
): T {
  const raw = toRequiredString(value, collectionName, docId, fieldName);
  const matched = allowed.find((item) => item === raw);
  if (!matched) {
    throw new Error(
      `Invalid enum value "${raw}" for "${fieldName}" in ${collectionName} doc "${docId}"`,
    );
  }
  return matched;
}

function toRequiredNumber(
  value: unknown,
  collectionName: string,
  docId: string,
  fieldName: string,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `Invalid or missing numeric field "${fieldName}" in ${collectionName} doc "${docId}"`,
    );
  }
  return value;
}

function toPositiveInteger(
  value: unknown,
  collectionName: string,
  docId: string,
  fieldName: string,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(
      `Invalid positive integer field "${fieldName}" in ${collectionName} doc "${docId}"`,
    );
  }
  return value;
}

function toOptionalString(
  value: unknown,
  collectionName: string,
  docId: string,
  fieldName: string,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(
      `Invalid non-string optional field "${fieldName}" in ${collectionName} doc "${docId}"`,
    );
  }
  return value;
}

function toOptionalBoolean(
  value: unknown,
  collectionName: string,
  docId: string,
  fieldName: string,
): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return toRequiredBoolean(value, collectionName, docId, fieldName);
}

function toOptionalNumber(
  value: unknown,
  collectionName: string,
  docId: string,
  fieldName: string,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return toRequiredNumber(value, collectionName, docId, fieldName);
}

function toNonNegativeInteger(
  value: unknown,
  collectionName: string,
  docId: string,
  fieldName: string,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `Invalid non-negative integer field "${fieldName}" in ${collectionName} doc "${docId}"`,
    );
  }
  return value;
}

function toOptionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  collectionName: string,
  docId: string,
  fieldName: string,
): T | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return toRequiredEnum(value, allowed, collectionName, docId, fieldName);
}

function toNullableLoungeIso(
  value: Timestamp | Date | string | null | undefined,
  collectionName: string,
  docId: string,
  fieldName: string,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return toRequiredLoungeIso(value, collectionName, docId, fieldName);
}

function parseDisclaimerConsent(
  raw: unknown,
  docId: string,
): LoungeUserDisclaimerConsent {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`Missing "disclaimerConsent" object in lounge_users doc "${docId}"`);
  }
  const consent = raw as Record<string, unknown>;
  const agreedToNonEeaEligibility = toOptionalBoolean(
    consent['agreedToNonEeaEligibility'],
    COLLECTIONS.LOUNGE_USERS,
    docId,
    'disclaimerConsent.agreedToNonEeaEligibility',
  );
  return {
    disclaimerVersion: toPositiveInteger(
      consent['disclaimerVersion'],
      COLLECTIONS.LOUNGE_USERS,
      docId,
      'disclaimerConsent.disclaimerVersion',
    ),
    agreedToGeminiTrainingUsage: toRequiredBoolean(consent['agreedToGeminiTrainingUsage'], COLLECTIONS.LOUNGE_USERS, docId, 'disclaimerConsent.agreedToGeminiTrainingUsage'),
    agreedToZeroPiiProhibition: toRequiredBoolean(consent['agreedToZeroPiiProhibition'], COLLECTIONS.LOUNGE_USERS, docId, 'disclaimerConsent.agreedToZeroPiiProhibition'),
    agreedToOneWayMemoryIsolation: toRequiredBoolean(consent['agreedToOneWayMemoryIsolation'], COLLECTIONS.LOUNGE_USERS, docId, 'disclaimerConsent.agreedToOneWayMemoryIsolation'),
    ...(agreedToNonEeaEligibility !== undefined ? { agreedToNonEeaEligibility } : {}),
    scrolledToBottomAt: toRequiredLoungeIso(
      consent['scrolledToBottomAt'] as Timestamp | Date | string | null | undefined,
      COLLECTIONS.LOUNGE_USERS,
      docId,
      'disclaimerConsent.scrolledToBottomAt',
    ),
    consentedAt: toRequiredLoungeIso(
      consent['consentedAt'] as Timestamp | Date | string | null | undefined,
      COLLECTIONS.LOUNGE_USERS,
      docId,
      'disclaimerConsent.consentedAt',
    ),
  };
}

function parseOptionalCoreProfile(raw: unknown, docId: string): UserCoreProfile | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Invalid non-object field "coreProfile" in ${COLLECTIONS.LOUNGE_USERS} doc "${docId}"`);
  }
  return { ...(raw as Record<string, unknown>) };
}

function parseOptionalEpisodicBuffer(
  raw: unknown,
  docId: string,
): ConversationLogEntry[] | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw new Error(
      `Invalid non-array field "episodicBuffer" in ${COLLECTIONS.LOUNGE_USERS} doc "${docId}"`,
    );
  }
  return raw.map((entry, idx): ConversationLogEntry => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(
        `Corrupted episodicBuffer entry at index ${idx} in ${COLLECTIONS.LOUNGE_USERS} doc "${docId}"`,
      );
    }
    const item = entry as Record<string, unknown>;
    const role = item['role'] === 'user' || item['role'] === 'model' ? item['role'] : null;
    if (!role || typeof item['content'] !== 'string') {
      throw new Error(
        `Corrupted episodicBuffer entry at index ${idx} in ${COLLECTIONS.LOUNGE_USERS} doc "${docId}"`,
      );
    }
    const normalized: ConversationLogEntry = {
      role,
      content: item['content'],
    };
    if (typeof item['thought'] === 'string') {
      normalized.thought = item['thought'];
    }
    if (typeof item['timestamp'] === 'string') {
      normalized.timestamp = item['timestamp'];
    }
    return normalized;
  });
}

function parseEmbeddingVector(raw: unknown, collectionName: string, docId: string): number[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  let candidate: unknown = raw;
  if (
    typeof raw === 'object' &&
    'toArray' in raw &&
    typeof (raw as { toArray?: unknown }).toArray === 'function'
  ) {
    candidate = (raw as { toArray(): unknown[] }).toArray();
  }
  if (!Array.isArray(candidate)) {
    throw new Error(`Invalid non-array field "embedding" in ${collectionName} doc "${docId}"`);
  }
  return candidate.map((val, idx) => {
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      throw new Error(
        `Invalid non-numeric embedding element at index ${idx} in ${collectionName} doc "${docId}"`,
      );
    }
    return val;
  });
}

/**
 * Converter for isolated `lounge_users` profiles, consent records, and independent Dreaming memory state.
 */
const loungeUserConverter: FirestoreDataConverter<LoungeUserDoc> = {
  toFirestore(user: LoungeUserDoc): DocumentData {
    const data: DocumentData = {
      xUserId: user.xUserId,
      xHandle: user.xHandle,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      status: user.status,
      language: user.language,
      timezone: user.timezone,
      onboardingCompleted: user.onboardingCompleted,
      allowServiceImprovementAnalytics: user.allowServiceImprovementAnalytics,
      disclaimerConsent: {
        disclaimerVersion: user.disclaimerConsent.disclaimerVersion,
        agreedToGeminiTrainingUsage: user.disclaimerConsent.agreedToGeminiTrainingUsage,
        agreedToZeroPiiProhibition: user.disclaimerConsent.agreedToZeroPiiProhibition,
        agreedToOneWayMemoryIsolation: user.disclaimerConsent.agreedToOneWayMemoryIsolation,
        ...(user.disclaimerConsent.agreedToNonEeaEligibility !== undefined
          ? { agreedToNonEeaEligibility: user.disclaimerConsent.agreedToNonEeaEligibility }
          : {}),
        scrolledToBottomAt: toRequiredFirestoreTimestamp(
          user.disclaimerConsent.scrolledToBottomAt,
          'disclaimerConsent.scrolledToBottomAt',
        ),
        consentedAt: toRequiredFirestoreTimestamp(
          user.disclaimerConsent.consentedAt,
          'disclaimerConsent.consentedAt',
        ),
      },
      createdAt: toRequiredFirestoreTimestamp(user.createdAt, 'createdAt'),
      updatedAt: toRequiredFirestoreTimestamp(user.updatedAt, 'updatedAt'),
      lastLoginAt: toRequiredFirestoreTimestamp(user.lastLoginAt, 'lastLoginAt'),
    };
    if (user.countryCode !== undefined) {
      data['countryCode'] = user.countryCode;
    }
    if (user.isEeaResident !== undefined) {
      data['isEeaResident'] = user.isEeaResident;
    }
    if (user.preferredCurrency !== undefined) {
      data['preferredCurrency'] = user.preferredCurrency;
    }
    if (user.coreProfile !== undefined) {
      data['coreProfile'] = user.coreProfile;
    }
    if (user.episodicBuffer !== undefined) {
      data['episodicBuffer'] = user.episodicBuffer;
    }
    if (user.lastDreamedAt !== undefined) {
      data['lastDreamedAt'] = toRequiredFirestoreTimestamp(user.lastDreamedAt, 'lastDreamedAt');
    }
    return data;
  },
  fromFirestore(snapshot: QueryDocumentSnapshot): LoungeUserDoc {
    const data = snapshot.data();
    const id = snapshot.id;
    const coreProfile = parseOptionalCoreProfile(data['coreProfile'], id);
    const episodicBuffer = parseOptionalEpisodicBuffer(data['episodicBuffer'], id);
    const lastDreamedAt = toOptionalLoungeIso(
      data['lastDreamedAt'],
      COLLECTIONS.LOUNGE_USERS,
      id,
      'lastDreamedAt',
    );
    const countryCode = toOptionalString(
      data['countryCode'],
      COLLECTIONS.LOUNGE_USERS,
      id,
      'countryCode',
    );
    const isEeaResident = toOptionalBoolean(
      data['isEeaResident'],
      COLLECTIONS.LOUNGE_USERS,
      id,
      'isEeaResident',
    );
    const preferredCurrency = toOptionalEnum(
      data['preferredCurrency'],
      LOUNGE_CURRENCIES,
      COLLECTIONS.LOUNGE_USERS,
      id,
      'preferredCurrency',
    );
    return {
      uid: id,
      xUserId: toRequiredString(data['xUserId'], COLLECTIONS.LOUNGE_USERS, id, 'xUserId'),
      xHandle: toRequiredString(data['xHandle'], COLLECTIONS.LOUNGE_USERS, id, 'xHandle'),
      displayName: toRequiredString(data['displayName'], COLLECTIONS.LOUNGE_USERS, id, 'displayName'),
      avatarUrl: toValidatedString(data['avatarUrl'], COLLECTIONS.LOUNGE_USERS, id, 'avatarUrl'),
      status: toRequiredEnum(data['status'], LOUNGE_ACCOUNT_STATUSES, COLLECTIONS.LOUNGE_USERS, id, 'status'),
      language: toRequiredEnum(data['language'], LOUNGE_SUPPORTED_LANGUAGES, COLLECTIONS.LOUNGE_USERS, id, 'language'),
      timezone: toRequiredString(data['timezone'], COLLECTIONS.LOUNGE_USERS, id, 'timezone'),
      onboardingCompleted: toRequiredBoolean(
        data['onboardingCompleted'],
        COLLECTIONS.LOUNGE_USERS,
        id,
        'onboardingCompleted',
      ),
      allowServiceImprovementAnalytics: toRequiredBoolean(
        data['allowServiceImprovementAnalytics'],
        COLLECTIONS.LOUNGE_USERS,
        id,
        'allowServiceImprovementAnalytics',
      ),
      ...(countryCode !== undefined ? { countryCode } : {}),
      ...(isEeaResident !== undefined ? { isEeaResident } : {}),
      ...(preferredCurrency !== undefined ? { preferredCurrency } : {}),
      disclaimerConsent: parseDisclaimerConsent(data['disclaimerConsent'], id),
      ...(coreProfile !== undefined ? { coreProfile } : {}),
      ...(episodicBuffer !== undefined ? { episodicBuffer } : {}),
      ...(lastDreamedAt !== undefined ? { lastDreamedAt } : {}),
      createdAt: toRequiredLoungeIso(data['createdAt'], COLLECTIONS.LOUNGE_USERS, id, 'createdAt'),
      updatedAt: toRequiredLoungeIso(data['updatedAt'], COLLECTIONS.LOUNGE_USERS, id, 'updatedAt'),
      lastLoginAt: toRequiredLoungeIso(data['lastLoginAt'], COLLECTIONS.LOUNGE_USERS, id, 'lastLoginAt'),
    };
  },
};

/**
 * Converter for isolated `lounge_subscriptions` tier, Stripe reference, and hybrid quota documents.
 * Enforces strict required fields on all greenfield reads without silent coercion.
 */
const loungeSubscriptionConverter: FirestoreDataConverter<LoungeSubscriptionDoc> = {
  toFirestore(sub: LoungeSubscriptionDoc): DocumentData {
    const data: DocumentData = {
      tier: sub.tier,
      status: sub.status,
      dailyTurnQuota: sub.dailyTurnQuota,
      dailyRemainingTurns: sub.dailyRemainingTurns,
      purchasedRemainingTurns: sub.purchasedRemainingTurns,
      remainingChatTurns: sub.remainingChatTurns,
      earliestLotExpiresAt:
        sub.earliestLotExpiresAt === null
          ? null
          : toRequiredFirestoreTimestamp(sub.earliestLotExpiresAt, 'earliestLotExpiresAt'),
      lastDailyResetAt: toRequiredFirestoreTimestamp(sub.lastDailyResetAt, 'lastDailyResetAt'),
      lastQuotaResetTimezone: sub.lastQuotaResetTimezone,
      nextDailyResetAt: toRequiredFirestoreTimestamp(sub.nextDailyResetAt, 'nextDailyResetAt'),
      currentPeriodEnd: toRequiredFirestoreTimestamp(sub.currentPeriodEnd, 'currentPeriodEnd'),
      trialTicketUsed: sub.trialTicketUsed,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      todaysConsumedDailyTurns: sub.todaysConsumedDailyTurns,
      updatedAt: toRequiredFirestoreTimestamp(sub.updatedAt, 'updatedAt'),
    };
    if (sub.billingCurrency !== undefined) {
      data['billingCurrency'] = sub.billingCurrency;
    }
    if (sub.stripeCustomerId !== undefined) {
      data['stripeCustomerId'] = sub.stripeCustomerId;
    }
    if (sub.stripeSubscriptionId !== undefined) {
      data['stripeSubscriptionId'] = sub.stripeSubscriptionId;
    }
    if (sub.stripeScheduleId !== undefined) {
      data['stripeScheduleId'] = sub.stripeScheduleId;
    }
    if (sub.lastProcessedInvoiceId !== undefined) {
      data['lastProcessedInvoiceId'] = sub.lastProcessedInvoiceId;
    }
    if (sub.todaysSearchCount !== undefined) {
      data['todaysSearchCount'] = sub.todaysSearchCount;
    }
    return data;
  },
  fromFirestore(snapshot: QueryDocumentSnapshot): LoungeSubscriptionDoc {
    const data = snapshot.data();
    const id = snapshot.id;
    const tier = toRequiredEnum(
      data['tier'],
      LOUNGE_SUBSCRIPTION_TIERS,
      COLLECTIONS.LOUNGE_SUBSCRIPTIONS,
      id,
      'tier',
    );
    const status = toRequiredEnum(
      data['status'],
      LOUNGE_SUBSCRIPTION_STATUSES,
      COLLECTIONS.LOUNGE_SUBSCRIPTIONS,
      id,
      'status',
    );
    const updatedAt = toRequiredLoungeIso(
      data['updatedAt'],
      COLLECTIONS.LOUNGE_SUBSCRIPTIONS,
      id,
      'updatedAt',
    );
    const dailyTurnQuota = toRequiredNumber(
      data['dailyTurnQuota'],
      COLLECTIONS.LOUNGE_SUBSCRIPTIONS,
      id,
      'dailyTurnQuota',
    );
    const remainingChatTurns = toRequiredNumber(
      data['remainingChatTurns'],
      COLLECTIONS.LOUNGE_SUBSCRIPTIONS,
      id,
      'remainingChatTurns',
    );
    const dailyRemainingTurns = toRequiredNumber(
      data['dailyRemainingTurns'],
      COLLECTIONS.LOUNGE_SUBSCRIPTIONS,
      id,
      'dailyRemainingTurns',
    );
    const purchasedRemainingTurns = toRequiredNumber(
      data['purchasedRemainingTurns'],
      COLLECTIONS.LOUNGE_SUBSCRIPTIONS,
      id,
      'purchasedRemainingTurns',
    );
    const nextDailyResetAt = toRequiredLoungeIso(
      data['nextDailyResetAt'] as Timestamp | Date | string | null | undefined,
      COLLECTIONS.LOUNGE_SUBSCRIPTIONS,
      id,
      'nextDailyResetAt',
    );
    const lastDailyResetAt = toRequiredLoungeIso(
      data['lastDailyResetAt'] as Timestamp | Date | string | null | undefined,
      COLLECTIONS.LOUNGE_SUBSCRIPTIONS,
      id,
      'lastDailyResetAt',
    );
    const lastQuotaResetTimezone = toRequiredString(
      data['lastQuotaResetTimezone'],
      COLLECTIONS.LOUNGE_SUBSCRIPTIONS,
      id,
      'lastQuotaResetTimezone',
    );
    const earliestLotExpiresAt = toNullableLoungeIso(
      data['earliestLotExpiresAt'] as Timestamp | Date | string | null | undefined,
      COLLECTIONS.LOUNGE_SUBSCRIPTIONS,
      id,
      'earliestLotExpiresAt',
    );
    const trialTicketUsed = toRequiredBoolean(
      data['trialTicketUsed'],
      COLLECTIONS.LOUNGE_SUBSCRIPTIONS,
      id,
      'trialTicketUsed',
    );
    const cancelAtPeriodEnd = toRequiredBoolean(
      data['cancelAtPeriodEnd'],
      COLLECTIONS.LOUNGE_SUBSCRIPTIONS,
      id,
      'cancelAtPeriodEnd',
    );
    const todaysConsumedDailyTurns = toRequiredNumber(
      data['todaysConsumedDailyTurns'],
      COLLECTIONS.LOUNGE_SUBSCRIPTIONS,
      id,
      'todaysConsumedDailyTurns',
    );
    const billingCurrency = toOptionalEnum(
      data['billingCurrency'],
      LOUNGE_CURRENCIES,
      COLLECTIONS.LOUNGE_SUBSCRIPTIONS,
      id,
      'billingCurrency',
    );
    const stripeCustomerId = toOptionalString(
      data['stripeCustomerId'],
      COLLECTIONS.LOUNGE_SUBSCRIPTIONS,
      id,
      'stripeCustomerId',
    );
    const stripeSubscriptionId = toOptionalString(
      data['stripeSubscriptionId'],
      COLLECTIONS.LOUNGE_SUBSCRIPTIONS,
      id,
      'stripeSubscriptionId',
    );
    const stripeScheduleId = toOptionalString(
      data['stripeScheduleId'],
      COLLECTIONS.LOUNGE_SUBSCRIPTIONS,
      id,
      'stripeScheduleId',
    );
    const lastProcessedInvoiceId = toOptionalString(
      data['lastProcessedInvoiceId'],
      COLLECTIONS.LOUNGE_SUBSCRIPTIONS,
      id,
      'lastProcessedInvoiceId',
    );
    const todaysSearchCount = toOptionalNumber(
      data['todaysSearchCount'],
      COLLECTIONS.LOUNGE_SUBSCRIPTIONS,
      id,
      'todaysSearchCount',
    );
    return {
      uid: id,
      tier,
      status,
      ...(billingCurrency !== undefined ? { billingCurrency } : {}),
      dailyTurnQuota,
      dailyRemainingTurns,
      purchasedRemainingTurns,
      remainingChatTurns,
      earliestLotExpiresAt,
      lastDailyResetAt,
      lastQuotaResetTimezone,
      nextDailyResetAt,
      currentPeriodEnd: toRequiredLoungeIso(
        data['currentPeriodEnd'],
        COLLECTIONS.LOUNGE_SUBSCRIPTIONS,
        id,
        'currentPeriodEnd',
      ),
      trialTicketUsed,
      cancelAtPeriodEnd,
      todaysConsumedDailyTurns,
      ...(stripeCustomerId !== undefined ? { stripeCustomerId } : {}),
      ...(stripeSubscriptionId !== undefined ? { stripeSubscriptionId } : {}),
      ...(stripeScheduleId !== undefined ? { stripeScheduleId } : {}),
      ...(lastProcessedInvoiceId !== undefined ? { lastProcessedInvoiceId } : {}),
      ...(todaysSearchCount !== undefined ? { todaysSearchCount } : {}),
      updatedAt,
    };
  },
};

/**
 * Converter for isolated `lounge_sessions` conversation threads.
 */
const loungeSessionConverter: FirestoreDataConverter<LoungeSessionDoc> = {
  toFirestore(session: LoungeSessionDoc): DocumentData {
    const data: DocumentData = {
      uid: session.uid,
      title: session.title,
      messageCount: session.messageCount,
      currentEmotion: session.currentEmotion,
      publicXMemorySyncedAt: toRequiredFirestoreTimestamp(
        session.publicXMemorySyncedAt,
        'publicXMemorySyncedAt',
      ),
      lastMessagePreview: session.lastMessagePreview,
      createdAt: toRequiredFirestoreTimestamp(session.createdAt, 'createdAt'),
      updatedAt: toRequiredFirestoreTimestamp(session.updatedAt, 'updatedAt'),
    };
    if (session.archivedAt !== undefined) {
      data['archivedAt'] = toRequiredFirestoreTimestamp(session.archivedAt, 'archivedAt');
    }
    return data;
  },
  fromFirestore(snapshot: QueryDocumentSnapshot): LoungeSessionDoc {
    const data = snapshot.data();
    const id = snapshot.id;
    return {
      id,
      uid: toRequiredString(data['uid'], COLLECTIONS.LOUNGE_SESSIONS, id, 'uid'),
      title: toRequiredString(data['title'], COLLECTIONS.LOUNGE_SESSIONS, id, 'title'),
      messageCount: toRequiredNumber(data['messageCount'], COLLECTIONS.LOUNGE_SESSIONS, id, 'messageCount'),
      currentEmotion: toRequiredEnum(data['currentEmotion'], LOUNGE_EMOTION_STATES, COLLECTIONS.LOUNGE_SESSIONS, id, 'currentEmotion'),
      publicXMemorySyncedAt: toRequiredLoungeIso(
        data['publicXMemorySyncedAt'],
        COLLECTIONS.LOUNGE_SESSIONS,
        id,
        'publicXMemorySyncedAt',
      ),
      lastMessagePreview: toValidatedString(data['lastMessagePreview'], COLLECTIONS.LOUNGE_SESSIONS, id, 'lastMessagePreview'),
      createdAt: toRequiredLoungeIso(data['createdAt'], COLLECTIONS.LOUNGE_SESSIONS, id, 'createdAt'),
      updatedAt: toRequiredLoungeIso(data['updatedAt'], COLLECTIONS.LOUNGE_SESSIONS, id, 'updatedAt'),
      archivedAt: toOptionalLoungeIso(data['archivedAt'], COLLECTIONS.LOUNGE_SESSIONS, id, 'archivedAt'),
    };
  },
};

/**
 * Converter for isolated `lounge_messages` turn logs.
 */
const loungeMessageConverter: FirestoreDataConverter<LoungeMessageDoc> = {
  toFirestore(message: LoungeMessageDoc): DocumentData {
    const data: DocumentData = {
      sessionId: message.sessionId,
      uid: message.uid,
      role: message.role,
      content: message.content,
      emotion: message.emotion,
      createdAt: toRequiredFirestoreTimestamp(message.createdAt, 'createdAt'),
    };
    if (message.imageAssetId !== undefined) {
      data['imageAssetId'] = message.imageAssetId;
    }
    if (message.imageUrl !== undefined) {
      data['imageUrl'] = message.imageUrl;
    }
    if (message.tokenUsage !== undefined) {
      data['tokenUsage'] = message.tokenUsage;
    }
    if (message.thought !== undefined) {
      data['thought'] = message.thought;
    }
    return data;
  },
  fromFirestore(snapshot: QueryDocumentSnapshot): LoungeMessageDoc {
    const data = snapshot.data();
    const id = snapshot.id;
    const rawUsage = data['tokenUsage'];
    let tokenUsage: LoungeTokenUsage | undefined;
    if (rawUsage !== undefined && rawUsage !== null) {
      if (typeof rawUsage !== 'object' || Array.isArray(rawUsage)) {
        throw new Error(
          `Invalid non-object field "tokenUsage" in ${COLLECTIONS.LOUNGE_MESSAGES} doc "${id}"`,
        );
      }
      const u = rawUsage as Record<string, unknown>;
      tokenUsage = {
        promptTokens: toRequiredNumber(u['promptTokens'], COLLECTIONS.LOUNGE_MESSAGES, id, 'tokenUsage.promptTokens'),
        candidatesTokens: toRequiredNumber(u['candidatesTokens'], COLLECTIONS.LOUNGE_MESSAGES, id, 'tokenUsage.candidatesTokens'),
        totalTokens: toRequiredNumber(u['totalTokens'], COLLECTIONS.LOUNGE_MESSAGES, id, 'tokenUsage.totalTokens'),
      };
    }
    const thought = toOptionalString(data['thought'], COLLECTIONS.LOUNGE_MESSAGES, id, 'thought');
    return {
      id,
      sessionId: toRequiredString(data['sessionId'], COLLECTIONS.LOUNGE_MESSAGES, id, 'sessionId'),
      uid: toRequiredString(data['uid'], COLLECTIONS.LOUNGE_MESSAGES, id, 'uid'),
      role: toRequiredEnum(data['role'], LOUNGE_SENDER_ROLES, COLLECTIONS.LOUNGE_MESSAGES, id, 'role'),
      content: toValidatedString(data['content'], COLLECTIONS.LOUNGE_MESSAGES, id, 'content'),
      emotion: toRequiredEnum(data['emotion'], LOUNGE_EMOTION_STATES, COLLECTIONS.LOUNGE_MESSAGES, id, 'emotion'),
      imageAssetId: toOptionalString(data['imageAssetId'], COLLECTIONS.LOUNGE_MESSAGES, id, 'imageAssetId'),
      imageUrl: toOptionalString(data['imageUrl'], COLLECTIONS.LOUNGE_MESSAGES, id, 'imageUrl'),
      tokenUsage,
      ...(thought !== undefined ? { thought } : {}),
      createdAt: toRequiredLoungeIso(data['createdAt'], COLLECTIONS.LOUNGE_MESSAGES, id, 'createdAt'),
    };
  },
};

/**
 * Converter for isolated `lounge_rag_memories` private episodic memory records.
 */
const loungeRagMemoryConverter: FirestoreDataConverter<LoungeRagMemoryDoc> = {
  toFirestore(memory: LoungeRagMemoryDoc): DocumentData {
    return {
      uid: memory.uid,
      sessionId: memory.sessionId,
      category: memory.category,
      summary: memory.summary,
      embedding:
        memory.embedding.length > 0 ? FieldValue.vector(memory.embedding) : [],
      salienceScore: memory.salienceScore,
      createdAt: toRequiredFirestoreTimestamp(memory.createdAt, 'createdAt'),
      updatedAt: toRequiredFirestoreTimestamp(memory.updatedAt, 'updatedAt'),
    };
  },
  fromFirestore(snapshot: QueryDocumentSnapshot): LoungeRagMemoryDoc {
    const data = snapshot.data();
    const id = snapshot.id;
    return {
      id,
      uid: toRequiredString(data['uid'], COLLECTIONS.LOUNGE_RAG_MEMORIES, id, 'uid'),
      sessionId: toRequiredString(data['sessionId'], COLLECTIONS.LOUNGE_RAG_MEMORIES, id, 'sessionId'),
      category: toRequiredEnum(data['category'], LOUNGE_MEMORY_CATEGORIES, COLLECTIONS.LOUNGE_RAG_MEMORIES, id, 'category'),
      summary: toRequiredString(data['summary'], COLLECTIONS.LOUNGE_RAG_MEMORIES, id, 'summary'),
      embedding: parseEmbeddingVector(data['embedding'], COLLECTIONS.LOUNGE_RAG_MEMORIES, id),
      salienceScore: toRequiredNumber(data['salienceScore'], COLLECTIONS.LOUNGE_RAG_MEMORIES, id, 'salienceScore'),
      createdAt: toRequiredLoungeIso(data['createdAt'], COLLECTIONS.LOUNGE_RAG_MEMORIES, id, 'createdAt'),
      updatedAt: toRequiredLoungeIso(data['updatedAt'], COLLECTIONS.LOUNGE_RAG_MEMORIES, id, 'updatedAt'),
    };
  },
};

/**
 * Converter for isolated `lounge_gallery` user illustration unlock records.
 */
const loungeGalleryConverter: FirestoreDataConverter<LoungeGalleryItemDoc> = {
  toFirestore(item: LoungeGalleryItemDoc): DocumentData {
    const data: DocumentData = {
      uid: item.uid,
      assetId: item.assetId,
      imageUrl: item.imageUrl,
      unlocked: item.unlocked,
    };
    if (item.unlockedAt !== undefined) {
      data['unlockedAt'] = toRequiredFirestoreTimestamp(item.unlockedAt, 'unlockedAt');
    }
    if (item.sourceSessionId !== undefined) {
      data['sourceSessionId'] = item.sourceSessionId;
    }
    return data;
  },
  fromFirestore(snapshot: QueryDocumentSnapshot): LoungeGalleryItemDoc {
    const data = snapshot.data();
    const id = snapshot.id;
    return {
      id,
      uid: toRequiredString(data['uid'], COLLECTIONS.LOUNGE_GALLERY, id, 'uid'),
      assetId: toRequiredString(data['assetId'], COLLECTIONS.LOUNGE_GALLERY, id, 'assetId'),
      imageUrl: toValidatedString(data['imageUrl'], COLLECTIONS.LOUNGE_GALLERY, id, 'imageUrl'),
      unlocked: toRequiredBoolean(data['unlocked'], COLLECTIONS.LOUNGE_GALLERY, id, 'unlocked'),
      unlockedAt: toOptionalLoungeIso(data['unlockedAt'], COLLECTIONS.LOUNGE_GALLERY, id, 'unlockedAt'),
      sourceSessionId: toOptionalString(data['sourceSessionId'], COLLECTIONS.LOUNGE_GALLERY, id, 'sourceSessionId'),
    };
  },
};

const LOUNGE_TRIAL_FORBIDDEN_PII_FIELDS = [
  'uid',
  'grantedUid',
  'xUserId',
  'xHandle',
  'displayName',
  'email',
  'stripeCustomerId',
  'stripeSessionId',
  'sessionId',
] as const;

function assertNoTrialGrantPii(record: Record<string, unknown>, docId: string): void {
  for (const field of LOUNGE_TRIAL_FORBIDDEN_PII_FIELDS) {
    if (record[field] !== undefined) {
      throw new Error(
        `Forbidden PII field "${field}" detected in ${COLLECTIONS.LOUNGE_TRIAL_GRANTS} doc "${docId}"`,
      );
    }
  }
}

/**
 * Converter for isolated `lounge_processed_events` Stripe/webhook idempotency records.
 */
const loungeProcessedEventConverter: FirestoreDataConverter<LoungeProcessedEventDoc> = {
  toFirestore(event: LoungeProcessedEventDoc): DocumentData {
    const data: DocumentData = {
      eventType: event.eventType,
      processedAt: toRequiredFirestoreTimestamp(event.processedAt, 'processedAt'),
    };
    if (event.uid !== undefined) {
      data['uid'] = event.uid;
    }
    if (event.targetId !== undefined) {
      data['targetId'] = event.targetId;
    }
    if (event.expireAt !== undefined) {
      data['expireAt'] = toRequiredFirestoreTimestamp(event.expireAt, 'expireAt');
    }
    return data;
  },
  fromFirestore(snapshot: QueryDocumentSnapshot): LoungeProcessedEventDoc {
    const data = snapshot.data();
    const id = snapshot.id;
    const uid = toOptionalString(data['uid'], COLLECTIONS.LOUNGE_PROCESSED_EVENTS, id, 'uid');
    const targetId = toOptionalString(
      data['targetId'],
      COLLECTIONS.LOUNGE_PROCESSED_EVENTS,
      id,
      'targetId',
    );
    const expireAt = toOptionalLoungeIso(
      data['expireAt'],
      COLLECTIONS.LOUNGE_PROCESSED_EVENTS,
      id,
      'expireAt',
    );
    return {
      eventId: id,
      eventType: toRequiredString(data['eventType'], COLLECTIONS.LOUNGE_PROCESSED_EVENTS, id, 'eventType'),
      ...(uid !== undefined ? { uid } : {}),
      ...(targetId !== undefined ? { targetId } : {}),
      processedAt: toRequiredLoungeIso(data['processedAt'], COLLECTIONS.LOUNGE_PROCESSED_EVENTS, id, 'processedAt'),
      ...(expireAt !== undefined ? { expireAt } : {}),
    };
  },
};

/**
 * Converter for isolated `lounge_credit_lots` promotional and paid credit buckets.
 */
const loungeCreditLotConverter: FirestoreDataConverter<LoungeCreditLotDoc> = {
  toFirestore(lot: LoungeCreditLotDoc): DocumentData {
    const data: DocumentData = {
      uid: lot.uid,
      productId: lot.productId,
      isPaid: lot.isPaid,
      initialTurns: lot.initialTurns,
      remainingTurns: lot.remainingTurns,
      currency: lot.currency,
      unitAmount: lot.unitAmount,
      status: lot.status,
      purchasedAt: toRequiredFirestoreTimestamp(lot.purchasedAt, 'purchasedAt'),
      expiresAt: toRequiredFirestoreTimestamp(lot.expiresAt, 'expiresAt'),
    };
    if (lot.stripePaymentIntentId !== undefined) {
      data['stripePaymentIntentId'] = lot.stripePaymentIntentId;
    }
    return data;
  },
  fromFirestore(snapshot: QueryDocumentSnapshot): LoungeCreditLotDoc {
    const data = snapshot.data();
    const id = snapshot.id;
    const stripePaymentIntentId = toOptionalString(
      data['stripePaymentIntentId'],
      COLLECTIONS.LOUNGE_CREDIT_LOTS,
      id,
      'stripePaymentIntentId',
    );
    return {
      id,
      uid: toRequiredString(data['uid'], COLLECTIONS.LOUNGE_CREDIT_LOTS, id, 'uid'),
      productId: toRequiredEnum(
        data['productId'],
        LOUNGE_CREDIT_LOT_PRODUCTS,
        COLLECTIONS.LOUNGE_CREDIT_LOTS,
        id,
        'productId',
      ),
      isPaid: toRequiredBoolean(data['isPaid'], COLLECTIONS.LOUNGE_CREDIT_LOTS, id, 'isPaid'),
      initialTurns: toPositiveInteger(
        data['initialTurns'],
        COLLECTIONS.LOUNGE_CREDIT_LOTS,
        id,
        'initialTurns',
      ),
      remainingTurns: toNonNegativeInteger(
        data['remainingTurns'],
        COLLECTIONS.LOUNGE_CREDIT_LOTS,
        id,
        'remainingTurns',
      ),
      currency: toRequiredEnum(
        data['currency'],
        LOUNGE_CREDIT_CURRENCIES,
        COLLECTIONS.LOUNGE_CREDIT_LOTS,
        id,
        'currency',
      ),
      unitAmount: toNonNegativeInteger(
        data['unitAmount'],
        COLLECTIONS.LOUNGE_CREDIT_LOTS,
        id,
        'unitAmount',
      ),
      status: toRequiredEnum(
        data['status'],
        LOUNGE_CREDIT_LOT_STATUSES,
        COLLECTIONS.LOUNGE_CREDIT_LOTS,
        id,
        'status',
      ),
      ...(stripePaymentIntentId !== undefined ? { stripePaymentIntentId } : {}),
      purchasedAt: toRequiredLoungeIso(
        data['purchasedAt'],
        COLLECTIONS.LOUNGE_CREDIT_LOTS,
        id,
        'purchasedAt',
      ),
      expiresAt: toRequiredLoungeIso(
        data['expiresAt'],
        COLLECTIONS.LOUNGE_CREDIT_LOTS,
        id,
        'expiresAt',
      ),
    };
  },
};

/**
 * Converter for isolated `lounge_quota_ledger` 180-day TTL operational quota mutation records.
 */
const loungeQuotaLedgerConverter: FirestoreDataConverter<LoungeQuotaLedgerDoc> = {
  toFirestore(entry: LoungeQuotaLedgerDoc): DocumentData {
    const data: DocumentData = {
      uid: entry.uid,
      deltaType: entry.deltaType,
      deltaDaily: entry.deltaDaily,
      deltaPurchased: entry.deltaPurchased,
      balanceTotalAfter: entry.balanceTotalAfter,
      referenceId: entry.referenceId,
      createdAt: toRequiredFirestoreTimestamp(entry.createdAt, 'createdAt'),
      expireAt: toRequiredFirestoreTimestamp(entry.expireAt, 'expireAt'),
    };
    if (entry.lotId !== undefined) {
      data['lotId'] = entry.lotId;
    }
    return data;
  },
  fromFirestore(snapshot: QueryDocumentSnapshot): LoungeQuotaLedgerDoc {
    const data = snapshot.data();
    const id = snapshot.id;
    const lotId = toOptionalString(data['lotId'], COLLECTIONS.LOUNGE_QUOTA_LEDGER, id, 'lotId');
    return {
      id,
      uid: toRequiredString(data['uid'], COLLECTIONS.LOUNGE_QUOTA_LEDGER, id, 'uid'),
      deltaType: toRequiredEnum(
        data['deltaType'],
        LOUNGE_QUOTA_DELTA_TYPES,
        COLLECTIONS.LOUNGE_QUOTA_LEDGER,
        id,
        'deltaType',
      ),
      deltaDaily: toRequiredNumber(data['deltaDaily'], COLLECTIONS.LOUNGE_QUOTA_LEDGER, id, 'deltaDaily'),
      deltaPurchased: toRequiredNumber(
        data['deltaPurchased'],
        COLLECTIONS.LOUNGE_QUOTA_LEDGER,
        id,
        'deltaPurchased',
      ),
      balanceTotalAfter: toNonNegativeInteger(
        data['balanceTotalAfter'],
        COLLECTIONS.LOUNGE_QUOTA_LEDGER,
        id,
        'balanceTotalAfter',
      ),
      ...(lotId !== undefined ? { lotId } : {}),
      referenceId: toRequiredString(
        data['referenceId'],
        COLLECTIONS.LOUNGE_QUOTA_LEDGER,
        id,
        'referenceId',
      ),
      createdAt: toRequiredLoungeIso(
        data['createdAt'],
        COLLECTIONS.LOUNGE_QUOTA_LEDGER,
        id,
        'createdAt',
      ),
      expireAt: toRequiredLoungeIso(
        data['expireAt'],
        COLLECTIONS.LOUNGE_QUOTA_LEDGER,
        id,
        'expireAt',
      ),
    };
  },
};

/**
 * Converter for non-PII `lounge_trial_grants` anti-fraud grant records.
 * Rejects any PII keys (`uid`, `xUserId`, `email`, `stripeCustomerId`, `stripeSessionId`) on read/write.
 */
const loungeTrialGrantConverter: FirestoreDataConverter<LoungeTrialGrantDoc> = {
  toFirestore(grant: LoungeTrialGrantDoc): DocumentData {
    assertNoTrialGrantPii(grant as unknown as Record<string, unknown>, grant.xUserIdHash);
    const data: DocumentData = {
      keyVersion: grant.keyVersion,
      riskStatus: grant.riskStatus,
      retainUntil: toRequiredFirestoreTimestamp(grant.retainUntil, 'retainUntil'),
    };
    if (grant.welcomeBonusGrantedAt !== undefined) {
      data['welcomeBonusGrantedAt'] = toRequiredFirestoreTimestamp(
        grant.welcomeBonusGrantedAt,
        'welcomeBonusGrantedAt',
      );
    }
    if (grant.trialTicketGrantedAt !== undefined) {
      data['trialTicketGrantedAt'] = toRequiredFirestoreTimestamp(
        grant.trialTicketGrantedAt,
        'trialTicketGrantedAt',
      );
    }
    return data;
  },
  fromFirestore(snapshot: QueryDocumentSnapshot): LoungeTrialGrantDoc {
    const data = snapshot.data();
    const id = snapshot.id;
    assertNoTrialGrantPii(data, id);
    const welcomeBonusGrantedAt = toOptionalLoungeIso(
      data['welcomeBonusGrantedAt'],
      COLLECTIONS.LOUNGE_TRIAL_GRANTS,
      id,
      'welcomeBonusGrantedAt',
    );
    const trialTicketGrantedAt = toOptionalLoungeIso(
      data['trialTicketGrantedAt'],
      COLLECTIONS.LOUNGE_TRIAL_GRANTS,
      id,
      'trialTicketGrantedAt',
    );
    return {
      xUserIdHash: id,
      keyVersion: toPositiveInteger(
        data['keyVersion'],
        COLLECTIONS.LOUNGE_TRIAL_GRANTS,
        id,
        'keyVersion',
      ),
      riskStatus: toRequiredEnum(
        data['riskStatus'],
        LOUNGE_TRIAL_RISK_STATUSES,
        COLLECTIONS.LOUNGE_TRIAL_GRANTS,
        id,
        'riskStatus',
      ),
      ...(welcomeBonusGrantedAt !== undefined ? { welcomeBonusGrantedAt } : {}),
      ...(trialTicketGrantedAt !== undefined ? { trialTicketGrantedAt } : {}),
      retainUntil: toRequiredLoungeIso(
        data['retainUntil'],
        COLLECTIONS.LOUNGE_TRIAL_GRANTS,
        id,
        'retainUntil',
      ),
    };
  },
};

// ---------------------------------------------------------------------------
// Public API: getCollections()
// ---------------------------------------------------------------------------

/**
 * Returns a map of fully-typed Firestore CollectionReferences, each bound
 * to the appropriate data converter.
 *
 * Usage:
 * ```ts
 * const db = new Firestore({ projectId });
 * const { users, conversationLogs, images } = getCollections(db);
 *
 * // Read – fully typed
 * const snap = await users.doc(userId).get();
 * const user: FirestoreUser = snap.data()!;
 *
 * // Write – type-checked against FirestoreUser
 * await users.doc(userId).set(newUser, { merge: true });
 * ```
 *
 * @param db - A live Firestore instance, provided by the application layer.
 * @returns An object containing typed collection references for the database.
 */
export function getCollections(db: Firestore) {
  return {
    /** Typed user documents. */
    users: db
      .collection(COLLECTIONS.USERS)
      .withConverter(userConverter),

    /** Typed raw conversation log documents (5-year TTL). */
    conversationLogs: db
      .collection(COLLECTIONS.CONVERSATION_LOGS)
      .withConverter(conversationLogConverter),

    /** Typed timeline post history documents (5-year TTL). */
    timelineHistory: db
      .collection(COLLECTIONS.TIMELINE_HISTORY)
      .withConverter(timelinePostConverter),

    /** Typed RAG memory documents with vector embeddings. */
    ragMemories: db
      .collection(COLLECTIONS.RAG_MEMORIES)
      .withConverter(ragMemoryConverter),

    /** Typed image asset metadata documents with vector embeddings. */
    images: db
      .collection(COLLECTIONS.IMAGES)
      .withConverter(imageDocConverter),

    /** Typed processed-follower idempotency documents. */
    processedFollowers: db
      .collection(COLLECTIONS.PROCESSED_FOLLOWERS)
      .withConverter(processedFollowerConverter),

    /** Typed list-interaction history documents. */
    listInteractionHistory: db
      .collection(COLLECTIONS.LIST_INTERACTION_HISTORY)
      .withConverter(listInteractionConverter),

    /**
     * Pass-through rate-limit counter documents.
     * Doc IDs use patterns such as `global_<date>`, `user_<id>_<date>`, etc.
     */
    rateLimits: db
      .collection(COLLECTIONS.RATE_LIMITS)
      .withConverter(rateLimitConverter),

    /**
     * Pass-through system singleton documents.
     * Known doc IDs: `persona`, `x_api_state`.
     */
    system: db
      .collection(COLLECTIONS.SYSTEM)
      .withConverter(personaConverter),

    /**
     * Pass-through system statistics documents.
     * Known doc IDs: `dau_<YYYY-MM-DD>`.
     */
    systemStats: db
      .collection(COLLECTIONS.SYSTEM_STATS)
      .withConverter(makePassThroughConverter<Record<string, unknown>>()),

    /**
     * Pass-through processed-mention idempotency documents.
     * Doc ID = tweet ID.
     */
    processedMentions: db
      .collection(COLLECTIONS.PROCESSED_MENTIONS)
      .withConverter(makePassThroughConverter<Record<string, unknown>>()),

    /**
     * Validated admin users documents for RBAC.
     * Doc ID = Firebase Auth UID.
     */
    adminUsers: db
      .collection(COLLECTIONS.ADMIN_USERS)
      .withConverter(adminUserConverter),

    /**
     * Pass-through processed Eventarc events idempotency documents.
     * Doc ID = Eventarc eventId.
     */
    processedEvents: db
      .collection(COLLECTIONS.PROCESSED_EVENTS)
      .withConverter(makePassThroughConverter<ProcessedEvent>()),

    /**
     * Typed campaign narrative event documents.
     * Doc ID = `camp_<timestamp>_<uuid>`.
     */
    campaigns: db
      .collection(COLLECTIONS.CAMPAIGNS)
      .withConverter(campaignDocConverter),

    /**
     * Pass-through reward image documents.
     * Doc ID = reward image UUID.
     */
    rewardImages: db
      .collection(COLLECTIONS.REWARD_IMAGES)
      .withConverter(makePassThroughConverter<RewardImageDoc>()),

    /** Typed support & tipping transaction documents (`support_transactions`). */
    supportTransactions: db
      .collection(COLLECTIONS.SUPPORT_TRANSACTIONS)
      .withConverter(makePassThroughConverter<SupportTransactionDoc>()),

    /** Typed isolated Private Lounge user profile documents (`lounge_users`). */
    loungeUsers: db
      .collection(COLLECTIONS.LOUNGE_USERS)
      .withConverter(loungeUserConverter),

    /** Typed isolated Private Lounge subscription & quota documents (`lounge_subscriptions`). */
    loungeSubscriptions: db
      .collection(COLLECTIONS.LOUNGE_SUBSCRIPTIONS)
      .withConverter(loungeSubscriptionConverter),

    /** Typed isolated Private Lounge session documents (`lounge_sessions`). */
    loungeSessions: db
      .collection(COLLECTIONS.LOUNGE_SESSIONS)
      .withConverter(loungeSessionConverter),

    /** Typed isolated Private Lounge chat message documents (`lounge_messages`). */
    loungeMessages: db
      .collection(COLLECTIONS.LOUNGE_MESSAGES)
      .withConverter(loungeMessageConverter),

    /** Typed isolated Private Lounge RAG memory documents (`lounge_rag_memories`). */
    loungeRagMemories: db
      .collection(COLLECTIONS.LOUNGE_RAG_MEMORIES)
      .withConverter(loungeRagMemoryConverter),

    /** Typed isolated Private Lounge gallery illustration documents (`lounge_gallery`). */
    loungeGallery: db
      .collection(COLLECTIONS.LOUNGE_GALLERY)
      .withConverter(loungeGalleryConverter),

    /** Typed isolated Private Lounge event idempotency documents (`lounge_processed_events`). */
    loungeProcessedEvents: db
      .collection(COLLECTIONS.LOUNGE_PROCESSED_EVENTS)
      .withConverter(loungeProcessedEventConverter),
    /** Typed isolated Private Lounge credit lot documents (`lounge_credit_lots`). */
    loungeCreditLots: db
      .collection(COLLECTIONS.LOUNGE_CREDIT_LOTS)
      .withConverter(loungeCreditLotConverter),
    /** Typed isolated Private Lounge 180-day TTL quota ledger documents (`lounge_quota_ledger`). */
    loungeQuotaLedger: db
      .collection(COLLECTIONS.LOUNGE_QUOTA_LEDGER)
      .withConverter(loungeQuotaLedgerConverter),
    /** Typed non-PII HMAC anti-fraud trial/welcome grant records (`lounge_trial_grants`). */
    loungeTrialGrants: db
      .collection(COLLECTIONS.LOUNGE_TRIAL_GRANTS)
      .withConverter(loungeTrialGrantConverter),
  } as const;
}

/** Type alias for the return value of `getCollections`. */
export type DbCollections = ReturnType<typeof getCollections>;

/**
 * Verifies at runtime that a fetched Private Lounge record belongs exclusively to `expectedUid`
 * to prevent cross-tenant data leakage even if a downstream query filter were misconfigured.
 *
 * @throws Error When `expectedUid` is blank or `record.uid !== expectedUid`.
 */
export function assertLoungeRecordOwnedByUid<T extends { uid: string }>(
  record: T,
  expectedUid: string,
  collectionName: string,
): T {
  const normalizedUid = expectedUid.trim();
  if (!normalizedUid) {
    throw new Error(`Tenant UID must not be empty when accessing ${collectionName}`);
  }
  if (record.uid !== normalizedUid) {
    throw new Error(
      `Cross-tenant access blocked on ${collectionName}: expected uid "${normalizedUid}" but got "${record.uid}"`,
    );
  }
  return record;
}

function normalizeScopedLoungeUid(uid: string): string {
  const scopedUid = uid.trim();
  if (!scopedUid) {
    throw new Error('Cannot construct user-scoped Lounge DB accessor with empty uid');
  }
  return scopedUid;
}

/**
 * Creates a strictly tenant-scoped accessor for Private Lounge Account billing/quota collections.
 *
 * @throws Error When `uid` is empty or whitespace.
 */
export function createUserScopedLoungeAccountDb(
  collections: Pick<
    DbCollections,
    'loungeSubscriptions' | 'loungeCreditLots' | 'loungeQuotaLedger'
  >,
  uid: string,
) {
  const scopedUid = normalizeScopedLoungeUid(uid);
  return {
    uid: scopedUid,
    subscriptionDoc: () => collections.loungeSubscriptions.doc(scopedUid),
    creditLotDoc: (lotId: string) => collections.loungeCreditLots.doc(lotId),
    creditLotsQuery: () => collections.loungeCreditLots.where('uid', '==', scopedUid),
    quotaLedgerQuery: () => collections.loungeQuotaLedger.where('uid', '==', scopedUid),
    assertOwned: <T extends { uid: string }>(record: T, collectionName: string): T =>
      assertLoungeRecordOwnedByUid(record, scopedUid, collectionName),
  };
}

/**
 * Creates a strictly tenant-scoped accessor for Private Lounge Gallery collections.
 *
 * @throws Error When `uid` is empty or whitespace.
 */
export function createUserScopedLoungeGalleryDb(
  collections: Pick<DbCollections, 'loungeUsers' | 'loungeGallery'>,
  uid: string,
) {
  const scopedUid = normalizeScopedLoungeUid(uid);
  return {
    uid: scopedUid,
    userDoc: () => collections.loungeUsers.doc(scopedUid),
    galleryDoc: (assetId: string) => collections.loungeGallery.doc(`${scopedUid}_${assetId}`),
    galleryQuery: () => collections.loungeGallery.where('uid', '==', scopedUid),
    assertOwned: <T extends { uid: string }>(record: T, collectionName: string): T =>
      assertLoungeRecordOwnedByUid(record, scopedUid, collectionName),
  };
}

/**
 * Creates a strictly tenant-scoped accessor for Private Lounge Session/Message/RAG collections.
 *
 * @throws Error When `uid` is empty or whitespace.
 */
export function createUserScopedLoungeSessionDb(
  collections: Pick<
    DbCollections,
    'loungeUsers' | 'loungeSessions' | 'loungeMessages' | 'loungeRagMemories'
  >,
  uid: string,
) {
  const scopedUid = normalizeScopedLoungeUid(uid);
  return {
    uid: scopedUid,
    userDoc: () => collections.loungeUsers.doc(scopedUid),
    sessionDoc: () => collections.loungeSessions.doc(scopedUid),
    messagesQuery: () => collections.loungeMessages.where('uid', '==', scopedUid),
    ragMemoriesQuery: () => collections.loungeRagMemories.where('uid', '==', scopedUid),
    assertOwned: <T extends { uid: string }>(record: T, collectionName: string): T =>
      assertLoungeRecordOwnedByUid(record, scopedUid, collectionName),
  };
}

/**
 * Creates a strictly tenant-scoped accessor over isolated `lounge_*` collections so repositories
 * cannot execute unscoped queries or access another user's records accidentally.
 *
 * @throws Error When `uid` is empty or whitespace.
 */
export function createUserScopedLoungeDb(
  collections: Pick<
    DbCollections,
    | 'loungeUsers'
    | 'loungeSubscriptions'
    | 'loungeSessions'
    | 'loungeMessages'
    | 'loungeRagMemories'
    | 'loungeGallery'
    | 'loungeCreditLots'
    | 'loungeQuotaLedger'
  >,
  uid: string,
) {
  const scopedUid = normalizeScopedLoungeUid(uid);
  const account = createUserScopedLoungeAccountDb(collections, scopedUid);
  const gallery = createUserScopedLoungeGalleryDb(collections, scopedUid);
  const session = createUserScopedLoungeSessionDb(collections, scopedUid);
  return {
    uid: scopedUid,
    userDoc: () => collections.loungeUsers.doc(scopedUid),
    subscriptionDoc: account.subscriptionDoc,
    sessionDoc: session.sessionDoc,
    galleryDoc: gallery.galleryDoc,
    creditLotDoc: account.creditLotDoc,
    messagesQuery: session.messagesQuery,
    ragMemoriesQuery: session.ragMemoriesQuery,
    galleryQuery: gallery.galleryQuery,
    creditLotsQuery: account.creditLotsQuery,
    quotaLedgerQuery: account.quotaLedgerQuery,
    assertOwned: <T extends { uid: string }>(record: T, collectionName: string): T =>
      assertLoungeRecordOwnedByUid(record, scopedUid, collectionName),
  };
}

// Re-export converters for consumers that need direct access (e.g., unit tests).
export {
  userConverter,
  conversationLogConverter,
  timelinePostConverter,
  ragMemoryConverter,
  imageDocConverter,
  processedFollowerConverter,
  listInteractionConverter,
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
};

// Re-export all schema models and collection constants.
export * from './schema';

