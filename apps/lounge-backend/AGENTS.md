# AGENTS.md — `apps/lounge-backend`

Scoped architectural and contract rules for the **Gemitec Private Lounge** Backend-for-Frontend (BFF) API (`Express 5`). Inherits all global invariants from root `../../AGENTS.md`.

## 1. Architecture, Isolation & Security Invariants

- **Hexagonal Feature Layout**: Keep transport (`routers/`, `controllers/`), domain (`usecases/`), and persistence/AI ports (`repositories/`, `ports/`) strictly separated under `src/features/{auth,account,sessions,gallery}/`.
- **1:1 Account & Single-Session Invariant**:
  - Enforce 1 Private Lounge account per X account (`HTTP 409 Conflict` when registering an already-linked `xUserId` or `uid`).
  - Provide a single continuous session per user (`GET /api/v1/lounge/session`, `GET/POST /api/v1/lounge/session/messages`) with irreversible cascade deletion (`DELETE /api/v1/lounge/account`) removing user profile, subscription, session, raw messages, Dreaming/RAG memories, and gallery records without refunding unused paid turns.
- **Two-Layer Memory & Strict Table Isolation (`lounge_*` Only for Writes)**:
  - Never mutate `users`, `conversation_logs`, `rag_memories`, `timeline_history`, `system/persona`, `admin_users`, or any Public Bot / Admin collection from `lounge-backend`.
  - Maintain independent per-user Private Lounge Dreaming (`coreProfile`), vectorized RAG (`lounge_rag_memories`), and raw messages separately in `lounge_*`, while reading Public X Bot user context + Layer 1/2/3 self-post memories strictly read-only through `IPublicXMemoryReadPort` and illustrations through `IBotImageAssetSearchPort`.
- **Scroll-Gated Sign-Up Consent Enforcement**:
  - Reject `/api/v1/lounge/auth/signup` unless `agreedToGeminiTrainingUsage`, `agreedToZeroPiiProhibition`, `agreedToOneWayMemoryIsolation`, valid `scrolledToBottomAt`, and valid `consentedAt` are explicitly verified at the domain boundary.
- **Locale & Time-of-Day Prompt Injection**:
  - Validate the 8 supported Lounge languages (`ja`, `en`, `de`, `pt`, `es`, `zh-HK`, `vi`, `th`) and IANA timezones strictly on `PATCH /api/v1/lounge/account/preferences`, and inject resolved local time and language directives into the AI pipeline.
- **Mandatory Bounded Pagination**:
  - Every collection endpoint (`GET /session/messages`, `GET /gallery`) must clamp `limit` with `Math.min(Math.max(1, limit), 100)` and support deterministic cursor pagination via `startAfterId`.
- **Zero Auth Bypass in Production**:
  - `NO_AUTH` must remain inert whenever `NODE_ENV === 'production'`. Emit 4xx/auth denials at `WARN` severity (`@rebecca/logger`); reserve `ERROR` severity exclusively for unhandled exceptions or infrastructure failures.

## 2. OpenAPI Contract Synchronization

- `apps/lounge-backend/openapi.yaml` (OpenAPI 3.0.3) is the single source of truth for all `/api/v1/lounge/*` REST contracts paired with DTOs in `@rebecca/types`.
