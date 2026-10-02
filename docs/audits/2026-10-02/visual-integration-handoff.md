# 三路视觉独立整合交付

本轮只准备分支 `codex/visual-integration-oct2`，worktree 为 `runtime/worktrees/visual-integration-oct2`。没有改动用户 main 工作区，没有 push、签名、桌面打包、安装或使用共享 Cargo target。最终报告提交可由 `git rev-parse codex/visual-integration-oct2` 取得；三路源码整合节点为 `33a49faad58f053219b476b87573dfe7ccef575e`，纳入最新发布文档后的节点为 `a697b454f851e067c5e004a9796168828e7cd2e8`。

## 基线与来源

开工时本地 main 为 `fa9bd65dcbf9037320984ccdb5ef4258780c20c3`。round9 `299f011d075ce1e09d7f87cf0a5da319af0515d8` 尚未进入 main，但已包含该 1.8.1 发布源码，因此直接以 round9 创建新 worktree。三路均通过 merge 保留来源祖先，没有重复 cherry-pick Gallery 的 `68690cb7d09e9fb169c8ffe118f253f72f111053` 依赖。

| 来源 | 保留内容 | 复用证据 |
| --- | --- | --- |
| `4113f5d6dc95956d5f437419ad59f27e28f14bc3` / `feat/magic-reveal-oct2` | 生成光纹、短时水纹，清除旧 gather 实现 | [来源报告](magic-reveal-handoff.md)：5 文件 65 项；真实 DirectorStagePanel 双主题对照及录像 |
| `4c885ed813314201f3d6c5e09b793f54aa67f5d1` / `codex/gallery-expand-oct2` | 缩略图即时预览、有界原位展开/收回、离屏焦点判断 | [来源报告](gallery-origin-expansion.md)：33+28=61 项，2 个浏览器用例及真实 Gallery 双主题录像 |
| `f1ea58252a9a172c303e5afac2f8dceb075f4547` / `feat/inspiration-cards-oct2` | 灵感推荐叠卡，仅来源的 5 文件 | 来源 `runtime/inspiration-deck-evidence/handoff.txt`：6 个行为用例、真实 SceneExplorerView 双主题操作与录像 |

三路除 `docs/INDEX.md` 外的所有来源文件与整合 HEAD 字节一致，删除文件也保持删除。索引保留各方入口。灵感翻页只浏览推荐，探索按钮才调用已有筛选动作；未改场景内容、提示词或分级数据。本轮未重复这些来源的组件套件或视觉矩阵。

工作期间用户发布会话将本地 main 推进到 `a135f6353941c977bebb58d9a06366b3f5c37cb7`，只更新 `docs/INDEX.md` 和 `docs/project-status.md` 的公开发行记录。本分支随后完整纳入该提交，保留新的发布状态和全部整合入口。主工作区只读检查为干净。远端 `git ls-remote origin refs/heads/main` 因 Schannel `SEC_E_NO_CREDENTIALS` 失败；本轮没有更改凭据或信任配置，不能据本地引用声称已核实实时远端。

## 共享行为核对

- Gallery 的 `useGalleryWorkspace.ts` 相对 round9 只有焦点返回目标的离屏判断；预取 AbortController 取消、40 张 HD 缓存、同 ID 替换逻辑保持。`PhotoSwipeStage.vue` 与 round9 字节一致，过时预览 decode 源释放仍保留。
- `useImageOriginTransition.ts` 与 Gallery 来源字节一致：只有 Gallery 传入 `1920 * 1080` 过渡副本预算；默认图片代理继续在 src 前设置 CORS/referrerPolicy、等待 decode、拒绝迟到结果。低动效、隐藏、反向关闭、失效来源及卸载清理仍在；canvas 释放归零，图片代理清除 src。
- 生成水纹保持最多 600,000 像素、960px 长边、DPR 1.25、30 次绘制/秒、600ms 上限和 GPU 资源释放；旧图消散 `canvasDissolve`、`useCanvasClearMotion` 与 round9 字节一致。
- `useVisualActivity`、`motionPreference`、Rust 后端、桌面源码、依赖锁、Vite 拆包配置和 bundle 预算均未修改。三路未产生需要另补视觉验收的组合行为变化。

## 本轮实际验证

