# Character Intellectual Property & Brand Assets Notice

## Separation of Software License and Character IP

This repository operates under a strict separation between **Software Source Code** and **Character Intellectual Property (IP)**:

1. **Software Source Code (MIT License)**  
   Unless otherwise noted, the underlying software architecture, orchestration pipelines, cognitive memory packages (`packages/memory`, `packages/prompt`, `packages/tools`, `packages/db`, `packages/logger`, `packages/types`), the generic persona framework in `packages/persona` (`src/basePersona.ts`, `src/types.ts`), and backend/frontend application code (`apps/*`, excluding the Character IP & Brand Assets specified in Section 2) are licensed under the [MIT License](LICENSE). Developers are free to fork, modify, self-host, and commercially build upon this codebase using their own original characters and personas.

2. **Character IP & Brand Assets (All Rights Reserved)**  
   The MIT License does **NOT** grant rights to exploit the character identity, brand marks, lore, or visual/creative assets of **"Rebecca" (レベッカ / Unit-001)** or **"Gemitec Inc."**, including without limitation:
   - Character definitions, lore, dialogue datasets, and precomputed persona embeddings (`packages/persona/src/personas/rebecca.ts`, `packages/persona/src/data/personaPatterns.json`, `packages/persona/src/personaPatternVectors.ts`)
   - Official illustrations, character portraits, icons, favicons, badges, screenshots, audio/video works, and brand logos (including assets under `apps/portal-web/public/`, `apps/dashboard-frontend/public/`, `docs/rebecca_landscape.jpg`, and `screenshots/`)
   - Official character names, trademarks, social handles, character-specific portal narrative copy, and officially shared LoRA model weights

   All rights to the Character IP and Brand Assets above are reserved by **AKINA** (Operator of the Rebecca AI Project / Gemitec Inc. creative project). Non-commercial community fan art and derivative works (including fan art generated via the officially shared PixAI LoRA model) are governed by the official [Creative & Derivative Works Guidelines](https://rebecca-ai.net/guidelines).

3. **Limited Developer Exception (Local Testing & Contributions)**  
   Developers cloning this repository may copy and execute the included Rebecca persona files strictly on local or private development environments for software evaluation, automated testing, or submitting Pull Requests to this repository, provided all Rebecca Character IP and Brand Assets are removed and replaced with an original persona prior to any public deployment, commercial hosting, or redistribution.
