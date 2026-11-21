---
name: studio-ui-design
description: 依据绘遇 DESIGN.md 的视觉动效目标与 Emil Kowalski 的设计工程原则，创建、修改或审查本项目 Vue 桌面 UI 的布局、控件、表单、弹层、反馈和动效；也用于定位动效卡顿。不用于后端、普通文档、模型提示词或生成 CG 美术。
---

# 绘遇 UI 设计工程

全局规范以 [DESIGN.md](../../../DESIGN.md#reading-guide) 为准，协作与验证范围遵循 [AGENTS.md](../../../AGENTS.md)。本入口按场景路由到 Vue 实施细节：

## 场景导航

- **控件、表单、弹层、拖拽或图片查看**：读 [交互落地](references/interaction.md)。
- **新增或修改动画、转场与列表交接**：读 [动效决策](references/motion.md)。
- **定位掉帧、拖拽卡顿或主线程阻塞**：读 [动效性能](references/performance.md)。
- **静态布局、排版与形状**：按 DESIGN.md 的 [Typography](../../../DESIGN.md#typography)、[Layout](../../../DESIGN.md#layout)、[Shapes](../../../DESIGN.md#shapes) 执行，不加载无关参考。
- **引入新视觉效果或更新采用版本**：读 [来源与采用边界](references/sources.md)。

## 落地顺序

1. 明确受影响路径、可达状态与共享组件归属；组件选型遵循 [依赖准入](../../../DESIGN.md#component-and-dependency-policy)。
2. 关键交互首轮交付即包含符合 [动效标准](../../../DESIGN.md#interaction--motion) 的动画与 reduced-motion 回退。
3. 修改共享规则须追踪全部调用方与局部覆盖，同步清理过期样式。
4. 沿路径审查双主题、键鼠焦点、错误恢复与卸载清理，以 [Desktop review](../../../DESIGN.md#desktop-review) 口径区分源码、等效视口与真机证据。

## 核心代码入口

- **主题令牌**：[design-system.css](../../../src/assets/css/design-system.css) · [light-theme.css](../../../src/assets/css/light-theme.css)
- **交互基元**：[Studio UI 组件](../../../src/components/ui/)（Reka UI 封装）· [AnimatedSelection](../../../src/components/visual/AnimatedSelection.vue)
- **动效与滚动**：[motionPreference.ts](../../../src/utils/motionPreference.ts) · [useScrollReveal.ts](../../../src/composables/useScrollReveal.ts) · [useGalleryListMotion.ts](../../../src/composables/gallery/useGalleryListMotion.ts)
- **工作台与看图/聊天**：[useDirectorLayout.ts](../../../src/composables/prompt/useDirectorLayout.ts) · [ZoomableImageViewer.vue](../../../src/components/visual/ZoomableImageViewer.vue) · [chatInput.ts](../../../src/utils/chatInput.ts) · [useConversationReading.ts](../../../src/composables/chat/useConversationReading.ts)
