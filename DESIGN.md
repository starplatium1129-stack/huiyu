---
version: "alpha"
name: "绘遇 · HUIYU"
description: "绘遇 HUIYU：温暖、细腻的角色创作与故事画室。让想象成形，让故事相遇。"
colors:
  primary: "#F2A8BE"
  on-primary: "#120C1A"
  primary-hover: "#FFC4D8"
  secondary: "#B784F6"
  tertiary: "#7FE7FF"
  neutral: "#211C30"
  neutral-deep: "#181420"
  surface: "#272135"
  surface-elevated: "#30283D"
  text-primary: "#FFF8F4"
  text-secondary: "#C8C7D2"
  success: "#81C784"
  warning: "#FFA726"
  danger: "#FF9B8F"
  info: "#90CAF9"
  # 2026-09-08: 此元数据表描述深色基线；浅色覆盖见 src/assets/css/light-theme.css。
  # 2026-09-01: 升级为甜系 Galgame 夜主题：高饱和樱花粉 + 薰衣草紫。
  # 2026-09-02: 方向 A 二次元博客质感优化：基底调校为澄澈绀蓝夜空、升级日系药丸胶囊微光标签与亚克力边缘高光。
  # 应用支持深浅主题；两种主题都需要视觉验收。
  # frontmatter 是语义色板，CSS 实现用另一套名字，映射如下——
  #   primary→--accent, primary-hover→--accent-hover, secondary→--accent-violet,
  #   on-primary→--text-inverse, neutral→--bg-base, surface→--bg-surface,
  #   surface-elevated→--bg-elevated, disabled-text→--text-disabled,
  #   nene→--nene-violet, natsume→--natsume-amber。tertiary 为历史语义色无直接对应。
  # disabled-text 为禁用态专用：不得用 opacity 压字（压后低于 AA 4.5:1）。
  disabled-text: "#A6A9BC"
  nene: "#B784F6"
  natsume: "#FBB040"
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
    fontSize: "0.85rem"
    fontWeight: 600
    lineHeight: 1.4
  mono:
    fontFamily: "JetBrains Mono, Fira Code, Consolas, monospace"
    fontSize: "0.82rem"
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
  # 2026-09-01: 甜系升级，与 design-system.css --r-* 对齐（大圆角萌系贴纸感）。
  sm: "8px"
  md: "10px"
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
  accent-tertiary:
    backgroundColor: "{colors.tertiary}"
    textColor: "{colors.on-primary}"
---

## Overview

绘遇 · HUIYU is a personal Galgame creation desk, not a generic dashboard and not
a public AI platform. Its visual character is quiet, intimate, precise, and
slightly romantic. It should feel like opening a private visual-novel art book
inside a capable creative tool.

The generated image, the chosen character, and the story moment are always the
visual protagonists. Interface decoration supports those three things and never
competes with them. Sakura pink is the primary interaction accent; silver violet
belongs to Ayachi Nene, while amber and coffee tones belong to Shiki Natsume.

This file is the single source of truth for website and control-panel design.
`src/assets/css/design-system.css` is its runtime implementation. When the two
disagree, update the CSS to follow this document. `docs/guides/art/art-direction.html` is
intentionally separate: it specifies the visual direction of generated CG
artwork, not website UI.

## Product character

Anime and Galgame establish the identity: characters, intimate dialogue, artwork,
and the feeling of entering a story. Apple supplies the discipline: a predictable
layout, optical spacing, readable typography, quiet materials, and immediate
feedback. Every surface belongs to this same atelier.

The home opening is a single character scene with a calm reading plane and
manual Nene/Natsume selection. Scene and character discovery precede the tool
catalog. Utilities use short labels and progressive disclosure. Status bars
communicate actual state without decorative radar, arbitrary coordinates, or
repeated chapter totals. Compact collection headers reserve the space for works.

Ayachi Nene and Shiki Natsume are the primary routes rather than interchangeable
skins. Empty states, conversation starters, scene discovery, and character
accents may reflect their different temperaments. Static character art must stay
completely still; animation belongs to a validated Live2D model, page transition,
or voice feedback—not to periodic transforms on a still portrait.

