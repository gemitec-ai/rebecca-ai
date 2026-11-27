import {
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import {
  LOUNGE_LANGUAGE_OPTIONS,
  buildLoungeTimezoneOptions,
} from './core/i18n';
import {
  LOUNGE_GALLERY_PAGE_SIZE,
  LoungeFacadeService,
} from './core/services/lounge-facade.service';
import { EntranceViewComponent } from './features/auth/entrance-view/entrance-view.component';
import { ReconsentModalComponent } from './features/auth/reconsent-modal/reconsent-modal.component';
import { BillingHubComponent } from './features/billing/billing-hub/billing-hub.component';
import { ChatViewComponent } from './features/chat/chat-view/chat-view.component';
import { GalleryLightboxModalComponent } from './features/gallery/gallery-lightbox-modal/gallery-lightbox-modal.component';
import { GalleryViewComponent } from './features/gallery/gallery-view/gallery-view.component';
import { DeleteAccountModalComponent } from './features/options/delete-account-modal/delete-account-modal.component';
import { OptionsViewComponent } from './features/options/options-view/options-view.component';

/**
 * Root presentation shell orchestrating Boot/Config error chrome, Topbar, Slide-Over Sidebar
 * navigation drawer, view switching across Entrance/Chat/Gallery/Billing/Options, and top-layer modals.
 */
@Component({
  selector: 'app-root',
  imports: [
    EntranceViewComponent,
    ChatViewComponent,
    GalleryViewComponent,
    OptionsViewComponent,
    ReconsentModalComponent,
    BillingHubComponent,
    DeleteAccountModalComponent,
    GalleryLightboxModalComponent,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent {
  public readonly facade = inject(LoungeFacadeService);

  public readonly languageOptions = LOUNGE_LANGUAGE_OPTIONS;
  public readonly timezoneOptions = computed(() =>
    buildLoungeTimezoneOptions(this.facade.timezone()),
  );
  public readonly galleryPageSize = LOUNGE_GALLERY_PAGE_SIZE;

  public readonly selectedImageUrl = signal<string | null>(null);

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
    this.facade.galleryCatalogTotalCount() > 0
      ? this.facade.galleryCatalogTotalCount()
      : (this.facade.accountSummary()?.totalGalleryCount ?? 0),
  );

  private readonly loungeWorkspaceRef = viewChild<ElementRef<HTMLElement>>('loungeWorkspace');
  private readonly sidebarDrawerRef = viewChild<ElementRef<HTMLElement>>('sidebarDrawer');
  private readonly closeSidebarButtonRef =
    viewChild<ElementRef<HTMLButtonElement>>('closeSidebarButton');
  private readonly hamburgerButtonRef =
    viewChild<ElementRef<HTMLButtonElement>>('hamburgerButton');
  private readonly reconsentModalRef = viewChild<ReconsentModalComponent>('reconsentModal');
  private readonly optionsViewRef = viewChild<OptionsViewComponent>('optionsView');

  private lastLightboxTriggerEl: HTMLElement | null = null;
  private wasSidebarOpen = false;

  constructor() {
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
  }

  /**
   * Handles Escape dismissal and keyboard Tab focus wrapping strictly for the slide-over
   * `#lounge-sidebar-drawer` landmark when open and unobstructed by native modal dialogs.
   */
  @HostListener('document:keydown', ['$event'])
  public onDocumentKeydown(event: KeyboardEvent): void {
    if (
      this.facade.deleteAccountStep() > 0 ||
      this.facade.isReconsentRequired() ||
      this.facade.selectedCheckoutProduct() !== null ||
      this.selectedImageUrl() !== null
    ) {
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

  /** Changes the active Gallery page and scrolls the gallery workspace back to top. */
  public onGalleryPageChange(page: number): void {
    const workspaceEl = this.loungeWorkspaceRef()?.nativeElement;
    if (workspaceEl) {
      workspaceEl.scrollTop = 0;
    }
    void this.facade.loadGalleryPage(page);
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
    const matched = this.timezoneOptions().find((opt) => opt.value === value);
    if (matched) {
      void this.facade.setTimezone(matched.value);
    }
  }

  /** Opens the full-resolution illustration lightbox and saves focus restoration target. */
  public openImagePreview(imageUrl: string, event?: Event): void {
    if (!imageUrl) {
      return;
    }
    this.lastLightboxTriggerEl =
      event?.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    this.selectedImageUrl.set(imageUrl);
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

  /** Restores keyboard focus cleanly back to the triggering delete control after modal dismissal. */
  public onDeleteModalClosed(): void {
    if (this.facade.isReconsentRequired()) {
      this.reconsentModalRef()?.focusDeleteButton();
    } else {
      this.optionsViewRef()?.focusOpenDeleteButton();
    }
  }

  /** Navigates directly to the unlocked Lounge illustration gallery from the celebration toast. */
  public openGalleryFromUnlockToast(): void {
    this.facade.dismissUnlockedGalleryNotice();
    this.facade.navigateTo('GALLERY');
  }

  private isFocusableVisible(el: HTMLElement, container: HTMLElement): boolean {
    let cursor: HTMLElement | null = el;
    while (cursor) {
      if (
        cursor.hasAttribute('hidden') ||
        cursor.getAttribute('aria-hidden') === 'true' ||
        cursor.hasAttribute('inert')
      ) {
        return false;
      }
      const style = window.getComputedStyle(cursor);
      if (style.display === 'none' || style.visibility === 'hidden') {
        return false;
      }
      if (cursor === container) {
        break;
      }
      cursor = cursor.parentElement;
    }
    return true;
  }

  private trapFocusWithinContainer(event: KeyboardEvent, container: HTMLElement): void {
    const focusables = Array.from(
      container.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => this.isFocusableVisible(el, container));
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
