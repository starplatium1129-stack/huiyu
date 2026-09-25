# 重构计划复审：代码事实、修正与复用

> 2026-09-26；源码基线 `8939d9769501788482968eb6666a584adab739c1`，原计划 `188d9b6e3b13ab5dba64436f6e326e60be98bea6`。本次是源代码与设计审查，不是生产实现或 Windows 实机验收。
> 执行入口：[重构总计划](REFACTOR-EXECUTION-PLAN.md)。后续代码与基线不同，只复核受影响的假设，不重新开展全仓研究。

## 结论

方向成立，原来的 191 行提纲不能直接作为数据库、任务与桌面入口的施工规范。此次补充的是协议、依赖顺序、真实复用入口和失败时停止条件，不是把所有问题再交给 Codex 选择。

保留 Vue、Tauri、Node；优先实现稳定的桌面作品库、运行时任务身份及本地 UI。SQLite 不以“必然更快”为理由采用，而是作为独立于浏览器来源的结构化数据权威。完整离线库、独立渲染进程和 Electron 迁移不混入这一轮的强制验收。

## 必须修正的设计

| ID | 原计划缺口 | 修订决定 |
| --- | --- | --- |
| A01 | 先提交数据库，再提升媒体文件，可能发布缺少原图的作品 | 先落持久操作意图，再写入、校验、提升不可变媒体，最后事务发布作品、引用和操作回执；未知提交只查账，不删图 |
| A02 | runtime 是唯一存储入口，却承诺 runtime 停机时完整浏览全部作品 | 降级时保留 UI、草稿和已加载缓存；未加载作品和冷启动完整库等待服务恢复。不偷偷增加 Rust 第二数据库入口 |
| A03 | 迁移只覆盖 history/projects/images | 补充回收站、隔离区、聊天、设置、草稿、临时图片和跨窗口状态分类；迁移包不等于普通备份 |
| A04 | 没有说明如何从旧来源读 IndexedDB | 旧来源桥接版本、同一 WebView 用户配置、维护屏障、按来源清单导出；端口被陌生程序占用时禁止导航过去或扩大 IPC 权限 |
| A05 | feature flag 被当作完整回滚方案 | 按是否切换、是否产生新写入区分回滚；新库已有写入后不能直接切回旧快照 |
| A06 | 将所有引擎当作同一种页面局部任务 | SD/Anima 改所有权；视频保留现有按 ID 重连；批次恢复单独处理逐镜依赖和拼接状态 |
| A07 | 成功、结果取回、作品入册混为一谈 | 分开执行状态、结果持久化状态、入册状态。自动入册默认关闭，不以持久任务之名偷偷改变产品行为 |
| A08 | 只持久化 status，忽略上游接受但应答丢失 | 先落账再发请求，稳定幂等键、上游身份、取消意图和结果引用；未知接受状态绝不自动重提 |
| A09 | 类型化桥接安排在切换桌面来源之后 | 最小 bootstrap 随 R1 提前；完整桥接与 transport 在新版 R8；本地 UI 在新版 R9，不能颠倒 |
| A10 | 新服务端作品 API 可能被原来的隧道分享凭据访问 | 桌面私人库单独认证与授权；共享网关 token 不获得作品库、迁移、备份和私人任务列表权限 |
| A11 | 从零设计 ports、SQLite 和恢复实验 | 复用已有 repository 注入点、保存用例、7 项迁移原型测试和 19 项恢复原型测试；原型不直接作为生产模块导入 |
| A12 | 一开始禁止所有旧依赖，与仓库规则冲突 | R0 登记精确旧边并只减不增；允许数据格式迁移所必需的限期适配，不允许无期限 deprecated shim |
| A13 | 直接引入查询库，未考虑已有请求缓存 | 首先复用现有 client 的去重、代际与消费者隔离；不叠加第二套缓存。新增查询库不是核心重构前置条件 |
| A14 | 假设新 TS 文件、worker、共享类型会自动进入桌面包 | 明确源码/生成物、类型编译边界、worker 路径与安装包验证；以实际 sidecar Node 运行探针，不靠开发机版本推断 |

## 已核对的代码入口

以下路径和符号基于上述固定提交；行号可能随实施变化，因此交接优先使用符号名。原始代码可通过 `git show 8939d976:<path>` 复核。

### 数据与保存

- `src/storage/artworkRepository.ts`：`createArtworkRepository` 已有 KV / image adapter 注入、串行化、相关记录事务、软删除与恢复；不是尚未建设仓储层。
- `src/application/artwork/saveGeneratedArtwork.ts`：`saveArtworkSnapshot` 已保护提交回执未知场景，按作品身份读回；不能因调用失败直接删原图。当前 operationId 尚不足以构成运行时持久幂等协议。
- `src/composables/prompt/persistPromptArtwork.ts`、`src/stores/promptHistoryStore.ts`：仍有绕过仓储的 KV / image 读写，R1 要收口实际消费者，而不是只加接口文件。
- `src/composables/useImageStore.ts`：图片库为 `aics_image_store`，对象仓库 `images`；`imgList()` 全量读取 Blob，不适合作为大库迁移的内存策略。
- `src/utils/storageKeys.ts`：普通备份刻意不含回收站、隔离区、部分会话状态；`AUTO_SAVE_TO_GALLERY_KEY` 对应默认关闭自动入册。重置 tombstone 不能从旧备份复活。
- `src/storage/chatArchiveRepository.ts`、`src/storage/backupRestore.spec.ts`、`src/utils/desktopImport.ts`：聊天、恢复和桌面导入也是迁移/权限变更的消费者，不可只验保存按钮。

