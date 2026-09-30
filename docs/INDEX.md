# 项目文档索引

Rust 后端六项优化与后续热点见 [六项性能优化与继续审计](audits/2026-09-30/rust-performance-six.md)：媒体索引、内部二进制块、资源单遍核验、恢复并发、轮询退避、有界解码，以及空 staging/资源快照代次修复与隔离测量。

本轮代码审计与修复见 [项目多维审计与修复](audits/2026-09-30/project-audit-and-fixes.md)：构建路径、持久任务与输出回收、视频异步、专家工作台大屏布局、Windows 审计工具及当次验收。源码与候选产物已更新，已安装版本尚未同步。

本次本地全面优化的实际结果与未覆盖范围见 [本地优化与覆盖账本（SFW 范围）](audits/2026-09-30/local-optimization.md)：桌宠 4K/DPI、近期作品读取、异步与草稿修复、外观键盘操作、测试提速及 SFW 官方资料交接。源码、构建与实际安装状态分别查项目状态。

本轮发行准备见 [1.7.4 更新说明](releases/v1.7.4.md)与[离线资源及有限优化报告](audits/2026-09-30/release-offline-optimization.md)：图库读取 180→60、可恢复缓存隔离、签名构建、隔离 ZIP 导入/两次 Rust 启动，以及正式安装、断网 GUI 和许可待验边界。

全局搜索传输收口见 [单请求搜索索引（2026-09-30）](audits/2026-09-30/search-index-transfer.md)：50 次分页改为一次轻量读取、Rust 响应 ownership 移动、实际隔离链路与双主题验证。

更新于 2026-09-30。文档按主题保留当前有效版本；已完成批次、旧状态快照与被替代报告从工作区删除，历史原文可从 Git 历史查询。报告日期只说明证据时点，不能代替当前源码或真实设备验收。

## 日常入口

| 文档 | 用途 |
| --- | --- |
| [项目说明](../README_zh.md) | 定位、下载与功能入口 |
| [设计规范](../DESIGN.md) | 品牌、主题与交互原则 |
| [项目状态](project-status.md) | 当前能力、数据规模、源码与安装身份 |
| [未来规划](roadmap.md) | 未完成、暂停与待决策事项 |
| [统一工作流](workflow.md) | 现成命令与验收范围 |
| [维护手册](maintenance.md) | 目录职责与数据维护 |
| [工程契约](engineering-contracts.md) | 模块、数据与生命周期边界 |
| [桌面部署](desktop-deployment.md) | 构建、同步、完整安装与 UAC |

协作规则见 [AGENTS.md](../AGENTS.md)。安装与换机查 [启动与排错](../STARTUP.md)、[离线资源指南](guides/offline-resources.md)与[模型开箱指南](guides/setup-and-models.md)。当前发行说明只维护 [1.7.4](releases/v1.7.4.md)。

## 现行契约与专项计划

- [Workspace 与迁移](architecture/WORKSPACE-MIGRATION-DESIGN.md)、[任务运行时](architecture/TASK-RUNTIME-DESIGN.md)、[桌面接入](architecture/DESKTOP-INTEGRATION-DESIGN.md)。
- [Rust 迁移与剩余验收（013）](../plans/013-node-to-rust-migration.md)、[交互性能（009）](../plans/009-ui-fluidity-and-performance.md)、[Live2D 适配（010）](../plans/010-companion-experience-and-live2d-adapter.md)。
- [反推满意图入场景（004）](../plans/004-scene-save-from-interrogate.md)保持暂停；[计划索引](../plans/README.md)只列仍有效范围。
- [012 功能矩阵](audits/2026-09-21/012-page-function-matrix.md)与[逐 ID 验收说明](audits/2026-09-21/012-execution-report.md)仍承接真实模型、素材与设备条件；历史 PASS 不关闭剩余事项。
- [远程内容投影契约](audits/2026-09-20/sec-03-remote-projection-design.md)保留字段、审批与拒绝边界。

## 专题与研究

- [专题指南](guides/README.md)：角色、粒子、美术、视频、桌面和工程维护。
- [研究与未验证候选](research/README.md)：独有来源资料、提示词依据和待决策方案。
- [TypeScript 开发](guides/engineering/typescript-development.md)、[Tailwind 样式](guides/engineering/tailwind-styling.md)、[维护性边界](guides/engineering/maintainability-boundaries.md)。
- [Live2D 运行时](guides/desktop/live2d-native-runtime.md)、[安装界面](guides/desktop/game-installer.md)、[Apple HIG Web 指南](guides/design/apple-hig-web-guidelines.md)。
- 图像提示词查 [skill 入口](../.agents/skills/studio-prompt-craft/SKILL.md)，按需选择 [Anima](../.agents/skills/studio-prompt-craft/references/anima.md)、[Krea](../.agents/skills/studio-prompt-craft/references/krea.md)或[数据交付](../.agents/skills/studio-prompt-craft/references/delivery.md)。
- [浏览器阅读入口](index.html)与[上手教程](getting-started.html)。

