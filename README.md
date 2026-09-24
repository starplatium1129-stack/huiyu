# 绘遇 · HUIYU

> A local creative studio for turning story moments into Galgame-style AI CGs, 4-perspective character reference bibles, and AI narrative short films.

[中文说明](README_zh.md)

[Download HUIYU 1.7.2 for Windows](https://github.com/starplatium1129-stack/huiyu/releases/tag/v1.7.2) · [Release notes](docs/releases/v1.7.2.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Current counts and capability boundaries: [Project status](docs/project-status.md). Next steps: [Roadmap](docs/roadmap.md).

## About

绘遇 (HUIYU) is a personal hobby project built for local use and occasional sharing with trusted friends. It is not a hosted service, public community, or commercial platform.

The system supports Ayachi Nene, Shiki Natsume, and a growing catalog of anime/game characters and outfits. A Scene keeps story, character, mood, camera, composition, lighting, prompt, LoRA, and generation settings together. Current counts and incomplete assets are tracked only in [Project status](docs/project-status.md).

This is an unofficial, non-commercial fan project and is not affiliated with or endorsed by the original rights holders.

## Features

- **Scene & Character Libraries**:
  - Searchable Scenes and Scene Blueprints, classified as All, R15, or R18 by depicted content.
  - Characters from multiple anime and game series, with character-specific outfits and scene presets.
  - Reviewed showcase samples in `AI/SceneShowcase/`, with direct links into the studio; availability depends on local assets.
- **4-Perspective Character Reference Bible**:
  - Four cinematic reference perspectives plus front, side, and back design sheets. Registered, pending, available, and visually reviewed assets are distinguished in [Project status](docs/project-status.md).
  - Generate isolated candidates and run automated checks, then record human review before explicitly publishing an immutable version. Missing review stays pending; see the [reference workflow](docs/workflow.md#参考库候选审核与版本发布).
  - Standardized reference asset contract for downstream MiniMax H3 Ref2VA identity locking.
- **Multi-Engine Generation & Curated Artist Styles**:
  - Automatic prompt compilation across Stable Diffusion / WAI (Danbooru tags), Anima (native `@artist` + tag format, current default checkpoint MiaoMiao Harem v1.2), and Krea 2 Turbo (natural language prose).
  - Curated anime artist & chief animation director styles (e.g. Nekotomi Chao / 猫富ちゃお, Kyoji Asano / WIT Studio, Rella moonlight, Misaki Kurehito, Muririn, Kobuichi, So-bin, etc.).
  - Regional Prompter dual-character composition stabilization on reForge.
- **AI Narrative Video Studio**:
  - Local AI video creation supporting Wan 2.2 TI2V and MiniMax H3 (Ref2VA reference image binding).
  - Intelligent shot list script decomposition, style anchor injection, and explicit dialogue language control (`dialogueLang: auto/zh/ja/en`).
- **Character Space & Voice Pipeline**:
  - Local character room backed by Ollama / OpenAI-compatible APIs with streaming sentence-level Japanese / Chinese voice synthesis (GPT-SoVITS).
  - Live2D lip sync driven by audio amplitude and emotion-matched expressions.
  - VRAM resource scheduler: one-click draw-first / chat-first modes with automatic model unloading.
- **Desktop Companion (Tauri 2)**:
  - Lightweight desktop shell with Companion + Atelier dual windows, system tray, Native Live2D overlay, and elevated quick-deploy pipeline (`deploy-desktop-quick.ps1`).

## Installation

### Prerequisites

| Component | Required | Notes |
| :--- | :---: | :--- |
| Node.js | **Yes** | `>= 22.18` (npm 11.x), check with `node -v` |
| Windows | **Yes** | Primary environment; launcher & desktop shell are Windows-first |
| A1111 / Forge / ReForge WebUI | Optional* | Started via Stability Matrix with `--api --port 7860` launch args — needed for SD/WAI generation |
| ComfyUI | Optional* | On `http://127.0.0.1:8188` — needed for the Anima / Krea 2 / Wan / H3 engine paths |
| cloudflared | Optional | Only for temporary public share links |
| GPT-SoVITS | Optional | Only for AI voice lines (role-specific weights) |
| Ollama | Optional | Only for character chat in the Character Space |

\* At least one image engine must be reachable for generation; browsing Scenes, prompts, and the reference bible works without any of them.

### Step 1 — Get the code

```bash
git clone https://github.com/starplatium1129-stack/huiyu.git
cd huiyu
```

### Step 2 — Install dependencies

```bash
npm install
```

`control.bat` also runs this automatically on first launch.

### Step 3 — Build the runtime services

Fresh clones must compile the TypeScript runtime once — the generated `.js` files are gitignored:

```bash
npm run build:runtime
```

`npm start` and the launchers (`control.bat` / `start.ps1`) already do this via the `prestart` hook, so you can skip this step if you launch through them.

### Step 4 — Start

**A. Control panel (recommended).** Start your WebUI first (note the address from its log, usually `http://127.0.0.1:7860`), then double-click `control.bat`, confirm the WebUI address, click **启动并生成分享链接**, and finally **打开本地网站（无需 Token）** for local use — or copy the token-protected link to share with a friend. Click **停止全部服务** when done.

**B. Manual (troubleshooting / full logs).**

```powershell
npm install
npm run build:runtime
$env:SD_HOST = 'http://127.0.0.1:7860'   # WebUI address
node server.js
```

Skip the tunnel with `$env:DISABLE_TUNNEL = '1'` if you only need the local gateway. Press `Ctrl+C` to stop.

**C. Development (HMR).** Run two terminals:

```powershell
npm run dev:server   # Express gateway on :3000 (API, SD proxy, static)
npm run dev          # Vite dev server with HMR on :5173
```

Full setup details, optional components (voice, chat, dual-character composition), and troubleshooting live in [STARTUP.md](STARTUP.md).

## Usage examples

### A. From a Scene to a finished image

1. Open the **Scene Library** (`场景库`), filter by character / content rating, and pick a Scene — story, mood, camera, lighting and prompt are already assembled.
2. Enter the **Director's Studio** (`导演台`), pick one of the 38 curated artist styles, and hit generate.
3. The prompt compiler automatically targets the active engine: SD/WAI (Danbooru tags), Anima (native `@artist` + tag format, current default checkpoint MiaoMiao Harem v1.2), or Krea 2 Turbo (3–5 sentences of natural-language prose).

### B. AI narrative short film (click-only flow)

1. Open a Scene Blueprint → **一键剧本** (auto 4-shot storyboard: setup → conflict → twist → resolution, dialogue taken from the Scene) → **一键首帧** (first frame per shot via the Krea 2 enhanced chain) → batch generation + tail-frame stitching.
2. Supports Wan 2.2 TI2V and MiniMax H3 Ref2VA identity locking; dialogue language is explicit via `dialogueLang: auto/zh/ja/en`.

### C. Character room, voice & desktop companion

- **更多 → 角色对话** connects to local Ollama; enable **回复后自动配音** to route replies through the local translation pipeline into GPT-SoVITS Japanese voice, with Live2D lip-sync following the audio amplitude.
- The Tauri 2 desktop Companion (`npm run dev:tauri` to develop, `npm run package:tauri` to build an NSIS installer) adds a frameless always-on-top character overlay with tray menu and global hotkeys.

### D. Everyday command-line operations

```powershell
npm run workflow -- --help          # unified entry for 140+ maintenance scripts
npm run workflow -- data:validate   # verify data shards & DATA_VERSION after editing scene data
npm run workflow -- gate:quick ui   # layered quality gate by change area (ui/server/data/all)
npm run scenes:import               # rebuild data/scenes.json from shards (batch-aware)
npm run popular:build               # rebuild data/popular-characters.json
npm run build                       # production bundle + 140KB route budget + precompression
```

The complete script index is in [docs/workflow.md](docs/workflow.md).

## Contributing

This is a personal project first, but well-scoped contributions are welcome. Before touching anything, read in this order: [docs/INDEX.md](docs/INDEX.md) (master doc index) → [docs/workflow.md](docs/workflow.md) (unified script entry) → **AGENTS.md** (collaboration charter — the highest authority in this repo).

### Development setup

See Installation Step 4-C (two terminals: Express gateway + Vite HMR). `npm run typecheck` and `npm run lint:js` give quick feedback while editing.

### Quality gates — must pass before any commit

```
[1. State/logic self-test] ─► [2. Type check] ─► [3. Contract tests] ─► [4. Build budget] ─► [5. Precise commit]
```

```powershell
npm run typecheck:app           # zero errors for Vue SFCs
npm run workflow -- check:full  # full validation suite (13 parallel checks + unit + contract)
npm run build                   # production build, 140KB per-route budget
```

For fast iteration run only the area you touched: `npm run workflow -- gate:quick ui|server|data|all`. `npm run validate` intentionally does not run the production build; run `npm run build` separately when the release bundle or bundle budgets are in scope. When the private reference root is unavailable, use the hermetic structure contract explicitly (PowerShell): `$env:AICS_REFERENCE_AUDIT_MODE='structure'; npm run validate`; do not treat that as physical-asset approval.

### Commit discipline (hard rules)

- **Never run `git add .`** — stage only the verified files you changed (review `git status` and `git diff` first). Do not sweep up someone else's in-flight work.
- **Never use `git reset --hard`** or other destructive commands.
- One concern per commit; pass the gates before committing, not after.

### Non-negotiable engineering rules

- **GPU-composited animations only.** Transitions must animate `transform`/`opacity`; tweening `left/top/width/height` fails the lint gate (`npm run lint:animations`) unless annotated `/* compositor-exempt: <reason> */`.
- **Hand-drawn line icons.** New icons must use the Hand-drawn Linear SVG mechanism (`ArchiveIcon.vue`); emoji and solid-filled icons are forbidden.
- **Content rating is fail-closed.** R18 content renders blurred by default; `adultEligibility` + `adultEnabled` double-gate, and unknown/unauthorized states must be rejected — never fall back to "safe".
- **Pinned scenes are byte-level baselines.** The 100 pinned scenes in `data/prompt-pinned-scenes.json` must never be touched by bulk tools (`npm run scenes:pin` enforces this). Changing one requires a real image test first.
- **No template-based bulk delivery.** Batch rewrites must be genuinely rewritten per item and pass `test-prompt-rewrite-integrity.js` (coverage = claimed count, no template fingerprints, ≤50% retained entries, ≤60% prose similarity).
- **Dual theme.** Light and dark themes are both supported; new UI must be reviewed in both themes. Use the `--text-disabled` token for disabled states, never `opacity`.
- **Style contracts come from DESIGN.md** — the runtime CSS is a derived implementation; resolve conflicts in favor of the contract.

### Tests

```powershell
npm run test:frontend   # vitest unit tests
npm run test:unit       # quality-suite unit group
npm run test:contract   # content & API contract tests
npm run test:e2e        # Playwright end-to-end (builds first)
```

### Documentation

New documents and major updates must be registered in [docs/INDEX.md](docs/INDEX.md). The docs stay in sync with what the code actually does — stale comments and contracts are treated as defects.

## Project layout

```text
huiyu/
├── DESIGN.md               # Website and control-panel design contract
├── AGENTS.md               # Collaboration rules, quality gates & operational constraints
├── index.html              # Vite SPA entry point (no global scripts)
├── vite.config.ts          # Vite build config + dev proxy to Express
├── control.bat             # Windows control panel launcher
├── server.js               # Express: static serving, SD proxy, sharing
├── src/                    # Vue 3 SPA source (Vite build target)
│   ├── config/             #   Character constants, artist styles, prompt definitions
│   ├── utils/              #   Stream parsing, character reference data, prompt compiler
│   ├── stores/             #   Pinia: scene data, prompt-builder state
│   ├── composables/        #   Chat storage, Live2D, voice, SD generate, IndexedDB
│   ├── components/         #   AppLayout, AppNav, SceneCard, Video Studio components
│   ├── views/              #   One .vue per route (all lazy-loaded)
│   └── assets/css/         #   Design system tokens, component styles
├── routes/                 # Express API routes (chat, voice, live2d, video, maintenance)
├── services/               # TypeScript runtime services (Ollama, TTS, HTTP client…)
├── desktop-tauri/          # Tauri 2 shell, Native Live2D overlay, sidecar and packaging
├── types/                  # Shared TypeScript type definitions
├── data/                   # Runtime JSON: scenes, characters, tags, blueprints, reference standards
├── assets/                 # Static assets: character images, Live2D models, vendor SDKs
├── docs/                   # Creative standards, quality checks, master index (docs/INDEX.md)
├── scripts/                # Maintenance, tests, reference generation, and runtime helpers
└── runtime/                # Local config, logs, process state, generated outputs (gitignored)
```

## Validation

```powershell
npm run typecheck:app     # TypeScript check for Vue SFCs
npm run validate          # Quality checks + frontend/unit/contract suites (does not build)
npm run build             # Production bundle, route budgets, and precompression
```

For current implementation details, verification baselines, and the complete documentation index, see [docs/project-status.md](docs/project-status.md) and [docs/INDEX.md](docs/INDEX.md).

## Scope

The project stays intentionally small: reliable local creation, high-quality Scene and reference assets, straightforward maintenance, and safe temporary sharing come first. Accounts, subscriptions, a public Scene store, and community uploads are not planned.

## License

MIT — see [LICENSE](LICENSE). The character content and original works belong to their respective rights holders; this project is an unofficial fan work and does not claim ownership of them.

> Prompts describe images. Scenes describe moments.
