# Codex 执行手册

> 2026-09-26；配套[总计划](REFACTOR-EXECUTION-PLAN.md)。本文件为执行清单，不是已执行报告。R0 已完成，R1 实现与定向验收完成，R2 代码、隔离及 sidecar 门槛完成但未启用生产；原生安装/WebView2 未验。实际结果见 [R0 记录](R0-EXECUTION-REPORT.md)、[R1 记录](R1-EXECUTION-REPORT.md)、[R2 记录](R2-EXECUTION-REPORT.md)。R3–R13 仍待执行。

## 0. 接手规则：只读本批所需内容

首次读总计划、复审 A01–A14、本手册和 AGENTS.md；进入某批时再读对应规范及该批入口。不重新研究 Vue vs React、SQLite vs IndexedDB 或 Tauri vs Electron，不重做 005 已完成的布局/接口阶段。

先运行只读检查：

```sh
git status --short
git diff --stat
git diff --cached --stat
git fetch origin
git rev-parse origin/main
git rev-parse origin/docs/architecture-refactor-plan
```

审查基线为 `8939d9769501788482968eb6666a584adab739c1`。若 main 改变，先按本批文件做 diff 复核，不用旧 SHA 冒充当前基线。不能覆盖其他会话修改、git add . 或 reset --hard。

PR #10 未合并时，可以从其最新 head 建立独立 R0 分支/工作树并注明依赖 #10；不要为取得文档擅自合并 PR。计划合并后再对齐 main。后续代码批次不要继续写进纯文档 PR #10。

现有依赖和 lockfile 匹配时不重复安装。需要安装时先核对 `.nvmrc` / packageManager；执行安装、模型调用或桌面部署前遵守仓库授权边界。

## 1. 已存在的命令与使用时机

以下命令来自基线 package.json，不表示本次已经执行：

```sh
node --version
npm --version
npm run build:runtime
npm run typecheck:app
npm run typecheck:node
npm run typecheck:tests
npm run test:architecture
npm run test:monolith
npm run validate
```

`validate` 含 check、前端、Node 单元和契约入口；check 的 precheck 会构建运行时代码。R0 记录一次基线，之后按变更复验，不能每改一段文档都重新跑全部。基线存在失败要保留实际失败、原因和隔离证据，不扩大任务去修无关问题，不通过删断言/提高阈值制造 PASS。

可定向复用的已知入口：

```sh
npm run test:frontend -- src/application/artwork/saveGeneratedArtwork.spec.ts
npm run test:frontend -- src/storage/backupRestore.spec.ts
npm run test:frontend -- src/api/client.spec.ts src/api/client.refresh.spec.ts
npm run test:frontend -- src/composables/generation/useSDGenerate.spec.ts src/composables/generation/useSDGenerate-results.spec.ts
node scripts/tests/test-artwork-persistence-prototype.js
node scripts/tests/test-task-recovery-prototype.js
npm run test:backup
npm run test:storage-health
npm run test:gallery
npm run test:generation
npm run test:security
npm run test:gateway
```

Node 测试 `.js` 是构建入口/生成物，先完成 build:runtime；原型源分别是 `scripts/tests/test-artwork-persistence-prototype.ts`、`test-task-recovery-prototype.ts`。缺少生成物时检查构建清单，不手写同名 JS 掩盖问题。每个脚本执行前核对其当前隔离目录/端口和副作用。

集成阶段才使用 `npm run test:e2e:critical`、`npm run test:desktop-staging`、`npm run build:tauri`、`npm run package:tauri`。`test:desktop:native` 涉及真实 Windows/安装/设备子流程，不视为普通无副作用单测；先读工作流和 `scripts/tests/run-desktop-native-acceptance.ts`，选择获授权的阶段。`test:live` 不属于本轮默认命令。

文档检查入口：`npm run wf -- docs:check`。新增测试登记 `scripts/tests/quality-test-inventory.ts`，新增维护命令同时登记工作流；不要发明并不存在的 npm 脚本写入交付报告。

## 2. R0 — 基线与可执行约束

读取：AGENTS.md、engineering-contracts、workflow 的门禁选择、复审记录；代码只读本批依赖入口。

