# Node → Rust 生产边界盘点

盘点日期：2026-09-27，来源基线为 `aba7e24b`；2026-09-28 已进入交付收口，当前实现与证据见[执行记录](NODE-RUST-MIGRATION-REPORT.md)。机器清单 [migration-inventory.json](../../runtime-rs/migration-inventory.json)保留旧来源、登记、命令、依赖边和初始 `pending`，用于范围追溯，不是当前未实现列表或完成率。批次含义见 [013](../../plans/013-node-to-rust-migration.md)，不能因 Rust 函数/路由存在便自动标为行为验收通过。

## 范围与口径

入口是 `server.ts`，包含桌面 host、独立 Web 模式、存储 worker、生产 HTTP handler 间接加载的脚本，以及维护子进程的确定白名单。Vue、Tauri 已有 Rust、Native Live2D、外部模型服务不重写。开发/前端构建仍可使用 Node。

使用 TypeScript 5.9.3 在内存中去除类型后解析 AST，递归收集真正保留的 import/require；生成 `.js` 定位回手写 `.ts`，不重复统计。worker、fork、维护脚本分派补显式边。没有执行生产服务、维护脚本、模型或真实 workspace，也没有读取生产数据库。

| 项目 | 盘点结果 | 含义 |
| --- | --- | --- |
| HTTP 路由登记 | 164 条 | 含别名、数组展开、手工分派和代理白名单；SD txt2img 的限流登记与代理白名单重复，SPA 正则和开放式资源路径也在内，**不是 164 个唯一具体端点** |
| Workspace command | 55 种 | 核心、媒体库、profile、旧来源导入、持久任务的完整类型联合；不是 55 个 HTTP URL |
| 维护 task | 4 种 | `POST /api/maintenance/run` 的确定白名单 |
| 运行时源模块闭包 | 227 个 | server.ts 1、server 80、routes 53、services 18、scripts 55、共享 src 模块 20；包括 WD14 client → worker、维护子进程及蓝图保存的条件内容校验显式边 |
| 生产 npm 根依赖 | 6 个 | compression、express、http-proxy-middleware、onnxruntime-node、sharp、ws |
| npm 锁文件闭包 | 143 个包位置 | 含各平台可选包；不是 Windows 实际安装数、包体或进程内存 |

相对模块引用和 npm 锁文件依赖均已解析；剩余唯一非字面 Express 登记是 `maintenance-scene-save.ts` 的 `router.post(url, ...)`，已按四行 URL/mode 表展开。静态挂载、WS、按方法/path 分派单列；隐式 HEAD、OPTIONS、具体文件和参数取值不靠扩大计数声称覆盖。

## HTTP 与运行时迁移批次

下表路径组采用共同前缀简写；完整方法、每条路径、来源行号在 JSON 的 `httpRoutes`。逐项初始状态保留 **pending**；已落地范围与待验收区别见执行记录。

