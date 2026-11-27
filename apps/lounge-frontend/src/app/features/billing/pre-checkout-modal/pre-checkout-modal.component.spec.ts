import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { LoungeBillingProductDto } from '@rebecca/types';
import { LoungeAccountPort } from '../../../core/ports/lounge-account.port';
import { LoungeAuthPort } from '../../../core/ports/lounge-auth.port';
import { LoungeBillingPort } from '../../../core/ports/lounge-billing.port';
import { LoungeConfigPort } from '../../../core/ports/lounge-config.port';
import { LoungeGalleryPort } from '../../../core/ports/lounge-gallery.port';
import { LoungeSessionPort } from '../../../core/ports/lounge-session.port';
import { LoungeFacadeService } from '../../../core/services/lounge-facade.service';
import { PreCheckoutModalComponent } from './pre-checkout-modal.component';

describe('PreCheckoutModalComponent', () => {
  let fixture: ComponentFixture<PreCheckoutModalComponent>;
  let facade: LoungeFacadeService;

  const sampleProduct: LoungeBillingProductDto = {
    productId: 'CHARGE_TICKET_100',
    mode: 'payment',
    currency: 'JPY',
    unitAmountMinor: 500,
    formattedPrice: '¥500',
    grantedTurns: 100,
    validityDays: 180,
    taxInclusive: true,
    promotionCodesAllowed: true,
    available: true,
    eligible: true,
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PreCheckoutModalComponent],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: LoungeConfigPort,
          useValue: {
            getRuntimeConfig: jest.fn(async () => ({
              appVersion: 'v1.46.0',
              disclaimerVersion: 1,
              phase2EeaEnabled: false,
              legalUrls: {
                tosUrl: 'https://portal.example.com/tos',
                privacyUrl: 'https://portal.example.com/privacy',
                legalUrl: 'https://portal.example.com/legal',
              },
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
          provide: LoungeBillingPort,
          useValue: {
            getCatalog: jest.fn(),
            createCheckout: jest.fn(async () => ({
              checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_1',
              sessionIdMasked: 'cs_...1',
            })),
            verifyCheckout: jest.fn(),
            createPortal: jest.fn(),
            getSubscriptionDetail: jest.fn(),
            withdrawEu: jest.fn(),
            listOrders: jest.fn(),
            getOrderReceipt: jest.fn(),
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
    jest.spyOn(facade, 'navigateExternalUrl').mockImplementation(() => undefined);
    await facade.ready;

    fixture = TestBed.createComponent(PreCheckoutModalComponent);
    fixture.componentRef.setInput('product', sampleProduct);
    fixture.componentRef.setInput('isEeaResident', false);
    fixture.componentRef.setInput('phase2EeaEnabled', false);
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('renders dynamic Portal legal links from /config and resets dialog returnValue on cancel/close', () => {
    const dialog = (fixture.nativeElement as HTMLElement).querySelector(
      '#precheckout-dialog',
    ) as HTMLDialogElement;
    expect(dialog.hasAttribute('open')).toBe(true);

    const links = Array.from(dialog.querySelectorAll<HTMLAnchorElement>('.legal-links-row a')).map(
      (a) => a.getAttribute('href'),
    );
    expect(links).toEqual([
      'https://portal.example.com/tos',
      'https://portal.example.com/privacy',
      'https://portal.example.com/legal',
    ]);

    facade.openPreCheckoutModal(sampleProduct);
    dialog.returnValue = 'dirty';
    const cancelEvent = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(cancelEvent);
    expect(cancelEvent.defaultPrevented).toBe(true);
    expect(dialog.returnValue).toBe('');
    expect(facade.selectedCheckoutProduct()).toBeNull();
  });

  it('enforces all 3 ASCT checkboxes plus EU waiver when enabled before submitting checkout', async () => {
    facade.openPreCheckoutModal(sampleProduct);
    fixture.componentRef.setInput('isEeaResident', true);
    fixture.componentRef.setInput('phase2EeaEnabled', true);
    await fixture.whenStable();
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const proceedBtn = root.querySelector('#btn-precheckout-proceed') as HTMLButtonElement;
    expect(proceedBtn.disabled).toBe(true);

    const chk1 = root.querySelector('#chk-precheckout-disclosure') as HTMLInputElement;
    const chk2 = root.querySelector('#chk-precheckout-autorenew') as HTMLInputElement;
    const chk3 = root.querySelector('#chk-precheckout-adult') as HTMLInputElement;
    const chkEu = root.querySelector('#chk-precheckout-eu-waiver') as HTMLInputElement;

    chk1.checked = true;
    chk1.dispatchEvent(new Event('change'));
    chk2.checked = true;
    chk2.dispatchEvent(new Event('change'));
    chk3.checked = true;
    chk3.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(proceedBtn.disabled).toBe(true);

    chkEu.checked = true;
    chkEu.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(proceedBtn.disabled).toBe(false);

    proceedBtn.click();
    await fixture.whenStable();
    expect(facade.navigateExternalUrl).toHaveBeenCalledWith(
      'https://checkout.stripe.com/c/pay/cs_1',
    );
  });
});
