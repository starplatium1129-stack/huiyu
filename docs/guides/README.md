# 专题指南

整理日期：2026-10-09。按问题查阅，通用约束以 DESIGN 和工程契约为准。以下只保留现行操作入口与独立创作参考；历史参数/实验不作为本次验证。当前实现见[项目状态](../project-status.md)，待办见[未来规划](../roadmap.md)。

[返回主索引](../INDEX.md)

## 环境与模型

- [离线素材安装与发行](offline-resources.md)：程序、素材与模型分开准备。
- [本地硬件与模型配置指南](setup-and-models.md)：文件位置、下载入口与体检；服务连接、实际推理和设备验收分别核对。

<a id="art"></a>

## 美术与创作

- [CG 美术风格规范 · 绫季绘境](art/art-direction.html)
- [创作取向 · 绫季绘境](art/philosophy.html)
- [出图质量检查 · 绫季绘境](art/quality-standard.html)
- [项目定位 · 绫季绘境](art/worldview.html)

<a id="characters"></a>

## 角色与粒子

- [热门角色接入工作流](characters/character-onboarding-workflow.md)
- [角色点阵粒子管线（操作手册）](characters/particle-portrait-pipeline.md)
- [视觉资产审核与用户审美意见](characters/quality-audit-standards-charter.md)
- [Scene 数据与写作规范 · 绫季绘境](characters/scene-spec.html)

<a id="desktop"></a>

## 桌面与桌宠

- [AI-CG-Studio 桌宠（Companion）DSH 架构对齐与配置指南](desktop/companion-dsh-agent-architecture.md)
- [绫季绘境 · 现代安装界面](desktop/game-installer.md)
- [Live2D 原生运行时](desktop/live2d-native-runtime.md)

<a id="engineering"></a>

## 工程设计

- [页面标题 · 绫季绘境](engineering/page-template.html)
- [随机灵感（Random Prompt Assembler）设计文档](engineering/random-prompt-assembler-design.md)
- [工程维护边界](engineering/maintainability-boundaries.md)
- [TypeScript 开发与生成物边界](engineering/typescript-development.md)
- [Tailwind 样式维护](engineering/tailwind-styling.md)
- [Apple HIG Web 指南](design/apple-hig-web-guidelines.md)

<a id="prompts"></a>

## 提示词

现行双引擎编译与交付统一查 [项目 skill](../../.agents/skills/studio-prompt-craft/SKILL.md)。

- [成年角色 NSFW / R-18 CG 提示词与蓝图编译规范](prompts/nsfw-cg-prompt-standard.md)：双引擎 NSFW 语法、脱衣防冲突机制、Danbooru 核心标签矩阵与 R-18 蓝图规范。
- [手机竖屏人物壁纸规范](prompts/mobile-wallpaper-prompt-standard.md)：iPhone 17 Pro 与通用长屏；裁切、锁屏／主屏遮挡及双引擎候选。
- [单人物立绘与特写壁纸提示词规范](prompts/character-wallpaper-prompt-standard.md)：与叙事 CG 并列；人物表现、4K 横幅留白及裁切验收。
- [人物与环境融合的叙事 CG 提示词规范](prompts/narrative-cg-prompt-standard.md)：双引擎写法、原创案例和主力机对照验收。
- [Prompt 规范 · 绫季绘境](prompts/prompt-spec.html)
- [标签规范 · 绫季绘境](prompts/tag-standard.html)
- [词条出图语义参考](prompts/tag-visual-semantics.md)

<a id="video"></a>

## 视频

- [视频与分镜工作流](video/video-ai-storyboard.md)：操作、当前 Rust/前端入口和真实成片验收边界。
