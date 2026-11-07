# AI-CG-Studio 协作指南

交付可用、简洁的桌面产品。用户当前要求优先于一般规范；在授权范围内自主完成，达到完成标准即交付。

按需查阅：[项目状态](docs/project-status.md)、[规划](docs/roadmap.md)、[文档索引](docs/INDEX.md)、[工程契约](docs/engineering-contracts.md)、[工作流](docs/workflow.md)。

## 任务与协作

- **开工准备**：明确目标、受影响文件、完成标准与验证方式；仅缺少关键决策或授权时询问。
- **技能按需加载**：图像提示词读 [studio-prompt-craft](.agents/skills/studio-prompt-craft/SKILL.md)；角色/故事文案读 [humanizer-zh](.agents/skills/humanizer-zh/SKILL.md)；UI 与动效读 [DESIGN.md](DESIGN.md) 与 [studio-ui-design](.agents/skills/studio-ui-design/SKILL.md)。其余任务不加载无关技能。
- **代码探索**：优先使用 `codegraph_explore` 查看实现与调用关系；工具不可用时直接阅读源码并使用 `rg`。
- **Git 规范**：写入前核对 `git status` 与 `git diff`，保留其他会话改动。严禁 `git add .` 和 `git reset --hard`；仅暂存和提交本次审查过的文件。
- **并行开发**：仅用于可独立拆分的任务，各自使用 worktree 且不同时修改同一文件；主会话负责复核。

## 精简实现

- **最小实现**：优先复用现有实现与依赖，做最小完整改动；不进行推测性抽象、过度封装或无关重命名；及时清理无用旧实现与死分支；单文件建议 ≤500 行。
- **组件与依赖准入**：前端优先复用共享组件与已安装成熟库，同一能力仅保留一套依赖；不因外观并存第二套交互或动效。
- **状态与架构**：复杂状态下沉至 composable，View 仅负责展示。网关协议、持久化存储与 Pinia 状态在边界做转换校验，不跨层共享可变引用。
- **资源生命周期**：长调用与生成保留取消、超时与防重入机制；Live2D、Pixi、音频等资源在离开或停用时可靠释放。
- **工作流维护**：复用现有工作流（`npm run workflow -- --help`）；仅工具源或配置变化时运行 `npm run build:runtime`，不手改生成的 `.js`。

## 验证与止损

- **严禁编写和运行任何测试**：不新增、不恢复任何单元测试、组件测试、E2E 测试、测试夹具及 CI 测试入口；严禁编写测试脚本或内联断言变相测试。仅在用户明确要求时方可例外。
- **审查驱动**：以源码、差异、构建和已有日志审查改动；按需执行产品构建与类型检查（入口见 [工作流](docs/workflow.md#门禁与构建)），不随意扩大检查范围。
- **实事求是**：明确区分通过、失败、未运行与待设备验证；未验证内容不得虚标通过，不以历史记录代替当前状态。
- **精准排错**：失败时先查原始日志定位根因，修复后再验证；严禁无修改重复重跑碰运气。

## 桌面开发与部署

- **开发入口**：Rust 调试使用 `dev:server`、`dev:tauri` 等入口；桌面构建直接在 `main` 工作区执行，复用构建缓存。
- **部署同步**：唯一入口为根目录 `deploy-desktop.bat`。日常开发默认 `desktop-local` 快速构建及无压缩升级包；正式发版使用完整 LZMA 包；纯资源改动使用 `-ResourcesOnly`。UAC 由用户确认。

## 质量红线

- **创作与分级自由**：项目全面支持全年龄（SFW）及各类成人（NSFW、R18）等所有分级自由创作，不设任何露骨场景限制或门控限制；场景与参考样张保留 R18 缩略图默认模糊遮罩，用户作品册不设遮罩；大图直接展示并保留立体观画与原图缩放。
- **内容一致性**：提示词、蓝图、服装换装改动需核对编译 Token 与真实渲染效果；多条改动逐一真实重写，严禁模板拼接或虚报。
- **定稿保护**：`data/prompt-pinned-scenes.json` 为字节级基线保护，批量任务跳过；单条修改必须真实出图后通过 `npm run scenes:pin-capture` 更新并附凭据。
- **UI 标准**：严格支持双主题与 WCAG AA；禁用文字使用 `--text-disabled`（严禁用 opacity 压字）；高频动画仅使用 `transform`/`opacity`；图标统一使用 `ArchiveIcon.vue` 手绘线条 SVG，不用 Emoji 或实心图标。
- **数据权威源**：开发工作权威为 `runtime/content/catalog.sqlite`（维护命令传 `--runtime-root runtime`），`data/catalog/` 为导出的项目快照。修改角色、蓝图与场景时先用 `content:catalog authoring` 读取上下文，再通过 patch 预览、应用并定向导出。

## 交付与规范

- **严禁编写任何形式的报告**：不生成 HTML、Markdown、纯文本、PDF 等格式的总结报告文件，不输出聊天内嵌报告；交付时仅在对话中简要说明完成结果与必要限制。
- **规范维护**：只沉淀长期有效、可复用的规则；临时日志、测试图和原始 JSON 放入被 Git 忽略的 `runtime/`。