实施：

1. 记录 HEAD、lockfile、Node/npm 与当前验证状态，绘制 artwork / project / task 的读写与副作用图。
2. 在工程契约中明确：已接受任务属于 runtime；页面卸载取消订阅，未接受交互请求仍可取消。
3. 对迁移必需的适配作窄例外：真实 Web adapter 长期保留；旧数据格式 importer 有生命周期；不允许新增无限期 deprecated shim 或双写主库。
4. 基于现有架构测试增加依赖边检查。允许列表精确到 source、target、依赖种类、规则、退出批次；旧边只减不增，不能豁免整个 src/。
5. 行为约束如“卸载不取消已接受任务”在 R6 用测试证明；不要通过禁止所有 AbortController/onUnmounted 来伪造架构安全。

受控文件：`docs/engineering-contracts.md`、必要的 AGENTS.md 窄修订、现有架构测试入口、测试 inventory、重构证据。新增测试名在实现时登记，不改生产运行路径。

Gate：新增合法/非法依赖夹具能分别通过/失败；注释、类型导入、unsubscribe 不被误报；基线问题与本次回归分开记录。

## 3. R1 — 收口已有仓储与最小 bootstrap

状态：实现与定向验收完成，含 7 项隔离 E2E 与最终类型/lint；原生安装/WebView2 未验。实际接线和保留的失败记录见 [R1 实施记录](R1-EXECUTION-REPORT.md)。

读：[Workspace 1–3 节](WORKSPACE-MIGRATION-DESIGN.md)、[Desktop 3–4 节](DESKTOP-INTEGRATION-DESIGN.md)。

现有入口：`src/storage/artworkRepository.ts`、`src/application/artwork/saveGeneratedArtwork.ts`、`artworkSaveInput.ts`、`src/composables/prompt/persistPromptArtwork.ts`、`src/stores/promptHistoryStore.ts`、`src/utils/desktopImport.ts`、`src/api/client.ts`、Rust `bridge.rs/main.rs`。

交付：收口作品列表/保存/删除/项目关系的实际调用点，使用已有注入点；定义 Web/desktop 的具体业务能力与 wire DTO。保留 Web 的锁、提交未知保护、回收站、Blob 生命周期。最小桌面 bootstrap 提前落地，但不打开私人库或改变页面来源。

禁止：把 `kvSet(history, wholeArray)` 原样搬成 HTTP 全量覆盖；新增一个无人使用的 Repository 接口就标完成；同时新建五个空仓储；改变 ID/历史字段/自动入册语义。

测试：保存用例、backupRestore、client、桌面 bootstrap 正反权限夹具、架构/typecheck。Gate：旧路径行为不变，实际消费者可替换，Web 不依赖 Tauri。

## 4. R2 — Workspace 内核与受保护 API

状态：代码、隔离测试及实际 sidecar 门槛完成，默认关闭、未启用生产；不是完整 NSIS 安装/WebView2 验收。实现边界、当次结果与过程修复见 [R2 实施记录](R2-EXECUTION-REPORT.md)。

建议新增生产文件归入 `server/workspace/`，路由按当前 server/routes 组织；worker 是该目录内的实际 TS 源，不导入 `scripts/tests/prototypes`。

交付：单写者、schema、media staging、稳定 operationId、revision、受保护的领域 API、backup/restore 候选、storage worker 和实际包内加载探针。优先复用原型断言，不复制其 any 类型和简化故障假设。

测试：规范中的保存中断矩阵、双进程竞争、锁残留、未知提交、权限、GC 引用和一致备份；typecheck、runtime build、desktop-staging。Gate：隔离目录全部通过；SQLite/worker 必须在实际 sidecar 通过，不能仅在开发 Node 可用。

R2 可分内核与 API 两个 PR；默认不启用生产迁移。

## 5. R3 — 旧来源桥接、完整清单与迁移器

入口：useKVStore/useImageStore、storageKeys、backupRestore、desktopImport、chatArchiveRepository、videoStore；桌面 paths 与受管窗口协调。

交付：按来源/领域盘点、维护屏障、游标/分块导出、MigrationEnvelope、备份、候选导入、幂等检查点和校验报告。旧 UI origin 保持不变；升级路径须能够先运行桥接流程。

