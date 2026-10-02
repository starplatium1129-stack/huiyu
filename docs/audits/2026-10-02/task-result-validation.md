# 任务结果提交校验与 SQLite 查询交接

日期：2026-10-02。基线：`a052c713b577f7ae3eec912f993f81d336a9cebb`。仅调整 `task.result.commit` 的整文件校验；未改任务 execution、输入媒体、普通保存协议、读校验缓存或其双槽限制。

## 实现与一致性边界

每 workspace 的结果 prepare、文本/二进制 chunk、commit 共用一个异步准入槽；等待发生在 SQLite actor 外。许可随已入队 Work 转交 actor，并留在进行中的校验任务中，不随 HTTP 等待者断开提前释放。没有新增生产配置或手动开关。

actor 先核对 principal、任务和输出身份、writer、owner、普通 task-result lease，并记录 workspace/root/DB/owner 身份、epoch、精确 media_json 和 lease 创建身份。后台只持有文件校验输入、打开句柄、不可变快照与取消信号；SQLite 连接始终由原 actor 操作。

后台以原 1 MiB 读取循环核对完整 SHA-256、长度和实际 MIME，保留打开句柄的 native identity 与完整 FileIdentity（包括 ChangeTime），核对读前、读后和路径指向。回队重新读取当前 TaskRecord、输出和 lease，拒绝 discarded、身份/版本漂移及已取消的请求；合法任务取消意图和 metadata 更新按当前记录保留，不把 TaskStatus::Cancelled 一概视为禁止收集结果。

已有对象校验一遍。新对象先验证 staging；actor 复核后 hard_link、保留原 sync_dir，再后台验证最终对象。hard_link 会改变 links/ChangeTime，因此第二遍不能通过忽略版本变化省略；AlreadyExists 竞争目标也走这遍验证。最终事务再次复核文件与授权，检查别名和已有对象元数据冲突，原子发布 media_objects/aliases/refs/task_outputs、合并任务状态并删除普通 lease；成功后清理 staging。每块 sync_all、原 SQLite FULL 持久性和 COMMIT_UNKNOWN 契约保持。

进行中任务在内存保护 hash 与 staging key。discard 可以删除普通 lease，但 GC 在后台校验结束前不能删除对应文件。失败保留原准备 lease 供重试；discard 不会重建 lease 或恢复引用。Close 关闭准入、取消校验并等待所有文件工作完成，所有结果/GC/backup 完成分支都参与 drain，之后才 checkpoint 和释放 owner。

## 确定性阻塞证据

原复现见被忽略的 `runtime/commit-validation-repro-oct2/report.md`：暂停 staging/已有对象校验时，校验线程为 `workspace-sqlite`，三个已入队查询使容量 64→61，均不能返回。

修复后用同类临时合成夹具，在 `workspace-result-verify` 实际完整 hash 前安装门闩，明确不释放门闩，然后等待画册列表、任务列表及既有媒体别名查询全部成功。两种分支均完成 3/3 查询，提交仍在等待。重复 prepare/chunk/commit 均在 actor 外等待，未产生第二个校验任务；释放后结果幂等、字节相等、重开 revision/引用正确，lease 清零。门闩只有 10 秒死锁 watchdog，无 sleep 或性能阈值。

该次三个查询合计为 staging 1.0241 ms、已有对象 0.8773 ms；夹具只含一个合成任务和 seed 媒体，不能外推到用户图库或生产延迟。

## 合成吞吐与验证

Windows x64，cargo/rustc 1.97.1，debug test profile，离线依赖，独立 E 盘 Cargo 缓存，编译并行度 2。数据为 16 MiB PNG 签名字节夹具，不是实际解码图像或模型输出。单次测量从释放 hash 门闩到提交完成，包含校验与发布、不含上传：

| 分支 | 有效提交吞吐 | 耗时 | 暂停期间查询 |
| --- | ---: | ---: | ---: |
| 新对象（两遍 hash） | 30.998 MiB/s | 0.5161604 s | 3/3 成功 |
| 已有对象（一遍 hash） | 61.702 MiB/s | 0.2593102 s | 3/3 成功 |

这是单次合成观测，无原实现吞吐对照；不能宣称提交吞吐提升或 UI 加速比例。新对象的第二遍读取是此次并发交接为保留内容一致性付出的成本。

首轮执行 `cargo test --manifest-path runtime-rs/Cargo.toml --locked --offline --lib --no-run --message-format=json-render-diagnostics`，编译成功（59.89 s），同一测试二进制执行 `storage::`：44 通过、2 失败、2 ignored。失败分别是重试夹具改变 media_json 字段顺序，及原回执丢失测试未解包新增准入 Work；修正夹具后只做一次必要增量编译（35.93 s），两个失败用例各定向复验通过，未再改生产代码。其余有效证据复用：合计 46 项普通存储行为通过，另 1 项显式 ignored 吞吐测量通过，旧 chunk 吞吐 benchmark 未运行。没有隐去首轮失败日志。

新增的 8 项行为测试集中覆盖：双分支查询与准入、同长改写并恢复 mtime/文件替换/目标竞争、discard+GC、掉线与关闭/GC 交叠及 owner、panic/启动失败重试、owner/epoch/lease/media/principal 漂移、正常媒体 API 抢占同名 alias、任务取消与 metadata 合并。复用已有媒体 durable/CAS、GC、backup、关闭、读缓存与双槽回归。

定向 rustfmt、`git diff --check`、原单体预算门禁通过（直接由 Node 执行 TypeScript 测试源，1665 个文件、0 个豁免；没有准备或构建 SPA）。原始编译日志、测试输出、吞吐数据和源码/二进制 SHA 绑定保留在被忽略的 `runtime/commit-validation-fix-oct2/`，由 `evidence.json` 索引。吞吐使用的首轮二进制另存为 `measured-lib-tests.exe`，不会被夹具重编译覆盖。

## 未验证

未使用真实用户库/图片、远程服务或模型，未测生产延迟、UI/桌面分辨率、release 构建、安装发行、实际断电及设备持久性。root 目录/DB 文件替换、reparse 变化未做独立故障注入；路径与句柄复核已实现，owner 替换和版本改写有实际夹具证据。未运行 Clippy、全仓门禁或 SPA 构建。本变更不涵盖其他媒体写入路径仍同步校验的耗时。
