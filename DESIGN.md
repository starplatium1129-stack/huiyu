---
version: "alpha"
name: "绘遇 · HUIYU"
description: "绘遇 HUIYU：温暖、细腻的角色创作与故事画室。让想象成形，让故事相遇。"
colors:
  primary: "#EBA4B8"
  on-primary: "#1B181A"
  primary-hover: "#FFC4D8"
  secondary: "#C59DF8"
  neutral: "#0E1014"
  neutral-deep: "#0A0B0E"
  surface: "#15181F"
  surface-elevated: "#1D212B"
  text-primary: "#F4EFE9"
  text-secondary: "#B3ADA6"
  success: "#4ADE80"
  warning: "#FBBF24"
  danger: "#F87171"
  info: "#60A5FA"
  # 此元数据表描述画室深色基线；浅色覆盖见 src/assets/css/light-theme.css。
  # 暖墨画廊与中性绘制舞台共用暗底，樱粉与角色专属色承载强调。
  # 应用支持深浅主题与可选配色（暖墨和纸 / 夜樱晴空）；均需视觉验收。
  # frontmatter 是语义色板，CSS 实现用另一套名字，映射如下——
  #   primary→--accent, primary-hover→--accent-hover, secondary→--accent-violet,
  #   on-primary→--text-inverse, neutral→--bg-base, surface→--bg-surface,
  #   surface-elevated→--bg-elevated, disabled-text→--text-disabled,
  #   nene→--nene-violet, natsume→--natsume-amber。
  # disabled-text 为禁用态专用：不得用 opacity 压字（压后低于 AA 4.5:1）。
  disabled-text: "#9A948E"
  nene: "#C59DF8"
  natsume: "#E8B460"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Noto Sans SC, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "2.2rem"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  heading:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Noto Sans SC, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Noto Sans SC, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.7
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Noto Sans SC, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.5
  mono:
    fontFamily: "JetBrains Mono, Fira Code, Consolas, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.7
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
  3xl: "48px"
  4xl: "64px"
rounded:
  # 与 design-system.css --r-* 对齐：紧凑控件与较柔和的面板边界。
  sm: "8px"
  md: "8px"
  lg: "16px"
  xl: "20px"
  pill: "999px"
components:
  page-dark:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.text-primary}"
  surface-dark:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: "{spacing.xl}"
  surface-elevated:
    backgroundColor: "{colors.surface-elevated}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "40px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.on-primary}"
  button-disabled:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.disabled-text}"
  text-secondary-dark:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.text-secondary}"
  status-success:
    backgroundColor: "{colors.neutral-deep}"
    textColor: "{colors.success}"
  status-warning:
    backgroundColor: "{colors.neutral-deep}"
    textColor: "{colors.warning}"
  status-danger:
    backgroundColor: "{colors.neutral-deep}"
    textColor: "{colors.danger}"
  status-info:
    backgroundColor: "{colors.neutral-deep}"
    textColor: "{colors.info}"
  character-nene:
    backgroundColor: "{colors.nene}"
    textColor: "{colors.on-primary}"
  character-natsume:
    backgroundColor: "{colors.natsume}"
    textColor: "{colors.on-primary}"
  accent-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.on-primary}"
---

## Overview

绘遇 · HUIYU is a private Galgame creation studio—warm, precise, and artwork-first. The generated image, chosen character, and story moment are always the visual protagonists; UI chrome supports them without competing.

- **Single source of truth:** This file owns website and control-panel UI design. Runtime tokens live in `src/assets/css/design-system.css` (dark default) and `src/assets/css/light-theme.css`. Generated CG art direction stays separate in [art-direction.html](docs/guides/art/art-direction.html).
- **Implementation & rules:** Engineering motion/UI workflow lives in [studio-ui-design](.agents/skills/studio-ui-design/SKILL.md), upstream bounds in [Sources](.agents/skills/studio-ui-design/references/sources.md), and verification policy in [AGENTS.md](AGENTS.md).

## Reading guide

