# 013：Node.js 运行时迁移到 Rust

更新于 2026-09-28。状态：**后端实现与产品入口切换已落地，最终构建、发行材料及安装/真实模型验收仍在收口**。最初的工期估算不再作为当前排期。执行、失败和证据边界见[迁移执行记录](../docs/architecture/NODE-RUST-MIGRATION-REPORT.md)；正式安装身份仍见[项目状态](../docs/project-status.md)。

## 范围与当前架构

只迁 Node 后端，保留 Vue/TypeScript 前端、Tauri 壳、Native Live2D 与外部模型服务。产品后端为独立 `huiyu-runtime` Rust 进程；SQLite 使用专用存储线程，HTTP、WS、NDJSON、任务与媒体协议延续原边界。Node 保留于前端构建、开发维护和旧实现对照，产品服务不以 Node 子进程处理遗漏功能。

实现位于 [runtime-rs](../runtime-rs/)，使用锁定的 Tokio/Axum、reqwest、rusqlite、serde、原生图像与 ONNX 包装。Tauri 启停、暂存和 npm 服务入口已改接 Rust。旧 `server.ts`、routes/services/worker 源码尚未删除，不能把“未随产品启动”写成“旧代码已清理”。

## 批次状态

| 批次 | 实际完成范围 | 尚需收口 |
| --- | --- | --- |
| M0 范围 | `aba7e24b` 的 227 模块闭包、164 HTTP 登记、55 workspace command、4 维护任务；动态 worker/维护边入册 | 清单 pending 保留范围基线语义；最终源码/构建身份及成本实测待补 |
| M1 纵向接线 | health、桌面认证、工作区与真实 Vue 图库接线，隔离协议夹具 | 最终浏览器操作证据与新安装确认 |
| M2 存储 | 单写者、schema、回执、媒体/profile/迁移、备份/恢复/GC | 真实用户库升级/回退、断电、磁盘/规模条件 |
| M3 网关与安全 | Host/Origin/token/会话、静态/预压、远程投影、参考、代理与 WS | 隧道、授权素材和完整远程页面验收 |
| M4 任务与创作 | accepted/取消/unknown 恢复、五种 provider、输入快照/收件箱、视频批次 | 真实模型、GPU、长任务及最终视频效果 |
| M5 聊天与语音 | 个人/托管 API、Ollama、工具协议、翻译/TTS、队列和取消 | 真实语音、长流、设备与服务生命周期 |
| M6 媒体与维护 | 图片/WD14、Live2D、内容事务/校验/上传、资源 full/delta/续传/恢复、五域聚合、恢复 CLI、控制面 | 原生 DLL 最终安装、真实权重与视觉/设备；未实际安装资源或出图 |
| M7 产品交付 | Rust EXE/DLL 载荷、Tauri 启动、构建身份与隔离 bundle 入口 | 最终构建/全门禁、许可/SBOM、安装/UAC、真实模型、旧实现退出；`releaseReady=false` |

“实现”不等于每个分支均验收。已保存日志、失败及定向补测见执行记录，最终指标由稳定源码的实际运行结果补入，不从路由数量推算覆盖率。既有 Node 单元、契约及仍启动旧网关的 E2E 只作旧行为对照；Rust 浏览器验收另用隔离 `parity.mjs` / `browser.mjs`，默认测试栈切换后也需真实重跑。

## 保持的约束

- workspaceId、principal、epoch、revision、schema、媒体哈希和旧回执序列化不因换语言改变；失联不回退写旧库。
- 已接受任务属于 runtime；页面卸载只解除订阅，显式取消才写取消意图，未知提交不自动重发。
- 本机/远程分级与审核发布保持 fail-closed；参考权威源仍为 `data/references/`，pending 不计交付；pin 保护字段不改字节。
- 内容和资源写入沿已验证的 lease/journal、审批、完整性及精确备份范围；恢复必须绑定可审核签名计划。
- 队列、连接池、缓存与长任务有界，断连/取消/退出回收自有资源；不把模型推理或 WebView 成本冒算为 Rust 收益。

具体约束沿用[工程契约](../docs/engineering-contracts.md)、[Workspace 契约](../docs/architecture/WORKSPACE-MIGRATION-DESIGN.md)及[任务契约](../docs/architecture/TASK-RUNTIME-DESIGN.md)。

## 剩余交付顺序

1. 固定当前源码，补齐 Rust、前端、旧实现对照、完整门禁和 release/bundle 的当次证据；保留原失败记录。
2. 完成原生依赖 SBOM/notices、工具链与对应源码等发行材料；`releaseReady=false` 期间不记为可公开发行。
3. 授权后通过 `deploy-desktop.bat` 完整安装 Rust 后端，核验 UAC、启动身份、私库、三窗、原生库、恢复与退出。
4. 按目标设备验证真实生成、视频、聊天/语音、WD14 与资源；再进行同负载成本测量。
5. 稳定升级/回退证据齐备后，单独清理不再需要的旧后端实现和旧暂存规则；保留开发工具与受支持 importer。

命令与恢复入口见[工作流](../docs/workflow.md#rust-运行时迁移)，安装边界见[部署指南](../docs/desktop-deployment.md)。本轮隔离夹具没有修改真实工作区、素材或提示词，没有自动安装或发布。
