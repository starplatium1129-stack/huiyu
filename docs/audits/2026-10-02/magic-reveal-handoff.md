# 生成光纹与水纹归静：隔离视觉版

基线：2026-10-02 核对本地 main / origin main / 远端 main 同为 `e9adae01`。独立 worktree `runtime/worktrees/magic-reveal-oct2`，分支 `feat/magic-reveal-oct2`。不合并、不推送、不安装、不参与签名发布或共享前端构建。

## 行为与范围

- `GenerationDust.vue` 在原调用位置替换为三条低饱和手绘光纹，只用 SVG 静态路径及 CSS transform/opacity；颜色继承主题。保留已有组件入口以避开第九轮舞台/反推文件，不保留旧粒子实现。
- `CgImageReveal.vue` 默认 520ms，改为短暂水纹折射层；原始 img 全程可见，无缩放、无图片 opacity 动画。纹理取自当前图片，中央人像区域抑制位移，最大位移 1.6 CSS px，外围归零。
- 删除 `canvasGather.ts` 及旧算法用例，由 `canvasRipple.ts` 和对应资源生命周期用例接替。无 Paper/Three.js 或新增依赖；自有实现，官方 [water](https://shaders.paper.design/water) / [smoke-ring](https://shaders.paper.design/smoke-ring) 只作方向参考，未复制其源码。
- 原 Telegram 式清除、再次生成时旧图消散、Gallery、反推、任务数据流、画布尺寸及导出数据均未改动。原舞台占位退出的短暂淡出仍存在；没有添加第二套成图效果。
- 结果/请求/保存不等待动画，进度仍完全由原舞台收到的数据决定。隔离演示的 36% 是明示的固定 mock 数据。

## 预算与降级

等待光纹无 JS 帧循环。水纹只有一个短时 WebGL1 draw pass：默认 520ms、参数上限 600ms、最多 30 次绘制/秒、纹理和 backing 均不超过 600,000 像素及 960px 长边，DPR 上限 1.25。先缩小后上传，不上传全尺寸 GPU 纹理，不逐帧读回像素，不修改源图。

在 shader draw 处记录 `compositor-exempt` 原因和预算，未修改全局动画 lint 或豁免基线。清理删除 texture/buffer/program/shader、释放一次性 context、取消 RAF 并移除 canvas。两次超过 80ms 的绘制间隔会提前撤掉效果。

减少动态/低效果直接显示原图；隐藏、离屏、卸载、切图、尺寸变化及任务代次替换停止效果。WebGL 不可用、shader 失败、CORS 上传异常和 context lost 干净降级。组件现有 generation token 继续拦截迟到完成事件。

## 当次证据

一次定向 Vitest：5 文件、65 项通过，涵盖成图组件、视觉生命周期、WebGL 资源/预算/失败、原清除和舞台揭示历史。新增覆盖只针对旧测试缺少的 GPU 释放、低效降级及原图不参与动画；原生命周期断言继续复用。`typecheck:app`、`lint-animations --check`、`check-contrast --check` 和 monolith budget 均通过。随后仅调整 shader 视觉常量，最终真实浏览器编译/截图再次通过；未机械重跑整套。

真实 `DirectorStagePanel` 的前后版本在同一隔离页对照；前版来自 `e9adae01`，SFW 图片为已有 `natsume-official.webp`。所有外部请求阻断，API 被拦截，未产生模型调用。深浅主题检查等待、到达、定格、保留成图等待和清除；页面错误 0，原图 opacity 始终 1、transform 为 none，完成和卸载后无水纹 canvas。低动效也确认无水纹层。

环境：Windows、Edge 154 headless，ANGLE 报告 RTX 4070 Ti SUPER / D3D11。浏览器缩放 100%。以下是浏览器 CSS 视口/模拟 DPR，系统显示缩放未测，不能等同物理 4K 或桌面客户端验收。

| CSS 视口 | DPR | 水纹 backing | 像素 |
| --- | --- | --- | --- |
| 1100×800 | 1 | 426×624 | 265,824 |
| 1920×1080（双主题） | 1 | 576×842 | 484,992 |
| 2560×1440 | 1 | 629×920 | 578,680 |
| 3840×2160 | 1 | 629×920 | 578,680 |
| 1920×1080（高 DPI 模拟） | 2 | 640×936 | 599,040 |

原始 `report.json`、双主题 PNG、约 21 秒真实组件前后录像保存在该 worktree 被忽略的 `runtime/magic-reveal-evidence/`；一次性对照脚本在 `scripts/archive/magic-reveal-oct2/`。原始证据不入 Git。首次录制器启动因工具目录权限出现 EPERM，之后授权运行同一隔离脚本成功录制；截图产物以最终成功录制对应版本为准。

## 未验边界

这是最小视觉版。未做用户远程笔记本、原生 WebView、真实 4K 系统 DPI/缩放或持续帧耗/显存压力测试，不能据限像素设计或 headless GPU 名称宣称这些性能已经验收。未真实生图/收费，未安装、构建发布包或修改用户 main。
