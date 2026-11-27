import { Injectable, inject, signal } from '@angular/core';
import type { LoungeGalleryItem, LoungeGalleryListResponseDto } from '@rebecca/types';
import { LoungeGalleryPort } from '../ports/lounge-gallery.port';
import { LoungeAccountOptionsStore } from './lounge-account-options.store';
import { LoungeShellStore } from './lounge-shell.store';

/** Fixed page size for numbered Gallery collection pagination (12 slots/page). */
export const LOUNGE_GALLERY_PAGE_SIZE = 12;

/**
 * Feature store managing unlocked artwork Gallery pagination, counts, and live unlock notifications.
 */
@Injectable({ providedIn: 'root' })
export class LoungeGalleryStore {
  private readonly galleryPort = inject(LoungeGalleryPort);
  private readonly shell = inject(LoungeShellStore);
  private readonly accountStore = inject(LoungeAccountOptionsStore);

  private readonly unlockedGalleryItemIds = new Set<string>();
  private galleryNeedsRefresh = false;

  public readonly galleryItems = signal<readonly LoungeGalleryItem[]>([]);
  public readonly isLoadingGalleryPage = signal<boolean>(false);
  public readonly galleryCurrentPage = signal<number>(1);
  public readonly galleryTotalPages = signal<number>(1);
  public readonly galleryTotalItems = signal<number>(0);
  public readonly galleryCatalogTotalCount = signal<number>(0);
  public readonly galleryUnlockedCount = signal<number>(0);
  public readonly newlyUnlockedGalleryItem = signal<LoungeGalleryItem | null>(null);
  public readonly newlyUnlockedAssetIds = signal<readonly string[]>([]);

  /** Applies initial Gallery page metadata loaded during Lounge session hydration. */
  public hydrateInitialGallery(
    galleryPage: LoungeGalleryListResponseDto,
    catalogTotal: number,
  ): void {
    this.unlockedGalleryItemIds.clear();
    for (const item of galleryPage.data) {
      if (item.unlocked) {
        this.unlockedGalleryItemIds.add(item.id);
        this.unlockedGalleryItemIds.add(item.assetId);
      }
    }
    this.galleryItems.set(galleryPage.data);
    this.galleryCurrentPage.set(galleryPage.meta.currentPage);
    this.galleryTotalPages.set(galleryPage.meta.totalPages);
    this.galleryTotalItems.set(galleryPage.meta.totalItems);
    this.galleryCatalogTotalCount.set(catalogTotal);
    this.galleryUnlockedCount.set(galleryPage.summary.unlockedCount);
    this.galleryNeedsRefresh = false;
  }

  /** Clears stale unlock notifications and triggers a page-1 refresh if out-of-page unlocks occurred. */
  public onEnterGallery(hasActiveSession: boolean): void {
    this.newlyUnlockedGalleryItem.set(null);
    if (this.galleryNeedsRefresh) {
      void this.loadGalleryPage(1, hasActiveSession);
    }
  }

  /** Loads a specific 1-based Gallery page via the unified bounded pagination contract. */
  public async loadGalleryPage(page: number, hasActiveSession: boolean): Promise<void> {
    if (!Number.isFinite(page)) {
      return;
    }
    const targetPage = Math.max(1, Math.trunc(page));
    if (this.isLoadingGalleryPage() || !hasActiveSession) {
      return;
    }
    this.isLoadingGalleryPage.set(true);
    this.shell.errorMessage.set(null);
    try {
      const res = await this.galleryPort.listGallery({
        page: targetPage,
        limit: LOUNGE_GALLERY_PAGE_SIZE,
      });
      if (res.summary.unlockedCount === 0) {
        this.unlockedGalleryItemIds.clear();
      }
      for (const item of res.data) {
        if (item.unlocked) {
          this.unlockedGalleryItemIds.add(item.id);
          this.unlockedGalleryItemIds.add(item.assetId);
        }
      }
      this.galleryItems.set(res.data);
      this.galleryCurrentPage.set(res.meta.currentPage);
      this.galleryTotalPages.set(res.meta.totalPages);
      this.galleryTotalItems.set(res.meta.totalItems);
      this.galleryUnlockedCount.set(res.summary.unlockedCount);
      this.galleryCatalogTotalCount.set(res.summary.totalCount);
      this.galleryNeedsRefresh = false;
      this.accountStore.syncGalleryTotals(res.summary.unlockedCount, res.summary.totalCount);
    } catch (err) {
      this.shell.errorMessage.set(this.shell.mapUiError(err, 'errorGeneric'));
    } finally {
      this.isLoadingGalleryPage.set(false);
    }
  }

