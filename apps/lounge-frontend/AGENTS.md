# AGENTS.md — `apps/lounge-frontend`

Scoped architectural and UI governance for the **Gemitec Private Lounge** Angular 22 Zoneless SPA. Inherits all global invariants from root `../../AGENTS.md`.

## 1. Zoneless Signals & Hexagonal Dependency Inversion

- Use `provideZonelessChangeDetection()` (`src/app/app.config.ts`) and manage UI state strictly with Angular **Signals**.
- Keep UI components decoupled from raw HTTP / `HttpClient` transport via abstract ports (`src/app/core/ports/*.port.ts`) bound in `appConfig` to `LoungeBffAdapter` (`src/app/core/adapters/lounge-bff.adapter.ts`).
- Consume character branding dynamically from `@rebecca/persona` / backend account payloads rather than hardcoding persona lore in Angular templates.

## 2. UI Security & Accessibility Invariants

- **Mandatory Scroll-Gated Sign-Up Consent**: Keep the sign-up agreement checkbox and X OAuth sign-up submit action disabled until the disclaimer container reaches bottom scroll depth and all required clauses (Gemini training/learning notice, zero-PII transmission prohibition, one-way Public X memory isolation) are confirmed. Announce scroll readiness cleanly via `aria-live="polite"`.
- **Top-Left Hamburger Drawer Navigation**: Provide a `>= 44x44px` hamburger toggle button (`aria-expanded`) that opens the Slide-Over Sidebar housing subscription/quota telemetry, Rewards gallery transition, Logout action, and subtle version badge.
- **Built-In XSS Safety**: Never invoke `DomSanitizer.bypassSecurityTrust*` on untrusted strings or user prompts.
