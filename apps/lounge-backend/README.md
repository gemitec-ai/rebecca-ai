# `@rebecca/lounge-backend` (`lounge-backend`)

Express 5 Backend-for-Frontend (BFF) architecture skeleton for the **Gemitec Private Lounge**.

## Architecture Overview

- **Strict Database Isolation**: Reads/writes exclusively against isolated Firestore collections (`lounge_users`, `lounge_subscriptions`, `lounge_sessions`, `lounge_messages`, `lounge_rag_memories`, `lounge_rewards`) declared in `@rebecca/db`.
- **One-Way Public X Memory Contract**: Reads public X Bot context solely through `IPublicXMemoryReadPort` (zero write methods). Private lounge sessions never leak back to public X posts or public `rag_memories`.
- **Hexagonal Separation**:
  - `src/middleware/`: Firebase Auth ID token verification (`ILoungeAuthVerifierPort`).
  - `src/features/auth/`: X-linked login, logout, and scroll-gated disclaimer signup validation.
  - `src/features/account/`: Subscription tier, daily remaining chat turns, and sync status.
  - `src/features/sessions/`: Paginated sessions/messages and AI pipeline/memory ports.
  - `src/features/rewards/`: Paginated collectible illustration rewards.
- **OpenAPI SSOT**: `openapi.yaml` (OpenAPI 3.0.3).

## Commands

```bash
npm run build --workspace=lounge-backend
npm test --workspace=lounge-backend
npm run lint --workspace=lounge-backend
```
