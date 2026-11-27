import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { LoungeAccountPort } from '../../../core/ports/lounge-account.port';
import { LoungeAuthPort } from '../../../core/ports/lounge-auth.port';
import { LoungeConfigPort } from '../../../core/ports/lounge-config.port';
import { LoungeGalleryPort } from '../../../core/ports/lounge-gallery.port';
import { LoungeSessionPort } from '../../../core/ports/lounge-session.port';
import { LoungeFacadeService } from '../../../core/services/lounge-facade.service';
import { LOUNGE_LANGUAGE_OPTIONS } from '../../../core/services/lounge-translations';
import { ReconsentModalComponent } from './reconsent-modal.component';

describe('ReconsentModalComponent (native <dialog> gate)', () => {
  let fixture: ComponentFixture<ReconsentModalComponent>;
  let facade: LoungeFacadeService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ReconsentModalComponent],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: LoungeConfigPort,
          useValue: {
            getRuntimeConfig: jest.fn(async () => ({
              appVersion: 'v1.46.0',
              disclaimerVersion: 2,
              phase2EeaEnabled: false,
              persona: {
                displayName: 'レベッカ',
                englishName: 'Rebecca',
                brandName: 'Rebecca Private Lounge',
                avatarPath: 'assets/persona_cutout.webp',
                chatIconPath: 'assets/avatars/persona_icon.png',
                emotionAvatarPaths: {
                  NEUTRAL: 'assets/avatars/persona_neutral.png',
                  HAPPY: 'assets/avatars/persona_happy.png',
                  TEASING: 'assets/avatars/persona_teasing.png',
                  SHY: 'assets/avatars/persona_shy.png',
                  EXCITED: 'assets/avatars/persona_excited.png',
                  THOUGHTFUL: 'assets/avatars/persona_thoughtful.png',
                  SURPRISED: 'assets/avatars/persona_surprised.png',
                },
              },
            })),
          },
        },
        {
          provide: LoungeAuthPort,
          useValue: {
            getCurrentSession: jest.fn(async () => null),
            loginWithX: jest.fn(),
            signUpWithX: jest.fn(),
            logout: jest.fn(async () => undefined),
          },
        },
        {
          provide: LoungeAccountPort,
          useValue: {
            getAccountSummary: jest.fn(),
            updatePreferences: jest.fn(),
            updateDisclaimerConsent: jest.fn(),
            deleteAccount: jest.fn(),
          },
        },
        {
          provide: LoungeSessionPort,
          useValue: { getSession: jest.fn(), listMessages: jest.fn(), sendMessage: jest.fn() },
        },
        {
          provide: LoungeGalleryPort,
          useValue: { listGallery: jest.fn() },
        },
      ],
    }).compileComponents();

    facade = TestBed.inject(LoungeFacadeService);
    await facade.ready;

    fixture = TestBed.createComponent(ReconsentModalComponent);
    fixture.componentRef.setInput('languageOptions', LOUNGE_LANGUAGE_OPTIONS);
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('opens a native modal <dialog> without redundant ARIA dialog roles and blocks Escape dismissal', async () => {
    const dialog = (fixture.nativeElement as HTMLElement).querySelector(
      '#reconsent-modal',
    ) as HTMLDialogElement;
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialog.getAttribute('role')).toBeNull();
    expect(dialog.getAttribute('aria-modal')).toBeNull();
    expect(dialog.hasAttribute('open')).toBe(true);

    const cancelEvent = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(cancelEvent);
    expect(cancelEvent.defaultPrevented).toBe(true);

    dialog.returnValue = 'stale';
    dialog.dispatchEvent(new Event('close'));
    expect(dialog.returnValue).toBe('');
  });

  it('requires both terms consent and Phase 1 non-EEA checkbox after scrolling to bottom', async () => {
    const box = (fixture.nativeElement as HTMLElement).querySelector(
      '#reconsent-scroll-box',
    ) as HTMLElement;
    const agreeBtn = (fixture.nativeElement as HTMLElement).querySelector(
      '#btn-submit-reconsent',
    ) as HTMLButtonElement;
    const chkTerms = (fixture.nativeElement as HTMLElement).querySelector(
      '#checkbox-reconsent',
    ) as HTMLInputElement;
    const chkNonEea = (fixture.nativeElement as HTMLElement).querySelector(
      '#checkbox-reconsent-non-eea',
    ) as HTMLInputElement;

    expect(agreeBtn.disabled).toBe(true);
    expect(chkTerms.disabled).toBe(true);
    expect(chkNonEea.disabled).toBe(true);

    Object.defineProperty(box, 'scrollHeight', { value: 400, configurable: true });
    Object.defineProperty(box, 'clientHeight', { value: 200, configurable: true });
    box.scrollTop = 200;
    box.dispatchEvent(new Event('scroll'));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(chkTerms.disabled).toBe(false);
    expect(chkNonEea.disabled).toBe(false);

    chkTerms.checked = true;
    chkTerms.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(agreeBtn.disabled).toBe(true);

    chkNonEea.checked = true;
    chkNonEea.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(agreeBtn.disabled).toBe(false);
  });

  it('emits requestDeleteAccount and focuses the delete button on focusDeleteButton()', () => {
    const emitSpy = jest.fn();
    fixture.componentInstance.requestDeleteAccount.subscribe(emitSpy);

    const deleteBtn = (fixture.nativeElement as HTMLElement).querySelector(
      '#btn-reconsent-delete',
    ) as HTMLButtonElement;
    const focusSpy = jest.spyOn(deleteBtn, 'focus');
    deleteBtn.click();
    expect(emitSpy).toHaveBeenCalledTimes(1);

    fixture.componentInstance.focusDeleteButton();
    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        expect(focusSpy).toHaveBeenCalled();
        resolve();
      });
    });
  });
});
