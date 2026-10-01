# 第一批功能流程优化

2026-10-01。首批功能提交 `d1712f5d` 基于 `dae4e161`，先独立实施、验证并推送；随后用户要求默认 Anima 统一 MiaoMiao 1.6 并整合到 main，后续范围与证据见文末。未安装桌面包。首批范围为旧作配方沿用、现有生成任务与入册事实、图库组合检索；参数矩阵、视频和无限画布未扩入。

## 已完成行为

- **配方沿用**：图库、历史与成功配方入口先选择完整配方或选择性沿用。可单选画风/光色、镜头/构图、提示词/场景、生成参数；保留未选条件以及当前角色、服装、引擎、画册。提示词输入仅在角色/服装匹配时沿用，参数仅同引擎沿用；角色 LoRA 仍由当前角色持有。显式空镜头、空构图与无风格 LoRA 可恢复，合法零值保留。取消保留草稿与导演模式；确认后进入专家模式以采用沿用/保留的参数。离开再从图库进入同一作品可重新选择。
- **恢复检查**：旧作缺失字段不补成原作事实；未知引擎、移除角色/服装或不兼容引擎拒绝完整载入。角色/服装绑定已变化的蓝图和场景不回放。原底模不一致、不可用及后端参数收敛有明确说明。原负向快照不进入自定义负面词，提示词继续按当前规则编译；比较表复用实际提交构造器。
- **任务与结果**：runtime 的正规化输入和实际 metadata 优先于当前表单；SD 恢复不重发任务，Krea 服务端追加的风格触发词不会被原请求覆盖。展示、冻结结果上下文和入册使用同一纯事实投影。确定任务失败、未知接收、停止观察分别处理；迟到取消回执不改写新成功结果。显式清除同步收件箱，迟到恢复不能填回已清除或已有新图的画布。
- **入册**：保存按任务结果身份幂等确认，保留原冻结角色、服装、场景与画册。只转换允许的生成字段，网关控制字段不进入作品记录；缺失 Seed、模型、尺寸等在持久记录和 Pinia 历史中继续缺失。旧的完整 HistoryEntry 展示格式只在返回展示边界补齐。
- **找图**：文本、标签、收藏、画册与已记录引擎、模型/checkpoint、角色内服装、精确 Seed、生成 size、候选状态组合过滤；明确提供“未记录”。成片 width/height 不代替生成 size。常用组合支持保存、同名更新、沿用、移除，保存失败可见。设置键 `aics_gallery_filter_presets_v1` 登记前端和 Rust 白名单，复用既有 profile 权威。已删除画册不误命中全库，清除条件同步 URL，分页不因 URL 自回写重复复位。查看器打开和关闭过渡时延后 URL 筛选恢复，关闭完成再应用最新条件。

