# R2：Workspace 内核、受保护 API 与 sidecar 验证

> 2026-09-26；基线 main `9260bd38eb5280fec406e348c489e19f22d00a82`。R2 代码、隔离验证及 sidecar 门槛完成，默认关闭、未启用生产；实际命令、源文件身份和日志见 [R2 验证证据](../evidence/architecture-r2-2026-09-26.json)。

实施提交：`137aa1aae1f9c3a3fe3b084288e860dc6db20297`，已推送 main；后续仅补齐本批证据身份。

## 实现与激活边界

| 范围 | 本批结果 |
| --- | --- |
| 生产存储内核 | `server/workspace/` 提供 SQLite schema 1 与单 owner storage worker；先持久化 prepared 意图，再分块写媒体、发布不可变文件，最后以 SQL 事务发布作品、引用与回执 |
| 身份与修订 | operationId + principal 幂等、revision 冲突检查；旧数字/字符串 ID 按 `String(...).trim()` 正规化并拒绝碰撞，保留未知数据字段；保存不自动新增项目关系，项目成员关系由独立 revision 命令修改 |
| 私人 API | `routes/workspace.ts` 使用专属内存 session，配置仅经可信进程内 binding 注入；共享网关 TOKEN 不授予私库权限。具备 Origin 校验、GET 的同源 Referer / Sec-Fetch-Site 证明及专属 header 保护；没有公开 mint 接口 |
| 一致备份与候选 | 使用 SQLite backup API、leases 和哈希校验；仅生成快照阶段暂停写入，媒体复制每 1 MiB 让出线程并允许正常读写，同一时刻只运行一项后台复制，close 会取消并等待其结束；candidate 独立保留、不激活 |
| owner 与路径保护 | 保留异常 owner 锁；仅凭实际已退出的子进程句柄和匹配 nonce 回收，未实现 Tauri 重启自动接管。workspace 路径拒绝应用包及已知公有 asset/cache/model 目录 |
| sidecar 工作流 | 新增 `desktop:workspace-sidecar`，登记现有工作流、`docs/workflow.md` 和 external 测试 inventory；不安装或下载依赖 |

真实 UI 与原生 session 发放留给 R4/R8；当前仍使用旧 Web 作品权威，没有生产迁移、双写或来源切换。本批提供可接入的生产模块与受保护入口，不把默认关闭的实现称为用户库已迁移。

## 当次验证与修复

| 检查 | 状态 | 结果与限制 |
| --- | --- | --- |
| 最终严格 runtime 构建 | passed | Node 315、tests 227 个编译源检查通过 |
| Workspace 四文件 | passed | 9 项测试通过：storage 自检 57 项并覆盖 4 次真实 SIGKILL 保存窗口；backup 3 项包含复制开始时写入 live 库仍保留旧快照；service client 3 项；routes 2 项启动真实 gateway + worker |
| 实际 sidecar | passed | 依生产 staging 和 `tauri.bundle.resources` 将 14 个实际编译模块复制到临时安装布局运行；Node v24.18.0、SQLite 3.53.1，save/reopen/backup/candidate/writeDuringCopy 全为 true；不是完整 NSIS 安装或 WebView2 验收 |
| staging / gateway / 工作流与测试登记 | passed | 40 项回归通过 |
| 架构 / monolith / 定向 ESLint | passed | 13 条旧边未增加；850 个源文件单体预算通过、未新增豁免；保留 27 条存量 lint warning |
| 最后路径保护复验 | passed | client / routes 共 5 项及 sidecar 1 项通过 |
| 前端、完整 validate、真实 GPU、生产迁移、原生安装、物理断电 | not-run | 本轮未执行；R0 缺失 2,534 张参考图的环境限制未处理，不以本批结果覆盖历史 validate 失败 |

sidecar SHA-256：`9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de`。隔离测试的真实进程终止不替代物理断电或用户安装环境证据。

Windows 目录刷新仍由 `paths.ts` 的窄分支处理，文件继续执行 fsync；目标 Node/Windows 组合经验证支持目录 flush 后移除此分支，不据此宣称断电原子性。

过程问题保留：早期验证误用旧生成物、sidecar 临时 tsconfig 缺少 exclude，统一构建并修正夹具后通过；Node fetch 忽略 Host 覆写导致认证夹具误判，改用 `node:http` 验证。复审还修正非有限 JSON 数值被静默转为 null，以及持久 fingerprint 排序依赖 locale 的问题。初版备份在整个复制阶段排队写入，最终已改为仅快照阶段暂停，复制期间并发写入由回归和 sidecar 探针验证。

## 下一批

R3 尚待执行：盘点旧来源与全部持久领域，建立维护屏障、分块导出、迁移包、幂等检查点和候选校验；保留旧 origin、profile 与源数据。R2 的 sidecar 门槛已取得当次证据，但真实数据激活仍须 R3/R4 的来源、备份/恢复与授权门槛；本轮不提前启用生产。
