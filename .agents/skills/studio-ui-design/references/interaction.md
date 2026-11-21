# 交互落地

控件、表单、弹层、拖拽与图片查看的 Vue 实施规范。设计标准见 [DESIGN.md](../../../../DESIGN.md)。

## 先复用真实组件

- 优先使用 `src/components/ui/` 已有 Reka UI 封装与 `AnimatedSelection`（业务层仅传值和内容，共享层管几何、主题、键鼠与焦点）。
- 禁止将上游 Base UI / React hooks / Framer Motion JSX 复制进 Vue；不重复造 focus trap 或手工弹层定位。

## 共享组件接入

- **`StudioSelect`**：单选（支持分组、禁用项、空字符串“全部/自动/无”）；富角色标签用 `value`/`option`/`header` 插槽，不改几何与焦点。
- **`StudioPopover`**：非模态锚定浮层；通过 `#trigger` 锚定按钮，保留碰撞与返焦，不外包 `StudioTooltip`；恢复文件选择与进模态时显式交接焦点。
- **`StudioTooltip`**：可禁用控件用 `anchor` 包裹（内部通过 `MutationObserver` 同步 `disabled`/`aria-disabled` 代理）；`StudioSelect` 提示放自身，不外包触发器；tooltip portal 挂载至所属 `<dialog>`。
- **`StudioMediaPlayer`**：保留原生解码媒体元素，由共享层绘制控栏。
- **样式分工**：`studio-fields.css` 管输入字段几何与状态；`native-controls.css` 管 autofill、光标、步进、range 与原生选框；次级导航 `AppMoreMenu` 通过 `StudioPopover` 懒加载（失败保留主导航可用）。
- **模态与焦点**：沿用 `useFluidDialog`（滚动锁、入场与返焦），模态内 select/popover/tooltip 通过 `useModalPortalHost` 挂载所属模态。

## 控件、排版与表单实施

- **动作提交与反馈**：功能动作走 `click`/键盘/组件事件，`pointerdown` 仅作视觉或拖拽准备，不提前触发提交或删除；禁用文字使用 `--text-disabled`；loading/disabled/empty/error/selected 各态明确。
- **收缩与换行**：flex/grid 子项加 `min-inline-size: 0` / `minmax(0, 1fr)`；长 URL 局部用 `overflow-wrap`，短标题渐进 `text-wrap: balance`（不用全局 `word-break: break-all`）；数字变化用 `font-variant-numeric: tabular-nums`。
- **可访问性与校验**：用 `for/id` 关联标签、`aria-describedby` 关联说明/错误、`aria-invalid` 标错；提交失败展开对应区域并聚焦首个无效项（异步校验与常规输入不抢焦点）。

## 浮层、指针与拖拽

- **浮层避让与退出**：使用 Reka 原点与桌面标题栏避让令牌；断点变化隐藏锚点时收拢浮层，仅当焦点原本在被隐藏/关闭元素内时安全返焦；离场透明副本禁止接收输入或进入阅读顺序。
- **连续拖拽**：使用 `pointer capture` 与 `pointerId` 跟踪（防多触点干扰），越过移动容差后才改分栏或布局；拖动中直接跟随不加滞后弹簧，松手按需用阻尼；`Escape` 回滚手势并释放捕获；支持等价键盘操作。

## 图片查看

- **`ZoomableImageViewer`**：基于未变换的适配尺寸与视口计算缩放/平移边界，切图或缩放重算边界，缩略图升原图保留查看位置。
- **`useArtworkInfoDrawer`**：统一查看器侧栏转抽屉断点与嵌套焦点返还。
- **`useArtworkViewerSurface` & `useViewerImage`**：持有缩略图→原图解码交接、放大回位与清理；页面仅传打开态、作品 ID、模式与来源，不另写动画计时或加载逻辑；预取邻近图片受限于当前图库缓存预算（动效参考 [动效决策](motion.md#列表与切换)）。

> **画面复核**：涉及浮层/看图改动须实际核对触发器返焦、dialog 内 portal 层级、标题栏避让、长内容滚动与退出期间输入隔离。来源：[emil-design-eng](https://github.com/emilkowalski/skills/blob/2d228630ba1446365f614a108cb8252f1feda202/skills/emil-design-eng/SKILL.md) · [apple-design](https://github.com/emilkowalski/skills/blob/2d228630ba1446365f614a108cb8252f1feda202/skills/apple-design/SKILL.md) · [pick-ui-library](https://github.com/emilkowalski/skills/blob/2d228630ba1446365f614a108cb8252f1feda202/skills/pick-ui-library/SKILL.md)。