这些改进参考 [InvokeAI 的图片元数据与沿用入口](https://github.com/invoke-ai/InvokeAI)、[SwarmUI 的参数分组与 Seed 微调说明](https://github.com/mcmonkeyprojects/SwarmUI/blob/master/docs/Basic%20Usage.md)、[Diffusion Toolkit 的元数据 AND 组合检索](https://github.com/RupertAvery/DiffusionToolkit/blob/master/Diffusion.Toolkit/Tips.md)，沿用 Vue/Pinia、Rust runtime、Tauri 和既有存储体系，没有新增依赖。

## 文件与集成边界

| 工作包 | 受控实现 |
| --- | --- |
| 配方与选择 | `historyRecipe.ts`、`historyReuse.ts`、`usePromptHistoryApply/Parts/Reuse.ts`、`historyReuseActions.ts`、`usePromptDeepLink.ts`、`usePromptLifecycle.ts` |
| 最小配方入口 | 新 `HistoryReuseDialog.vue`；`PromptBuilderView.vue` 仅异步组件、绑定与弹窗接线；`usePromptWorkspace.ts` 替换旧历史动作封装 |
| 任务与保存 | `runtimeTasks.ts`、`runtimeImageSession.ts`、`useAnimaSession.ts`、`useSDGenerate.ts`、`runtimeTaskResult.ts`、`saveTaskResult.ts`、`persistPromptArtwork.ts`、`sdResultActions.ts`、`usePromptSdQueue.ts`、`useTempResult.ts`、`tempResultRestore.ts` |
| 检索与偏好 | `useGalleryFilters.ts`、`galleryGenerationConditions.ts`、`useGallerySavedFilters.ts`、`galleryFilterPreferences.ts`、`storageKeys.ts`、Rust `storage/profile.rs` |
| 最小检索入口 | 新 `GalleryGenerationFilters.vue`；`GalleryView.vue` 插入可折叠入口及项目选项；`useGalleryWorkspace.ts` 只增加筛选接口和关闭后的 URL 恢复桥接 |
| 构建与验证 | Vite 既有 prompt 缓存分组登记配方选择 facade；复用相关 spec，Rust `batch_plan_profile.rs` 增补设置往返，`github-reference.spec.ts` 增补选择/取消与同作品 SPA 返回 |

UI 对话已单独推送主线 `d0c2efaf`。本功能分支没有包含该视觉实现，集成时保留其 `PromptBuilderView.vue` 最近作品抽屉及 `DirectorResultShelf @resume` 接线，再加入本批配方弹窗。`useGalleryWorkspace.ts` 的键盘即时信息抽屉改动和本批筛选/关闭桥接位于不同逻辑；两者都应保留。未改角色卡、查看器样式、动画、整体布局或设计令牌。生产角色、服装、蓝图、定稿场景及提示词数据无改动。

## 当次验证

| 证据 | 结果与范围 |
| --- | --- |
| 合批 Vitest | 15 文件 140 项通过；晚改定向 7 文件 81 项通过。不是 221 个独立测试 |
| 回归发现与修复 | 相关流程首轮 45/46，通过剩余失败定位查看器被 URL 筛选关闭；修复后图库 2 文件 29 项通过，保留既有断言并覆盖关闭后恢复。配方最终 3 文件 28 项通过 |
| 浏览器流程 | 配方选择、取消后同作品 SPA 再进入、旧配方比较及双主题初始化，3 条通过；保存组合在真实浏览器持久后重新沿用通过 |
| 桌面视觉 | Edge 154.0.4258.48；dark/light × CSS 视口 1920×1080、2560×1440、3840×2160、1100×800，共 8 组，菜单/弹窗及主要按钮可达，键盘开关、Escape 与焦点返回通过；文字对比度抽样最低 7.18:1，全局双主题令牌及 SFC 局部扫描无失败 |
| 构建与静态 | 应用与测试类型、受控 ESLint、单体 500 行门禁、领域依赖护栏通过；ESLint 零错误，图库既有测试保留四条组件/console 警告；前端构建/压缩/体积预算通过，绘制页约 139.4 KiB/140 KiB，完整静态依赖仍受原预算约束 |
| Rust | 隔离 SQLite 的既有 `batch_plan_profile` 测试增补常用组合设置重启读回，通过；恢复后的当前源码另构建 debug runtime 供隔离浏览器使用，不是 release 或桌面安装构建 |

浏览器缩放与根 CSS zoom 均为 100%，实测 innerWidth/innerHeight 与设置的 CSS 视口一致，DPR=1 仅为记录。无头环境未可靠取得系统 DPI/显示缩放，不能据本矩阵宣称物理 4K/多屏或已安装 Tauri 验收。主机只读显示查询返回了 3840×2160 和 2622×1206；不据此推断实际 CSS 工作区。

视觉 runner 首轮使用默认 5 秒等待，冷启动未及时出现配方弹窗；改为 20 秒初始化观察后完整通过，常驻 E2E 断言未放宽。新增场景模式取消覆盖时，推荐路线使当前引擎为离线 Anima；测试错误地对照了闲置 SD 的参数。改为在真实界面明确选择专家模式与 SD，再沿用并验证原 Seed/CFG 断言。此前构建预算失败均先定位加载边界并修复，未提高阈值。查看器回归的原失败日志保留。原隔离工作区在设置删除动作中被移除，完整源码快照 `94cb7199` 恢复到 `D:/CodexCaches/worktrees/workflow-recipe-recovery/AI-CG-Studio`；删除前同字节 Rust 存储证据复用，被忽略的原构建/日志未冒充仍存在。

当次新日志、截图和 JSON 在被忽略的 `runtime/feature-workflow-20261001/`；一次性视觉 runner 位于被忽略的 `scripts/archive/feature-workflow-visual-20261001.cjs`，不新增常驻测试矩阵。

## 剩余限制与停止标准

已完成所授权的实现、必要定向验证和功能分支交付。没有访问或迁移本机个人资料库，没有调用真实模型、下载模型、安装或发布桌面包。模拟任务/中性图片不证明真实 Token 与渲染效果一致，编译变化、原模型不可用及真实 Seed/图像效果仍需在获得实际模型授权后验收。原生客户端 DPI、实体键鼠/多屏、真实生成和最终集成安装仍待验证。当前绘制页包体接近既有上限，后续新增功能继续遵守预算，不据此次通过扩成全面重写。

## 后续：默认 Anima 统一 MiaoMiao 1.6 与主线整合

按用户随后要求，创作会话初值、工作室单人/热门角色推荐、热门草稿恢复，以及八个当前维护生成入口统一 `anima-miaomiao-v1.6`。对应 profile 为 `anima_miaomiao_v16`，文件为 `miaomiaoHarem_anima16.safetensors`。1.6 未就绪时保持明确离线，不把旧可用模型默认为 1.6；显式选择旧模型继续支持。Krea 与 SD 路径不改。

70 个人物分片、160 名角色默认推荐及支持列表同步，入驻默认模型与模型指南更新。逐条结构核对仅 321 个授权 JSON 字段变化，985 套服装及其余身份、prompt、蓝图、样张、参考、generatedRecipe 字段不变。聚合及 DATA_VERSION 经既有 `popular:build` 生成。模型库存、下载清单、历史作品/旧配方和按 sourceAttempt/旧图裁切固定的历史复验配置保留原模型；不是把旧出图事实改名。三项候选生成默认目录使用新的 miaomiao16 隔离路径，旧图不会自动成为本轮候选。

整合上游 `27bde11f` 时，Anima 会话轮询拆分发生内容冲突：保留主线异步轮询模块、冻结提交/原配方与高清来源能力，同时保留首批 runtime 实际元数据、身份核对与取消守卫。修复后的轮询仍拒绝其他任务 ID 的响应。后续 UI 主线按原实现整合，不用功能分支覆盖其视觉文件。

当次验证：10 个关联前端文件 80 项通过；6 个 Node 契约文件共 122 项，其中旧快照失败经定向修复后生成安全 28 项全部通过；应用/测试类型、受控 ESLint（零错误，旧脚本测试警告保留）、单体与领域护栏通过；整合前端构建及预算通过，绘制页约 139.8 KiB/140 KiB。Rust 当前源码 debug 构建通过。三个既有浏览器流程验证宁宁/夏目角色 LoRA、热门无 LoRA 的实际模拟 POST 均为 1.6，重复出图保持同一父级参数快照。

旧 payload 哈希失配定位为 `fe96ae82` 早已按用户意图删除自动壁纸说明末句；不是本次默认迁移造成。仅三个受影响旧哈希改为独立重放 `27bde11f` 的原 1.2 基线，另外七个有效哈希保持。当前模型/profile 明确断言 1.6，正规化只有授权改变的 modelId；负向、角色绑定、尺寸和采样仍受完整比较保护。未补回旧自动提示词。Anima Web 测试因异步轮询拆分补 `dynamicImportSettled` 后再推进假时钟，未提高超时；一个浏览器旧成片工具选择器改用主线现有“成片”标签并保留提示与父级请求断言。

本机只读模型盘点：1.6 权重、Qwen 编码器、VAE 都存在且与已登记大小匹配；未核对大文件 SHA、未加载/推理，不据此认证真实效果。新证据在 `runtime/miaomiao-defaults-20261001/` 和 `runtime/miaomiao-data-defaults-20261001/`，不入 Git。源码整合不代表当前安装构建已同步，本轮仍未自动下载、真实生成或安装。

最终又整合 `2fa5fde5` 的首页/发现页/导航精修，保留其原代码。最终构建、应用类型和文档链接通过；模型选择入口 dark/light × 1920×1080、2560×1440、3840×2160、1100×800 的八组 CSS 视口验证 1.6 为选中项、菜单可达、Space/Escape 与焦点返回，选中模型文字对比度最低 6.35:1。Edge 154.0.4258.48、CSS zoom/visualScale=1、DPR=1；不把 DPR 或无头视口当作原生 DPI/设备验收。

主线交付从独立工作区快进推送远端 main。原 `E:/code/2/lora/AI-CG-Studio` 的 main 工作区有另一会话未提交的图库实现，其文件、索引和本地 main HEAD 原样保留；这里没有强制 checkout、stash 或覆盖。该工作区需在其图库改动安全整合后正常对齐远端，不能将旧本地文件或已安装包称为已同步 1.6。
