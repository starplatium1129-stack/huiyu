# 动效决策与 Vue 落地

时长、曲线、中断与品牌规则见 [DESIGN.md · Interaction & motion](../../../../DESIGN.md#interaction--motion)，本页说明 Vue 实施要点。

## 1. 手段选型与锚定

| 场景 | 首选方案 |
| --- | --- |
| hover、按压、class/属性切换 | CSS `transition`（显式属性，禁 `transition: all`） |
| 组件挂载与卸载 | Vue `Transition` 或 Reka UI 状态机 |
| 可控制/可取消的预定过渡 | WAAPI 或共享编排入口 |
| 可中断弹簧 / 拖拽释放 | 已有 `motion` 与对应 composable |
| 分段选中指示 | `AnimatedSelection`（保持连续弹簧状态） |

- **属性与层次**：优先 `transform`/`opacity`（禁 `scale(0)` 进场或随意叠 blur）；百分比 `translate` 适合未知尺寸抽屉。区分即时业务提交与仍在继续的视觉过渡，卡片、图像与背景按角色保持错落时序。
- **可中断与原点**：复用已有语义时长（不私造毫秒常量）；频繁切换从当前值重瞄准最新目标；锚定浮层跟随 Reka 原点（如 `--reka-popover-content-transform-origin`），中心弹窗用中心原点。

## 2. 列表与切换

- 仅对新入场可见元素做短错峰，过滤/排序/回看不重播整列表动画；`key` 绑定真实记录 ID。
- 滚动显现不反复隐藏已读节点，且观察器未就绪或取消时有正确可见态。
- `TransitionGroup` / 缩略图共享转场复用已加载缩略图，按 `object-fit` 实际画面区域计算起终点，转场结束或取消时立即恢复临时 `view-transition-name` 与样式（视觉克隆不参与点击或焦点）。

## 3. 动效偏好与卸载清理

- CSS 同时尊重 `prefers-reduced-motion` 与 `data-motion`（保留 `full` 显式覆盖），JS 使用 `motionPreference` 与 `listenMotionChanges` / `scrollBehavior`；减动效下保留可达焦点、完整状态与终态切换。hover 位移仅在 `(hover: hover) and (pointer: fine)` 启用。
- 组件卸载、KeepAlive 停用或任务重入时必须取消动画、`rAF`、观察器、事件监听与克隆节点，防止迟到回调覆写新状态或残留半透明节点。

> 来源：[animate](https://github.com/emilkowalski/skills/blob/2d228630ba1446365f614a108cb8252f1feda202/skills/animate/SKILL.md) · [review-animations](https://github.com/emilkowalski/skills/blob/2d228630ba1446365f614a108cb8252f1feda202/skills/review-animations/STANDARDS.md) · [find-animation-opportunities](https://github.com/emilkowalski/skills/blob/2d228630ba1446365f614a108cb8252f1feda202/skills/find-animation-opportunities/SKILL.md)。
