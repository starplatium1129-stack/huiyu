# Rust 后端六项性能优化与继续审计

日期：2026-09-30。基线 `09c7ab34`；在独立工作树 `rust-performance-six` 实施，保护主目录其他会话的文档、提示词与测试工作流修改。没有调用真实模型、访问生产 workspace、安装或部署。本轮不修改提示词、模型参数、图片质量和内容分级。

## 六项实现

| 工作包 | 实现 | 保持的契约 |
| --- | --- | --- |
| 媒体反向索引 | 在既有 additive-index 入口增加 `media_aliases(hash)`、`media_refs(hash)`；新库、既有 v3 与恢复候选均取得索引 | schema/backup 版本和业务 revision 不变，外键、完整性、成员顺序与持久性不降低 |
| Live2D overlay 单遍核验 | 当前请求文件从两次读取/哈希变为一次；GET 共用 512KiB 读哈希循环收集 body，HEAD/304 只校验 | 整个 group 的每个依赖仍逐字节核验；授权、路径、版本、同长度篡改和关闭/取消检查保留，无 TTL/mtime 哈希绕过 |
| 内部二进制媒体块 | 内存输出用共享 `Bytes` 切片，文件块直接移交；走原 bounded actor 队列 | HTTP Base64 协议保留；两通道共用身份、offset、重试字节比较、lease、长度、writer epoch 与逐块 `sync_all` 校验 |
| 首次任务恢复 | 初始探测并发 2，原稳定水位分页与 OnceCell 保留；整批扫描 60s、清理 5s、共享请求等待 65s 上限 | 未完成初始化不标成功，可重试；超时仅是 unknown 观察，不重提、不隐式取消；清理跳过 dispatching、已完成结果及被其他操作持有的锁 |
| Comfy history 退避 | WS 活跃执行时 3s，未开始执行时 1s；无 WS 逐步退避至 2s；收尾窗口 5s 内用 250ms | WS 仅唤醒 history 权威核验；空 history 不算成功；lag、断线、取消与关闭可立即唤醒，不能漏终态或绕过取消确认 |
| 大 WebUI 结果解码 | ≥512KiB JSON/base64 进入最多 2 个 blocking worker；小响应直通 | 原 8MiB 字节上限及错误语义保留，取消后复核；CPU permit 持有至真实结束；注册与关闭同 scope，inline/CPU 都排空，inline 不在共享锁内解码 |

没有新增库、缓存工厂、协议字段或持久化兼容 shim。内部二进制接口限 `pub(crate)`，不暴露给客户端。

整合回归另修复存储关闭的窄窗口：worker 在退出后先关闭 receiver，再完成 shutdown 和发送 Close 确认；复制仍运行时不提前关闭，保证 `CopyFinished` 可入队。已确认关闭后的新写返回 unavailable；关闭前已被接收但丢失应答的写入仍是 `COMMIT_UNKNOWN`，不伪报未执行。

## 当次测量

Windows x64、Node 24.18.0、Rust release 优化构建；测量在构建完成后串行执行，没有同时运行浏览器、Cargo 或 GPU 基准。原始材料仅保存于忽略的 `runtime/rust-performance-six/`。

| 负载与范围 | 之前 | 之后 | 解释 |
| --- | ---: | ---: | --- |
| 实际 bundled SQLite 3.53.2：5万对象、5万别名、2.5万引用，删除200个无引用对象，3次回滚重跑的中位数 | 760.43ms | 0.8997ms | SCAN 变为 covering SEARCH；仅 SQL 删除机制，未计文件扫描、删除、完整 GC 或用户库 |
| 128MiB 纯 codec / 共享切片循环，3轮中位数 | 187.00ms | 0.0017ms | 后者不复制或写出128MiB，不是端到端数据传输时延；说明内部编码/解码被消除 |
| 各3轮16MiB、16块、同一个真实 actor/staging 磁盘路径，逐块 `sync_all` 开启 | 57.61ms | 35.79ms | 包含编码/队列/offset校验/文件写入/fsync；未计下载、最终媒体发布/哈希及真实生成 |
| 2MiB 中性 overlay 当前文件 GET | 2次读取、4MiB累计读取 | 1次读取、2MiB累计读取 | 真实读哈希 instrumentation；其他 group 依赖仍各读一次 |
| 同资源 HEAD/304 body 收集 | 2MiB | 0 | 仍完整流式核验字节，不等于零磁盘读取 |

两个 release 测量程序在六项主体冻结后编译。后续空 staging/快照代次修复未改变被测 SQL 索引、二进制块编码或 actor 写入算法；复用这些组件的测量，不把它冒充整个最终 EXE 的性能采样。原始日志：`bench-media-indexes.log`、`bench-media-transport.log`；overlay 的实际读量/收集量由回归断言验证。

Comfy 20s 的 virtual-time 调度回归验证≤7轮等待；真实模拟 HTTP 验证 WS 终态提示后仍以 history 决定结果。没有将调度模拟数字标成真实模型网络请求采样。解码回归用受控 CPU gate 验证轻量 HTTP 可响应、inline 并行、取消不提前释放 permit，以及关闭等待真实工作结束；未给解码虚构整机吞吐提升。

## 继续审计后追加的两个小修

1. **空 staging 短路**：安全打开 staging 目录后检查首项；为空则直接返回，非空复用同一 ReadDir 并保留首项。空目录不再查询无关 operation/task media/lease 历史或计算对应 digest。回执、revision、30天保留期、lease 保护、失败回滚和原 operationId 重试保留。

   独立原 DDL 机制夹具：10万 operations、2.5万 tasks（各1条 input/output）、2.5万 leases，实际 staging 为0，旧子阶段仍读取17.5万行、约9.6MB文本、约120万 VM步骤，随后构造10万次SHA256键。短路后该子阶段0查询/0digest；这是代码成本与SQL步骤证据，未测完整GC时延。原始报告 `runtime/perf-storage-next-audit.json`。

