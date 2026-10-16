---
version: "alpha"
name: "绘遇 · HUIYU"
description: "绘遇 HUIYU：温暖、细腻的角色创作与故事画室。让想象成形，让故事相遇。"
colors:
  primary: "#F2A8BE"
  on-primary: "#111923"
  primary-hover: "#FFC4D8"
  secondary: "#B784F6"
  neutral: "#151C24"
  neutral-deep: "#10161D"
  surface: "#1E2935"
  surface-elevated: "#25313D"
  text-primary: "#EDF3FA"
  text-secondary: "#BDCBD8"
  success: "#4ADE80"
  warning: "#FBBF24"
  danger: "#F87171"
  info: "#60A5FA"
  # 此元数据表描述画室深色基线；浅色覆盖见 src/assets/css/light-theme.css。
  # 蓝灰夜幕作为深色结构底色，樱粉与角色专属色承载强调。
  # 应用支持深浅主题；两种主题都需要视觉验收。
  # frontmatter 是语义色板，CSS 实现用另一套名字，映射如下——
  #   primary→--accent, primary-hover→--accent-hover, secondary→--accent-violet,
  #   on-primary→--text-inverse, neutral→--bg-base, surface→--bg-surface,
  #   surface-elevated→--bg-elevated, disabled-text→--text-disabled,
  #   nene→--nene-violet, natsume→--natsume-amber。
  # disabled-text 为禁用态专用：不得用 opacity 压字（压后低于 AA 4.5:1）。
  disabled-text: "#A6B3C0"
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

绘遇 · HUIYU is a personal Galgame creation desk, not a generic dashboard and not
a public AI platform. Its visual character is warm, expressive, intimate, precise, and
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