### 任务与请求

- `src/composables/generation/useSDGenerate.ts`：`dispose()` 调用 `cancel()`；客户端超时会放弃已接受任务；结果仍经直接 `fetch(job.resultUrl)` 获取。
- `src/stores/videoStore.ts` 和 `VIDEO_TASK_KEY`：视频已保存任务身份，用于离页后重连；不能重复开发后反而丢掉此能力。
- `server/generation/service.ts`：共享准入预算、WebUI 串行队列、终结后保留窗口已存在。WebUI 必须等当前执行与全局 interrupt 都结束，才能开始下一项。
- `routes/anima/service.ts`、`routes/video/service.ts`、`routes/video/batch.ts`、`server/job-snapshot.ts`：现有持久化是中断账本，不是可重新执行的任务日志。
- `src/api/client.ts`：已有 GET 去重、每个消费者独立取消、缓存代际、显式 refresh/bypass 和响应隔离。transport 改造必须保留这些测试约束。

### 桌面与安全

- `desktop-tauri/src-tauri/src/main.rs`：恢复网关后对三个窗口重新导航；自定义 invoke handler 只信任当前已认证网关来源。本地资源入口不能只改 URL 而不改授权。
- `desktop-tauri/src-tauri/src/paths.rs`：配置根、gateway runtime、模型工作区和安装资源根是不同概念；不能把私人作品库放到模型目录或安装包资源目录。
- `desktop-tauri/src-tauri/tauri.conf.json`：`frontendDist` 当前为 `../web`，程序手动建窗，实际网关资源另行打包。必须验打包产物，而非仅让 Vite 开发服务可用。
- `src/utils/runtimeEnvironment.ts` 与 `server/security.ts`：已经识别 Tauri 本地来源；不要误报为缺失，也不要改成“存在桌面全局对象就授权”。服务端仍需拒绝转发/远程请求。
- `server/config.ts`：持久网关 token 用于现有网关访问；这不是私人 workspace 的授权模型。`AI_WORKSPACE_ROOT` 属于模型资源，`RUNTIME_ROOT` 属于运行数据。

### 构建与规则

- `.nvmrc` 固定 `24.18.0`，`package.json` 声明 `npm@11.16.0`，Node engines 下限则更宽；三者不能混为同一个实测运行版本。
- `scripts/build-node.mts` 是现有构建入口。修改 `.ts` 源，不手改生成 `.js`；新增 worker 和测试需被现有构建、测试清单收录。
- `tsconfig.runtime.json` 的 services 根目录边界不同于 `tsconfig.node.json`；不要为了共享几个 DTO 让 services 运行时反向依赖整个 src。
- `AGENTS.md`：500 有效行限制、受控文件提交、旧豁免只减不增、真实数据和设备验收规则继续有效。

## 已有成果的复用与覆盖关系

`plans/005-desktop-architecture-consolidation.md` 的布局与接口阶段已经实施，不重新做。其 C/D 中“本轮只评估”的约束属于旧任务范围；当前用户已授权准备生产重构设计，因此本计划替代其后续存储/任务选择，但不覆盖它的安全边界或伪造新测试结果。

复用入口：

- `scripts/tests/prototypes/artwork-sqlite.ts`：已有 Node 内置 SQLite、媒体内容寻址和先媒体后元数据的隔离原型。
- `scripts/tests/test-artwork-persistence-prototype.ts`：已有迁移中断、重复执行、源变化和损坏等测试。正式实现需要补生产单写者、恢复、权限和部署条件。
- 005 的任务恢复原型与故障矩阵：按其引用定位当前 `.ts` 源，保留无自动 submit、取消意图、后端指纹和结果交付边界；历史“19 项通过”不是本轮通过。
- 既有作品保存、图片回收、双窗口事务、任务结果和网关安全测试：变更实现而保留行为断言，不重写一套只检查源代码字符串的新测试。

`plans/architecture-evolution.md` 已完成的类型和保存用例仍然有效。本计划不重置那些完成状态，也不把旧计划内与本任务无关的事项加入关键路径。

## 本次证据与限制

本次实际完成：读取固定源码和原计划、核对 PR/main、识别上述设计冲突、明确默认方案和逐批验收。

本次没有完成：仓库本地构建、npm 全量测试、原型重跑、Windows/WebView2/Cubism/DPI 测试、真实数据库扫描、安装或升级。所有实施批次仍为待执行。

需要目标环境证明的关键条件已变成硬门槛，而不是模糊 TODO：旧 WebView 配置来源可读取、SQLite sidecar 可运行、同库单写者、故障恢复与备份有效、本地 UI 资源/媒体/权限正常。失败时保留旧来源与原数据，停止激活，不用新空库掩盖失败。
