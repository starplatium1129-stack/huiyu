# 前端审美全面翻新、首次加载提速与桌宠独立区域改造方案

> 状态：已定稿待实施（技术交接文档）  
> 适用范围：绘遇 · HUIYU 全站前端、桌面 Tauri 壳层与原生 Live2D 桌宠渲染层  
> 协作与验证基准：[AGENTS.md](../../AGENTS.md) · [DESIGN.md](../../DESIGN.md)

---

## 1. 目标与已拍板的产品决策

本方案覆盖四个相互关联的体验升级目标，所有方向均已确认，可直接拆分落地：

1. **全站前端审美全面翻新（方向 1 × 方向 3 混搭）**
   - **视觉混搭策略**：
     - **展示与浏览类页面**（首页、角色档案、灵感场景、角色场景、参考画册、我的作品、使用指南）：采用 **方向 1（高级暗房画廊 / Editorial Atelier）**——温暖沉静的墨黑暗房底、精致衬线标题、美术馆留白与画框感，作品与角色为绝对主角。
     - **高频创作与工具类页面**（绘制工作台、故事短片、创作项目、剧本模式、色彩情绪、内容维护、控制面板）：采用 **方向 3（专业沉浸创作器 / Pro Studio）**——严格中性的画布舞台（绝不给生成 CG 染色偏色）、紧凑高效的工具密度、浮动画布 HUD 与等宽数字对齐（`tabular-nums`）。
     - **浅色主题**：全站统一采用 **方向 1 的和纸画册暖白色系**（温润纸白底面 + 深墨文字 + 柔和暖灰分隔），避免刺眼纯白与冷灰后台感。
   - **导航壳层**：全面升级为**单层融合顶栏**——在桌面端把原自定义标题栏（38px）与主导航栏合二为一（约 `52px` 高，直接释放 `~44px` 纵向视口）；Web 浏览器形态自动隐藏窗口最小化/最大化/关闭按钮，共享同一套代码。
   - **既有产品红线不动摇**：双主题 WCAG AA（禁用文字严格使用 `--text-disabled`，严禁用 `opacity` 压字）、`ArchiveIcon` 手绘单线 SVG、角色强调色（宁宁紫 / 夏目琥珀 / 樱粉）、R18 场景/参考缩略默认模糊遮罩与用户作品册无遮罩、页脚「綾季」朱印，以及独立的「泰拉瑞亚」像素主题。

2. **首次加载速度深度优化**
   - 拆除前端 `main.ts` / `initializePlatform.ts` 串行启动瀑布流与重复握手；
   - 桌宠首屏延后重数据并推进轻入口隔离；
   - 按需拆分入口 CSS 与重闭包；
   - Rust 端提前预热 Live2D 渲染线程，并将模型贴图升级为多线程并行解码 + 磁盘预处理缓存。

3. **桌宠零闪现启动 + 控制面板可配启动策略**
   - 彻底消除软件打开时先弹出深色实底方块与 `正在打开桌面陪伴…` 加载卡片的问题。
   - 默认仍保持**桌宠优先静默启动**，同时在控制面板新增启动策略切换项（默认仅桌宠 / 仅主画室 / 同时启动 / 仅托盘静默）。

4. **桌宠像素级独立区域 & 极简交互**
   - 桌宠采用**像素级动态穿透**：只有**人物当前帧实体不透明像素**（及主动展开的右键环形菜单/瞬态浮层）属于桌宠；窗口内其余透明空白区域 100% 穿透给桌面和下层软件。
   - 移除桌宠常驻底部快捷操作条，日常桌面上只留人物本体；所有交互统一收拢至**右键人物环形菜单**（左键按人物本体拖拽）与**系统托盘**。

---

## 2. 现状根因定位（已核实源码）

接手实施前，可直接对照以下已确认的源码瓶颈与缺陷：