| 路径/职责 | 旧实现 | 批次 | 实施边界与验收要点 |
| --- | --- | --- | --- |
| `GET /api/health` | `server.ts` | M1 | 能力/队列状态、desktopProtocol、直接本机 challenge HMAC，`no-store` |
| `POST /api/desktop-host` | `server/workspace/host.ts`、`host-auth.ts` | M1/M2 | session、prepare-candidate、activate、enable-bundled、shutdown 五种 action；签名请求体、nonce、窗口、sourceProfileId、Origin、维护排空 |
| `/api/workspace/status`、artworks、projects、operations | `routes/workspace.ts`、`server/workspace/{engine,records,schema,owner}.ts` | M1 只读 / M2 完整 | 分页/复合 ID、revision、writerEpoch、操作回执、软删/硬删/恢复、项目归属 |
| `/api/workspace/artwork-saves/:operationId` 及 chunks/commit/abort | `routes/workspace.ts`、`server/workspace/saves.ts` | M2 | 媒体先发布再提交元数据；未知提交不能回滚成丢图 |
| `/api/workspace/media-*`、media、thumbnail、collect、trash/purge | `routes/workspace.ts`、`server/workspace/{media,library-media,garbage,thumbnails}.ts` | M2 | 上传、原图流、别名租约、缩略派生与清理；不把原图跟随缩略失败删除 |
| `/api/workspace/media-capabilities`、`media-content/:alias` | `server/workspace/host-media.ts` | M1/M2 | 会话换媒体 capability，GET/HEAD/Range 与 MIME；不能用全局共享 token 授权私库 |
| `/api/workspace/backups`、`backups/:backupId/restore` | `server/workspace/backup.ts`、worker | M2 | 一致快照、取消、复原候选；备份复制让出存储串行通道 |
| `/api/workspace/profile/{settings,chat,drafts}`、chat/reset | `routes/workspace-profile.ts`、`server/workspace/profile-*` | M2 | GET/PUT/reset、期望 revision/reset、windowId；这些由 `router.use` 分派，普通 route grep 会漏 |
| `/api/workspace/migrations` 及 status/verify/records/chunks/media | `routes/workspace-profile.ts`、`server/workspace/migration-*` | M2 | 旧浏览器来源按域导入、分块、指纹、审核与 host 激活 |
| `/api/tasks/v1/`、legacy-history、by-key、id、delivery、results、reconcile/resume/concat/continue | `routes/tasks.ts`、`server/tasks/*`、`server/workspace/tasks.ts` | M4 | 持久 accepted、取消意图、输入快照、结果收件箱、provider 绑定、重启 unknown |
| `/api/generation/{status,jobs}` 及状态/取消/结果 | `routes/generation.ts`、`server/generation/*` | M4 | WAI Comfy/SD WebUI provider；任务和直接生成入口不能混为一种语义 |
| `/api/anima/*` 与 `/api/creative/*` 的 status/images/jobs | `routes/anima.ts`、`routes/anima/*` | M4 | 两套 API 别名与模型选择、输入图上传、任务取消/结果；保持工作流和 prompt 语义 |
| `/api/video/*` 的 status/images/jobs/storyboard/batches | `routes/video.ts`、`routes/video/*`、`video-stream.ts` | M4 | 单镜头、批次、按镜头重试、concat、媒体 Range；ffmpeg 继续作为外部工具 |
| `/api/chat`、chat-status、chat-provider/test、host-config | `routes/chat.ts`、`chat-{content,validation}.ts`、`server/chat-*`、`services/ollama-service.ts` | M5 | NDJSON 流、配置测试与托管、工具调用；慢读背压、UTF-8 分片与断连取消 |
| `/api/translate`、tts-status、voice/prepare、`GET/POST /api/tts` | `routes/voice.ts`、`services/{translation,tts}-service.ts` | M5 | 外部 Python/GPT-SoVITS、共享生成、60 条/128 MiB 音频缓存、RIFF 修正与播放流 |
| `/api/video-ai/{status,rewrite,polish,dialogue,review,script}` | `routes/video-ai*.ts` | M5 | 配置/提示模板/输出解析、远程自配 API 与本机托管权限边界 |
| `/api/live2d-{companions,local,status,model,texture}` | `routes/live2d.ts`、`services/live2d-*` | M6 | 本机素材、模型清单、质量与纹理派生；不重写 Tauri Native Live2D 渲染 |
| `/api/live2d-import`、id、rollback | `routes/live2d-import.ts`、`services/live2d-import-*` | M6 | multipart/raw 上限、候选导入、编辑/回滚、资源路径与图片准入 |
| `/api/interrogate`、interrogate/status | `routes/interrogate.ts`、`server/interrogate-engine.ts` | M6 | WD14 ONNX、图片解码/448 预处理、BGR/NHWC、阈值与降级；真实权重输出另验 |
| `/api/resources/{status,tasks}`、tasks/id/cancel | `routes/resources.ts`、`scripts/lib/resource-*` | M6 | import/download/recover/rollback 四种任务；资源策略、完整性、取消、安装 journal、版本回滚 |
| `/api/character-reference-profile/:id`、reference view、character-references | `routes/resources-reference.ts`、`server/character-reference-profile.ts` | M3/M6 | 人物懒加载、参考发布/图像哈希绑定、local-only；发布失效不得落回普通静态路径 |
| `/api/maintenance/scenes`、import/changes/preview、scenes-state | `routes/maintenance-scene-save.ts`、`maintenance-scene-state.ts` | M6 | 四个 POST 动态登记、快照冲突、pin 原字节、scene 锁、备份/事务恢复 |
| `/api/maintenance/{backups,recovery-status,home-hero,showcase,run}` | `routes/maintenance.ts`、`maintenance-{backup,content-products,validation}.ts` | M6 | home-hero GET 的公开投影与缓存；其他本机控制；安装包内容维护仍返回现行 501 |
| `/api/{status,sd-status,share-link,diagnostics,logs,start,stop,config,preference,mode}`、service、maintenance/build-web | `routes/control.ts`、`routes/control/*`、`services/{control-operation,service-watchdog}.ts` | M6/M7 | 服务探活/监护、期望状态、隧道、PowerShell 管理；源码构建属于开发 Node 工具链 |
| `POST /api/desktop-tools` 与聊天工具调用 | `routes/desktop-tools.ts`、`server/{companion-tools,tool-command,tool-process}.ts` | M6 | 8 种工具分派；trusted run_command 默认关闭、图片工具按分级；进程树/输出/超时/取消 |
| SD 原生代理、WS upgrade | `server.ts`、`server/sd-proxy-policy.ts` | M3 | GET/HEAD 六条只读路径，POST 三条写路径；写与 WS 仅直接本机，upgrade 另验 Host/token |
| Host/token、native CORS、远程内容、静态/预压/SPAs | `server.ts`、`server/{security,remote-content,precompressed,static-path-policy,public-data,docs}.ts` | M3 | 顺序是权限 → 私库/资源发布 → 预压/静态；未知/远程分级 fail-closed |

