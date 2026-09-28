# 项目状态

> 核对日期：2026-09-28；仓库版本 1.7.2。本轮更新 Rust 迁移状态，数据规模仍为 9 月 27 日登记快照。待办查 [未来规划](roadmap.md)，旧批次过程查 [分批记录快照](archive/completed/project-status-2026-09-27.md)。

## 源码与本机安装

| 层次 | 当前状态 | 依据 |
| --- | --- | --- |
| 当前 main | PR #11 的 Node → Rust 迁移已合并；前端/桌面壳保留，旧 Node 对照源码尚未删除 | [迁移执行记录](architecture/NODE-RUST-MIGRATION-REPORT.md)；合并提交 `f05f8724` |
| 最近本机安装 | `main@42041f46` 的 Rust 版 1.7.2 已完整安装并启动；宿主、Rust 子进程、原生 DLL、认证健康状态及现有 workspace owner 已核对 | [本次安装证据](evidence/rust-installation-2026-09-28.json)；此前内存/设备测量仍见 [9 月 27 日记录](evidence/memory-optimization-2026-09-27.json)，不自动沿用于新后端 |
| 资料迁移 | 当前旧来源 3002 已正式迁入 SQLite workspace，启用本地打包 UI；旧来源及独立备份保留 | [R3–R11 主线记录](architecture/R3-R11-EXECUTION-REPORT.md) |
| 实验默认 | 正式桌面仍用 Tauri 与线程渲染；R12 独立进程、R13 Electron 只保留实验入口 | [R12](architecture/R12-EXECUTION-REPORT.md)、[R13](architecture/R13-EXECUTION-REPORT.md) |

源码、构建、安装和设备验收分别核对。本次经用户授权使用 `deploy-desktop.bat` 完整安装到 `D:/AI-CG-Studio`；UAC 已由用户确认，未主动调用真实模型。首次校验发现 Tauri 的三字节 NSIS 标记差异，修复精确校验后重建并安装成功；后续代码变化不自动获得本次通过结论。

本次 Rust 迁移已有隔离存储、模拟上游、维护/资源事务与 Node 差分证据。Windows/Linux release、Linux Rust 检查、7 项工作区一致性、图库/控制台双主题及默认 Rust 测试栈的五条主流程通过；本机安装与启动核验已完成。旧 Node 单元/契约仅证明旧实现；总门禁仍有继承的 title 36/35 失败，不能标为全绿。真实模型、完整设备/资料验收及原生发行材料仍未完成，`releaseReady=false`。旧安装遗留 Node 程序文件保留，但当前宿主只启动 Rust 网关。

当前工作区已接入 Tailwind CSS 4.3.3，迁移常规组件/页面样式并保留原有深浅主题、Reka 交互及定制视觉；Firefox 最低版本经确认调整为 128。Web/desktop UI 构建及浏览器验收见 [迁移记录](audits/2026-09-27/tailwind-migration.md)，完整门禁仍有记录中的既有环境/基线失败，本轮未同步正式桌面安装。

## 现行能力与边界

