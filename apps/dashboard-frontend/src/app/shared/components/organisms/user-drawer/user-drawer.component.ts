import { Component, ElementRef, Input, OnChanges, ViewChild, inject, signal, effect } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { DrawerService } from '../../../../core/services/drawer.service';
import { ToastService } from '../../../services/toast.service';
import { TranslationService } from '../../../../core/services/translation.service';
import { USERS_REPOSITORY } from '../../../../core/ports/users.repository';
import { ChatMessage, UserDetail, UserStatus } from '@rebecca/types';
import { TzDatePipe } from '../../../pipes/tz-date.pipe';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { CopilotContextService } from '../../../../core/services/copilot-context.service';

/**
 * Component representing the User Drawer organism.
 * 
 * Provides a detailed view for a single user, displaying their status,
 * statistics, and core profile. Allows administrators to view/edit profile
 * tags and block/unblock the user.
 */
@Component({
  selector: 'app-user-drawer',
  standalone: true,
  imports: [FormsModule, TzDatePipe, TranslatePipe],
  templateUrl: './user-drawer.component.html',
  styleUrls: ['./user-drawer.component.css']
})
export class UserDrawerComponent implements OnChanges {
  /** Injected service to control drawer state and visibility. */
  drawerService = inject(DrawerService);
  
  /** Injected service for displaying toast notifications. */
  toastService = inject(ToastService);
  private readonly translationService = inject(TranslationService);

  /** Injected context service for AI copilot context tracking. */
  contextService = inject(CopilotContextService);
  
  /** The ID of the user to display details for. */
  @Input() userId: string | null = null;

  /** The detailed information of the loaded user. */
  readonly user = signal<UserDetail | undefined>(undefined);

  /** The parsed core profile of the user, organized by category. */
  readonly parsedProfile = signal<Record<string, string[]>>({
    attributes: [],
    preferences: [],
    concerns: [],
    important_memories: []
  });

  /** Indicates if a block/unblock action is currently in progress. */
  readonly isActionLoading = signal<boolean>(false);
  
  /** Indicates if the currently loaded user is blocked. */
  readonly isBlocked = signal<boolean>(false);
  
  /** Indicates if a profile save operation is currently in progress. */
  readonly isSavingProfile = signal<boolean>(false);

  /** Active tab inside the user drawer (`profile` or `conversations`). */
  readonly activeTab = signal<'profile' | 'conversations'>('profile');

  /** Loaded paginated conversation messages. */
  readonly conversations = signal<ChatMessage[]>([]);
  readonly conversationsPage = signal<number>(1);
  readonly conversationsTotalPages = signal<number>(1);
  readonly conversationsTotalItems = signal<number>(0);
  readonly conversationsSortOrder = signal<'desc' | 'asc'>('desc');
  readonly isLoadingConversations = signal<boolean>(false);
  readonly isLoadingMoreConversations = signal<boolean>(false);
  readonly conversationsLoaded = signal<boolean>(false);
  readonly showJumpToLatest = signal<boolean>(false);

  @ViewChild('chatHistoryContainer') chatHistoryContainer?: ElementRef<HTMLDivElement>;

  private readonly usersRepo = inject(USERS_REPOSITORY);

  constructor() {
    // Reactively sync blocked state if user status changes via Copilot HITL action execution
    effect(() => {
      const focused = this.contextService.focusedEntity();
      const currentUser = this.user();
      if (focused && focused.type === 'user' && currentUser) {
        const isSameUser = focused.id === currentUser.id ||
          focused.id === this.userId ||
          focused.label.replace(/^@/, '').toLowerCase() === (currentUser.username || '').toLowerCase();

        if (isSameUser) {
          const newStatus = focused.details?.['status'] as UserStatus | undefined;
          if (newStatus === UserStatus.BLOCKED || newStatus === UserStatus.ACTIVE) {
            const isNowBlocked = newStatus === UserStatus.BLOCKED;
            if (this.isBlocked() !== isNowBlocked) {
              this.isBlocked.set(isNowBlocked);
              this.user.set({ ...currentUser, status: newStatus });
            }
          }
        }
      }
    });
  }