Design engineering and motion follow the project adaptation of
[Emil Kowalski's skills](https://github.com/emilkowalski/skills/tree/2d228630ba1446365f614a108cb8252f1feda202).
Selected resizing, artwork-viewer and container-layout principles also draw
from the independent [open-claude-ui analysis](https://github.com/Caho1/open-claude-ui),
with source revisions and adoption limits recorded in the UI skill.
The adopted rules live here; [studio-ui-design](.agents/skills/studio-ui-design/SKILL.md)
provides conditional Vue implementation guidance and source attribution.
These principles guide future UI work alongside HUIYU's brand,
desktop scope and AGENTS.md constraints. Review upstream changes before adopting
them; a newer upstream version does not silently replace this standard.

## Product character

Anime and Galgame establish the identity: characters, intimate dialogue, artwork,
and the feeling of entering a story. The selected reference is VoltAgent's
[Linear DESIGN.md](https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/linear.app/DESIGN.md),
an independent analysis of Linear's marketing site, not its application specification.
Borrow its surface hierarchy, consistent control geometry, measured spacing and
clear emphasis. Apply these principles to the existing creation workspace;
retain HUIYU's character colors, artwork, Chinese typography and both themes.
Its near-black palette, lavender brand color, proprietary fonts, large promotional
headlines and landing-page section spacing are outside this adaptation.

Artwork preview effects refer to [Sakuria](https://sakuria.syarolia.com/zh-CN):
image-card lift, picture zoom and soft highlights with distinct timing. This
reference covers images and image cards. Navigation, page transitions, dialogs
and other controls follow HUIYU's own design goals and suitable Inspira UI patterns.

Component composition also draws from Inspira UI's layered cards and interactive
controls, and Magic UI's Bento layouts. Adapt their material hierarchy, artwork
depth and authored motion into one HUIYU component family. Visual upgrades may
reshape existing components and shared surfaces while preserving task state,
readable Chinese typography and immediate actions in both themes.

The home opening and character archive retain the installed desktop layout from
`faddab4a`. The opening pairs one character artwork with a calm reading plane,
manual Nene/Natsume selection, a serif title and character accent. Scene and character discovery precede the tool
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
surfaces use blue-gray night tones; light surfaces use warm paper and readable rose-ink
accents. Both themes preserve the same layout, action hierarchy, and character identity.

The default atelier maps these shared roles to both themes. Preserve per-character
overrides and body aura mappings in `src/assets/css/director/tokens.css`.
Light-mode elevation uses boundaries and shadow, not ever-brighter surfaces.

| Role / CSS token | Dark | Light |
| --- | --- | --- |
| Workspace / `--bg-base` | `#151C24` | `#F5EFE7` |
| Panel / `--bg-surface` | `#1E2935` | `#FFFCF6` |
| Raised control / `--bg-elevated` | `#25313D` | `#EEE7E0` |
| Main text / `--text-primary` | `#EDF3FA` | `#29242A` |
| Supporting text / `--text-secondary` | `#BDCBD8` | `#585059` |
| Disabled text / `--text-disabled` | `#A6B3C0` | `#6D6069` |
| Primary action / `--accent` | `#F2A8BE` | `#9B3E61` |

界面风格与明暗模式独立：外观设置中的「绘遇画室」为默认风格；「泰拉瑞亚」采用像素木纹、纸张面板、森林地景、灯具藤蔓和主题插画，同样支持浅色、深色和跟随系统。宽度达到 1440 CSS px 时使用 8.5rem（默认 136px）木质侧栏，并支持上下方向键导航；较窄窗口恢复顶部导航，1000px 以下沿用折叠菜单。绘图工作台按扣除导航和边框后的实际内容宽度约束左右栏，桌面视口高度不再重复计入主题装饰。风格通过 `data-theme-style` 应用，保存在既有外观偏好的 `style` 字段；首帧脚本同步恢复。像素主题使用不透明材质，切回画室后恢复原有玻璃偏好。原作、参考图和聊天壁纸保持原始画面；仅主题装饰通过 `useThemeIllustration` 切换，不得改变内容或分级。独立桌宠保持透明，系统高对比度颜色优先。

新增颜色须适配两个主题。源码与令牌审查不能代替动态组件、纹理背景、
角色强调色和图片叠字的实际画面验收；遵守 AGENTS.md 的验证范围与测试禁令。

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
- Keep the existing local Chinese fonts; do not load Linear's brand fonts or apply
  its tightly tracked display typography to Chinese controls.
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

Drawing, inspiration and gallery share compact 24px page headings, 15px body
text and 13px control labels at the default root size. Use 40px controls and
32px compact controls (`--control-height` / `--control-height-sm`), 8/10px
control radii and 16px panel radii. Keep headers short and actions in stable
slots. Selected artwork uses a rose border, a check or existing selection
indicator, and `--selection-shadow`; it must not change the wall geometry.

The drawing workspace follows the active theme: empty canvas
uses `--bg-surface`, result and working surfaces use `--bg-base`, and text
uses `--text-*`. Reserve fixed `--art-stage` and `--on-art-*` for image mats
and image overlays that need them, never the whole empty canvas. Display real SFW images at their original proportions;
the main canvas always contains the complete work. Character colors remain
available for context. Normal controls respond in 120–200ms. A newly decoded
result may reveal once using the same image. Simple reveals normally take
450–700ms; particle formation and other deliberate artwork presentations may
take longer when the complete motion improves visual continuity and comfort.
Duration follows the effect's meaningful phases, rather than a universal cap.
Waiting states must describe actual generation progress. Preserve the existing dissolve effect,
reduced motion, visibility cleanup and anchored-viewer fallbacks.

Shared page chrome uses `1000 / 768 / 480px` as its default responsive scale.
Content-driven layouts can use their own thresholds: the director workspace
uses `1440 / 1024 / 900px` for its material switch and stacked rails; the character directory
uses `900px` for its rail and `540px` for its dialog cards. These are local
layout decisions, not additional global device categories. Prefer the shared
scale unless actual content needs another threshold, document the reason near
the owning rule, and verify both sides of each changed threshold in both themes.

Resizable rails, drawers and split views use their own available inline width
to decide wrapping and disclosure. Keep current values and primary actions
visible; secondary controls may move into an accessible disclosure. Chinese
labels must retain readable lines as the container narrows.

Resizing distinguishes a deliberate drag from a press with minor movement.
Escape during an active resize restores the widths and collapsed state from
before that gesture, without closing the containing surface or cancelling work.

The director workspace follows an image-first hierarchy:

1. The canvas/result stage is the largest region and remains visible before and
   after generation.
2. Story and scene selection form the starting rail.
3. Director decisions form a secondary rail with progressive disclosure.
4. Prompt internals, model details, backup, and diagnostics are utilities, not
   the default visual focus.

Home, the character archive and drawing retain their scoped `--studio-*` surfaces.
Drawing keeps resizable material, canvas and parameter columns, horizontal category
controls and stable action locations as specified in “绘制工作台 · 素材与参数” below.
Keep the current generation, reveal and clear animations. Segmented choices share
`AnimatedSelection` and its continuous spring, with a softly lit raised surface
and a shallow contact shadow; navigation and ordinary buttons keep their own
forms. After an image exists, do not shrink it merely to
show every control without scrolling. Empty space must either frame the artwork,
clarify grouping, or improve touch/click accuracy. Large blank zones with no
communicative purpose are a layout defect.
Align labels, fields and actions to shared column edges. Use the existing spacing
scale to separate groups; keep dense settings compact without reducing hit areas.

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

Depth makes grouping, focus and interactive layers visible:

- Base and panels: shared background roles and soft 1px borders establish grouping.
- Interactive controls: buttons, tabs, segments and menus share authored hover
  and press feedback through surfaces, icons and labels, with stable hit targets.
  Selection keeps its own indicator, and keyboard focus stays visible and immediate.
- Floating surfaces: popovers, dialogs and viewers use existing elevation tokens;
  primary actions gain emphasis from their action color, not an extra shadow tier.

Glass surfaces are allowed for navigation, floating utilities, and the director
stage chrome. They must have an opaque fallback and must not be stacked until
text becomes hazy. Prefer one clear surface boundary over several nested glowing
cards. Motion uses `--motion-press` (120ms), `--motion-hover` (160ms),
`--motion-control` (200ms) and `--motion-surface` (260ms). Artwork hover, route and
character presentations have distinct longer roles. Use shared tokens for those
roles, retain reduced-motion fallbacks and keep actions available throughout.

Honor `prefers-reduced-motion` and `prefers-reduced-transparency`.
System transparency, increased contrast, and forced colors must update material
fallbacks live, including native dialog backdrops, without changing the saved
manual preference. Restoring the system setting restores the user's own choice.

## Interaction & motion

Motion is a visible part of HUIYU's design. Page transitions, card interactions,
list handoffs and artwork reveals should have a recognizable shape through
displacement, scale, depth, stagger and rhythm. Review an applicable approved reference's
actual behavior before choosing an effect. Preserve or strengthen that visual
intent while improving continuity and response. Frequency alone does not justify
reducing amplitude, shortening duration or replacing a designed effect with a fade.

Actions respond immediately; visual motion can continue while the next action
is accepted. Keyboard input, typing and cancellation keep their immediate paths.
Give each visual phase enough time to read: a card can lift first and its artwork
follow more slowly. Shared semantic durations describe these roles rather than
impose a universal sub-300ms ceiling. Judge amplitude and timing by clarity,
continuity, comfort and the chosen reference. Reading remains legible; filters
do not replay the entire page or every card. Keep character and artwork signatures.
Entering, exiting and immediate feedback prefer --ease-out; on-screen movement
uses --ease-in-out, drawers use --ease-drawer, and constant progress uses linear.
Reuse suitable shared curves and spring configuration; define a shared semantic
role when an existing token does not express the intended motion.

Simple motion uses CSS transitions with explicit properties; never transition:
all. Programmatic predetermined motion may use WAAPI. Complex interruptible
gestures and shared selection reuse existing motion and AnimatedSelection.
Retarget from the current displayed value; do not reset to the start or replay
keyframes on every rapid toggle. Spring and bounce express a chosen interaction
and settle cleanly, with amplitude suited to the surface and its content.
Actions, cancellation and focus restoration proceed without waiting for visual
completion, and an animation ending never proves a request succeeded.

Press feedback visibly acknowledges input without moving the hit target or
triggering an action early. Choose entrance scale and displacement to express
the surface's origin and depth; avoid scale(0). Anchored popovers use their Reka
primitive's transform origin; centered modals may remain centered. Enter and exit
paths preserve the spatial relationship. After the first tooltip opens, adjacent tooltips in the same
group skip repeated delay and motion while retaining keyboard access.

High-frequency motion uses transform/opacity. Blur, clip-path, shadow and layout
animation are not presumed compositor-safe; necessary exceptions follow the
compositor-exempt rule in AGENTS.md. Avoid per-frame reactive tree updates and
inherited CSS-variable changes on large containers. Use will-change only for
an observed issue, on the affected element, and release unnecessary layers.
Visual scaling cannot replace real layout or focus semantics.

Hover motion requires (hover: hover) and (pointer: fine). Respect both system
reduced-motion and the app's motion preference, including live changes and
explicit overrides. Reduced motion may use instant state changes or short
fades; content, progress and actions remain visible and usable. Interruptions,
unmount and KeepAlive deactivation release owned animation resources and reject
stale callbacks. Review actual desktop behavior in both themes when affected;
source review alone does not establish frame rate or device feel.

## Shapes

Use `8–10px` radii for inputs and compact controls, `14–20px` for cards and
sections, and pill shapes only for filters, small status badges, and segmented
controls. The artwork viewer or main stage may use a larger optical radius (up
to 32px) when it reads as one continuous frame.

Do not mix sharp system-tool rectangles, soft consumer-app pills, and oversized
glass bubbles in the same control group. Icon geometry, border weight, radius,
and padding must make adjacent controls feel like one family.

Browse toolbars and major drawing panels share `--r-xl` (20px); their inputs
and compact buttons use `--r-md` (10px). Browse toolbar surfaces are owned by
`fluid-workspaces.css`: opaque theme surface, soft border, and restrained depth.
Page styles control placement and wrapping without replacing this shape with
square corners. Borderless reading regions and full-screen viewers may remain
flush. Narrow browse controls provide a 44px minimum touch height.

## Vue interaction components

Reusable interaction primitives live in `src/components/ui/` and use Reka UI.
`StudioSelect` provides single selection and replaces every native `<select>`;
it accepts flat or grouped options, disabled entries, string or numeric values,
and treats an empty-string value as a real choice ("all / auto / none") rather
than as "nothing selected". `StudioPopover` provides non-modal anchored content with collision
handling and focus restoration. `StudioTooltip` replaces the native `title`
attribute for explanatory hints, opening on hover and on keyboard focus, and
re-routing its portal into an ancestor `<dialog>` so it is not buried under a
modal. `StudioMediaPlayer` renders audio and video without the browser's native
control chrome, keeping the decoded element as the playback core. Views retain their deferred-loading
boundaries. Data tools use `StudioPopover`, with file inputs kept outside the
transient surface and an explicit focus handoff to the restore dialog.
The secondary navigation also uses `StudioPopover`, loading `AppMoreMenu`
only on first use. Keep destinations as actual links, and preserve route/settings
focus handoffs when the menu closes. A failed menu download must leave primary
navigation usable and explain how to recover by refreshing; never automatically
reload a workspace that could have an active generation task.
Business views supply values and content; the wrappers own theme styling and
keyboard behavior. Do not add a second focus trap or manual viewport positioning
around these primitives. Existing modal dialogs keep their current focus stack
until migrated and manually reviewed as a complete flow; portalled content inside legacy
trapped dialogs needs an explicit integration check.

### Native browser chrome

The system skin never ships: a native `<select>`, a `<audio>`/`<video>` with the
`controls` attribute, a `title` tooltip, or a
`window.confirm`/`alert`/`prompt` call is a defect, not a shortcut, because none
of them can follow the theme, the character accent, or the project's focus flow.
The native `title` attribute is retired across all native HTML elements.
Vue component props such as `ArchiveStatePanel.title` and
`ModelCalibrationFields.title` are distinct from native tooltips.
Two integration shapes matter — wrap the
control in `StudioTooltip` with `anchor` when the control can be disabled
(disabled controls do not dispatch pointer events, so a plain wrapper never
receives hover), and for a `StudioSelect` host put the hint on the select itself
rather than wrapping it, because the trigger is the focusable element.
Popovers (`StudioPopover`) attach anchoring directly to their `#trigger` slot;
keep trigger buttons bare with `aria-label` rather than wrapping them in
`StudioTooltip`, preserving clean anchor geometry. `StudioTooltip` with
`anchor` employs a MutationObserver to observe subtree `disabled` and
`aria-disabled` attributes, dynamically synchronizing focus proxies and
tabindex across runtime reactive state transitions.
Native checkboxes and radios retain their existing themed uses through
`native-controls.css`; selection menus continue to use `StudioSelect`.
`native-controls.css` covers the remaining browser surfaces the theme cannot
reach through components: autofill fills, tap highlights, caret color, search
field decorations, file-selector buttons, spinners, range thumbs, progress bars,
and image drag ghosts. When a new native surface appears, extend that file rather
than styling the leak at the call site.

## Anime Visual Language

The identity comes from authored character artwork, emotional scene choices,
short dialogue, and character color. Controls have tactile surface hierarchy,
clear geometry and consistent spacing. Glowing surfaces and stickers are not a substitute
for character presence.

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
  `.page-header` (including `.page-header h1`), and `.title-gradient`.
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
Low-frequency text actions use `btn-quiet`: no resting outline, with the shared
hit area, focus indication, and readable disabled text retained.

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

Artwork-viewer zoom and pan limits follow the actual image and viewport sizes,
keeping the work recoverable when the viewer resizes. Thumbnail-to-viewer
transitions are optional enhancements: a missing origin, unavailable API or
interrupted transition must leave viewing, closing and focus restoration usable.

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
- Manually review affected desktop and narrow-window layouts in both themes;
  include mobile only when requested, following AGENTS.md.
- Preserve keyboard focus, readable contrast, reduced-motion support, and
  minimum target sizes.
- Give key interactions visible motion and keep a clear hierarchy around them.
- Follow the approved visual reference while preserving HUIYU's identity.

### Don't

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

## 绘制工作台 · 素材与参数

绘制区以作品为中心：左侧创作素材按角色、场景、描述分类，专家模式额外提供历史。一级分类使用可键盘切换的下划线标签，首次加载后通过 v-show 保留组件实例。宽桌面默认素材栏 336px、参数栏 368px、栏间距 24px，仍可拖动或用方向键调整；宽度由 useDirectorLayout 按实际内容区收敛，几何规则集中在 director/layout.css，表面与文字分别由 workspace.css、atelier.css 及组件样式负责。

参数区先选择引擎、模型和画幅，再选择风格；高级调整收起时保留当前配方摘要。真实生成与停止共用原状态机，动作条固定在参数栏底部；隐藏参数或专注时回到画布上方，画幅仍可操作。图片入册、存为场景、对比和清除在画布下方常驻，无可用结果时禁用。画面描述只在素材区编辑，“这一幕”提供定位入口，专注模式在顶栏提供入口。

提示词栏优先保证视觉美感与阅读舒适度，保留轻盈词条、语义配色和清晰层次，用分组、留白与渐进展开缓解密度。Anima 按五层展示：质量/分级（暖金）、角色与作品（角色强调色，组内分开标识）、画师（紫）、画面标签（蓝）、自然语言（青绿）；对应 studio-prompt-craft 的六段发送顺序，展示合组不改变编译。Krea 保留自然语言阅读，不套标签分层。避免在固定侧栏里重复嵌套面板、计数与滚动区；负向词、模型和 LoRA 信息按需展开，复制、保存和词条工作台入口保持可达。长提示词提供宽幅阅读入口，按实际栏宽换行与排列操作，不靠缩小字号容纳内容。

1024–1440 CSS px 默认显示画布与 320px 参数栏；“素材”切换同一主区域，Escape 返回画布并返焦入口，不改写宽屏栏宽和隐藏偏好。低于 1024px 将参数放在画布下方，900px 以下单列并提供锚点导航。专注模式保留单画布与动作条。画布使用跟随主题的 --bg-surface / --bg-base，提示文字用 --text-*；图片上的分级遮罩继续使用 --art-scrim / --on-art-*。角色强调色、实际样张来源及动效清理沿用现有实现，支持减少动态效果。


## Iconography

图标使用 ArchiveIcon 的手绘单线 SVG。24 × 24 坐标系、1.65 主线宽、圆角端点与连接、currentColor 描边、fill=none；手绘感来自轮廓曲线与自然留白，不通过整图偏移重描或实心墨点制造。

- 先看 16px，再看 24/40px；复杂图形必须在小尺寸保留主体轮廓。统一视觉重量，不强求所有轮廓的外接矩形同大。
- 常用操作保持简洁。错误与关闭、灵感与收藏、放大与收拢等相近功能必须有不同轮廓。
- 场景用开放风景、剧情用场记板、服装用衣架；镜头用画框与人物裁切层级，三分构图使用真正九宫格。情绪用眼口和少量情绪标记区分。
- 图标不承担文字标签职责；纯图标按钮仍须有可访问名称。图标本体不获取焦点，交互状态由宿主按钮呈现。
- 深浅主题继承宿主的语义颜色，不在图标内部固定颜色。新图标在所属 icons 分组登记，类型从实际定义推导；交付前检查路径合法性、画布边界和实际页面。

## 绘遇品牌（2026-09-09）

名称：绘遇 · HUIYU。标语：让想象成形，让故事相遇。画框与翻页线条象征角色从画面进入故事，沿用 ArchiveIcon 的圆头手绘描边。

品牌资产沿用墨紫 `#211C30`、暖白 `#FFF8F4`、樱花粉 `#F2A8BE`、浅紫藤 `#C5B5E8`；界面深色结构底色采用蓝灰夜幕。浅色背景上的小字与图标使用深墨或深玫瑰，不能用浅粉压低对比度。

母版为 `assets/brand-mark.svg`；`npm run wf -- brand:build` 生成深浅字标、favicon、七尺寸 ICO 和原生安装器路径。字标由 BrandLogo 跟随应用主题切换，不使用滤镜或发光覆盖文字。业务功能色和角色强调色保留独立语义。

兼容约束：`com.aics.studio`、内部 AI-CG-Studio 安装标识、可执行文件名、注册表路径、存储键和备份协议继续保留，用户可见名称统一为绘遇。

## Background material hierarchy

- Dark surfaces use blue-gray night tones; light surfaces use warm paper neutrals. Character hues remain accents, not full-page washes.
- RouteAtmosphere owns one bounded, static ambient surface. Do not add duplicate body glows, blur passes, or permanent will-change to static backgrounds.
- Reading cards are opaque. Optional liquid refraction belongs to floating structural chrome; cards do not stack backdrop filters.
- Card hover rims and ordinary image entrances animate opacity/transform. Rating masks remain enforced independently of decorative effects.
