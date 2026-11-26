# AI-CG-Studio 协作指南

用户当前要求优先；授权范围内自主完成并交付。参考：[状态](docs/project-status.md) · [规划](docs/roadmap.md) · [索引](docs/INDEX.md) · [工程契约](docs/engineering-contracts.md) · [工作流](docs/workflow.md) · [设计规范](DESIGN.md)。

## 协作与流程

- **准备与边界**：先明确目标效果、范围和验证方式；需取舍、扩范围或不可逆时先问用户并推进独立部分。
- **桌面绘图**：共用 `cli-anything-huiyu --json` 或 Muse HTTP 接口，按 `batchKey` 交接与排错，见 [CLI 技能](tools/cli-anything-huiyu/SKILL.md)。
- **技能按需加载**（仅 5 项）：图像提示词读 [studio-prompt-craft](.agents/skills/studio-prompt-craft/SKILL.md)；视频提示词读 [video-prompt-craft](.agents/skills/video-prompt-craft/SKILL.md)；角色/故事文案读 [humanizer-zh](.agents/skills/humanizer-zh/SKILL.md)；桌面 Vue UI 读 [DESIGN.md](DESIGN.md) 与 [studio-ui-design](.agents/skills/studio-ui-design/SKILL.md)；HTML/CSS/浏览器 JS 改动先查 [modern-web-guidance](.agents/skills/modern-web-guidance/SKILL.md)（用后附合规披露）。其余任务不加载无关技能。
- **前端兼容与探索**：桌面核对实际 WebView2，共用前端以 [package.json](package.json) browserslist 与 [vite.config.ts](vite.config.ts) 为准；超范围 API 做特性检测渐进增强。探索优先用 `codegraph_explore`，不可用时读源码与 `rg`。
- **Git 与并行**：写入前核对 `git status`/`git diff`，保留他改；严禁 `git add .` 与 `git reset --hard`，仅暂存审查过的文件。可拆分任务用独立 worktree 改不同文件，内容库补丁与导出由主会话统一执行。

## 实现、验证与部署

- **架构与生命周期**：分层与持久边界见 [工程契约](docs/engineering-contracts.md)，依赖准入见 [DESIGN.md](DESIGN.md#component-and-dependency-policy)。改动兼容已存数据；长任务支持取消/超时/防重入；Live2D/Pixi/音频离页可靠释放；生图默认开启缓存（Anima 用 TeaCache 默认阈值）。
- **工作流产物**：复用 `npm run wf -- --help`；仅工具源或配置改动后跑 `npm run build:runtime`，严禁手改生成 `.js`。
- **严禁测试**：不新增、不恢复、不运行任何单测、组件/E2E 测试、夹具或内联断言脚本（仅用户明确要求例外）。
- **审查与止损**：靠源码、差异、类型检查与产品构建验证（[工作流](docs/workflow.md#门禁与构建)），实事求是区分已验/未验/待真机；失败先查原始日志定位根因，严禁无修改重复重跑。
- **桌面构建与部署**：构建在 `main` 执行，部署统一用 `deploy-desktop.bat`（UAC 由用户确认），详见 [部署指南](docs/desktop-deployment.md)。

## 质量红线

- **全分级自由创作**：全面支持 SFW、NSFW、R18 等所有分级，不设任何门控或露骨场景限制；目录与参考样张保留 R18 缩略图默认模糊遮罩，用户作品册不设遮罩，大图支持立体观画与原图缩放。
- **内容与角色出图**：提示词、蓝图与换装核对编译 Token 与真实渲染，多条改动逐一重写禁模板拼接。新增角色立绘与样张统一用无画师配方（保留角色/作品标签，正向前核对无 `@画师` 与画师 LoRA）。
- **定稿保护**：`data/prompt-pinned-scenes.json` 字节级保护，批处理跳过；单条修改须真实出图后跑 `npm run scenes:pin-capture` 更新并附凭据。
- **UI 标准**：严格支持双主题与 WCAG 2.2 AA；禁用文字用 `--text-disabled`（严禁 opacity 压字）；高频动效仅用 `transform`/`opacity`；图标统一用 `ArchiveIcon.vue` 手绘单线 SVG，不用 Emoji 或实心图标。
- **数据权威**：开发权威为 `runtime/content/catalog.sqlite`（`--runtime-root runtime`），`data/catalog/` 为导出快照；修改角色/蓝图/场景走 `content:catalog authoring` → patch 预览/应用 → 定向导出（见 [维护手册](docs/maintenance.md)）。
- **交付与卫生**：用通俗中文逐项说明改动、核实方式及限制；严禁生成任何总结报告文件或聊天内嵌报告。临时日志、测试图与原始 JSON 放入被忽略的 `runtime/`。
