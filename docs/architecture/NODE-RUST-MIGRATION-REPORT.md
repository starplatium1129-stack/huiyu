# Node → Rust 运行时迁移执行记录

更新于 2026-09-28。当前工作区已将产品后端、独立服务入口与桌面 gateway 载荷改为 `runtime-rs/` 的 `huiyu-runtime`。Vue/TypeScript 前端、Tauri 壳和 Native Live2D 保留。本地候选已构建并验证；**尚未安装或公开发布本次 Rust 版本，`releaseReady=false`**。既有 1.7.2 安装身份见[项目状态](../project-status.md)，不能用旧安装证据认证新后端。

## 范围与实现

旧实现范围基线为 `aba7e24b`：[机器清单](../../runtime-rs/migration-inventory.json)记录 227 个生产源模块、164 条 HTTP 登记、55 种 workspace command 和 4 种维护 task。164 包含别名、动态展开、代理及重复登记，不是唯一端点数。清单中的 `pending` 是保留的盘点状态；[迁移矩阵](NODE-RUST-MIGRATION-MATRIX.md)定位旧实现，本报告记录执行状态，二者均不代表完整行为覆盖率。

| 范围 | 已实现 | 验证边界 |
| --- | --- | --- |
| 身份与工作区 | challenge/HMAC、session/principal/epoch、候选激活、SQLite 单写者、回执、媒体/profile/迁移、备份与恢复 | 隔离库、旧 Node 回读/回执和跨会话拒绝；未迁移或回退真实用户库 |
| 网关与接入 | HTTP/NDJSON/WS、SD 白名单代理、静态/预压、参考发布校验、远程审核投影 | 模拟 HTTP/WS、路径/哈希/撤销及协议夹具；挂载核对不等于各分支均验收 |
| 任务与创作 | generation、Anima/creative、video/batch、输入快照、收件箱、取消、重启核对、分镜继续与拼接 | 模拟上游和临时媒体；未知提交不自动重发，真实模型/GPU/成片另验 |
| 聊天、语音与工具 | persona/个人 API/托管设置、流式工具协议、Ollama、翻译/TTS、有界队列、八种桌面工具 | 分片流、模拟服务、临时目录与取消；绘画工具仍只准备草稿，真实设备另验 |
| 媒体与 Live2D | 原生图像处理、WD14 ONNX 包装、Live2D 资源/派生/导入 | 固定 DLL 清单与隔离夹具；真实权重、多屏/DPI与安装后的 DLL 搜索待验 |
| 内容维护 | 场景/蓝图保存、评级/编译校验、内容 gate、pin、lease/journal、备份、上传样张/首页图、四个维护 task | 中性夹具与 Node 差分；失败恢复原字节，未修改真实提示词/pin/参考源，未出图 |
| 资源与启动 | 审批、full/delta、续传、安装/回退/恢复、本机挂载；五域聚合/预压与原生恢复 CLI | 临时资源库和模拟下载源；下载不自动安装，篡改后撤挂，未安装真实资源包 |
| 控制与桌面 | 服务控制、分享、诊断；Tauri 启停 Rust；EXE/DLL 暂存、构建身份与隔离 bundle 检查 | 最终 release、桌面构建、实际安装与发布结论仍须下表中的证据 |

产品载荷不再要求 `node.exe`、`server.js`、服务端 `node_modules` 或旧 TS 路由。旧 Node 源码尚未删除，保留用于差分、历史验证和开发维护工具；Node/npm/Vite 仍用于前端与构建编排。生产后端没有 Node 自动回退。

`compression`、`express`、`http-proxy-middleware`、`onnxruntime-node`、`sharp`、`ws` 已归入开发依赖，继续服务构建、原生 DLL 采集及旧行为对照；锁文件保留原有包版本、来源和完整性摘要。

本次明确调整了以下行为：

- 控制台保存服务/声线配置后要求重启；状态分别返回生效值与已保存值，界面保留待重启提示。环境变量固定的服务地址不能通过保存操作伪装为已切换。
- 启动不因历史配置自动启动受管模型或分享隧道；用户启动的自有进程才进入监视与回收。默认仅监听 `127.0.0.1:3000`，显式公开监听仍须经过远程授权和内容投影。
- Krea 的 init/mask 编辑请求明确返回 501，避免旧图忽略输入仍声称完成；H3 无 T8 的参考图、Wan 不支持的多镜头尾帧连接在受理前拒绝。
- 分镜保持本机访问，明确拒绝成人分级输入；未知提交只查询原任务，不自动再次提交。执行成功但结果持久化失败时保留可重收集状态，不重占 GPU 提交新任务。

