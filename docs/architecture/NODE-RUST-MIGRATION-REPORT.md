# Node → Rust 运行时迁移执行记录

更新于 2026-09-28。产品后端、独立服务入口与桌面 gateway 已改为 `runtime-rs/` 的 `huiyu-runtime`；Vue/TypeScript 前端、Tauri 壳和 Native Live2D 保留。下文保留候选构建记录。后续经用户授权，PR #11 已合并 main，并完成 Rust 版 1.7.2 的本机安装与启动核验，见[安装证据](../evidence/rust-installation-2026-09-28.json)。**尚未公开发布，原生发行材料仍为 `releaseReady=false`**。

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

Linux 的 `C`/`POSIX` 系统 locale 按 [Node 24.18 的 V8 实现](https://github.com/nodejs/node/blob/v24.18.0/deps/v8/src/execution/isolate.cc#L6711)映射为 `en-US`，避免任务运行时在初始化时退出；已有账本记录的 locale 仍按原值严格解析。Unix 磁盘余量计算使用宽整数饱和转换，避免 x64 专属的同型转换 Clippy 失败。首次 Linux CI 已通过格式与 Clippy，单元测试为 64 过/1 失败/1 原生专项忽略；失败暴露目录列表另有一处未规范化系统 locale。现将目录列表与任务指纹接到同一模块，保留旧账本 locale，相关本机 5 项定向回归通过；Linux 复验的 65 项单元、16 项集成、release 与协议对照已全部通过，运行记录见下表。展示层与图像实现未改，双主题和原生字节对照证据复用；最终 release 的协议复验见 `parity-locale-final.json`。

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
| 原生及桌面补验 | 已暂存 DLL 对 12 种 WD14 预处理像素差异均为 0；36 个派生文件逐字节一致；332 字节 toy ONNX 在 CPU 通过；实际 Tauri 配置的 debug 构建完成，独立 bundle 首轮启动 232 ms，最终 EXE 重验 204 ms | 小模型/中性素材及一次启动样本不证明真实权重、实际安装或发行材料完成 |

默认 Playwright 的 web 与 flows 入口已改为实际 Rust release EXE；Node 只提供五个可编程假上游。每栈使用临时 app/runtime/AI，拒绝复用已有网关；CI 先构建 Rust。既有断言未调整，Krea、SD 出图入册、Anima job、翻译配音、流式聊天五条主流程全部通过（`rust-critical-flows.log`，31.8 秒）。完整全站浏览器矩阵未在本轮运行。Rust 专项 `parity.mjs`/`browser.mjs` 还对实际暂存 bundle 完成工作区往返与图库/控制台双主题验收（`parity-release-final.json`、`ui-release-final/`）。

连接池、流式背压、SQLite 专用线程、有界任务队列、共享不可变资源清单与媒体身份缓存已经实现。启动聚合按域封存原产物；原文缩小后清除旧压缩伴生文件，避免返回旧内容。这些是实现措施，**尚未据此宣称整机内存、GPU 或模型速度改善**。

## 最终验收与剩余项目

| 项目 | 当前记录 |
| --- | --- |
| 最终源码提交/内容身份 | 代码提交 `c1f30f9e`；Rust 源选择身份 `660ea68242f6a64da6f2278df13716f639ddb6a19a41319a04036782f6b9940c`。交付分支 `codex/node-to-rust`；后续文档更新不改变已验证代码。桌面构建/NSIS 绑定已生成；后续实际安装身份见下文及安装证据 |
| Rust 门禁 | [Linux CI](https://github.com/starplatium1129-stack/huiyu/actions/runs/36339429625) 的格式、全 targets Clippy、65 项 lib+16 项 integration、release 及 Node 协议对照全部通过。4 项原生专项在 Windows 显式通过；本机 locale/Live2D 定向回归通过 |
| Node 完整 check | `--all` 19 过/1 失败：原生 title 36 > 基线 35；没有放宽断言或宣称全量通过 |
| release runtime | 25,287,680 字节；SHA-256 `3350ce3cc8e902e79a86340d6026679656768af8e954a2ee78f71e8744596ff3`；见 `runtime/rust-evidence/build.json` |
| 暂存 bundle、桌面 EXE/NSIS、发行输入绑定 | stage+独立 bundle 启动通过；Tauri release/NSIS 与 `verifyDeployment` 绑定通过。Updater 签名按 `--no-sign` 跳过；后续本机安装已完成，未公开发布 |
| Rust 浏览器端到端与双主题 | `parity-final.json` 中图库与控制台均通过；实际暂存 bundle 独立启动亦通过，默认 Rust E2E 五条主流程通过，全站矩阵未跑 |
| 工作区 HTTP 读取切片 | 1002 记录、5×40 轮；p50 Node 15.09–15.36 ms、Rust 14.63–15.41 ms，未得出加速结论 |
| 启动、安装包体及完整进程树成本 | NSIS 候选 400.83 MiB，大部分体积为保留的静态资源；尚无相同负载/压缩口径的整机对照，不把分页切片推广为全产品收益 |
| 安装/UAC、重启、多窗及用户资料回退 | 后续已通过唯一部署入口安装，用户确认 UAC；认证宿主与 Rust 网关 ready，现有 workspace owner 与 Rust PID 一致。多窗/资料回退的完整设备矩阵未重做 |
| 真实生成/视频、Ollama/语音、WD14 权重 | 未执行本次真实模型验收；模拟服务和小模型不替代目标工作量 |
| 原生依赖发行材料 | 未完成，`releaseReady=false` |

原生材料以 [Windows x64 清单](../../runtime-rs/native-dependencies.windows-x64.json)及[随附说明](../../runtime-rs/native-licenses/README.md)为准。目前仍需完成实际链接特性/目标的 SBOM 与 notices、Rust/编译器静态运行库闭包、构建镜像与工具链身份、对应源码及产品分发要求核对，并验最终安装包的 DLL/VC++ 环境。收集许可证文本或校验字节不等于获得发行结论。

### 首次 Windows 本地安装候选（后续已替换）

`npm run package:tauri` 从上述代码完成完整构建；使用已有 Cubism Native R5 SDK，没有安装 SDK 或应用。回执为 `runtime/delivery-evidence/desktop-build-binding.json`，候选摘要为 `runtime/rust-evidence/desktop-package-final.json`。

| 产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `desktop-tauri/src-tauri/target/release/ai-cg-studio-desktop.exe` | 45,786,624 | `ef7ea0f69026f65c0f41a170a10113f04cddda318e3c72114570d355cb12f718` |
| `desktop-tauri/src-tauri/target/release/bundle/nsis/AI-CG-Studio_1.7.2_x64-setup.exe` | 420,299,322 | `6d92c7e61ce5cacfef6b1a6dfeab7400ad2a7fe94d8cb05ba7c61724e2502dd8` |

桌面源选择身份为 `d015cea3968174a7ad2def5ce43d2970c4f9eb639cb28d4925f16c772d325324`，构建产物身份为 `cb55434f2b9d36728180eb76a9a978397755177e4ec29f5f7b156c0fadef5384`。保留仓库 1.7.2 版本号只用于本地候选；它不是已发布 1.7.2 的同一产物，不可冒充或覆盖公开资产。实际安装仍仅走 `deploy-desktop.bat`，UAC 由用户操作。

### main 合并与实际安装

PR #11 以 `f05f8724` 合并。首次安装后，校验发现宿主仅有 Tauri 正常写入的 `UNK → NSS` 三字节标记变化；`42041f46` 修复为从已绑定源推导这一个确定变换并核对完整 SHA-256，任意其它修改仍拒绝，定向夹具通过。随后使用既有 `desktop:package-local` 无压缩方式重新完整构建，经 `deploy-desktop.bat -UseInstaller -QuietInstall -SkipBuild` 安装成功并启动。新包与实际文件哈希统一见[安装证据](../evidence/rust-installation-2026-09-28.json)，上面的 400.83 MiB 候选属于历史记录。

运行中的宿主位于 `D:/AI-CG-Studio/ai-cg-studio-desktop.exe`，子进程为 `gateway/huiyu-runtime.exe`；认证维护状态与网关健康检查通过，现有 SQLite workspace owner 已对应 Rust PID。旧 Node 程序残留文件未清理，也未被本应用启动。本次没有主动调用真实模型或把本地安装当作公开发行。

## 2026-09-28 聊天流生命周期补强

客户端保持连接但停止读取响应时，原先的按需读取 Body 不再轮询上游超时，因而可能长期持有 Ollama 串行许可。聊天响应现用 4 槽有界通道转发，响应创建后独立计时 600 秒；停止读取也会触发释放。Body 丢弃或宿主关闭通过子取消令牌停止转发，不取消宿主令牌。终态使用独立通道，满缓冲区后的超时仍能在恢复读取时返回原有 `error` 事件；正常 `done` 后释放许可不依赖下一次 Body 轮询。

本机 `npm run wf -- rust:check` 的格式、Clippy、69 项单元与 16 项集成测试通过，4 项原生专项按原配置跳过。新增 4 项聊天生命周期回归覆盖停读超时、后续请求进入、静默上游下的关闭/断连及正常完成；停读测试使用虚拟时钟和内存响应，仍持有真实队列许可。前端 `src/utils/stream.spec.ts` 2 项及单体体量门禁通过。未调用真实模型、构建发行包或同步桌面安装；本节不更新既有安装身份或设备验收结论。

最后移除测试专用截止时间入口后，最终源码再次通过格式、全 targets Clippy 和 9 项聊天定向测试；其余未受影响的 Rust 检查沿用上述结果。

## 2026-09-28 性能优化

同图解码合并、项目反查索引及后续 CPU/内存/GPU 优化的结果、验证与设备边界统一见[性能优化报告](../audits/2026-09-28/performance.md)。原始测量仅留本机，不随仓库提交。

## 恢复与后续

`maintenance-recovery` 默认只读预览，`--out` 只创建新计划；应用必须显式 `--apply-plan` 并重核签名、根、journal、进程及当前文件。原生入口覆盖启动聚合新增的词条备份范围，不能改用旧 Node 恢复白名单处理这些新事务。用法见[工作流](../workflow.md#rust-运行时迁移)。

剩余工作按[013 计划](../../plans/013-node-to-rust-migration.md)和[未来规划](../roadmap.md)收口：继承的 title 门禁、全站浏览器/整机对照、发行材料及真实模型/完整设备验收，然后确定旧后端源码和旧安装程序残留的退出时机。当前不删除旧库、旧来源或已有备份，不把 pending 资产计为交付。
