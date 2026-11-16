# Shared Cognitive Memory Engine (`packages/memory`)

SDK-agnostic 3-tier memory core, Tatemae/Honne (`thought` / `reply`) history reconstruction & prompt synthesis, core vectorization/RAG primitives, Dreaming consolidation, asymmetric public-to-private memory overlay, and dynamic persona anchoring shared across Rebecca AI backend services.

---

## Core vs. Application Layer Boundary

`@rebecca/memory` contains **pure, channel-agnostic cognitive memory engines** parameterized by `@rebecca/persona` and Hexagonal storage/embedder/synthesizer ports. Concrete application use cases—such as X reply query generation prompts, user-exchange serialization templates, timeline post image attachments, news headline deduplication, and batch asset caption indexing—remain inside each consuming application (`apps/bot-backend`, future `apps/lounge-backend`).

---

## Architecture & Core Modules

- **Tier 1 / 2 Working Memory & Tatemae/Honne Reconstruction (`src/workingMemory.ts`)**:
  - `getWorkingMemory`: Extracts the trailing sliding window of conversation turn pairs (`limit = 10` pairs = 20 entries by default).
  - `createTurnPair` / `saveInteraction`: Persists paired `[user, model]` turns with optional internal monologue (`thought`).
  - `formatTurnWithInnerThought` / `formatHistoryWithInnerThought`: Restores model turns with `【思考・本音】...\n【発話】...` framing and localized timestamps.
- **Core Vectorization & RAG Retrieval (`src/ragMemory.ts`)**:
  - `cosineSimilarity`: Pure similarity math between numeric vectors.
  - `vectorizeText`: Embeds caller-supplied text via `IMemoryVectorEmbedder` with empty-input gating.
  - `indexVectorMemory` / `searchVectorMemories`: Channel-agnostic vector persistence and similarity lookup over `IMemoryRagStore`.
- **3-Tier Prompt Composition (`src/contextInjector.ts`)**:
  - `composeSystemPrompt`: Combines `@rebecca/persona` Layer 0 instructions, localized clock & rollout anniversary checks, dynamic few-shot anchors, Core Profile, RAG episodes, absence reaction, collective evolution trend, timeline summary, campaign context, parent post context, optional read-only public X overlay, and platform guidelines.
- **Asymmetric One-Way Memory Overlay (`src/compositeOverlay.ts`)**:
  - `composeAsymmetricMemoryOverlay`: Bridges read-only Public X memories (`users`, `rag_memories`, `timeline_history`) into isolated private session contexts without modifying public stores or leaking private interactions back to X.
- **Layer 1 Global Evolution (`src/evolution.ts`)**:
  - `GlobalEvolutionEngine`, `formatEvolutionConversationLogs`, `buildEvolutionSynthesisPrompt`, `buildEvolutionAuditPrompt`: Distills recent multi-user dialogue trends into an extended persona prompt, evaluates safety & alignment via an LLM-as-a-Judge audit, and persists validated updates via `IEvolutionMemoryStore`.
- **Layer 2 Self-Reflection (`src/selfReflection.ts`)**:
  - `SelfReflectionEngine`, `buildSelfReflectionPrompt`: Distills recent persona activities paired with the prior summary into Layer 2 long-term summary (`system/persona.timeline_summary`) with fail-fast blank-response protection via `ISelfReflectionStore`.
- **Layer 3 Dreaming Consolidation (`src/dreaming.ts`)**:
  - `DreamingConsolidationEngine` & `hasUnconsolidatedActivity`: Rate-limited (`throttleMs`) per-user episodic-to-CoreProfile assimilation engine abstracted over `IDreamingMemoryStore` and `IDreamingSynthesizer`.
- **Situational Persona Anchoring (`src/personaAnchoring.ts`)**:
  - `resolveSituationalPersonaAnchors`: Vector-similarity few-shot resolver parameterized by persona pattern vectors.

> Note: Google Search Grounding and Function Calling dialogue orchestration live separately in `@rebecca/tools` (`packages/tools`).

---

## Dependency Invariants

- Depends strictly on `@rebecca/types` and `@rebecca/persona`.
- Zero direct imports from `@google-cloud/firestore`, `@google/genai`, `@rebecca/logger`, or `apps/*`.
- Zero hardcoded character lore; all character identity, callsigns, birthdays, and prompts are injected via `IPersonaDefinition`.

---

## Testing

```bash
npm run build --workspace=@rebecca/memory
npm run test --workspace=@rebecca/memory
npm run lint --workspace=@rebecca/memory
```
