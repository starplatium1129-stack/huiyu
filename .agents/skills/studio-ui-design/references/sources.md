# 来源与采用边界

引入新视觉效果、复制上游实现或升级采用版本时核对本页。采用后的设计标准统一维护在 [DESIGN.md](../../../../DESIGN.md)。

## 1. 设计工程基线

- **Emil Kowalski**：[emilkowalski/skills](https://github.com/emilkowalski/skills/tree/2d228630ba1446365f614a108cb8252f1feda202)（基线 `2d228630`，本地 [MIT 许可](../LICENSE)），提炼 `emil-design-eng`、`animate`、`review-animations`、`animation-performance`、`apple-design`、`find-animation-opportunities` 与 `pick-ui-library` 原则。
- **TypeUI**：[UI Foundations](https://www.typeui.sh/ui-foundations/configurator) / [fundamentals](https://github.com/bergside/typeui/tree/2a977f1f6616ae8a5ea84a478ca35601c67f4322/skills/fundamentals)（基线 `2a977f1f`，MIT）。采用阅读排版、数字对齐、表单分组与嵌套圆角原则；**不采用**移动端优先、16px 字号下限、标题行高 1 及禁止入场编排等限制。
- **open-claude-ui**：[分析仓库](https://github.com/Caho1/open-claude-ui/tree/2834bc158a4849f21c97cbb2e0b10525f6e646f1)（基线 `2834bc15`，MIT），仅吸收分栏手势、图片查看与容器布局原则。

## 2. 视觉与动效参考范围

| 来源 | 采用范围与保留边界 |
| --- | --- |
| [Linear DESIGN.md](https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/linear.app/DESIGN.md) | 仅借鉴表面层级、几何与密度；不采用近黑底色、品牌紫、专有字体与落地页大间距 |
| [Sakuria](https://sakuria.syarolia.com/zh-CN) | 仅借鉴图片卡片抬升、画面缩放、柔光与分层时序 |
| Inspira UI / Magic UI | 分层卡片与 Bento 构图，融入同一绘遇组件体系 |
| [AIRI](https://airi.moeru.ai/docs/ja/blog/DevLog-2025.03.10/) / [WebGAL](https://docs.openwebgal.com/webgal-script/custom-ui.html) | 轻量装饰、菜单高亮与角色优先构图；保留暖纸/夜幕配色与手绘图标 |
| [Lucian UX/UI Prompt](https://lucianlabs.dev/uxui-prompt/) | 导航、筛选、保存反馈、作品交接与主题圆扩散动效（快照 [7e339faa](https://github.com/Seokwoooo/lucian-uxui-prompt/tree/7e339faa1cc5e87496cb7ce556a5b22aadbe76f8)，MIT） |

## 3. 全局适配红线

- 保留绘遇品牌、双主题、中文排版尺度、桌面优先与 Vue + Reka UI 技术栈（不引入 React、Expo、Swift、Sonner 或移动优先流程）。
- 保留源码/许可溯源；不引入动画 `blur`/`clip-path`（主题切换除外）、demo 自动播放或虚假进度反馈。
