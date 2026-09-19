# 可维护性试点边界

本页规定作品历史、提示词工作台和观画适配的维护入口。当前实施和验收见 [项目状态](../../project-status.md)，待验事项见 [roadmap](../../roadmap.md)，固定基线审查见 [M01–M10](../../research/engineering/maintainability-optimization-2026-09-19.md)。

## 历史与工作台依赖

以下根据试点实际 import 核对，区分运行时与纯类型引用；不是全仓循环依赖或性能结论。

| 公开入口 | 内部依赖 / 所有权 | 对应回归 |
| --- | --- | --- |
| promptHistoryStore | 从 KV 读取 ArtworkRecord[]，调用 artworkRepository 软删/恢复；持有读取代际；不声明旧作品具有完整配方 | promptHistoryStore.spec、artworkRepository.test |
| promptBuilderStore | 复用 historyStore 的同一 ref；新作品由 commitHistoryEntry 组装，经 artworkRepository 写入；追加返回未知旧记录，重新解析列表 | promptBuilderStore.spec、test-storage-repositories |
| types/promptHistory | 新生成记录、角色和工作台选择的纯类型；store 保留兼容转导出 | typecheck:app / typecheck:tests |
| historyRecipe → usePromptHistoryApply | 只读校验投影，不写回数据库；无效引擎拒绝覆盖草稿，旧缺字段保留缺失并显示检查说明；合法零值与原 ID 保留 | historyRecipe.spec、usePromptHistoryApply.spec、usePromptDeepLink.spec |
| generationApi → generationResponse → generationTask | 统一客户端负责传输，解码器检查业务字段，generationTask 唯一映射 UI 阶段；非空未知阶段保持 unknown，未知进度保持 null | generationApi.spec、generationTask.spec、test-api-client |

纯类型允许 import type 引用现有兼容入口；没有证据表明纯计算依赖了 store 的运行时常量，因此本轮不移动提示词映射和编译常量。

ESLint 的 huiyu/module-boundaries 对以下方向执行检查：types 与 historyRecipe/generationTask/promptPolicy 不得运行时加载页面、状态或浏览器服务；storage 不得反向加载页面/组件/store；PhotoSwipe 依赖（含类型）只能从 PhotoSwipeStage 引用。规则解析普通导入、再导出、动态 import、require 和 TS import-equals，统一别名与相对路径；试点底层的非字面量加载拒绝检查绕过。test-module-boundaries 用允许/禁止夹具验证。它不检查任意 eval、运行时加载器或未纳入试点的全仓依赖图。

## 资源所有权

| 资源 | 唯一拥有者 / 停止动作 | 保持的语义 |
| --- | --- | --- |
| PhotoSwipe 实例、ResizeObserver、解码元素 | PhotoSwipeStage；列表重建和卸载统一 dispose，过期事件/解码不得发布 | 初始化失败通知 Gallery 回退；每个自建 URL 只回收一次；外部 HTTP 图片不回收 |
| Gallery 外层 dialog、键盘、焦点、滚动锁 | Gallery 原有组合逻辑 | 业务收藏/删除/Remix 使用稳定作品身份，适配器只发送索引变化及错误 |
| 语音翻译、预热、播放等待、口型帧 | useVoice 的 session / AbortController / 播放取消句柄 | stop、切角、destroy 分别沿用原行为；等待 Promise 必须结束 |
| KeepAlive 可见性、激活、停用、卸载 | 各页面既有生命周期 owner | 暂停可见性任务不清草稿，不取消真实生成任务 |
| Live2D 双后端 | 现有 destroyRuntime | 唯一销毁入口、Pixi-first 顺序与 capability 分支不变 |

PhotoSwipeStage.spec 覆盖迟到解码、A→B→A 的迟到读取、失败、部分初始化与准确释放次数；useVoice.spec 保留取消播放 Promise、旧轮次错误和预热代际的行为回归。未提取通用生命周期框架。

## PhotoSwipe 适配契约与退出

默认仍是 ZoomableImageViewer，PhotoSwipe 5.4.4 由用户显式开启。PhotoSwipeStage 的 props 仅为作品列表与 index，事件为 change/error；依赖类型和实例不得进入作品仓储、配方、收藏或任务中心。

升级先执行适配组件模拟故障测试，再运行 github-reference.spec 的真实库浏览器流程（双主题缩放、切图、焦点、滚动锁、20 次开关、DOM/Blob URL 趋势）。模拟测试不代替真实库集成；浏览器 CDP 双指不代替实体触屏或 Tauri/GPU 验收。缺少这些目标设备证据时不得默认替换查看器。

若出现无法修复的焦点/键盘冲突、稳定身份错配、资源增长或目标设备手势倒退，保持原查看器并撤回试验接线：Gallery 的开关、异步组件及事件绑定，PhotoSwipeStage 及专属测试，package/lock 中的 photoswipe 与对应独占规则。许可证继续使用现有 [第三方声明](../../../public/licenses/PhotoSwipe.txt)，不另建账本。

## 测试职责与报告

路由 import 关系改为 TypeScript AST 检查，局部重命名、注释和提取加载 helper 不影响断言；页面标题由 a11y-device.spec 的实际可访问一级标题检查，覆盖原静态测试的所有页面。ManagedDrawingRouteCard 的旧事件签名字串断言由组件点击测试替代，验证数字/字符串 ID 原样发出且忙碌时禁用。CSP、定稿字节基线和动画策略静态门禁保留。删除的标题源码断言由这条浏览器测试承接，不再维护 ControlIntro 的专例。

质量元数据附在既有 quality-test-inventory：试点记录域、环境、并行安全、资源和可选单文件超时，未审查项明确 unreviewed，不能据此并行；已审核契约的资源与并行声明直接复用 contract-test-policy，避免与同期 main 合入的进程池规则重复。保留同期 main 已合入的有限并行进程池，本轮接入逐文件超时与报告，不另建调度框架，不统一提高超时，也不共享 CI 构建产物。

设置 AICS_TEST_REPORT_DIR 后，现有质量执行器保存逐文件 JSON 和原始日志；fail-fast 后的项目标记 not-run，退出失败区分 assertion/typecheck/build/timeout/environment/signal/process。Node 输出中的 skipped/cancelled 数量保留在 counts；定向重跑只代表本轮选择范围。unit 仍是现有 Node 并发聚合，报告如实标为 aggregate，不伪造逐文件耗时。

这些文件是 [capture:delivery / audit:delivery](../../workflow.md#办公机工程阶段入口2026-09-15) 的输入日志：执行前捕获源/构建身份，执行后在原有结果 JSON 的对应门禁字段填实际 status 与 log/transcript/report 路径，并携带 baselineSha256，再绑定 baseline/record。suite JSON 本身不是交付认证，不自动覆盖先前失败或未运行状态。

失败分类是诊断提示，原始退出码和日志仍须保留。各 CI job 继续独立构建，并上传质量诊断。先保留本次耗时、缓存命中/重建输出和产物尺寸；CI 跨机上传/下载体积、缓存命中率与墙钟收益仍需同口径实测，当前不承诺提速或启用跨 job 缓存复用。

## 回退

文档校准可独立回退；历史类型/解析改动不迁移数据；API 解码可独立撤回，不回退统一客户端；静态规则/测试报告及最低 Node CI 单独回退不影响运行时；PhotoSwipe 始终有原查看器可用。回退资源清理改动前先保留本次迟到回调回归，避免重新引入重复释放。

