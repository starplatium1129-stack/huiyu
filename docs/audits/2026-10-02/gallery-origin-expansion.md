# Gallery 选图连续展开与收回

日期：2026-10-02。范围：选中作品的图片过渡与必要焦点恢复；不改变展墙排列、删除消散、生成画布、图片原件或导出数据。

## 整合依赖

- 工作树：`runtime/worktrees/gallery-expand-oct2`，分支 `codex/gallery-expand-oct2`。
- 开工时 main 为 `fa9bd65d`，尚未包含 `68690cb7`。本分支直接基于 `68690cb7`；整合前须保留第九轮 Gallery 修复，或先整合该提交。
- `PhotoSwipeStage.vue` 未修改；`useGalleryWorkspace.ts` 只增加离屏焦点判断。离屏预取取消、解码源释放、40 张 HD 缓存、同 ID 图片替换刷新保持原实现。
- 共享 `useImageOriginTransition` 新增可选 `proxyPixelBudget`，仅 Gallery 启用。其他调用者保留图片代理及 CORS/decode 路径；并行修改该共享文件时需合并此增量。

## 最终行为

- 卡片已有可见图片时立即作为预览展开；原图异步读取与解码完成后接替。缩略图与原图在同一 contain 区域展示，横竖比例不变。
- 原生 WAAPI 只动画单个选中图片的 transform，沿用查看器的透明度过渡。没有对所有卡片测量或执行 layout 动画，没有新增依赖。
- Gallery 过渡帧直接从已解码图片绘制到 canvas，像素预算为 1920 × 1080，且不高于源图像素。原图仍可在查看器完整显示/缩放；此上限只约束短暂过渡副本，不是整个浏览器 GPU 内存上限。
- 关闭返回对应卡片位置；原卡缺失、离屏、模糊受限或图像已缩放裁切时沿用淡出。焦点恢复仍使用 preventScroll；离屏返回目标不抢焦点。
- 快速换图/同 ID 换源会取消旧预览，避免旧图混入新图。重复 enter 回调不再重启同一动画；ESC 反向关闭、resize、reduced-motion、失效图片、deactivate/unmount 均清理过渡。canvas 释放时归零尺寸，图片代理释放 src。

## 当次验收

只使用 6 幅合成 SFW 几何图及浏览器独立存储，无生产访问、真实出图或设备安装。浏览器运行真实构建的 Gallery、ZoomableImageViewer、PhotoSwipeStage 组件。

| 检查 | 结果 |
| --- | --- |
| `typecheck:app` | 通过；先按工作流补齐 worktree 缺失的 popular 聚合数据 |
| 现有图片来源过渡、GalleryViewer、PhotoSwipeStage 单测 | 33 项通过 |
| GalleryWorkspace 与 WorkspaceRequests | 28 项通过，包含第九轮取消与缓存回归；focus mock 已更新为真实返回形状 |
| 现有 Gallery 关闭/对比/手势/反向开启浏览器用例 | 通过 |
| 新增一个 Gallery 浏览器行为用例 | 通过：冷原图先显示存储缩略图、单层有界展开、快速 ESC/切图、resize、动态/静态 reduced-motion、原卡离屏、失败图片与滚动/焦点清理 |
| 双主题视觉 | CSS 视口 1920×1080、2560×1440、3840×2160；另覆盖 1280×800 resize 和 960×700 离屏关闭。人工检查截图无拉伸与遮字，标题实测对比度 ≥4.5 |
| CSS token 对比度、定向 ESLint、500 行门禁、diff 空白检查 | 通过 |

Playwright 桌面浏览器 DPR=1、浏览器缩放=1；上述为实际 CSS 视口，不声称物理显示器/DPI 验收。4K 时采样的 canvas 像素不超过 2,073,600。两主题原尺寸截图在 `runtime/gallery-expand/browser-final/`，视频记录为 1920×1080，并不代替原尺寸截图。

原始证据位于本工作树被忽略的 `runtime/gallery-expand/`：`unit.log`、`contrast.log`、`eslint.log`、`browser-recorded.log`（其中既有关闭用例通过）、`browser-final.log`（新增用例最终通过）、`browser-final/` 截图和 `gallery-origin-desktop-demo.webm`（14.76 秒、1,826,966 字节）。临时静态夹具与配置在 `scripts/archive/gallery-expand/`，不登记为维护入口。

首次浏览器运行的录屏子进程受 sandbox EPERM 阻塞，完成授权范围内的隔离录屏重试。重试另暴露新夹具过早访问尚未迁移的 IndexedDB，已改为等待 6 张真实卡片就绪并处理事务中止，只补跑失败的新增用例；没有放宽产品断言。

## 交付与限制

- Library 已保存 `gallery-origin-desktop-demo.webm`：`libfile_357cf1d1cda08191bb52824e7f4b3bb1`，文件 `file_0000000047dc81f99a44af22f96e7cae`。本地回执为 `runtime/gallery-expand/library-receipt.json`；Windows Python 不支持 `os.setxattr`，本地扩展属性未写入，不影响 Library 文件保存。
- 未做全套测试、真实模型出图、原生桌面/WebView2 验收、系统 DPI/显示缩放实测或 GPU 内存采样；没有声称这些通过。
- 按本次明确授权仅本地提交，不合并 main、不 push、不发布、不安装。
