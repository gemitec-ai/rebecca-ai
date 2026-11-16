# `@rebecca/tools`

Provider-agnostic JSON Schema tool declarations, registry management, and multi-round Function Calling orchestration primitives.

## Overview

`@rebecca/tools` defines clean domain abstractions and execution loops for LLM Function Calling workflows without coupling to any specific AI SDK, transport protocol, or persistence layer.

- **Tool Registry & Declarations (`PersonaToolRegistry`, `ToolDeclaration`, `ToolDefinition`)**: Standard JSON Schema parameter contracts paired with async execution handlers and conflict detection.
- **Web Lookup Contract (`IWebSearchProvider`, `SEARCH_WEB_TOOL_DECLARATION`, `createSearchWebTool`)**: Reusable `search_web` schema and input-normalizing adapter wrapper backed by an injected search provider port.
- **Dialogue Loop Orchestrator (`runToolDialogueLoop`, `EmptyDialogueResponseError`)**: Multi-round tool call dispatch and validation loop operating on neutral conversation turns and callback-injected model adapters.

## Architectural Boundary

- Zero dependencies on AI provider SDKs or internal workspace libraries.
- Infrastructure adapters in consuming services translate `ToolDeclaration` and `ToolDialogueStepContext` into SDK-specific payloads and implement `IWebSearchProvider`.

## Verification

```bash
npm run build --workspace=@rebecca/tools
npm test --workspace=@rebecca/tools
npm run lint --workspace=@rebecca/tools
```
