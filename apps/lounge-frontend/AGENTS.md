# AGENTS.md — `apps/lounge-frontend`

Scoped architectural and UI governance for the **Gemitec Private Lounge** Angular 22 Zoneless SPA. Inherits all global invariants from root `../../AGENTS.md`.

## 1. Zoneless Signals & Hexagonal Dependency Inversion

- Use `provideZonelessChangeDetection()` (`src/app/app.config.ts`) and manage UI state strictly with Angular **Signals**.
- Keep UI components decoupled from raw HTTP / `HttpClient` transport via abstract ports (`src/app/core/ports/*.port.ts`) bound in `appConfig` to `LoungeBffAdapter` (`src/app/core/adapters/lounge-bff.adapter.ts`).
- Consume character branding dynamically from `LoungeConfigPort` (`/api/v1/lounge/config`) and `@rebecca/types` rather than importing `@rebecca/persona` or hardcoding persona lore in Angular templates.

## 2. UI Security, Onboarding & Accessibility Invariants

- **Sign-Up Onboarding Journey (`Consent -> X Link -> Locale/Timezone -> Start`)**:
  - Keep the sign-up agreement checkbox and X OAuth sign-up submit action disabled until the disclaimer container reaches bottom scroll depth (or auto-unlocks on zero-overflow viewports) and all required clauses (Gemini API usage notice, zero-PII transmission prohibition, private session rules) are confirmed. Announce scroll readiness cleanly via `aria-live="polite"`.
  - Immediately following X Sign-Up linking, present the Language & IANA Timezone confirmation step (custom accessible dropdowns—never native `<select>`) with explicit notice that settings can be modified later from Options before entering the user's single persistent conversation session.
- **Top-Left Hamburger Drawer Navigation & Multi-Step Withdrawal**:
  - Provide a `>= 44x44px` hamburger toggle button (`aria-expanded`) opening the focus-trapped Slide-Over Sidebar housing subscription/quota telemetry, Gallery navigation, Options navigation, Logout action, and subtle version badge.
  - Inside Options, provide a clear two-step irreversible Account Deletion & Withdrawal flow warning users that all session/memory/gallery data will be permanently erased with zero recovery and zero refunds for paid turns.
- **Built-In XSS Safety**: Never invoke `DomSanitizer.bypassSecurityTrust*` or `[innerHTML]` on untrusted strings or user prompts.
