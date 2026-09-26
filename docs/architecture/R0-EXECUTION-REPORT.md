# R0：基线与依赖护栏实施记录

> 2026-09-26；范围仅为 [执行手册 R0](CODEX-EXECUTION-RUNBOOK.md#2-r0--基线与可执行约束)。本批不改生产运行路径，不包含 R1 实现、真实迁移、来源切换、模型调用或桌面安装。命令、环境和原始日志绑定见 [机器可读证据](../evidence/architecture-r0-2026-09-26.json)。

## 基线与审查差异

- 设计审查基线：`8939d9769501788482968eb6666a584adab739c1`。
- 本轮开工 HEAD / `origin/main`：`61604ec6dafa4118a83f6bc30a2824de27aceef5`；`origin/docs/architecture-refactor-plan`：`a1e08e2b07074474d3b784f907e9ac35226c3d21`。写入前 `git status --short`、`git diff --stat` 与 `git diff --cached --stat` 均无输出。
- 审查基线到开工 HEAD 仅新增/更新架构文档、文档索引，以及 `.github/workflows/quality.yml` 中 Browser Regression (Critical) 的 CI 超时由 20 分钟改为 35 分钟；没有生产源码变化。本轮复用 A01–A14 的设计判断，同时直接核对下表当前调用点，未重新进行框架或数据库选型。
- 实测 Node `24.18.0`、npm `11.16.0`；`package-lock.json` SHA-256：`302ed273761e76cd239cada37b1d5c4b552e580e09b1c2a6ed351a9bacf50df4`。最终变更身份和逐命令日志记录在机器可读证据中。

## 当前读写与副作用图

| 领域 | 当前入口与流向 | 真实副作用及本轮边界 |
| --- | --- | --- |
| artwork：保存 | `persistPromptArtwork` → `saveArtworkSnapshot`（显式注入）→ `imgPut` / 缩略图 KV / `artworkRepository.appendArtwork`；桌面文件导入经 `desktopImport.importLocalImages` | 先保存图片再追加记录；回执未知按作品身份读回，仍不明时保留图片。暂存锁、缩略图 best-effort 与失败补偿属于现有 Web 行为，R0 不修改 |
| artwork：查询与旧格式读取 | `promptHistoryStore.loadHistory`、`galleryStorage.loadGalleryStorageAction`、`HomeView`、`useSceneExplorerWorkspace` → KV；部分入口也读旧 localStorage | Gallery/Home 读取可触发旧数据写入 KV 并移除旧 localStorage 键，不能把它们当作纯查询；场景页从历史构造偏好。R1 收口实际消费者，迁移 importer 按支持来源保留 |
| artwork：媒体、删除与恢复 | `useGalleryWorkspace` → `imgGet` / thumbnail KV；`galleryMutations`、history store、`useGalleryTrash` → Repository | 页面拥有 Blob URL；正常删除写回收站并摘项目引用，恢复补回增量关系；过期懒清理才真删图，并保护 history、project、trash、quarantine、local/session 草稿引用 |
| project：读取与关系 | `promptHistoryStore.loadProjects`、`galleryStorage` → 统一项目 KV，必要时读取旧 `aics_projects`；Repository 软删/恢复 → 项目 `history_ids` | 软删/恢复把 history、project 引用、trash 纳入相关记录事务；`appendArtwork` 不自动新增项目关系。不能把整数组 KV 写入机械搬成 HTTP 全量覆盖 |
| task：SD / Anima / Krea | `useSDGenerate` → `generationApi` → `apiClient`；`useAnimaSession` → `apiClient`；runtime → provider | 当前页面卸载和部分客户端超时会向已接受任务发送 DELETE；结果获取后由页面持有 Blob URL。此行为仍在，R6a/R6b 才改任务所有权并逐 provider 验收 |
| task：视频与分镜 | `videoStore` → sessionStorage 的 jobId/batchId；视频页按身份重连；`prepareVideoCtx` → fetch / `imgPut` | 已有跨页恢复身份必须保留。单视频与分镜 checkpoint 分属 R6c/R6d，不把分镜当单任务套用；跨页交接图和草稿不等于 durable 输出 |
| task：摘要和运行时账本 | `useDrawingTaskTracking` → `useTrackedTask` → KV 摘要；runtime registry → `job-snapshot` JSON loss ledger | `useTrackedTask` 卸载仅标 interrupted、清控制句柄，不取消 provider。loss ledger 仅说明重启中断，不重提执行；视频启动现有孤儿 prompt / 旧媒体清理须在 R5/R6 复核，不能将其称为 durable recovery |

## 本轮契约与护栏

[工程契约](../engineering-contracts.md#重构期间的任务与持久化边界)明确已接受任务归 runtime，页面只订阅和释放资源；尚未接受请求可取消，未知接受不自动重提。Web adapter 长期合法；旧格式 importer 必须有支持范围和退出条件；不新增无限期兼容垫片、双写主库或 runtime 出错后写回旧库的 fallback。这是目标约束，SD/Anima 的现有卸载取消行为仍待 R6 验证和修改。

护栏实现为 `scripts/lib/refactor-boundaries.ts` 与 `refactor-allowlist.ts`，接入既有 `scripts/tests/test-domain-type-boundaries.ts` 架构入口；`test-refactor-boundaries-fixtures.ts` 登记到现有 unit inventory。既有纯领域可达图的 application 入口扩展为全部 application roots。未新增生产抽象或维护命令。

| 规则 | 受保护的依赖方向 |
| --- | --- |
| `browser-storage-port` | 应用消费者经业务边界访问浏览器存储；既有直接依赖按精确旧边管理 |
| `application-no-infrastructure` | application 用例不反向依赖具体存储、传输、框架和宿主实现 |
| `runtime-no-frontend` | runtime 不反向依赖前端源，类型边也需迁出；现有两条纯类型旧边单独登记 |
| `production-no-test-dependency` | 生产模块不导入测试或原型实现 |
| `desktop-capability-boundary` | Tauri/桌面能力保持在桌面适配边界内 |
| `web-no-desktop` | Web 实现不加载桌面能力；递归追踪经过中间模块和 barrel 的路径 |

解析复用 `sourceDependencies` 的 AST，区分 `import`、再导出、动态加载、`require`、TS import-equals 和 type-query，并按 TypeScript 真实路径解析 Vue SFC 与 barrel。注释不构成依赖。类型依赖与运行时依赖分别记录；例如 `useDrawingTaskTracking → useSDGenerate/useAnimaSession` 是纯类型边，而 `routes/voice.ts → src/types/api.ts`、`routes/resources.ts → src/types/resources.ts` 即使是类型导入，也属于已登记的 runtime 反向旧边。

`scripts/tests/refactor-boundary-allowlist.json` 精确登记 33 条旧边，每条包含 source、target、依赖种类、规则和退出批次。`refactor-boundary-seed.json` 封存初始集合并固定哈希；检查同时对照 Git HEAD、CI PR base 或 HEAD^ 的已有集合，使删除后的例外不能重新加回。旧代码边删除时必须同步删除允许项，不允许靠保留无消费者豁免扩大后续空间。

真实 Web 存储实现 `src/storage/artworkRepository.ts`、`backupRestore.ts`、`chatArchiveRepository.ts` 的现有适配接线精确合法，未来 `src/platform/web/` 中的真实 Web 实现也属于合法平台能力，不是旧边豁免。没有豁免整个 `src/` 或所有 storage 文件。既有纯领域可达依赖规则与合理的 `server/generation/service → routes/anima/service` 服务复用继续保留。

护栏只检查声明的依赖及明确规则，不证明全部副作用、动态浏览器行为或间接全局能力使用安全。`window` 上的旧桌面全局桥、任意计算属性/eval 加载、Rust invoke 授权、媒体 URL 和真实窗口生命周期不由 import 边扫描覆盖；它们留给 R8/R9 的类型化桥接、安全夹具和原生验收。静态检查不禁止所有 `AbortController` / `onUnmounted`，也不把正常 unsubscribe 视为取消任务。`src/platform` 在基线尚不存在；R0 没有创建空 adapter 或启用窄桥接。

## 实际验证与限制

基线检查先于本次正式代码写入完成，以下结果不能代替改动后的定向验收。本批生产源码与依赖内容未变，因此复用同内容的前端 1,423 项、Node 1,097 项、contract 36 文件及前端构建证据；对新增护栏、测试和文档执行下列定向复验，未重复运行最终全量 check 或 validate。

| 基线检查 | 状态 | 结果 |
| --- | --- | --- |
| `npm run build:runtime` | passed | 原始运行时代码构建通过 |
| `npm run test:architecture` / `npm run test:monolith` | passed | 原始架构与单体预算检查通过 |
| `npm run build` | passed | 原始前端生产构建通过 |
| `npm run validate` | failed，exit 1 | check 共 21 项中的 2 项因 2,534 个参考素材文件缺失失败；未改变素材模式。内部 app、node、tests、browser-tools typecheck 均通过；后续 suite 因 `&&` 未由本次 validate 执行 |
| 独立 `npm run test:frontend` | passed | 203 个文件，1,423 项测试通过；不重命名为 validate 通过 |
| 独立 Node unit | passed | 1,097 项测试通过；独立执行记录见机器可读证据 |
| 独立 contract suite | passed | 36 个文件通过；独立执行记录见机器可读证据 |

| 改动后定向验收 | 状态 | 结果 |
| --- | --- | --- |
| 最终 `npm run build:runtime` | passed | 正式构建通过，包含 strict Node / tests 编译检查 |
| 新依赖规则与既有领域边界夹具 | passed | 合计 63 项通过：新增 48 项、既有 15 项；覆盖合法/非法依赖、纯类型、注释及正常资源释放等边界 |
| 最终架构依赖图 | passed | 665 个生产/可达文件、3,203 条边、33 条精确旧边，unknown 为 0；纯领域可达图覆盖全部 application roots |
| 最终 `npm run test:check` | passed，exit 0 | 补齐证据文件后完整重跑，20 个文件全部通过，包含 architecture、monolith、生成物与类型/构建相关检查 |
| 定向 ESLint | passed | 本批受影响脚本检查通过 |
| `npm run wf -- docs:check` | passed，exit 0 | 227 个文件、1,659 个本地链接，broken 为 0 |
| 集成中间态 `npm run check` | failed，exit 1 | 保留原始参考素材的两项失败；另因证据 JSON 当时尚未写入导致 test:check 的文档断链。补齐后已完整重跑 test:check 通过；该次 check 的其他步骤（包括 app/typecheck/lint）已通过，未重跑最终全量 check |
| 真实模型、生产数据库、来源激活、Windows 安装/原生窗口 | not-run | 本轮 R0 未执行，也未由静态测试证明 |

参考素材位于不入 Git 的资产域，缺失是本机基线限制；本轮不生成 pending 占位、不改断言或阈值制造 PASS。中间态证据文件缺失是本次集成问题，已补齐并通过完整 test:check 复验；它与原始素材失败分别留痕。最终定向检查通过不覆盖原始 validate 或中间 check 的失败，也不代表最终全量重新运行。实际命令、退出状态、日志和最终变更身份见机器可读证据。

## R1 接续边界

下批先读 [Workspace 1–3 节](WORKSPACE-MIGRATION-DESIGN.md) 和 [Desktop 3–4 节](DESKTOP-INTEGRATION-DESIGN.md)，围绕真实调用点收口，不只新增无人使用的接口。

- 现有保存/仓储装配：`src/storage/artworkRepository.ts`、`src/application/artwork/saveGeneratedArtwork.ts`、`artworkSaveInput.ts`、`src/composables/prompt/persistPromptArtwork.ts`、`src/stores/promptHistoryStore.ts`、`src/utils/desktopImport.ts`。
- 不能漏掉的查询/项目/媒体消费者：`src/composables/gallery/galleryStorage.ts`、`galleryMutations.ts`、`useGalleryWorkspace.ts`、`useGalleryTrash.ts`、`src/views/HomeView.vue`、`src/composables/scene/useSceneExplorerWorkspace.ts`；备份/恢复入口 `src/composables/useBackup.ts`、`src/storage/backupRestore.ts` 须按接口影响复核。
- 最小 bootstrap：`src/api/client.ts`、Rust `desktop-tauri/src-tauri/src/bridge.rs` / `main.rs` 及实际新建的窄平台能力装配点；不打开私人库，不改变页面来源，Web 不依赖 Tauri。
- 保留现有锁、未知提交保护、软删/回收站、Blob 所有权、ID/历史字段和默认不自动入册；复用保存、backupRestore、client 等行为测试，新增 bootstrap 正反授权夹具。

本轮在 R0 停止。参考素材缺失阻塞全量 validate 通过；真实 profile 可读取、备份/恢复、sidecar SQLite/worker、原生窗口和生产激活证据尚未取得，不能提前声称 R2–R9 gate 已满足。本批新增护栏定向验收已通过，R1 可按上述受控范围接续；本轮未提前执行 R1。