| 问题域 | 根因定位 | 关键文件 |
| --- | --- | --- |
| 桌宠启动闪现深色实底方块 | `theme-bootstrap.js` 仍使用 Electron 遗留检测 `'companionDesktop' in window` 且只匹配 `location.pathname === '/companion'`；Tauri 环境下对象为 `__TAURI_INTERNALS__`，且 bundled UI 走 hash 路由 `index.html#/companion`，导致 `html.companion-desktop` 首帧未挂载，窗口吃到 `--bg-base: #151C24` 实底。 | [assets/theme-bootstrap.js](../../assets/theme-bootstrap.js) · [desktop-tauri/src-tauri/src/ui_entry.rs](../../desktop-tauri/src-tauri/src/ui_entry.rs) |
| 桌宠顶部出现 `正在打开桌面陪伴…` 卡片 | `create_companion_window` 建窗后立即调用 `win.show()`；路由进入 `RoomRouteView` 后由 `AsyncPanel` 渲染 `min-height: 180px` 实心卡片，并硬等 `CompanionView` + `localCompanions` + `chatCards` + `ensureProfileChatHistory` 全部完成。 | [desktop-tauri/src-tauri/src/main_shared.rs](../../desktop-tauri/src-tauri/src/main_shared.rs) · [src/views/RoomRouteView.vue](../../src/views/RoomRouteView.vue) · [src/components/ui/AsyncPanel.vue](../../src/components/ui/AsyncPanel.vue) · [src/router/roomResources.ts](../../src/router/roomResources.ts) |
| 桌宠透明空白处拦截鼠标 | 桌宠上层为默认 `540×760` 透明 WebView2 窗；未开启整窗穿透时整块矩形都会吃掉点击，开启整窗穿透后人物本身又无法点击。底层原生渲染器已具备 `model_bounds` 与 `render_alpha_at`，`watchers.rs` 已有 30fps 全局鼠标轮询，但尚未联动做像素级动态穿透。 | [desktop-tauri/src-tauri/src/window_state.rs](../../desktop-tauri/src-tauri/src/window_state.rs) · [desktop-tauri/src-tauri/src/live2d_renderer/draw.rs](../../desktop-tauri/src-tauri/src/live2d_renderer/draw.rs) · [desktop-tauri/src-tauri/src/watchers.rs](../../desktop-tauri/src-tauri/src/watchers.rs) |
| 首次加载偏慢 | 1) `main.ts` 在 `app.mount()` 前串行阻塞 `initializePlatform()`，且其内部连续执行两次 `refreshDesktopRuntime()` 与全量 profile 同步；2) 入口同步拉取 14 份 CSS（含 `terraria-theme.css`），静态闭包偏重（入口 ~350–390 KiB，最大路由 ~684 KiB）；3) 原生 Live2D 直到前端挂载后才拉起线程，并在 `model.rs` 单线程串行解码和 Lanczos3 缩放多张高分 PNG 贴图。 | [src/main.ts](../../src/main.ts) · [src/platform/initializePlatform.ts](../../src/platform/initializePlatform.ts) · [scripts/maintenance/check-bundle-budget.js](../../scripts/maintenance/check-bundle-budget.js) · [desktop-tauri/src-tauri/src/live2d_renderer/model.rs](../../desktop-tauri/src-tauri/src/live2d_renderer/model.rs) |
| 前端审美与空间效率痛点 | 深色底 `#151C24 / #1E2935` 偏冷灰开发后台感；零碎装饰多（倾斜发光 `.page-kicker::before`、发光圆点 `.badge`、虚线空态框、多余嵌套框）；桌面端「38px 标题栏 + 80px 主导航」双层顶栏视觉拥挤且占用大量纵向空间。 | [src/assets/css/design/tokens.css](../../src/assets/css/design/tokens.css) · [src/assets/css/design/components.css](../../src/assets/css/design/components.css) · [src/assets/css/design/page-chrome.css](../../src/assets/css/design/page-chrome.css) · `DesktopTitleBar.vue`（旧实现） · [src/components/AppNav.vue](../../src/components/AppNav.vue) |

---

## 3. 工作线 1（WS-1）：全站视觉令牌与单层融合顶栏

### 3.1 新双主题色板与令牌规范

同步更新以下 4 处，确保设计规范、运行时令牌与防白屏首帧底色完全一致：

- [DESIGN.md](../../DESIGN.md)（同步 frontmatter 颜色、顶栏高度与去噪原则，确保 `npm run design:lint` 通过）
- [src/assets/css/design/tokens.css](../../src/assets/css/design/tokens.css)
- [src/assets/css/light-theme.css](../../src/assets/css/light-theme.css)
- [src/styles/first-paint.css](../../src/styles/first-paint.css)

推荐基准色板（实施后必须运行 `npm run lint:contrast` 校验所有文字/禁用态在 `--bg-base` / `--bg-surface` / `--bg-elevated` 上全部 ≥ 4.5:1）：

| 语义令牌 | 深色新值（暖墨暗房 + 中性画布） | 浅色新值（方向 1 和纸画册） | 说明 |
| --- | --- | --- | --- |
| `--bg-deep` | `#0A0B0E` | `#EAE4DA` | 画布舞台/代码底，深色严守中性不偏色 |
| `--bg-base` | `#0E1014` | `#F6F3EC` | 全局页面基底 |
| `--bg-surface` | `#15181F` | `#FDFBF7` | 卡片、侧栏与面板表面 |
| `--bg-elevated` | `#1D212B` | `#F0EBE2` | 抬升控件、下拉与激活态表面 |
| `--border-soft` | `rgba(248, 240, 232, 0.08)` | `rgba(34, 28, 30, 0.09)` | 极细发丝分隔，取代明显灰线框 |
| `--border-strong` | `rgba(248, 240, 232, 0.16)` | `rgba(34, 28, 30, 0.19)` | 聚焦/悬停/强边界 |
| `--text-primary` | `#F4EFE9` | `#1B181A` | 暖象牙白 / 深墨主字 |
| `--text-secondary` | `#B3ADA6` | `#5F585B` | 次级说明与控件文字 |
| `--text-muted` | `#948E88` | `#6A6266` | 辅助元数据 |
| `--text-disabled` | `#9A948E` | `#6A6266` | 禁用态专用（禁止叠 `opacity`） |
| `--accent` | `#EBA4B8` | `#9E3D5E` | 品牌樱粉（深色提纯柔和、浅色玫瑰墨） |
| `--nene-violet` | `#C59DF8` | `#6E439C` | 绫地宁宁角色强调色 |
| `--natsume-amber` | `#E8B460` | `#925C18` | 四季夏目角色强调色 |
| `--shadow-card` | `inset 0 1px 0 rgba(255, 250, 245, 0.055), 0 8px 24px -10px rgba(0, 0, 0, 0.50)` | `inset 0 1px 0 rgba(255, 255, 255, 0.90), 0 6px 20px -10px rgba(42, 32, 26, 0.09)` | 明度层级 + 顶部 1px 极细高光 |

