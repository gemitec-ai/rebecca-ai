import { expect, type Page } from '@playwright/test';

/**
 * Completes Phase 1 4-clause scroll-gated Sign-Up (`Consent -> Non-EEA Check -> X OAuth -> Onboarding`)
 * against Firebase Auth Emulator (`?emuXUser=...`) without any client mock scenario flags.
 */
export async function completeSignUpAndOnboarding(page: Page, emuXUserId: string): Promise<void> {
  await page.goto(`/?emuXUser=${encodeURIComponent(emuXUserId)}`);
  await expect(page.locator('#btn-switch-to-signup')).toBeVisible({ timeout: 15000 });
  await page.locator('#btn-switch-to-signup').click();

  await page.locator('#disclaimer-scroll-box').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event('scroll'));
  });

  await page.locator('#checkbox-disclaimer-consent').check();
  await page.locator('#checkbox-non-eea-eligibility').check();
  await expect(page.locator('#btn-x-signup')).toBeEnabled();
  await page.locator('#btn-x-signup').click();

  await expect(page.locator('#onboarding-preferences-card')).toBeVisible({ timeout: 20000 });
  await page.locator('#btn-start-lounge').click();
  await expect(page.locator('#topbar-turns-value')).toHaveText(/25\s*\/\s*5/, { timeout: 15000 });
}
