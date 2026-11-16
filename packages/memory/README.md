# `@rebecca/memory`

Channel-agnostic, infrastructure-independent cognitive memory core for persona-driven AI applications.

## Overview

`@rebecca/memory` provides a Hexagonal core for multi-tier persona memory, prompt assembly, episodic buffer management, semantic vector retrieval, and periodic memory consolidation. All persistence, embedding computation, and LLM synthesis operations are abstracted behind typed ports so host services retain complete ownership of infrastructure adapters and channel-specific workflows.

## Modules

- **Working Memory & Turn Reconstruction (`src/workingMemory.ts`)**: Bounded sliding-window retrieval (`getWorkingMemory`), `[user, model]` turn construction (`createTurnPair`, `saveInteraction`), and inner-monologue (`thought` / `reply`) prompt restoration (`formatTurnWithInnerThought`, `formatHistoryWithInnerThought`).
- **Core Vectorization & RAG Primitives (`src/ragMemory.ts`)**: Cosine similarity math (`cosineSimilarity`), text embedding gating (`vectorizeText`), and store-backed indexing/retrieval (`indexVectorMemory`, `searchVectorMemories`).
- **Multi-Tier Prompt Composition (`src/contextInjector.ts`)**: Composes persona system prompts from `@rebecca/persona` base definitions, localized time/anniversary context, retrieved RAG episodes, Layer 1–3 memory layers, customizable read-only overlays, and extensible host-provided context sections (`additionalSections`).
- **Asymmetric One-Way Memory Overlay (`src/compositeOverlay.ts`)**: Defensively clones read-only source snapshots into isolated target session views with configurable provenance tags (`composeAsymmetricMemoryOverlay`).
- **Layer 1 Global Evolution (`src/evolution.ts`)**: Synthesizes and safety-audits cross-user trend instructions (`GlobalEvolutionEngine`, `formatEvolutionConversationLogs`, `buildEvolutionSynthesisPrompt`, `buildEvolutionAuditPrompt`).
- **Layer 2 Self-Reflection (`src/selfReflection.ts`)**: Distills recent autonomous activities and prior summaries with fail-fast empty-output guards (`SelfReflectionEngine`, `buildSelfReflectionPrompt`, `DEFAULT_SELF_REFLECTION_SYSTEM_INSTRUCTION`).
- **Layer 3 Dreaming Consolidation (`src/dreaming.ts`)**: Rate-limited per-user assimilation of unconsolidated episodic buffers into long-term `UserCoreProfile` records (`DreamingConsolidationEngine`, `hasUnconsolidatedActivity`).
- **Situational Persona Anchoring (`src/personaAnchoring.ts`)**: Vector-similarity few-shot exemplar selection (`resolveSituationalPersonaAnchors`).

## Architectural Invariants

- Depends strictly on `@rebecca/types` and `@rebecca/persona`.
- Zero direct dependencies on database SDKs, LLM provider SDKs, or host applications.
- Channel-specific terminology, provenance labels, and workflow sections are injected by consuming services.

## Verification

```bash
npm run build --workspace=@rebecca/memory
npm test --workspace=@rebecca/memory
npm run lint --workspace=@rebecca/memory
```
