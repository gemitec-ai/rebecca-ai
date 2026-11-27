import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { LoungeDropdownComponent } from './lounge-dropdown.component';

describe('LoungeDropdownComponent', () => {
  let fixture: ComponentFixture<LoungeDropdownComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LoungeDropdownComponent],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();

    fixture = TestBed.createComponent(LoungeDropdownComponent);
    fixture.componentRef.setInput('options', [
      { value: 'ja', label: '日本語' },
      { value: 'en', label: 'English' },
      { value: 'de', label: 'Deutsch' },
    ]);
    fixture.componentRef.setInput('selectedValue', 'en');
    fixture.componentRef.setInput('ariaLabel', 'Select language');
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('opens listbox on click, navigates with keyboard keys, emits selection, and closes on outside click', async () => {
    const emitted: string[] = [];
    fixture.componentInstance.valueChange.subscribe((val) => emitted.push(val));

    const trigger = (fixture.nativeElement as HTMLElement).querySelector(
      'button[role="combobox"]',
    ) as HTMLButtonElement;
    expect(trigger.textContent).toContain('English');

    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.componentInstance.isOpen()).toBe(true);
    expect(fixture.componentInstance.activeIndex()).toBe(1);

    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(fixture.componentInstance.activeIndex()).toBe(0);

    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }));
    expect(fixture.componentInstance.activeIndex()).toBe(2);

    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
    expect(fixture.componentInstance.activeIndex()).toBe(0);

    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(emitted).toEqual(['ja']);
    expect(fixture.componentInstance.isOpen()).toBe(false);

    // ArrowUp when closed opens at last item; Escape closes cleanly
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    await fixture.whenStable();
    expect(fixture.componentInstance.isOpen()).toBe(true);
    expect(fixture.componentInstance.activeIndex()).toBe(2);

    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(fixture.componentInstance.isOpen()).toBe(false);

    // Toggle & Tab close & document outside click close
    trigger.click();
    expect(fixture.componentInstance.isOpen()).toBe(true);
    document.body.click();
    expect(fixture.componentInstance.isOpen()).toBe(false);

    trigger.click();
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    expect(fixture.componentInstance.isOpen()).toBe(false);
  });

  it('ignores keyboard/open actions when disabled and returns null for empty or unmatched values', () => {
    fixture.componentRef.setInput('selectedValue', '');
    fixture.detectChanges();
    expect(fixture.componentInstance.selectedOption()).toBeNull();

    fixture.componentRef.setInput('selectedValue', 'unknown_val');
    fixture.detectChanges();
    expect(fixture.componentInstance.selectedOption()).toBeNull();

    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();

    const trigger = (fixture.nativeElement as HTMLElement).querySelector(
      'button[role="combobox"]',
    ) as HTMLButtonElement;
    fixture.componentInstance.toggleOpen();
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(fixture.componentInstance.isOpen()).toBe(false);
  });
});
