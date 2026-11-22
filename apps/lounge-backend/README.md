# `@rebecca/lounge-backend` (`lounge-backend`)

Express 5 Backend-for-Frontend (BFF) architecture skeleton for the **Gemitec Private Lounge**.

## Architecture Overview

- **Strict Database Isolation**: Reads/writes exclusively against isolated Firestore collections (`lounge_users`, `lounge_subscriptions`, `lounge_sessions`, `lounge_messages`, `lounge_rag_memories`, `lounge_gallery`) declared in `@rebecca/db`.
- **Two-Layer Memory & Read-Only Bot Integration**: Combines independent Private Lounge Dreaming (`coreProfile`), vector search (`lounge_rag_memories`), and recent raw turns with read-only Public X Bot user context (recent turns, vector memories, structured profile) plus the active persona's Layer 1/2/3 self-post memories via `IPublicXMemoryReadPort` and illustration matching via `IBotImageAssetSearchPort`.
- **Hexagonal Separation**:
  - `src/middleware/`: Firebase Auth ID token verification (`ILoungeAuthVerifierPort`).
  - `src/features/auth/`: X-linked login, logout, and scroll-gated disclaimer signup validation enforcing `1 X account = 1 Lounge account` (`HTTP 409`).
  - `src/features/account/`: Subscription tier, remaining daily chat turns, gallery count, locale preferences (`PATCH /account/preferences`), and irreversible cascade withdrawal (`DELETE /account`).
  - `src/features/sessions/`: Single persistent session per user (`/session`, `/session/messages`), locale & memory prompt directive builders, Bot illustration matching, and AI pipeline ports.
  - `src/features/gallery/`: Paginated Bot illustrations automatically saved when shown during conversation.
- **OpenAPI SSOT**: `openapi.yaml` (OpenAPI 3.0.3).

## Commands

```bash
npm run build --workspace=lounge-backend
npm test --workspace=lounge-backend
npm run lint --workspace=lounge-backend
```
