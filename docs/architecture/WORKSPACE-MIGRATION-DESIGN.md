# Workspace 与数据迁移实施规范

> 设计规范，尚未接入生产。对应新版 R1–R4，以及 R9 的剩余来源数据迁移。入口：[总计划](REFACTOR-EXECUTION-PLAN.md)。

## 1. 已定方案与所有权

桌面作品库由 Node 应用运行时统一管理；SQLite 元数据和不可变媒体文件共同组成 workspace。Vue 不直接访问桌面 SQLite，Rust 不建立第二套业务仓储。

首个生产驱动选择仓库已有原型使用的 `node:sqlite`，运行版本以 `.nvmrc` 的 Node 24.18.0 为基准。`DatabaseSync` 放在专用 storage worker 中，防止同步查询、迁移和校验阻塞网关健康检查。worker 不是新的业务服务，也不拥有生成调度逻辑。

R2 必须用实际打包 sidecar 验证 SQLite 版本、事务、备份、worker 加载与重开；版本或打包不满足时阻塞 R2，不悄悄切换驱动或提高整个项目的 Node 下限。Node 该版本文档仍将此模块列为 release candidate，驱动必须封装且不向业务层泄漏。

路径由宿主配置决定，不接受 HTTP 请求中的任意绝对路径：

```text
<config_root>/workspace-active.json       # 指向唯一活动 workspace，含身份/代际/域状态
<config_root>/workspaces/<workspaceId>/   # 初始默认；用户迁移目录是独立操作
  workspace.json                        # 身份与格式；与 SQLite meta 核对
  huiyu.sqlite3                         # 首个生产 schemaVersion=1
  media/objects/<prefix>/<sha256>         # 原图/视频等不可变字节
  media/staging/<operationId>/
  media/derived/                        # 可重建缩略图
  migrations/<migrationId>/
  backups/<backupId>/
```

“Workspace v2”指产品架构版本，不代表第一份生产数据库必须叫 schema v2。不得复用测试 candidate.sqlite。私人库不得放进安装目录、dist、AI_WORKSPACE_ROOT 或可自动清空的 runtime cache。

根路径不可写、磁盘断开、身份不匹配、schema 较新时，显示诊断并拒绝写入；禁止自动改用另一个路径创建空库。

## 2. 单写者与连接边界

- 每个活动 workspace 只允许一个运行时拥有者和一个写连接。所有窗口经同一 API 进入仓储事务；Web Locks 只留在 Web adapter，不用于跨来源协调。
- 初版使用排他的 owner lock 文件创建和宿主生命周期管理，记录 owner nonce、进程身份与 workspaceId。发现已有 owner 时拒绝二次启动，不用“心跳超时”抢锁。
- 崩溃后的自动接管仅允许宿主确认其拥有的旧进程已退出且锁身份匹配；无法证明的残留锁进入维修状态，不删锁试运气。PID 被复用或外部 runtime 不明时同样停止。
- DB meta 保存 writerEpoch，每次变更事务校验；worker 出错后暂停接收写入和生成副作用，先停止/回收原拥有者再恢复。已发送的写命令不能因客户端断开而假定没有提交。
- WAL + synchronous=FULL + foreign_keys=ON；具体 SQLite 版本和恢复行为列入 R2 证据。活库仅支持已验证的本机文件系统，不部署到网络共享或同步盘中并发写。
- 文件提升、GC、备份和数据库更新都服从同一所有权；禁止另开“清理脚本”绕过它。不要用长时间持有 SQLite 事务等待网络/图片解码。

## 3. 数据结构与接口

下表是最低业务约束，不要求一次预建未来无消费者的表。tasks 在 R5 增量迁移建立。

| 表/集合 | 关键约束 |
| --- | --- |
| meta / schema_migrations | workspaceId、databaseKind、schemaVersion、writerEpoch、单调 revision；未知版本拒绝写 |
| artworks | 内部键、旧 ID/类型、完整兼容 body、revision、删除状态；保留当前配方/收藏/备注/父作品字段 |
| projects / project_artworks | 原项目 body、明确作品关系与顺序；关系在事务中修改 |
| trash | 删除时间、恢复快照、项目引用与媒体引用；保留原有 30 天语义 |
| media_objects / media_aliases | 内容 hash/bytes/MIME；旧 image_id 映射到对象，不以 hash 改写所有 UI ID |
| media_refs / leases | 作品、回收站、任务输入、结果收件箱、暂存和备份的引用/保留责任 |
| operations | 唯一 `(principalId, kind, operationId)`、输入指纹、prepared/committed/aborted、提交 revision 与回执 |
| migration_sessions / items | 来源身份、快照指纹、分批进度、校验与激活状态 |
| profile_records | R9 按已分类领域建立；不作为放入任意 LocalStorage JSON 的万能垃圾桶 |

旧数字 ID、字符串 ID 和项目引用必须按当前解析语义往返；若正规化后碰撞，生成冲突报告并停止激活，不静默覆盖。未知旧字段保留在对应领域的兼容 body/隔离记录，不能因为新 DTO 没定义就丢弃。