| 范围 | 已实现行为 | 证据与限制 |
| --- | --- | --- |
| Web 与桌面持久化 | Web 保留 IndexedDB；当前源码由 Rust runtime 管理桌面 SQLite 元数据和媒体，保持原 schema/回执，失联不降级双写旧库 | [Workspace 契约](architecture/WORKSPACE-MIGRATION-DESIGN.md)；新 Rust 安装、历史 3000 来源凭据、其他机器和实际用户库回退仍单列 |
| 任务与结果 | runtime 持有已接受任务、幂等身份、取消与结果收件箱；页面卸载解除订阅，重连查询任务状态 | [任务契约](architecture/TASK-RUNTIME-DESIGN.md)；真实 provider、长回复/工具流与复杂故障组合仍需目标环境验收 |
| 创作 | SD、Anima、Krea 2 各有编译/请求边界，支持工作台、换装、场景蓝图、作品入册与视频分镜 | [工程契约](engineering-contracts.md)；聊天绘画工具目前只准备草稿，真实生成及视频效果按 roadmap 验收 |
| 内容维护 | 人物、服装、蓝图和参考按权威源维护；变更集/事务、候选审核、不可变发布与资源恢复已接线 | [维护手册](maintenance.md)、[候选审核工作流](workflow.md#参考库候选审核与版本发布)；pending、登记与结构检查不计为图片交付 |
| UI | 深浅主题、按需路由、角色画集、粒子肖像、结果架、相册/收藏及无障碍交互已有实现；Reka UI 已用于浮层和控件 | [012 实施记录](audits/2026-09-21/012-execution-report.md)；217 项矩阵中的 85 项外部条件为当时检查点，后续按 ID 补验 |
| 陪伴与 Live2D | 统一身份/Profile、独立聊天窗、模型检查、参数枚举、有界本机导入校准已接线；Cubism 2 候选保留浏览器回退 | [010 计划与记录](../plans/010-companion-experience-and-live2d-adapter.md)、[尾项记录](audits/2026-09-21/office-tail-completion.md)；语音、多屏/DPI/休眠与长期资源趋势继续开放 |
| 资源释放 | 桌宠隐藏/系统关闭释放模型与原生 GPU context，重开按偏好恢复；桌面取消全库缩略预热，缓存限 96 项/8 MiB；图库停用释放高清 URL | [内存优化证据](evidence/memory-optimization-2026-09-27.json)；880M 本机短样本不推广到独显、大图库或长期功耗 |
| 桌面交付 | 图片统一解析 runtime URL；维护先保存各窗并排空网关；构建回执绑定实际输入/载荷，部署拒绝未退出进程或残留 workspace 锁 | [可靠性收尾](architecture/RELIABILITY-FOLLOWUP-REPORT.md)、[部署指南](desktop-deployment.md)；UAC 由用户操作 |

011 六项边界补强、012 办公机体验实施及 9 月 20–21 日审计修复已有分批记录。本机后续安装包含其受控提交中的实现；这不替代各专项仍缺的模型、素材、其他设备与大规模数据证据。

## 当前数据

以下为 2026-09-27 从权威 JSON/分片重新读取的登记快照，非资产实物或画质审核。读取使用现有 store 的只读加载函数，未重建或改写内容；[盘点与文档整理记录](audits/2026-09-27/documentation-drift.md)保留口径。

| 项目 | 数量 | 权威源 / 口径 |
| --- | ---: | --- |
| 角色档案 | 160 | `data/characters.json` |
| 热门角色 / 服装形态 | 158 / 971 | `data/popular/` 的 characters / outfits |
| 通用场景 / 场景蓝图 | 302 / 1,692 | `data/scenes/` / `data/blueprints/` |
| 参考库角色 / 已登记形态 | 160 / 1,001 | `data/references/` 的 view 记录 |
| 参考条目 | 7,007 | 所有已登记形态的 references |
| 非 pending 且有 URL / pending | 2,534 / 4,473 | 只统计索引字段；未检查 URL、文件或图片质量 |

参考权威源为 `data/references/<人物ID>.json` 与 manifest。`data/character-reference-standards.json`、`data/character-reference-view.json` 为不入 Git 的兼容聚合产物；人物页/视频参考卡按人物请求本机 API，优先读取已安装的审核发布版本，远程访问继续拒绝。

## 验证与后续入口

当前页不滚动累加测试数量。各次通过、失败、跳过、环境与源码/构建身份留在对应执行记录；历史 PASS 不能替代当前工作区验证。局部改动按 [工作流分层规则](workflow.md#门禁与构建) 选择检查。

- [未来规划](roadmap.md)：待开发、待验收、暂停与待决策事项；同一缺口按 ID 维护。
- [计划索引](../plans/README.md)：005–013 和长期架构目标，进入前先查剩余范围。
- [分批记录快照](archive/completed/project-status-2026-09-27.md)：此前状态页的完整过程，包括当时未安装、失败及补验说明。
- [文档索引](INDEX.md)：专题规范、实施报告、证据及研究资料。
