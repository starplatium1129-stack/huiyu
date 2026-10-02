# 项目文档索引

[生产代码体量审计与精简](audits/2026-10-02/code-slimming-refactor.md)记录无调用模块与失效入口退出、前端/维护工具/Rust 重复实现收敛，以及隔离整合验证和保留原因。

[测试体系重构](audits/2026-10-02/test-suite-refactor.md)记录扩大范围后的测试合并、旧专题退役、精准专项派发与全量入口去重，以及当次整合验证和失败修复。

[测试精简](audits/2026-10-02/test-pruning.md)记录弱源码检查退役、重复前端/浏览器用例合并、保留覆盖与当次定向验收。

[设置、媒体生命周期与缓存读取审计](audits/2026-10-02/settings-media-lifecycle-audit.md)记录服务商密钥隔离、语音/搜索浮层、任务预览释放、视频轮询竞态和 Rust 暖缓存排队优化，附隔离构建与定向验证。

[二级界面与读取性能精修](audits/2026-10-02/atelier-experience-polish.md)记录聊天菜单/确认框、创作资料导航/搜索、画廊批量扫描与 Rust 参考读取并发优化，以及双主题桌面浏览器证据和原生未验边界。

[安装产物的普通用户审计](audits/2026-10-02/installer-user-audit.md)区分现成 1.8.1 包与待重建修复，记录助手随包和入口、安装占用保护、中文空格路径、取消恢复及默认数据保留的当次证据和实机边界。

[三路视觉独立整合交付](audits/2026-10-02/visual-integration-handoff.md)汇总画布动效、灵感叠卡与画册展开的来源保留、round9/发布接入、组合类型与生产预算，以及主分支交接前提。

[第九轮独立整合交付](audits/2026-10-02/round9-integration.md)汇总四路来源、原始提交保留、指定 Rust 回归与类型/接口检查，并明确主分支接入步骤及发布未验边界。

[第九轮共享生命周期核查](audits/2026-10-02/round9-runtime-lifecycle.md)记录 20 轮合成导航的监听器、timer、observer、频道与 Blob URL 计数；未复现持续增长，保留产品代码，并列明原生桌面未验边界。

[第九轮图库滚动与预览取消](audits/2026-10-02/gallery-scroll-preview-cancellation.md)记录 3,000 条合成记录的旧请求占位复现、解码释放修复、缓存边界及当次定向验证。

最新公开安装包与第一至第八轮更新汇总见 [1.8.1 更新说明](releases/v1.8.1.md)，实际发行及验证结果见[项目状态](project-status.md)。

[生成光纹与水纹归静](audits/2026-10-02/magic-reveal-handoff.md)记录隔离视觉版、短时 GPU 预算、深浅主题前后对照与桌面高 DPI 性能未验边界。

[Gallery 选图连续展开与收回](audits/2026-10-02/gallery-origin-expansion.md)记录缩略图预览衔接、限像素过渡层、离屏焦点与中断清理、真实组件双主题证据及第九轮整合依赖。

[Rust 画册读取优化](audits/2026-10-02/gallery-backend-reads.md)记录有效作品索引、正文重复分配消除、合成分页实测与当次回归，区分读取切片收益和桌面未验范围。

[角色场景同页导航核查](audits/2026-10-02/popular-scene-navigation.md)记录角色参数变化后旧列表与绘制目标修复、缩略图缓存试验的撤回依据及隔离浏览器验收边界。

[WebUI 收集与生成队列解耦](audits/2026-10-02/webui-collection-worker.md)记录阻塞 hook 的旧/新对照、有限重试与取消、pending 观察及 interrupt 屏障验证。

[桌面自动更新诊断](audits/2026-10-02/desktop-updater-diagnostics.md)记录线上 1.7.4 与本地 1.8 成果的区别、发行缺项、完整包下载分析，以及进度/超时/取消/防重入修复和未验设备边界。

[页面加载衔接核查](audits/2026-10-02/page-loading-handoff.md)记录首屏占位交接与迟到路由失败修复、缓存/减少动态/图片解码核查，以及开发浏览器与生产/原生未验边界。

[第四轮图库、聊天与绘制工具整合](audits/2026-10-02/round4-integration.md)记录五组交付、统一包体预算、聊天静态依赖实测、图库请求减少与双主题刷新恢复验收，区分生产包浏览器证据和原生设备待验项。

[任务结果提交校验交接](audits/2026-10-02/task-result-validation.md)记录后台 hash、SQLite 回队复核、GC/close 保护、合成查询与吞吐证据及未验证范围。

[迁移激活身份修复与原生三窗口验收](audits/2026-10-02/workspace-migration-authority.md)记录目录取消、持久激活意图、只读恢复、实际三窗身份同步及双主题/DPI 验收，区分隔离候选和个人资料迁移。