  /**
   * Lifecycle hook that is called when any data-bound property of a directive changes.
   * Triggers the loading of user details if a new `userId` is provided.
   */
  ngOnChanges() {
    if (!this.userId) return;
    this.activeTab.set('profile');
    this.conversations.set([]);
    this.conversationsLoaded.set(false);
    this.conversationsPage.set(1);
    this.conversationsTotalPages.set(1);
    this.conversationsTotalItems.set(0);
    this.showJumpToLatest.set(false);

    this.usersRepo.getById(this.userId).subscribe({
      next: (u) => {
        this.user.set(u);
        this.isBlocked.set(u.status === UserStatus.BLOCKED);
        this.contextService.setFocusedEntity({
          type: 'user',
          id: u.id,
          label: u.username ? `@${u.username}` : (u.name || u.id),
          details: { interactions: u.interactions, status: u.status, firstSeen: u.firstSeen, lastSeen: u.lastSeen }
        });
        try {
          const parsed = JSON.parse(u.coreProfile) as Record<string, string[]>;
          ['attributes', 'preferences', 'concerns', 'important_memories'].forEach(key => {
            if (!parsed[key]) parsed[key] = [];
          });
          this.parsedProfile.set(parsed);
        } catch (error) {
          console.error('Failed to parse coreProfile JSON', error);
          this.parsedProfile.set({ attributes: [], preferences: [], concerns: [], important_memories: [] });
        }
      },
      error: (err) => {
        console.error('Failed to fetch user details:', err);
      }
    });
  }

  /**
   * Switches between Profile and Conversations tabs, lazy-loading conversations on first open.
   */
  setTab(tab: 'profile' | 'conversations'): void {
    this.activeTab.set(tab);
    if (tab === 'conversations') {
      if (!this.conversationsLoaded() && this.userId) {
        this.loadConversations(1, false);
      } else if (this.conversationsSortOrder() === 'desc') {
        setTimeout(() => this.scrollToBottom(), 0);
      }
    }
  }

  /**
   * Toggles conversation sort order between newest-first (`desc`) and oldest-first (`asc`).
   */
  toggleSortOrder(): void {
    const nextOrder = this.conversationsSortOrder() === 'desc' ? 'asc' : 'desc';
    this.conversationsSortOrder.set(nextOrder);
    this.conversations.set([]);
    this.showJumpToLatest.set(false);
    this.loadConversations(1, false);
  }

  /**
   * Loads a page of conversation history and anchors scroll position to avoid layout jumps.
   */
  loadConversations(page: number, isLoadMore: boolean): void {
    if (!this.userId) return;
    if (isLoadMore) {
      this.isLoadingMoreConversations.set(true);
    } else {
      this.isLoadingConversations.set(true);
    }

    const sortOrder = this.conversationsSortOrder();
    const container = this.chatHistoryContainer?.nativeElement;
    const prevScrollHeight = container ? container.scrollHeight : 0;
    const prevScrollTop = container ? container.scrollTop : 0;

    this.usersRepo.getConversations(this.userId, { page, limit: 20, sortOrder }).subscribe({
      next: (res) => {
        this.conversationsPage.set(res.meta.currentPage);
        this.conversationsTotalPages.set(res.meta.totalPages);
        this.conversationsTotalItems.set(res.meta.totalItems);
        this.conversationsLoaded.set(true);

        if (isLoadMore) {
          if (sortOrder === 'desc') {
            this.conversations.update((prev) => [...res.data, ...prev]);
            setTimeout(() => {
              const el = this.chatHistoryContainer?.nativeElement;
              if (el) {
                el.scrollTop = prevScrollTop + (el.scrollHeight - prevScrollHeight);
              }
            }, 0);
          } else {
            this.conversations.update((prev) => [...prev, ...res.data]);
          }
        } else {
          this.conversations.set(res.data);
          setTimeout(() => {
            if (sortOrder === 'desc') {
              this.scrollToBottom();
            } else if (this.chatHistoryContainer?.nativeElement) {
              this.chatHistoryContainer.nativeElement.scrollTop = 0;
            }
          }, 0);
        }

        this.isLoadingConversations.set(false);
        this.isLoadingMoreConversations.set(false);
      },
      error: (err) => {
        console.error('Failed to fetch user conversations:', err);
        this.isLoadingConversations.set(false);
        this.isLoadingMoreConversations.set(false);
      }
    });
  }

