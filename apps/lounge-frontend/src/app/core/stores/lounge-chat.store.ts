import { Injectable, computed, inject, signal } from '@angular/core';
import type {
  LOUNGE_ERROR_CODE_DISCLAIMER_RECONSENT_REQUIRED,
  LoungeMessage,
  LoungeMessageListResponseDto,
  LoungeSession,
} from '@rebecca/types';
import { LoungeSessionPort } from '../ports/lounge-session.port';
import { assertNonEmptyChatMessage } from '../validators/lounge-business.validator';
import { LoungeAccountOptionsStore } from './lounge-account-options.store';
import { LoungeGalleryStore } from './lounge-gallery.store';
import { LoungeShellStore } from './lounge-shell.store';

/** Fixed page size for upward chat history pagination (`desc` windowing). */
export const LOUNGE_CHAT_PAGE_SIZE = 20;

/** Maximum allowed composer character count enforced on client and backend. */
export const MAX_LOUNGE_COMPOSER_LENGTH = 1500;

const DISCLAIMER_RECONSENT_REQUIRED_CODE: typeof LOUNGE_ERROR_CODE_DISCLAIMER_RECONSENT_REQUIRED =
  'DISCLAIMER_RECONSENT_REQUIRED';

function isReconsentRequiredError(
  err: unknown,
): err is { readonly code: string; readonly requiredDisclaimerVersion?: number } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === DISCLAIMER_RECONSENT_REQUIRED_CODE
  );
}

/**
 * Feature store managing single-session chat messages, upward history pagination cursors,
 * composer drafts, and mid-session re-consent detection during turn submission.
 */
@Injectable({ providedIn: 'root' })
export class LoungeChatStore {
  private readonly sessionPort = inject(LoungeSessionPort);
  private readonly shell = inject(LoungeShellStore);
  private readonly accountStore = inject(LoungeAccountOptionsStore);
  private readonly galleryStore = inject(LoungeGalleryStore);

  public readonly activeSession = signal<LoungeSession | null>(null);
  public readonly messages = signal<readonly LoungeMessage[]>([]);
  public readonly isLoadingOlderMessages = signal<boolean>(false);
  public readonly hasMoreMessages = signal<boolean>(false);
  public readonly oldestMessageCursor = signal<string | null>(null);
  public readonly messagesTotalItems = signal<number>(0);
  public readonly latestMessageAnchorSeq = signal<number>(0);
  public readonly composerDraft = signal<string>('');

  public readonly composerCharCount = computed(() => this.composerDraft().length);

  /** Applies session metadata and initial page of chat messages on authentication. */
  public hydrateInitialChat(
    session: LoungeSession,
    messagesPage: LoungeMessageListResponseDto,
  ): void {
    this.activeSession.set(session);
    this.messages.set(messagesPage.data);
    this.hasMoreMessages.set(messagesPage.meta.hasMore);
    this.oldestMessageCursor.set(messagesPage.meta.nextCursor);
    this.messagesTotalItems.set(messagesPage.meta.totalItems);
    this.latestMessageAnchorSeq.update((seq) => seq + 1);
  }

  /** Prepends the next older slice of conversation turns via `oldestMessageCursor`. */
  public async loadOlderMessages(): Promise<boolean> {
    if (this.isLoadingOlderMessages() || !this.hasMoreMessages()) {
      return false;
    }
    const cursor = this.oldestMessageCursor();
    if (!cursor) {
      this.hasMoreMessages.set(false);
      return false;
    }
    this.isLoadingOlderMessages.set(true);
    try {
      const page = await this.sessionPort.listMessages({
        limit: LOUNGE_CHAT_PAGE_SIZE,
        cursor,
      });
      this.messages.update((prev) => {
        const existingIds = new Set(prev.map((msg) => msg.id));
        const older = page.data.filter((msg) => !existingIds.has(msg.id));
        return older.length > 0 ? [...older, ...prev] : prev;
      });
      this.hasMoreMessages.set(page.meta.hasMore);
      this.oldestMessageCursor.set(page.meta.nextCursor);
      this.messagesTotalItems.set(page.meta.totalItems);
      return page.data.length > 0;
    } catch (err) {
      this.shell.errorMessage.set(this.shell.mapUiError(err, 'errorGeneric'));
      return false;
    } finally {
      this.isLoadingOlderMessages.set(false);
    }
  }

  /** Submits a new chat turn and reconciles messages, quota counters, and Gallery unlocks. */
  public async sendMessage(
    content: string,
    onReconsentRequired: (requiredVersion?: number) => void,
  ): Promise<void> {
    if (!content.trim() || !this.activeSession() || this.shell.isLoading()) {
      return;
    }
    const trimmed = assertNonEmptyChatMessage(content).slice(0, MAX_LOUNGE_COMPOSER_LENGTH);
    this.shell.isLoading.set(true);
    this.shell.errorMessage.set(null);
    try {
      const res = await this.sessionPort.sendMessage({ content: trimmed });
      this.activeSession.set(res.session);
      this.messages.update((prev) => [...prev, res.userMessage, res.assistantMessage]);
      this.messagesTotalItems.update((count) => Math.max(count + 2, this.messages().length));
      this.latestMessageAnchorSeq.update((seq) => seq + 1);

      const { nextUnlockedCount, nextCatalogTotal } = this.galleryStore.applyUnlockedItem(
        res.unlockedGalleryItem,
      );
      this.accountStore.syncAfterChatTurn(
        nextUnlockedCount,
        nextCatalogTotal,
        res.remainingChatTurns,
        res.subscription,
      );
      this.composerDraft.set('');
    } catch (err) {
      if (isReconsentRequiredError(err)) {
        onReconsentRequired(err.requiredDisclaimerVersion);
        return;
      }
      this.shell.errorMessage.set(this.shell.mapUiError(err, 'errorGeneric'));
    } finally {
      this.shell.isLoading.set(false);
    }
  }

  /** Resets all chat session history, cursor state, and composer draft on logout or deletion. */
  public reset(): void {
    this.activeSession.set(null);
    this.messages.set([]);
    this.isLoadingOlderMessages.set(false);
    this.hasMoreMessages.set(false);
    this.oldestMessageCursor.set(null);
    this.messagesTotalItems.set(0);
    this.latestMessageAnchorSeq.set(0);
    this.composerDraft.set('');
  }
}
