# `lounge-frontend`

Angular 22 Zoneless SPA architecture skeleton for the **Gemitec Private Lounge**.

## Architecture

- **Hexagonal Ports (`src/app/core/ports/`)**:
  - `LoungeConfigPort`: Runtime version, disclaimer version, and dynamic persona branding (`/config`).
  - `LoungeAuthPort`: X-linked login, logout, and 1:1 X sign-up with scroll-verified disclaimer consent.
  - `LoungeAccountPort`: Subscription tier, daily remaining chat turns summary, locale/timezone updates, and cascade account deletion.
  - `LoungeSessionPort`: User's single persistent Private Lounge conversation session and message turn submission.
  - `LoungeGalleryPort`: Paginated visual Bot illustration gallery automatically unlocked during chat turns.
- **Adapters (`src/app/core/adapters/`)**: `LoungeBffAdapter` implements all five ports cleanly against `@rebecca/types` DTOs and dynamic `/api/v1/lounge/config` metadata.
- **Signals Facade (`src/app/core/services/lounge-facade.service.ts`)**: Reactive Zoneless state orchestrating Auth (`LOGIN` / scroll-gated `SIGNUP`), post-signup Language/Timezone Onboarding (`ONBOARDING`), Single-Session Chat (`CHAT`), Slide-Over Sidebar Drawer, Bot Illustration Gallery (`GALLERY`), Options Preferences & 2-Step Withdrawal Modal (`OPTIONS`), across 8 supported languages (`ja`, `en`, `de`, `pt`, `es`, `zh-HK`, `vi`, `th`).

## Commands

```bash
npm run dev --workspace=lounge-frontend
npm run build --workspace=lounge-frontend
npm test --workspace=lounge-frontend
npm run lint --workspace=lounge-frontend
```