### 3.2 全局视觉去噪清单

在 [src/assets/css/design/page-chrome.css](../../src/assets/css/design/page-chrome.css) 与 [src/assets/css/design/components.css](../../src/assets/css/design/components.css) 执行统一减噪：

1. 移除 `.page-kicker::before` 的倾斜 `-2deg` 渐变发光小条，改为克制的等宽大写微距副标题（`letter-spacing: 0.12em`）。
2. 移除 `.badge` 的外扩彩色发光阴影与发光圆点特效，改为低噪中性边线或柔和淡底胶囊；状态点仅用纯色微圆点，不加发光滤镜。
3. 移除 `.card-direct::after` 的装饰性折角线与 `.empty-state::before` 的虚线内框，用干净的留白、衬线标题和比例建立高级感。
4. 统一圆角分层：
   - 工具控件（按钮、输入、分段）：`8px`（`--r-sm` / `--r-md`）
   - 面板与画廊卡片：`14px–16px`（`--r-lg`）
   - 首页主视觉与画布舞台：`20px–22px`（`--r-stage`）
5. 统一字阶对比：浏览类页面标题使用 `--font-serif`（字重 500，紧凑行高 `1.22–1.28`），正文与控件用 `--font-sans`，参数/步数/种子/编号严格使用 `--font-mono` + `font-variant-numeric: tabular-nums`。

### 3.3 单层融合顶栏改造

涉及文件：[src/components/DesktopWindowControls.vue](../../src/components/DesktopWindowControls.vue)、[src/components/AppNav.vue](../../src/components/AppNav.vue)、[src/App.vue](../../src/App.vue)、[src/views/ControlView.vue](../../src/views/ControlView.vue)、[src/assets/css/desktop-layout.css](../../src/assets/css/desktop-layout.css)、[src/composables/useScrollHeader.ts](../../src/composables/useScrollHeader.ts)。

1. **拆分窗口三键组件**：从 `DesktopTitleBar.vue` 抽出独立无布局副作用组件 `src/components/DesktopWindowControls.vue`，仅封装「最小化 / 最大化还原 / 关闭」三按钮、`aics:maximized` 事件同步与失败提示。
2. **移除全局独立顶条**：`App.vue` 不再全局渲染 `<DesktopTitleBar />`；`html.aics-desktop-shell` 中 `--desktop-chrome-height` 归零（由顶栏自身高度统一接管）。
3. **融合进 `AppNav.vue`**：
   - 将桌面端导航高度收紧为 `--app-navigation-height: 52px`（`>= 2200px` 视口 `58px`，`>= 3000px` 视口 `68px`），较原有 `38 + 80 = 118px` 节省约 50% 顶栏空间。
   - 顶栏空白区域绑定 `data-tauri-drag-region`（CSS `-webkit-app-region: drag`），支持空白处拖动窗口与双击最大化/还原；所有导航链接、搜索、按钮及 `<DesktopWindowControls />` 明确标注 `data-tauri-drag-region="false"`（`-webkit-app-region: no-drag`）。
   - **桌面端禁用滚动隐藏**：`useScrollHeader.ts` 在桌面壳模式下不触发 `data-scroll-hidden='true'`，确保窗口拖拽区与关闭/最小化按钮始终常驻顶部，仅保留滚动后的细微底线与阅读进度条。
   - **精简一级导航密度**：主导航收敛为 5 个最高频入口（`首页 / 绘制 / 角色 / 灵感 / 作品`）+ 结构化「更多」菜单（含房间、参考画册、创作项目、故事短片、剧本、色彩情绪、角色场景、画风、模型资料、内容维护、控制面板、使用指南）；右侧依次排布紧凑搜索胶囊（带 `Ctrl K` 键帽）、任务中心入口、主题切换、声音切换、细分隔线与 `<DesktopWindowControls />`（仅桌面端显示）。
