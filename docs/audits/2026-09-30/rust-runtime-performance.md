# Rust 迁移后运行时性能复审

日期：2026-09-30。接续 [搜索与测试负担复审](performance-simplification.md)。本轮覆盖正式 Rust 网关的主要请求链路和迁移边界，落实三处重复工作优化；不是每个源文件逐行审计，也不把旧 Node 测试通过当作 Rust 产品性能证据。

## 本轮落实

| 路径 | 当前问题 | 修改 |
| --- | --- | --- |
| `storage/profile.rs::snapshot` | 先把所有窗口草稿正文从 SQLite 复制成 Vec，再按当前窗口过滤；保存大量旧窗口草稿时，读取小窗口也搬运整域数据 | 将原有窗口筛选放到 SQL，逐行构造结果，不再收集完整正文数组；逐行检查取消。使用 instr/substr 做字面匹配，保留 Unicode、百分号、下划线、未分窗旧数据、排序和回执语义 |
| `storage/backup/verify.rs::verify_records` | 每条作品和每个项目重新 prepare 固定 SQL；项目成员先收集所有 JSON 字符串再解析 | 两个校验 statement 各准备一次；成员逐行解析，保留原画引用、成员顺序、记录身份、垃圾箱、媒体哈希和取消核验 |
| `generation/probe.rs::webui` | 查询 WAI 模型时深复制已解析的整份模型目录，只用于只读查找 | 直接借用模型数组，消除一次完整 Vec/Value 深复制；状态返回字段、fresh 重查与缓存语义保持 |

没有新增依赖、缓存层、服务工厂、协议字段或持久化迁移。Rust 默认测试文件和用例数量未增加；在既有存储 round-trip 用例中补充当前窗口/其它窗口/旧全局草稿及 Unicode、SQL 通配符字符的行为验证。

## 隔离测量

Windows x64，Node 24.18.0，Rust 1.97.1，release 优化构建、bundled rusqlite 0.40。一次性工具提取当时真实源码的 snapshot/reset、verify_records 及 entity_key 函数，接到内存 SQLite 和中性记录；错误上下文采用轻量替身，revision 与取消上下文为替身。不复制改写测量算法。七轮独立数据库，每轮十二次调用，统计每轮中位数再取中位数；响应序列化/校验哈希在计时外。

| 测量 | 之前 | 之后 | 行为核对 |
| --- | ---: | ---: | --- |
| 10,001 条草稿、100 个窗口，当前窗口返回 101 条 | 12.4888 ms | 1.4539 ms | 七轮前后响应 SHA-256 一致 |
| 5,000 条作品、1,000 个项目、每项目 5 位成员的记录核验 | 37.6091 ms | 16.0576 ms | 全部原画关系和项目成员验证成功；真实备份/恢复流程由 Rust 行为测试复验 |

备份记录核验的固定 statement 准备数量按代码路径从 6,003 次变为 5 次；没有减少核验 SQL 的执行次数。草稿过滤仍扫描相应域的键，没有宣称新增窗口索引或 O(1) 查询；收益主要是跳过其它窗口正文的复制并取消整域 Vec。模型目录删除复制有代码路径证据，本轮没有给它单独编造耗时或内存数字。

这些数字不包含 HTTP、唯一 SQLite worker 的排队、实际数据库磁盘读取、文件复制、原图哈希、fsync、进程 RSS 或 GPU。不能据此宣称整应用、完整备份或真实模型相同比例提速。脚本位于忽略目录 `scripts/archive/rust-hotpath-audit.mjs`，临时 benchmark crate 同在 archive；前后源码、哈希、原始日志和七轮结果保留在 `runtime/rust-performance-2026-09-30/`，不入 Git。

## 链路审查结论

