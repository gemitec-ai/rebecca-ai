import { expect, test } from '@playwright/test';

test.describe('Private Lounge CUJ 04: Cascade Account Deletion & Trial/Welcome Anti-Abuse Persistence', () => {
  test('wipes user/session/subs on 2-step deletion and blocks second +20 welcome bonus or Trial repurchase on same X re-signup', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const sameXId = `e2e_abuse_${Date.now()}`;

    // 1. First sign-up & onboarding (+20 welcome + 5 daily = 25)
    await page.goto(`/?emuXUser=${sameXId}`);
    await page.locator('#btn-switch-to-signup').click();
    await page.locator('#disclaimer-scroll-box').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event('scroll'));
    });
    await page.locator('#checkbox-disclaimer-consent').check();
    await page.locator('#btn-x-signup').click();
    await expect(page.locator('#onboarding-preferences-card')).toBeVisible({ timeout: 20000 });
    await page.locator('#btn-start-lounge').click();
    await expect(page.locator('#topbar-turns-value')).toHaveText(/25\s*\/\s*5/, { timeout: 15000 });

    // Purchase Trial Ticket (+100 -> 125 / 5)
    await page.locator('#btn-topbar-billing').click();
    await page.locator('#btn-select-product-TRIAL_TICKET_100').click();
    await page.locator('#chk-precheckout-disclosure').check();
    await page.locator('#chk-precheckout-autorenew').check();
    await page.locator('#chk-precheckout-adult').check();
    await page.locator('#btn-precheckout-proceed').click();
    await expect(page.locator('#topbar-turns-value')).toHaveText(/125\s*\/\s*5/, { timeout: 20000 });

    // 2. Navigate to Options and complete 2-step irreversible Account Deletion
    await page.locator('#btn-hamburger').click();
    await page.locator('#nav-btn-options').click();
    await expect(page.locator('#options-view')).toBeVisible({ timeout: 10000 });

    await page.locator('#btn-open-delete-account').click();
    await expect(page.locator('#btn-delete-step1-next')).toBeVisible();
    await page.locator('#btn-delete-step1-next').click();

    await expect(page.locator('#btn-confirm-delete-account')).toBeDisabled();
    await page.locator('#checkbox-delete-irreversible').check();
    await page.locator('#checkbox-delete-no-refund').check();
    await expect(page.locator('#btn-confirm-delete-account')).toBeEnabled();
    await page.screenshot({ path: 'screenshots/lounge_09_delete_step2.png' });
    await page.locator('#btn-confirm-delete-account').click();

    // Account deleted -> returns to AUTH Sign-Up mode
    await expect(page.locator('#btn-x-signup')).toBeVisible({ timeout: 20000 });

    // 3. Re-register with the EXACT same X account ID and verify anti-abuse protections
    await page.goto(`/?emuXUser=${sameXId}`);
    await page.locator('#btn-switch-to-signup').click();
    await page.locator('#disclaimer-scroll-box').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event('scroll'));
    });
    await page.locator('#checkbox-disclaimer-consent').check();
    await page.locator('#btn-x-signup').click();
    await expect(page.locator('#onboarding-preferences-card')).toBeVisible({ timeout: 20000 });
    await page.locator('#btn-start-lounge').click();

    // Same X identity receives ONLY 5 daily turns (second +20 welcome bonus blocked)
    await expect(page.locator('#chat-message-stream')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#topbar-turns-value')).toHaveText(/5\s*\/\s*5/, { timeout: 15000 });

    // Trial Ticket remains permanently locked (TRIAL_ALREADY_USED across deletion!)
    await page.locator('#btn-topbar-billing').click();
    await expect(page.locator('#btn-select-product-TRIAL_TICKET_100')).toBeDisabled({
      timeout: 15000,
    });
    await page.screenshot({ path: 'screenshots/lounge_10_antiabuse_locked.png' });
  });
});