## Colors

The atelier supports dark and light themes, with dark as the default. Dark
surfaces use graphite-violet; light surfaces use paper-white and readable ink
accents. Both themes preserve the same layout, action hierarchy, and character identity.

> **2026-09-08 · 当前双主题契约**
> 浅色已恢复，入口为 AppThemeToggle/useTheme，覆盖在 light-theme.css。
> 本文色板为深色基线；新增颜色需适配两个主题，角色强调色与图片上文字分别验收。
> check-contrast.js 核算双主题全局令牌与角色强调色；浏览器计算样式和视觉审查仍须覆盖动态组件与图片叠字。
> ui-layout.spec.ts 的实际文字检查逐层合成文字 alpha、背景与祖先 opacity；图片和渐变背景继续用实际像素与深浅主题截图验收，不能把令牌通过视作页面整体 AA 通过。

- Use `primary` only for the current selection, the main call to action, focus,
  or a small piece of emphasis. A page must not look uniformly pink.
- Use Nene violet and Natsume amber to clarify character context. Within a
  character cover or director workspace, the primary action may inherit that
  character accent; navigation and neutral pages retain sakura pink.
- Keep body text neutral. Long paragraphs, parameters, and metadata must not use
  decorative gradients.
- Success, warning, danger, and information colors communicate state only.
- Maintain WCAG AA contrast for normal text. If a translucent surface makes
  contrast uncertain, use its opaque fallback.
- Do not introduce a near-duplicate color when a token already expresses the
  same role.

Runtime surfaces may use the alpha values already defined in
`src/assets/css/design-system.css`; the opaque colors in the front matter are
their validation fallbacks. Disabled controls must use the `--text-disabled`
token directly — never `opacity` on a text-bearing control, because alpha
compositing drops it below AA.

## Typography

Chinese text is primary. English labels such as Scene, Prompt, LoRA, Seed, and
SD WebUI may appear when they are established terms, but must not make an action
harder to understand.

- Use the system sans stack for controls and reading. The home opening and short
  character dialogue may use the serif stack for visual-novel intimacy.
- Use the mono stack only for prompts, seeds, model names, ports, paths, and
  machine-readable state.
- Headings are compact and confident, not oversized landing-page slogans.
- Buttons use short verbs. Error messages state what happened and what the user
  can do next.
- Never depend on font weight or color alone to distinguish a critical state.

## Layout

Use the 4/8/12/16/24/32/48/64 spacing scale. Normal pages use a `1200px` content
maximum. Dense creative workspaces may use the available viewport width while
preserving at least `16px` outer breathing room.

Shared page chrome uses `1000 / 768 / 480px` as its default responsive scale.
Content-driven layouts can use their own thresholds: the director workspace
uses `1200 / 900px` for its inspector and material rails; the character directory
uses `900px` for its rail and `540px` for its dialog cards. These are local
layout decisions, not additional global device categories. Prefer the shared
scale unless actual content needs another threshold, document the reason near
the owning rule, and verify both sides of each changed threshold in both themes.

The director workspace follows an image-first hierarchy:

1. The canvas/result stage is the largest region and remains visible before and
   after generation.
2. Story and scene selection form the starting rail.
3. Director decisions form a secondary rail with progressive disclosure.
4. Prompt internals, model details, backup, and diagnostics are utilities, not
   the default visual focus.

At wide desktop sizes, side rails should be approximately `268–324px`; remaining
width belongs to the stage. After an image exists, do not shrink it merely to
show every control without scrolling. Empty space must either frame the artwork,
clarify grouping, or improve touch/click accuracy. Large blank zones with no
communicative purpose are a layout defect.

Desktop is the primary creation environment. Responsive order is stage first,
then story/scene, then detailed decisions. On small screens, controls become a
single column, primary actions stay reachable, and tap targets should be at least
`44 × 44 CSS px` for shared buttons and navigation on coarse pointers. This is a
project touch target, not an Apple platform point conversion. Expand controls in
normal layout without overlapping neighboring targets; retain desktop text size
on narrow screens. Mobile compatibility must not weaken the desktop stage.