2. **资源撤销/发布按 Arc 代次**：旧 worker 失败只能撤销自己持有的配置与快照；成功返回前也须同一个配置、快照 Arc。避免同 identity 刷新时旧失败清掉新快照或旧成功发布过期代次。用实际2MiB读取在512KiB checkpoint暂停、修复坏字节并刷新同 identity 的两种竞争场景验证，不给产品引入测试 hook 或省略授权检查。

## 验证与失败记录

- 六项主体完整 `rust:check`：fmt、all-targets Clippy `-D warnings` 与151项通过，10项原有/显式实验 ignored；主体日志 `rust-check-final.log`。
- 最终八项改动的官方 `rust:check` 入口在 `CARGO_BUILD_JOBS=1` 下通过：fmt、all-targets Clippy、155项通过/0失败/10项ignored；`rust-check-official-serial.log`。另保留完整串行测试 `test-closeout-serial.log`。两个新ignored性能实验另行显式执行成功，其他设备/像素专项未执行。
- 单体500行、领域/依赖方向、diff 格式检查通过，没有新增豁免；全部新测试文件仍在500有效行内。
- 真实 Rust release 构建与来源/EXE绑定、网页构建预算及预压通过；最终来源见 `runtime/rust-evidence/build.json`。未构建 Tauri/NSIS，也未更新安装版。
- 首轮编译的 borrowed stream 生命周期及 integration 模块路径错误已修正。新历史恢复夹具原先误用正常 accept 写入103个同时未完成任务，触发 `TASK_PROVIDER_BUSY`；改为受支持的合法历史 SQLite 夹具，生产防重规则保留。历史行在 Storage 关闭后写入，核对身份、WAL、外键、revision、schema与完整性再重开。
- 首轮新关闭断言暴露 admission 窄窗口，已修复；304 新断言误认为无 Content-Length，已核对旧逻辑与 Axum 空 body 行为，精确验证 `0`，正文/ETag/version/读量断言保留。
- 补充小修的并行编译曾报告 crate rlib 格式缺失；底层错误为 Windows `os error 1455`（页面文件太小，无法 mmap 编译材料），日志 `rust-check-closeout.log` 保留。控制编译并发后完整复验通过，没有删除检查、放宽断言、抬高时限或修改系统页面文件。
- 浏览器 critical：94/95首轮通过；唯一万条旧作检索失败发生在 `page.goto(load)` 后、异步App/快捷键宿主挂载之前。trace确认该时点还未请求首批布局脚本，快捷键被丢失。只给测试补现有搜索按钮可见的 readiness，原Ctrl+k、10000全库、旧作/Enter URL断言保留，独立复验1/1通过，合计95/95有效证据。日志 `browser.log`、`browser-search-ready-native.log`；这里237ms搜索数据不是本轮Rust性能收益。
- worktree的 node_modules 复用采用junction，原生库发现器会按原安全规则拒绝它。浏览器夹具使用主目录经manifest字节/SHA核验的显式VIPS路径，ORT由mock-stack覆写为私有不存在路径，真实模型禁用。一次未带环境的启动拒绝保留为 `browser-search-ready.log`；没有放宽link guard。
- 文档检查271文件/1984本地链接/0坏链，体量及依赖方向门禁通过。同内容证据复用，提交本身不触发重复构建或全量测试。

所有实现保留在本聊天附加的隔离工作树与 `codex/rust-performance-six` 分支，尚未合入主目录的其他会话工作，也未同步已安装桌面端。完整Tauri/NSIS、UAC、真实模型/音画效果和主力机长期资源趋势继续按既有验收边界处理。

## 后续优化优先级

| 下一项 | 当前剩余成本 | 最小安全切片 |
| --- | --- | --- |
| 资源 mount 控制检查 | 每命中前后各1次，全局 mutex 内读配置/current/路径；未命中也先检查，约2h+m轮串行磁盘验证 | 先检查快照是否包含路径，锁外做原检查，回锁确认相同 Arc、active/closed。代次保护本轮已补；首次/状态 refresh 另行处理 |
| GC 候选发现 | 全目录遍历和安全路径/mtime/存在性判断仍独占 actor 和 writer；未过期、最终无删除也付出扫描成本 | 仅将发现移到有界后台，回 actor 后重查当前 refs/leases、文件身份和安全路径再删除；不能把旧 protected 集合当授权或直接后台 unlink |
| 导入人物聊天引用 | 每条聊天串行校验，重复引用与重复根 canonicalize；源码调用量约3N+9 | 引用去重、复用本次根、最多4路校验；结束时重新确认目录/companion身份。只影响导入人物，不长期缓存资格结论 |
| 恢复观察首轮消重 | 初次 reconcile 后 monitor 立即再观察；运行旧Comfy任务每轮history+queue及同步目录身份检查 | 首轮复用/同任务在途观察合并；取消、writer epoch、修订和提供方变化绕过复用。正常accept只允许一个未完成任务，不能泛化旧库多任务压力 |
| 远程纯投影复用 | release索引/URL查找及源JSON解码、公开字段投影、序列化每请求重做 | 只缓存exact index bytes对应解析结果、已核验SHA对应纯投影；每次重新授权、核验当前源SHA、比对index前后字节，缓存字节有界且响应继续持有admission |

这些为新的代码/机制候选，本轮未直接引入锁外事务、全局观察缓存或远程投影缓存。后续按实际桌面资源包、导入人物、旧库恢复与远程访问负载选择，不将理论复杂度变成未测得的整应用收益。