测试：相同源重复导入、源变化、中途退出、磁盘满、缺图、损坏、回收站/临时图、未知键/凭据、旧端口被占用、同 profile 与新 profile 区分、多窗口同时写入。

Gate：在复制的 WebView profile 和隔离 workspace 中完整往返通过；没有真实数据激活。普通备份不能替代全量迁移包。

## 6. R4 — 作品域 authority 激活

入口：仓储装配点、workspace-active 指针、迁移协调器、桌面启动、版本/权限握手。

交付：旧 origin 的 UI 改走 runtime 作品库，旧作品 IDB 保留只读；错误不能自动回落到旧库写入。未迁移的设置/聊天继续明确归旧来源，不能假装整个 profile 已迁移。

Gate：端口变更作品不变、多窗口并发修订冲突可解释、私人库不向隧道开放；激活前、激活后零写入、激活后有新写入三种回退分别演练。

真实数据切换之前必须获得对应授权并有实际备份与恢复证据。代码通过但未实际迁移时只记录“可激活”，不能写“用户数据迁移完成”。

## 7. R5 — Durable ledger 与恢复内核

读：[Task 1–5 节](TASK-RUNTIME-DESIGN.md)。入口：`server/job-runner`、`server/job-snapshot.ts`、`server/generation/service.ts`、workspace；复用 `scripts/tests/prototypes/task-recovery.ts` 的协议边界和对应测试。

交付：稳定 principal/requestKey、唯一约束、接受前落账、provider 身份、取消意图、结果状态、重开对账及准入保护；SQLite 是生产权威，不再额外创造一个同等权威 JSONL 日志。

测试：假 provider 注入全部应答丢失/乱序/崩溃点，验证恢复器不调用 submit。Gate：未知状态不重复生成、不释放未确认执行槽，不泄露其他 principal 的任务。

## 8. R6 — 逐 provider 接入

分四个受控子批：

- R6a WAI/WebUI：generation/service、webui、useSDGenerate；保留全局 interrupt 屏障。
- R6b Comfy/Anima/Krea：anima/service、现有共享 Comfy 链路与 useAnimaSession；持久化 prompt_id 和输出身份，不改工作流字段。
- R6c 单视频：video/service 与 videoStore；保留已有重连，补 durable 输出和运行时身份。
- R6d 分镜批次：video/batch；逐镜依赖/尾帧/拼接 checkpoint 分开实现，重启默认不推进下一镜。

每批交付一个完整纵向链路，不在同一 PR 同时重写所有状态机。测试提交/取消/结果/切页/失联/重开；关键生成输入与旧链路逐字段对照。Gate：正确释放页面资源，但不因其卸载取消任务；旧路由与新入口不会各执行一次。

## 9. R7 — Task Center 与结果收件箱

入口：`src/composables/useTaskCenter` 对应实现、`useDrawingTaskTracking.ts`、videoStore、保存用例、任务查询 adapter。

交付：runtime 查询作为事实，旧摘要只作历史展示；输出先可靠保存再呈现可下载；保存到作品册是独立的幂等用例。

Gate：切页/刷新后同一个任务可找回；自动入册关闭时不新增作品；重复取图/入册不会重复生成/重复写入；空间不足先停止新准入而不是清除未交付结果。

## 10. R8 — 完整类型化桥接与连接/资源层

读：[Desktop 1–5 节](DESKTOP-INTEGRATION-DESIGN.md)。入口：`src/platform/`、api/client、直接 fetch/resultUrl 消费者、Rust shim/bridge/main/main_shared、tauri.conf。

交付：最小 bootstrap 扩展成完整窄能力，runtimeEpoch、会话、来源/角色授权、URL resolver、媒体 Range/短期 capability、重连和跨窗事件。仍保留旧 UI origin。

测试 client 的已有取消/缓存契约；所有 URL 类别、非法来源、分享 token、错误窗口、过期会话、端口更换与迟到响应。

Gate：真实三个窗口在旧来源下使用新 adapter 正常；不新增业务全局 shim，不靠通配 CORS/CSP 修复问题。

