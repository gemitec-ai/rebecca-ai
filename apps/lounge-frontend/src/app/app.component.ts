import {
  Component,
  ElementRef,
  HostListener,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import type { LoungeEmotionState } from '@rebecca/types';
import {
  LOUNGE_LANGUAGE_OPTIONS,
  LOUNGE_TIMEZONE_OPTIONS,
} from './core/i18n/lounge-translations';
import {
  LOUNGE_GALLERY_PAGE_SIZE,
  LoungeFacadeService,
} from './core/services/lounge-facade.service';
import { LoungeDropdownComponent } from './shared/components/lounge-dropdown/lounge-dropdown.component';
import { LoungePaginationComponent } from './shared/components/lounge-pagination/lounge-pagination.component';
import { ReconsentModalComponent } from './shared/components/reconsent-modal/reconsent-modal.component';

/**
 * Root presentation shell orchestrating Entrance (`AUTH` + `ONBOARDING` locale step) and
 * Authenticated Single-Session Lounge (`CHAT`, `GALLERY`, `OPTIONS` + Re-Consent & Withdrawal Modals).
 */
@Component({
  selector: 'app-root',
  imports: [LoungeDropdownComponent, LoungePaginationComponent, ReconsentModalComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent {
  public readonly facade = inject(LoungeFacadeService);
  private readonly injector = inject(Injector);

  public readonly languageOptions = LOUNGE_LANGUAGE_OPTIONS;
  public readonly timezoneOptions = LOUNGE_TIMEZONE_OPTIONS;
  public readonly galleryPageSize = LOUNGE_GALLERY_PAGE_SIZE;

  public readonly selectedImageUrl = signal<string | null>(null);
  public readonly showJumpToLatest = signal<boolean>(false);

  public readonly formattedVersion = computed(() => {
    const raw = this.facade.appVersion().trim();
    if (!raw) {
      return '';
    }
    return raw.startsWith('v') ? raw : `v${raw}`;
  });

  public readonly unlockedGalleryCount = computed(() =>
    this.facade.galleryTotalItems() > 0 || this.facade.galleryUnlockedCount() > 0
      ? this.facade.galleryUnlockedCount()
      : (this.facade.accountSummary()?.unlockedGalleryCount ?? 0),
  );

  public readonly totalGalleryCount = computed(() =>
    this.facade.galleryTotalItems() > 0
      ? this.facade.galleryTotalItems()
      : (this.facade.accountSummary()?.totalGalleryCount ?? 0),
  );

  private readonly disclaimerBoxRef = viewChild<ElementRef<HTMLElement>>('disclaimerBox');
  private readonly composerInputRef = viewChild<ElementRef<HTMLTextAreaElement>>('composerInput');
  private readonly chatStreamRef = viewChild<ElementRef<HTMLElement>>('chatStream');
  private readonly loungeWorkspaceRef = viewChild<ElementRef<HTMLElement>>('loungeWorkspace');
  private readonly sidebarDrawerRef = viewChild<ElementRef<HTMLElement>>('sidebarDrawer');
  private readonly closeSidebarButtonRef =
    viewChild<ElementRef<HTMLButtonElement>>('closeSidebarButton');
  private readonly hamburgerButtonRef =
    viewChild<ElementRef<HTMLButtonElement>>('hamburgerButton');
  private readonly lightboxModalRef = viewChild<ElementRef<HTMLElement>>('lightboxModal');
  private readonly closeLightboxButtonRef =
    viewChild<ElementRef<HTMLButtonElement>>('closeLightboxButton');
  private readonly deleteModalRef = viewChild<ElementRef<HTMLElement>>('deleteModal');
  private readonly openDeleteButtonRef =
    viewChild<ElementRef<HTMLButtonElement>>('openDeleteAccountButton');
  private readonly deleteCancelButtonRef =
    viewChild<ElementRef<HTMLButtonElement>>('deleteCancelButton');
  private readonly deleteIrreversibleCheckRef =
    viewChild<ElementRef<HTMLInputElement>>('deleteIrreversibleCheck');
  private readonly reconsentModalRef = viewChild<ReconsentModalComponent>('reconsentModal');

  private lastLightboxTriggerEl: HTMLElement | null = null;
  private wasSidebarOpen = false;
  private prevDeleteStep = 0;

  constructor() {
    effect(() => {
      const view = this.facade.activeView();
      const authMode = this.facade.authMode();
      this.facade.lang();
      const boxEl = this.disclaimerBoxRef()?.nativeElement;
      if (view === 'AUTH' && authMode === 'SIGNUP' && boxEl) {
        queueMicrotask(() => {
          this.checkZeroOverflowDisclaimer(boxEl);
        });
      }
    });

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

    effect(() => {
      const isOpen = this.facade.isSidebarOpen();
      if (isOpen && !this.wasSidebarOpen) {
        queueMicrotask(() => {
          this.closeSidebarButtonRef()?.nativeElement.focus();
        });
      } else if (!isOpen && this.wasSidebarOpen) {
        queueMicrotask(() => {
          this.hamburgerButtonRef()?.nativeElement.focus();
        });
      }
      this.wasSidebarOpen = isOpen;
    });

    effect(() => {
      const deleteStep = this.facade.deleteAccountStep();
      if (deleteStep > 0 && this.prevDeleteStep === 0) {
        queueMicrotask(() => {
          this.deleteCancelButtonRef()?.nativeElement.focus();
        });
      } else if (deleteStep === 2 && this.prevDeleteStep === 1) {
        queueMicrotask(() => {
          this.deleteIrreversibleCheckRef()?.nativeElement.focus();
        });
      } else if (deleteStep === 0 && this.prevDeleteStep > 0) {
        queueMicrotask(() => {
          if (this.facade.isReconsentRequired()) {
            this.reconsentModalRef()?.focusDeleteButton();
          } else {
            this.openDeleteButtonRef()?.nativeElement.focus();
          }
        });
      }
      this.prevDeleteStep = deleteStep;
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

  /** Changes the active Gallery page and scrolls the gallery workspace back to top. */
  public onGalleryPageChange(page: number): void {
    const workspaceEl = this.loungeWorkspaceRef()?.nativeElement;
    if (workspaceEl) {
      workspaceEl.scrollTop = 0;
    }
    void this.facade.loadGalleryPage(page);
  }

  /**
   * Handles global Escape dismissal and keyboard Tab focus trapping across active dialogs
   * (`#delete-account-modal`, `#gallery-lightbox-modal`, or `#lounge-sidebar-drawer`).
   */
  @HostListener('document:keydown', ['$event'])
  public onDocumentKeydown(event: KeyboardEvent): void {
    const deleteEl = this.deleteModalRef()?.nativeElement;
    if (this.facade.deleteAccountStep() > 0 && deleteEl) {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.facade.closeDeleteAccountModal();
        return;
      }
      if (event.key === 'Tab') {
        this.trapFocusWithinContainer(event, deleteEl);
      }
      return;
    }

    if (this.facade.isReconsentRequired()) {
      return;
    }

    const lightboxEl = this.lightboxModalRef()?.nativeElement;
    if (this.selectedImageUrl() && lightboxEl) {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.closeLightbox();
        return;
      }
      if (event.key === 'Tab') {
        this.trapFocusWithinContainer(event, lightboxEl);
      }
      return;
    }

    const drawerEl = this.sidebarDrawerRef()?.nativeElement;
    if (this.facade.isSidebarOpen() && drawerEl) {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.facade.toggleSidebar(false);
        return;
      }
      if (event.key === 'Tab') {
        this.trapFocusWithinContainer(event, drawerEl);
      }
    }
  }

  /** Automatically unlocks short non-overflowing disclaimer containers on viewport resize. */
  @HostListener('window:resize')
  public onWindowResize(): void {
    const boxEl = this.disclaimerBoxRef()?.nativeElement;
    if (boxEl) {
      this.checkZeroOverflowDisclaimer(boxEl);
    }
  }

  /** Tracks disclaimer scroll depth and enables consent checkbox at the bottom. */
  public onDisclaimerScroll(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    this.facade.updateDisclaimerScroll(target.scrollTop, target.clientHeight, target.scrollHeight);
  }

  /** Synchronizes consent checkbox state through the facade validation guard. */
  public onConsentChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    this.facade.setDisclaimerChecked(target.checked);
  }

  /** Synchronizes the Step 2 irreversible data-erasure confirmation checkbox. */
  public onDeleteIrreversibleChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    this.facade.setDeleteConfirmIrreversible(target.checked);
  }

  /** Synchronizes the Step 2 no-refund acknowledgement checkbox. */
  public onDeleteNoRefundChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    this.facade.setDeleteConfirmNoRefund(target.checked);
  }

  /** Updates the message draft signal and auto-grows the composer textarea cleanly. */
  public onComposerInput(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement)) {
      return;
    }
    this.facade.composerDraft.set(target.value);
    target.style.height = 'auto';
    if (target.scrollHeight > 0) {
      target.style.height = `${Math.min(target.scrollHeight, 128)}px`;
    }
  }

  /** Submits the composer message on Enter while preserving Shift+Enter newlines. */
  public onComposerKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
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

  /** Switches active UI and conversational response language via allowlisted options. */
  public onLanguageChange(value: string): void {
    const matched = LOUNGE_LANGUAGE_OPTIONS.find((opt) => opt.value === value);
    if (matched) {
      void this.facade.setLanguage(matched.value);
    }
  }

  /** Updates user IANA timezone so day/night greeting context aligns with local time. */
  public onTimezoneChange(value: string): void {
    const matched = LOUNGE_TIMEZONE_OPTIONS.find((opt) => opt.value === value);
    if (matched) {
      void this.facade.setTimezone(matched.value);
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

  /** Opens the full-resolution illustration lightbox and saves focus restoration target. */
  public openImagePreview(imageUrl: string, event?: Event): void {
    if (!imageUrl) {
      return;
    }
    this.lastLightboxTriggerEl =
      event?.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    this.selectedImageUrl.set(imageUrl);
    queueMicrotask(() => {
      this.closeLightboxButtonRef()?.nativeElement.focus();
    });
  }

  /** Closes the illustration lightbox and restores keyboard focus to its opening control. */
  public closeLightbox(): void {
    this.selectedImageUrl.set(null);
    const trigger = this.lastLightboxTriggerEl;
    this.lastLightboxTriggerEl = null;
    if (trigger) {
      queueMicrotask(() => {
        trigger.focus();
      });
    }
  }

  /** Navigates directly to the unlocked Lounge illustration gallery from the celebration toast. */
  public openGalleryFromUnlockToast(): void {
    this.facade.dismissUnlockedGalleryNotice();
    this.facade.navigateTo('GALLERY');
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

  private checkZeroOverflowDisclaimer(boxEl: HTMLElement): void {
    if (boxEl.clientHeight > 0 && boxEl.scrollHeight <= boxEl.clientHeight) {
      this.facade.updateDisclaimerScroll(boxEl.scrollTop, boxEl.clientHeight, boxEl.scrollHeight);
    }
  }

  private trapFocusWithinContainer(event: KeyboardEvent, container: HTMLElement): void {
    const focusables = Array.from(
      container.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusables.length === 0) {
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    const activeIndex = active instanceof HTMLElement ? focusables.indexOf(active) : -1;

    if (event.shiftKey) {
      if (activeIndex <= 0) {
        event.preventDefault();
        last.focus();
      }
      return;
    }

    if (activeIndex === -1 || activeIndex === focusables.length - 1) {
      event.preventDefault();
      first.focus();
    }
  }
}
