import { expect, test } from '@playwright/test';

test.describe('Private Lounge CUJ 01: Scroll-Gated Onboarding, Empty States, Chat, Gallery & Geo-Block', () => {
  test('enforces 4-clause scroll gate, Rebecca branding, empty states, persistent chat/options, and Phase 1 EEA geo-block', async ({
    browser,
    page,
  }) => {
    test.setTimeout(90000);
    const uniqueXId = `e2e_chat_${Date.now()}`;

    await page.goto(`/?emuXUser=${uniqueXId}`);
    await expect(page).toHaveTitle(/Rebecca Private Lounge/, { timeout: 15000 });
    await expect(page.locator('.brand-pill')).toContainText('Rebecca Private Lounge');
    await expect(page.locator('#btn-x-login')).toBeVisible({ timeout: 15000 });

    // Switch to Sign-Up and verify scroll gate locks both disclaimer & non-EEA checkboxes initially
    await page.locator('#btn-switch-to-signup').click();
    const consentCheckbox = page.locator('#checkbox-disclaimer-consent');
    const nonEeaCheckbox = page.locator('#checkbox-non-eea-eligibility');
    const signUpBtn = page.locator('#btn-x-signup');
    await expect(consentCheckbox).toBeDisabled();
    await expect(nonEeaCheckbox).toBeDisabled();
    await expect(signUpBtn).toBeDisabled();

    // Scroll disclaimer to the bottom -> both checkboxes unlock; both required to enable Sign-Up CTA
    await page.locator('#disclaimer-scroll-box').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event('scroll'));
    });
    await expect(consentCheckbox).toBeEnabled();
    await expect(nonEeaCheckbox).toBeEnabled();
    await consentCheckbox.check();
    await expect(signUpBtn).toBeDisabled();

    await nonEeaCheckbox.check();
    await expect(signUpBtn).toBeEnabled();
    await signUpBtn.click();

    // Confirm Language & Timezone onboarding screen -> enter Chat
    await expect(page.locator('#onboarding-preferences-card')).toBeVisible({ timeout: 20000 });
    await page.screenshot({ path: 'screenshots/lounge_01_onboarding.png' });
    await page.locator('#btn-start-lounge').click();

    // Verify 25 initial turns & real empty chat state before first message
    await expect(page.locator('#chat-message-stream')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#chat-empty-state')).toBeVisible();
    await expect(page.locator('#topbar-turns-value')).toHaveText(/25\s*\/\s*5/);

    // Verify empty gallery state & absence of dead .gallery-tile.locked placeholders
    await page.locator('#btn-hamburger').click();
    await page.locator('#nav-btn-gallery').click();
    await expect(page.locator('#gallery-view')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#gallery-empty-state')).toBeVisible();
    await expect(page.locator('.gallery-tile.locked')).toHaveCount(0);

    await page.locator('#btn-back-to-chat').click();
    await expect(page.locator('#chat-message-stream')).toBeVisible({ timeout: 10000 });

    // Send a real turn against BFF + Firestore Emulator -> assistant reply & quota decrement to 24 / 5
    await page.locator('#chat-composer-input').fill('E2E hello Rebecca! Tell me about tonight.');
    await page.locator('#btn-send-message').click();
    await expect(page.locator('#chat-message-stream')).toContainText('E2E hello Rebecca!', {
      timeout: 20000,
    });
    await expect(page.locator('#chat-empty-state')).toBeHidden();
    await expect(page.locator('#topbar-turns-value')).toHaveText(/24\s*\/\s*5/, { timeout: 15000 });
    await page.screenshot({ path: 'screenshots/lounge_02_chat_turn.png' });

    // Toggle analytics opt-out in Options and verify reload persistence
    await page.locator('#btn-hamburger').click();
    await page.locator('#nav-btn-options').click();
    await expect(page.locator('#options-view')).toBeVisible({ timeout: 10000 });

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

    // Verify Phase 1 EEA Geo-Blocking (x-client-country: DE -> 403 GEO_BLOCKED toast in UI)
    const eeaContext = await browser.newContext({
      extraHTTPHeaders: { 'x-client-country': 'DE' },
    });
    try {
      const eeaPage = await eeaContext.newPage();
      await eeaPage.goto(`http://127.0.0.1:4300/?emuXUser=e2e_eea_${Date.now()}`);
      await expect(eeaPage.locator('#btn-switch-to-signup')).toBeVisible({ timeout: 15000 });
      await eeaPage.locator('#btn-switch-to-signup').click();
      await eeaPage.locator('#disclaimer-scroll-box').evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        el.dispatchEvent(new Event('scroll'));
      });
      await eeaPage.locator('#checkbox-disclaimer-consent').check();
      await eeaPage.locator('#checkbox-non-eea-eligibility').check();
      await eeaPage.locator('#btn-x-signup').click();
      await expect(eeaPage.locator('#lounge-error-toast')).toBeVisible({ timeout: 15000 });
    } finally {
      await eeaContext.close();
    }
  });
});