Scene discovery must expose search and the most useful filters near the results.
Do not require a friend who has never used the site to understand the taxonomy
before they can find a scene.

The footer is a quiet colophon, not a floating island: pages keep it pinned to
the bottom of the viewport on short content (`body` is a column flex container
and the footer uses `margin-top: auto`), so no page shows a stranded footer with
empty space beneath it.

## Elevation & Depth

Depth is restrained and functional:

- Level 1: static information, soft border, little or no shadow.
- Level 2: selectable cards and controls, modest hover lift.
- Level 3: the primary action, active modal, or artwork viewer.

Glass surfaces are allowed for navigation, floating utilities, and the director
stage chrome. They must have an opaque fallback and must not be stacked until
text becomes hazy. Prefer one clear surface boundary over several nested glowing
cards. Motion uses the existing `150ms` and `240ms` timings; page and character
transitions may be slightly slower, but never delay an action.

Honor `prefers-reduced-motion` and `prefers-reduced-transparency`.
System transparency, increased contrast, and forced colors must update material
fallbacks live, including native dialog backdrops, without changing the saved
manual preference. Restoring the system setting restores the user's own choice.

## Shapes

Use `8–10px` radii for inputs and compact controls, `14–20px` for cards and
sections, and pill shapes only for filters, small status badges, and segmented
controls. The artwork viewer or main stage may use a larger optical radius (up
to 32px) when it reads as one continuous frame.

Do not mix sharp system-tool rectangles, soft consumer-app pills, and oversized
glass bubbles in the same control group. Icon geometry, border weight, radius,
and padding must make adjacent controls feel like one family.

## Anime Visual Language

The identity comes from authored character artwork, emotional scene choices,
short dialogue, and restrained character color. Controls are flat, precise,
and consistently spaced. Glowing surfaces and stickers are not a substitute
for character presence.

### Theme semantics

- Dark graphite-violet and light paper surfaces share the same semantic tokens.
- Preserve all per-character director tokens and body aura mappings in
  src/assets/css/director/tokens.css.
- Accent colors identify selections, focus, and primary actions. Neutral text
  remains readable across every character palette.
- Disabled controls use the text-disabled token directly.

### Decor layers

- Use a restrained static ambient wash and the existing character-aware aura.
- Foreground petals are reserved for the character room. Home, discovery,
  collections, and workspaces keep text and controls clear.
- The global starfield and vertical watermark are retired.
- Still artwork has no perpetual floating animation. User-triggered character
  changes crossfade with opacity/transform and respect reduced motion.

### Sticker & polaroid rules

- Chibi/polaroid cards may tilt alternately (±2deg), wear a sticker caption
  and a rotated character-color stamp (NENE violet / NATSUME amber).
- Polaroid frames (padding + bottom caption) are for unpacked game material
  only; ordinary UI cards stay flat and token-driven.
- Seals (red "綾季" stamp) are reserved for the footer signature; do not
  scatter seal-like badges elsewhere.

### Gradient text

- `background-clip: text` is allowed only on `.hero-title`, headings within
  `.page-header` (including `.page-header h1`), and `.title-gradient`
  (enforced by test-style-debt.js).
- Everywhere else, color stays flat and token-based.

### Q-version assets

- Source: `scripts/maintenance/chibi-import.py` converts unpacked SD event CGs
  into 480/960px webp pairs under `assets/chibi/`.
- Selection standard: medium-shot composition with the full head and ahoge,
  clean background, no English sticker/panel overlays.
- Usage: home chibi strip with dialog lightbox, 404 companion, chat-stage
  expression switcher. Do not reuse a character's chibi in more than one
  context per page.

## Components

### Navigation

Keep the primary navigation short and stable. The current page is visible, but
navigation does not compete with the artwork. Mobile navigation opens as a clear
menu with text labels.

