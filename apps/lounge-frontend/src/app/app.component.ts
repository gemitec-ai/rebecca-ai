import { CommonModule } from '@angular/common';
import {
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { LoungeEmotionState, LoungeReward } from '@rebecca/types';
import { LoungeFacadeService } from './core/services/lounge-facade.service';

const EMOTION_LABELS: Record<LoungeEmotionState, { ja: string; en: string; accent: string }> = {
  NEUTRAL: { ja: '落ち着き', en: 'NEUTRAL', accent: '#94a3b8' },
  HAPPY: { ja: '上機嫌', en: 'HAPPY', accent: '#00f5d4' },
  TEASING: { ja: 'ニヤリ', en: 'TEASING', accent: '#a855f7' },
  SHY: { ja: '照れ', en: 'SHY', accent: '#ff2a85' },
  EXCITED: { ja: 'テンションMAX', en: 'EXCITED', accent: '#f59e0b' },
  THOUGHTFUL: { ja: '思索中', en: 'THOUGHTFUL', accent: '#38bdf8' },
};

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Root shell component rendering the Gemitec Private Lounge experience across Auth,
 * Main Chat Stage, Hamburger Slide-Over Sidebar Drawer, and Rewards Gallery views.
 */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent {
  private readonly hostRef: ElementRef<HTMLElement> = inject(ElementRef);
  private wasSidebarOpen = false;

  public readonly facade = inject(LoungeFacadeService);
  public readonly selectedLightboxReward = signal<LoungeReward | null>(null);

  public readonly personaDisplayName = computed(() => {
    const branding = this.facade.personaBranding();
    return this.facade.lang() === 'en' ? branding.englishName : branding.displayName;
  });

  public readonly currentEmotionMeta = computed(() => {
    const state = this.facade.activeSession()?.currentEmotion ?? 'NEUTRAL';
    return EMOTION_LABELS[state];
  });

  public readonly unlockedRewardsCount = computed(
    () => this.facade.rewards().filter((item) => item.unlocked).length,
  );

  public readonly isQuotaExhausted = computed(() => {
    const sub = this.facade.accountSummary()?.subscription;
    return sub ? sub.remainingChatTurns <= 0 : false;
  });

  constructor() {
    effect(() => {
      const open = this.facade.isSidebarOpen();
      if (open && !this.wasSidebarOpen) {
        queueMicrotask(() => {
          this.focusSelector('#btn-close-sidebar');
        });
      } else if (!open && this.wasSidebarOpen) {
        queueMicrotask(() => {
          this.focusSelector('#btn-hamburger');
        });
      }
      this.wasSidebarOpen = open;
    });
  }

  /** Handles Escape key press to dismiss Lightbox modal or Slide-Over Sidebar Drawer cleanly. */
  @HostListener('document:keydown.escape')
  public onEscapeKey(): void {
    if (this.selectedLightboxReward()) {
      this.closeRewardLightbox();
      return;
    }
    if (this.facade.isSidebarOpen()) {
      this.facade.toggleSidebar(false);
    }
  }

  /** Traps keyboard Tab navigation inside the open Slide-Over Sidebar Drawer. */
  public onDrawerKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab') {
      return;
    }
    const drawer = this.hostRef.nativeElement.querySelector('#lounge-sidebar-drawer');
    if (!(drawer instanceof HTMLElement)) {
      return;
    }
    const focusables = Array.from(drawer.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
      (node): node is HTMLElement => node instanceof HTMLElement,
    );
    if (focusables.length === 0) {
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const activeEl = document.activeElement;
    if (event.shiftKey && activeEl === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && activeEl === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /** Tracks scroll position inside the Sign-Up disclaimer box to unlock agreement at bottom. */
  public onDisclaimerScroll(event: Event): void {
    const element = event.target as HTMLElement | null;
    if (!element) {
      return;
    }
    this.facade.updateDisclaimerScroll(
      element.scrollTop,
      element.clientHeight,
      element.scrollHeight,
    );
  }

  /** Updates the Sign-Up agreement checkbox state after verifying scroll completion. */
  public onConsentCheckboxChange(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    this.facade.setDisclaimerChecked(Boolean(input?.checked));
  }

  /** Sends the current composer draft when the chat form submits and quota permits. */
  public async onSubmitMessage(event: Event): Promise<void> {
    event.preventDefault();
    if (this.isQuotaExhausted()) {
      return;
    }
    await this.facade.sendMessage(this.facade.composerDraft());
  }

  /** Opens the full-resolution Lightbox viewer for an unlocked reward illustration. */
  public openRewardLightbox(item: LoungeReward): void {
    if (!item.unlocked || !item.previewAssetPath) {
      return;
    }
    this.selectedLightboxReward.set(item);
    queueMicrotask(() => {
      this.focusSelector('#btn-close-lightbox');
    });
  }

  private focusSelector(selector: string): void {
    const el = this.hostRef.nativeElement.querySelector(selector);
    if (el instanceof HTMLElement) {
      el.focus();
    }
  }

  /** Closes the Lightbox modal cleanly. */
  public closeRewardLightbox(): void {
    this.selectedLightboxReward.set(null);
  }

  /** Resolves localized emotion label based on active language toggle. */
  public getEmotionLabel(emotion: LoungeEmotionState): string {
    const entry = EMOTION_LABELS[emotion];
    return this.facade.lang() === 'en' ? entry.en : `${entry.en} // ${entry.ja}`;
  }
}
