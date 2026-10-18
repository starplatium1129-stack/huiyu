---
name: studio-ui-design
description: 依据绘遇 DESIGN.md 的视觉动效目标与 Emil Kowalski 的设计工程原则，创建、修改或审查本项目 Vue 桌面 UI 的布局、控件、表单、弹层、反馈和动效；也用于定位动效卡顿。不用于后端、普通文档、模型提示词或生成 CG 美术。
---

# 绘遇 UI 设计工程

以美观与实用共同优先，以 [DESIGN.md](../../../DESIGN.md) 为设计真相源；先读其中与当前页面相关的部分，再按任务读取下面的参考。布局、控件和必需动效都应提升视觉品质与操作体验。直接完成已授权工作。

## 使用入口

- 控件、表单、弹层、拖拽、图片查看或状态反馈：读 [交互落地](references/interaction.md)。
- 新增或修改动画、页面切换、列表交接：读 [动效决策](references/motion.md)。
- 卡顿、拖拽变慢、繁忙主线程或合成层问题：读 [动效性能](references/performance.md)；涉及时长与曲线时再读动效决策。
- 仅调整静态布局、字号或表面层级时，使用 DESIGN.md 的现有品牌、字体、几何与令牌；窄栏按实际容器宽度选择布局，不加载全部参考。

## 落地顺序

1. 按 [首次交付标准](../../../DESIGN.md#ui-delivery-standard) 明确受影响操作从入口到结果、恢复与返回的路径、适用状态及共享组件/样式归属，查看现有实现和依赖。已有规范在本轮落实，不等用户逐项指出或留到后续统一优化。
2. 关键交互必须在首次交付中具备可感知动效。按 DESIGN.md 确认当前交互适用的参考范围、幅度、节奏与层次，再判断频率和用途；高频操作立即响应、连续动效可中断，并提供减少动态效果下的替代行为。
3. 静态布局复用共享令牌，改共享规则时追踪实际调用方与局部覆盖，同步移除本次范围内被替代的样式；简单过渡优先 CSS，程序控制可用 WAAPI，真实弹簧或复杂编排才复用现有 motion。
4. 复用 Vue 与 Reka UI 的真实入口，保留现有键鼠语义、焦点与资源所有权。采用上游方法时改写为本项目实现，不复制 React API。
5. 交付前沿第 1 步的操作路径审查适用状态、桌面布局与键鼠焦点，并核对动效目的、时序、原点、中断、减少动态效果及生命周期。按 DESIGN.md 的桌面组合优先查看主力 4K、2K 与笔记本，窄窗口作为补充；按 AGENTS.md 在受影响范围内人工验收双主题与实际画面。源码审查、类型/构建、等效视口与真实设备证据分别说明，未查看的状态或设备表现不能宣称通过。主动修复本次范围内的规范遗漏后再交付。

## 项目入口

- [共享设计令牌](../../../src/assets/css/design-system.css)与 [浅色主题](../../../src/assets/css/light-theme.css)。
- [Studio UI 组件](../../../src/components/ui/)：优先复用现有 Reka UI 封装；复杂业务状态放所属 composable。
- [AnimatedSelection](../../../src/components/visual/AnimatedSelection.vue)：分段选择的连续弹簧，不另写竞争实现。
- [动效偏好](../../../src/utils/motionPreference.ts)：prefersReducedMotion、listenMotionChanges 与 scrollBehavior。
- [滚动显现](../../../src/composables/useScrollReveal.ts)与 [图库交接](../../../src/composables/gallery/useGalleryListMotion.ts)：有相关需求才读，保留现有图片与页面生命周期。
- 分栏与图片查看分别沿用 [useDirectorLayout](../../../src/composables/prompt/useDirectorLayout.ts) 和 [ZoomableImageViewer](../../../src/components/visual/ZoomableImageViewer.vue)；聊天输入与阅读复用 [chatInput](../../../src/utils/chatInput.ts) 和 [useConversationReading](../../../src/composables/chat/useConversationReading.ts)。

## 来源与采用边界

组件样式与动效另参考 [Lucian UX/UI Prompt](https://lucianlabs.dev/uxui-prompt/)；已核对的源码快照为 [7e339faa1cc5e87496cb7ce556a5b22aadbe76f8](https://github.com/Seokwoooo/lucian-uxui-prompt/tree/7e339faa1cc5e87496cb7ce556a5b22aadbe76f8)，许可为 MIT © 2026 Seokwoooo。按当前操作路径选择示例，先观察实际演示，再核对同版 `src/elements` 的时序和中断；已有适配先审查后复用。复制实现时保留来源、示例编号和许可，不把演示自动播放或模拟成功带入真实状态。

融合自 [emilkowalski/skills](https://github.com/emilkowalski/skills/tree/2d228630ba1446365f614a108cb8252f1feda202)，采用基线为 `2d228630ba1446365f614a108cb8252f1feda202`（2026-10-14 接入），保留 [MIT 许可证](LICENSE)。

本入口与参考提炼 emil-design-eng、animate、review-animations、animation-performance、apple-design、find-animation-opportunities 和 pick-ui-library 的适用原则；采用后的规范维护在 DESIGN.md，参考只补充 Vue 实施细节。后续上游更新需审查实际差异后融入，不自动改变项目标准。

补充交互参考为 [Caho1/open-claude-ui](https://github.com/Caho1/open-claude-ui/tree/2834bc158a4849f21c97cbb2e0b10525f6e646f1) 的独立逆向分析，参考基线为 `2834bc158a4849f21c97cbb2e0b10525f6e646f1`（2026-10-15，[上游 MIT 许可证](https://github.com/Caho1/open-claude-ui/blob/2834bc158a4849f21c97cbb2e0b10525f6e646f1/LICENSE)）。仅吸收分栏手势、图片查看及容器布局的适用原则。引入具体实现或参数前须核对同一版本的文档与源码，再按绘遇场景验证；文档声明不作为运行或性能证据。日常任务使用本地规范，无需反复加载上游手册。

适配取舍：

- 按动效角色复用合适的语义令牌；参考站的表现目标与上游工程原则共同适配，不把高频或性能要求推导成统一的小幅度、短时长。
- 将 React、Base UI、Framer Motion 示例转为现有 Vue、Reka UI 与 motion；不引入 React、Expo、Swift、Sonner 或移动端专用流程。
- 不默认采用动画 blur、clip-path、高度动画或新增玻璃层；性能例外按 AGENTS.md 处理。
- 保留项目已有验收和交付约束；上游固定欢迎语、强制停止等待、测试、报告模板与全仓审计流程不导入。
