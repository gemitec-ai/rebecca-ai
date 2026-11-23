import { Component, computed, input, output } from '@angular/core';

/**
 * Strongly typed render token for numbered pagination strips, keeping ellipsis keys unique
 * so Angular `@for (...; track item.key)` never collides when two ellipses appear.
 */
export type LoungePaginationToken =
  | { readonly key: string; readonly kind: 'page'; readonly page: number }
  | { readonly key: string; readonly kind: 'ellipsis' };

/**
 * Reusable numbered pagination bar mirroring Dashboard's Assets `PaginationComponent`
 * inside the cyber-noir Gemitec Private Lounge theme, with 44px touch targets on mobile.
 */
@Component({
  selector: 'app-lounge-pagination',
  standalone: true,
  templateUrl: './lounge-pagination.component.html',
  styleUrl: './lounge-pagination.component.css',
})
export class LoungePaginationComponent {
  /** 1-based currently active page index. */
  public readonly currentPage = input.required<number>();
  /** Total available pages (`>= 1`). */
  public readonly totalPages = input.required<number>();
  /** Total collection item count across all pages. */
  public readonly totalItems = input<number>(0);
  /** Fixed page capacity per page (defaults to `12`). */
  public readonly pageSize = input<number>(12);
  /** Disables page navigation controls while an asynchronous fetch is in flight. */
  public readonly loading = input<boolean>(false);

  /** Localized label for item summary range prefix. */
  public readonly showingLabel = input<string>('Showing');
  /** Localized label for current page indicator (`Page`). */
  public readonly pageLabel = input<string>('Page');
  /** Localized plural unit suffix (`items` / `枚`). */
  public readonly itemsUnit = input<string>('items');
  /** Accessible ARIA label for Previous page button. */
  public readonly prevAriaLabel = input<string>('Previous page');
  /** Accessible ARIA label for Next page button. */
  public readonly nextAriaLabel = input<string>('Next page');

  /** Emits the target 1-based page number when the user selects another page. */
  public readonly pageChange = output<number>();

  /** Inclusive 1-based start index of the current page's visible slice. */
  public readonly rangeStart = computed(() => {
    const total = this.totalItems();
    if (total <= 0) {
      return 0;
    }
    const safePage = Math.max(1, Math.trunc(this.currentPage()));
    const safeSize = Math.max(1, Math.trunc(this.pageSize()));
    return Math.min(total, (safePage - 1) * safeSize + 1);
  });

  /** Inclusive 1-based end index of the current page's visible slice. */
  public readonly rangeEnd = computed(() => {
    const total = this.totalItems();
    if (total <= 0) {
      return 0;
    }
    const safePage = Math.max(1, Math.trunc(this.currentPage()));
    const safeSize = Math.max(1, Math.trunc(this.pageSize()));
    return Math.min(total, safePage * safeSize);
  });

  /** Ordered page numbers and smart ellipsis tokens following Dashboard windowing rules. */
  public readonly paginationTokens = computed<readonly LoungePaginationToken[]>(() => {
    const total = Math.max(1, this.totalPages());
    const current = Math.min(Math.max(1, this.currentPage()), total);
    const tokens: LoungePaginationToken[] = [];

    const pushPage = (page: number): void => {
      tokens.push({ key: `page-${page}`, kind: 'page', page });
    };

    if (total <= 5) {
      for (let page = 1; page <= total; page++) {
        pushPage(page);
      }
      return tokens;
    }

    if (current <= 3) {
      for (let page = 1; page <= 4; page++) {
        pushPage(page);
      }
      tokens.push({ key: 'ellipsis-right', kind: 'ellipsis' });
      pushPage(total);
      return tokens;
    }

    if (current >= total - 2) {
      pushPage(1);
      tokens.push({ key: 'ellipsis-left', kind: 'ellipsis' });
      for (let page = total - 3; page <= total; page++) {
        pushPage(page);
      }
      return tokens;
    }

    pushPage(1);
    tokens.push({ key: 'ellipsis-left', kind: 'ellipsis' });
    pushPage(current - 1);
    pushPage(current);
    pushPage(current + 1);
    tokens.push({ key: 'ellipsis-right', kind: 'ellipsis' });
    pushPage(total);
    return tokens;
  });

  /** Handles Prev/Next and numbered pill clicks, suppressing out-of-range or redundant emits. */
  public selectPage(targetPage: number): void {
    const clamped = Math.trunc(targetPage);
    if (
      this.loading() ||
      clamped < 1 ||
      clamped > Math.max(1, this.totalPages()) ||
      clamped === this.currentPage()
    ) {
      return;
    }
    this.pageChange.emit(clamped);
  }
}
