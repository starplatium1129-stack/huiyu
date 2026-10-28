# 项目文档索引

从这里查找现行指南、架构和维护入口；已提交的历史资料可从 Git 历史读取。

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
| [设计规范](../DESIGN.md) | 品牌、双主题与融合 Emil Kowalski 原则的交互和动效标准 |
| [桌面部署](desktop-deployment.md) | 构建、安装、同步及 UAC |

协作规则见 [AGENTS.md](../AGENTS.md)。普通用户从[浏览入口](index.html)、[上手教程](getting-started.html)、[模型配置](guides/setup-and-models.md)和[离线资源](guides/offline-resources.md)开始。当前发行说明为 [2.0.0](releases/v2.0.0.md)，公开发行与本机安装分别核对。

## 架构与验收

- [内容记录库](architecture/CONTENT-CATALOG-DESIGN.md)：SQLite 工作权威与显式项目快照。
- [Workspace 与迁移](architecture/WORKSPACE-MIGRATION-DESIGN.md)：单一写入权威、来源隔离、迁移和恢复。
- [持久任务](architecture/TASK-RUNTIME-DESIGN.md)：接受、取消、结果回收和重启恢复。
- [桌面接入](architecture/DESKTOP-INTEGRATION-DESIGN.md)：宿主、网关、会话与原生能力。
- [远程内容投影](architecture/REMOTE-CONTENT-DESIGN.md)：发布索引、最小字段和未知状态拒绝。
- [设备与外部条件验收清单](architecture/acceptance-checklist.md)：原 012 条件项及 009/010 场景，保留稳定 ID 和要求，不沿用旧 PASS。

专项剩余范围和暂停事项统一维护在[未来规划](roadmap.md)。

## 专题指南

[专题索引](guides/README.md)按环境、角色、美术、提示词、视频、桌面与工程分类。[研究来源](research/README.md)说明参考资料和采用边界。

角色档案与场景故事使用 [humanizer-zh](../.agents/skills/humanizer-zh/SKILL.md)，图像提示词使用 [studio-prompt-craft](../.agents/skills/studio-prompt-craft/SKILL.md)，UI 工作使用 [studio-ui-design](../.agents/skills/studio-ui-design/SKILL.md) 和[设计规范](../DESIGN.md)。

## 维护方式

同一事实只在一处维护：状态在 project-status，待办在 roadmap，命令在 workflow，长期规则在契约或指南。优先更新现有页；原始 JSON、截图和日志放入被忽略的 runtime/，不要链接干净检出中不存在的文件。第三方许可证和正式阅读页资源保留。

增删文档同步本索引、分类索引、脚本引用和[旧地址映射](redirects.json)，运行 npm run wf -- docs:check。查旧过程使用 git log -- <路径> 与 git show <提交>:<路径>，不把历史文件重新复制到现行目录。
