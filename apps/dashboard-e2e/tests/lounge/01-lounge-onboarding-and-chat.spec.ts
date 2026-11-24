import { expect, test } from '@playwright/test';

test.describe('Private Lounge CUJ 01: Scroll-Gated Onboarding, Persistent Chat, Gallery & Options', () => {
  test('registers via X emulator, completes onboarding with 25 initial turns, chats, toggles analytics, and persists across reload', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const uniqueXId = `e2e_chat_${Date.now()}`;

    await page.goto(`/?emuXUser=${uniqueXId}`);
    await expect(page.locator('#btn-x-login')).toBeVisible({ timeout: 15000 });

    // Switch to Sign-Up and verify scroll gate keeps consent & X Sign-Up locked initially
    await page.locator('#btn-switch-to-signup').click();
    const consentCheckbox = page.locator('#checkbox-disclaimer-consent');
    const signUpBtn = page.locator('#btn-x-signup');
    await expect(consentCheckbox).toBeDisabled();
    await expect(signUpBtn).toBeDisabled();

    // Scroll disclaimer to the bottom and unlock consent + X registration
    await page.locator('#disclaimer-scroll-box').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event('scroll'));
    });
    await expect(consentCheckbox).toBeEnabled();
    await consentCheckbox.check();
    await expect(signUpBtn).toBeEnabled();
    await signUpBtn.click();

    // Confirm Language & Timezone onboarding screen -> enter Chat
    await expect(page.locator('#onboarding-preferences-card')).toBeVisible({ timeout: 20000 });
    await page.screenshot({ path: 'screenshots/lounge_01_onboarding.png' });
    await page.locator('#btn-start-lounge').click();

    // Verify 5 daily + 20 welcome bonus = 25 initial turns
    await expect(page.locator('#chat-message-stream')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#topbar-turns-value')).toHaveText(/25\s*\/\s*5/);

    // Send a real turn against BFF + Firestore Emulator -> assistant reply & quota decrement to 24 / 5
    await page.locator('#chat-composer-input').fill('E2E hello Rebecca! Tell me about tonight.');
    await page.locator('#btn-send-message').click();
    await expect(page.locator('#chat-message-stream')).toContainText('E2E hello Rebecca!', {
      timeout: 20000,
    });
    await expect(page.locator('#topbar-turns-value')).toHaveText(/24\s*\/\s*5/, { timeout: 15000 });
    await page.screenshot({ path: 'screenshots/lounge_02_chat_turn.png' });

    // Visit Gallery and Options via Hamburger Drawer
    await page.locator('#btn-hamburger').click();
    await page.locator('#nav-btn-gallery').click();
    await expect(page.locator('#gallery-view')).toBeVisible({ timeout: 10000 });

    await page.locator('#btn-hamburger').click();
    await page.locator('#nav-btn-options').click();
    await expect(page.locator('#options-view')).toBeVisible({ timeout: 10000 });

    // Toggle analytics opt-out and verify reload persistence
    const analyticsCheckbox = page.locator('#chk-analytics-optin');
    await expect(analyticsCheckbox).toBeChecked();
    await analyticsCheckbox.uncheck();
    await expect(page.locator('#options-saved-banner')).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: 'screenshots/lounge_03_options_saved.png' });

    await page.reload();
    await expect(page.locator('#chat-message-stream')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#topbar-turns-value')).toHaveText(/24\s*\/\s*5/);

    await page.locator('#btn-hamburger').click();
    await page.locator('#nav-btn-options').click();
    await expect(page.locator('#chk-analytics-optin')).not.toBeChecked({ timeout: 10000 });
  });
});
