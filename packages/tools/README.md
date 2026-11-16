# `@rebecca/tools`

Provider-agnostic JSON Schema tool declarations, registry management, and multi-round Function Calling orchestration primitives.

## Overview

`@rebecca/tools` defines clean domain abstractions and execution loops for LLM Function Calling workflows without coupling to any specific AI SDK, transport protocol, or persistence layer.

- **Tool Registry & Declarations (`PersonaToolRegistry`, `ToolDeclaration`, `ToolDefinition`)**: Standard JSON Schema parameter contracts paired with async execution handlers and conflict detection.
- **Web Lookup Contract (`IWebSearchProvider`, `SEARCH_WEB_TOOL_DECLARATION`, `createSearchWebTool`)**: Reusable `search_web` schema and input-normalizing adapter wrapper backed by an injected search provider port and configurable fallback responses.
- **Multi-Provider Dialogue Orchestrator (`runToolDialogueLoop`, `ILLMToolDialogueClient`, `EmptyDialogueResponseError`)**: Provider-neutral tool loop operating on `'user' | 'assistant'` turns, explicit tool invocation `id` correlation, opaque provider turn passthrough, and callback-injected output parsing.

## Architectural Boundary

- Zero dependencies on AI provider SDKs or internal workspace libraries.
- Infrastructure adapters implement `ILLMToolDialogueClient` and `IWebSearchProvider` at the application boundary, mapping neutral roles and JSON Schema declarations into SDK payloads (e.g., Gemini, Azure OpenAI).

## Verification

```bash
npm run build --workspace=@rebecca/tools
npm test --workspace=@rebecca/tools
npm run lint --workspace=@rebecca/tools
```
