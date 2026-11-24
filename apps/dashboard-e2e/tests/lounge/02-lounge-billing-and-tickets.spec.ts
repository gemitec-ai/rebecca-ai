import { expect, test } from '@playwright/test';

test.describe('Private Lounge CUJ 02: Billing Catalog, ASCT Checkout, History Receipt & Portal Sync', () => {
  test('completes Trial Ticket + Standard Monthly Checkout, checks Purchase History & receipt popup, and syncs Portal return', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const uniqueXId = `e2e_bill_${Date.now()}`;

    await page.goto(`/?emuXUser=${uniqueXId}`);
    await expect(page.locator('#btn-switch-to-signup')).toBeVisible({ timeout: 15000 });
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

    // Open 3-Tab Billing Hub via clickable Topbar quota button
    await page.locator('#btn-topbar-billing').click();
    await expect(page.locator('#billing-view')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#product-card-TRIAL_TICKET_100')).toBeVisible();
    await expect(page.locator('#product-card-CHARGE_TICKET_100')).toBeVisible();
    await expect(page.locator('#product-card-STANDARD_MONTHLY')).toBeVisible();
    await page.screenshot({ path: 'screenshots/lounge_04_billing_plans.png' });

    // Purchase one-time Trial Ticket (+100 turns) via native <dialog> ASCT Art. 12-6 gate
    await page.locator('#btn-select-product-TRIAL_TICKET_100').click();
    await expect(page.locator('#precheckout-dialog')).toBeVisible();
    await expect(page.locator('#btn-precheckout-proceed')).toBeDisabled();
    await page.screenshot({ path: 'screenshots/lounge_05_precheckout_dialog.png' });

    await page.locator('#chk-precheckout-disclosure').check();
    await page.locator('#chk-precheckout-autorenew').check();
    await page.locator('#chk-precheckout-adult').check();
    await expect(page.locator('#btn-precheckout-proceed')).toBeEnabled();
    await page.locator('#btn-precheckout-proceed').click();

    // Wait for Checkout return verification + updated quota (25 + 100 = 125 / 5) and Trial lockout
    await expect(page.locator('#billing-view')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#billing-status-banner')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#topbar-turns-value')).toHaveText(/125\s*\/\s*5/);
    await expect(page.locator('#btn-select-product-TRIAL_TICKET_100')).toBeDisabled();

    // Inspect Purchase History tab & verify Safari-safe receipt popup launch
    await page.locator('#billing-tab-history').click();
    const firstReceiptBtn = page.locator('button[id^="btn-receipt-"]').first();
    await expect(firstReceiptBtn).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: 'screenshots/lounge_06_billing_history.png' });

    await page.context().route('https://pay.stripe.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>Stripe Test Receipt</body></html>' }),
    );
    const popupPromise = page.waitForEvent('popup');
    await firstReceiptBtn.click();
    const receiptPopup = await popupPromise;
    await expect(receiptPopup).toHaveURL(/https:\/\/pay\.stripe\.com\/receipts/);
    await receiptPopup.close();

    // Subscribe to Standard Monthly (100 daily allowance -> 100 daily + 120 purchased = 220 total)
    await page.locator('#billing-tab-plans').click();
    await page.locator('#btn-select-product-STANDARD_MONTHLY').click();
    await page.locator('#chk-precheckout-disclosure').check();
    await page.locator('#chk-precheckout-autorenew').check();
    await page.locator('#chk-precheckout-adult').check();
    await page.locator('#btn-precheckout-proceed').click();

    await expect(page.locator('#billing-view')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#topbar-turns-value')).toHaveText(/220\s*\/\s*100/, {
      timeout: 15000,
    });

    // Switch to Subscription tab and verify breakdown & Stripe Customer Portal round-trip sync
    await page.locator('#billing-tab-subscription').click();
    await expect(page.locator('#sub-tier-value')).toHaveText('STANDARD', { timeout: 15000 });
    await expect(page.locator('#sub-status-value')).toHaveText('ACTIVE');
    await expect(page.locator('#sub-daily-bucket-value')).toContainText('100 / 100');
    await expect(page.locator('#sub-purchased-bucket-value')).toContainText('120');
    await page.screenshot({ path: 'screenshots/lounge_07_subscription_detail.png' });

    await page.locator('#btn-portal-default').click();
    await expect(page.locator('#billing-status-banner')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#sub-status-value')).toHaveText('ACTIVE');
  });
});
