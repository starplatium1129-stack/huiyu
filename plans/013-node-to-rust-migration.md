# 013：Node.js 运行时迁移到 Rust

更新于 2026-09-28。状态：**后端切换、main 合并与本机安装/启动核验已完成，发行材料及真实模型/设备验收仍待收口**。最初的工期估算不再作为当前排期。执行、失败和证据边界见[迁移执行记录](../docs/architecture/NODE-RUST-MIGRATION-REPORT.md)；安装身份见[项目状态](../docs/project-status.md)。

## 范围与当前架构

只迁 Node 后端，保留 Vue/TypeScript 前端、Tauri 壳、Native Live2D 与外部模型服务。产品后端为独立 `huiyu-runtime` Rust 进程；SQLite 使用专用存储线程，HTTP、WS、NDJSON、任务与媒体协议延续原边界。Node 保留于前端构建、开发维护和旧实现对照，产品服务不以 Node 子进程处理遗漏功能。

实现位于 [runtime-rs](../runtime-rs/)，使用锁定的 Tokio/Axum、reqwest、rusqlite、serde、原生图像与 ONNX 包装。Tauri 启停、暂存和 npm 服务入口已改接 Rust。旧 `server.ts`、routes/services/worker 源码尚未删除，不能把“未随产品启动”写成“旧代码已清理”。

## 批次状态

| 批次 | 实际完成范围 | 尚需收口 |
| --- | --- | --- |
| M0 范围 | `aba7e24b` 的 227 模块闭包、164 HTTP 登记、55 workspace command、4 维护任务；动态 worker/维护边入册 | 清单 pending 保留范围基线语义；当前源码/构建身份见执行记录，整机成本对照仍待测 |
| M1 纵向接线 | health、桌面认证、工作区与真实 Vue 图库接线、双主题证据；新安装认证与 workspace owner 核验通过 | 完整浏览器/多窗设备矩阵 |
| M2 存储 | 单写者、schema、回执、媒体/profile/迁移、备份/恢复/GC | 真实用户库升级/回退、断电、磁盘/规模条件 |
| M3 网关与安全 | Host/Origin/token/会话、静态/预压、远程投影、参考、代理与 WS | 隧道、授权素材和完整远程页面验收 |
| M4 任务与创作 | accepted/取消/unknown 恢复、五种 provider、输入快照/收件箱、视频批次 | 真实模型、GPU、长任务及最终视频效果 |
| M5 聊天与语音 | 个人/托管 API、Ollama、工具协议、翻译/TTS、队列和取消 | 真实语音、长流、设备与服务生命周期 |
| M6 媒体与维护 | 图片/WD14、Live2D、内容事务/校验/上传、资源 full/delta/续传/恢复、五域聚合、恢复 CLI、控制面；两份原生 DLL 安装哈希一致 | 真实权重与视觉/设备；未实际安装额外资源包或出图 |
| M7 产品交付 | Rust EXE/DLL、Tauri release、NSIS 与输入绑定通过；main 合并及本机完整安装/UAC、认证启动通过 | 继承的 title 门禁、许可/SBOM、真实模型/完整设备验收、旧实现退出；`releaseReady=false` |

“实现”不等于每个分支均验收。已保存日志、失败及定向补测见执行记录，不从路由数量推算覆盖率。Node 单元/契约保留旧行为对照；默认 Playwright 已启动 Rust，Node 仅提供假上游，五条主流程实际重跑通过。Rust 专项另用隔离 `parity.mjs` / `browser.mjs` 验证工作区与双主题。Linux CI 的格式、Clippy、65 项单元/16 项集成、release 与协议对照已通过。

## 保持的约束

- workspaceId、principal、epoch、revision、schema、媒体哈希和旧回执序列化不因换语言改变；失联不回退写旧库。
- 已接受任务属于 runtime；页面卸载只解除订阅，显式取消才写取消意图，未知提交不自动重发。
- 本机/远程分级与审核发布保持 fail-closed；参考权威源仍为 `data/references/`，pending 不计交付；pin 保护字段不改字节。
- 内容和资源写入沿已验证的 lease/journal、审批、完整性及精确备份范围；恢复必须绑定可审核签名计划。
- 队列、连接池、缓存与长任务有界，断连/取消/退出回收自有资源；不把模型推理或 WebView 成本冒算为 Rust 收益。