Start with [UI delivery standard](#ui-delivery-standard) and [Component and dependency policy](#component-and-dependency-policy), then inspect only the affected sections:

| Task | Design sections |
| --- | --- |
| Page composition or brand | [Product character](#product-character), [Layout](#layout), [Anime Visual Language](#anime-visual-language), [绘遇品牌](#绘遇品牌) |
| Theme or material | [Colors](#colors), [Elevation & Depth](#elevation--depth) |
| Text, spacing or geometry | [Typography](#typography), [Layout](#layout), [Shapes](#shapes) |
| Controls, forms or feedback | [Vue interaction components](#vue-interaction-components), [Components](#components) |
| Motion or performance | [Interaction & motion](#interaction--motion) |
| Drawing workspace | [Director stage](#director-stage), [绘制工作台 · 素材与参数](#绘制工作台--素材与参数) |
| Visual acceptance | [Desktop review](#desktop-review) and affected component states |

## UI delivery standard

Deliver visual clarity, coherent layout, accessible keyboard flows, and perceptible motion together in the first implementation—never defer shared control consistency, error/recovery states, or reduced-motion alternatives to a later pass.

- Before editing, identify the primary action, entry-to-recovery flow, applicable component states, shared style owners, and reference hierarchy.
- Keep affected pages within one component family and remove superseded local overrides.

## Product character

Anime and visual-novel atmosphere frame the tool:
- **Visual references:** Linear (hierarchy/geometry), Sakuria (card lift/zoom/soft highlights), Inspira UI / Magic UI / AIRI / WebGAL / Lucian (composition & motion). Adapt into one unified HUIYU family; never ship demo autoplay or simulated progress.
- **Home & routes:** Home sections expand up to `1800 CSS px` (`src/assets/css/home.css`) with a bounded reading plane, pairing character art (Nene / Natsume manual switch) with serif title and accent; recent works and scenes precede tools. Static portraits stay completely still (animation belongs to Live2D, route transitions, or voice feedback).
- **Quiet chrome:** Use faint dot motifs only on navigation/chapter furniture; keep labels short and status bars factual without decorative radar or coordinates.

## Colors

Dark uses warm ink for gallery pages and a neutral mat for creation tools. Light uses washi paper and readable rose-ink accents. Both preserve hierarchy and character identity.

| Role / CSS token | Dark | Light |
| --- | --- | --- |
| Canvas / `--bg-deep` | `#0A0B0E` | `#EAE4DA` |
| Workspace / `--bg-base` | `#0E1014` | `#F6F3EC` |
| Panel / `--bg-surface` | `#15181F` | `#FDFBF7` |
| Raised control / `--bg-elevated` | `#1D212B` | `#F0EBE2` |
| Main text / `--text-primary` | `#F4EFE9` | `#1B181A` |
| Supporting text / `--text-secondary` | `#B3ADA6` | `#5F585B` |
| Muted text / `--text-muted` | `#948E88` | `#6A6266` |
| Disabled text / `--text-disabled` | `#9A948E` | `#6A6266` |
| Primary action / `--accent` | `#EBA4B8` | `#9E3D5E` |
| Nene / `--nene-violet` | `#C59DF8` | `#6E439C` |
| Natsume / `--natsume-amber` | `#E8B460` | `#8D5818` |

- **Optional atelier palette (`data-theme-palette="yozakura"`):** 「夜樱晴空」 provides an alternative midnight-ink dark (`#10141F` / `#171C2A`, sakura `#F2A7BE`) and warmed gallery-snow light (`#F8F7FA` / `#FFFFFF`, rose ink `#A6345B`) under the 「绘遇画室」 style, keeping the warm-ink / washi baseline as default.
- **Theme style (`data-theme-style`):** Independent of dark/light mode. Default is 「绘遇画室」; 「泰拉瑞亚」 uses pixel woodgrain, paper panels, forest scenery, and an `8.5rem` (`136px`) wood sidebar at `>= 1440 CSS px` (supporting Up/Down keys, collapsing `< 1000px`). Pixel mode uses opaque surfaces; theme illustrations switch via `useThemeIllustration` without altering artwork or ratings. Standalone companion remains transparent; system forced-colors take priority.
- **Accent & contrast rules:**
  - Use Nene violet (`--nene-violet`) / Natsume amber (`--natsume-amber`) as contextual accents (`src/assets/css/director/tokens.css`), neutral pages use sakura pink (`--accent`). Keep resting controls neutral.
  - Maintain WCAG AA contrast across both themes and real artwork overlays (use local scrims/backings).
  - Disabled controls must use `--text-disabled` directly—never apply `opacity` to text-bearing disabled controls.
  - Never add gradient fills to body text, parameters, or metadata, and never invent duplicate color tokens.

## Typography

- **Primary language & stacks:** Chinese is primary (Established English terms like Scene, Prompt, LoRA, Seed, SD WebUI are fine when clear). Use system sans for controls/reading, Chinese serif (and Japanese Mincho for JP decor) on home opening, chapter titles, character names, and short dialogue; use `mono` strictly for prompts, seeds, model names, ports, paths, and machine state. Keep Chinese headings at normal tracking.
- **Hierarchy & wrapping:** Choose heading elements semantically (`15px` body / `13px` control labels / `24px` page headings on browse/studio pages). Keep reading prose start-aligned inside bounded columns; never insert manual line breaks for a single viewport, and ensure long paths/URLs wrap or truncate with accessible inspection/copy.
- **Tabular numbers:** Counts, durations, and progress values use tabular numerals in stable slots so adjacent units and actions do not jitter.

## Layout

- **Scale & containers:** `4/8/12/16/24/32/48/64px` spacing; `1200px` max width for standard pages; full viewport width (min `16px` outer gutter) for dense creative workspaces. Use `40px` standard / `32px` compact controls (`--control-height` / `--control-height-sm`) and `44×44 CSS px` minimum targets on coarse pointers.
- **Breakpoints:** Shared chrome uses `1000 / 768 / 480px`. Local content-driven thresholds: director uses `1440 / 1024 / 900px`; character directory uses `900 / 540px`. Verify both sides of every threshold in both themes.
- **Desktop navigation** sits below a separate 38px window title bar (44px on touch). The title bar holds the window controls and a draggable area. The navigation follows the page’s scrolling behavior. The pixel theme keeps its sidebar below the title bar.
- **Director hierarchy & workspace surfaces:**
  1. Canvas/result stage is largest and remains visible pre/post generation (`--bg-surface` empty canvas, `--bg-base` working/result, `--art-stage`/`--on-art-*` strictly for image mats/overlays). Display SFW art in full original proportion.
  2. Story/scene rail starts; director parameters sit secondary with progressive disclosure; prompt internals/diagnostics remain utilities.
  3. **Minimal copy rule:** Before adding labels, subtitles, or helper text, confirm they add necessary info—prefer layout, spacing, and alignment over explanatory prose. Keep validation limits, error recovery, and destructive confirmations explicit.
- **Resizing & layout hygiene:** Resizable rails respect available inline container width (accounting once for title chrome/nav); `Escape` during resize cancels and restores prior widths without closing surfaces. Pin quiet footers to viewport bottom (`margin-top: auto` in column flex body).

### Desktop review

Prioritize primary 4K, then 2K and 16:10 laptop logical viewports at 100% browser zoom:

| Priority / display | Physical resolution | Windows scale | Nominal logical area (CSS px) |
| --- | --- | --- | --- |
| Primary 4K, 16:9 | `3840 × 2160` | 150% / 200% | `2560 × 1440` / `1920 × 1080` |
| 2K, 16:9 | `2560 × 1440` | 100% / 125% | `2560 × 1440` / `2048 × 1152` |
| Laptop, 16:10 | `2560 × 1600` | 150% | `~1707 × 1067` |

Keep simulated DPR/viewport layout checks separate from real hardware sharpness and performance acceptance.

## Elevation & Depth

- **Surface & feedback:** Soft `1px` borders and shared surfaces establish grouping. Ordinary buttons, nav items, and filters lift `3px` on hover with readable character-accent ink; framed/filled controls, chips, segments, and disclosures use surface/border feedback without extra underlines (short hover underlines belong strictly to text links and nav). Inner press scales to `~0.98` without shifting hit targets; keyboard focus uses a clear neutral ring.
- **Glass & motion tokens:** Limit backdrop blur to floating utilities, nav, and director stage chrome (never stack blur layers or blur reading cards; always provide opaque fallbacks). Motion durations: `--motion-press` (`120ms`), `--motion-hover` (`240ms`), `--motion-control` (`280ms`), `--motion-surface` (`380ms`), with longer deliberate phases (`460–700ms`+) for route glides, artwork reveals, and particle formation.
- **System preferences:** Live-honor `prefers-reduced-motion`, `prefers-reduced-transparency`, increased contrast, and forced colors (including native dialog backdrops) without overwriting saved user preferences.

## Interaction & motion

- **Purpose & continuity:** Design motion with clear spatial depth, stagger, and rhythm; never degrade designed effects to plain fades merely because an action is frequent. Actions accept input and cancel immediately while animations retarget smoothly from their current value (`--ease-out` enter/exit, `--ease-in-out` on-screen, `--ease-drawer`, `linear` progress).
- **Theme switch reveal:** Sun/moon button expands a circular view-transition reveal (`--motion-theme-reveal`, `650ms`) from center using Lucian's pattern (no live layout animation or extra blur); repeated clicks reverse from current state; reduced-motion, modals, coarse pointers, forced-colors, and companion windows commit directly.
- **Performance & safety:** Animate only `transform` and `opacity` for high-frequency motion (no `transition: all`, no per-frame reactive tree updates, no `scale(0)` entrances). Apply `will-change` only for observed bottlenecks and release on unmount/KeepAlive deactivation. Adjacent tooltips in a group skip repeated open delay after the first opens. Hover effects gate on `(hover: hover) and (pointer: fine)`.

## Shapes

- **Radii & concentricity** use 8px for controls, 14–16px for gallery cards, and 22px for the main stage. Use pill geometry for filters, small badges, and segments. Keep inner radii concentric with the outer edge.
- **Cursors & scrollbars:** Use system cursors (`native-controls.css` adds smooth SVG `zoom-in`/`grab`/`grabbing` with forced-colors fallbacks). `studio-scrollbars.css` defines themed rounded scrollbars (`12px` drag target on Chromium/WebView2).

## Component and dependency policy

- **Mature reuse first:** Extend existing Studio primitives (`src/components/ui/`) or maintained Vue-compatible libraries (e.g. Reka UI) before writing custom behaviors; justify any handwritten exception explicitly.
- **Controllable source & single stack:** Keep adapted source in-repo with license attribution (never patch `node_modules`). Audit `package.json` and lockfile before adding dependencies—never maintain two competing UI kits, animation runtimes, or primitive stacks.
- **One design language:** Style adopted primitives exclusively via HUIYU tokens, typography, and motion in both themes.

## Vue interaction components

- `src/components/ui/` wraps Reka UI: `StudioSelect`, `StudioPopover`, `StudioTooltip`, `StudioMediaPlayer`. Views supply data only; shared wrappers own geometry, keyboard focus, portals (preserving live theme/motion updates), and animations. Details in [交互落地](.agents/skills/studio-ui-design/references/interaction.md#共享组件接入).

### Native browser chrome

Never ship unstyled native `<select>`, `<audio controls>`/`<video controls>`, HTML `title` tooltips (Vue `title` props remain valid), or `window.confirm`/`alert`/`prompt`. Extend `native-controls.css` for native checkboxes/radios instead of page-local overrides.

## Anime Visual Language

### Decor layers
- `RouteAtmosphere` owns one bounded, static character aura (no extra body glows or permanent `will-change`).
- Foreground petals belong strictly to the character room; global starfields and vertical watermarks are retired.

### Sticker & polaroid rules
- Chibi/polaroid frames (only for unpacked game assets) may tilt `±2deg` with rotated character-color stamps (`NENE` violet / `NATSUME` amber).
- Red `"綾季"` seal is reserved strictly for the footer colophon.

### Gradient text
- `background-clip: text` is permitted **only** on `.hero-title`, `.page-header` headings (including `.page-header h1`), and `.title-gradient`.

### Q-version assets
- Converted via `scripts/maintenance/chibi-import.py` into `480/960px` WebP pairs under `assets/chibi/` (medium-shot, full head + ahoge, clean background, no overlays). Never reuse a character's chibi in multiple contexts on the same page.

## Components

### Navigation
Short, stable top-level nav (`design-system.css` owns `.nav-back`, `.page-kicker`, `.page-title`, `.page-subtitle`, `.page-intro`, `.atelier-shell`, `.sticky-toolbar`, `.filter-pill`, `.empty-state`; `director/layout.css` & `workspace.css` own studio geometry). Collapsing/hiding a focused trigger transfers focus cleanly to its equivalent or logical reading position.

### Buttons
One primary action per region; secondary adjusts/inspects; danger interrupts/destroys. Never make critical actions icon-only. Low-frequency text actions use `btn-quiet`.

### Cards
Avoid nested cards unless boundaries are real interaction layers. Scene cards prioritize preview (`/scene-showcase/thumbs/<scene-id>.jpg`, graceful gradient fallback), title, character, and story cue; R18 scene/reference thumbnails stay blurred until hover/focus (user's own artwork album stays unblurred). Keep mono code (`SC-XXX`) and at most one quiet corner mark; never render internal tags like `official_cg` or `visual_audited`. Selected artworks use a rose border, indicator, and `--selection-shadow` without shifting layout geometry.

### Inputs and filters
Provide persistent accessible labels (placeholders are examples only). Selected chips/options use neutral surfaces, borders, and checkmarks—never red/pink fills. Collapse advanced parameters by default for newcomers. Validate on blur/submit (keep errors inline with first invalid field focused; preserve typed input). Maintenance UI uses plain language and staged saving with pre-save backup/validation.

### Director stage
Reserve media dimensions before decoding. Zoom/pan limits follow image & viewport bounds; in the 3D artbook, wheel over the image zooms around pointer (hitting zoom limits must not trigger page turns). Shared viewer sidebar/drawer behavior and modal focus-return rules live in [交互落地](.agents/skills/studio-ui-design/references/interaction.md#图片查看).

### Status and errors
Use short factual labels + actionable recovery (state + unaffected scope + next step). Implement all reachable flow states (`loading`, `empty`, `selected`, `disabled`, `success`, `failure/retry`, `cancelled`) on first delivery; never mask backend failure with reload/fake success. Raw logs stay behind disclosures.

### Character styling
Character art provides subtle contextual presence behind controls and stays crisp on character/result pages.

## Character presence and operational clarity

Discovery uses crisp art and brief dialogue; the character scene library retains interactive particle portraits (including switch reassembly and pointer feedback) without obstructing reading/controls. Keep copy warm in invitations and strictly literal in action labels, errors, and progress; keep raw resource filenames inside installation details.

## 绘制工作台 · 素材与参数

- **三栏格局与宽度（`useDirectorLayout`）**：
  - 宽桌面（`> 1440px`）：默认素材栏 `336px`（角色/场景/描述/专家历史，`v-show` 缓存）、画布主舞台、参数栏 `368px`、栏间距 `24px`（支持拖拽与方向键调节）。
  - 中等视口（`1024–1440px`）：默认显示画布与 `320px` 参数栏，素材通过主区切换并提供「返回画布」（与 `Escape` 共用返回及返焦）。
  - 窄屏（`< 1024px` 参数下置，`< 900px` 单列并提供锚点导航）；专注模式保留单画布与动作条。
- **参数与提示词展示**：
  - 参数栏遵循「引擎 → 模型 → 画幅 → 风格」，固定底部动作条（隐藏参数或专注时回归画布上方）；画布下方常驻入册、存为场景、对比与清除。
  - **Anima 五层着色**（对应六段编译顺序，展示合组不改编译）：质量/分级（暖金）、角色与作品（角色强调色）、画师（紫）、画面标签（蓝）、自然语言（青绿）；Krea 保持纯自然语言阅读。避免在固定侧栏嵌套多层滚动面板；负向词、模型与 LoRA 详情按需展开，提供宽幅阅读入口。

## Iconography

- 统一使用 `ArchiveIcon` 手绘单线 SVG（`24×24` 坐标系、`1.65` 主线宽、圆角端点/连接、`currentColor` 描边、`fill="none"`）；纯图标按钮必须具备可访问名称；严禁内部硬编码颜色。
- 常用相近图标（关闭 vs 错误、灵感 vs 收藏、放大 vs 收拢）需保持轮廓区分；按角色语义设计（如开放风景=场景、场记板=剧情、衣架=服装、九宫格=三分构图）。交付前同时校验 `16px` 与 `24/40px` 清晰度。

## 绘遇品牌

- **品牌标识**：绘遇 · HUIYU（标语：让想象成形，让故事相遇）。品牌辅助色为墨紫 `#211C30`、暖白 `#FFF8F4`、樱花粉 `#F2A8BE`、浅紫藤 `#C5B5E8`；浅色背景文字/图标采用深墨或深玫瑰保证对比度。
- **资产生成**：母版为 `assets/brand-mark.svg`，通过 `npm run wf -- brand:build` 生成深浅字标（`BrandLogo` 自动切换，无滤镜发光）、favicon、ICO 与安装器路径。
- **兼容标识**：内部包名 `com.aics.studio`、目录 `AI-CG-Studio`、可执行文件名、注册表路径与备份协议保持不变，用户可见品牌统一为「绘遇」。