4. **独立路由 `/control` 适配**：`ControlView.vue` 不经过 `AppLayout`，在其顶部右侧（及窄屏紧凑顶栏）内嵌 `<DesktopWindowControls />` 并预留顶部拖拽条，确保控制面板既无双层顶栏、又不丢失窗口拖拽与三键操作。
5. **联动偏移校验**：同步检查 [src/composables/prompt/useDirectorLayout.ts](../../src/composables/prompt/useDirectorLayout.ts)、全站 `.sticky-toolbar` 与 `.skip-link`，统一读取 `--app-navigation-visible-height`，杜绝锚点或吸顶条遮挡标题。

---

## 4. 工作线 2（WS-2）：全站页面审美全面翻新

以 WS-1 新令牌为统一底座，按「展示画廊层（偏 1）」与「专业工具层（偏 3）」分批翻新全站页面，同时清理页面内局部旧样式覆盖与硬编码颜色：

### 4.1 展示与浏览类页面（偏方向 1：高级暗房画廊）

- **首页**（[src/views/HomeView.vue](../../src/views/HomeView.vue)、[src/assets/css/home.css](../../src/assets/css/home.css)）：
  - 重排首屏 Hero 序章：左侧衬线标题 + 精简副文 + 清晰双 CTA + 宁宁/夏目切换胶囊，右侧角色大图采用与底面自然融合的柔和渐变过渡，去掉生硬分栏线与繁杂角标。
  - 优化纵向信息密度与节奏：突出「最近创作 → 精选灵感场景 & 角色发现 → 精简画室章节」，清理重复空框与冗长副标题，增大区块间呼吸留白。
  - 卡片统一使用面差 + 顶部微高光，悬停仅做 `translateY(-2px)` 与图片 `scale(1.03)`（仅合成器属性 `transform`/`opacity`）。
- **灵感场景 / 角色场景 / 参考画册 / 我的作品 / 角色档案**（`SceneExplorerView.vue`、`PopularSceneExplorerView.vue`、`ShowcaseView.vue`、`GalleryView.vue`、`CharacterView.vue` 及对应 CSS）：
  - 顶部筛选区收敛为单行轻量 sticky 工具条，减少多层套框与冗余图标；
  - 作品与场景卡突出画面本身（细内衬画框 `inset 0 0 0 1px var(--border-soft)`），保留单行精炼标题与等宽代码；
  - 严格保留 R18 场景/参考缩略图默认模糊遮罩与悬停预览、作品册无遮罩，以及大图 3D 观画与原图缩放能力。
- **角色房间与独立聊天窗**（`ChatView.vue`、`CompanionChatView.vue`）：
  - 消息气泡与输入框收敛为干净的纸面/墨面层次，去除过重边线和视觉干扰。

### 4.2 高频创作与管理类页面（偏方向 3：专业沉浸创作器）

- **绘制工作台**（[src/views/PromptBuilderView.vue](../../src/views/PromptBuilderView.vue)、[src/assets/css/director/workspace.css](../../src/assets/css/director/workspace.css) 及同目录 CSS）：
  - 画布主舞台采用纯正中性暗房底 `--bg-deep`（浅色 `--bg-deep` 暖灰和纸衬垫），移除任何会干扰画面色准的彩色背景光斑。
  - 画布底部常驻动作（入册收藏 / 存为场景 / 对比 / 3D 观画 / 清除 / 尺寸读数）收敛为一枚居中的**浮动画布 HUD 胶囊**，减少底部额外占位行。
  - 左右素材栏与参数栏去掉卡片套卡片的多层嵌套边框，使用清晰的细线分段、紧凑 `32px/36px` 表单高度与 Anima 五层编译预览等宽区，底部生成按钮常驻高辨识度。
- **故事短片 / 创作项目 / 剧本模式 / 色彩情绪 / 内容维护 / 控制面板**（`VideoStudioView.vue`、`StudioProjectsView.vue`、`ScenarioView.vue`、`ColorScriptView.vue`、`SceneManagerView.vue`、`ControlView.vue`）：
  - 统一接入新色板、去噪面板头与紧凑表单控件；移除历史遗留的硬编码深蓝色值；
  - 排查全局弹层（`GlobalSearch`、`TaskCenter`、`ConfirmDialog`、`StudioSelect`、`StudioPopover`、`StudioTooltip`）的双主题一致性。

### 4.3 独立主题兼容保护

- `data-theme-style="terraria"` 的木纹/纸面/侧栏覆盖必须保持独立隔离，不因主画室令牌重写而错位或丢失对比度。

---

## 5. 工作线 3（WS-3）：桌宠零闪现、启动策略与像素级动态穿透

### 5.1 零闪现启动（Zero-Flash Show）

1. **修复首帧透明脚本**（[assets/theme-bootstrap.ts](../../assets/theme-bootstrap.ts)）：
   - 路由判定同时识别 pathname 与 hash：
     - 提取规范路径 `const routePath = (location.hash.startsWith('#/') ? location.hash.slice(1) : location.pathname).split(/[?#]/, 1)[0].replace(/\/+$/, '')`
   - 桌面宿主判定改为 `const isDesktop = '__TAURI_INTERNALS__' in window || 'companionDesktop' in window`；
   - 当 `isDesktop && routePath === '/companion'` 时立即添加 `html.companion-mode`、`html.companion-desktop`（同时当 `routePath === '/companion-chat'` 时补透明类），确保在任何 CSS/JS 到达前文档已完全透明。
