# 动效决策与 Vue 落地

新增、修改或审查动画时读取；频率、用途、时长、曲线、中断和品牌边界遵循 [DESIGN.md · Interaction & motion](../../../../DESIGN.md#interaction--motion)。本页补充 Vue 实施方式。

## 选择工具与属性

| 场景 | 首选 |
| --- | --- |
| hover、按压、由 class 或属性驱动的切换 | CSS transition，显式列出属性 |
| Vue 挂载与退出 | 现有 Transition 或 Reka UI 的状态和挂载机制 |
| 需要程序控制、取消的预定过渡 | WAAPI 或已有编排入口 |
| 可反向操作的真实弹簧、拖拽释放 | 已有 motion 与所属 composable |
| 分段选中指示 | AnimatedSelection，保留连续状态 |

优先 transform/opacity。不要使用 transition: all、scale(0) 进场或为了“丝滑”给整个控件叠 blur。缩放进场通常从接近完整尺寸的 0.95 左右开始；能用短淡入表达时不必缩放。百分比 translate 以节点自身尺寸为基准，适合未知尺寸抽屉；实际布局变化仍需真实布局规则。

## 编排与锚定

JS 编排沿用调用方或共享实现的语义时长，不另设平行毫秒常量；CSS 曲线不冒充物理弹簧。分段选择复用 AnimatedSelection 的现有配置。

频繁切换时保留当前动画实例或呈现值，更新到最新目标；取消旧实例时处理其完成回调。收起时释放逻辑状态和焦点，视觉退出由所属组件完成。

锚定原点来自当前 Reka primitive（如 --reka-popover-content-transform-origin），跟随碰撞后的实际方向；中心模态框可用中心原点，不能给全部弹层写同一个角落。

## 列表与切换

只给实际新进入的少量可见内容安排短错峰，不按全库索引累计延迟；过滤、排序和回看不重新演出每张卡。节点 key 表示真实记录身份，不为了触发动画更换 key。

滚动显现不反复隐藏已读内容；观察器尚未启动、偏好切换或取消时，节点仍有正确的可见回退态。

Vue TransitionGroup 的布局交接与普通进场分开判断。图库已有专属交接，复用已解码、已展示的缩略图；不为动效加载原图，不让视觉克隆参与焦点或点击。

背景和内容共享合适的时序，避免新旧文字长时间重叠。视觉过渡不延迟状态提交、取消或任务接受，也不把动画完成当成请求完成。

## 偏好和清理

CSS 同时遵循系统 prefers-reduced-motion 与项目 data-motion，保留 full 的显式覆盖语义。JS 使用 motionPreference 的公共函数，必要时通过 listenMotionChanges 响应系统、应用偏好和可见性变化；程序滚动复用 scrollBehavior。

减少动态效果时可即时切换或保留短淡入；结束在正确最终状态，文字、选中、进度与操作始终可达。hover 位移仅在 (hover: hover) and (pointer: fine) 下启用。

Vue 卸载、KeepAlive 停用和重入按资源所有权处理：取消当前动画、rAF、观察器、监听器和视觉克隆；撤销返回的订阅释放函数。迟到完成回调不能覆盖新目标或旧页面，偏好改变不能留下半透明节点。

来源：[animate](https://github.com/emilkowalski/skills/blob/2d228630ba1446365f614a108cb8252f1feda202/skills/animate/SKILL.md)、[review-animations](https://github.com/emilkowalski/skills/blob/2d228630ba1446365f614a108cb8252f1feda202/skills/review-animations/STANDARDS.md)、[find-animation-opportunities](https://github.com/emilkowalski/skills/blob/2d228630ba1446365f614a108cb8252f1feda202/skills/find-animation-opportunities/SKILL.md)；按本项目 Vue 与桌面约束适配。
