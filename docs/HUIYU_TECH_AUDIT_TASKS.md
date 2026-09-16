# HUIYU Technical Audit & Development Tasks

## Overview

Target: transform HUIYU from a feature-rich AI CG tool into a stable and maintainable AI creative platform.

Audit scope:

- Backend architecture
- AI provider system
- Data architecture
- Frontend structure
- Performance
- Security
- Testing

---

# Phase 1: Backend Architecture Stabilization

## TASK-001: Split server entry

Priority: P0

Problem:

`server.ts` currently handles too many responsibilities:

- Express initialization
- Middleware registration
- Security
- Static assets
- API routing
- AI service startup

Actions:

Create:

```
server/
├── app.ts
├── bootstrap.ts
├── middleware/
│   ├── security.ts
│   ├── compression.ts
│   └── static.ts
```

Move:

- express app creation
- middleware mounting
- static resource handling
- router registration

Keep `server.ts` only responsible for process startup.

Acceptance:

- server.ts reduced below 150 lines
- Existing API paths unchanged
- npm run typecheck passes
- npm run test:gateway passes

---

## TASK-002: Standardize API structure

Priority: P0

Current risk:

New features keep adding routes, making business logic difficult to locate.

Refactor:

```
routes/
  generation/
    index.ts
    controller.ts
    service.ts
    schema.ts
```

Requirements:

- Controller handles HTTP only
- Service handles business logic
- Schema validates input
- Errors use unified system

Acceptance:

All API responses follow:

```json
{
  "success": true,
  "data": {},
  "error": null
}
```

---

## TASK-003: Create application error system

Priority: P1

Create:

```
server/errors/
├── AppError.ts
├── ErrorCode.ts
└── handler.ts
```

Replace:

```
throw new Error()
```

with structured errors.

Required codes:

- AI_PROVIDER_OFFLINE
- MODEL_NOT_FOUND
- INVALID_REQUEST
- GENERATION_FAILED
- STORAGE_ERROR

Acceptance:

Frontend can display meaningful error messages without parsing strings.

---

# Phase 2: AI Provider Architecture

## TASK-004: Create AI Provider interface

Priority: P0

Create:

```
services/providers/
└── provider.ts
```

Interface:

```ts
interface AIProvider {
 generate()
 cancel()
 status()
 healthCheck()
}
```

Purpose:

Business logic should not know whether the backend is SD, ComfyUI, or another engine.

---

## TASK-005: Extract Stable Diffusion provider

Priority: P1

Create:

```
providers/stable-diffusion.ts
```

Move:

- API request handling
- model query
- generation request
- error conversion

Acceptance:

Generation workflow works without route knowing SD details.

---

## TASK-006: Extract ComfyUI provider

Priority: P1

Create:

```
providers/comfyui.ts
```

Move:

- workflow submission
- websocket progress
- queue status
- cancel handling

---

# Phase 3: Data Architecture

## TASK-007: Add data schema validation

Priority: P1

Create:

```
schemas/
├── scene.schema.ts
├── character.schema.ts
├── blueprint.schema.ts
└── prompt.schema.ts
```

Validate:

- required fields
- data version
- type consistency

---

## TASK-008: Create data repository layer

Priority: P2

Problem:

Business code directly reading JSON increases coupling.

Create:

```
services/data/
├── sceneRepository.ts
├── characterRepository.ts
└── promptRepository.ts
```

Provide methods:

- get()
- search()
- filter()
- update()

---

# Phase 4: Frontend Maintainability

## TASK-009: Split frontend by domain

Priority: P1

Create:

```
src/modules/
├── studio/
├── gallery/
├── character/
├── voice/
├── video/
└── live2d/
```

Move related components into domains.

---

## TASK-010: Review Pinia stores

Priority: P1

Separate:

```
stores/
├── scene.store.ts
├── generation.store.ts
├── character.store.ts
├── settings.store.ts
```

Avoid one global store becoming a dependency center.

---

# Phase 5: Performance

## TASK-011: Image optimization pipeline

Priority: P1

Create:

```
scripts/image-pipeline/
```

Pipeline:

```
Original
 ↓
Optimized WebP
 ↓
Thumbnail
 ↓
Preview
```

Goals:

- reduce package size
- improve gallery loading

---

## TASK-012: Bundle monitoring

Priority: P2

Track:

- initial JS
- route chunks
- CSS size
- asset size

Generate report after build.

---

# Phase 6: Security

## TASK-013: Centralize environment configuration

Priority: P0

Create:

```
config/env.ts
```

Manage:

- tokens
- hosts
- runtime flags
- feature switches

No direct scattered `process.env` usage.

---

## TASK-014: Add secret scanning

Priority: P1

Check commits for:

- API keys
- access tokens
- passwords

Add git hook or CI check.

---

# Phase 7: Product Data Improvements

## TASK-015: Generation history system

Priority: P2

Record:

- prompt
- model
- seed
- timestamp
- output image

Create:

```
generation-history/
```

Purpose:

Allow users to reproduce previous works.

---

## TASK-016: Prompt version management

Priority: P2

Support:

```
Prompt v1
Prompt v2
Prompt v3
```

Store changes instead of overwriting.

---

# Execution Order

## Sprint 1: Stability

- TASK-001
- TASK-003
- TASK-007
- TASK-013

## Sprint 2: Architecture

- TASK-002
- TASK-004
- TASK-005
- TASK-006

## Sprint 3: Maintainability

- TASK-008
- TASK-009
- TASK-010

## Sprint 4: Productization

- TASK-011
- TASK-015
- TASK-016

---

This document will continue expanding after deeper file-level audits.