| 范围与核对入口 | 当前判断与剩余成本 |
| --- | --- |
| 桌面作品查询：`storage/records.rs`、`workspace_http/commands.rs`、前端 artworkRepository | 全局搜索首条查询仍经 readHistory 读取全库，每页 200 条；万条约 50 次 HTTP。这是当前优先级最高的跨层改造候选，应由现有 Rust/SQLite 返回匹配摘要和有界结果。需同时保持多词子串、Unicode、时间排序、软删过滤、取消和工作区身份语义，本轮没有把它标为已解决 |
| 任务与恢复：`storage/tasks/listing.rs`、`task_runtime`、`tasks_http/results.rs` | 已有无变化 patch 去重、带水位分页、恢复 rowid、冷媒体校验移出 SQLite worker；未重复重构。任务记录反序列化/Value 交接仍有成本，未测得值得改变整套 DTO 的收益 |
| 本机 HTTP 和代理：`upstream/client.rs`、`upstream/proxy.rs` | 已复用 reqwest Client、连接池与流式转发；没有每请求重建本机客户端。大 JSON 的解析仍同步完成，是否下沉 blocking pool 应按实际体量和 executor 尾延迟测量，不能将小状态请求全部交给新线程池 |
| 聊天与语音：`chat/transport.rs`、`chat/stream.rs`、`chat/settings.rs`、`voice/config.rs` | 受信上游共用客户端；远程自配公网 API 每次 DNS 校验后固定连接地址属于访问边界，不直接改成普通连接池。聊天流已有有界通道和独立总期限；voice Settings 只在初始化读取，不是每次 TTS 同步读配置。托管 chat 配置每请求读回属于真实更新语义，未添加失效缓存 |
| 生图/视频：`generation/probe.rs`、`generation/recovery.rs`、`images`、`video` | WAI 探测已并行，常规状态有短缓存，fresh 请求不借旧缓存。排除了“只探 options/models”候选：恢复任务还核对采样器、scheduler 和 hires upscaler；省略会改变真实可执行性判断。没有修改生成提示词、模型参数、输出画质或队列许可 |
| 普通静态文件：`static_files.rs`、`remote_content/precompressed.rs` | ServeFile 已处理流式、Range、HEAD 和预压缩，不把完整图片缓冲进 gateway。docs redirect 仍逐请求读解析 redirects.json，但文件小、路径低频，当前不增加专用缓存 |
| 原图/缩略图/原生图像：`storage/verification.rs`、`storage/thumbnail.rs`、`native_images/api.rs` | 已有同文件合并、有界解码许可和 hash 身份缓存；libvips API 实际由 OnceLock/Arc 懒加载，并非每张图重载 DLL。vips operation cache 禁用用于避免上传内存被图计算缓存持有；未开启此缓存换速度 |
| 资源与远程审核：`resources/manager.rs`、`resources/resolve.rs`、`resources/http/overlay.rs`、`remote_content.rs` | 资源包 overlay 的 Live2D 分组可能在多个资源请求中重复哈希依赖，是专项采样候选；当前配置未证明此链是主耗时。授权配置、发布字节和撤销核验仍要生效，不能仅用永久路径/mtime 缓存替代。普通参考读取仍按人物分片，不将全参考库塞进启动页 |
| 启动/维护：`bootstrap.rs`、`maintenance/fs.rs` | packaged 启动已检查现成产物后返回；非 packaged 的首轮只读判断和锁内重读承担防漂移职责。未为了启动时间删掉锁内重读、事务备份或 fsync |
| 开发与旧 Node 对照：package scripts、Rust migration report、parity.mjs、quality inventory | 安装的产品不再启动 Node 后端，Node 仍服务构建、维护和差分夹具。npm prestart/prebuild 编译 Node 工具和旧测试的成本属于开发链；不等于桌面运行成本。旧 Node unit/contract 有部分保留的协议锚点，后续应逐文件建立与 Rust 行为/差分覆盖的替代关系再收口，而不是仅按数量删除 |

本轮未开展真实模型吞吐、GPU/显存、WebView2 renderer、长期多窗口内存或主力机设备测试；原有 GPU/模型待验项继续保留。上述“已有优化”均经本轮当前源码核对，没有把旧报告的 PASS 重新包装成当次性能采样。

## 当次验证与环境失败

| 检查 | 结果与证据 |
| --- | --- |
| 实际 Rust 全部默认行为测试 | **117 通过、0 失败、8 ignored**，`rust-tests-neutral-temp.log`；ignored 为显式原生/性能专项，不计通过 |
| 正式 crate release 库构建 | 通过，`release-lib.log`；不是 EXE/安装包构建，不改变已安装应用 |
| 全 crate rustfmt | 通过，直接执行已安装 cargo-fmt/rustfmt，`fmt.log` |
| Clippy / 统一 rust:check | 未完成；rustup shim 报 stable 缺 manifest，实际工具链没有 cargo-clippy.exe/clippy-driver，`rust-check.log`、`clippy.log`。未安装工具链组件或放宽 -D warnings |
| 体量、diff 格式 | 通过，0 新豁免；未运行无关前端/E2E全量 |
| 文档链接 | 当次 docs:check 通过，见 `docs.log` |

初轮 Rust 测试的 23 个失败保留在 `rust-tests.log`。本机默认 TEMP/TMP 为 `C:\Users\ADMINI~1\AppData\Local\Temp`，其短路径与 canonical 目录名不同，维护/资源/角色图的防别名检查将它拒绝。改用仓库内临时目录后 96 项通过、1 项资源对照失败（Node 的 protected-root 政策拒绝仓库内资源库），记录为 `rust-tests-local-temp.log`。最终使用独立新建的仓库外 `E:\codex-test-fixtures\performance-20260930-<UUID>`，117 项完整通过；TEMP/TMP 只在该命令进程设置，夹具路径记录在 `fixture-root.txt`。没有改动系统环境、生产资料或路径拒绝规则，没有抬高超时、删失败断言或跳过测试。

## 交付状态与后续顺序

本轮修改三个 Rust 生产文件和一个既有行为测试文件。上一轮搜索优化、工作区已有遮罩/粒子及其它会话改动均保留。期间其它会话将 main 从 `4be54c1c` 提交到 `60a8ed71`，本轮原始测量绑定源文件 SHA-256；按 AGENTS 的单会话 Git 写入约束，本轮未提交/推送，未安装桌面、未调用真实模型。

后续优先处理全局搜索的全库传输；资源分组核验与大 JSON executor 阻塞先做对应负载采样；Node 默认测试收口先完成具体行为覆盖映射。Clippy 待工具链组件可用后补验，当前不能将整个 rust:check 声称为通过。