## 中间件与动态资源面

以下是路径空间，不能视为一个字面 GET handler 便宣称完整迁移：

- `/_app`、dist 根、`/css`、`/src/assets/css`、`/assets`、`/assets/live2d`、`/assets/live2d-current`、`/data`、`/scene-showcase`、`/character-references`、`/docs`、`/tools`。需要保留安装资源优先级、manifest allowlist、隐藏文件、真实根路径、压缩协商、ETag/304、缓存和 SPA fallback。
- 远程内容发布覆盖 `/data|assets|scene-showcase`，只允许审核绑定的 All 内容；reference view/images 保持本机。读取前后都核对发布索引，响应为核验过的字节。没有发布索引不是“默认公开”。
- `/sdapi|controlnet|adetailer|comfy|prompt|queue|history|object_info|interrupt|view` 未开放路径统一拒绝。不能把 Comfy 外部 URL 直接透传浏览器。
- SD 白名单读路径是 `sd-models`、samplers、schedulers、upscalers、options、progress；写路径是 txt2img、options、interrupt。HTTP/WS 使用同一允许集合，但方法和身份约束不同。
- desktop host 路由先于共享 token；workspace/task 使用独立 authority、principal、runtimeEpoch 与 Origin。普通 `OPTIONS` 的 CORS 行为及未匹配错误仍需在协议接线中保留。

## 55 种工作区命令

这些内部命令经过 HTTP/host/task 边界构造，客户端不能提交任意 command 名执行。完整来源和逐项状态在 JSON；下列均 pending。

| 组 / 来源 | 命令 | 批次 |
| --- | --- | --- |
| Core / `server/workspace/types.ts` | status、listArtworks、getArtwork、getArtworks、listProjects、prepareSave、uploadChunk、commitSave、abortSave、getOperation、patchArtwork、softDeleteArtwork、softDeleteArtworks、hardDeleteArtwork、restoreArtwork、saveProject、purgeExpiredTrash、collectGarbage、readMedia、readThumbnail、backup、restoreBackup | M2 |
| Library / `server/workspace/library-media.ts` | prepareMedia、uploadMediaChunk、commitMedia、releaseMedia、appendArtwork、countMedia | M2 |
| Profile / `server/workspace/profile-types.ts` | profile.readSettings、saveSetting、readChat、saveChatRecord、resetChat、readDrafts、saveDraft（均带 `profile.` 前缀） | M2 |
| Import / `server/workspace/migration-types.ts` | migration.begin、record、recordChunk、media、verify、status、activate（均带 `migration.` 前缀） | M2 |
| Task / `server/workspace/task-types.ts` | task.accept、list、legacy-history、get、patch、cancel、result.prepare、result.chunk、result.commit、input.prepare、input.chunk、input.commit、input.get（均带 `task.` 前缀） | M4 |

持久任务 provider 位于 `server/tasks/providers.ts` 和 `batch-provider.ts`；anima/creative、WAI generation、video、batch 复用相应服务。关键依赖是输入快照、providerFingerprint、提交意图/观察时点、checkpoint、结果媒体提交，不是只移植 Router。

## 生产脚本闭包与外部进程

