# `lounge-frontend`

Angular 22 Zoneless SPA architecture skeleton for the **Gemitec Private Lounge**.

## Architecture

- **Hexagonal Ports (`src/app/core/ports/`)**:
  - `LoungeAuthPort`: X-linked login, logout, and scroll-verified disclaimer sign-up.
  - `LoungeAccountPort`: Subscription tier and remaining daily chat turns summary.
  - `LoungeSessionPort`: Paginated Private Lounge sessions and interactive turn submission.
  - `LoungeRewardPort`: Paginated collectible illustration gallery.
- **Adapters (`src/app/core/adapters/`)**: `LoungeBffAdapter` implements all four ports cleanly against `@rebecca/types` DTOs and dynamic `@rebecca/persona` metadata.
- **Signals Facade (`src/app/core/services/lounge-facade.service.ts`)**: Reactive Zoneless state coordinating the Auth (`LOGIN` / scroll-gated `SIGNUP`), Chat Stage (top-left hamburger menu), Slide-Over Sidebar Drawer (account quota + Rewards navigation + Logout), and Rewards Illustration Gallery views.

## Commands

```bash
npm run dev --workspace=lounge-frontend
npm run build --workspace=lounge-frontend
npm test --workspace=lounge-frontend
npm run lint --workspace=lounge-frontend
```
