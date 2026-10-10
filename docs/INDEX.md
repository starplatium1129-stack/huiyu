# 项目文档索引

整理日期：2026-10-09。保留现行文档与今日交付记录；历史版本、过程报告和旧原始证据由 Git 历史保存。整理日期不表示重新执行模型、设备或全仓验收。

## 日常入口

| 文档 | 唯一维护职责 |
| --- | --- |
| [项目说明](../README_zh.md) / [English](../README.md) | 产品、下载与功能入口 |
| [启动与排错](../STARTUP.md) | 安装、源码启动与常见故障 |
| [项目状态](project-status.md) | 当前能力、源码/发行/安装身份和已知限制 |
| [未来规划](roadmap.md) | 待开发、待验收、暂停与待决策事项 |
| [统一工作流](workflow.md) | 现有命令、权限与定向验证 |
| [内容维护](maintenance.md) | 工作库、记录修改、快照与保护 |
| [工程契约](engineering-contracts.md) | 模块、数据、任务与资源生命周期 |
| [设计规范](../DESIGN.md) | 品牌、双主题与交互原则 |
| [桌面部署](desktop-deployment.md) | 构建、安装、同步及 UAC |

协作规则见 [AGENTS.md](../AGENTS.md)。普通用户从[浏览入口](index.html)、[上手教程](getting-started.html)、[模型配置](guides/setup-and-models.md)和[离线资源](guides/offline-resources.md)开始。当前保留的发行说明为 [1.9.2](releases/v1.9.2.md)，公开发行与本机安装分别核对。

## 架构与验收

- [内容记录库](architecture/CONTENT-CATALOG-DESIGN.md)：SQLite 工作权威与显式项目快照。
- [Workspace 与迁移](architecture/WORKSPACE-MIGRATION-DESIGN.md)：单一写入权威、来源隔离、迁移和恢复。
- [持久任务](architecture/TASK-RUNTIME-DESIGN.md)：接受、取消、结果回收和重启恢复。
- [桌面接入](architecture/DESKTOP-INTEGRATION-DESIGN.md)：宿主、网关、会话与原生能力。
- [远程内容投影](architecture/REMOTE-CONTENT-DESIGN.md)：发布索引、最小字段和未知状态拒绝。
- [设备与外部条件验收清单](architecture/acceptance-checklist.md)：原 012 条件项及 009/010 场景，保留稳定 ID 和要求，不沿用旧 PASS。

009、010、013 的剩余范围和 004 的暂停决定统一维护在[未来规划](roadmap.md)，不再并行维护专项进度副本。

- [独立推理候选接入](guides/independent-inference.md)：无 ComfyUI 文生图里程碑、独立运行库与未验收范围。

## 专题指南

[专题索引](guides/README.md)按环境、角色、美术、提示词、视频、桌面与工程分类。专题只维护可复用规则，当前状态不重复登记。

- 工程：[TypeScript](guides/engineering/typescript-development.md)、[Tailwind](guides/engineering/tailwind-styling.md)、[维护性边界](guides/engineering/maintainability-boundaries.md)。
- 桌面：[Live2D](guides/desktop/live2d-native-runtime.md)、[安装界面](guides/desktop/game-installer.md)、[陪伴配置](guides/desktop/companion-dsh-agent-architecture.md)。
- 内容：[角色接入](guides/characters/character-onboarding-workflow.md)、[粒子管线](guides/characters/particle-portrait-pipeline.md)、[视频工作流](guides/video/video-ai-storyboard.md)。
- 提示词：[项目 skill](../.agents/skills/studio-prompt-craft/SKILL.md)及其作者规则、Anima/Krea 编译和交付参考；本次不修改提示词或生产内容。
- [研究来源与采用边界](research/README.md)：只保留必要来源和未采纳条件，候选不等于实施承诺。

## 今日记录

- [独立推理当前候选汇总](audits/2026-10-09/independent-inference-current.html)：自动/手绘局部重绘、严格离线单文件转换、实际验证与发行缺口。

- [独立推理手绘局部重绘](audits/2026-10-09/independent-inference-phase3.html)：逐步蒙版采样、输入保护与应用交互；真实设备验收待完成。

- [独立推理第二阶段](audits/2026-10-09/independent-inference-phase2.html)：LoRA、图生图、应用配置与诊断；编译和实机验收仍待完成。

- [独立推理候选切片](audits/2026-10-09/independent-inference.html)：本次实现、定向验证与尚未完成的替代范围。

- [前后端持续优化](audits/2026-10-09/fullstack-performance.html)：九轮改进、舍弃方案、内容门禁剩余失败和未验范围。
- [文档归纳与清理](audits/2026-10-09/documentation-cleanup.html)：本次合并、清理数量、链接检查和范围。

- [独立推理 TeaCache 候选](audits/2026-10-10/independent-inference-teacache.html)：默认关闭的缓存执行、本机校准/验收与设备阻塞。

- [独立推理编译与离线初装](audits/2026-10-10/independent-inference-setup.html)：Rust 编译、应用离线准备、完整目录导入及设备验收限制。

## 维护方式

同一事实只在一处维护：状态在 project-status，待办在 roadmap，命令在 workflow，长期规则在契约或指南。更新现有页优先于新建日期副本；原始 JSON、截图、日志写入被忽略的 runtime/，仓库文档只注明其本机路径，不生成干净检出不可用的链接或图片。第三方许可证、运行数据、测试夹具和正式阅读页资源不属于过期文档。

增删文档同步本索引、分类索引、脚本引用和[旧地址映射](redirects.json)，运行 npm run wf -- docs:check。查旧过程使用 git log -- <路径> 与 git show <提交>:<路径>，不把历史文件重新复制到现行目录。
