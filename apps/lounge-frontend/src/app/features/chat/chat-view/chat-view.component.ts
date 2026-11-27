import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { LoungeEmotionState } from '@rebecca/types';
import {
  LOUNGE_CHAT_PAGE_SIZE,
  MAX_LOUNGE_COMPOSER_LENGTH,
  LoungeFacadeService,
} from '../../../core/services/lounge-facade.service';

/** Image preview selection payload emitted when a user taps an inline illustration. */
export interface LoungeImagePreviewEvent {
  readonly imageUrl: string;
  readonly event?: Event;
}

/**
 * Primary single-session chat workspace featuring the PC companion showcase panel,
 * lazy upward history pagination, emotion-mapped circular avatars, inline gallery previews,
 * quota/past-due HUD banners, and auto-growing message composer.
 */
@Component({
  selector: 'app-chat-view',
  templateUrl: './chat-view.component.html',
  styleUrl: './chat-view.component.css',
})
export class ChatViewComponent {
  public readonly facade = inject(LoungeFacadeService);
  private readonly injector = inject(Injector);

  public readonly unlockedGalleryCount = input.required<number>();
  public readonly totalGalleryCount = input.required<number>();

  public readonly imagePreviewRequested = output<LoungeImagePreviewEvent>();

  public readonly showJumpToLatest = signal<boolean>(false);
  public readonly maxComposerLength = MAX_LOUNGE_COMPOSER_LENGTH;
  public readonly chatPageSize = LOUNGE_CHAT_PAGE_SIZE;

  private readonly chatStreamRef = viewChild<ElementRef<HTMLElement>>('chatStream');
  private readonly composerInputRef = viewChild<ElementRef<HTMLTextAreaElement>>('composerInput');

  constructor() {
    effect(() => {
      const anchorSeq = this.facade.latestMessageAnchorSeq();
      const view = this.facade.activeView();
      if (view === 'CHAT' && anchorSeq > 0) {
        afterNextRender(
          () => {
            this.showJumpToLatest.set(false);
            this.scrollChatToBottom();
          },
          { injector: this.injector },
        );
      }
    });
  }

  /** Scrolls the chat stream cleanly to the bottom, including after inline illustration image decode. */
  public scrollChatToBottom(): void {
    const el = this.chatStreamRef()?.nativeElement;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }

  /** Tracks chat scroll position to toggle Jump-to-latest pill and upward lazy-load older turns. */
  public onChatScroll(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
    this.showJumpToLatest.set(distanceFromBottom > 80);

    if (
      target.scrollTop <= 40 &&
      this.facade.hasMoreMessages() &&
      !this.facade.isLoadingOlderMessages()
    ) {
      void this.triggerLoadOlderMessages();
    }
  }

  /**
   * Prepends the next older page of conversation turns and preserves viewport scroll offset
   * (`prevScrollTop + (newScrollHeight - prevScrollHeight)`) strictly after Zoneless DOM commit.
   */
  public async triggerLoadOlderMessages(): Promise<void> {
    const el = this.chatStreamRef()?.nativeElement;
    const prevScrollHeight = el?.scrollHeight ?? 0;
    const prevScrollTop = el?.scrollTop ?? 0;
    const loaded = await this.facade.loadOlderMessages();
    if (!loaded || !el) {
      return;
    }
    afterNextRender(
      () => {
        const delta = el.scrollHeight - prevScrollHeight;
        el.scrollTop = Math.max(0, prevScrollTop + delta);
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        this.showJumpToLatest.set(distanceFromBottom > 80);
      },
      { injector: this.injector },
    );
  }

  /** Returns the chat viewport immediately to the latest message and hides the jump pill. */
  public jumpToLatestMessage(): void {
    this.showJumpToLatest.set(false);
    this.scrollChatToBottom();
  }

  /** Scrolls to bottom after inline image load only while anchored near latest messages. */
  public onInlineImageLoad(): void {
    if (!this.showJumpToLatest()) {
      this.scrollChatToBottom();
    }
  }

  /** Updates the message draft signal and auto-grows the composer textarea cleanly. */
  public onComposerInput(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement)) {
      return;
    }
    const clamped = target.value.slice(0, MAX_LOUNGE_COMPOSER_LENGTH);
    if (target.value !== clamped) {
      target.value = clamped;
    }
    this.facade.composerDraft.set(clamped);
    target.style.height = 'auto';
    if (target.scrollHeight > 0) {
      target.style.height = `${Math.min(target.scrollHeight, 128)}px`;
    }
  }

  /** Submits composer message on Enter while ignoring active IME composition and Shift+Enter newlines. */
  public onComposerKeydown(event: KeyboardEvent): void {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.isComposing &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      void this.onSendMessage();
    }
  }

  /** Submits the trimmed composer message and resets textarea height. */
  public async onSendMessage(event?: Event): Promise<void> {
    event?.preventDefault();
    const draft = this.facade.composerDraft();
    await this.facade.sendMessage(draft);
    const inputEl = this.composerInputRef()?.nativeElement;
    if (inputEl && !this.facade.composerDraft()) {
      inputEl.style.height = 'auto';
    }
  }

  /**
   * Resolves the persona avatar icon URL matching the current assistant emotion, falling back
   * cleanly to the configured default chat icon path.
   */
  public getEmotionAvatarPath(emotion?: LoungeEmotionState): string {
    const branding = this.facade.personaBranding();
    if (!emotion) {
      return branding.chatIconPath;
    }
    return branding.emotionAvatarPaths[emotion] ?? branding.chatIconPath;
  }

  /** Formats the next local daily quota reset timestamp in user's selected timezone. */
  public formatResetTimestamp(isoTimestamp: string | undefined): string {
    if (!isoTimestamp) {
      return '';
    }
    const parsed = new Date(isoTimestamp);
    if (Number.isNaN(parsed.getTime())) {
      return '';
    }
    try {
      return new Intl.DateTimeFormat(this.facade.lang(), {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZone: this.facade.timezone(),
      }).format(parsed);
    } catch {
      return parsed.toISOString().slice(11, 16);
    }
  }

  /** Formats an ISO-8601 message timestamp into `HH:mm` (`h23`) in the active locale and timezone. */
  public formatMessageTime(isoTimestamp: string): string {
    const parsed = new Date(isoTimestamp);
    if (Number.isNaN(parsed.getTime())) {
      return '';
    }
    try {
      return new Intl.DateTimeFormat(this.facade.lang(), {
        timeZone: this.facade.timezone(),
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(parsed);
    } catch {
      return parsed.toISOString().slice(11, 16);
    }
  }
}
