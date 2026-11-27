# AGENTS.md — `apps/lounge-e2e`

Scoped engineering rules for the **Rebecca Private Lounge** Playwright End-to-End (E2E) test suite. Inherits all global invariants from root `../../AGENTS.md`.

## 1. Role in the Testing Trophy

- `apps/lounge-e2e` verifies **full-stack Critical User Journeys (CUJs)** across the compiled Private Lounge Angular SPA (`scripts/serve-frontend.js` on `127.0.0.1:4300`), the isolated Lounge Express BFF (`127.0.0.1:8083`), and local Firebase Emulators (`Firestore:8080`, `Auth:9099`, `Storage:9199`).
- Lock down real user-visible contracts: 4-clause scroll-gated sign-up onboarding (including Phase 1 non-EEA eligibility check), `Rebecca Private Lounge` dynamic `/config` branding, real BFF persistent chat & empty states (`#chat-empty-state`, `#gallery-empty-state`), 3-tab Billing Hub & ASCT pre-checkout modal, Stripe webhook state transitions, Phase 1 `GEO_BLOCKED` enforcement, and 2-step cascade withdrawal / anti-abuse persistence.
- Never use `?previewScenario=` or offline client mock fixtures in E2E tests.

## 2. Locator, Assertion & Motion Rules (Zero Flakiness)

1. **Web-First Auto-Retrying Assertions Only**: Always `await expect(locator).toBeVisible()`, `toHaveText()`, `toHaveAttribute()`, `toBeDisabled()`, or `await expect(page).toHaveURL(...)`. **Strictly forbid `page.waitForTimeout(...)`**.
2. **Anchored URL Checks**: When asserting external hosted Stripe receipt URLs in popup checks, anchor regex patterns strictly (`/^https:\/\/pay\.stripe\.com\/receipts\//`).
3. **Clean Artifacts**: Never commit generated `playwright-report/`, `test-results/`, or `screenshots/` artifacts to Git.
