# 来源与采用边界

引入新视觉效果、复制上游实现或更新采用版本时读取相关条目。日常复用已有适配时使用 DESIGN.md、所属组件与本地实施参考；无需重新浏览全部来源。

采用后的设计标准统一维护在 [DESIGN.md](../../../../DESIGN.md)，Vue 实施方式维护在本 skill 的交互、动效和性能参考中。上游更新先审查实际差异，不自动改变项目标准。复制代码保留来源、版本和许可；演示与文档声明不代替实际运行或设备证据。

## 设计工程

- **Emil Kowalski**：[emilkowalski/skills](https://github.com/emilkowalski/skills/tree/2d228630ba1446365f614a108cb8252f1feda202)，采用基线 `2d228630ba1446365f614a108cb8252f1feda202`（2026-10-14 接入），保留本地 [MIT 许可证](../LICENSE)。提炼 emil-design-eng、animate、review-animations、animation-performance、apple-design、find-animation-opportunities 和 pick-ui-library 的适用原则。
- **TypeUI**：[UI Foundations](https://www.typeui.sh/ui-foundations/configurator) 公开目录与示例（2026-10-20 查阅），官方 [fundamentals](https://github.com/bergside/typeui/tree/2a977f1f6616ae8a5ea84a478ca35601c67f4322/skills/fundamentals) 基线 `2a977f1f6616ae8a5ea84a478ca35601c67f4322`（[MIT © 2026 Bergside LLC](https://github.com/bergside/typeui/blob/2a977f1f6616ae8a5ea84a478ca35601c67f4322/LICENSE.md)）。网站与仓库分别记录，不假定同版。采用阅读、数字对齐、表单、分组、嵌套圆角和图片框架原则；不采用移动端优先、统一 16px 字号下限、标题行高 1、固定 32px 标题间距、统一短动效或禁止产品页入场编排等约束。
- **open-claude-ui**：[独立逆向分析](https://github.com/Caho1/open-claude-ui/tree/2834bc158a4849f21c97cbb2e0b10525f6e646f1)，参考基线 `2834bc158a4849f21c97cbb2e0b10525f6e646f1`（2026-10-15，[MIT 许可证](https://github.com/Caho1/open-claude-ui/blob/2834bc158a4849f21c97cbb2e0b10525f6e646f1/LICENSE)）。仅吸收分栏手势、图片查看及容器布局原则；引入具体实现或参数前核对同版文档与源码。

## 视觉与动效

| 来源 | 采用范围与边界 |
| --- | --- |
| [VoltAgent 的 Linear DESIGN.md](https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/linear.app/DESIGN.md) | 独立分析营销站的表面层级、控件几何、间距与重点；不作为 Linear 应用规范，不采用近黑底色、紫色品牌、专有字体、大宣传标题和落地页区段间距。 |
| [Sakuria](https://sakuria.syarolia.com/zh-CN) | 图片卡片抬升、画面缩放、柔光及分层时序；范围仅为图片和图片卡片。 |
| Inspira UI / Magic UI | Inspira UI 的分层卡片与交互控件、Magic UI 的 Bento 构图；导航、页面切换和弹层按绘遇目标选择适用模式，整合到同一组件体系。 |
| [AIRI](https://airi.moeru.ai/docs/ja/blog/DevLog-2025.03.10/) / [WebGAL](https://docs.openwebgal.com/webgal-script/custom-ui.html) | 轻量装饰节奏、半透明菜单高亮和角色优先构图；保留暖纸、手绘图标与夜幕色板，不导入组件或替换配色。 |
| [Lucian UX/UI Prompt](https://lucianlabs.dev/uxui-prompt/) | 控件、导航、筛选、详情、保存反馈和作品交接的样式与动效。源码快照 [7e339faa1cc5e87496cb7ce556a5b22aadbe76f8](https://github.com/Seokwoooo/lucian-uxui-prompt/tree/7e339faa1cc5e87496cb7ce556a5b22aadbe76f8)，MIT © 2026 Seokwoooo。 |

采用新效果时先观察相关演示，确认触发、原点、阶段、幅度、时序和中断，再核对对应源码；Lucian 示例查看同版 `src/elements`，复制时保留示例编号。网站演示可能更新，不把当前网站当作所记录源码版本的运行证据。

## 适配取舍

- 保留绘遇品牌、双主题、中文字号、控件几何、桌面优先和动效角色。参考站的表现目标与工程原则共同适配，不把高频或性能要求推导成统一的小幅度、短时长。
- 将 React、Base UI、Framer Motion 示例转为现有 Vue、Reka UI 与 motion；不引入 React、Expo、Swift、Sonner 或移动端专用流程。依赖选择遵循 DESIGN.md 的组件与依赖准入。
- 不默认采用动画 blur、clip-path、高度动画或新增玻璃层；性能例外按 AGENTS.md 处理。
- 保留即时操作、键鼠语义、减少动态效果与真实请求状态；不把演示自动播放或模拟成功带入产品。
- 保留项目验收与交付约束；上游固定欢迎语、强制停止等待、测试、报告模板与全仓审计流程不导入。
