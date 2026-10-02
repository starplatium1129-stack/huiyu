# Rust 画册读取优化

基线：`7ee83b0e4e662ce76897659127a5b16f7bb3dc9e`。工作分支：`fix/gallery-backend-oct2`。仅修改 Rust 作品/画册读取及现有测试；不访问真实作品，不调用模型，不改前端、内容分级或已完成的媒体哈希/生成发布链路。

## 确认问题与修改

- `records::read` 的普通分页、搜索索引和最近作品索引均筛选 `deleted_at IS NULL`，原有主键索引不能跳过回收站记录。在唯一 SQLite worker 中，大量删除记录仍增加查询工作。新增 `artworks_live_id ON artworks(id_key) WHERE deleted_at IS NULL`，沿用 v3 打开时补充索引的机制。现有库、旧备份恢复后均会补建，协议、revision 与分页顺序不变；首次补建需要扫描作品表，后续写入由 SQLite 维护。
- `decode_artwork`/`decode_project` 把解码后的 `Value` 放入 `json!`，分页又把完整 `Vec<Value>` 放入 `json!`。serde_json 1.0.151 的宏对表达式调用 `to_value(&expression)`，两处分别重新分配正文。改为直接移动正文和列表数组，保留所有字段、类型、删除状态、游标与版本号。搜索/最近索引已经使用移动结果，不重复修改。
- 图片读取继续使用已有独立验证器与受限缩略图队列；本轮未发现需要改写它们的额外证据。

## 合成实测

同机 Windows、本地内存 SQLite **3.53.2**、项目现有 debug 依赖。一次性探针直接提取基线与候选 `records.rs` 的读取函数，以最小 `Context` 提供真实 SQLite revision 查询；不包含 actor 调度、HTTP 或磁盘 I/O。每阶段预热一次，测量七次；每次逐值核对完整结果相同。Rust 全局分配器记录一次请求的累计分配字节，**不是常驻内存或峰值 RSS**，也不含 SQLite C 分配。

| 场景 | 修改前 | 修改后 | 解释 |
| --- | --- | --- | --- |
| 200 条有效作品，每条 128 KiB 合成文本；不改变 SQL 索引 | 96.46 ms；105,508,645 B | 85.63 ms；52,800,850 B | 读取中位耗时降 11.2%，累计 Rust 分配降 50.0%；单独衡量消除复制 |
| 20,000 条、每 100 条一条有效，每条 4 KiB 合成文本，读取 200 条 | 7.72 ms；81,412 VM steps | 4.39 ms；1,812 VM steps | 耗时降 43.2%，SQL 指令降 97.8%；包括索引及消除复制 |

稀疏场景的查询计划从主键 `sqlite_autoindex_artworks_1` 范围查找切换为 `artworks_live_id` 范围查找。有效作品比例较高时不能套用稀疏场景收益。最初的 Python SQLite 3.45.3 探索也复现了扫描差异，上表采用项目 bundled SQLite 的后续实测。

原始样本及生成的探针在工作树被忽略的 `runtime/gallery-read-probe/`；一次性驱动在被忽略的 `scripts/archive/gallery-read-probe.py`。只有本汇总入库，不新增常驻性能套件或耗时门槛。

## 验证与边界

- `cargo test --locked --offline --test storage_indexes --test storage_preferences --test storage_behavior`：**5 passed**。两个原有手动 benchmark 仍为 ignored，未当作通过。
- 扩充现有索引生命周期用例：新建/重开 v3、索引补建、revision/identity 不变、备份恢复、删除后普通/偏好分页、`includeDeleted`、恢复重新进入有效索引。
- 复用现有投影与持久化用例：大字段、混合 JSON 类型、最近/搜索索引、未知字段保留、项目成员顺序与完整正文往返。
- `cargo fmt --check`、`cargo clippy --locked --offline --lib --test storage_indexes --test storage_preferences --test storage_behavior -- -D warnings`、`git diff --check`：**通过**。受影响 Rust 文件有效行数分别为 435（records）、378（schema）、377（索引用例），均低于 500。
- 没有执行全量 Rust/前端检查、生产 release 构建、真实库性能采样、浏览器/原生 UI 验收、安装或发布。上述数据仅证明读取切片收益；桌面整页耗时仍需主任务在整合后验证。