使用具体操作，而不是远程通用 SQL/KV：list/get artwork、save artwork、patch with expectedRevision、softDelete、restore、purge、project membership、media upload、operation lookup、migration/backup。新 wire DTO 可放在 `types/` 的纯类型声明中；运行校验仍在边界执行，不把 TypeScript 类型当输入校验。

所有变更携带 workspaceId、客户端支持的 protocolVersion、稳定 operationId；修订已有记录还需 expectedRevision。冲突返回明确错误并重新读取，不用最后响应覆盖较新内容。通知仅携带 revision/实体 ID，丢通知后全量或增量重取，通知不是数据权威。

私人 workspace API 只接受桌面专属会话，不能仅凭当前共享网关 token 授权。纯 Web 模式继续使用自己的 IndexedDB；它不是桌面库的离线副本，也不会自动合并进桌面。以后增加浏览器访问私人库需独立配对，不在本轮默认开放。

## 4. 保存与崩溃协议

客户端在用户确认一次保存时生成 operationId，并保持到得到确定回执；HTTP 超时、重连和重试沿用同一个 ID。同 ID 不同输入返回冲突，不能覆盖旧操作。

1. 解析领域快照，检查权限、可用空间与已存在回执，持久化 prepared 操作和暂存租约。
2. 分块写暂存文件；流式计算 SHA-256、长度并核对 MIME/实际文件类型。路径由服务端生成，拒绝穿越、符号链接/重解析点逃逸和任意路径。
3. flush/fsync 后，在同一文件系统提升到不可变对象路径；若相同 hash 已存在，验证后复用，不覆盖未知文件。更新可恢复的操作进度。
4. 原图已经可读取且 hash/长度正确后，短事务一次发布作品、项目关系、媒体引用、revision 和 committed 回执。
5. 提交后返回回执；缩略图异步派生，失败不撤销原图和作品。清除暂存租约必须以已确定的提交状态为依据。

| 中断点 | 重开后的处理 |
| --- | --- |
| prepared 后，文件未完整 | 保留操作身份；重传缺失块或显式终止，没有可见作品 |
| 文件已提升，数据库尚未发布 | 文件是受操作租约保护的孤立对象；可继续事务，不自动删除 |
| SQL 事务中断 | 用数据库恢复结果判断是否已提交；不靠内存 catch 推断 |
| 提交成功但客户端没收到 | 以原 operationId 查询并返回同一回执，不生成第二件作品 |
| 任一存储仍不可读 | 保持 commit-unknown，禁用破坏性补偿/GC；向用户显示可恢复故障 |
| 原图意外缺失/损坏 | 记录不可用状态并从已验证备份修复；不悄悄删作品或伪报成功 |

先媒体、后元数据减少进程崩溃窗口，但不是 Windows 任意断电下的绝对保证。文件/目录持久性、磁盘满、杀毒软件占用与突然终止必须实测；失效时靠校验、备份和显式维修，不隐藏结果。

删除先改变逻辑引用，媒体回收单独执行。GC 只能删除无作品/回收站/任务/暂存/备份引用且超过保留期的对象；unknown 操作、取消未确认任务和未交付结果保持引用。派生缩略图可重建，不能用缩略图存在证明原图完好。

## 5. 迁移范围：先分类，再切换

| 来源 | 迁移动作 |
| --- | --- |
| history、projects、trash、quarantine | 完整导出，兼容字段、删除时间、引用与隔离状态保留；R4 激活作品域 |
| aics_image_store/images | 按游标/批次复制，包含临时和回收站所需原图；不能只遍历可见作品 |
| thumb:<imageId> | 可复制或重新派生；缺失不视为原图迁移失败 |
| storageKeys 的活设置与前缀 | 逐项分类；R9 才切换的领域仍保持旧来源权威，切换时补最新快照 |
| 聊天/归档/重置 tombstone | 保留现有合并/清除语义；旧备份不能复活已重置内容 |
| session 草稿、临时成片、视频/批次指针 | 从仍打开的所属窗口导出；媒体纳入保留；不能从关闭的旧 session 凭空恢复 |
| 任务中心摘要/SD 队列快照 | 历史/待确认数据，不当作可执行任务或真实运行状态 |
| storage 事件信号、relay receipt、在途回调 | 不重放、不恢复；新窗口重新订阅 |
| 凭据 | 通过现有 credentials 能力迁移为引用并验证；不写普通 SQL 表、迁移清单或日志 |

普通备份白名单有意省略部分上述数据，所以必须建立版本化 MigrationEnvelope，不能直接把普通 backup 当作全量迁移包。未知仍在使用的键、未识别凭据字段、无法分类的会话引用是来源切换阻塞项。源配置保留，不静默删除或导入为公开字段。

## 6. 旧来源桥接与激活状态机

```text
inventoried → frozen → exported → importing → verified → activated
                    ↘ failed（保留源、备份和检查点）
```

