# 动效性能

用于卡顿、拖拽变慢、导航期间掉帧或合成层问题；时长与手感判断另见 [动效决策](motion.md)。

## 先说明原因

从本次相关节点、原始日志和已有画面证据确认：谁驱动动画、改变什么属性、是否与数据加载或页面切换同时发生。源码可证明属性与更新链路，实际帧率和设备效果需要对应画面或录制证据，不能凭 transform 或 will-change 宣称已流畅。

按已有失败止损规则推进，没有新诊断证据不重复同一操作，也不为小问题扩大成全仓审计。

## 按成本定位

1. 先查看布局属性：width、height、margin、padding、top、left 是否逐帧变化；再看 box-shadow、border-radius、大面积 blur 等绘制成本。transition: all 改为明确属性。
2. 导航或加载时才卡顿，查看主线程工作与动画驱动。可预定的 transform/opacity 优先 CSS 或 WAAPI；JS rAF 与长任务竞争，已有 motion 也需查看实际使用路径。
3. pointermove、scroll 或 rAF 内是否每帧写 ref、reactive、computed 依赖或 Pinia，带动整片 Vue 节点更新。只用于显示的连续位移由所属 DOM/动画实例更新，最终业务值才按需要提交。
4. 内容越多越慢，查看是否在大容器逐帧修改继承 CSS 变量、同时读取/写入布局或启动太多节点动画。局部位移写目标 transform，不修改根节点令牌。
5. 确有合成层切换、像素跳动或掉帧证据后，才考虑局部 will-change；仅在需要时启用并释放，不加到全站、每张卡或巨大容器。

读取几何和写入样式按帧分批，避免每个节点交替 getBoundingClientRect 与样式写入。不要为“优化”把布局测量移到更频繁的滚动处理。

## 优化边界

- 高频动画仅 transform/opacity。height、clip-path、filter 或阴影动画不能因为上游列为可加速就默认放行；必要例外写 compositor-exempt 理由并沿现有流程评审。
- transform/opacity 是优先候选，不是 GPU 保证；浏览器、过滤器、层尺寸和上下文会影响实际路径。React Motion shorthand 的结论不能直接套到本项目所有 motion 调用。
- 实际列宽、换行、滚动区域和画布比例不能由视觉 scale 假装完成；scale 同时缩放文字和子节点，不总与改宽高等价。
- opacity 不代替 display、可聚焦性或可访问状态。离场后仍须按组件语义解除命中和焦点；禁用态文字不通过压低 opacity 表达。
- 阴影优先保留静态材质，必要时变更单独阴影层的 opacity；不统一替换成 drop-shadow，也不默认添加 blur 过渡。
- 不每帧改变大树的继承 CSS 变量；共享主题令牌用于稳定样式，连续位移只影响拥有动画的节点。
- 不为动画预载高清图片、放大缓存或新增虚拟化框架。优先限制在真实可见内容，复用已解码资源与项目现有图库预算。

## 有证据再声明效果

必要时使用现有 DevTools Performance 或 Animations 面板人工查看长任务、布局、绘制、同步与中断；慢放只用于定位，交付恢复正常令牌。桌面 CPU 降速不能代表真实 GPU、DPI 或高刷新屏。

源码审查结论与实际设备表现分开说明。确认受影响组件的动画、rAF、监听器、视觉副本和 Blob 所有权在退出或取消时释放，不让性能修复引入 stale 回调或隐藏资源累积。

来源：[animation-performance](https://github.com/emilkowalski/skills/blob/2d228630ba1446365f614a108cb8252f1feda202/skills/animation-performance/SKILL.md)；采用成本诊断方法，不采用其移动端基准、报告流程或加速保证。
