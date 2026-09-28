# Rust 后端请求与存储优化

本次范围为任务重复写入、历史任务读取、媒体冷校验及健康探测。修改正式 `runtime-rs` 后端与对应任务读取客户端，不改变模型请求参数或内容分级规则。

## 行为与边界

- 无变化任务 patch 保持 revision 和 updatedAt，仍执行 writer epoch、预期 revision、取消与重复提交检查；关键状态变化仍按原事务持久化，不降低 SQLite 持久性等级。
- 任务历史分批读取，客户端保留完整历史并增量获取变更；恢复查询仅选择需要协调的任务。取消、分页失败、工作区或 runtime epoch 切换不能发布混合身份的结果。
- 原图/视频冷校验移出唯一 SQLite worker，有界后台校验并合并同文件并发工作；保留 SHA256、文件类型、长度和文件身份检查，关闭时排空校验工作。
- 健康探测读取 Live2D 能力快照，目录刷新在后台进行；模型与资源访问继续使用严格检查，健康快照不作为访问授权。

## 验证与交付

当次 Windows x64 验证：

| 检查 | 结果 | 原始日志（不入 Git） |
| --- | --- | --- |
| `npm run wf -- rust:check` | fmt、Clippy 通过；117 项测试通过，8 项显式原生/性能实验未运行 | `runtime/backend-optimization-2026-09-29/rust-check-3.log` |
| 任务 API 与 tasks composables Vitest | 5 个文件、22 项通过；含跨页取消、epoch 切换和失败不发布半批 | 同目录 `task-tests.log` |
| `npm run typecheck:app`、定向 ESLint | 通过 | 同目录 `typecheck.log`、`eslint.log` |
| 单体预算、领域依赖边界 | 通过；无新增违规或豁免 | 同目录 `monolith-final.log`、`boundaries.log` |
| 文档链接 | 0 个断链 | 同目录 `docs.log` |
| 桌面构建环境检查 | Windows/MSVC/SDK/Cubism 就绪 | 当次 `desktop:doctor --json` 输出 |

Rust 新回归证明：暂停冷校验期间数据库请求仍可完成，同文件并发只哈希一次，取消/关闭等待实际线程退出，文件变化不进入缓存；任务无变化 patch 不推进版本，分页期间的更新由增量读取补齐，一次性恢复使用稳定 rowid，查询计划使用相应索引；健康路由在两个 Live2D worker 均占用时仍响应，目录锁、冷启动、失效、TTL 与刷新超时有覆盖。最初两轮 Clippy 发现测试跨 await 持锁及未使用包装函数，已分别改为独立线程夹具并删除无用包装，最终完整检查通过。

构建与安装另行登记。代码路径优化不等于已经测得整机性能提升；本次没有调用真实模型，8 项被标记 ignored 的实验不计为通过，长期设备表现不在隔离回归结论内。
