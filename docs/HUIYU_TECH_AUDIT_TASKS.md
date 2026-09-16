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

- Create `server/app.ts`
- Create `server/middleware/`
- Move initialization logic into modules
- Keep `server.ts` only as startup entry

Acceptance:

- server.ts reduced significantly
- Type checking passes
- Gateway tests pass

---

## TASK-002: Standardize API structure

Priority: P0

Actions:

Refactor routes into:

```
routes/
  feature/
    controller.ts
    service.ts
    schema.ts
```

Requirements:

- Request validation
- Unified response format
- Unified error handling

---

## TASK-003: Create application error system

Priority: P1

Create:

```
server/errors/
  AppError.ts
  ErrorCode.ts
  handler.ts
```

Replace uncontrolled errors with structured errors.

---

# Phase 2: AI Provider Architecture

## TASK-004: Create AI Provider interface

Priority: P0

Create abstraction:

```
providers/
  provider.ts
```

Required methods:

- generate()
- cancel()
- status()
- healthCheck()

---

## TASK-005: Extract Stable Diffusion provider

Priority: P1

Move SD communication into:

```
providers/stable-diffusion.ts
```

---

## TASK-006: Extract ComfyUI provider

Priority: P1

Move ComfyUI workflow and websocket logic into:

```
providers/comfyui.ts
```

---

# Phase 3: Data Architecture

## TASK-007: Add data schema validation

Priority: P1

Create schemas for:

- Scene
- Character
- Blueprint
- Prompt

Validate runtime data before loading.

---

## TASK-008: Create data repository layer

Priority: P2

Avoid direct JSON access from business code.

Create:

```
services/data/
  sceneRepository.ts
  characterRepository.ts
```

---

# Phase 4: Frontend Maintainability

## TASK-009: Split frontend by domain

Priority: P1

Recommended structure:

```
src/modules/
  studio/
  gallery/
  character/
  voice/
  video/
```

---

## TASK-010: Review Pinia stores

Priority: P1

Separate global state by domain:

- scene
- generation
- character
- settings

---

# Phase 5: Performance

## TASK-011: Image optimization pipeline

Priority: P1

Add automatic conversion:

```
source image
 -> webp
 -> thumbnail
 -> preview
```

---

## TASK-012: Bundle monitoring

Priority: P2

Track:

- JS size
- CSS size
- route chunks

---

# Phase 6: Security

## TASK-013: Centralize environment configuration

Priority: P0

Create:

```
config/env.ts
```

Manage:

- Tokens
- Hosts
- Runtime settings

---

## TASK-014: Add secret scanning

Priority: P1

Detect accidental commits of:

- API keys
- Tokens
- Passwords

---

# Execution Order

## Sprint 1

- TASK-001
- TASK-003
- TASK-007
- TASK-013

## Sprint 2

- TASK-004
- TASK-005
- TASK-006
- TASK-009

## Sprint 3

- TASK-008
- TASK-011
- TASK-012

---

This document will be expanded after deeper file-level audits.
