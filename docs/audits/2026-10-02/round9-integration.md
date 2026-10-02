# 第九轮独立整合交付

本轮仅准备本地分支 `codex/round9-integration-oct2`，目录为 `runtime/worktrees/round9-integration-oct2`。开工只读核实远端 main 与本地 main 均为 `e9adae012dfe664d51ae1ab1c22601a93a8de91a`，主工作区干净。发布、签名和最终打包继续由用户本地会话负责；本轮没有切换或合并 main，没有安装、打包、签名或 push，也没有修改 Git 信任及权限配置。

## 来源保留

采用保留原始提交祖先关系的合并。产品整合节点为 `6ecf90da`，后续交付提交只增加本报告和索引。除 `docs/INDEX.md` 的机械追加冲突外，各来源修改文件均逐一比对源提交与整合 HEAD，字节一致；索引两侧入口全部保留。

| 来源提交 | 本轮保留内容 | 复用的来源证据 |
| --- | --- | --- |
| `7c43050f918746fd58c8e617912e9edc8a0cda72` | 同一 Vue 应用的最新反推请求拥有草稿；保留显式镜头与光照，避免参考结果写入冲突指令 | 3 文件 36 项定向测试、应用类型、ESLint、体量检查通过；包含 Anima/Krea 编译输入断言，未真实出图 |
| `06682389e65affa863a93dc586b65879b5e9cd5c` | 待确认取消、刷新及任务动作共用在途操作锁，失败后可按原 key 重试 | 4 文件 28 项通过，补齐 fixture 类型后仅复跑受影响 2 项；双主题文字/非文字对比度及浏览器操作通过 |
| `f9362fc9bb41146c1cf402c963a6897619be839e` | 已 settled 且 discarded 的结果直接返回，拒绝重新查询下载 | 来源 rustfmt 通过；此前未编译的指定 Rust 回归由本轮补验通过 |
| `6b68b2d3d2332840ce430d0cafbc29d191456bd8` | [共享生命周期有界核查](round9-runtime-lifecycle.md)及索引，仅文档 | 20 轮合成导航计数无持续增长，卸载后资源计数归零；没有产品改动或量化修复收益 |
| `68690cb7d09e9fb169c8ffe118f253f72f111053` | 离开预取区取消原图请求，预览移出邻域立即清除旧图 decode 源，保留缓存/替换语义 | [图库报告](gallery-scroll-preview-cancellation.md)：38 项定向用例、lint、体量检查和双主题 3 个 CSS 视口通过；3,000 条合成记录的旧请求在回顶部 120ms 后由 4 个降至 0 |
| `c1efc3d1c098e003bc74dff0eb60e15fc79d240e` | 第八轮离线助手工作流写入语义修复 | 开工时尚未进入 main，仅纳入本分支；不接管用户发布。复用第八轮 3 个 workflow-runner 用例证据 |

来源原始材料仍在各自 worktree 被忽略的 runtime 目录：反推 `runtime/round9-interrogation-evidence/`、任务 `runtime/round9-task-evidence/`、Gallery `runtime/gallery-round9/`、生命周期 `runtime/round9-lifecycle/`。本轮没有重复执行这些已验证且字节未变的定向套件，也没有把原始截图或日志加入 Git。

## 本轮实际验证

- 一次 `npm run build:runtime`：新 worktree 准备 Node 工具产物，services/node/tests/browser 四个 TypeScript 项目通过；仅输出本 worktree 忽略产物。
- `vue-tsc -p tsconfig.app.json --noEmit`：最终通过。首次因新 worktree 缺少忽略的 `data/popular-characters.json` 未通过；用已有 `node scripts/workflow.js popular:build --check` 从当前分片补齐产物后复验，不修改源码、类型规则或数据分片。
- `node scripts/tests/test-domain-type-boundaries.js`：2 项通过，984 个产品源文件、4,398 条依赖，0 个遗留豁免、0 个新边界违规，未解析依赖和运行时循环为空。
- 指定 Rust 命令通过，1 passed、4 filtered out，测试耗时 0.19 秒，增量编译 1 分 27 秒。MSVC 报告两处创建 import library 的 `linker_messages` 提示，没有编译错误。

```powershell
cargo test --manifest-path runtime-rs/Cargo.toml --locked --test task_recovery restart_recovers_node_identity_without_resubmission_and_requires_cancel_ack -- --exact
```

启动前只读检查用户发布进程；其使用 release worktree 与 `D:/CodexCaches/Cargo/build/b0/a2bbc5a849d4e4`。本轮复用当时无运行进程占用的第七轮隔离 `runtime/cargo-target` 和 `runtime/cargo-build`，以进程环境 `CARGO_TARGET_DIR`、`CARGO_BUILD_BUILD_DIR` 指定，`CARGO_BUILD_JOBS=1`、`CARGO_NET_OFFLINE=true`；TEMP/TMP 指向本轮独立普通长路径。没有等待或争用发布 target 锁，没有运行 Rust 全套。初始 shell 未包含 Cargo，仅补充当前进程 PATH 使用已安装的 1.97.1 工具链，未安装或改全局配置。

该用例实际验证原 Node 任务身份恢复、不重提任务、取消确认和 discard 后 reconcile 原记录不变；history/download/posts 计数不增长，恢复临时文件不存在。它不是修复后 HTTP EXE 或真实模型验收。

整合原始日志及来源字节核对清单位于本 worktree 被忽略的 `runtime/round9-integration/`。文档本地链接与 `git diff --check` 在交付前定向核验。

## 待验边界与接入

- 反推没有真实模型/图片验收，不以编译输入通过证明画面质量；没有改写场景、蓝图或定稿数据。
- 来源 UI 验收为隔离浏览器：任务列表覆盖深浅主题 CSS 1920×1080、2560×1440、3840×2160、960×720；Gallery 覆盖前三档，DPR=1、缩放=1。系统 DPI、原生 WebView2、GPU/进程内存、多千张真实原图及实际磁盘取消延迟仍未验。
- 生命周期只覆盖实际 composable 的合成路由、假时钟及可计数替身；不宣称完整应用无泄漏。
- 没有新生产前端/桌面构建、安装、签名、发布或完整全量回归；用户已有发布包不包含本轮变更，除非由发布会话后续明确接入并重建。

用户发布会话结束后，先检查 main 工作区及最新提交，再判断其是否为本分支祖先。若仍为 `e9adae01` 或本分支已包含的 `c1efc3d1`，可由用户会话执行 `git merge --ff-only codex/round9-integration-oct2`。若 main 已有其他提交，不强推、不重置、不覆盖发布改动；先在独立整合分支合并最新 main、处理实际差异并仅补受影响验证。后续 push、构建、安装和发布仍归用户发布会话执行。
