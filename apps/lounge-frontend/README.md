# Private Lounge Frontend (`apps/lounge-frontend`)

Angular 22 Zoneless single-page application for **Gemitec Private Lounge** (`PORT=4300` local proxy/dev server). Built with **Hexagonal Architecture** (Ports & Adapters), Angular **Signals**, and WCAG-compliant interactive modals/tabs.

## Architecture & Core Capabilities

- **6 Hexagonal Domain Ports (`src/app/core/ports/`)**:
  Auth, Account, Session/Chat, Gallery, Health/Runtime Config, and Billing (`LoungeBillingPort`), decoupled cleanly behind `LoungeBffAdapter` + `LoungeFacadeService`.
- **Modular Firebase X Auth & Request Interceptor**:
  - `LoungeAuthService` initializes a named Firebase app (`gemitec-private-lounge`), supports `OAuthProvider('twitter.com')` in Firebase Auth Emulator mode (`?emuXUser=` / `sessionStorage`) and `TwitterAuthProvider` popup in production.
  - `loungeAuthInterceptor` attaches Firebase ID tokens only when `isTrustedLoungeApiDestination` matches and an authenticated user is present.
- **Onboarding, Chat HUD & Artwork Gallery**:
  - Scroll-gated disclaimer onboarding and inline versioned re-consent (`LOUNGE_DISCLAIMER_RECONSENT_REQUIRED`).
  - Singleton chat HUD enforcing the `1500`-character message limit, analytics opt-out toggle, 8 UI languages, and 29 global hourly timezones.
- **3-Tab Billing Hub & Pre-Checkout Disclosure (`BillingHubComponent` & `PreCheckoutModalComponent`)**:
  - WAI-ARIA `tablist` (`focusgroup="tablist nomemory"`, arrow-key navigation, indicator border, separated `.tabpanel-surface` panels) covering Plans/Tickets, Subscription Management / Customer Portal, and Purchase History (`<table>` with `<caption>`, `<th scope="col">`, and Safari-safe pre-opened receipt links).
  - Native `<dialog>` (`showModal()`) pre-checkout confirmation linking externally to `/tos.html`, `/privacy.html`, and `/tokushoho.html` before redirecting only to Stripe-allowlisted URLs (`isAllowedStripeRedirectUrl`).
  - Automatic return synchronization on `?checkout=` and `?portal_return=1` query params.
- **2-Step Account Withdrawal**:
  Requires explicit confirmation and surfaces `502 STRIPE_CANCELLATION_FAILED` errors cleanly if remote Stripe subscription termination fails before local erasure.
