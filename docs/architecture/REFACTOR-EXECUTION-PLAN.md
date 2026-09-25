# HUIYU 架构重构执行计划

> 2026-09-26。目标优先级：长期正确性、可靠性、可恢复性、清晰边界；不以“重构麻烦”为保留次优架构的理由。

## 最终目标

1. 作品/项目不依赖 WebView origin 或 localhost 端口。
2. 长任务不依赖 Vue 页面生命周期；切页只取消订阅，不取消任务。
3. runtime/gateway 重启时桌面 UI 不消失、不整页刷新。
4. 桌面业务数据只有一个权威来源。
5. 桌面能力通过类型化接口暴露，业务组件不直接知道 Tauri command、shim 或动态端口。
6. 重启后可 reconciliation；无法证明状态时标记 unknown/interrupted，禁止盲目重提 GPU 工作。
7. Web 版继续可用，但其 IndexedDB adapter 不限制桌面架构。

## 目标架构

```text
Vue 3 UI
├─ feature modules
├─ Pinia：draft / selection / UI state
├─ query/cache：可重新获取的 server state
└─ platform capabilities
        │
Tauri/Rust host
├─ bundled UI / windows / tray / updater / credentials
├─ runtime supervision
└─ native rendering supervision
        │
Node/TypeScript application runtime
├─ generation/video/voice orchestration
├─ durable task ledger + reconciliation
├─ artwork/project/task repositories
└─ engine adapters
        │
Workspace
├─ SQLite：结构化记录
└─ filesystem：原图/视频/派生媒体
```

权威所有权：编辑临时状态归 Vue；作品/项目/任务归 runtime+workspace；媒体归 workspace filesystem；窗口/更新/系统凭据归 Tauri；Live2D 原生状态归 renderer supervisor。禁止双主。

## 非目标

本轮不默认做 Vue→React、Tauri→Electron、Node→全 Rust，也不为目录漂亮做无行为收益的搬家。Electron 和独立 Live2D renderer process 放到后期用数据做 PoC 决策。

# Phase 0 — 基线与安全网（P0）

- 新增 ADR：workspace storage、task ownership、desktop UI origin、platform capability、native renderer isolation。
- 扩展 architecture tests：application/domain 禁止依赖 Tauri global；desktop adapter 外禁止散落 invoke 字符串；runtime repository 禁止依赖 Vue/Pinia；桌面持久化禁止新增 IndexedDB；页面 unmount 禁止作为默认 cancel。
- 记录 baseline：冷启动、网关恢复、空闲内存、切页任务行为、网关崩溃、端口冲突、100/500/2000 作品读取、Live2D 60/120/165 FPS。

**Gate：** baseline 可重复，关键现状有测试保护。

# Phase 1 — Workspace v2（P0，最高优先级）

先定义 ports：ArtworkRepository、ProjectRepository、SettingsRepository、TaskRepository、MediaRepository。application use case 只依赖接口；Web 可继续 IndexedDB adapter；Desktop 指向 runtime/workspace。

推荐：
```text
workspace/
├─ huiyu.sqlite3
├─ media/images
├─ media/videos
├─ media/derived
├─ runtime
└─ backups
```

SQLite 至少覆盖 schema_version、artworks、projects、project_artworks、tasks、migration_state 与非敏感业务设置；credential 继续系统安全存储。

SQLite 与媒体文件不是同一事务。作品写入必须保留现有 staging/compensation/commit-unknown 思想：临时媒体→校验/fsync→DB transaction→原子 promote→recovery marker/启动恢复。

### IndexedDB 迁移

旧 origin 读取→migration manifest→导入 workspace→校验数量/ID/hash/size/项目引用→标记完成→保留旧库兼容期→再切 authority。

要求：幂等、可续跑、失败不宣称完成、迁移前备份。

**关键验收：** 3000 创建作品→关闭→占用 3000→桌面换端口启动→原作品/项目/图片仍完整。

**Gate：** 桌面业务资产不再依赖 IndexedDB origin；backup/restore 与 Web adapter 均通过。

# Phase 2 — Durable Task Runtime（P0）

统一外部任务状态：queued/submitting/running/cancelling/succeeded/failed/cancelled/interrupted/unknown。

持久化 stable task id、kind、时间、sanitized input、provider/upstream id、status/progress、result refs、error、cancel/reconciliation metadata。不要强行统一 Comfy/WebUI/video 内部状态机，只统一外部契约。

重构 useSDGenerate/anima/video：composable 只 submit/subscribe/display；unmount=unsubscribe；explicit cancel=cancel；Task Center 查询 runtime 真实任务。

runtime 启动时读取非终态任务并按 provider reconciliation：能查则重连；结果存在则落账；确认失败则终结；无法证明则 unknown/interrupted；**绝不自动重新提交未确认任务**。

必测：切页任务继续、关闭视频页仍可观察、runtime 重启后重连、未知状态不重复生成、cancel/unmount 竞争、同一结果只入册一次。