Shared atelier chrome lives in `src/assets/css/design-system.css`: `.nav-back`,
`.page-kicker` (aliases `.pb-kicker` / `.gallery-kicker`), `.page-title`,
`.page-subtitle`, `.page-intro`, `.atelier-shell`, `.sticky-toolbar`,
`.filter-pill`, and `.empty-state`. Prefer these over page-local copies.
Director-only layout lives in `src/assets/css/director/workspace.css`.

### Buttons

Each region has at most one visually dominant action. Primary means “continue or
generate,” secondary means “adjust or inspect,” and danger is reserved for
destructive or interrupting actions. Related buttons share height, radius, icon
style, and baseline. Never make a critical action icon-only.

### Cards

Cards express grouping or selection, not decoration. Avoid a card inside a card
inside another card unless each boundary represents a real interaction layer.
Selectable scene cards prioritize title, character, story cue, and preview;
technical tags are supporting metadata.

Scene cards lead with the real reviewed sample, not a decorative gradient: the
card band loads `/scene-showcase/thumbs/<scene-id>.jpg` and silently falls back
to the gradient band when the thumbnail is missing, so the page still works on a
plain static server. Adult-rated thumbnails stay blurred until hover or keyboard
focus. A small mono archive code (`SC-XXX`) sits on the artwork as provenance,
and signature or curated marks appear as one quiet corner badge at most.
Internal audit labels such as `official_cg` or `visual_audited` never render as
visible tags.

### Inputs and filters

Inputs show a persistent label when their meaning is not obvious. Search remains
recognizable as search. Selected filters are visually distinct and removable.
Advanced parameters are collapsed by default for first-time users and retain
their previous state for experienced users.

Maintenance pages use plain language and staged saving. A person who does not
write code must be able to add, duplicate, edit, retire, and validate a Scene or
replace its reviewed sample without opening JSON or a terminal. Destructive
changes remain pending until an explicit project save creates a backup and
passes validation.

### Director stage

The stage is the visual anchor. Before generation it presents one obvious next
step and a quiet character cue. During generation it shows progress without
covering the composition. After generation the artwork receives maximum useful
space; save, regenerate, vary, voice, and review actions sit near it without
forming a second competing dashboard.

### Status and errors

Connection, generation, voice, and sharing states use a short label plus a
specific recovery action. Color reinforces the state but is never the only
signal. Raw logs stay behind a disclosure unless troubleshooting is active.

### Character styling

Nene context may use silver-violet accents; Natsume context may use amber-coffee
accents. Character art is meaningful identity content, not a watermark. Keep it
subtle behind controls and fully legible on character or result-focused pages.

## Character presence and operational clarity

Discovery uses readable character artwork and a brief line of dialogue, with the
same integrated lower-edge caption treatment as home. The character scene library
preserves its interactive character particle portraits as a signature brand feature,
including character-switch reassembly and pointer feedback. Do not replace these
portraits with static images as a general simplification. Keep particles clear of
reading and control areas, and respect reduced-motion preferences.

Invitations can be emotional; action labels, progress, and failures must be
literal and useful. Missing previews are explicitly labeled. Resource filenames
belong inside installation details, not in the default creative composition.

## Do's and Don'ts

### Do

- Make the first useful click obvious to a friend seeing the site for the first
  time.
- Let artwork occupy the largest meaningful area in creation and review flows.
- Reuse variables and shared components from `src/assets/css/design-system.css`.
- Use progressive disclosure for expert controls.
- Keep current selection, progress, empty, error, and success states explicit.
- Test desktop, narrow desktop, and mobile layouts after structural UI changes.
- Preserve keyboard focus, readable contrast, reduced-motion support, and
  minimum target sizes.
- Prefer one calm hierarchy over many equally loud cards and buttons.

### Don't

- Do not imitate Apple, Figma, Notion, or a generic anime site as an end goal.
  Borrow useful interaction principles while preserving this project's identity.
- Do not add decorative whitespace, glow, blur, gradients, or floating shapes
  without a hierarchy or storytelling purpose.
