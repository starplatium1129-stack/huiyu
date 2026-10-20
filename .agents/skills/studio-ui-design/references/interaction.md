# 交互落地

创建或审查控件、表单、弹层、拖拽及反馈时读取。布局、字体、材质和品牌遵循 [DESIGN.md](../../../../DESIGN.md)。

## 先复用真实组件

查看 src/components/ui 的现有 Studio 组件、调用方与 package.json。选择、popover、tooltip 优先已有 Reka UI 封装；分段选择复用 AnimatedSelection。业务层提供值和内容，共享组件负责主题、键鼠、定位与焦点。

不将上游 Base UI、React hooks 或 Framer Motion JSX 复制进 Vue，不为偏好的外观替换现有依赖。已有模态与非模态行为分别维护，不重复添加 focus trap 或手工定位。

## 共享组件接入

- **StudioSelect**：单选，支持平面/分组选项、禁用项、字符串/数值；空字符串是“全部／自动／无”等真实选项。富角色标签使用 `value`、`option`、`header` 插槽，只提供内容，不替换控件几何、状态或焦点机制。
- **StudioPopover**：非模态锚定内容，保留碰撞处理与返焦；通过 `#trigger` 直接锚定按钮，按钮用 `aria-label`，不外包 StudioTooltip。数据工具的文件输入留在临时浮层外，进入恢复对话框时显式交接焦点。
- **StudioTooltip**：可禁用控件使用 `anchor` 包裹；共享组件让禁用子控件不拦截指针，并用 MutationObserver 跟踪 `disabled` / `aria-disabled`，同步焦点代理和 tabindex。StudioSelect 的提示放在选择器自身，不外包触发器。tooltip portal 进入所属 `<dialog>`，避免被模态层遮住。
- **StudioMediaPlayer**：保留原生已解码媒体元素作为播放核心，由共享组件绘制音视频控制栏。
- **样式归属**：`studio-fields.css` 管理共用字段几何、材质与原生文本输入状态；Studio 组件管理内部布局和交互动效；`native-controls.css` 管理浏览器外观与原生选择控件，包括 autofill、触摸高亮、光标、搜索装饰、文件按钮、数值步进、range、进度条和图片拖影。
- **延迟加载**：保留视图已有边界。次级导航通过 StudioPopover 按需加载 AppMoreMenu，目标保留真实链接；关闭时完成路由或设置入口的焦点交接。加载失败仍可使用主导航，并给出刷新恢复入口，不自动重载可能正在生成的工作区。

既有模态保留当前焦点栈，迁移需覆盖完整操作路径并人工查看；向旧 focus trap 内接入 portal 时单独核对。原生模态沿用 `useFluidDialog` 的滚动锁、入场和返焦；select、popover、tooltip 与模型选择器通过 `useModalPortalHost` 进入所属模态，Reka primitive 保留自身键盘和关闭语义。

## 控件与文字

- 按下提供清晰可感知的视觉反馈，幅度沿用 DESIGN.md 的共享控件规范，但不改变点击命中区、文本排版或提交时机；输入、画布和拖拽把手不机械套用缩放。
- 功能动作继续由 click、键盘和已有组件事件提交。pointerdown 仅用于必要的视觉或拖拽准备，不能提前执行删除或表单提交。
- 字号、字重、行高、留白和对比共同形成层级；中文不照搬拉丁标题的负字距。标签长短不改变对齐基线，也不能挤掉关键动作。
- loading、disabled、empty、error、selected 与 focus 是不同状态。禁用文字沿用 --text-disabled；状态不能仅靠颜色或整体透明度表达。
- 操作靠近受影响内容，优先明确动作名称；高级设置按现有方式渐进展开。成功、失败与进度描述真实请求状态，保留正在使用的结果与输入。

## 排版与表单实施