2. **桌宠禁用实底加载卡片**（[src/views/RoomRouteView.vue](../../src/views/RoomRouteView.vue)）：
   - 在 `page === 'companion'`（且桌面模式）下，向 `<AsyncPanel>` 传入自定义 `#feedback` 插槽：
     - `loading` 态：渲染完全透明空占位（**绝不渲染 `正在打开桌面陪伴…` 卡片与实色背景**）；
     - 仅在真正 `failed` 态时渲染紧凑可重试浮标（并在此时注册该浮标为可点击区域，保证可恢复）。
3. **Rust 侧延迟显窗状态机**（[desktop-tauri/src-tauri/src/main_shared.rs](../../desktop-tauri/src-tauri/src/main_shared.rs)、[desktop-tauri/src-tauri/src/bridge.rs](../../desktop-tauri/src-tauri/src/bridge.rs)、[desktop-tauri/src-tauri/src/live2d_renderer/window.rs](../../desktop-tauri/src-tauri/src/live2d_renderer/window.rs)）：
   - `create_companion_window` 建窗完成后保持 `.visible(false)`，将 `show_on_start` 记入 `AppState` 的 `companion_pending_show` 标志，**不再立即调用 `win.show()`**。
   - 新增 IPC 命令 `companion_mark_ready`：前端 `CompanionView` 透明壳挂载且通知 Live2D 发起首帧后调用；同时原生渲染线程在 `frame_count >= 1`（首次 `frame.present()` 成功）时置位 `live2d_first_frame_ready`。
   - **显现门控**：当 `companion_pending_show == true` 且满足「前端透明壳已就绪 **并且** 原生 Live2D 已出首帧（若用户关闭了 Live2D 则前端静态态就绪即可）」时，由 Rust 原子地先 `ShowWindow(overlay_hwnd, SW_SHOWNA)` 再 `companion_win.show()`（不抢焦点或按托盘主动呼出参数决定是否 focus），发出 `aics:shown` 与 `aics:visibility`。
   - **故障兜底**：设置 `8s` 兜底定时器——若超时仍未完成首帧（如模型文件缺失或 GPU 异常），不再无限隐藏，改为系统托盘气泡提示并在显窗后展示轻量错误恢复浮标。

### 5.2 控制面板可配启动策略

1. **持久化偏好**（[desktop-tauri/src-tauri/src/window_state.rs](../../desktop-tauri/src-tauri/src/window_state.rs)）：
   - 在 `CompanionPreferences` 扩展字段（`#[serde(default)]` 兼容旧 JSON）：
     ```rust
     #[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
     #[serde(rename_all = "kebab-case")]
     pub enum StartupMode {
         Companion, // 默认：桌宠先启动
         Atelier,   // 仅打开主画室
         Both,      // 桌宠与主画室同时启动
         Tray,      // 仅托盘静默启动
     }
     ```
2. **启动分发**（[desktop-tauri/src-tauri/src/main.rs](../../desktop-tauri/src-tauri/src/main.rs)）：
   - 命令行带 `--hidden`（开机自启静默）或存在维护/升级恢复标记时保持原高优逻辑不变；
   - 常规启动读取 `preferences.startup_mode`：
     - `Companion`（默认）：仅创建桌宠（延迟零闪现显示）；
     - `Atelier`：直接打开主画室，不创建桌宠窗口；
     - `Both`：并行拉起桌宠（延迟显窗）与主画室；
     - `Tray`：不自动显示任何窗口，仅驻留托盘（点击托盘随时唤起桌宠或画室）。
3. **IPC 与控制面板 UI**：
   - [desktop-tauri/src-tauri/src/bridge.rs](../../desktop-tauri/src-tauri/src/bridge.rs) 新增 `get_startup_mode` / `set_startup_mode`，经 [src/platform/desktop/capabilities.ts](../../src/platform/desktop/capabilities.ts) 暴露；
   - 在 [src/components/DesktopPreferences.vue](../../src/components/DesktopPreferences.vue)（挂在 [src/views/ControlView.vue](../../src/views/ControlView.vue) 的 `control-personalization` 分区）增加「启动方式」选项组，即时落盘并提示「下次启动生效」。

### 5.3 像素级动态穿透独立区域

核心机制：**默认即像素级穿透，只有人物实体像素与主动展开的交互浮层才接管鼠标。**