- Do not hide the generated image behind parameters, logs, or prompt text.
- Do not introduce page-local colors, shadows, or radii when a shared token fits.
- Do not use emoji-only controls for navigation or important actions.
- Do not duplicate Scene titles or character data in page markup.
- Do not show every advanced option merely because space is available.
- Do not redesign one page in isolation without checking navigation, director,
  scene library, showcase, character pages, and control panel as one family.

## 2026-09-07 · 夜色手帐布局

采用二次元博客的角色封面、日文短句与私人画室语气，结合克制的深色表面、留白和明确操作层级。全站基础表面统一为石墨蓝灰，樱粉只强调主要操作与少量标题；角色专属主题继续由 director/tokens.css 管理。

首页顺序为封面与继续创作、四个常用入口、精选场景、角色横条、档案、最近作品。首页样式由 src/assets/css/home.css 独立维护；取消标题滚动淡出，避免阅读与点击目标漂移。导航采用悬浮圆角容器，手机折叠菜单允许内部滚动，归档选中后自动收起。

通用页面框架在 1000 / 768 / 480px 分级适配；绘制区、目录和弹窗按上文 Layout 的内容断点补充。卡片只使用 transform 进行位移动效，遵循 reduced-motion。图标复用 ArchiveIcon；文案不展示 LoRA 契约等内部实现细节。

## 2026-09-07 · 绘制区素材抽屉

绘制区沿用夜色手帐风格：左侧创作素材按角色、场景、描述分类，专家模式额外提供历史；分类通过 v-show 保持组件实例，避免切换丢失草稿或搜索状态。中央保留画布、尺寸与生成条、输出设置；专家模式在宽屏提供独立右侧调校栏。工作台表面与响应式规则统一由 director/workspace.css 持有，角色强调色与生成状态继续复用原有令牌和状态机。

1200px 以下右侧调校移到中央下方，900px 以下单列排列并提供素材、画布、输出锚点导航。吸附顶部留出 90px 避让导航，专注模式恢复单画布。背景粒子不覆盖绘制工作区，动效只使用合成属性。


## Iconography

图标使用 ArchiveIcon 的手绘单线 SVG。24 × 24 坐标系、1.65 主线宽、圆角端点与连接、currentColor 描边、fill=none；手绘感来自轮廓曲线与自然留白，不通过整图偏移重描或实心墨点制造。

- 先看 16px，再看 24/40px；复杂图形必须在小尺寸保留主体轮廓。统一视觉重量，不强求所有轮廓的外接矩形同大。
- 常用操作保持简洁。错误与关闭、灵感与收藏、放大与收拢等相近功能必须有不同轮廓。
- 场景用开放风景、剧情用场记板、服装用衣架；镜头用画框与人物裁切层级，三分构图使用真正九宫格。情绪用眼口和少量情绪标记区分。
- 图标不承担文字标签职责；纯图标按钮仍须有可访问名称。图标本体不获取焦点，交互状态由宿主按钮呈现。
- 深浅主题继承宿主的语义颜色，不在图标内部固定颜色。新图标在所属 icons 分组登记，类型从实际定义推导；交付前检查路径合法性、画布边界和实际页面。

## 绘遇品牌（2026-09-09）

名称：绘遇 · HUIYU。标语：让想象成形，让故事相遇。画框与翻页线条象征角色从画面进入故事，沿用 ArchiveIcon 的圆头手绘描边。

品牌色为墨紫 `#211C30`、暖白 `#FFF8F4`、樱花粉 `#F2A8BE`、浅紫藤 `#C5B5E8`；浅色背景上的小字与图标使用墨紫或深玫瑰，不能用浅粉压低对比度。

母版为 `assets/brand-mark.svg`；`npm run wf -- brand:build` 生成深浅字标、favicon、七尺寸 ICO 和原生安装器路径。字标由 BrandLogo 跟随应用主题切换，不使用滤镜或发光覆盖文字。业务功能色和角色强调色保留独立语义。

兼容约束：`com.aics.studio`、内部 AI-CG-Studio 安装标识、可执行文件名、注册表路径、存储键和备份协议继续保留，用户可见名称统一为绘遇。
