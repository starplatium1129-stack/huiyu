# 搜索索引传输与响应复制收口

Clippy 补验（2026-09-30）：经用户授权安装同版本的 rustup 管理工具链及 Clippy/rustfmt，编译器仍为 `1.97.1`，默认工具链改为 `1.97.1-x86_64-pc-windows-msvc`；原 stable 目录保留。完整 `rust:check` 已通过：fmt、全目标 Clippy `-D warnings`、117 项行为测试通过，8 项显式专项 ignored。日志在 `runtime/clippy-setup-2026-09-30/rust-check.log`；下文“Clippy 缺失”为初次交付状态，现已补齐。未更新桌面安装。

日期：2026-09-30。基线 `005ffc43` 已提交并推送，包含前两轮搜索/测试负担与 Rust 读写优化。本轮落实先前报告中的全库分页成本，保留工作区原有遮罩、粒子和 TypeScript 热点审计改动。

## 实现与取舍

桌面全局搜索通过受限的 `GET /api/workspace/artwork-search-index` 一次读取完整轻量索引，不再通过每页 200 条的 readHistory 搬运完整作品正文。路径独立于作品 ID，不占用旧作品 `search-index` 的读取地址；原有 session、origin、scope、workspaceId 和 runtimeEpoch 校验继续生效。

Rust 在 SQLite 内投影显示所需原字段及八个检索字段，排除软删条目、原图/base64、配方和未知大字段，再组装规范化 searchText。客户端只接收 id、原始 title/sceneTitle/scene/timestamp/size 与 searchText，日期、标题和路径仍由既有 JS 规则处理。没有将旧字符串日期强行改成 Rust 日期解析，没有数据库迁移或额外索引表。

键入匹配继续在本地，最多展示 5 条作品；没有每个按键都发起请求、引入 debounce 或截断旧作品。空面板不读作品库，当前面板复用索引；关闭、清空、卸载取消读取。仓库保留一份已读的搜索快照供断联展示，返回数据与缓存隔离，确认编辑后失效；新能力不回落到旧 Node 后端。Web 使用其既有 IndexedDB 权威，在读边界生成同类轻量数据。作品搜索文字的纯逻辑归 application，View 工具只处理显示，图库继续复用同一文字规则。

另修正 Rust 的三处 JSON 重复制：搜索索引的 Vec 直接移动进 Value::Array；workspace/task HTTP envelope 直接接收已有结果，避免 json! 再次深复制整个 Value。字段、顺序、错误/回执与取消语义保持；没有新增通用包装工厂或依赖。

## 当次测量

Windows、Node 24.18.0、Rust 1.97.1 release 构建。真实 Rust Storage worker 经隔离 loopback Axum 提供查询，前后调用真实 TypeScript desktop repository 与索引函数；旧函数取自 `005ffc43`。三轮交替顺序，10,000 条中性作品，每条 prompt 2,035 字符，另有不会用于检索的旧图片/未知元数据字符串。计时包含 HTTP JSON 读取、客户端脱离副本和本地建索引，结果哈希在计时外。

| 项目 | 之前 | 之后 |
| --- | ---: | ---: |
| 完整读取请求数 | 50 | 1 |
| 解码后的响应正文合计 | 64,473,761 bytes（61.49 MiB） | 22,117,281 bytes（21.09 MiB） |
| 完整读取与建索引中位 | 916.61 ms | 322.43 ms |
| 三轮耗时范围 | 891.32–959.96 ms | 319.38–326.79 ms |
| 索引条目与显示/检索内容 | 10,000 条 | 10,000 条，六个样本结果 SHA-256 一致 |

这是本地隔离链路结果，不是整应用提速或实际用户库测量。HTTP 夹具绕过外层 host 认证，认证由真实 host_http 回归另验；没有压缩，因此正文合计不是浏览器压缩后实际网络字节。没有 DOM/GPU、原生安装、真实模型或进程内存测量。索引仍是 O(n) 全库读取，包含完整检索文字，大库仍有体量与冷读取成本；不能把一次请求解释为只传 5 条记录或完全解决大库内存问题。

原始结果、前后 hash、初次试验与源码身份保存在 `runtime/search-index-transfer-2026-09-30/`。一次性工具位于 `scripts/archive/search-index-transfer-audit.mjs` 与同目录 search-index-server crate，不进入常驻测试或维护入口。初次结果在完成 ownership 移动前有明显波动，保留为 initial-results.json；最终上述结果绑定修正后的源码，不用初次样本宣称最终收益。

## 验证与交付边界

- 5 个前端文件、29 项行为检查通过；Web 存储 14 项通过。覆盖全库旧作、多词、稳定排序、旧字符串日期、拒绝坏索引、取消/迟到结果、重开和离线快照隔离。
- Rust 路由 2 项、任务 HTTP 2 项及存储/host 集成 7 项通过。旧用例补充新只读路由、作品 ID 不冲突、未授权拒绝、软删过滤、非字符串标题、Unicode/希腊词尾、原日期字符串与保留全长检索词；未增加 Rust 默认用例或测试文件。
- 应用类型、tests 严格编译、领域/模块边界、体量、diff 与全 crate rustfmt 通过。受控前端 ESLint 0 error；原有 Node 测试 any 告警保留。
- 当前 Web 构建、包体预算和预压通过；既有接近预算的警告保留。深浅主题搜索及迟到导入取消共 3 项浏览器回归通过，截图已查看，搜索文字 AA 至少 4.5:1，CSS 视口 1440×960。没有新的布局修改、物理分辨率/DPI 或安装版 WebView2 结论。

相关日志在同一原始目录及前轮 `runtime/performance-simplification-2026-09-30/`。没有重复运行无关前端、Node 全量套件或真实生成；Clippy 组件仍缺失，未将 rust:check 声称为通过。release 测量实际链接本轮 runtime 库，但没有生成/安装正式桌面交付候选。

新前端与 Rust 新只读能力需要共同更新；目前安装版未同步。本轮源码按受控文件提交推送，具体身份见 Git 历史；工作区原有未完成修改继续保留。后续大库/长时资源采样仍应区分冷读取、键入匹配、SQLite worker 排队及进程/GPU 内存，避免再引入未测量的缓存框架。