## 保留的专题验收记录

下列记录各自承接独立主题或未覆盖条件；源码、构建、安装和设备结果分别核对。旧版本安装记录由当前状态页与最新发行说明承接。

| 日期 | 主题 |
| --- | --- |
| 2026-09-30 | [全部前端与 Node 单测精简](audits/2026-09-30/test-total-simplification.md)及[454文件逐项决定](audits/2026-09-30/test-total-decisions.md) |
| 2026-09-30 | [日常测试精简与定向入口](audits/2026-09-30/test-simplification.md) |
| 2026-09-30 | [搜索索引传输与响应复制收口](audits/2026-09-30/search-index-transfer.md) |
| 2026-09-30 | [Rust 迁移后运行时性能复审](audits/2026-09-30/rust-runtime-performance.md) |
| 2026-09-30 | [1.7.4 构建、离线资源与有限优化](audits/2026-09-30/release-offline-optimization.md) |
| 2026-09-30 | [项目多维审计与修复](audits/2026-09-30/project-audit-and-fixes.md) |
| 2026-09-30 | [性能与测试负担复审](audits/2026-09-30/performance-simplification.md) |
| 2026-09-30 | [新机器离线资源交付与模型清单核对](audits/2026-09-30/offline-resource-delivery.md) |
| 2026-09-30 | [手绘遮罩撤销优化与工作区接手复核](audits/2026-09-30/mask-history-takeover.md) |
| 2026-09-30 | [本地优化与覆盖账本（SFW 范围）](audits/2026-09-30/local-optimization.md) |
| 2026-09-29 | [过度工程化审计与精简](audits/2026-09-29/engineering-simplification.md) |
| 2026-09-29 | [角色场景图片盘点与日常立绘](audits/2026-09-29/character-image-inventory.md) |
| 2026-09-29 | [Rust 后端请求与存储优化](audits/2026-09-29/backend-optimization.md) |
| 2026-09-29 | [爱莎新增角色审计](audits/2026-09-29/aisha-onboarding-audit.md) |
| 2026-09-28 | [页面数据链路性能根因与验证](audits/2026-09-28/ui-data-performance.md) |
| 2026-09-28 | [参考画册画幅与预览优化（2026-09-28）](audits/2026-09-28/showcase-image-layout.md) |
| 2026-09-28 | [性能优化报告](audits/2026-09-28/performance.md) |
| 2026-09-28 | [维护功能桌面视觉验收（2026-09-28）](audits/2026-09-28/maintenance-visual-acceptance.md) |
| 2026-09-28 | [Live2D 遮罩内存与桌宠按钮交互优化](audits/2026-09-28/live2d-mask-memory.md) |
| 2026-09-28 | [全站布局审计与统一（2026-09-28）](audits/2026-09-28/layout-unification.md) |
| 2026-09-28 | [E2E 必要性审计（2026-09-28）](audits/2026-09-28/e2e-necessity-audit.md) |
| 2026-09-28 | [桌面 UI 细节审计与修整](audits/2026-09-28/desktop-ui-craft.md) |
| 2026-09-28 | [桌面体验优化实施与验收](audits/2026-09-28/desktop-experience-implementation.md) |
| 2026-09-28 | [日常导航过渡细节优化](audits/2026-09-28/daily-navigation-motion.md) |
| 2026-09-27 | [Tailwind 全站样式迁移](audits/2026-09-27/tailwind-migration.md) |
| 2026-09-27 | [六项技术栈升级评估与实施](audits/2026-09-27/stack-upgrades.md) |
| 2026-09-21 | [012：逐页功能、状态与验收矩阵](audits/2026-09-21/012-page-function-matrix.md) |
| 2026-09-21 | [012 全站页面与功能体验执行报告](audits/2026-09-21/012-execution-report.md) |
| 2026-09-20 | [SEC-03 远程内容投影设计](audits/2026-09-20/sec-03-remote-projection-design.md) |

## 文档维护

| 目录 | 收录内容 |
| --- | --- |
| docs 根目录 | 日常入口与阅读门户 |
| architecture/ | 现行架构契约 |
| guides/ | 可重复使用的操作与维护指南 |
| research/ | 独有来源、未采纳研究及候选 |
| audits/ | 各主题仍有效的验收摘要与剩余条件 |
| releases/ | 当前发行说明 |
| evidence/ | 绑定原始源码和构建的受控证据；不改写历史身份 |

新增文档登记本页或分类索引。规模只在项目状态维护，待办只在未来规划维护。更新或删除文档时同步相对链接、脚本引用和现有旧站内地址映射，并运行 npm run wf -- docs:check；原始性能采样、截图与日志放在被忽略的 runtime/。