1. **原生渲染侧低分辨率 Alpha 掩码快照**（[desktop-tauri/src-tauri/src/live2d_renderer/draw.rs](../../desktop-tauri/src-tauri/src/live2d_renderer/draw.rs) & `mod.rs`）：
   - 在 `Live2DOverlayState` 新增原子/读写锁保护的 `AlphaMaskSnapshot { origin_x, origin_y, width_px, height_px, mask_w, mask_h, data: Vec<u8> }`。
   - 渲染器无需每帧 165fps 回读全分辨率贴图：将当前帧 Alpha 通道降采样到约 **1/4 尺度**（如 `135×190`，约 25 KiB）异步读回 CPU；触发更新时机为：
     - 模型首帧渲染完成、角色/服装/取景变更、窗口缩放移动；
     - 常态低频刷新（`4Hz`），动作播放期间提升至 `10Hz`（避免摆手/转身轮廓滞后）。
   - 提供快路径查询 `hit_opaque_pixel(screen_x: i32, screen_y: i32) -> bool`：
     1. 先用 `state.model_bounds` 做快速矩形粗筛，在包围盒外直接 `false`；
     2. 映射至 `mask` 坐标，在半径 `1` 格（等价约 `3–4px` 膨胀容差，防止发丝/衣角边缘拖拽断触）内检查是否存在 `alpha > 16`。
2. **交互浮层与拖拽锁定协议**（[desktop-tauri/src-tauri/src/bridge.rs](../../desktop-tauri/src-tauri/src/bridge.rs) + [src/composables/chat/useCompanionWorkspace.ts](../../src/composables/chat/useCompanionWorkspace.ts)）：
   - 新增 IPC 命令 `companion_set_interactive_regions(regions: Vec<LocalRect>, lock: bool)`：
     - `regions`：当前展开中的 DOM 交互浮层（如右键环形菜单 `CompanionOrbitMenu`、角色选择弹窗、设置面板、瞬态提醒气泡、故障重试浮标）相对于 `companion` 窗口客户区的物理像素矩形列表；
     - `lock`：用户正在按住人物左键拖拽期间为 `true`，松手恢复 `false`（防止鼠标甩出人物轮廓导致拖拽中断）。
   - 默认纯人物静置态：`regions = []`、`lock = false`。
3. **全局鼠标 30fps 动态切换穿透**（[desktop-tauri/src-tauri/src/watchers.rs](../../desktop-tauri/src-tauri/src/watchers.rs)）：
   - 明确两层穿透语义优先级：
     - **整身锁定穿透**（`state.ignore_mouse_events == true`，由系统托盘「锁定整身穿透」或快捷键 `Ctrl+Shift+P` 触发）：无条件保持 `set_ignore_cursor_events(true)`，连人物本体也穿透，防全屏游戏/绘画误触；
     - **默认像素级穿透**（`state.ignore_mouse_events == false`）：`watchers.rs` 根据实时光标 `(pt.x, pt.y)` 计算：
       ```text
       should_accept_input =
           interactive_lock
           || point_in_any_registered_region(pt, window_origin)
           || overlay_state.hit_opaque_pixel(pt.x, pt.y)
       ```
       仅在 `should_accept_input` 与上次下发状态发生变化时调用 `companion_win.set_ignore_cursor_events(!should_accept_input)`（零无用系统调用），同时继续按需推送全局目光跟随事件 `aics:global-mouse`。
   - 窗口显示初始态默认先置为穿透（`true`），待鼠标真正移入人物像素再接管，杜绝启动瞬间误挡鼠标。

### 5.4 桌宠纯人物极简交互形态

涉及文件：[src/views/CompanionView.vue](../../src/views/CompanionView.vue)、[src/components/CompanionDesktopFloat.vue](../../src/components/CompanionDesktopFloat.vue)、[src/components/CompanionOrbitMenu.vue](../../src/components/CompanionOrbitMenu.vue)、[src/assets/css/companion-surface.css](../../src/assets/css/companion-surface.css)、[desktop-tauri/src-tauri/src/tray.rs](../../desktop-tauri/src-tauri/src/tray.rs)。

1. **移除常驻操作条**：桌面桌宠模式下隐藏/移除底部常驻的 `companion-action-dock`（对白/画室/看屏按钮条），日常桌面只呈现纯粹的人物本体。
2. **右键人物 + 托盘全覆盖**：
   - 左键按人物实体：互动反馈 / 拖动移动人物位置；
   - 右键人物实体：呼出 `CompanionOrbitMenu` 环形菜单（含：打开聊天、打开画室、切换角色、表情、动作、看屏、置顶、设置、隐藏）；展开期间上报环形菜单外框至 `companion_set_interactive_regions`，点击菜单外或按 `Esc` 立即收起并归零区域；
   - 系统托盘（`tray.rs`）：同步补齐「显示/隐藏桌面角色、打开聊天、打开绘图画室、切换角色/设置、置顶、锁定整身穿透、开机启动、退出」，并明确文案区分「锁定整身鼠标穿透（默认空白已自动穿透）」。
3. **释放窗口无用留白**：调整 `companion-surface.css` 中桌面态 `.live2d-host` 的 `inset`（去掉原 `66px 0 38px` 为旧顶栏和旧底条留出的空隙，改为贴边极小安全边距），使人物画面更舒展且默认窗口尺寸可进一步收紧。
4. **主动问候与异常提示**：主动问候默认走系统原生通知（或短时瞬态气泡，出现时注册可点区域、自动消失后撤销），绝不长期占驻屏幕。

