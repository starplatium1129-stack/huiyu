# 项目状态

维护日期：2026-10-08。此页维护当前身份、能力与限制；每次更新对应行，过程与原始验证留在执行记录。[此前过程及数据登记快照](audits/2026-10-08/project-status-history.md)已归档。

## 源码与本机安装

| 层次 | 最近已登记状态 | 依据与边界 |
| --- | --- | --- |
| 当前源码 | `package.json` 版本 1.9.2，包含发行后的修复；当前工作区改动以 Git 为准 | [工程契约](engineering-contracts.md)、[工作流](workflow.md)；源码变更不等于已安装或发布 |
| 公开发行 | 2026-10-07 记录 1.9.2 已发布并设为 latest，发行源码 `f221bd4c`，含 full/upgrade 两种包 | [1.9.2 说明](releases/v1.9.2.md)与[发行记录](audits/2026-10-08/project-status-history.md)；本次整理未重新查询远端状态 |
| 最近本机安装记录 | 2026-10-01 完整安装 1.8.0 至 `C:/Program Files/AI-CG-Studio`；宿主、Rust EXE 与 DLL 当时核对匹配、启动 ready | [安装历史](audits/2026-10-08/project-status-history.md)；本次未检查安装目录，不以源码版本代替已装版本 |
| 资料迁移记录 | 2026-09-26 曾登记旧来源迁入 SQLite；10 月 1 日对应机器未发现 active pointer，仍使用旧来源 IndexedDB | [Workspace 契约](architecture/WORKSPACE-MIGRATION-DESIGN.md)；按具体机器核对，不合并两次记录为已迁移结论 |
| 桌面实现 | Tauri 宿主、Rust 网关、原生 Live2D 线程渲染；独立渲染进程仍为显式实验 | [桌面接入](architecture/DESKTOP-INTEGRATION-DESIGN.md)、[原生运行时](guides/desktop/live2d-native-runtime.md) |

后续安装或发布分别更新相应行，附源码/产物身份和当次证据。既有材料 pending、模型与设备待验范围继续保留，见[未来规划](roadmap.md)。

## 现行能力与边界

| 范围 | 已实现行为 | 剩余边界 |
| --- | --- | --- |
| 持久化与任务 | Web 保留 IndexedDB；桌面激活后由 Rust/SQLite 持有权威；已接受任务独立于页面生命周期，失联不降级双写 | 历史来源、其他机器、大规模数据及真实故障场景按 [Workspace](architecture/WORKSPACE-MIGRATION-DESIGN.md) 与[任务契约](architecture/TASK-RUNTIME-DESIGN.md)分别验收 |
| 创作 | Anima/Krea 2 新生成、换装、蓝图、入册与视频分镜；SD 新生成已退出，旧任务查询/取消/收集及历史作品保留 | 聊天绘画工具仍只准备草稿；真实模型、视频效果与成本按 [roadmap](roadmap.md) 验收 |
| 内容维护 | 记录 API、修订历史、字段补丁、批量预览/导入与项目快照导出；立绘/样张走图片事务 | 工作库与项目快照独立；pending、记录登记和结构校验不计为图片交付，见[维护手册](maintenance.md) |
| 界面与陪伴 | Vue/Pinia、双主题、Reka 控件、路由按需加载、角色身份/Profile、独立聊天窗与浏览器/原生 Live2D | WebView2、DPI/多屏/休眠、真实语音与长期资源趋势保留设备验收范围 |
| 资源生命周期 | 隐藏桌宠释放模型与原生 GPU context；桌面缩略缓存限 96 项/8 MiB；图库停用释放高清 URL | 既有短样本不推广为全部 GPU、大图库或长时间运行结论 |
| 桌面交付与离线资源 | 构建/载荷身份绑定、full/upgrade 包、Rust 离线资源导入、维护锁与窗口排空 | 版本、安装、素材和许可分别核验；部署使用[唯一入口](desktop-deployment.md)，UAC 由用户操作 |

模块约束的权威说明在[工程契约](engineering-contracts.md)，设备与素材未完成项统一在[未来规划](roadmap.md)，此处不累加历史测试数量。

## 当前数据

| 数据 | 工作权威 / 项目来源 |
| --- | --- |
| 人物、服装、场景、蓝图、记录式文档 | 实际运行目录 `content/catalog.sqlite`；通过 `content:catalog` 或内容维护页面读写 |
| 项目初始化/发行快照 | 显式导出的 `data/catalog/`；构建读取快照，安装不覆盖个人工作库 |
| 参考资料 | `data/references/<人物ID>.json` 与 manifest；本机 API 懒加载，旧聚合仅兼容 |

当前数量需针对明确的运行目录通过 `content:catalog stats/query` 读取。本次未打开工作库或盘点图片，不用 2026-09-27 的历史分片数量代表当前记录库或图片实物；原登记快照保存在[历史记录](audits/2026-10-08/project-status-history.md#当前数据)。

## 验证与后续入口

- [工作流分层规则](workflow.md#门禁与构建)：按实际影响选验证，复用同一源码/配置/产物/环境的有效证据。
- [未来规划](roadmap.md)：待开发、待验收、暂停和待决策事项。
- [计划索引](../plans/README.md)：专项执行与剩余范围。
- [历史状态](audits/2026-10-08/project-status-history.md)：保留原过程及限制，不代替当前通过证据。
- [文档索引](INDEX.md)：专题规范、实施报告和研究资料。
