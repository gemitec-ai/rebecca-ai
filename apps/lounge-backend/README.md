# Private Lounge Backend (`apps/lounge-backend`)

Express 5 Backend-for-Frontend (BFF) service powering **Gemitec Private Lounge** (`PORT=8083`). Built with Clean / Hexagonal Vertical Slicing (`auth`, `account`, `session`, `gallery`, `billing`, `batch`), isolated `lounge_*` Firestore persistence, Stripe SAQ-A delegation, and Gemini Flash-Lite conversational orchestration.

## Architecture & Core Capabilities

- **Isolated Firestore Persistence (10 `lounge_*` Collections)**:
  `lounge_users`, `lounge_sessions`, `lounge_messages`, `lounge_rag_memories`, `lounge_gallery`, `lounge_subscriptions`, `lounge_credit_lots`, `lounge_quota_ledger`, `lounge_processed_events`, and `lounge_trial_grants`.
- **Hybrid Quota Engine & Anti-Abuse Ledger**:
  - **Daily Allowance**: `FREE: 5` turns/day, `STANDARD: 100` turns/day (non-rollover; timezone-change-only 24-hour clamp).
  - **180-Day Credit Lots**: `WELCOME_BONUS_20` (one-time welcome grant), `TRIAL_TICKET_100` (one-time per X account), and `CHARGE_TICKET_100`, consumed FIFO within `LOUNGE_CREDIT_LOT_VALIDITY_DAYS=180`.
  - **Versioned HMAC Trial Tracking**: `lounge_trial_grants` stores keyed HMAC-SHA256 digests (`LOUNGE_TRIAL_HMAC_KEYS` / `LOUNGE_TRIAL_HMAC_SECRET_V1`) retained for 3 years (`LOUNGE_TRIAL_GRANT_RETENTION_DAYS`) with zero PII.
- **Stripe SAQ-A Billing & Webhooks**:
  - Multi-currency server-locked catalog (`JPY` tax-inclusive / `USD`) from Geo-IP headers (`x-client-country` / `cf-ipcountry`), with Phase-2 EEA/UK/CH gating (`LOUNGE_PHASE2_EEA_ENABLED`).
  - Delegates payment capture and recurring self-service to Stripe Checkout & Customer Portal (`isAllowedStripeRedirectUrl` validated), verifies `stripe-signature` against raw payloads at `/api/v1/lounge/webhooks/stripe` (`90`-day idempotent ledger), and fails closed if `sk_live_`/`rk_live_`/`pk_live_` keys are supplied outside `NODE_ENV=production`.
- **Gemini 3 Flash-Lite & Nightly Dreaming**:
  - Uses `gemini-3.1-flash-lite` (chat + Google Search grounding; daily limits `FREE: 2`, `PAID_OR_STANDARD: 3`) and `gemini-embedding-2` (vector RAG), capped at `450` output tokens (`LOUNGE_MAX_OUTPUT_TOKENS`) and global circuit breakers (`LOUNGE_GLOBAL_DAILY_SIGNUP_CAP=2000`, `LOUNGE_GLOBAL_DAILY_TURN_CAP=50000`).
  - Nightly memory consolidation exposed via OIDC-protected `/api/v1/lounge/batch` (`/batch/lounge-dreaming`).
- **Cascade Account Deletion (`502 STRIPE_CANCELLATION_FAILED` Guard)**:
  Cancels active Stripe subscriptions and deletes the Stripe customer before wiping user, session, message, memory, gallery, and subscription records locally.

## API Route Groups (`/api/v1/lounge`)

- `GET /api/v1/lounge/health` & `GET /api/v1/lounge/config`
- `/api/v1/lounge/auth`
- `/api/v1/lounge/account`
- `/api/v1/lounge/session`
- `/api/v1/lounge/gallery`
- `/api/v1/lounge/billing`
- `POST /api/v1/lounge/webhooks/stripe` (raw body signature verification)
- `/api/v1/lounge/batch`

## Key Environment Variables

Use placeholders and `sk_test_` / `pk_test_` keys in non-production environments (see root `.env.example`):

- `PORT` (default `8083`), `NODE_ENV`, `GCP_PROJECT_ID`, `LOUNGE_PUBLIC_ORIGIN`, `CORS_ALLOWED_ORIGINS`
- `LOUNGE_STRIPE_SECRET_KEY` / `STRIPE_SECRET_KEY`, `LOUNGE_STRIPE_PUBLISHABLE_KEY` / `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_TRIAL_JPY`, `STRIPE_PRICE_TRIAL_USD`, `STRIPE_PRICE_CHARGE_JPY`, `STRIPE_PRICE_CHARGE_USD`, `STRIPE_PRICE_STANDARD_JPY`, `STRIPE_PRICE_STANDARD_USD`
- `LOUNGE_TRIAL_HMAC_KEYS` (JSON version map, e.g. `{"1":"<secret>"}`) / `LOUNGE_TRIAL_HMAC_SECRET_V1`
- `LOUNGE_GEMINI_CHAT_MODEL`, `LOUNGE_GEMINI_SEARCH_MODEL`, `LOUNGE_GEMINI_EMBEDDING_MODEL`, `LOUNGE_GEMINI_PAID_TIER`, `LOUNGE_PHASE2_EEA_ENABLED`
- `BATCH_SECRET_KEY` (non-production local batch testing only)