  /** Reconciles an artwork unlocked during a Chat turn into the Gallery collection state. */
  public applyUnlockedItem(unlocked: LoungeGalleryItem | undefined): {
    readonly nextUnlockedCount: number;
    readonly nextCatalogTotal: number;
  } {
    let nextUnlockedCount = this.galleryUnlockedCount();
    let nextTotalItems = this.galleryTotalItems();
    let nextCatalogTotal = this.galleryCatalogTotalCount();

    if (!unlocked) {
      return { nextUnlockedCount, nextCatalogTotal };
    }

    const alreadyUnlocked =
      this.unlockedGalleryItemIds.has(unlocked.assetId) ||
      this.unlockedGalleryItemIds.has(unlocked.id) ||
      this.newlyUnlockedAssetIds().includes(unlocked.assetId) ||
      this.galleryItems().some(
        (item) => (item.id === unlocked.id || item.assetId === unlocked.assetId) && item.unlocked,
      );
    let updatedInPlace = false;
    let insertedOnPage1 = false;
    this.galleryItems.update((items) => {
      const exists = items.some(
        (item) => item.id === unlocked.id || item.assetId === unlocked.assetId,
      );
      if (exists) {
        updatedInPlace = true;
        return items.map((item) =>
          item.id === unlocked.id || item.assetId === unlocked.assetId ? unlocked : item,
        );
      }
      if (this.galleryCurrentPage() === 1 && this.galleryTotalItems() < LOUNGE_GALLERY_PAGE_SIZE) {
        insertedOnPage1 = true;
        return [unlocked, ...items];
      }
      return items;
    });

    if (insertedOnPage1) {
      nextTotalItems += 1;
      this.galleryTotalItems.set(nextTotalItems);
      this.galleryTotalPages.set(Math.max(1, Math.ceil(nextTotalItems / LOUNGE_GALLERY_PAGE_SIZE)));
    } else if (!updatedInPlace) {
      this.galleryNeedsRefresh = true;
    }

    if (unlocked.unlocked) {
      this.unlockedGalleryItemIds.add(unlocked.id);
      this.unlockedGalleryItemIds.add(unlocked.assetId);
    }
    if (!alreadyUnlocked && unlocked.unlocked) {
      nextUnlockedCount += 1;
      this.galleryUnlockedCount.set(nextUnlockedCount);
      nextCatalogTotal = Math.max(nextCatalogTotal, nextUnlockedCount);
      this.galleryCatalogTotalCount.set(nextCatalogTotal);
      this.newlyUnlockedGalleryItem.set(unlocked);
      this.newlyUnlockedAssetIds.update((ids) =>
        ids.includes(unlocked.assetId) ? ids : [...ids, unlocked.assetId],
      );
    }

    return { nextUnlockedCount, nextCatalogTotal };
  }

  /** Dismisses the celebratory New Gallery Unlock toast notification cleanly. */
  public dismissUnlockedGalleryNotice(): void {
    this.newlyUnlockedGalleryItem.set(null);
  }

  /** Returns whether the given Bot asset ID was unlocked during the active session turn. */
  public isNewlyUnlockedAsset(assetId?: string): boolean {
    return Boolean(assetId && this.newlyUnlockedAssetIds().includes(assetId));
  }

  /** Clears all Gallery pagination and newly-unlocked state on logout or deletion. */
  public reset(): void {
    this.galleryItems.set([]);
    this.isLoadingGalleryPage.set(false);
    this.galleryCurrentPage.set(1);
    this.galleryTotalPages.set(1);
    this.galleryTotalItems.set(0);
    this.galleryCatalogTotalCount.set(0);
    this.galleryUnlockedCount.set(0);
    this.newlyUnlockedGalleryItem.set(null);
    this.newlyUnlockedAssetIds.set([]);
    this.unlockedGalleryItemIds.clear();
    this.galleryNeedsRefresh = false;
  }
}
