# 测试精简（2026-10-02）

## 范围与结果

在已有按改动选测和 core/optional 分组之上继续删除弱断言、合并重复准备，不改产品逻辑、依赖或覆盖率门槛。本轮 13 个受控代码/清单文件净减 **468 行**，删除 **2 个测试文件**，顶层用例声明净减 **12 条**；合并保留的断言不算独有覆盖删除。其他会话的画布与 GenerationDust 改动不计入本轮。

| 范围 | 删减与保留依据 |
| --- | --- |
| `test-ux-regressions.ts` | 删除文件及 npm/清单入口。7 组 UI 检查只匹配函数、变量、类名或模板写法，不能证明粘贴、标签关联、输入归一化、首次引导及提交前校验实际可用；不再将它们作为 UX 验收。唯一真实的 `presets.model_profiles` 默认关闭高清修复约束迁入现有 `test-prompt-builder-modules.ts`，没有丢失数据保护。 |
| `test-page-architecture.ts` | 净减 144 行：去掉模块存在清单、数量下限、组件名、退役选择器、精确动效写法与情绪源码枚举。保留 CSP、非空路由扫描、动态导入、路由 CSS 隔离/命名空间及字体来源。类型检查验证真实依赖，统一动效扫描与交互测试继续存在；不声称现有情绪行为测试已完整覆盖五种情绪。 |
| `test-live2d-backend.ts` | 删除只创建本文件 stub 再检查其方法存在的自证用例；实际生产后端的取消、事件订阅释放、迟到响应、FPS 与销毁行为全部保留。 |
| `RouteAtmosphere.spec.ts` | 删除只锁类名和节点形状的文件；`a11y-device.spec.ts` 保留真实浏览器 ARIA、pointer-events、减弱动效检查。 |
| `characterTheme.spec.ts` | 删除固定 162 角色输出 SHA256 的历史拆分验收快照；保留主题优先级、非法颜色回退、DOM token 清理，以及既有双主题 `check-contrast` 门禁。 |
| `CgImageReveal.spec.ts` / `ZoomableImageViewer.spec.ts` | 点击和即时缩略图断言并入既有呈现/解码例，减少重复挂载；图像错误由已有 `aiVisualLifecycle.spec.ts` 的动画停止、错误事件和迟到完成忽略用例承接。 |
| `atelier-design.spec.ts` | 7→3：快速反向选择由 `detail-polish` 更强的动态几何检查承接，导览 Escape 由 `navigation-popover` 承接；减弱动效并入同页用例；角色身份、解码和图注迁入现有 `particle-atmosphere`。 |
| `a11y-device.spec.ts` | 5→4：首页地标全部断言并入导航流程，省去一次相同首页加载。静态氛围、404 标题、画廊焦点用例保留。 |

没有为了凑删除数量移走有效断言、放宽门槛、增加 skip 或新建测试套件。`ui-finish` 的按钮关闭与 Escape 属于不同交互，复核后完整保留。上述源码字符串检查退出后，真实页面体验仍需对应行为/浏览器验收，不能用剩余静态 PASS 代替。

## 验证

- `npm run build:runtime` 成功，自动清理已删除测试的生成入口；没有手改生成 `.js`。
- 定向前端 **4 文件 / 36 项通过**（3 个存留修改文件及承接错误生命周期的 `aiVisualLifecycle`）；受控前端 ESLint 通过。
- 定向 Node **43 项**：初轮 42 通过，1 项因进程 PATH 找不到 Git Bash 未能启动；临时把已有 Git Bash 加入当前命令 PATH 后，仅重跑该项并通过。清单唯一登记、架构、Live2D、目录数据、E2E 分组及体量检查均保留有效结果；没有声称初轮整批 PASS。
- `typecheck:tests`、`typecheck:app` 通过；Node 修改文件 ESLint 0 错误、55 条既有 `any` 警告。
- 隔离 Rust web 栈的 Playwright **9 项通过，21.6 秒，退出码 0**：`atelier-design` 3、`particle-atmosphere` 1、`a11y-device` 2（地标导航与静态氛围）、`detail-polish` 1、`navigation-popover` 2（双主题）。复用已有 dist/Rust EXE，未跑未修改的 404/画廊例。首轮没有完整保存 runner 输出，不能据终态文件虚报逐项结果；仅为补齐该证据缺口重跑最终相关 9 项，完整输出保存为 `e2e.log`。
- 受控文件 `git diff --check` 通过；文档检查 133 文件、929 本地链接，0 断链。

原始 Node 输出放在忽略目录 `runtime/test-pruning-20261002/`。前端与 E2E 修改仅涉及测试，未新增桌面分辨率/主题矩阵；没有真实模型、GPU 设备、安装发布或全量门禁验收。未做同机独占的前后耗时对照，不宣称固定提速百分比；本轮可确认减少重复挂载/导航和约束实现拼写的维护成本。

## 日常使用

继续使用 `npm test` 按 Git 改动选测，或精确运行相关前端/Node/浏览器文件。跨领域集成再使用 `gate:full`，显式全部库存使用 `validate:all`。现有入口及失败回退策略不变，详情见 [工作流的分层选择](../../workflow.md#按改动选择检查)。
