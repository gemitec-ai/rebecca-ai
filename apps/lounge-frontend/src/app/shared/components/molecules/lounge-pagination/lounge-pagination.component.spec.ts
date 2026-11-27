import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { LoungePaginationComponent } from './lounge-pagination.component';

describe('LoungePaginationComponent', () => {
  let fixture: ComponentFixture<LoungePaginationComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LoungePaginationComponent],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();

    fixture = TestBed.createComponent(LoungePaginationComponent);
    fixture.componentRef.setInput('currentPage', 1);
    fixture.componentRef.setInput('totalPages', 1);
    fixture.componentRef.setInput('totalItems', 0);
    fixture.componentRef.setInput('pageSize', 12);
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('handles zero items and compact <= 5 page ranges', async () => {
    expect(fixture.componentInstance.rangeStart()).toBe(0);
    expect(fixture.componentInstance.rangeEnd()).toBe(0);

    fixture.componentRef.setInput('totalItems', 36);
    fixture.componentRef.setInput('totalPages', 3);
    fixture.componentRef.setInput('currentPage', 2);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.rangeStart()).toBe(13);
    expect(fixture.componentInstance.rangeEnd()).toBe(24);
    expect(fixture.componentInstance.paginationTokens()).toEqual([
      { key: 'page-1', kind: 'page', page: 1 },
      { key: 'page-2', kind: 'page', page: 2 },
      { key: 'page-3', kind: 'page', page: 3 },
    ]);
  });

  it('renders right, left, and dual ellipses across large page spans and suppresses invalid/loading emissions', async () => {
    const emitted: number[] = [];
    fixture.componentInstance.pageChange.subscribe((page) => emitted.push(page));

    fixture.componentRef.setInput('totalItems', 120);
    fixture.componentRef.setInput('totalPages', 10);

    // Front window (current <= 3) -> right ellipsis
    fixture.componentRef.setInput('currentPage', 2);
    await fixture.whenStable();
    expect(fixture.componentInstance.paginationTokens().map((t) => t.key)).toEqual([
      'page-1',
      'page-2',
      'page-3',
      'page-4',
      'ellipsis-right',
      'page-10',
    ]);

    // Tail window (current >= total - 2) -> left ellipsis
    fixture.componentRef.setInput('currentPage', 9);
    await fixture.whenStable();
    expect(fixture.componentInstance.paginationTokens().map((t) => t.key)).toEqual([
      'page-1',
      'ellipsis-left',
      'page-7',
      'page-8',
      'page-9',
      'page-10',
    ]);

    // Middle window -> dual ellipses
    fixture.componentRef.setInput('currentPage', 5);
    await fixture.whenStable();
    expect(fixture.componentInstance.paginationTokens().map((t) => t.key)).toEqual([
      'page-1',
      'ellipsis-left',
      'page-4',
      'page-5',
      'page-6',
      'ellipsis-right',
      'page-10',
    ]);

    fixture.componentInstance.selectPage(5); // same page
    fixture.componentInstance.selectPage(0); // out of range
    fixture.componentInstance.selectPage(11); // out of range
    fixture.componentInstance.selectPage(6); // valid
    expect(emitted).toEqual([6]);

    fixture.componentRef.setInput('loading', true);
    fixture.componentInstance.selectPage(7);
    expect(emitted).toEqual([6]);
  });
});
