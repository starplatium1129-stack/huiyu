---
name: studio-ui-design
description: 依据绘遇 DESIGN.md 的视觉动效目标与 Emil Kowalski 的设计工程原则，创建、修改或审查本项目 Vue 桌面 UI 的布局、控件、表单、弹层、反馈和动效；也用于定位动效卡顿。不用于后端、普通文档、模型提示词或生成 CG 美术。
---

# 绘遇 UI 设计工程

以美观与实用共同优先。[DESIGN.md](../../../DESIGN.md#reading-guide) 维护设计标准，本入口负责查阅与实施路径，参考补充 Vue 细节；协作与验证范围遵循 [AGENTS.md](../../../AGENTS.md)。

## 使用入口

- 控件、表单、弹层、拖拽、图片查看或状态反馈：读 [交互落地](references/interaction.md)。
- 新增或修改动画、页面切换、列表交接：读 [动效决策](references/motion.md)。
- 卡顿、拖拽变慢、繁忙主线程或合成层问题：读 [动效性能](references/performance.md)；涉及时长与曲线时再读动效决策。
- 仅调整静态布局、字号或表面层级时，按 DESIGN.md 的 [Typography](../../../DESIGN.md#typography)、[Layout](../../../DESIGN.md#layout) 和 [Shapes](../../../DESIGN.md#shapes) 处理中文阅读、数据对齐、分组与嵌套几何；窄栏按实际容器宽度选择布局。涉及字段语义或文本溢出实现时再读交互落地，不加载全部参考。
- 引入新视觉效果、复制上游实现或更新采用版本：读 [来源与采用边界](references/sources.md)，再查看相关演示与对应源码。复用已有适配时先看本地规范和实际组件，无需重新浏览全部来源。

## 落地顺序

1. 按 [首次交付标准](../../../DESIGN.md#ui-delivery-standard) 明确受影响操作路径、适用状态和共享组件/样式归属，查看现有实现；组件选择遵循 [依赖准入](../../../DESIGN.md#component-and-dependency-policy)。
2. 关键交互首次交付即具备可感知动效，按 [动效标准](../../../DESIGN.md#interaction--motion) 保留幅度、节奏与层次。复用 Vue、Reka UI 和已有动效入口，保留即时操作、可中断性、减少动态效果与资源所有权。
3. 改共享规则时追踪调用方及局部覆盖，同步移除本次范围内被替代的样式。页面负责排列，控件的表面、几何和焦点由共享组件负责。
4. 沿受影响路径审查状态、恢复与返回、双主题、键鼠焦点及动效生命周期；桌面组合见 [Desktop review](../../../DESIGN.md#desktop-review)，具体交互检查见所选参考。修复本次范围内的规范遗漏；交付按 AGENTS.md 区分源码、等效视口和真实设备证据。

## 项目入口

- [共享设计令牌](../../../src/assets/css/design-system.css)与 [浅色主题](../../../src/assets/css/light-theme.css)。
- [Studio UI 组件](../../../src/components/ui/)：优先复用现有 Reka UI 封装；复杂业务状态放所属 composable。
- [AnimatedSelection](../../../src/components/visual/AnimatedSelection.vue)：分段选择的连续弹簧，不另写竞争实现。
- [动效偏好](../../../src/utils/motionPreference.ts)：prefersReducedMotion、listenMotionChanges 与 scrollBehavior。
- [滚动显现](../../../src/composables/useScrollReveal.ts)与 [图库交接](../../../src/composables/gallery/useGalleryListMotion.ts)：有相关需求才读，保留现有图片与页面生命周期。
- 分栏与图片查看分别沿用 [useDirectorLayout](../../../src/composables/prompt/useDirectorLayout.ts) 和 [ZoomableImageViewer](../../../src/components/visual/ZoomableImageViewer.vue)；聊天输入与阅读复用 [chatInput](../../../src/utils/chatInput.ts) 和 [useConversationReading](../../../src/composables/chat/useConversationReading.ts)。