**Gate：** 长任务生命周期与 Vue component 完全解耦。

# Phase 3 — Desktop UI 与 Runtime 解耦（P1）

Phase 1 完成后，Atelier/Companion/Chat 改为 Tauri bundled frontend resource。新增 starting/ready/degraded/restarting/unavailable 连接状态。

runtime 不可用时仍可浏览本地作品、保留草稿、查看诊断；恢复后 transport reconnect + query invalidation + task reconciliation。删除“gateway restart → navigate 整页”作为正常恢复方式。

Transport 用 ADR 比较 authenticated HTTP/WS、Tauri IPC+sidecar 或其他本机 IPC，以 streaming、安全、调试、Windows 可靠性、Web 共用程度为准。

**Gate：** kill runtime 后窗口不刷新；恢复后查询与任务自动恢复。

# Phase 4 — 前端分层（P1）

逐步按 app/features/application/domain/infrastructure/shared/platform 收敛，不一次性搬目录。评估 TanStack Vue Query 或同等 query layer，负责 catalog/status/artwork list/task list 等可失效 server state；不负责 durable execution、undo/redo 或复杂 draft。

Pinia 收敛为 prompt draft、selection、panel/UI preference、editing session。

**Gate：** feature 可在 mock platform/runtime 下测试；核心 use case 不依赖 Vue。

# Phase 5 — 类型化 Desktop Capability（P1）

逐步退出 shim.rs 中的大段业务 JS。定义 Window/Workspace/Credential/Notification/Update/Live2D capabilities；bridge 在正常 TS source 构建；command/event names 集中；Rust/TS 做 contract test 或生成契约；业务组件禁止直接访问 window.__TAURI__。window.companionDesktop 先降为兼容层，再删除。

CSP 的 unsafe-eval/unsafe-inline 只在实测覆盖下逐步收紧。

**Gate：** desktop capability 可类型检查、mock、contract-test。

# Phase 6 — Live2D renderer process PoC（P2）

独立实验，不直接迁移。比较当前线程方案与 renderer process：CPU、frame time/drops、60/120/165 FPS、显存、renderer crash 后 host 存活、sleep/wake、DPI 100/125/150/200、多显示器、hide/show、model reload。只有故障隔离收益成立且性能/交互无不可接受回退才迁移。

# Phase 7 — Tauri vs Electron 产品基准（P2）

边界稳定后做最小 Electron shell，复用 Vue UI/runtime。比较 installer、cold/warm start、idle/multi-window memory、透明窗、快捷键、tray/updater、native overlay、渲染一致性、sleep/wake、crash isolation、Windows DPI、发布复杂度。只有数据明显支持才换宿主。

## 迁移规则

采用 Strangler Migration：

```text
define port → wrap legacy → add new implementation → verify
→ migrate → switch authority → soak → remove legacy
```

高风险能力保留 feature flag/回退路径。legacy 的删除条件是新路径完成迁移验证和 soak，而不是“新代码写完”。

## PR 批次

1. R0 ADR + baseline + architecture guards
2. R1 repository ports + legacy adapters
3. R2 workspace v2 schema + media staging
4. R3 IndexedDB migration + verification + backup
5. R4 desktop authority switch + port-invariance tests
6. R5 durable task model + task repository
7. R6 generation/anima/video task ownership migration
8. R7 Task Center reconnect/reconciliation
9. R8 bundled desktop UI + runtime reconnect
10. R9 feature/query cleanup
11. R10 typed desktop capability bridge
12. R11 legacy storage/shim cleanup
13. R12 Live2D renderer-process PoC
14. R13 Tauri/Electron benchmark PoC

R0–R11 是主重构；R12/R13 是独立决策实验。不要合成一个超大 PR。

## 每批 Definition of Done

- typecheck、architecture、unit、contract 通过；
- 受影响关键路径有 E2E；
- 无已知数据丢失路径；
- 持久化 schema 有 migration；
- 跨进程协议有版本/兼容策略；
- 更新 ADR；
- 桌面高风险阶段跑 native acceptance/staging/package；
- 不把关键一致性问题以 TODO 推给下一阶段。

## 明天第一轮

1. 拉最新 main 并重新确认基线。
2. 跑 npm run validate + 桌面关键 acceptance，记录现有失败。
3. 完成 R0。
4. 画 artwork/project/task 读写调用图。
5. 定义 repository ports，用现有 IndexedDB 包 legacy adapters。
6. 行为完全不变后完成 R1。
7. 再开始 workspace v2 schema/migration prototype。

## 不可破坏的不变量

- 不丢已有作品、原图、项目引用、设置。
- 不因恢复逻辑重复提交 GPU 工作。
- 不因页面卸载隐式取消已接受长任务。
- 不用 UI cache 充当桌面持久化事实。
- credential 不写普通 SQLite 表或日志。
- 不为了统一破坏 Comfy/WebUI/video 必要的状态机差异。
- 未完成数据迁移前不改变桌面 origin。
- 每个高风险 authority switch 都必须有回滚方案。
