# 可维护性试点边界

本页规定作品历史、提示词工作台和观画适配的维护入口，按当前平台边界更新。当前实施和验收见 [项目状态](../../project-status.md)，待验事项见 [roadmap](../../roadmap.md)，旧阶段证据由 Git 历史保存。

## 历史与工作台依赖

以下根据试点实际 import 核对，区分运行时与纯类型引用；不是全仓循环依赖或性能结论。

| 公开入口 | 内部依赖 / 所有权 |
| --- | --- |
| promptHistoryStore | 经 artworkRepository 读取 ArtworkRecord[]、项目及软删/恢复；平台适配选择 Web 或桌面 workspace；持有读取代际，不声明旧作品具有完整配方 |
| promptBuilderStore | 保留创作状态和兼容接口；草稿、筛选和作品持久化分别经 usePromptDraft / usePromptSceneFilters / usePromptArtworkHistory；后者复用 historyStore 同一 ref |
| types/promptHistory | 新生成记录、角色和工作台选择的纯类型；store 保留兼容转导出 |
| historyRecipe → usePromptHistoryApply | 只读校验投影，不写回数据库；无效引擎拒绝覆盖草稿，旧缺字段保留缺失并显示检查说明；合法零值与原 ID 保留 |
| generationApi → generationResponse → generationTask | 统一客户端负责传输，解码器检查业务字段，generationTask 唯一映射 UI 阶段；非空未知阶段保持 unknown，未知进度保持 null |

前端纯类型可按既有规则使用现存转导出入口；runtime 不得反向依赖 `src/`，包括纯类型和间接边。应用用例通过端口与平台适配连接，不能从纯计算层引入 Store 或具体持久化实现。

`types/promptHistory`、`types/artwork`、`types/generation`、`types/anima` 和 `utils/resultContext` 的可达依赖连类型边也不引用 Store、展示层或 Vue。按源码调用关系审查；已无调用方的独立扫描器和豁免清单已移除。

现行 [ESLint 规则](../../../scripts/lib/module-boundaries.mts) 约束 application、types、resultContext 与 historyRecipe/generationTask/promptPolicy/promptCatalog：包括纯类型在内的直接依赖不得指向页面、状态或浏览器服务；application 另不得加载平台适配或 Node 模块。storage 不反向加载页面、组件或 Store；PhotoSwipe 依赖（含类型）只从 PhotoSwipeStage 引用。规则解析普通导入、再导出、动态 import、require 和 TS import-equals；间接依赖仍按源码调用关系审查。仓库禁止编写和运行测试，见 [AGENTS.md](../../../AGENTS.md)。

## 资源所有权

生成作品保存由 `src/application/artwork/saveGeneratedArtwork.ts` 承担编排，`usePromptArtworkHistory` 注入图片、缩略图、测量、ID、暂存和 Repository 能力，成功后更新显示。用例及其可达依赖不直接绑定具体存储/API 或 Node 平台实现。保存输入在异步工作开始前复制；runtime 任务另在接收时保存输入与结果上下文，两者是各自独立的快照边界。写入应答丢失时按作品身份读回，无法确认提交则保留媒体并报告未知，不能误当回滚成功。当前任务与持久化边界见[工程契约](../../engineering-contracts.md#重构期间的任务与持久化边界)。

WAI HTTP、参数校验和任务执行位于 `runtime-rs/src/generation/`；图片引擎、公共执行契约与存储保持单向依赖。旧 Node HTTP 路由与服务已退役，离线样张工具仅保留 `scripts/lib/generation/` 中实际使用的参数、目录与窄用途节点图。工作台不得直接导入持久化/传输实现，草稿与筛选适配不得反向加载 Store 或作品服务；按源码审查，保留现行 ESLint 约束。

| 资源 | 唯一拥有者 / 停止动作 | 保持的语义 |
| --- | --- | --- |
| PhotoSwipe 实例、ResizeObserver、解码元素 | PhotoSwipeStage；列表重建和卸载统一 dispose，过期事件/解码不得发布 | 初始化失败通知 Gallery 回退；每个自建 URL 只回收一次；外部 HTTP 图片不回收 |
| Gallery 外层 dialog、键盘、焦点、滚动锁 | Gallery 原有组合逻辑 | 业务收藏/删除/Remix 使用稳定作品身份，适配器只发送索引变化及错误 |
| 语音翻译、预热、播放等待、口型帧 | useVoice 的 session / AbortController / 播放取消句柄 | stop、切角、destroy 分别沿用原行为；等待 Promise 必须结束 |
| KeepAlive 可见性、激活、停用、卸载 | 各页面既有生命周期 owner | 暂停可见性任务不清草稿，不取消真实生成任务 |
| Live2D 双后端 | 现有 destroyRuntime | 唯一销毁入口、Pixi-first 顺序与 capability 分支不变 |

资源审查核对迟到解码、A→B→A 的读取代际、失败与部分初始化清理，以及播放取消后的 Promise 收束；不恢复旧 spec，不提取通用生命周期框架。

## PhotoSwipe 适配契约与退出

默认仍是 ZoomableImageViewer，PhotoSwipe 5.4.4 由用户显式开启。PhotoSwipeStage 的 props 仅为作品列表与 index，事件为 change/error；依赖类型和实例不得进入作品仓储、配方、收藏或任务中心。

升级先审查适配器的初始化、身份和释放路径，再按影响人工核对双主题缩放、切图、焦点、滚动锁与资源趋势。浏览器操作不能代替实体触屏或 Tauri/GPU 验收。缺少目标设备证据时不得默认替换查看器。

若出现无法修复的焦点/键盘冲突、稳定身份错配、资源增长或目标设备手势倒退，保持原查看器并撤回试验接线：Gallery 的开关、异步组件及事件绑定、PhotoSwipeStage、package/lock 中的 photoswipe 与对应独占规则。许可证继续使用现有 [第三方声明](../../../public/licenses/PhotoSwipe.txt)，不另建账本。

## 审查与验证职责

源码和差异审查负责依赖方向、数据转换、任务身份与资源所有权；按需运行类型检查、产品构建和现有维护校验。页面标题、控件状态、键鼠与弹层可达性按受影响页面人工核对，源码规则不代替实际画面。CSP、定稿字节基线和动画约束继续保留，不恢复已删除的测试入口。

复用相同源码、配置、产物与环境的有效证据，聊天中明确未运行、失败和设备待验范围。不编写报告文件，不以历史成功记录覆盖当前失败或未运行项。

首次失败读取原始日志，区分本次缺陷、环境问题和尚未定位的原因；没有相关修复或新证据不重复命令。构建和安装身份独立核对，类型检查或构建成功不代表实际设备行为已经验收。

## 回退

文档校准可独立回退；历史类型/解析改动不迁移数据；API 解码可独立撤回，不回退统一客户端；静态规则可单独撤回，PhotoSwipe 始终有原查看器可用。回退资源清理改动前复核迟到回调和释放所有权，避免重新引入重复释放。
