# 项目状态

此页维护源码、发行、已登记安装和能力边界。2026-10-28 根据仓库更新版本信息；未重新查询远端或验收本机安装。

## 源码与本机安装

| 层次 | 最近已登记状态 | 依据与边界 |
| --- | --- | --- |
| 当前源码 | `package.json` 版本 2.0.0；当前工作区改动以 Git 为准 | 源码变更不等于已安装或发布 |
| 已登记发行 | [2.0.0 发行说明](releases/v2.0.0.md)记录完整安装包及尚未附带的资源；旧版见 [1.9.2 说明](releases/v1.9.2.md) | 仓库中的发行记录不代替远端状态查询 |
| 已登记本机安装 | 2026-10-24 00:16（Asia/Shanghai）以无压缩升级包更新 1.9.2 至 `D:/AI-CG-Studio`；基于 `12f25368` 及当时工作区改动，构建源码摘要 `fb7d3ce0…` | 部署入口退出 0，EXE/DLL/安装包绑定及宿主、所属 Rust 网关认证启动通过；安装包 SHA-256 `6522129a…`，325,803,520 字节。这是历史记录，不能推断当前安装版本 |
| 资料迁移记录 | 2026-10-24 核对当时本机 `3000` / `profile-b65070ee…` 来源后，激活 SQLite 工作区 `eb17d902-b84b-46b1-82e5-d6567f754234`；格式 v6，1 条作品、5 个媒体别名对应 4 份去重原件，38 条迁移记录 | 独立目录备份读回、全部迁移记录/原图校验、本机快照与独立恢复副本完成；重启后同一工作区和数量保留。原 IndexedDB 与旧 `3002` / `profile-e3128c00…` SQLite 留存，来源身份不同，不合并或覆盖；大库、实际回退和物理故障仍按 [Workspace 契约](architecture/WORKSPACE-MIGRATION-DESIGN.md)验收 |
| 桌面实现 | Tauri 宿主、Rust 网关、原生 Live2D 线程渲染；独立渲染进程仍为显式实验 | [桌面接入](architecture/DESKTOP-INTEGRATION-DESIGN.md)、[原生运行时](guides/desktop/live2d-native-runtime.md) |

后续安装或发布分别更新相应行，附源码/产物身份和当次证据。既有材料 pending、模型与设备待验范围继续保留，见[未来规划](roadmap.md)。

## 现行能力与边界

| 范围 | 已实现行为 | 剩余边界 |
| --- | --- | --- |
| 持久化与任务 | Web 保留 IndexedDB；桌面激活后由 Rust/SQLite 持有权威；已接受任务独立于页面生命周期，失联不降级双写 | 历史来源、其他机器、大规模数据及真实故障场景按 [Workspace](architecture/WORKSPACE-MIGRATION-DESIGN.md) 与[任务契约](architecture/TASK-RUNTIME-DESIGN.md)分别验收 |
| 创作 | Anima/Krea 2 新生成、换装、蓝图、入册与视频分镜；聊天绘画工具已接入任务提交和入册；SD 新生成已退出，旧任务查询/取消/收集及历史作品保留 | 聊天绘画、真实模型、视频效果与成本按[规划](roadmap.md)分别验收 |
| 首次配置与受管绘图 | 控制室一键准备独立运行库与完整模型，逐项下载/校验，保留续传和取消；已有完整模型可采用，离线导入保留；显式保存原生引擎，工作区变更后重启，不静默回退 ComfyUI | 源码、构建与目录核验不代表干净 Windows 安装或真实出图已验收；断网、空间/权限、系统组件、重启发现及设备效果按[独立推理指南](guides/independent-inference.md)验收 |
| AMD 核显 ComfyUI | Windows 受管官方 AMD Portable v0.39.0，使用分块注意力和低显存模式；本机 Radeon 880M / Torch 2.9.1+ROCm 7.2.1 可用。2026-10-25 已确认安装版网关接收 MiaoMiao 1.6＋宁宁 LoRA 请求并正常采样；任务 `e0bda69a323545a9bbacd60006914989` 最终 succeeded，结果可取；随后受管停止完成 | 连通性已确认，原始回执在 `runtime/diagnostics/notebook-generation-final-20261025.json`；网关 EXE SHA-256 `7cd06caa603e2a65098f7564ad485bc126d4b70b96d926e77ef83598d8b29095`。不要求等待出图确认基本可用；这不构成画质或性能验收。其他驱动/AMD 设备及仅支持 NVIDIA 的原生推理分别核对 |
| 独立 Anima 推理 | 内置 Anima TeaCache 无需逐组合校准；复用现成资源，合作取消保留模型，完成后释放闲置显存；支持 resident/offload | 10 月 13 日本机候选曾验证 MiaoMiao 1.6＋宁宁 LoRA 的普通图、Latent/Remacri 高清、取消恢复与显存；该历史证据不代替当前受管版本、其他模型、自动换装语义与更广硬件验收 |
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

当前数量需针对明确的运行目录通过 `content:catalog stats/query` 读取；历史分片数量不能代表当前记录库或图片实物。

## 验证与后续入口

- [工作流分层规则](workflow.md#门禁与构建)：按实际影响选验证，复用同一源码/配置/产物/环境的有效证据。
- [未来规划](roadmap.md)：待开发、待验收、暂停和待决策事项。
- [计划索引](../plans/README.md)：专项执行与剩余范围。
- [文档索引](INDEX.md)：现行规范与研究来源。
