# AI-CG-Studio 协作指南

交付可用、简洁的桌面产品。用户当前要求优先于一般规范；在授权范围内自主完成，达到完成标准即交付。

按需查阅：[项目状态](docs/project-status.md)、[规划](docs/roadmap.md)、[文档索引](docs/INDEX.md)、[工程契约](docs/engineering-contracts.md)、[工作流](docs/workflow.md)。

## 任务与协作

- **开工准备**　先明确用户要看到的结果、改动范围和验证方式。授权范围内可逆的实现细节自行决定。遇到需要用户取舍、扩大范围或不可逆的操作时，说明需要决定什么，先完成其余可独立推进的工作。
- **技能按需加载**：图像提示词读 [studio-prompt-craft](.agents/skills/studio-prompt-craft/SKILL.md)；角色/故事文案读 [humanizer-zh](.agents/skills/humanizer-zh/SKILL.md)；UI 与动效读 [DESIGN.md](DESIGN.md) 与 [studio-ui-design](.agents/skills/studio-ui-design/SKILL.md)。其余任务不加载无关技能。
- **Modern Web Guidance**：HTML、CSS 和浏览器端 JavaScript 改动先查阅 [Modern Web Guidance](.agents/skills/modern-web-guidance/SKILL.md)（上游 v1.0.1），按任务搜索并读取对应指南。全局现代化用 `legacy-scan` 定位候选，结合源码复核后再改，按本项目的验证规则交付。
- **浏览器兼容目标**：Windows 桌面核对实际 WebView2 运行时；共用前端以 [package.json](package.json) 的 browserslist 和 [Vite 构建目标](vite.config.ts) 为准。新 API 若超出支持范围，通过特性检测渐进增强，兼容路径保留相同的核心操作。
- **代码探索**：优先使用 `codegraph_explore` 查看实现与调用关系；工具不可用时直接阅读源码并使用 `rg`。
- **Git 规范**：写入前核对 `git status` 与 `git diff`，保留其他会话改动。严禁 `git add .` 和 `git reset --hard`；仅暂存和提交本次审查过的文件。
- **并行开发**　任务能独立拆分时，按需使用子代理，例如按角色审稿或按模块排查问题。并行改代码时各用独立 worktree，分别修改不同文件。主会话负责复核，涉及内容库时统一应用补丁并导出快照。

## 精简实现

- 架构与状态边界见 [工程契约](docs/engineering-contracts.md)，组件和依赖选择见 [设计规范](DESIGN.md#component-and-dependency-policy)。改动须兼容已保存的数据，各层在边界校验数据并独立持有可变状态。
- **资源生命周期**：长调用与生成保留取消、超时与防重入机制；Live2D、Pixi、音频等资源在离开或停用时可靠释放。
- **出图缓存**：有缓存支持时默认开启，包括试出图和批量样张。Anima 使用 TeaCache，阈值沿用对应模型或工作流的默认设置。
- **工作流维护**：复用现有工作流（`npm run workflow -- --help`）；仅工具源或配置变化时运行 `npm run build:runtime`，不手改生成的 `.js`。

## 验证与止损

- **严禁编写和运行任何测试**：不新增、不恢复任何单元测试、组件测试、E2E 测试、测试夹具及 CI 测试入口；严禁编写测试脚本或内联断言变相测试。仅在用户明确要求时方可例外。
- **审查驱动**：以源码、差异、构建和已有日志审查改动；按需执行产品构建与类型检查（入口见 [工作流](docs/workflow.md#门禁与构建)），不随意扩大检查范围。
- **实事求是**：明确区分通过、失败、未运行与待设备验证；未验证内容不得虚标通过，不以历史记录代替当前状态。
- **精准排错**：失败时先查原始日志定位根因，修复后再验证；严禁无修改重复重跑碰运气。

## 桌面开发与部署

- 桌面构建在 `main` 工作区执行。部署统一使用根目录的 `deploy-desktop.bat`，UAC 由用户确认。调试入口和打包参数见 [工作流](docs/workflow.md) 与 [桌面部署指南](docs/desktop-deployment.md)。

## 质量红线

- **创作与分级自由**：项目全面支持全年龄（SFW）及各类成人（NSFW、R18）等所有分级自由创作，不设任何露骨场景限制或门控限制；场景与参考样张保留 R18 缩略图默认模糊遮罩，用户作品册不设遮罩；大图直接展示并保留立体观画与原图缩放。
- **内容一致性**：提示词、蓝图、服装换装改动需核对编译 Token 与真实渲染效果；多条改动逐一真实重写，严禁模板拼接或虚报。
- **角色出图**：新增角色的档案立绘和场景样张统一使用无画师配方。保留角色与作品标签，出图前核对最终正向提示词没有 `@画师`，且没有选用画师风格 LoRA。
- **定稿保护**：`data/prompt-pinned-scenes.json` 为字节级基线保护，批量任务跳过；单条修改必须真实出图后通过 `npm run scenes:pin-capture` 更新并附凭据。
- **UI 标准**：严格支持双主题与 WCAG AA；禁用文字使用 `--text-disabled`（严禁用 opacity 压字）；高频动画仅使用 `transform`/`opacity`；图标统一使用 `ArchiveIcon.vue` 手绘线条 SVG，不用 Emoji 或实心图标。
- **数据权威源**：开发工作权威为 `runtime/content/catalog.sqlite`（维护命令传 `--runtime-root runtime`），`data/catalog/` 为导出的项目快照。修改角色、蓝图与场景时先用 `content:catalog authoring` 读取上下文，再通过 patch 预览、应用并定向导出。

## 交付与规范

- **交付说明**　逐项核对用户要求，用通俗中文说明完成了什么、如何核实，以及哪些假设或限制会影响使用。严禁生成任何格式的总结报告文件或聊天内嵌报告。
- **规范维护**：只沉淀长期有效、可复用的规则；临时日志、测试图和原始 JSON 放入被 Git 忽略的 `runtime/`。
