# 第九轮共享生命周期有界核查

## 结论与范围

本轮未在受测路径复现随反复切页增长的资源计数，因此不修改产品代码、不新增常驻测试。此结论只覆盖下述合成路由与实际 composable，不等同于整个桌面应用不存在泄漏。

- 基线：只读查询远端 main 得到 `e9adae012dfe664d51ae1ab1c22601a93a8de91a`，包含任务提示中的 `95616968`。
- 分支：`codex/round9-runtime-lifecycle-oct2`；独立目录：`runtime/worktrees/round9-runtime-lifecycle-oct2`。
- 受测实现：`useHomeRecentWorks`、`useControlStatus`、`useControlNavigation`、`useResourceLibrary`、`useScrollReveal`、`useFocusTrap`、`useImageOriginTransition`、`useCharacterPortraitTransition`、`useCharacterArtRefresh`；间接执行共享轮询和 Vue 作用域清理。
- 写入边界仅本报告和 `docs/INDEX.md`。Gallery 专属、反推、批量、画布、安装签名发布脚本与 main 均未改动。

## 方法与计数

Windows、Vitest 4.1.11、happy-dom；Vue Router 内存路由驱动实际挂载、卸载与 KeepAlive 停用/恢复。路由组件是小型组合夹具，并非完整 Home/Control/Showcase 页面。接口只返回中性合成状态与 Blob，无生产数据或模型访问。

20 轮依次进入首页预览组合、控制面板组合、缓存页组合、空页。每轮控制页推进 3 秒前台轮询，再隐藏 6 秒、恢复前台；使用假时钟，不是墙钟长跑。所有轮次结束后额外制造一个未完成原图读取，离页后才交付其结果，最后卸载应用。

计数器按 target/type/capture/callback 追踪 window、document 和合成 MediaQueryList 的监听器；独立记录已 observe 的合成 observer、BroadcastChannel 与 create/revoke Blob URL。计时器使用 Vitest 假时钟计数。observer/channel 是可计数替身，不代表浏览器底层占用。

| 观测 | 第 1 轮 | 第 20 轮 | 应用整体卸载后 |
| --- | ---: | ---: | ---: |
| 离开页面后监听器 | 14 | 14 | 0 |
| 离开页面后 timer | 0 | 0 | 0 |
| 离开页面后 observer | 0 | 0 | 0 |
| 离开页面后 Blob URL | 0 | 0 | 0 |
| 应用频道 | 1 | 1 | 0 |
| 页面滚动锁 | 已释放 | 已释放 | 已释放 |

20 轮完整样本一致。14 个监听器包含仍缓存的组件与应用监听器，不是已经卸载页面的遗留；本轮没有为追求停用时零监听器而重构有界缓存。

- 首页每次持有 3 个回退原图 URL，总计创建 60 个；每次离页均回到 0。
- 缓存页每次激活有 2 个 observer；每次停用回到 0，重新激活可恢复观察与焦点锁。
- 控制状态累计读取 60 次，资源状态累计读取 40 次；每轮前台定时读取继续发生，隐藏 6 秒期间不增长，恢复后立即读取。没有禁用必要的前台轮询或修改服务端任务。
- 迟到原图请求在离页时收到 abort；随后返回 Blob 也没有创建新的 URL。
- 初版探针只覆写 EventTarget 原型，未覆盖 happy-dom 的 window/document 实现，因此其监听器数不采用。修正为逐目标挂钩后重新采样一次，以上为修正后的结果；产品代码始终未变。

## 验证与证据

新 worktree 仅运行一次 `npm run build:runtime` 准备忽略的 Node 工具产物；未运行 Cargo、前端生产构建、安装或发布。最终计数探针 1 个用例通过，工具报告总耗时 630ms（用例 84ms）；这些是验证耗时，不是产品性能收益。

文档链接检查通过：123 文件、905 个本地链接、70 个重定向、0 断链；差异空白检查通过。

复跑命令（在上述 worktree）：

```powershell
node ../../../node_modules/vitest/vitest.mjs run --config scripts/archive/round9-lifecycle/vitest.config.mts
```

一次性探针保存在忽略的 `scripts/archive/round9-lifecycle/`，原始 20 轮 JSON 保存在该 worktree 的 `runtime/round9-lifecycle/probe.json`，均不入 Git。

- 探针 SHA-256：`249f7821802433ac51e1c15b3444eb84e7a4ddd4df88dcefbb0c4731a98a229c`。
- JSON SHA-256：`6d02de216a1266f360302f816855f3a5410f20a2faac1e1adfb2b6154c7d625a`。

## 限制

本轮没有完整页面/真实浏览器导航、WebView2 原生进程堆/显存、真实桌面宿主轮询或整机长时采样。未做深浅主题及分辨率视觉验收，因为没有 UI 改动；不能将此计数夹具用作视觉证据。也未覆盖真实出图、音频、Live2D、视频或其他并行任务的专项模块。

没有可量化的修复收益，不据代码可疑点制造问题。后续若出现原生桌面的具体增长轨迹，应按该轨迹定位，而非据本报告扩大测试矩阵或声称全站无泄漏。
