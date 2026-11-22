# AGENTS.md — `apps/lounge-backend`

Scoped architectural and contract rules for the **Gemitec Private Lounge** Backend-for-Frontend (BFF) API (`Express 5`). Inherits all global invariants from root `../../AGENTS.md`.

## 1. Architecture, Isolation & Security Invariants

- **Hexagonal Feature Layout**: Keep transport (`routers/`, `controllers/`), domain (`usecases/`), and persistence/AI ports (`repositories/`, `ports/`) strictly separated under `src/features/{auth,account,sessions,rewards}/`.
- **Strict Table Isolation (`lounge_*` Only for Writes)**:
  - Never mutate `users`, `conversation_logs`, `rag_memories`, `admin_users`, or any Public Bot / Admin collection from `lounge-backend`.
  - Public X Bot context may only be read through the read-only `IPublicXMemoryReadPort` boundary.
- **Scroll-Gated Sign-Up Consent Enforcement**:
  - Reject `/api/v1/lounge/auth/signup` unless `agreedToGeminiTrainingUsage`, `agreedToZeroPiiProhibition`, `agreedToOneWayMemoryIsolation`, valid `scrolledToBottomAt`, and valid `consentedAt` are explicitly verified at the domain boundary.
- **Mandatory Bounded Pagination**:
  - Every collection endpoint (`GET /sessions`, `GET /sessions/:sessionId/messages`, `GET /rewards`) must clamp `limit` with `Math.min(Math.max(1, limit), 100)` and support deterministic cursor pagination via `startAfterId`.
- **Zero Auth Bypass in Production**:
  - `NO_AUTH` must remain inert whenever `NODE_ENV === 'production'`. Emit 4xx/auth denials at `WARN` severity (`@rebecca/logger`); reserve `ERROR` severity exclusively for unhandled exceptions or infrastructure failures.

## 2. OpenAPI Contract Synchronization

- `apps/lounge-backend/openapi.yaml` (OpenAPI 3.0.3) is the single source of truth for all `/api/v1/lounge/*` REST contracts paired with DTOs in `@rebecca/types`.
