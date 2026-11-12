# 项目状态

维护当前源码、发行版本、已登记安装与能力边界。

## 源码与本机安装

| 层次 | 当前状态 | 说明 |
| --- | --- | --- |
| 源码版本 | [package.json](../package.json) | 工作区改动以 Git 为准 |
| 发行说明 | [版本索引](INDEX.md#发行说明) | 公开发行以 [GitHub Releases](https://github.com/starplatium1129-stack/huiyu/releases) 为准 |
| 本机安装记录 | 2026-10-24 以快速升级包更新至 `D:/AI-CG-Studio` | 当时确认 EXE/DLL 绑定及宿主网关启动 |
| 资料迁移记录 | 2026-10-24 激活 SQLite 工作区（格式 v6） | 原 IndexedDB 留存备用，来源隔离不覆盖 |
| 桌面实现 | Tauri 2 宿主、Rust 网关、原生 Live2D 线程渲染 | 参见 [桌面接入](architecture/DESKTOP-INTEGRATION-DESIGN.md) 与 [原生运行时](guides/desktop/live2d-native-runtime.md) |

## 现行能力与边界

| 范围 | 已实现能力 | 边界与说明 |
| --- | --- | --- |
| **持久化与任务** | Web 保留 IndexedDB；桌面版由 Rust/SQLite 权威管理；任务生命周期独立于前端页面 | 历史旧库与跨机器迁移按 [Workspace 契约](architecture/WORKSPACE-MIGRATION-DESIGN.md) 执行 |
| **创作引擎** | Anima、Krea 2、Qwen 与 MOSS 生图，另有换装、蓝图与视频分镜。保留旧 SD 任务与作品查询 | [模型指南](guides/setup-and-models.md)与[原生绘图连接](guides/independent-inference.md#在另一台绘遇上使用原生绘图) |
| **受管绘图与反推** | 控制室一键准备独立运行库与 PixAI 反推环境，逐项下载校验并支持断点续传 | 首次运行需检查硬件显存是否满足要求 |
| **AMD 核显支持** | 实验性支持 Windows AMD Portable v0.39.0（分块注意力与低显存模式） | 已验证 Radeon 880M 基本可用性，画质与性能需实测 |
| **独立 Anima 推理** | 内置 TeaCache 加速，复用现成资源，任务完成后自动释放空闲显存 | 支持 resident / offload 显存策略 |
| **内容维护** | 记录 API、修订历史、批量 Patch 与定向快照导出；样张/立绘原子切换 | 工作库与项目快照保持独立，详见 [维护手册](maintenance.md) |
| **界面与陪伴** | Vue 3 + Pinia，全功能双主题，独立聊天窗，支持浏览器/原生双后端 Live2D | 桌面端隐藏桌宠时自动释放 GPU 资源与上下文 |
| **桌面交付** | 源码/产物 SHA-256 绑定，支持 full 完整包与快速增量升级包 | 部署统一通过 `deploy-desktop.bat` |

## 数据源分布

| 数据 | 工作权威 / 项目来源 | 说明 |
| --- | --- | --- |
| 人物、服装、场景、蓝图 | 开发工作库：`runtime/content/catalog.sqlite`；桌面端：用户个人目录下的 `catalog.sqlite` | 运行时权威，通过 `content:catalog` 读写 |
| 项目快照 | `data/catalog/` | Git 跟踪，构建时注入，发行不覆盖个人工作库 |
| 参考资料 | `data/references/<人物ID>.json` 与 manifest | 懒加载读取，图片文件不入 Git |

## 关联入口

- [工作流](workflow.md)：日常命令与门禁构建。
- [未来规划](roadmap.md)：待办与后续演进。
- [文档索引](INDEX.md)：完整文档目录。
