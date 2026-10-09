# 项目状态

整理日期：2026-10-09。此页维护当前身份、能力与限制；旧过程已归入 Git 历史，不在工作目录保留日期副本。今天的性能交付见[执行报告](audits/2026-10-09/fullstack-performance.html)。

## 源码与本机安装

| 层次 | 最近已登记状态 | 依据与边界 |
| --- | --- | --- |
| 当前源码 | `package.json` 版本 1.9.2，包含发行后的修复；当前工作区改动以 Git 为准 | [工程契约](engineering-contracts.md)、[工作流](workflow.md)；源码变更不等于已安装或发布 |
| 公开发行 | 2026-10-07 记录 1.9.2 已发布并设为 latest，发行源码 `f221bd4c`，含 full/upgrade 两种包 | [1.9.2 说明](releases/v1.9.2.md)；发行记录保留在 Git 历史；本次整理未重新查询远端状态 |
| 最近本机安装记录 | 2026-10-09 23:06（Asia/Shanghai）将源码 `8e9fd0f4` 的 1.9.2 本机无压缩构建完整安装至 `D:/AI-CG-Studio`；宿主、Rust EXE、libvips DLL 字节核对及认证启动 ready 通过，内容快照变更为 0 | 经 `deploy-desktop.bat -UseInstaller -QuietInstall` 安装；本机回执 `runtime/install-latest-20261009/installation.json`、构建日志和 `runtime/desktop-deploy-last.log`，原始记录不入 Git。未公开发布；真实模型与原生画面/设备验收未运行 |
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

## 今日交付与已知限制

以下性能项沿用 2026-10-09 已有交付记录；提示词门禁项来自本次定向检查。定向检查不代表全仓、设备或视觉验收：

- 性能改进覆盖按需加载、内容读取、作品修订缓存、图库分批挂载及首轮尺寸读取；六条场景分级统一 All，分级差异为零。
- 提示词检查已按 studio-prompt-craft 退出最低字符数、词数和句号数配额，保留非空、绑定、分级、冲突与编译消费约束；302 条场景校验及 Rust 语义定向回归通过。sc009 / sc027 正文未改，不再把 99 / 94 字符列为质量缺陷。
- 相关内容回归仍有四项现有断言失败：默认服装 SFW 覆盖、全部服装场景覆盖、角色场景类别覆盖及圆扇形状进入双引擎编译。已核对服装缺项和圆扇正文与项目快照一致，未为过检改写内容；按[未来规划](roadmap.md)继续核对。
- 完整 Rust 检查在未改动的 desktop_tools/files.rs、desktop_tools/tests.rs 格式检查上失败，后续 Clippy／全套测试未运行；本次两个语义文件的格式与一项定向 Rust 行为回归通过。
- 图库冷进入仍出现 56–72 ms 长任务样本；真实模型、原生安装/WebView2、物理 DPI 和长期 RSS/GPU 未验收。
- Windows 符号链接拒绝用例因权限错误 1314 保留未验证；参考图验证已被该任务明确免除，不能记为通过。
- 旧报告中的 ChatView 包体、来源指纹和 Python 夹具问题已在今日收口，不再列为当前未解决项。全部验证边界见[今日报告](audits/2026-10-09/fullstack-performance.html#completion-audit)。

## 当前数据

| 数据 | 工作权威 / 项目来源 |
| --- | --- |
| 人物、服装、场景、蓝图、记录式文档 | 实际运行目录 `content/catalog.sqlite`；通过 `content:catalog` 或内容维护页面读写 |
| 项目初始化/发行快照 | 显式导出的 `data/catalog/`；构建读取快照，安装不覆盖个人工作库 |
| 参考资料 | `data/references/<人物ID>.json` 与 manifest；本机 API 懒加载，旧聚合仅兼容 |

当前数量需针对明确的运行目录通过 `content:catalog stats/query` 读取。本次未打开工作库或盘点图片，不用 2026-09-27 的历史分片数量代表当前记录库或图片实物；旧登记快照可从 Git 历史读取。

## 验证与后续入口

- [工作流分层规则](workflow.md#门禁与构建)：按实际影响选验证，复用同一源码/配置/产物/环境的有效证据。
- [未来规划](roadmap.md)：待开发、待验收、暂停和待决策事项。
- [计划索引](../plans/README.md)：专项执行与剩余范围。
- [文档索引](INDEX.md)：现行规范、今日报告与研究来源。