---

## 6. 工作线 4（WS-4）：首次加载速度深度优化

### 6.1 拆解前端启动串行瀑布流

涉及文件：[src/main.ts](../../src/main.ts)、[src/platform/initializePlatform.ts](../../src/platform/initializePlatform.ts)。

1. **消除重复桌面握手**：`initializePlatform.ts` 目前在 `initializeDesktopRuntime()` 内调用一次 `refreshDesktopRuntime()`，随后第 42 行又同步 `await refreshDesktopRuntime()` 一次（触发两次跨进程 Tauri IPC → 网关 HTTP 往返）。合并为**单次带完整窗口身份的启动握手**。
2. **并发初始化与壳层优先挂载**：
   - 将 `import('./App.vue')`、`import('./router')`、`initializeDesktopPreferences()` 与平台握手全部放入同一阶段并发执行，不再串行等待 `useTaskCenter` 动态导入后才开始握手；
   - 保持数据写入安全契约（在握手确认前维持写锁/fail-closed 保护），但允许只读首屏壳层（导航、首屏骨架/本地缓存展示）先挂载呈现，全量 `chat`/`draft` 等非首屏同步数据在挂载后立刻并行水合。

### 6.2 桌宠独立轻入口 & 延迟加载重数据

涉及文件：[src/router/roomResources.ts](../../src/router/roomResources.ts)、[vite.config.ts](../../vite.config.ts)、[desktop-tauri/src-tauri/src/ui_entry.rs](../../desktop-tauri/src-tauri/src/ui_entry.rs)。

1. **拆出非首帧必需数据**：`loadRoom('companion')` 不再在挂载 `CompanionView` 前阻塞等待 `ensureProfileChatHistory()`（全量聊天记录）与 `loadChatCards()`（全部角色卡）。首帧仅拉取当前激活角色的轻量元数据与 Live2D 配置即可驱动渲染；聊天记录与角色卡改为首帧完成后的空闲预热，或打开聊天窗/角色切换弹窗时按需加载。
2. **桌宠独立轻入口（Multi-entry）**：参照现有 `resource-assistant.html`，在 `vite.config.ts` 新增 `companion.html` 轻量入口（仅挂载桌宠壳层、桌宠所需极简样式与能力，不打入主画室的 `AppNav`、`GlobalSearch`、`TaskCenter`、`terraria-theme.css`、画廊/导演台公共依赖），显著压低桌宠 WebView2 的解析与执行耗时。

### 6.3 入口 CSS 与重闭包瘦身

涉及文件：[src/main.ts](../../src/main.ts)、[scripts/maintenance/check-bundle-budget.js](../../scripts/maintenance/check-bundle-budget.js)。

1. **按需加载非默认主题 CSS**：`terraria-theme.css` 从 `main.ts` 同步导入改为仅当 `themeStyle === 'terraria'` 时动态导入（首帧底色已由 `first-paint.css` 兜底，无闪色）。
2. **审计入口静态闭包**：逐项排查 `src/main.ts` 与 `App.vue` 同步依赖，将低频弹层（如 `AppearancePreferences`、`ConfirmDialog` 重内容、`StudioSelect` 依赖的 Reka Popper 定位块）按需延迟或按 `check-bundle-budget.js` 注释方案轻量化，确保入口 JS 闭包与路由闭包较现状明显下降且不触碰预算红线。

### 6.4 Rust 端 Live2D 前置预热与贴图磁盘缓存

涉及文件：[desktop-tauri/src-tauri/src/main.rs](../../desktop-tauri/src-tauri/src/main.rs)、[desktop-tauri/src-tauri/src/live2d_overlay.rs](../../desktop-tauri/src-tauri/src/live2d_overlay.rs)、[desktop-tauri/src-tauri/src/live2d_renderer/model.rs](../../desktop-tauri/src-tauri/src/live2d_renderer/model.rs)。

1. **前置预热渲染线程**：当 `startup_mode` 为 `Companion` 或 `Both` 时，在 `main.rs` 的 `setup` 阶段即与网关启动并行触发 `ensure_overlay`（提前创建隐藏的渲染线程与默认角色预加载上下文），不必等到 WebView2 启动、Vue 挂载、前端完成 IPC 才开始读模型文件。
2. **多线程贴图解码 + 预处理落盘缓存**：
   - `model.rs` 加载多张模型纹理时改为多线程并行解码，不再单线程串行执行 `image::open` + `Lanczos3` 缩放；
   - 按 `sha256(源路径 + 文件大小 + mtime + texture_scale)` 在 `runtime/live2d-cache/` 缓存已缩放的原始 RGBA（或极速压缩格式如 LZ4/无压缩头），命中缓存直接 mmap/读入上传 GPU，将每次冷启动 1–3 秒的 CPU 纹理解码耗时压降到百毫秒内；磁盘读取失败或校验不匹配时安全回退实时解码并重建缓存。

---

## 7. 推荐实施顺序与并行 Worktree 切分