  /**
   * Handles scroll events inside the conversations container to trigger next-page loading
   * and toggle the floating "Jump to latest" button.
   */
  onChatScroll(event: Event): void {
    const el = event.target as HTMLElement;
    const sortOrder = this.conversationsSortOrder();

    if (sortOrder === 'desc') {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      this.showJumpToLatest.set(distanceFromBottom > 80);
    } else {
      this.showJumpToLatest.set(false);
    }

    if (
      this.isLoadingConversations() ||
      this.isLoadingMoreConversations() ||
      this.conversationsPage() >= this.conversationsTotalPages()
    ) {
      return;
    }

    if (sortOrder === 'desc' && el.scrollTop <= 40) {
      this.loadConversations(this.conversationsPage() + 1, true);
    } else if (sortOrder === 'asc' && el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
      this.loadConversations(this.conversationsPage() + 1, true);
    }
  }

  /**
   * Jumps back to the latest conversation messages.
   */
  jumpToLatest(): void {
    if (this.conversationsSortOrder() === 'asc') {
      this.conversationsSortOrder.set('desc');
      this.conversations.set([]);
      this.loadConversations(1, false);
      return;
    }
    this.scrollToBottom();
    this.showJumpToLatest.set(false);
  }

  private scrollToBottom(): void {
    const el = this.chatHistoryContainer?.nativeElement;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }

  /**
   * Removes a tag from a specific profile category.
   * 
   * @param category - The category to remove the tag from (e.g., 'attributes').
   * @param index - The index of the tag to remove within the category array.
   */
  removeTag(category: string, index: number) {
    const current = { ...this.parsedProfile() };
    if (current[category]) {
      current[category] = current[category].filter((_, i) => i !== index);
      this.parsedProfile.set(current);
    }
  }

  /**
   * Adds a new tag to a specific profile category.
   * 
   * @param category - The category to add the tag to.
   * @param event - The keyboard event or focus out event triggering the addition.
   */
  addTag(category: string, event: Event) {
    const input = event.target as HTMLInputElement;
    const value = input.value.trim();
    if (value) {
      const current = { ...this.parsedProfile() };
      if (!current[category]) current[category] = [];
      current[category] = [...current[category], value];
      this.parsedProfile.set(current);
      input.value = '';
    }
  }

  /**
   * Saves the modified core profile of the user to the repository.
   */
  onSaveProfile() {
    if (!this.userId) return;
    const u = this.user();
    if (!u) return;
    this.isSavingProfile.set(true);
    const updatedProfile = JSON.stringify(this.parsedProfile(), null, 2);
    this.usersRepo.updateMemory(this.userId, updatedProfile).subscribe({
      next: () => {
        this.user.set({ ...u, coreProfile: updatedProfile });
        this.toastService.show(
          this.translationService.t('toast.user_profile_save_success', { id: this.userId ?? '' }),
          'success',
        );
        this.isSavingProfile.set(false);
      },
      error: (err) => {
        console.error('Failed to save core profile:', err);
        this.toastService.show(this.translationService.t('toast.user_profile_save_failed'), 'error');
        this.isSavingProfile.set(false);
      }
    });
  }

  /**
   * Toggles the blocked status of the currently loaded user.
   * Persists the change to the repository.
   */
  onBlockUser() {
    if (!this.userId) return;
    const u = this.user();
    if (!u) return;
    const targetStatus = this.isBlocked() ? UserStatus.ACTIVE : UserStatus.BLOCKED;
    this.isActionLoading.set(true);
    const targetId = u.id || this.userId;
    this.usersRepo.bulkUpdateStatus([targetId], targetStatus).subscribe({
      next: () => {
        this.isBlocked.set(targetStatus === UserStatus.BLOCKED);
        this.user.set({ ...u, status: targetStatus });
        this.contextService.setFocusedEntity({
          type: 'user',
          id: u.id,
          label: u.username ? `@${u.username}` : (u.name || u.id),
          details: { interactions: u.interactions, status: targetStatus, firstSeen: u.firstSeen, lastSeen: u.lastSeen }
        });
        this.isActionLoading.set(false);
        const toastKey =
          targetStatus === UserStatus.BLOCKED
            ? 'toast.user_blocked_success'
            : 'toast.user_unblocked_success';
        this.toastService.show(this.translationService.t(toastKey, { id: targetId }), 'success');
      },
      error: (err) => {
        console.error('Failed to update user status:', err);
        this.toastService.show(this.translationService.t('toast.user_status_update_failed'), 'error');
        this.isActionLoading.set(false);
      }
    });
  }

  /**
   * Opens the user's profile page on X (Twitter) in a new tab.
   */
  onViewOnX(): void {
    const u = this.user();
    if (!u) return;
    const username = (u.username || u.id).replace(/^@/, '').trim();
    if (!username) return;
    const url = `https://x.com/${encodeURIComponent(username)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
