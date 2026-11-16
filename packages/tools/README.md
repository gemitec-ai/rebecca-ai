# `@rebecca/tools`

Shared LLM Function Calling registry, Google Search Grounding execution helpers, and Tatemae/Honne tool dialogue orchestration (`PersonaToolRegistry`, `runStructuredDialogueWithTools`, `executeGoogleWebSearch`, `SEARCH_WEB_TOOL`).

This package decouples runtime tool capabilities (Web search, session language switching, illustration selection) from `@rebecca/memory` so services such as `apps/bot-backend` and Private Lounge can share identical tool declarations and orchestration without coupling to `@google/genai` binaries or application SDKs.