| 入口 | 确定调用 | Node 迁移处理 / 状态 |
| --- | --- | --- |
| 网关启动 | `scripts/lib/ensure-data-build.ts` → scene/popular/blueprint/tag/reference store，必要时 `scripts/maintenance/precompress.ts` | M6 pending；保留陈旧/缺失重建、聚合字节与压缩刷新，安装包模式与源码模式按原条件处理 |
| `maintenance/run` task=lint-colors | `scripts/maintenance/lint-colors.ts` → style-sources、tailwind-style-audit | M6 pending；保留源码模式操作入口，不因看似 lint 就漏计运行时调用 |
| task=validate | `scripts/maintenance/validate-scenes.ts` | M6 pending；输入根隔离与场景/分片/保护契约 |
| task=classify | `scripts/maintenance/classify-scene-ratings.ts --write` | M6 pending；保留评级来源与保护字段，不重写 prompt |
| task=optimize | `scripts/maintenance/optimize-scenes.ts --write` | M6 pending；依赖 prompt-policy 与真实场景编译契约，真实 Token/画面验收仍适用 |
| 场景保存 | 固定顺序 classify `--write` → optimize `--write` → validate | M6 pending；子进程退出后才可回滚，不能改成未经等待的并发写 |
| 包含蓝图的场景保存 | `scripts/maintenance/validate-content-contracts.ts` → check-ref-urls、popularContent、promptCompiler/Krea 规则 | M6 pending；这是条件 Node 子命令，不能只按 maintenance/run 四任务表盘点 |
| 维护执行器 | `maintenance-transaction-process.ts` fork `maintenance-transaction-child.ts`，ready/PID 入账后 start/runMain | M6 pending；以 Rust 子命令/专用工作器替代 Node，保留租约参与者和退出语义 |
| 私库工作器 | `server/workspace/client.ts` → Worker `worker.ts` → engine | M2 pending；专用存储线程、顺序执行、独立备份通道，不阻塞异步 HTTP |
| 资源与参考发布 | `scripts/lib/resource-*`、reference-candidate-publish/review、generation-candidates/gateway | M6 pending；运行时确有传递依赖，不能把整个 scripts 当开发工具忽略 |
| 源码重建 | `/api/maintenance/build-web` → `npm run build` | M7 pending；这是开发功能，保留 Node/Vite 不等于发行包依赖 Node |
| 外部语音/模型服务 | PowerShell managed-webui/comfy、工作区 Voice Start/Stop、Python translate-zh-ja、ffmpeg、cloudflared | 调度迁 Rust；外部工具继续存在，不声称“所有进程纯 Rust” |
| trusted 桌面工具 | 显式开启后允许 node/npm/npx 等系统命令 | 保留操作员授权能力；不为支持任意系统工具而随包携带 Node |

完整 scripts 闭包为 **47 个 scripts/lib + 8 个 scripts/maintenance**，见 JSON `runtimeModules`。其中共享前端闭包有 20 个 `src` 模块；蓝图保存的条件 validator 额外引入 popularContent、promptCompiler、blueprint 决策和 Krea 配方等模块。前端实现仍保留；生产维护链对这些算法的运行时依赖必须移植/固定契约，不能留 `require(.ts)` 便宣称发行运行时已去 Node。2026-09-27 深入维护链时补齐该条件子进程边，初版 210 个模块的统计已被本次 225 个替代。

六个 npm 根依赖退役条件不同：Express/compression/proxy/ws 由 Rust HTTP/流式/WS 接管；sharp 与 onnxruntime-node 要分别完成解码/缩略/纹理/WD14 的等价验证。SQLite 是 `node:sqlite` 内建依赖，不出现在 npm 根清单中，但其 worker/schema/备份必须迁移。

## 建议接着独立移植的模块

优先完成 `server/buffered-request.ts` + `server/upstream-health.ts` 的本机上游传输与探活，再把其 pooled client 接到 Comfy/生成/控制路由。这一块不依赖 workspace 写入，接口小、调用广，可以直接为后续迁移提供实际复用点。

- `requestBuffered(target, {method, headers, timeoutMs, maxBytes, body}) -> {status, headers, body}`：总期限覆盖完整响应，按流累计大小，有界 buffer，截断/断流为错误；非 2xx 不在传输层一律报错。
- `requestJson(baseUrl, apiPath, body?, timeoutMs?, maxBytes?) -> {status,data,raw}`：有 body 用 POST，否则 GET；默认 4 s/8 MiB；无效 JSON 的 data 为 null。
- `pingSd`：`/sdapi/v1/sd-models`，200–499 可达；`pingTts`：`/docs` 网络异常时再试 `/`；`pingComfy`：`/system_stats` 严格 2xx；`pingOllamaDetail`：`/api/ps` 模型/VRAM，网络异常时 `/api/tags`。
- 依赖只有可复用 reqwest/Tokio client、URL、JSON 与字节流；本机 client 显式不走环境代理。池复用和并发探活可以减少反复建连，但性能收益应在同负载测量后报告。
- 公网自配接口的 `services/http-client.ts` / `public-upstream.ts` 后接：HTTPS、完整 DNS 结果公网校验、选定 IP 绑定、环境代理/NO_PROXY 和请求取消是独立契约，不应借上述本机 client 绕过。

建议只用模拟 HTTP 上游验证四种判定、超限和总期限，再复用真实请求黑盒用例；不为每个转发函数加镜像实现的单元测试。真实模型、音频、生产库、安装与完整运行时性能在当前盘点中均未执行。
