# 第九轮图库滚动与预览取消

基线为现场只读核实的远端 main `e9adae012dfe664d51ae1ab1c22601a93a8de91a`，工作树为 `runtime/worktrees/round9-gallery-preview-oct2`，分支 `codex/round9-gallery-preview-oct2`。本批只修改图库原图读取所有者和手势预览解码生命周期；没有重复改造轻量加载、KeepAlive 或后端存储索引。

## 复现与修复

1. 展墙分页保留旧卡片 DOM，IntersectionObserver 原先只处理进入预取区。快速滚动离开后，旧卡片仍在 pagedVisible 中，所以其在途及排队原图请求不会被筛选取消逻辑清理。现在离开原有 ±600px 预取范围时取消该卡片的读取并移除排队项；复用同一取消路径处理筛选和图片替换，保留旧请求清理不得夺走新请求所有权的检查。
2. PhotoSwipe 切出 ±2 邻图范围时原先取消读取、撤销 Blob URL，但正在 `Image.decode()` 的图片仍持有 src。现在该读取的 AbortSignal 同时清除解码图片 src 和跟踪集合，finally 移除监听；迟到解码仍不可发布到新选中项。

40 张展墙原图缓存上限、缩略图、图片身份及缓存版本戳均未改变。没有持久化数据变更或真实模型调用。

## 当次证据

隔离 Chromium + Vite 源码夹具挂载真实 GalleryView，注入 3,000 条合成记录和本地 canvas JPEG，仓库 API 读写由夹具替代。基线对照通过独立 Vite load hook 加载 git 导出的原始 useGalleryWorkspace 字节；不切换或覆盖工作树源码。

| 场景 | 基线 | 修复后 |
| --- | --- | --- |
| 首屏 3,000 条元数据 | 60 张卡片，8 个原图 URL | 60 张卡片，8 个原图 URL |
| 读取人为延迟 2 秒，滚至第 40 张再立即回顶部，120ms 后原来的 4 个请求 | 4 个均仍运行 | 4 个均已取消，无旧读取占位 |
| 分批滚动至 420 个 DOM 卡片 | 原图 URL 上限 40 | 原图 URL 上限 40 |
| KeepAlive 停用 | 原图 URL 归零 | 原图 URL 归零 |
| 手势预览解码中由第 0 张切至第 3 张 | 已 abort/revoke，src 仍为旧 blob；新回归基线失败 | src 立即清空；迟到解码不发布、不报当前图片错误 |

筛选初探 8 次（交替清空/输入匹配全库的 Synthetic）基线约 31–33ms，修复版约 27–38ms。此数据包含开发模式和夹具开销，不能视为端到端输入延迟或显著优化收益；本批不修改筛选实现。分页仍随浏览深度累积 DOM，未声称实现全库虚拟化，也未将 URL 数量换算为实际浏览器/GPU 内存。

原始材料均在工作树内被忽略的 `runtime/gallery-round9/`：

- `cancellation-comparison.json`：相同条件下旧请求状态对照，是取消收益依据。
- `baseline.json` / `after.json`：分页、筛选、缓存观测。初探在途请求采样有竞争，因此不用于精确取消率；基线退出时的 aborted 计数含夹具未解绑的已完成请求监听，不能当作取消收益。
- `preview-baseline.log`：解码中移出邻域的基线失败。
- `targeted-tests.log` / `requests-tests.log`：最终有效行为证据。四个文件共 38 项；首次 37 通过、1 个新增用例误假定夹具按 id 升序，改为使用实际展示顺序后仅补跑该文件，4/4 通过。其余 34 项复用同源码已有结果。
- `visual.json`、`wall-*.png`、`viewer-*.png`、`gesture-*.png`：双主题浏览器检查。CSS 视口 1920×1080、2560×1440、3840×2160，DPR=1、visualViewport.scale=1；关闭按钮可达，无横向溢出。标题、元数据、说明的最小对比度为 7.18:1。普通/手势预览截图已人工查看。

复现脚本保留在忽略的 `scripts/archive/gallery-round9/`。最初浏览器夹具曾因 API 路由拦截过宽和 PowerShell 导出中文源文件破坏字节而未完成；修正夹具后取得上表结果，未修改产品代码来适应这些故障。

## 验证边界与交付

- 定向行为覆盖：PhotoSwipeStage、useGalleryWorkspace、useGalleryWorkspaceRequests、useGalleryViewer，共 38 项通过；新增仅两个现有测试文件内的真实回归用例。
- 修改的四个 TS/Vue 文件 ESLint 通过；单体体量门禁通过（0 个基线豁免，500 行上限）；git diff 空白检查通过。
- 新工作树只准备一次本地 build:runtime 工具产物。没有启动 Cargo、生产前端构建、安装、签名、发布或全量测试；没有更改 main 或共享产品构建目录。
- 上述是隔离开发浏览器与合成仓库证据，尚未验收原生桌面/WebView2、系统 DPI、多千张真实原图的 GPU/进程内存或实际磁盘取消延迟。手势预加载与普通查看器是否存在重复原图读取只作后续线索，本批没有足够收益证据，不扩大修改。
- 按本次授权仅本地 commit，不合并 main、不 push。后续整合使用此分支的实际提交与上述证据，不把本报告当作发布验收。
