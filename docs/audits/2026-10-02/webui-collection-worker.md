# WebUI 完成收集与串行生成队列解耦

日期：2026-10-02。基线：`7ee83b0e4e662ce76897659127a5b16f7bb3dc9e`。独立分支：`fix/webui-collection-worker-oct2`。

## 已确认问题与实现边界

WebUI 的单一 `run_queue` 等待 `complete → jobs::succeed → try_collect → hooks.collect`。即使 admission permit 已释放，首次收集内的慢持久化仍阻塞下一条 `/sdapi/v1/txt2img`。问题出现在带 hooks 的 WebUI 任务；此证据不说明 Comfy 跨任务吞吐提高。

产品代码只修改 `runtime-rs/src/generation/jobs.rs`：

- 完成状态转换、输出保留、`collection_pending` 设置和 permit 释放仍在调用链内完成；不把整个 `succeed` 异步化。
- 首次收集与原有 1、2、4 秒有限重试由同一个 `TaskTracker` worker 执行。无 hooks 的任务直接完成，不创建收集 worker。
- 首次、重试和 query 兜底共用原来的 `try_lock` claim。成功收集清 pending，失败保持原错误信息及待保存观察语义，查询不会重新生成。
- `collect` await 优先响应服务 shutdown，取消时释放 hook future 与 claim。`webui.rs` 的生成/interrupt 双重屏障、`service.rs` 的 cancel → wait → 清输出顺序不变。

未修改 storage、画册读取、任务媒体持久化实现、提示词或分级内容。共享 `succeed` 也服务 Comfy，因此复用已有 Comfy 输出所有权回归核对影响，不扩展吞吐结论。

## 当次证据

环境：Windows、Rust/Cargo 1.97.1。依赖来自本机缓存，Cargo 使用 `--locked --offline`；build/target 目录均在本 worktree 内，`CARGO_BUILD_JOBS=2`。fixture 仅使用临时目录、动态回环端口和固定 PNG 字节，无真实模型或生产数据访问。

复用 `generation_service` 现有 mock 服务，增加三个行为测试。为维持文件体量，把原有 collection hook 与 pending helper 移入 `tests/generation_service/collection.rs`，原断言保留。

| 验证 | 结果与含义 |
| --- | --- |
| 旧代码 + 阻塞 hook + 两条 WebUI 任务 | `second WebUI POST must arrive while collection gate is closed` 在 5 秒内超时；测试失败符合已确认阻塞，单测耗时 5.03 秒 |
| 新代码，同一阻塞 fixture | gate 未释放、hook 仍活动时第二个 POST 到达；第二条保持在途时取消第一条，不发送 interrupt；最终只有两次生成和一次成功收集 |
| pending / 幂等 / admission | 查询返回 running、未 settled、非 unknown 且保留输出；重复查询不重复 collect；第一条保存阻塞时只占第二条的 admission，第二条完成后占用为零 |
| 关闭中的首次与重试收集 | 分别阻塞第 1、2 次 collect，close 均在 1 秒限时内返回；活动 hook 归零、输出弱引用不可升级、结果从服务移除 |
| 有限重试与 query 兜底 | 虚拟时钟验证累计约 1/3/7 秒的三次重试，仅容许 Tokio 每个 timer 的 1ms 舍入；再推进 8 秒仍只有四次尝试。之后 query 获得 claim，并发 query 不重复收集，shutdown 可取消该兜底调用 |
| 既有 WebUI interrupt 屏障 | 通过；原生成返回但 interrupt 未完成时，第二个 POST 仍被阻挡 |
| 既有 Comfy 工作流/输出所有权/定向取消 | 通过；包括首次收集读取落盘文件的字节与 SHA 核对 |

执行命令（均在 worktree）：

```powershell
cargo test --manifest-path runtime-rs/Cargo.toml --locked --offline --test generation_service collection::webui_slow_collection_does_not_block_next_generation -- --exact --nocapture
cargo test --manifest-path runtime-rs/Cargo.toml --locked --offline --test generation_service -- --nocapture
cargo test --manifest-path runtime-rs/Cargo.toml --locked --offline --test generation_service collection::webui_collection_keeps_finite_backoff_and_query_fallback_cancellable -- --exact --nocapture
cargo clippy --manifest-path runtime-rs/Cargo.toml --locked --offline --test generation_service -- -D warnings
cargo fmt --manifest-path runtime-rs/Cargo.toml --check
node scripts/tests/test-monolith-budget.ts
npm run build:runtime
node scripts/maintenance/check-doc-links.js
```

首次修复后批次四项通过，退避测试因误要求整秒精度（实际 1.001 秒）失败；仅修正新测试的毫秒舍入断言及虚拟时钟作用范围后，定向重跑该项通过（0.02 秒）。其余四项未改，沿用同次有效证据。定向 Clippy、fmt 和单体门禁通过。新 worktree 的文档检查起初缺少 31 处生成 JS 引用；执行一次 `build:runtime` 后，119 个文档、898 个本地链接和 70 个重定向全部通过。没有手改生成入口或提交生成 JS。

原始日志位于本 worktree 被忽略的 `runtime/evidence/`：`before.txt`（旧代码反例）、`after.txt`（四项通过及时间断言失败）、`backoff.txt`（修正后的定向通过）、`clippy.txt`、`build-runtime.txt`、`docs.txt`。这些是调度行为证据，没有测量真实生成耗时或生产存储吞吐。

## 交付限制

只做本地提交，未合并 main、push、安装或真实出图。未运行全仓测试、发布构建或设备验收。当前工具无法核对任务服务是否有同名工作；本地分支/worktree 和当前可见会话在开工时未发现同名任务。未重试此前返回 UNKNOWN 的服务创建，也未绕过任何 push 审核。