1. `npm run build:runtime` 通过，准备新 worktree 的 services/node/tests/browser 工具产物。复用已有依赖安装；生成工具、dist、数据聚合和日志均在本 worktree。
2. `node scripts/workflow.js popular:build --check` 补齐新 worktree 缺失的忽略聚合文件；`npm run typecheck:app` 通过。
3. `node scripts/tests/test-domain-type-boundaries.js`：2 项通过，986 个产品源、4,406 条依赖，0 个遗留豁免、0 个新违规，未解析依赖及循环为空。
4. `npm run build:web:run`：生产 Vite 构建、原有预算和 gzip/Brotli 预压全部通过。随后以同一 dist 导出预算 JSON，没有第二次构建。加入 main 的变化及本报告仅为文档，与实际构建节点的产品源码/配置字节一致，复用本次证据。
5. 来源祖先、逐文件字节、round9 后端/画册、发布文件及懒加载边界核对通过；报告本地链接和 `git diff --check` 通过。

| 生产预算项 | 实测 / 上限 |
| --- | --- |
| PromptBuilder 路由 JS | 143,285 / 143,360 字节（139.9 / 140 KiB），仅余 **75 字节** |
| 最大路由静态闭包 Gallery | 628,711 / 696,320 字节（614.0 / 680 KiB） |
| 入口 JS 静态闭包 | 248,440 / 399,360 字节（242.6 / 390 KiB） |
| 入口 CSS | 101,721 / 102,400 字节（99.3 / 100 KiB） |
| 最大懒加载 Live2D 块 | 917,811 / 1,024,000 字节（896.3 / 1000 KiB），未进入入口静态闭包 |

18 条懒路由预算通过；PromptBuilder 仍为动态路由。没有通过提高阈值、移动到同步共享块或破坏懒加载获取通过。Vite 仍提示已有 wl-live2d ESM/CommonJS 混用和大 chunk 警告；预算门禁未失败。PromptBuilder 与入口 CSS 均接近上限，后续代码增加需重新看真实产物。

原始日志、预算 JSON、manifest 边界和来源逐文件核对在本 worktree 被忽略的 `runtime/visual-integration/`；一次性核对脚本位于 `scripts/archive/visual-integration/`，未新增常驻测试或维护入口。

## 既有录像与未验边界

本轮复用来源本地回执和原始真实组件录像，不重新上传 Library：

| 录像 | 已有 Library 文件 |
| --- | --- |
| `huiyu-magic-before-after.mp4` | `libfile_a9d71f2012e88191ab431b23750968d4` / `file_000000001bb481f9ba0c8c14ebb84255` |
| `gallery-origin-desktop-demo.webm` | `libfile_357cf1d1cda08191bb52824e7f4b3bb1` / `file_0000000047dc81f99a44af22f96e7cae` |
| `inspiration-deck.mp4` | `libfile_74b3900bbf688191bc69ac3622dc0e0d` / `file_000000004b5881f9ba33f6a4015300e2` |

来源在各自 worktree 的 `runtime/magic-reveal-evidence/`、`runtime/gallery-expand/`、`runtime/inspiration-deck-evidence/` 保留原始材料。其双主题验收覆盖 1920×1080、2560×1440、3840×2160 及较窄 CSS 视口；浏览器缩放 100%，主要 DPR=1，画布另有 DPR=2 模拟。它们不是物理分辨率、系统 DPI 或原生桌面验收。本轮没有重跑浏览器矩阵、全量测试、Rust 构建、真实模型出图、设备/GPU 压力、WebView2、UAC 或安装验收，也未访问生产数据。

## main 接入前提

用户发布会话结束后，在负责 main 的会话核对工作区干净、实时远端和本地 main 最新。当前已纳入的本地 main `a135f635` 是本整合分支祖先，可以执行 `git merge --ff-only codex/visual-integration-oct2`；本轮没有执行该操作。若 main 再前进，先在独立整合分支合入新提交，核对实际差异，仅补受影响验证，不能覆盖发布改动。

本分支包含 round9 和这三路视觉，当前已发布、绑定 `fa9bd65d` 的 1.8.1 安装包不包含它们。后续版本、完整桌面构建、签名、push、安装和发布由用户会话接管；本轮前端 dist 仅证明组合产物通过预算，不是可直接安装的桌面发行候选。
