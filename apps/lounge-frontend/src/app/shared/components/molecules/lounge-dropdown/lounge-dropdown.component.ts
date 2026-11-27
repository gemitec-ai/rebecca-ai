import {
  Component,
  ElementRef,
  HostListener,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { LoungeSelectOption } from '../../../../core/services/lounge-translations';

/**
 * Custom accessible glassmorphic dropdown selector conforming to `docs/ui-design-guide.md`
 * (replaces native `<select>` elements across the Private Lounge).
 */
@Component({
  selector: 'app-lounge-dropdown',
  templateUrl: './lounge-dropdown.component.html',
  styleUrl: './lounge-dropdown.component.css',
})
export class LoungeDropdownComponent {
  private static nextInstanceId = 0;

  private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly options = input<readonly LoungeSelectOption[]>([]);
  readonly selectedValue = input<string>('');
  readonly ariaLabel = input<string>('Select option');
  readonly leadingIcon = input<string>('');
  readonly compact = input<boolean>(false);
  readonly disabled = input<boolean>(false);
  readonly align = input<'left' | 'right'>('left');

  readonly valueChange = output<string>();

  readonly triggerButton = viewChild<ElementRef<HTMLButtonElement>>('triggerButton');
  readonly listboxEl = viewChild<ElementRef<HTMLUListElement>>('listboxEl');

  readonly listboxId = `lounge-dropdown-list-${++LoungeDropdownComponent.nextInstanceId}`;
  readonly isOpen = signal(false);
  readonly activeIndex = signal(-1);

  readonly selectedOption = computed<LoungeSelectOption | null>(() => {
    const opts = this.options();
    const val = this.selectedValue();
    if (!val || opts.length === 0) {
      return null;
    }
    return opts.find((opt) => opt.value === val) ?? null;
  });

  readonly activeDescendantId = computed<string | null>(() => {
    const idx = this.activeIndex();
    if (!this.isOpen() || idx < 0 || idx >= this.options().length) {
      return null;
    }
    return `${this.listboxId}-opt-${idx}`;
  });

  /** Closes the listbox when clicking outside the component boundary. */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: Event): void {
    if (!this.isOpen()) {
      return;
    }
    const target = event.target;
    if (target instanceof Node && !this.elementRef.nativeElement.contains(target)) {
      this.isOpen.set(false);
      this.activeIndex.set(-1);
    }
  }

  /** Toggles the dropdown menu open or closed. */
  toggleOpen(): void {
    if (this.disabled() || this.options().length === 0) {
      return;
    }
    if (this.isOpen()) {
      this.closeMenu(false);
      return;
    }
    this.openMenu(this.findSelectedIndex());
  }

  /** Selects an option, emits the new value, and closes the listbox. */
  selectOption(value: string): void {
    if (this.disabled()) {
      return;
    }
    if (value !== this.selectedValue()) {
      this.valueChange.emit(value);
    }
    this.closeMenu(true);
  }

  /** Handles keyboard navigation and selection on the combobox trigger. */
  onTriggerKeydown(event: KeyboardEvent): void {
    if (this.disabled() || this.options().length === 0) {
      return;
    }

    const opts = this.options();
    const currentlyOpen = this.isOpen();

    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        if (!currentlyOpen) {
          this.openMenu(this.findSelectedIndex());
          return;
        }
        this.moveActiveIndex((this.activeIndex() + 1) % opts.length);
        return;
      }
      case 'ArrowUp': {
        event.preventDefault();
        if (!currentlyOpen) {
          this.openMenu(opts.length - 1);
          return;
        }
        this.moveActiveIndex((this.activeIndex() - 1 + opts.length) % opts.length);
        return;
      }
      case 'Home': {
        if (!currentlyOpen) {
          return;
        }
        event.preventDefault();
        this.moveActiveIndex(0);
        return;
      }
      case 'End': {
        if (!currentlyOpen) {
          return;
        }
        event.preventDefault();
        this.moveActiveIndex(opts.length - 1);
        return;
      }
      case 'Enter':
      case ' ': {
        event.preventDefault();
        if (!currentlyOpen) {
          this.openMenu(this.findSelectedIndex());
          return;
        }
        const active = opts[this.activeIndex()];
        if (active) {
          this.selectOption(active.value);
        } else {
          this.closeMenu(true);
        }
        return;
      }
      case 'Escape': {
        if (currentlyOpen) {
          event.preventDefault();
          event.stopPropagation();
          this.closeMenu(true);
        }
        return;
      }
      case 'Tab': {
        if (currentlyOpen) {
          this.closeMenu(false);
        }
        return;
      }
      default:
        return;
    }
  }

  private findSelectedIndex(): number {
    const idx = this.options().findIndex((opt) => opt.value === this.selectedValue());
    return idx >= 0 ? idx : 0;
  }

  private openMenu(initialIndex: number): void {
    const opts = this.options();
    const clampedIndex = Math.max(0, Math.min(initialIndex, opts.length - 1));
    this.isOpen.set(true);
    this.activeIndex.set(clampedIndex);
    this.scrollActiveOptionIntoView(clampedIndex);
  }

  private moveActiveIndex(nextIndex: number): void {
    this.activeIndex.set(nextIndex);
    this.scrollActiveOptionIntoView(nextIndex);
  }

  private closeMenu(restoreFocus: boolean): void {
    this.isOpen.set(false);
    this.activeIndex.set(-1);
    if (restoreFocus) {
      this.triggerButton()?.nativeElement.focus();
    }
  }

  private scrollActiveOptionIntoView(index: number): void {
    queueMicrotask(() => {
      const list = this.listboxEl()?.nativeElement;
      if (!list) {
        return;
      }
      const item = list.querySelector<HTMLElement>(`#${this.listboxId}-opt-${index}`);
      if (item && typeof item.scrollIntoView === 'function') {
        item.scrollIntoView({ block: 'nearest' });
      }
    });
  }
}