Linux 的 `C`/`POSIX` 系统 locale 按 [Node 24.18 的 V8 实现](https://github.com/nodejs/node/blob/v24.18.0/deps/v8/src/execution/isolate.cc#L6711)映射为 `en-US`，避免任务运行时在初始化时退出；已有账本记录的 locale 仍按原值严格解析。Unix 磁盘余量计算使用宽整数饱和转换，避免 x64 专属的同型转换 Clippy 失败。首次 Linux CI 已通过格式与 Clippy，单元测试为 64 过/1 失败/1 原生专项忽略；失败暴露目录列表另有一处未规范化系统 locale。现将目录列表与任务指纹接到同一模块，保留旧账本 locale，相关本机 5 项定向回归通过；Linux 复验结果以 PR #11 最新运行记录为准。展示层与图像实现未改，双主题和原生字节对照证据复用；最终 release 的协议复验见 `parity-locale-final.json`。

验收还修复了输入保护期间重复恢复分发、成功结果保存失败后无法重收集、未确认结束任务不能取消，以及手动恢复未重新挂接监视的问题。Windows Live2D 路径检查不再提前查询不完整的 `\\?\C:` 前缀；规范化路径下导入、编辑和目录扫描已定向通过，junction/symlink 仍拒绝。

## 已有证据与失败记录

以下是文档核对时已存在的本机记录，不合并成“最终全量通过”。日志位于被忽略的 `runtime/rust-evidence/`，最终交付仍须绑定稳定源码、二进制、日志及安装包身份。

| 记录 | 已观察到的结果 | 限制 |
| --- | --- | --- |
| Rust 最终门禁 | 全 targets Clippy `-D warnings` 通过；64 项 lib、16 项 integration 通过，4 项原生用例随后显式执行通过（含 Live2D HTTP 纹理/ETag） | 普通命令仍默认忽略需本机 DLL 的专项；本轮已显式补验 |
| `rust-integration-final.log` | 9 组、16 项隔离集成测试通过 | 不覆盖全部单元分支、浏览器、真实模型或安装 |
| `rust-tests.log`、`rust-task-race.log` | 较早全量 63 过、1 失败、1 忽略；竞态修复后对应单项通过 | 定向补测不等于该次全量通过；原生纹理用例须显式中性素材/DLL |
| 移植期间集中夹具 | 维护/恢复、资源 full→delta→rollback、HTTP 取消续传、启动聚合、恢复 CLI 与 Node 对拍通过 | 只证明对应隔离行为，不是视觉审核或任意故障组合覆盖 |
| `node-test-frontend.log`、`node-test-unit-run.log`、`node-test-contract-run.log` | 当轮前端 233 文件/1605 用例、旧实现 unit 1170 用例、contract 39 文件通过 | Node 单元/契约通过不能替代 Rust 测试 |
| `full-gate.log`、`node-test-check.log`、`hygiene.json` | 保留早期失败。后续 Node check `--all` 为 19 过/1 失败，仅继承的原生 title 36/35；hygiene 通过，材料与暂存契约 26 项通过、1 项非 Windows 专属用例跳过 | 整体 Node check 仍不是全绿；原失败记录不覆盖为成功 |
| `ui/failed-dark.*`、`ui-final/failed-control-dark.*` | 保留图库读取及控制台的较早失败 | 不能删除失败历史后只展示成功截图 |
| `build.json`、`release-build-final.log` | 当前 Rust release 构建完成，25,287,680 字节；源码选择身份与 EXE 哈希已写回执 | 只绑定后端构建，桌面安装包和许可仍单列 |
| `parity-final.json`、`ui-final/rust-*.png` | 7 项 Node/Rust 工作区一致性通过；图库/控制台深浅主题通过，workspace 失败 0，截图已人工查看 | 使用隔离资料与中性设置；不覆盖全站、模型或桌面安装 |
| 原生及桌面补验 | 已暂存 DLL 对 12 种 WD14 预处理像素差异均为 0；36 个派生文件逐字节一致；332 字节 toy ONNX 在 CPU 通过；实际 Tauri 配置的 debug 构建完成，独立 bundle 首轮启动 232 ms，最终 EXE 重验 204 ms | 小模型/中性素材及一次启动样本不证明真实权重、release安装或发行材料完成 |

默认 Playwright 的 web 与 flows 入口已改为实际 Rust release EXE；Node 只提供五个可编程假上游。每栈使用临时 app/runtime/AI，拒绝复用已有网关；CI 先构建 Rust。既有断言未调整，Krea、SD 出图入册、Anima job、翻译配音、流式聊天五条主流程全部通过（`rust-critical-flows.log`，31.8 秒）。完整全站浏览器矩阵未在本轮运行。Rust 专项 `parity.mjs`/`browser.mjs` 还对实际暂存 bundle 完成工作区往返与图库/控制台双主题验收（`parity-release-final.json`、`ui-release-final/`）。

连接池、流式背压、SQLite 专用线程、有界任务队列、共享不可变资源清单与媒体身份缓存已经实现。启动聚合按域封存原产物；原文缩小后清除旧压缩伴生文件，避免返回旧内容。这些是实现措施，**尚未据此宣称整机内存、GPU 或模型速度改善**。

## 最终验收与待补指标

| 项目 | 当前记录 |
| --- | --- |
| 最终源码提交/内容身份 | Rust 源选择身份 `660ea68242f6a64da6f2278df13716f639ddb6a19a41319a04036782f6b9940c`；交付分支 `codex/node-to-rust`，提交见 Git 记录；桌面 release/安装绑定仍未生成 |
| Rust 门禁 | 当前已记录全 targets Clippy、64 lib+16 integration 通过，locale 修复后新增/原有 fingerprint 两项定向通过，原生 4 项显式通过；Live2D 规范化路径与链接拒绝定向 2 项通过。最终日志/源码绑定随交付回执核对 |
| Node 完整 check | `--all` 19 过/1 失败：原生 title 36 > 基线 35；没有放宽断言或宣称全量通过 |
| release runtime | 25,287,680 字节；SHA-256 `3350ce3cc8e902e79a86340d6026679656768af8e954a2ee78f71e8744596ff3`；见 `runtime/rust-evidence/build.json` |
| 暂存 bundle、桌面 EXE/NSIS、发行输入绑定 | stage+独立 bundle 启动通过；实际配置的 Tauri debug 构建 49.23 s 完成。最终 release桌面/NSIS与回执待补，不等于已安装 |
| Rust 浏览器端到端与双主题 | `parity-final.json` 中图库与控制台均通过；实际暂存 bundle 独立启动亦通过，默认 Rust E2E 五条主流程通过，全站矩阵未跑 |
| 工作区 HTTP 读取切片 | 1002 记录、5×40 轮；p50 Node 15.09–15.36 ms、Rust 14.63–15.41 ms，未得出加速结论 |
| 启动、安装包体及完整进程树成本 | 待补充同负载测量；上述分页切片不推广为全产品收益 |
| 安装/UAC、重启、多窗及用户资料回退 | 未执行本次 Rust 安装验收；走[唯一部署入口](../desktop-deployment.md) |
| 真实生成/视频、Ollama/语音、WD14 权重 | 未执行本次真实模型验收；模拟服务和小模型不替代目标工作量 |
| 原生依赖发行材料 | 未完成，`releaseReady=false` |

原生材料以 [Windows x64 清单](../../runtime-rs/native-dependencies.windows-x64.json)及[随附说明](../../runtime-rs/native-licenses/README.md)为准。目前仍需完成实际链接特性/目标的 SBOM 与 notices、Rust/编译器静态运行库闭包、构建镜像与工具链身份、对应源码及产品分发要求核对，并验最终安装包的 DLL/VC++ 环境。收集许可证文本或校验字节不等于获得发行结论。

## 恢复与后续

`maintenance-recovery` 默认只读预览，`--out` 只创建新计划；应用必须显式 `--apply-plan` 并重核签名、根、journal、进程及当前文件。原生入口覆盖启动聚合新增的词条备份范围，不能改用旧 Node 恢复白名单处理这些新事务。用法见[工作流](../workflow.md#rust-运行时迁移)。

剩余工作按[013 计划](../../plans/013-node-to-rust-migration.md)和[未来规划](../roadmap.md)收口：最终构建/门禁绑定、发行材料及授权后的安装/模型/设备验收，然后确定旧后端源码退出时机。当前不删除旧库、旧来源或已有备份，不把 pending 资产计为交付。
