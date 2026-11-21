# Workspace 与数据迁移实施规范

> 桌面作品库由 `runtime-rs/` 独立管理；Web 端保持独立 IndexedDB。全局入口见 [工程契约](../engineering-contracts.md#重构期间的任务与持久化边界)，本机安装状态见 [项目状态](../project-status.md#源码与本机安装)。

---

## 1. 存储结构与所有权

- **单一仓储**：`rusqlite` 连接由专用存储线程持有（`WAL`、`synchronous=FULL`、`foreign_keys=ON`），避免阻塞异步网关；Vue 端仅通过窄 HTTP 契约访问。
- **目录布局**（路径由宿主配置决定，拒绝 HTTP 请求中的任意绝对路径）：

```text
<config_root>/workspace-active.json       # 唯一活动 workspace 指针（含身份/代际/域状态）
<config_root>/workspaces/<workspaceId>/
  workspace.json                        # 身份与格式（与 SQLite meta 核对）
  huiyu.sqlite3                         # 当前 schemaVersion = 6（v1→v6 顺序升级）
  media/objects/<prefix>/<sha256>         # 不可变原图与视频字节
  media/staging/<operationId>/
  media/derived/                        # 可重建缩略图
  migrations/<migrationId>/
  backups/<backupId>/
```

- **路径与版本保护**：禁止将工作区放在安装目录、`dist`、`AI_WORKSPACE_ROOT` 或可自动清空的 cache 中，也不支持网络共享盘或同步盘并发写。路径不可写、身份不匹配或库版本高于运行时时直接报错并拒绝写入，禁止静默新建空库。

---

## 2. 单写者与并发控制

- **排他持有者锁**：每个活动 workspace 仅允许一个拥有者进程与写连接。启动时通过排他 owner lock 记录 `owner nonce`、进程身份与 `workspaceId`；发现已有活 owner 时拒绝二次启动。仅确认原自有进程已退出且锁身份匹配时才接管；无法证明的残留锁进入维修状态。
- **写事务与 `writerEpoch`**：`meta` 表保存 `writerEpoch`，每次写事务均校验。存储线程出错时暂停写入与生成副作用，先回收原拥有者再恢复。
- **通知非权威**：前端通知仅携带 `revision` 与实体 ID，丢失通知通过增量/全量重取收敛。变更提交携带 `workspaceId`、`protocolVersion`、`operationId` 及 `expectedRevision`，冲突返回明确错误而不静默覆盖。

---

## 3. 核心表结构与查询边界

| 表 / 集合 | 关键约束与职责 |
| --- | --- |
| `meta` / `schema_migrations` | 保存 `workspaceId`、`databaseKind`、`schemaVersion`、`writerEpoch`、单调 `revision` |
| `artworks` | 内部键、兼容 `body`、`revision`、软删状态 `deleted_at`（保留未知兼容字段） |
| `projects` / `project_artworks` | 项目定义与有序作品关系，事务内维护 |
| `trash` | 删除时间与媒体引用，保留 30 天恢复语义 |
| `media_objects` / `media_aliases` | 内容 SHA-256、字节大小与 MIME，旧 `image_id` 映射到对象 |
| `media_refs` / `leases` | 作品、回收站、任务输入/收件箱、暂存与备份的生命周期引用 |
| `operations` | 唯一 `(principalId, kind, operationId)`、输入指纹、状态与提交回执 |
| `migration_sessions` / `items` | 来源身份、快照指纹、分批进度与激活状态 |
| `profile_records` | 按已分类领域存储偏好设置（非任意 JSON 垃圾桶） |
| `chat_message_records` | 按角色、分支、消息编号拆分活跃聊天正文，与 `profile` 协同校验 |
| `image_batch_plans` | 后台持有冻结配方、逐项稳定 `requestKey`、暂停态与入册回执 |

### 派生索引与专用接口

- **回收站查询**：`GET /api/workspace/artworks?deletedOnly=true` 直接查 `artworks.deleted_at IS NOT NULL`（利用 `artworks_deleted_id` 部分索引，每页 1–200 条）；客户端 `listTrash` 完成后复核会话与 workspace 身份，不一致则拒绝整次结果。
- **全局搜索 (`GET /api/workspace/artwork-search?terms=<JSON数组>[&cursor=<ID>]`)**：使用 `artwork_read_index`（触发器维护 `artwork_read_dirty` 与 `meta.artworkRevision`）及无原文 FTS5 候选索引。索引按 128 条分批后台补齐，支持安全取消；索引未就绪时回退正确线性扫描。

---

## 4. 保存协议、崩溃恢复与 GC

客户端确认保存时生成稳定 `operationId`，重试沿用同 ID（同 ID 不同输入报冲突）：
1. 校验权限、空间与已存在回执，写入 `prepared` 记录与暂存租约。
2. 分块写入暂存文件，流式计算 SHA-256 与长度并校验 MIME/真实文件头（拒绝路径穿越与重解析点逃逸）。
3. `flush/fsync` 后在同一文件系统原子提升至 `media/objects/`（同 hash 复用，不覆盖未知文件）。
4. 短事务一次性发布作品、项目关系、媒体引用、`revision` 与 `committed` 回执，随后异步派生缩略图。

| 异常中断点 | 重启后处理原则 |
| --- | --- |
| 暂存未写完 | 保留 `operationId` 供重传或显式中止；无可见作品 |
| 文件已提升，DB 未发布 | 文件受操作租约保护，可继续事务，禁止自动删除 |
| SQL 事务状态未知 | 按库内状态与 `operationId` 查询恢复；不可读时标 `commit-unknown` 并禁用 GC |
| 原图损坏/缺失 | 报告不可用并从已验证备份修复，严禁静默删作品 |

> **GC 边界**：必须先解除逻辑引用再延迟回收；处于 `unknown` 操作、未确认取消或未交付结果的媒体严禁回收。

---

## 5. 备份、恢复与旧来源迁移

- **完整备份 (`.huiyu` / `HUIYU-BACKUP-1`)**：使用 SQLite Backup API + 独立只读连接固定 `revision`/`writerEpoch` 读取媒体清单并流式校验 SHA-256，备份期间受租约保护（不含网关 token 与凭据，内容目录仍单独导出）。
- **回收站恢复**：先在有界槽中完整校验媒体 SHA-256，再于事务内复核作品状态与文件身份后恢复。
- **备份还原与回退**：导入包先在独立候选工作区核验全部文件与外键，再经跨窗口保存屏障排空写入后切换身份；旧运行中任务仅保留历史不重新执行。
- **IndexedDB 来源迁移 (`inventoried → frozen → exported → importing → verified → activated`)**：
  - 按领域分类导出 `Versioned MigrationEnvelope`（凭据走系统凭据能力迁移，不落普通 SQL 表或日志）。
  - 每次激活一个已确认来源；激活前通过维护屏障阻止并发写并核对所有原图、引用与统计差异，切换后旧库仅作只读备份。
  - 若激活后已产生新写入，仅支持前向修复或经验证的导出降级，禁止直接恢复旧快照覆盖新数据。
