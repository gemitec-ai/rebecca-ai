# Private Lounge Frontend (`apps/lounge-frontend`)

Angular 22 Zoneless single-page application for **Rebecca Private Lounge** (`PORT=4300` local proxy/dev server). Built with **Hexagonal Architecture** (Ports & Adapters), Angular **Signals**, and WCAG-compliant interactive modals/tabs.

## Architecture & Core Capabilities

- **6 Hexagonal Domain Ports (`src/app/core/ports/`)**:
  Auth, Account, Session/Chat, Gallery, Health/Runtime Config, and Billing (`LoungeBillingPort`), decoupled cleanly behind `HttpLoungeBffAdapter` (`src/app/infrastructure/http/http-lounge-bff.adapter.ts`) + `LoungeFacadeService`.
- **Modular Firebase X Auth & Request Interceptor**:
  - `LoungeAuthService` initializes a named Firebase app (`private-lounge`), supports `OAuthProvider('twitter.com')` in Firebase Auth Emulator mode (`?emuXUser=` / `sessionStorage`) and `TwitterAuthProvider` popup in production.
  - `loungeAuthInterceptor` attaches Firebase ID tokens only when `isTrustedLoungeApiDestination` matches `/api/v1/lounge` on a verified origin and an authenticated user is present.
- **Onboarding, Chat HUD & Artwork Gallery**:
  - Scroll-gated 4-clause disclaimer onboarding (including Phase 1 non-EEA residency confirmation) and inline versioned re-consent (`DISCLAIMER_RECONSENT_REQUIRED`).
  - Singleton chat HUD enforcing the `1500`-character message limit, analytics opt-out toggle, 8 UI languages, and 29 global hourly timezones.
- **3-Tab Billing Hub & Pre-Checkout Disclosure (`BillingHubComponent` & `PreCheckoutModalComponent`)**:
  - WAI-ARIA `tablist` (`focusgroup="tablist nomemory"`, arrow-key navigation, indicator border, separated `.tabpanel-surface` panels) covering Plans/Tickets, Subscription Management / Customer Portal, and Purchase History (`<table>` inside `.table-wrapper` container-query responsive region with `<caption>`, `<th scope="col">`, and Safari-safe pre-opened receipt links).
  - Native `<dialog>` (`showModal()`) pre-checkout confirmation reading Portal legal links dynamically from `/api/v1/lounge/config` before redirecting only to Stripe-allowlisted URLs (`isAllowedStripeRedirectUrl`).
  - Automatic return synchronization on `?checkout=` and `?portal_return=1` query params.
- **2-Step Account Withdrawal**:
  Requires explicit confirmation and surfaces `502 STRIPE_CANCELLATION_FAILED` errors cleanly if remote Stripe subscription termination fails before local erasure.