本次 [1.8.0 发行准备与更新说明](releases/v1.8.0.md)汇总配方选择沿用、角色／智能画册、生成条件检索、PixAI、MiaoMiao 1.6 和桌面交互更新，并登记签名本机安装与已公开的完整素材下载：471 项基础资源、2,042 条样张、约 1.28 GiB ZIP 及两种校验值。程序公开发行条件单独核对，当前程序公开版本仍为 1.7.4。

第三批[视频台、任务中心与设置精修](audits/2026-10-01/atelier-production-polish.md)记录窄桌面布局、任务列表滚动、外观弹窗连续操作与确认框焦点修复，附双主题前后对比、定向验证和原生设备未验边界。

「我的作品」的[角色自动画册与标签智能画册](audits/2026-10-01/gallery-smart-albums.md)记录元数据归组、持续规则匹配、手动／智能画册边界及双主题桌面 CSS 视口验证。

本次[场景样张索引恢复](audits/2026-10-01/scene-showcase-index-recovery.md)补回 401 条已存在图片的遗漏记录，修复分批发布删除其他角色样张的问题；区分清单内文件可用与当前场景完整覆盖，附桌面网关及双主题浏览器证据。

第二批[首页、发现列表与导航精修](audits/2026-10-01/atelier-discovery-polish.md)记录创作入口、画册刷新保留、卡片键盘、菜单取消与减少动态反馈，附双主题桌面验收及范围外基线失败。

第一批七项可靠性修复见 [审计修复与验证](audits/2026-10-01/first-batch-audit-fixes.md)：WebUI 手动恢复、发布拦截、换装与高清配方归属、SDK 输入、Rust 门禁和 Python 版本检查；源码、候选与安装边界分别记录。

本轮[绘制台、角色档案与作品查看器精修](audits/2026-10-01/atelier-ui-refinement.md)记录共享图片、菜单与通知反馈，双主题 CSS 视口、行为回归、前后截图及原生设备未验边界。

云端修复与最新本机主线的整合见 [双父合并与 Windows 定向验收](audits/2026-10-01/cloud-local-integration.md)：保留 durable batch 与独立 FIFO 语义、反推跨角色、双主题真实浏览器证据及安装/模型未验边界。

本轮[创作流程、画布与大库响应优化](audits/2026-10-01/creator-workflow-optimization.md)完成保存／最近作品读取、图库整理、候选对比、导航、配方核对、批次恢复与 GC 排队收口；画布按用户反馈恢复原默认比例，新增检查移到次级入口。源码和候选已更新，安装与原生验收仍分开记录。

云端本轮有限优化见 [图库空筛选与资源 mount 读取](audits/2026-09-30/cloud-gallery-resource-optimization.md)：迟到观察回调回归、未命中控制读取与锁外代次核验；验证与设备边界分开记录。

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
| [第一批功能流程优化](audits/2026-10-01/functional-workflow-first-batch.md) | 配方选择沿用、任务结果事实、图库组合检索及独立分支集成边界 |
| [统一工作流](workflow.md) | 现成命令与验收范围 |
| [维护手册](maintenance.md) | 目录职责与数据维护 |
| [工程契约](engineering-contracts.md) | 模块、数据与生命周期边界 |
| [桌面部署](desktop-deployment.md) | 构建、同步、完整安装与 UAC |

协作规则见 [AGENTS.md](../AGENTS.md)。安装与换机查 [启动与排错](../STARTUP.md)、[离线资源指南](guides/offline-resources.md)与[模型开箱指南](guides/setup-and-models.md)。最新公开发行说明见 [1.8.1](releases/v1.8.1.md)，此前素材与安装记录见 [1.8.0](releases/v1.8.0.md)。

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
- [旧陪伴 CDP 探针归档说明](../scripts/archive/companion-cdp-20260930/README.md)：保留历史源码、失效原因与现行验收边界；手动窗口截图及旧热门样张恢复查[工作流](workflow.md)。

## 保留的专题验收记录

下列记录各自承接独立主题或未覆盖条件；源码、构建、安装和设备结果分别核对。旧版本安装记录由当前状态页与最新发行说明承接。

| 日期 | 主题 |
| --- | --- |
| 2026-10-01 | [Anima 加速真实对照与舍弃决定](audits/2026-10-01/anima-acceleration-comparison.md)：EasyCache、整模型／分块编译与内存控制的实际耗时、画面及隔离收口；保持现有默认 |
| 2026-10-01 | [动漫图片反推模型试跑](audits/2026-10-01/interrogate-model-trial.md)：三个 CPU 模型和 PixAI 的真实 CG 标签、耗时、显存与退出释放记录 |
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
