import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RightDrawerComponent } from './right-drawer.component';
import { DrawerService } from '../../../../core/services/drawer.service';
import { SettingsService } from '../../../../core/services/settings.service';

describe('RightDrawerComponent', () => {
  let component: RightDrawerComponent;
  let fixture: ComponentFixture<RightDrawerComponent>;
  let drawerService: DrawerService;
  const selectedLang = signal<'ja' | 'en'>('ja');

  beforeEach(async () => {
    selectedLang.set('ja');
    await TestBed.configureTestingModule({
      imports: [RightDrawerComponent],
      providers: [
        DrawerService,
        { provide: SettingsService, useValue: { selectedLang } }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(RightDrawerComponent);
    component = fixture.componentInstance;
    drawerService = TestBed.inject(DrawerService);
    fixture.detectChanges();
  });

  it('should create right drawer component', () => {
    expect(component).toBeTruthy();
  });

  it('should emit closeDrawer on close()', () => {
    spyOn(component.closeDrawer, 'emit');
    component.close();
    expect(component.closeDrawer.emit).toHaveBeenCalled();
  });

  it('should open AI copilot on openAiCopilot()', () => {
    spyOn(drawerService, 'open');
    component.openAiCopilot();
    expect(drawerService.open).toHaveBeenCalled();
  });

  it('should render localized Analyze button label in JA and EN', () => {
    selectedLang.set('ja');
    fixture.detectChanges();
    const btn: HTMLElement = fixture.nativeElement.querySelector('.sparkle-btn');
    expect(btn.textContent).toContain('AI分析');

    selectedLang.set('en');
    fixture.detectChanges();
    expect(btn.textContent).toContain('Analyze');
  });
});