多人或多代理协作时，建议按两个阶段并行推进，严格隔离编辑文件域以防冲突：

| 阶段 | 工作包 | 独占修改目录 / 文件域 | 前置依赖 |
| --- | --- | --- | --- |
| **Phase 1A** | **WS-1**：新双主题令牌 + 去噪基元 + 单层融合顶栏 + `DESIGN.md` | `DESIGN.md`、`src/styles/first-paint.css`、`src/assets/css/design/*`、`src/assets/css/light-theme.css`、`src/assets/css/desktop-layout.css`、`src/components/DesktopTitleBar.vue`、`DesktopWindowControls.vue`、`AppNav.vue`、`App.vue`、`src/composables/useScrollHeader.ts` | 无 |
| **Phase 1B** | **WS-3 + WS-4（Rust 侧）**：零闪现显窗、启动策略持久化、Alpha 掩码与动态像素穿透、Live2D 预热与贴图缓存 | `desktop-tauri/src-tauri/src/*` | 无（与 1A 完全并行） |
| **Phase 2A** | **WS-3 + WS-4（前端侧）**：`theme-bootstrap.js` 修复、桌宠轻入口与透明路由、纯人物去底条、浮层区域上报、`main.ts` 瀑布流拆解、控制面板启动策略 UI | `assets/theme-bootstrap.js`、`vite.config.ts`、`companion.html`、`src/main.ts`、`src/platform/*`、`src/router/roomResources.ts`、`src/views/CompanionView.vue`、`RoomRouteView.vue`、`src/components/CompanionDesktopFloat.vue`、`CompanionOrbitMenu.vue`、`DesktopPreferences.vue`、`src/assets/css/companion-surface.css` | 依赖 1B 的 IPC 契约 |
| **Phase 2B** | **WS-2**：全站页面按「1+3 混搭」视觉翻新（首页、绘制台、画廊/场景、角色/房间、短片/项目、控制面板） | `src/views/*.vue`（不含 `CompanionView` / `RoomRouteView`）、`src/assets/css/home.css`、`src/assets/css/director/*` 及各业务页 CSS | 依赖 1A 的令牌与顶栏契约 |

---

## 8. 约束红线与验收清单

遵循 [AGENTS.md](../../AGENTS.md) 规范：**严禁新增或运行任何单元测试、组件测试、E2E 测试或测试脚本**；交付必须通过静态检查、产品构建门禁与真机实测逐项验收。

### 8.1 构建与静态门禁

- `npm run typecheck` 通过
- `npm run design:lint` 通过
- `npm run lint:contrast` 通过（深浅双主题及 `--text-disabled` 全部达标 WCAG AA）
- `npm run lint:animations` 与 `npm run lint:colors` 通过
- `npm run build` 通过，且 `check-bundle-budget.js` 输出中对比改造前记录 `entry closure JS`、`largest route closure`、`entry CSS` 实测下降数据
- `npm run wf -- docs:check` 通过
- `npm run build:tauri`（在 `main` 工作区执行）构建通过

### 8.2 真机桌面验收清单（覆盖 4K 150%/200% 与 2K 100%/125%）

1. **零闪现冷启动**：
   - 双击启动后，桌面不出现任何深色实底方块或 `正在打开桌面陪伴…` 卡片；桌宠就绪后直接显现干净人物。
   - 对比记录改造前后冷启动到桌宠首帧可见、到主画室首页可交互的实测耗时（含贴图缓存命中前/命中后）。
2. **像素级动态穿透独立区域**：
   - 在桌宠背后放置浏览器或编辑器，依次点击人物头顶两侧、肩膀外侧、脚部周围空白区，确认 100% 穿透给下层软件；
   - 点击、拖动人物本体流畅无断触；快速拖动人物不脱手；
   - 右键人物呼出环形菜单后所有扇区与二级面板均正常可点，关闭菜单后周围空白立即恢复穿透；
   - 通过系统托盘或 `Ctrl+Shift+P` 切换「锁定整身穿透」时，人物本体也被穿透，再切回后恢复像素级穿透；
   - 确认桌面常驻形态下无底部操作条，托盘与右键菜单均可访问全部核心能力。
3. **启动策略配置**：
   - 在控制面板「个性化 → 桌面偏好」分别切换「桌宠优先 / 仅主画室 / 同时启动 / 托盘静默」，重启验证每次启动窗口行为与设置一致。
4. **全站审美与单层融合顶栏**：
   - 单层融合顶栏在首页、绘制工作台、画廊、角色档案、控制面板均可正常拖动窗口、双击最大化/还原、点击三键最小化/还原/关闭，滚动页面时顶栏不消失；
   - 深色暗房画廊（展示页）+ 中性暗房工具台（绘制台/短片/项目）与浅色和纸画册全站双主题视觉统一、无旧冷灰残留或对比度告警；
   - 宁宁 / 夏目角色色切换、泰拉瑞亚像素主题切换、R18 缩略遮罩与作品册无遮罩、大图 3D 观画与缩放均无回归。
