# Rebecca Private Lounge E2E Suite (`apps/lounge-e2e`)

End-to-end Playwright suite verifying **Rebecca Private Lounge** against live Express BFF (`apps/lounge-backend`) and Firebase Emulators (Auth, Firestore, Storage).

## Running Locally

1. Ensure Firebase Emulators (Auth `9099`, Firestore `8080`, Storage `9199`) are running.
2. Build workspaces (`npm run build`).
3. Execute the suite:

```bash
npm run test:e2e:lounge
```

## Covered Critical User Journeys

- `01-lounge-onboarding-and-chat.spec.ts`: 4-clause scroll gate + non-EEA check, `Rebecca Private Lounge` branding, `#chat-empty-state` & `#gallery-empty-state`, live chat turn & quota decrement, analytics opt-out reload persistence, and Phase 1 `DE` geo-blocking (`403 GEO_BLOCKED`).
- `02-lounge-billing-and-tickets.spec.ts`: 3-tab Billing Hub, localized tier/status badges (`data-tier`, `data-status`), ASCT pre-checkout modal with dynamic legal URLs, Trial & Standard checkouts, Purchase History receipt popup (`/^https:\/\/pay\.stripe\.com\/receipts\//`), and Stripe Customer Portal round-trip sync.
- `03-lounge-webhooks-and-disputes.spec.ts`: Signed Stripe webhooks (`customer.subscription.updated`, `invoice.payment_failed`, `charge.refunded`, `charge.dispute.created`) and `DISPUTE_BLOCKED` suspension isolation.
- `04-lounge-withdrawal-and-antiabuse.spec.ts`: 2-step cascade deletion across Firestore + Firebase Auth + non-PII HMAC anti-abuse persistence blocking repeat `+20` welcome bonuses and Trial Ticket repurchase.
