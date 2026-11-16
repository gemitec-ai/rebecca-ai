# `@rebecca/prompt`

Channel-agnostic prompt composition building blocks bridging `@rebecca/persona` and `@rebecca/memory`.

## Overview

`@rebecca/prompt` supplies reusable prompt section formatters, localized timezone utilities, situational few-shot anchor resolution, and a declarative prompt assembler. Host applications choose which blocks to include and control ordering cleanly without embedding channel assumptions inside persona or memory packages.

## Modules

- **Time Localization (`src/time.ts`)**: ECMA-402 `Intl.DateTimeFormat` clock extraction (`getZonedDateParts`, `formatZonedDateTime`) and time-bracket mapping (`resolveTimeContextPeriod`).
- **Situational Persona Anchoring (`src/personaAnchoring.ts`)**: Vector-similarity few-shot exemplar selection (`resolveSituationalPersonaAnchors`).
- **Modular Section Formatters (`src/sections.ts`)**: Standalone builders for current timestamp, persona birthday/anniversary checks, interlocutor identity, Layer 3 core profile, read-only external overlays, retrieved RAG episodes, time-of-day tone, absence reactions, Layer 1 trends, and Layer 2 activity summaries.
- **Prompt Assembler (`src/composer.ts`)**: Unified, anchoring-required entrypoint (`composeSystemPrompt`) combining Layer 0 identity, channel rules, dynamic situational anchors, optional localized temporal/birthday context, memory tiers, and host sections (`assemblePromptSections`).

## Verification

```bash
npm run build --workspace=@rebecca/prompt
npm test --workspace=@rebecca/prompt
npm run lint --workspace=@rebecca/prompt
```