## 11. R9 — 剩余 profile 迁移与 bundled UI

R9a 先补设置/聊天/草稿的实际领域 adapter 和最新迁移快照；复用现有 codec 与 tombstone，不对初次导出的旧设置盲目重放。所有持久来源都完成分类和保留才能继续。

R9b 再改桌面构建模式、hash router、路径编码、bootstrap 建窗顺序与原生来源信任。Web 构建/路由保持原语义。

入口：Vite/router 装配、现有桌面 prepare/staging 脚本、tauri.conf frontendDist、Rust main/main_shared/paths、各 URL/角色消费者、设置和聊天仓储。

Gate：没有 Vite/开发仓库兜底的安装产物可运行；runtime 未启动时 UI 可开诊断；重启不整页刷新；数据与深链/三个窗口/原生功能通过真实 WebView2 验收。未满足时不切换新 origin。

## 12. R10 — 前端模块与查询整理

只整理已接入的 artwork/generation/platform 纵向链路，不全仓搬家。Pinia 留编辑/展示状态；持久事实在 runtime。保留原 use case 和共享组件的合理边界。

新增查询库需要实证重复职责和一个可回退纵向试点；同时替换旧 TTL/轮询对应责任，保留响应代际测试。没有必要时不加依赖，也不影响 R0–R9 验收。

Gate：核心用例不依赖 Vue/Tauri；页面可用 mock 能力测试；没有两套缓存/两套可写事实和循环镜像 watch。

## 13. R11 — 退役与发布验收

按实际消费者移除旧桌面 shim、旧作品写路径和迁移期边例外；Web adapter 继续保留。migration reader 的保留由支持的升级跨度决定，不因一台机器成功就删除其他用户仍需的升级入口。

Gate：全量验证、关键 E2E、打包/安装/恢复/回退通过；主力机证据单列。用户源数据和备份不随代码清理自动删除。记录最终版本兼容矩阵和仍支持的迁移来源。

## 14. R12/R13 — 独立实验，不阻塞主线

R12 原生 renderer process 对照当前线程；R13 Electron shell 对照 Tauri。使用同一内容、构建、设备、测量方式，比较可靠性与完整产品成本。没有预设胜者，不把 PoC 代码自动加入生产。

它们不是 R0 必须先跑的基准；60/120/165 FPS、DPI、显存和多显示器放在实际涉及渲染的验收中。

## 15. 每批交付格式与停止条件

每批保留一份短证据，示例字段不是已经取得的结果：

```json
{
  "batch": "R0",
  "baseCommit": "<actual>",
  "headCommit": "<actual>",
  "changedPaths": [],
  "environment": {"node": "<actual>", "npm": "<actual>", "platform": "<actual>"},
  "checks": [{"command": "<actual>", "status": "not-run", "exitCode": null, "evidence": null}],
  "productionDataTouched": false,
  "nativeAcceptance": "not-run",
  "blockers": [],
  "nextBatch": "R1"
}
```

允许状态 passed/failed/blocked/not-run；日志需绑定提交和依赖环境。相同内容的已验证结果可复用，后续只重跑受影响项；不能把一次独立通过重命名为整套门禁通过。

停止当前激活、不阻塞无关安全工作：源不可读取/完整性不明、schema 不兼容、并发写者无法排除、权限回归、旧数据转换有损、测试实际调用生产资源。保留结果并修正该门槛，禁止清库/删断言/忽略失败继续。

每次结束仅交代本批改动、实际验证、未验证项和下一批入口；不要重复输出整个方案。

## 可直接交给 Codex 的第一条任务

> 阅读 AGENTS.md、重构总计划和本手册 R0。先核对实际 main/head 与审查基线差异，只复查本批受影响假设。不要重新做框架或数据库选型研究。本轮仅完成 R0：记录基线、更新窄工程契约、建立可逐步收紧的依赖护栏和测试。保留旧边但禁止新增违规边；不执行真实数据迁移、不切 origin、不启动真实模型、不安装桌面产物。根据实际命令报告 passed/failed/blocked/not-run，不把本文档或旧原型的 PASS 当作新验收。R0 交付后停止，列出 R1 的受控文件与阻塞项。
