import * as crypto from 'node:crypto';
import { expect, test } from '@playwright/test';

const WEBHOOK_SECRET = 'whsec_e2e_test_secret';

function signWebhookBody(rawBody: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(`${ts}.${rawBody}`, 'utf8')
    .digest('hex');
  return `t=${ts},v1=${sig}`;
}

interface FirestoreFieldValue {
  readonly stringValue?: string;
}

interface FirestoreDocument {
  readonly name: string;
  readonly fields?: Record<string, FirestoreFieldValue>;
}

async function queryEmulatorCollection(collectionName: string): Promise<FirestoreDocument[]> {
  const res = await fetch(
    `http://127.0.0.1:8080/v1/projects/rebecca-ai-gal-local/databases/(default)/documents/${collectionName}?pageSize=100`,
    { headers: { Authorization: 'Bearer owner' } },
  );
  if (!res.ok) {
    throw new Error(`Firestore emulator read failed (${collectionName}): ${res.status}`);
  }
  const json = (await res.json()) as { readonly documents?: FirestoreDocument[] };
  return json.documents ?? [];
}

test.describe('Private Lounge CUJ 03: Signed Stripe Webhooks & Dispute Isolation', () => {
  test('processes subscription cancel_at_period_end, payment_failed PAST_DUE banner, charge.refunded, and dispute suspension', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const uniqueXId = `e2e_hook_${Date.now()}`;

    await page.goto(`/?emuXUser=${uniqueXId}`);
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

    // Purchase Charge Ticket (+100) and subscribe to Standard Monthly (+100 daily)
    await page.locator('#btn-topbar-billing').click();
    await page.locator('#btn-select-product-CHARGE_TICKET_100').click();
    await page.locator('#chk-precheckout-disclosure').check();
    await page.locator('#chk-precheckout-autorenew').check();
    await page.locator('#chk-precheckout-adult').check();
    await page.locator('#btn-precheckout-proceed').click();
    await expect(page.locator('#topbar-turns-value')).toHaveText(/125\s*\/\s*5/, { timeout: 15000 });

    await page.locator('#btn-select-product-STANDARD_MONTHLY').click();
    await page.locator('#chk-precheckout-disclosure').check();
    await page.locator('#chk-precheckout-autorenew').check();
    await page.locator('#chk-precheckout-adult').check();
    await page.locator('#btn-precheckout-proceed').click();
    await expect(page.locator('#topbar-turns-value')).toHaveText(/220\s*\/\s*100/, {
      timeout: 15000,
    });

    // Resolve user's UID, Stripe Customer ID, Subscription ID & PaymentIntent ID from Firestore Emulator
    const userDocs = await queryEmulatorCollection('lounge_users');
    const targetUserDoc = userDocs.find((d) => d.fields?.['xUserId']?.stringValue === uniqueXId);
    expect(targetUserDoc).toBeDefined();
    const uid = targetUserDoc!.name.split('/').pop()!;

    const subDocs = await queryEmulatorCollection('lounge_subscriptions');
    const subDoc = subDocs.find((d) => d.name.endsWith(`/${uid}`));
    expect(subDoc).toBeDefined();
    const stripeCustomerId = subDoc!.fields?.['stripeCustomerId']?.stringValue ?? '';
    const stripeSubId = subDoc!.fields?.['stripeSubscriptionId']?.stringValue ?? '';
    expect(stripeCustomerId).toMatch(/^cus_/);
    expect(stripeSubId).toMatch(/^sub_/);

    const lotDocs = await queryEmulatorCollection('lounge_credit_lots');
    const paidLotDoc = lotDocs.find(
      (d) =>
        d.fields?.['uid']?.stringValue === uid &&
        d.fields?.['productId']?.stringValue === 'CHARGE_TICKET_100',
    );
    expect(paidLotDoc).toBeDefined();
    const paidPiId = paidLotDoc!.fields?.['stripePaymentIntentId']?.stringValue ?? '';
    expect(paidPiId).toMatch(/^pi_/);

    const postSignedWebhook = async (eventId: string, type: string, dataObj: Record<string, unknown>) => {
      const rawBody = JSON.stringify({ id: eventId, type, data: { object: dataObj } });
      const res = await page.request.post('http://127.0.0.1:8083/api/v1/lounge/webhooks/stripe', {
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signWebhookBody(rawBody),
        },
        data: rawBody,
      });
      expect(res.status()).toBe(200);
    };

    // 1. customer.subscription.updated (cancel_at_period_end: true -> CANCELING)
    await postSignedWebhook(`evt_cancel_${Date.now()}`, 'customer.subscription.updated', {
      id: stripeSubId,
      customer: stripeCustomerId,
      status: 'active',
      cancel_at_period_end: true,
    });
    await page.locator('#billing-tab-subscription').click();
    await expect(page.locator('#sub-status-value')).toHaveText('CANCELING', { timeout: 15000 });
    await expect(page.locator('#billing-canceling-notice')).toBeVisible();

    // 2. invoice.payment_failed -> PAST_DUE banner & daily quota drops to 5
    await postSignedWebhook(`evt_fail_${Date.now()}`, 'invoice.payment_failed', {
      customer: stripeCustomerId,
      parent: { subscription_details: { subscription: stripeSubId } },
    });
    await page.goto('/');
    await expect(page.locator('#chat-past-due-banner')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#topbar-turns-value')).toHaveText(/125\s*\/\s*5/);
    await page.screenshot({ path: 'screenshots/lounge_08_past_due_banner.png' });

    // 3. charge.refunded on Charge Ticket -> revokes 100 turns (25 / 5 remaining)
    await postSignedWebhook(`evt_refund_${Date.now()}`, 'charge.refunded', {
      payment_intent: paidPiId,
      customer: stripeCustomerId,
      amount_captured: 500,
      amount_refunded: 500,
    });
    await page.reload();
    await expect(page.locator('#topbar-turns-value')).toHaveText(/25\s*\/\s*5/, { timeout: 15000 });

    // 4. charge.dispute.created -> suspends account & sets DISPUTE_BLOCKED
    await postSignedWebhook(`evt_dispute_${Date.now()}`, 'charge.dispute.created', {
      id: `dp_e2e_${Date.now()}`,
      payment_intent: paidPiId,
      charge: 'ch_disp_1',
    });
    await page.reload();
    // Suspended user is rejected from session restore and returns cleanly to Auth view
    await expect(page.locator('#btn-x-login')).toBeVisible({ timeout: 15000 });

    const grantDocs = await queryEmulatorCollection('lounge_trial_grants');
    const disputedGrant = grantDocs.find((g) => g.fields?.['riskStatus']?.stringValue === 'DISPUTE_BLOCKED');
    expect(disputedGrant).toBeDefined();
  });
});