设计规则见 DESIGN.md 的 [Typography](../../../../DESIGN.md#typography)、[Shapes](../../../../DESIGN.md#shapes) 和 [Inputs and filters](../../../../DESIGN.md#inputs-and-filters)，本节只补充现有 Vue 组件的落地方式。

- flex/grid 内允许文本子项收缩（如 `min-inline-size: 0`、`minmax(0, 1fr)`），对长 URL 等连续字符串定向使用 `overflow-wrap`。短标题可渐进增强 `text-wrap: balance`，普通换行仍须可用；不全局 `word-break: break-all`，不改变提示词编辑值来修补排版。
- 更新中的数字使用 `font-variant-numeric: tabular-nums`，保留原字体角色。单位、比较列和占位空间由所属展示组件负责，不改存储精度或给文本值补空格凑对齐。
- 标签优先使用原生 `for/id` 或 Reka 的关联机制；整行选择沿用 label/primitive，帮助链接、复制和删除仍由各自入口处理。描述与错误通过稳定 id 接入 `aria-describedby`，实际无效时设置 `aria-invalid`，由共享字段组件管理。
- 提交失败时由表单所属 composable 协调展开与定位，在 Vue DOM 更新后聚焦真实字段；普通输入与异步校验不抢焦点。沿用现有校验和 Studio 组件能力，不为此增加另一套表单框架。

## 浮层与 tooltip

锚定浮层使用所属 primitive 的原点变量和碰撞结果，接入现有桌面标题栏与可用空间令牌，不另写固定避让值。确认框在触发层之上可达；关闭后回到合理入口，内部 portal 沿用当前 dialog 接入机制。断点或容器变化使浮层失去可见锚点时收拢；仅在焦点原本属于被隐藏/移除的入口或该浮层时，交接到仍可见的合理位置，保留已经移到其他区域的焦点。

tooltip 同时支持 hover 与键盘焦点。首个说明可有短延迟；同组已经打开后，邻近 tooltip 跳过重复延迟与演出。说明不承担唯一标签，不覆盖正在使用的按钮，也不能留在已消失入口上。

视觉退出不延迟 Escape 或返焦；可见内容与实际可操作范围一致。透明、离场或仅用于过渡的副本不能继续接收输入或进入阅读顺序。

## 指针与连续操作

有实际拖拽需求时保留按下位置相对对象的偏移，使用 pointer capture 防止越界丢失；识别所属 pointerId，处理 pointercancel、丢失捕获和额外指针，避免第二个触点改变当前目标。

分栏拖拽先记录起点、栏宽和折叠状态；越过移动容差后才改布局。容差依据实际输入体验选取，不套用上游固定像素。Escape 回滚本次手势并释放捕获，避免继续触发外层关闭；待拖动阶段不保存偏好，已识别的拖动不再触发尾随点击。

拖动期间对象跟随输入，不加使功能滞后的弹簧。只有释放阶段才根据已有交互使用惯性或阻尼；不移植上游统一速度阈值，不把关闭手势扩展为删除或任务取消。拖拽保留现有键盘等价操作。

连续操作从当前画面值和最新业务目标衔接；新请求不会被旧动画完成回调覆盖。关闭、重开或路线切换不锁住控件等待演出。

## 图片查看

复用 ZoomableImageViewer 的现有锚点缩放与键盘入口。几何计算以未施加缩放和平移的适配尺寸、所属视口为基准，避免反复把已变换的矩形当作初始尺寸；同次拖动的位移使用一致起点。切图或视口变化时重算边界，同图由缩略图升级原图时保留查看位置。

`useArtworkInfoDrawer` 统一场景、样张、图库和批量查看器的侧栏转抽屉断点、嵌套焦点域与焦点交接；各查看器保留自己的图片数据和外层模态生命周期。聊天图片预览等原生模态沿用上文共享模态接入方式。

如需相邻作品预取，沿用现有图库缓存预算、加载入口和释放策略，仅请求有限的邻近媒体，不照搬上游固定张数；限制媒体加载不等于整条列表 DOM 已虚拟化。转场处理见 [动效决策](motion.md#列表与切换)。

## 画面验收

范围与记录遵循 [AGENTS.md · 审查与验收](../../../../AGENTS.md#审查与验收)。沿受影响流程查看适用的状态与恢复操作；涉及浮层时查看真实触发器的返焦、dialog 内 portal 的层级、标题栏和固定动作区避让、长内容滚动及视觉退出期间的输入隔离。布局变化涉及入口隐藏时，查看变化前后的浮层收拢和焦点交接；源码不能代替这些画面证据。

来源：[emil-design-eng](https://github.com/emilkowalski/skills/blob/2d228630ba1446365f614a108cb8252f1feda202/skills/emil-design-eng/SKILL.md)、[apple-design](https://github.com/emilkowalski/skills/blob/2d228630ba1446365f614a108cb8252f1feda202/skills/apple-design/SKILL.md)、[pick-ui-library](https://github.com/emilkowalski/skills/blob/2d228630ba1446365f614a108cb8252f1feda202/skills/pick-ui-library/SKILL.md)；保留绘遇现有组件和 Windows 桌面语义。