采用可重复执行的桥接阶段：先在旧 UI origin 和同一 WebView 用户配置中提供迁移功能，R4 先把作品读写切至 runtime，R9 再切 UI origin。不是先改变入口再尝试读取旧 IndexedDB。

M1. 核对安装身份、WebView profile、旧 origin、DB 版本、源指纹及空间。仅使用已知受控来源；desktop-gateway.json 只能证明已记录地址，不证明所有历史端口都已枚举。

M2. 请求维护屏障：阻止新写入，等待所有受管窗口确认，排空已提交操作并暂停 GC。未完成生成/拼接不强杀；等待其安全结束，或在明确处置后再迁移。不能在导出一半时让旧窗口继续改同一领域。

M3. 导出带版本/来源/记录数/媒体 hash 的清单与分块数据，保存独立备份并读回校验。分块大小有界、失败可重试；不把全库 Blob 转成一个巨大 Base64 JSON。

M4. 建立独立候选库。migrationId 绑定 sourceProfileId、origin、快照指纹和目标 workspaceId；相同指纹可续跑，源已变化时要求新会话，不把旧检查点套到新源。

M5. 校验全部原图、引用、回收站、项目顺序、字段往返和源分类统计。坏记录保留隔离副本并报告；存在未解释差异时禁止激活。只有缩略图等明确可重建数据可单列而不阻塞。

M6. 所有客户端读写都经过维护协调后，候选 DB 记录 ready，再原子替换活动指针；指针绑定 DB 身份、迁移 ID 和代际。重启发现两者不一致进入维修，不任选其一。

M7. 客户端拿到新代际后切换该领域 authority，拒绝旧代际变更。作品域已经激活后，旧 IndexedDB 作品数据只读留存；R9 迁移设置/聊天时不能把旧作品快照再次覆盖新库。

端口被其他程序占用时，不能通过解除导航限制来读取旧来源。保留源 profile，等待端口可安全使用，或导入之前验证过的迁移包。没有可靠源就停在旧入口/诊断态，不能显示“迁移成功、0 件作品”。

不同 origin/profile 的数据不是天然同一份库。初版一次激活一个已确认来源；其他来源保留独立导入会话，冲突需显式映射/预览，禁止按 ID 或时间戳自动合并。

旧版程序不懂新维护协议，不能声称可以阻止任意旧二进制直接写它自己的 IndexedDB。支持的升级入口必须阻止不兼容降级；绕过入口运行旧版本产生的写入属于另一数据源，不会自动同步。

## 7. 备份、恢复与回退

备份使用 SQLite backup API 形成数据库一致快照，不能仅复制活库 `.sqlite3` 并遗漏 WAL。短暂冻结变更/GC取得快照后，为该快照引用的不可变媒体建立备份租约，再恢复服务并复制/校验文件。备份完成前租约不能释放；失败备份不进入“可恢复”列表。

恢复先进入独立候选：检查格式/空间/hash/FK/领域数据，再维护切换。备份中的旧任务默认需要重新核对，不自动生成；网关 token 与凭据不从普通业务备份导入。恢复不会覆盖较新的聊天 reset 等保护状态而不作处理。

回退分三个边界：

- 激活前：丢弃未激活候选或留作诊断，解除维护；源完全不变。
- 激活后尚无新变更：比较激活 revision、操作账本和媒体引用，证明没有新写入后才可恢复旧 authority。
- 已有新变更：优先前向修复；必须降级时导出可被旧版读取的完整状态/增量，覆盖新建、修改、删除、回收站和设置变化，验证后才切换。转换不支持就停止降级，不能直接恢复旧快照。

UI 开关可以控制入口展示，但不能选择两个可写主库。旧源与迁移备份在实际安装、恢复、回退演练通过且用户确认清理前保留。

## 8. R2–R4 硬验收

隔离测试必须覆盖：两个进程竞争同库、残留锁、writerEpoch 过期、每个保存中断点、回执丢失、幂等冲突、磁盘满、原图损坏、重复/变化源、迁移中窗口写入、未知格式、项目悬空、回收站恢复、共享媒体不误删、备份期间新写入、带新写入的回退拒绝、远程 token 读取私人库被拒绝。

Windows 必须另验：实际 Node sidecar 加载 worker/SQLite；旧 WebView profile 导出；安装更新不覆盖 workspace；3000 创建作品后占用端口再启动仍访问同一库；路径不可用时不创建空库。没有此证据，R2/R3 可合入默认关闭的实现，但 R4 的真实数据激活不能标完成。

## 技术依据

- [现有 SQLite 原型](../../scripts/tests/prototypes/artwork-sqlite.ts)与[旧方案及隔离证据](../../plans/005-desktop-architecture-consolidation.md)。
- [Node 24.18 SQLite](https://nodejs.org/download/release/v24.18.0/docs/api/sqlite.html)：DatabaseSync 为同步接口，提供 backup；本方案因此隔离同步存储工作。
- [SQLite WAL](https://sqlite.org/wal.html)与[Backup API](https://sqlite.org/backup.html)：按数据库快照和引用媒体分别保证备份完整性；不能把文件系统与数据库声称为一个原子事务。