具体约束沿用[工程契约](../docs/engineering-contracts.md)、[Workspace 契约](../docs/architecture/WORKSPACE-MIGRATION-DESIGN.md)及[任务契约](../docs/architecture/TASK-RUNTIME-DESIGN.md)。

## 剩余交付顺序

1. 保留当前源码、Rust/前端/对照及 release/NSIS 的绑定证据；原有 title 36/35 门禁尚未消除，全站浏览器矩阵与整机成本对照另验。
2. 完成原生依赖 SBOM/notices、工具链与对应源码等发行材料；`releaseReady=false` 期间不记为可公开发行。
3. 已通过 `deploy-desktop.bat` 完整安装并核验 UAC、启动身份、workspace owner 与原生库；三窗、实际资料回退和长期退出/恢复场景仍按设备矩阵补验。
4. 按目标设备验证真实生成、视频、聊天/语音、WD14 与资源；再进行同负载成本测量。
5. 稳定升级/回退证据齐备后，单独清理不再需要的旧后端实现和旧暂存规则；保留开发工具与受支持 importer。

命令与恢复入口见[工作流](../docs/workflow.md#rust-运行时迁移)，安装边界见[部署指南](../docs/desktop-deployment.md)。隔离实现阶段未修改真实资料；后续经用户明确授权安装新版并重开既有 workspace，没有主动调用真实模型或公开发布。

## 旧 Node 实现的分批退出（2026-09-28）

第一批先解除编译契约对旧实现的运行时依赖：图片与视频各 23 个既有输入/工作流案例、AI 整理的 7 个案例与 2 个分镜样例改为 `runtime-rs/tests/fixtures/*-contract.json` 固定夹具，保留校验结果、错误码、清洗结果与完整图结构断言，删除三个动态 oracle。夹具由标注的 `sourceCommit` 旧 TypeScript 实现提取，不从 Rust 被测实现回写；契约有意变更时逐项审查差异，不能自动刷新以消除失败。`video/ai/sources.json` 仅保留常量提取的历史来源，不再要求旧源码永久存在且哈希不变。删除 `routes/video-ai-config.ts` 纯转发层，现有使用者直接调用 `server/chat-host-config.ts`。

后续删除以实际消费者消失为出口，而非按目录一刀切：

| 范围 | 当前保留原因 | 退出条件 |
| --- | --- | --- |
| `server.ts`、旧图片/视频/聊天等路由与服务 | `gateway-test-stack.ts` 仍启动旧网关；例如 `test-video-ai.ts` 检查 API/Ollama HTTP、鉴权与失败响应，纯编译夹具无法替代 | 把已有高价值 HTTP 场景切到 Rust 隔离栈；删除重复或只验证旧内部实现的测试，再按引用删除路由、服务与构建输入，不新增一套重复测试 |
| `server/workspace` | `runtime-rs/tests/parity.mjs` 仍验证旧回执、读取与 Node 重开 Rust 写入的库 | 固定支持的旧库/回执样本，并用独立 SQLite/协议断言承担 importer 兼容检查后退出旧 host/engine；保留受支持 importer |
| `server/tasks/runtime` | `task_recovery.rs` 仍通过它计算带真实临时目录身份的旧任务 fingerprint | 使用已固定的序列化指纹案例验证算法，再独立构造旧任务身份；不能把重启恢复改成自写自验的新任务 |
| 维护域 oracle | colors、semantics、blueprints 依赖仍在使用的 Node 维护工具；content_products 则调用旧维护路由 | 工具仍被工作流使用时保留跨实现差异验证；路由退出前将内容事务/产物语义用固定输入和独立文件断言承接 |
| Node/TypeScript 工具链 | 前端、构建、内容维护、假上游和浏览器测试仍使用 | 不属于旧产品后端删除范围；没有删除 Node 的计划 |

本批不改变产品提示词、图结构、模型调用或真实数据；固定编译契约验证不构成真实出图和设备验收。

## 迁移后的架构收口（2026-09-28）

- `task_contract` 提供 TaskRecord、生命周期枚举、TaskPatch 与任务存储命令。任务 runtime、SQLite 记录读写和状态转移使用强类型，JSON 留在 HTTP/provider、媒体上传及落盘边界；现有字段名、指纹、CAS、取消意图、提交防重、终态保护与媒体归属保持。非空字段的非法类型/null 拒绝，可空更新保留缺省/清空/赋值三态。旧 Node 记录没有 fingerprint locale 时继续读取原格式，不推断缺失的必需事实。
- `execution` 承载跨引擎的 Output、Observation 和 ExecutionHooks；视频结果下载归入 generation 的 Comfy 输出实现，移除 generation→video 反向依赖。保留取消、超时与临时文件清理，没有引入插件框架或新增依赖。
- 前端任务快照、待确认请求身份和合并/清理逻辑移到 `src/stores/runtimeTaskState.ts`；消费者直接读取该状态模块，API 保留传输、轮询和命令编排，删除旧状态文件及状态转导出。
- 原依赖门禁补 Rust 核心模块显式路径检查，识别分组导入、内联模块的 super 路径、字符串与嵌套注释；不宣称宏展开或完整符号分析。只新增一个护栏夹具用例；任务字段拒绝/null 行为加入原有存储生命周期用例，其余复用既有测试和固定契约案例。

本次验证：Rust all-targets 106 通过、8 项原有忽略；Clippy（warnings 为错误）、格式、前端相关 17 项、依赖边界、页面架构和 500 行预算通过。`gate:full --all` 的旧后端契约 39 文件通过、生产构建与预算通过；全量前端 1723 通过/1 失败，Node unit 1170 通过/2 失败/4 跳过。完整 gate 未通过：本机未配置参考素材根，另有未涉及文件的换行、RouteAtmosphere 装饰数量、资源面板源码断言、Showcase Grid 断言失败；未改索引或放宽这些断言。原始日志仅留被忽略的 `runtime/architecture-refactor-*`。本批未安装桌面、未调用真实模型或改写用户 workspace。

浏览器定向复验 5/5 通过：结果架深浅主题、SD 出图入册、串行队列自动入册及 Anima 经真实 Rust 网关/模拟 ComfyUI 生成。使用当前源码的 debug Rust EXE 与本次生产 SPA、临时隔离数据和假上游；桌面 CSS 视口沿用现有 1440×960/1440×1200 用例，不记为原生窗口、4K/DPI 或真实模型验收。最终命令内存布局调整后，任务存储 2 项与执行/恢复 2 项定向重跑通过。

## CI 修复与既有 E2E 收口（2026-09-28）

修复 GitHub Quality 在 `9f3f54f5` 的两条失败链：主题自定义属性载体改为按词法作用域追踪返回值，修复相对导入识别；替换未定义字号 token。既有 RouteAtmosphere、资源面板、画册和页面标题断言跟随已上线实现，保留可达性、操作接线、原图比例与命名一致性保障。原生 title 门禁通过 Vue 模板 AST 区分组件 props 和真实 HTML 属性，最后一处桌宠菜单提示改为 StudioTooltip，真实原生预算为 0。未新增测试数量或调低质量门槛。

Critical 的五项真实失败同时修复：Rust 生图和 TTS 保留有界错误诊断，使 OOM 恢复操作及语音失败原因可见；TTS 错误体仍受 16 KiB、截止时间和取消约束。尾斜杠文档与普通路径使用相同的麦克风/CSP 策略，API 路由与权限未放宽。已有 E2E 导航 helper 等待 Vue Router 初次就绪，防止测试在初始路由尚未完成时发起第二次导航；桌宠菜单原有双主题用例补键盘提示与边界核验，不增加用例数。

本机验证：按 GitHub 的结构素材模式执行 `npm run check`，21/21 步通过；前端含覆盖率 1724/1724、Node unit 1172 通过（保留4项素材条件跳过）；Rust 生成2项、语音1项、受限上游诊断1项通过，Clippy 与格式检查通过，生产 SPA 和 debug Rust 构建通过。Critical 原95项中90项首次通过，5项修复后定向通过；桌宠菜单双主题480×720 CSS窗口键盘提示通过并查看截图。日志和截图仅在忽略的 `runtime/ci-repair-*`。`desktop-maintenance-runtime.spec.ts` 原工作区提示经哈希确认与HEAD内容一致，刷新索引后无差异；本批实际 E2E 修改为 office-code 和 companion-focus。GitHub 结果以最终提交上的 Actions 为准，Windows Native Live2D 仍需要带 live2d-cubism 标签的自托管 runner（用户表示可能在主力机上）。
