# 动效性能排查

用于定位掉帧、拖拽变慢、导航卡顿与合成层问题（时长与手感见 [动效决策](motion.md)）。

## 1. 按成本排查链路

先从相关节点与实际录屏/trace 确认驱动源与并发加载情况，再按以下顺序检查：

1. **触发布局与重绘**：是否每帧修改 `width`/`height`/`margin`/`padding`/`top`/`left`，或过渡 `box-shadow`/`border-radius`/大面积 `blur`/`transition: all`。
2. **主线程竞争**：导航/数据加载期间，JS `rAF` 动画与长任务互相阻塞时，预定过渡改用 CSS 或 WAAPI。
3. **每帧触发 Vue 响应式更新**：`pointermove`、`scroll` 或 `rAF` 内是否每帧写入 `ref`/`reactive`/Pinia；连续位移应直接作用于目标 DOM/动画实例，结束时再提交业务状态。
4. **整树重算与布局抖动**：避免在大容器逐帧改继承 CSS 变量，或对节点列表交替读写 `getBoundingClientRect` 与样式（应先批量读再批量写）。
5. **合成层滥用**：仅针对已观察到的像素跳动或掉帧对具体元素按需临时启用 `will-change` 并及时释放，禁止挂全站或全部卡片。

## 2. 性能硬边界

- **高频属性限制**：高频动画仅限 `transform`/`opacity`（例外须明确说明 `compositor-exempt` 理由）；不要通过 `scale` 假装布局改宽或用 `opacity` 替代 `display`/禁用命中。
- **阴影与缓存**：阴影动画优先改变独立阴影层的 `opacity`；不为动画额外预载原图或引入新虚拟化框架，限制在可见内容与已有缓存预算内。
- **证据口径**：以 DevTools Performance / Animations 实机表现区分代码审查与真实帧率（定位可临时慢放，交付前恢复正常令牌）；清理前确认卸载/取消时已释放 `rAF`、监听器、克隆节点与 Blob。

> 来源：[animation-performance](https://github.com/emilkowalski/skills/blob/2d228630ba1446365f614a108cb8252f1feda202/skills/animation-performance/SKILL.md)。
