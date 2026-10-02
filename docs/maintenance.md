# 场景库维护手册

场景库采用“维护页面 → 分片源文件 → 自动构建 → 浏览器产物”的结构。日常维护通过本机页面完成；底层按小文件保存，网页按需读取 core、index 与角色分组产物，完整聚合供维护和兼容读取。Rust 承担内容事务；桌面安装版使用运行目录 `content/data` 中的可写副本，不改写安装包。

## 速查表

以下是维护这个项目的常见操作。每项都可以在不懂全部代码的情况下完成。

| 我想做 | 改哪个文件 / 怎么操作 |
|---|---|
| 添加一个新场景 | 打开本机网站 → 更多 → 场景管理 → 新增场景 → 填写表单 → 保存到项目 |
| 修改某个场景的文字/标签 | 打开场景管理 → 搜索场景 → 点"编辑" → 改完后保存到项目 |
| 替换某张样张图片 | 打开场景管理 → 样张管理 → 搜索场景 → 选择新样张 |
| 修改网站整体的颜色/风格 | 打开 `src/assets/css/design-system.css`，改 `:root` 下的 `--xxx` token 值 |
| 修改设计 token 后检查遗漏 | 改完 `src/assets/css/design-system.css` 后运行 `npm run lint:colors` |
| 新建一个页面 | 新增 `src/views/*.vue` → 登记 `src/router/index.ts` → 按需更新 `src/components/AppNav.vue` |
| 导航栏里加/删/改链接 | 应用导航编辑 `src/components/AppNav.vue`；静态手册导航才使用 `tools/nav.ts` |
| 添加一个新的 tag 标签 | 打开场景管理 → Tag 管理 → 新增 Tag → 保存到项目 |
| 把场景设为精选或招牌 | 编辑场景 → 选择推荐层级 → 填写推荐理由 → 保存到项目 |
| 运行所有检查确保没问题 | 运行 `npm run wf -- gate:full`；浏览器、实际出图与桌面验收按改动另做 |
| 检查 CSS 是否有硬编码颜色 | 命令行执行 `npm run lint:colors`，输出 0 条就干净 |
| 查看备份历史 | 场景管理 → 维护工具 → 备份历史 |

网页作品备份恢复会先暂存新图片，再统一更新作品和项目；覆盖恢复保留旧原图，确认结果后可通过存储清理释放空间。清理会保护回收站、项目与当前标签页草稿引用；操作前先关闭其他创作标签页并导出备份。桌面 workspace 使用本机私库备份和恢复候选，下载的 JSON 是绑定当前 workspace 的恢复凭证；旧网页备份通过独立迁移入口处理，不能直接覆盖桌面库。当前边界见[工程契约](engineering-contracts.md#重构期间的任务与持久化边界)。

所有颜色都应该通过 `var(--xxx)` 引用设计 token，不要直接写 `#XXXXXX`。
做完任何 CSS 改动后养成运行 `npm run lint:colors` 的习惯，可以避免设计退化。

## 目录与产物

| 目录 | 职责 |
| --- | --- |
| src/ | Vue 页面、组件、状态、样式与浏览器 API |
| runtime-rs/ | Rust 网关、任务、SQLite、上游连接与内容/资源事务 |
| data/、assets/ | 创作数据源与受版本控制的展示素材 |
| desktop-tauri/ | 桌面壳、原生 Live2D 与安装器 |
| scripts/、tests/ | 工作流、维护和自动化验证 |
| docs/、plans/ | 文档分类与暂缓提案 |
| css/、tools/ | 仍被静态文档站引用的样式与辅助工具 |
| poc/ | 独立原型与比对实验，不作为生产入口 |

`dist/`、`node_modules/`、`test-results/`、`.cache/` 为本地产物，已忽略，不需要为目录美观迁动生产路径。
`runtime/` 含配置、凭据、备份、输出及运行记录；不能整体当缓存删除。
一次性脚本与本轮验收文件归入被忽略的 `scripts/archive/`。旧实验清理先用 `npm run wf -- runtime:clean --days 60` 查看白名单结果，不删除未识别目录。
静态文档页面模板仅用于 HTML 手册，不是新增应用页面的模板。

## 文件职责

代码只编辑 .ts/.mts/.cts 源码；表中的 Node/静态页脚本由 `npm run build:runtime` 生成同路径 .js/.mjs/.cjs，生成文件禁止手改。命令仍执行生成文件，注册入口为 `scripts/workflow.ts`。完整对应规则见 [TypeScript 指南](guides/engineering/typescript-development.md#编辑源码)，不另维护全仓清单。

| 编辑入口（源码或权威数据） | 职责 / 执行入口 | 维护方式 |
| --- | --- | --- |
| `data/scenes/*.json` | 场景的唯一数据源，按角色 × 系列分片；超过 `manifest.json` 的 `batchSize`（默认 50）条时自动切成 `base.N.json` 批次文件 | 否，网页维护 |
| `data/scenes/manifest.json` | 声明分片分组、顺序与 `batchSize`；批次文件由 `writeSceneShards` 自动维护，一般无需手改 | 新增角色系列时编辑 |
| `data/popular/*.json` | 热门角色唯一数据源，每个 franchise（系列）一个文件 | 是，按系列文件直接编辑 |
| `data/popular/manifest.json` | 热门角色分片清单：声明系列文件与合并顺序（首次出现顺序） | 新增系列时编辑（`popular:split` 会自动补） |
| `data/popular-characters.json` | 供静态网页读取的热门角色构建产物，由 `npm run popular:build` 从分片生成；**不入库**，网关启动/维护脚本自愈重建 | 否 |
| `data/blueprints/*.json` | 热门角色场景蓝图唯一数据源，每个 franchise 一个文件 | 是，按系列文件直接编辑 |
| `data/blueprints/manifest.json` | 热门角色场景蓝图分片清单：声明系列文件与合并顺序 | 新增系列时编辑（`blueprints:split` 会自动补） |
| `data/scene-blueprints.json` | 供静态网页与网关读取的蓝图构建产物，由 `npm run blueprints:build` 从分片生成；**不入库**，网关启动/维护脚本自愈重建 | 否 |
| `data/scenes.json`、`data/scenes-nene.json`、`data/scenes-natsume.json`、`data/scenes-shared.json`、`data/scenes-core.json`、`data/scenes-index.json` | 供网页读取的构建产物；**不入库**，由 `scripts/lib/ensure-data-build.js` 在网关启动/门禁缺失时自愈重建 | 否 |
| `data/references/<人物ID>.json`、`data/references/manifest.json` | 参考登记权威源；每个人物分片同时保存 standard 与 view，manifest 声明元数据和顺序 | 登记/同步经 `scripts/lib/reference-store.ts` 写回；改后检查参考契约并运行 `reference:build` |
| `data/character-reference-standards.json`、`data/character-reference-view.json` | 从人物分片生成的兼容聚合，**不入库**；前端懒加载 view，镜像契约由 `test-character-reference-contract.js` 核对 | 否，运行 `npm run wf -- reference:build` |
| `data/curation.json` | 精品层级、推荐理由、语义搜索和情绪入口 | 场景推荐由网页维护；搜索规则变化时编辑 |
| `scripts/lib/scene-store.ts` | 所有维护脚本共用的读写层 | 结构变化时编辑 |
| `src/utils/sceneUX.ts` | 搜索意图、相关度和本机偏好排序的共享逻辑 | 搜索规则变化时编辑 |
| `tools/nav.ts`、`tools/local-status.ts` | 静态 HTML 手册导航与轻量服务状态；不控制 Vue 应用导航 | 页面入口或服务状态契约变化时编辑 |
| `src/utils/quickCreate.ts` | 最近成功参数的规范化、存取、摘要和快速路由 | 快速创作规则变化时编辑 |
| `src/utils/storageHealth.ts`、`src/platform/desktop/backupActions.ts` | 网页存储诊断与桌面 workspace 状态/清理各自的入口 | 修改对应平台规则 |
| `src/utils/sdError.ts` | SD 错误分类、用户提示与恢复动作建议 | 出图异常或恢复策略变化时编辑 |
| `src/utils/sdRequest.ts` | 前端 SD 请求构建、扩展参数和响应解析；网关输入与上游协议在 runtime 边界另行校验 | SD 参数或扩展协议变化时编辑 |
| `src/utils/backupCore.ts`、`src/platform/desktop/backupActions.ts` | 网页备份格式/迁移规则与桌面 workspace 备份凭证/候选恢复 | 修改对应平台备份契约 |
| `src/application/artwork/artworkRepository.ts`、`src/storage/artworkRepository.ts`、`src/platform/web/`、`src/platform/desktop/` | 作品端口、当前平台委派与两种持久化适配；桌面 workspace 由 `runtime-rs/src/storage/` 管理 SQLite 和媒体文件 | 不让 View 直接绑定数据库；桌面激活后不回落写旧浏览器库 |
| `src/views/PromptBuilderView.vue`、`src/stores/promptBuilderStore.ts`、`src/components/` | 导演台编排、状态与独立生命周期组件 | 修改对应职责时编辑 |
| `runtime-rs/src/bootstrap.rs`、`runtime-rs/src/lib.rs` | 组装 Rust 网关、领域服务、中间件与静态资源 | 新增顶层能力时编辑 |
| `runtime-rs/src/config.rs`、`runtime-rs/src/security.rs` | 运行时配置、目录发现、Token 与安全响应头 | 配置项或访问策略变化时编辑 |
| `runtime-rs/src/generation/`、`images/`、`video/`、`chat/`、`voice/` | 各领域的 HTTP、输入校验、上游连接与资源生命周期；已接受持久任务由 task_runtime 持有 | API、引擎或调度行为变化时编辑 |
| `scripts/lib/content/`、`generation/`、`live2d/` | 维护工具使用的目录解析、样张参数/窄用途节点图及本地模型文件检查 | 仅用于显式工具，不承接产品服务或任务状态 |
| `src/views/ChatView.vue`、`src/composables/chat/useChatStorage.ts`、`useVoice.ts`、`useLive2D.ts` | 角色房间编排、存储、实时配音和 Live2D 生命周期 | 修改对应职责时编辑 |
| `src/assets/css/chat.css` | 角色房间独立布局、动效和响应式样式 | 只修改视觉时编辑 |

## 人物、服装与参考域的维护边界

此处补充上表，不另建一套字段契约；验证范围按 [工作流分层规则](workflow.md#门禁与构建) 选择，不因编辑档案就默认执行全部构建或参考同步。2026-09-13 的旧聚合与静态主题复核仅作历史依据。

| 域 | 维护与读取入口 | 要保留的边界 |
| --- | --- | --- |
| 人物档案 | `data/characters.json` → `src/utils/characterProfiles.ts` → CharacterView | 详情解析仅保留其显式字段；JSON 中存在 traits/visual_dna 等字段不代表详情页正在展示。保存链还会清理 lora.recommended_scene 引用 |
| 热门生成身份 | `data/popular/` 源 → popular:build → 聚合 → `src/utils/popularContent.ts` | 展示档案与生成身份用途独立；不能把两份同名字段机械合并 |
| 服装 | 热门分片 outfits，经 parseOutfit 解析；工作室服装另见 useDirectorCatalog、promptPolicy 与 promptBuilderStore | 热门服装按角色 ID + 服装 ID 定位；parseOutfit 保留 default，不保留分片 isDefault；参考 view 的 isDefault 属于另一条派生链 |
| 参考标准与视图 | `data/references/` → reference:build → standards/view 聚合；登记与旧库同步统一经 reference-store 写回分片 | 分片内保留完整 view 投影，不能只编辑旧聚合。镜像契约通过不代表图片存在或已审核 |
| 角色蓝图 | `data/blueprints/` 源 → blueprints:build → 聚合；运行时按角色解析 outfitId | UI 保存通过变更集与持久化事务同步源分片、聚合及版本；旧基线返回 409 并保留草稿，存在未恢复事务时读取拒绝半写状态。隔离验证与真实断电边界见 [当前实现](project-status.md) 和 [剩余验收](roadmap.md#后续工作流与内容数据治理) |

参考同步有实际数据写入，不能作为档案编辑后的固定必跑步骤：`sync-multi-outfit-standards.js` 根据磁盘四个参考机位是否齐全过滤热门服装，并允许角色级旧机位路径回退；在缺素材根的机器上运行可能写出空形态。名称启发式产生的 isNsfw 与该磁盘过滤是两条独立逻辑，不能据此解释某形态缺失原因。同步中的 `o.default || idx === 0` 无条件将首套标成默认；若其他服装也标 default，需检查输出是否出现双默认，不能称为“仅无标记时兜底”。

`accent_color` 由 `src/utils/characterTheme.ts` 参与运行时主题派生，已有调校例外优先，缺失或非法值回退默认强调色。`tokens.css` 保留通用派生规则，普通新角色无需新增选择器；覆盖审计识别该通用契约，但不证明颜色对比度或实际渲染。主题改动仍需双主题视觉检查。

## 角色聊天、实时语音与 Live2D

角色房间按“页面状态 → 浏览器能力控制器 → 网关路由 → 上游服务”分层：

1. `ChatView.vue` 只编排会话与用户操作；聊天记录由 `useChatStorage.ts` 统一迁移、裁剪和保存。
2. `useVoice.ts` 负责句子切分、翻译/TTS 取消、顺序播放、重播与真实音频振幅口型；不要把这些状态重新写回视图。
3. `ChatCharacterStage.vue` 与 `useLive2D.ts` 负责按需加载、尺寸观察、WebGL 丢失恢复和静态立绘回退；模型完整性由 `runtime-rs/src/live2d/` 在服务端检查。
4. Rust 的 `chat`、`voice` 和 `control` 模块分别持有 HTTP 契约、上游请求、模型切换与队列；使用隔离目录和模拟上游验证，不恢复旧 Node 服务。
5. Ollama 和 GPT-SoVITS 都必须在完整响应结束后才释放串行队列。客户端点击停止、切角色或关闭页面时，应通过 `AbortController` 一直取消到上游请求，避免后台继续占用显存。

`tools/local-status.ts` 是静态 HTML 手册共享的轻量状态入口，只探测现有
`/api/health`、`/api/chat-status`、`/api/tts-status` 和 SD 代理，不管理进程。
启动、停止和显存模式切换由 `runtime-rs/src/control/` 与控制台负责，避免
每个页面各自实现一套调度逻辑。

聊天页与导演台会在角色确定后调用 `POST /api/voice/prepare`，并行预热翻译模型和当前角色的 GPT-SoVITS 权重。一次聊天回复必须锁定同一个 `referenceEmotion` 与 `consistency: locked`，句子情绪只能驱动表情，不能逐句更换身份参考音。TTS 使用固定 seed 与完整短句非流式 WAV；客户端在当前句播放时继续生成下一句。导演台按句生成并立即播放已经完成的片段，完整 WAV 仍会在全部片段完成后提供重播与下载。

控制面板的健康检查必须等待 SD、GPT-SoVITS 与 Ollama 的实际探测结束后再返回；耗时操作通过统一 `operation` 状态公开阶段、完成或失败。任一 GPU 操作进行时拒绝重复启动另一个操作。“停止网站网关”只关闭网关与分享隧道，不能隐式关闭绘图、语音或聊天服务。

中日翻译默认使用单束搜索并批量处理句子。需要用质量换速度时可通过 `AICS_TRANSLATION_BEAMS` 调整为 `1` 至 `4`，本机实时链路建议保持 `1`。改动模型、显卡驱动或 TTS 参数后，可在网关和语音服务已启动时运行：

```powershell
npm run benchmark:voice
```

报告会分别显示翻译冷/热耗时、角色权重预热、首个音频字节、完整语音耗时，以及 WAV 时长、RMS、峰值、静音比例和质量问题。若要同时比较 GPT-SoVITS 的底层流式模式，可额外传入网关和语音服务地址：`node scripts/maintenance/benchmark-voice.js http://127.0.0.1:3000 http://127.0.0.1:9880`。延迟更低但出现静音、严重削波或异常直流偏移时不能视为优化成功。

新增角色时，静态立绘可以先工作。若要启用 Live2D，在 `assets/live2d/<角色 ID>/` 放置 `<角色 ID>.model3.json` 及它引用的全部 Moc、纹理、动作、表情和物理文件；状态接口只有在引用完整时才声明可用。没有模型的角色会明确显示“静态立绘”，不会阻断聊天或语音。

修改这些链路后按影响面选择检查；Rust 服务修改使用现行后端门禁，WAV 工具修改使用对应离线测试：

```powershell
npm run wf -- rust:check
npm run test:voice-quality
```

Rust 的聊天、语音、控制与 Live2D 既有测试使用隔离夹具检查流、切换、串行所有权、文件完整性和失败回收。`test:voice-quality` 使用合成 PCM 样本检查 WAV 解析、时长、响度、静音、削波和直流偏移；两者均不能替代真实听感或模型验收。

## 作品册

作品册由 `src/views/GalleryView.vue` 提供展览布局，通过作品 Repository 读取当前平台数据：Web adapter 使用 IndexedDB，桌面激活后由 workspace 管理私库与媒体文件。展墙按作品记录尺寸和图片解码后的真实尺寸保留比例，禁止为统一卡片高度使用 `object-fit: cover`。列表只延迟读取缩略图，进入观画模式后再加载选中作品；页面停用、卸载或切换筛选时释放高清原图与查看器 Blob URL，迟到读取不得填回旧激活代次。

修改作品册后运行受影响的现有 Gallery 组件/composable 测试，并在桌面客户端或桌面浏览器检查横图、竖图、方图、空作品册、键盘方向键和侧栏；按本次布局范围覆盖双主题、桌面窗口大小与显示缩放。

## 页面与控制逻辑边界

应用页面统一由 `src/views/*.vue` 承载，并通过路由懒加载。跨页面状态放在 Pinia store，可复用业务和生命周期放在 composable，纯规则放在 `src/utils/`；不要恢复旧 `tools/*.html` 控制器或向 `index.html` 注入全局脚本。

`npm run test:architecture` 会检查 SPA 入口、路由懒加载、SFC 结构、共享组件所有权和路由专属 CSS。新建应用页面时应把它加入 `src/router/index.ts`，并同步扩展 `scripts/tests/test-page-architecture.js`。

`npm run test:e2e` 使用本机 Chrome/Edge 或 Playwright Chromium 打开首页、导演台、场景管理、作品册、控制面板与角色房间，覆盖外部控制器加载、场景数据、作品比例、沉浸观画、首页性能预算和热页 chrome。本机可设 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 或依赖配置中的本机浏览器探测。测试产物位于 `test-results/`，仅失败诊断使用，不提交到项目。

前端由 `vue-tsc` 检查 SFC 与 TypeScript；Node 维护工具、测试和独立浏览器脚本分别使用 `tsconfig.node.json`、`tsconfig.tests.json`、`tsconfig.browser-tools.json`。`build:runtime` 只生成这三个项目的运行文件，产物被 Git 忽略；Rust 由 Cargo 检查和构建，旧 `tsconfig.runtime.json` 已删除。前端领域类型放 `src/types/`，跨端 DTO 放根目录 `types/` 或对应 runtime 纯模块。前端边界由 TypeScript AST 护栏检查，Rust 核心模块继续执行独立的依赖方向检查。

CI 在 `.github/workflows/quality.yml`：push 与 PR 分别运行静态检查、前端覆盖率与 unit、contract 和最低 Node 兼容检查；关键 Chromium e2e 等待前三个检查任务通过。各任务独立安装和构建，不能复用另一任务工作区的 dist。

`scripts/maintenance/validate-content-contracts.js` 检查角色 ID、身份锚点、肖像文件、LoRA 强度、测试场景和场景角色引用。它已进入 `npm run validate`，修改 `characters.json` 或 `loras.json` 时不再依赖人工发现引用断裂。

控制面板的操作互斥、阶段进度、完成/失败和迟到回调保护归 `runtime-rs/src/control/`；新增 GPU 操作复用现有操作身份与调度，不另建 busy 标志。聊天与语音各自持有串行任务的完整生命周期，失败或取消必须释放队列。

受限本机 HTTP 连接在 `runtime-rs/src/upstream/client.rs`，聊天个人/托管端点在 `runtime-rs/src/chat/transport.rs`；两者保留各自的地址授权、代理、超时与响应体上限。不能把公网聊天代理规则套到只允许回环地址的模型连接。

TTS 的声线校验、参考权重切换和串行合成位于 `runtime-rs/src/voice/`；翻译子进程与缓存位于其 `translation` 模块。Ollama 模型与流式对话位于 `runtime-rs/src/chat/ollama.rs`。Live2D 文件、引用及本机导入检查位于 `runtime-rs/src/live2d/`，离线导入/同步工具复用 `scripts/lib/live2d/`。这些产品模块修改后选择相应 Rust 测试；跨域整合使用 `rust:check`，不再运行已退役的 Node 后端单测。

## 真实声线基线

固定台词在 `scripts/fixtures/voice-baseline.json`（宁宁/夏目 × 日/中，默认中性），golden 指标在 `scripts/fixtures/voice-baseline-metrics.json`。离线结构与质量门：

```bash
npm run test:voice-quality
npm run test:voice-baseline
```

本机 GPT-SoVITS 与网关在线时，可捕获或对比真实生成：

```bash
VOICE_BASELINE_LIVE=1 npm run benchmark:voice-baseline
VOICE_BASELINE_LIVE=1 VOICE_BASELINE_WRITE=1 npm run benchmark:voice-baseline
```

人工听感清单（调参后勾选，不进 CI）：音色像角色？情绪对？日语可懂？无破音？无异常静音？通过后再把 metrics 的 `status` 从 `provisional` 改为 `captured`。

日常添加场景、编辑标签、调整精选层级和替换样张已经完全由场景管理页处理，不需要改代码或执行命令。新增一种角色、生成模型或新的页面布局仍属于结构变更，因为它会改变校验规则、提示词契约或服务能力，不能当成普通数据录入静默处理。

## 日常新增、修改或下架场景

日常维护不需要编辑 JSON，也不需要打开终端：

1. 通过本机控制面板打开网站，进入“更多 → 场景管理”。
2. 点击“新增场景”，或复制一个相近场景后修改。
3. 表单内保存只是暂存，可以继续检查其他场景。
4. 点击页面顶部“保存到项目”。
5. 系统会创建声明范围内的事务备份、写入分片、同步 Tag 与推荐层级，执行分级、规范化和场景编译契约校验。

页面顶部会显示待保存修改数量。标题和故事是必填项，招牌场景还必须填写推荐理由；如果带着未保存修改离开，浏览器会先提醒。检查失败时按事务声明恢复受影响文件；中断或恢复失败保留 journal 并拒绝半写内容读取，须按[恢复工作流](workflow.md#办公机工程阶段入口2026-09-15)处理。下架场景只有在点击“保存到项目”并通过校验后才生效。保存通过不代表真实画面验收。

## 替换场景样张

1. 在场景维护页打开“样张管理”。
2. 搜索并点选要替换的场景。
3. 点击“选择新样张”，选择 PNG、JPEG 或 WebP。
4. 系统会转换为高质量 JPEG，同时生成 560px 轻量缩略图，并按场景 ID 写入当前样张目录。

每次替换都会先备份旧原图、缩略图和 Manifest；任何一步失败都会恢复旧版本。写入型维护接口只允许本机访问；朋友分享链接不能修改场景或样张。

批量处理或修改数据结构时，仍可使用脚本流程：编辑 `data/scenes/*.json`，运行 `npm run scenes:normalize` 和 `npm run validate`。这不是日常维护的默认入口。

## 搜索与个人推荐

- `searchAliases` 同时承担同义词扩展和中文整句意图拆解。优先添加完整的二字以上词语；单字仅在用户独立输入时识别，避免“夏目”误命中“夏日”。
- 搜索结果先按标题、角色、情绪、地点、故事等字段的命中强度排序，再结合个人偏好和主理人精选顺序。
- 个人偏好只读取当前平台的本机作品历史，根据使用次数、五维评分、收藏和最近使用时间计算；Web 与桌面各用自己的持久权威，不上传、不新增远程追踪。
- 没有历史记录时，智能推荐会自动退回主理人精选顺序，因此新用户体验不依赖个人数据。

## 快速创作

- `quick=1` 只由用户明确点击“快速出图”产生；普通场景卡和 `generate=1` 仍只准备 Prompt，不会自动调用 SD。
- 快速模式先检测 SD，再应用 `aics_sd_last_success_v1` 中最近一次真正成功的模型与参数。失效的模型、采样器或放大器会回退到当前可用值。
- 连接失败、超时、主动停止或生成报错都不会覆盖最近成功参数，并会保留已组装的 Prompt 供手动调整。
- 快速模式不强制复用 Seed，避免连续生成完全相同的画面；固定 Seed 仍由工作台原有开关控制。

## SD 出图恢复

- 出图失败后会根据 HTTP 状态、WebUI 返回的 detail 与异常名称区分：显存不足、LoRA/模型缺失、采样器不兼容、超时、网关缺失与离线。
- 恢复动作必须由用户点击触发：降低尺寸并关闭 hires.fix、临时跳过 LoRA、改用当前模型、恢复通用采样器，或重新检测连接。
- 失败、超时和停止不会清空 Prompt、当前参数或最近成功参数；“重新检测连接”也不会自动提交新的生成任务。

## 本地备份与生成队列

- 网页备份通过 `src/utils/backupCore.ts` 声明格式与版本；合并恢复按记录 ID 去重并保留较新的记录，时间相同时备份数据优先，覆盖恢复先明确确认。旧历史继续经过已有迁移函数。
- 桌面 workspace 备份由 `src/platform/desktop/backupActions.ts` 请求 runtime 保存私库与媒体，并下载恢复凭证；恢复先创建核验候选，不将网页 JSON 直接覆盖为桌面主库。
- 网关维护备份落在 `runtime/maintenance-backups/`，每次“保存到项目”或替换样张前都会写入一份带时间戳与 label 的完整快照；场景管理 → 维护工具 → 备份历史可查看最近 50 份清单（ID / label / 创建时间 / 文件数）。
- 队列任务在加入时冻结 Prompt、负面词、角色、场景、构图、项目和 SD 参数，后续修改工作台不会污染已排队任务或其作品记录。
- 桌面 workspace 已接收的任务由 runtime 持久管理，离开页面只停止观察，明确取消经任务命令执行；接收应答丢失按稳定请求身份查询，不自动重投。Web 待办队列保存快照，恢复后暂停，用户继续后才出图；它不等同于桌面 runtime 任务。

## 从旧版场景管理器导出文件恢复

新版场景管理器可以直接保存到项目。“导出备份”主要用于额外留档。若需要从旧版导出的完整 `scenes.json` 恢复，可覆盖 `data/scenes.json` 后运行：

```powershell
npm run scenes:import
npm run validate
```

导入命令会按角色和系列重新分片，超过批次上限（50）的系列组会自动切成 `base.N.json` 批次文件。它是显式覆盖操作，不应作为日常构建命令使用。

热门角色同理：覆盖 `data/popular-characters.json` 后运行：

```powershell
npm run popular:import
npm run validate
```

导入命令会按 franchise（系列）重新分片并重建聚合。

## 通用场景补丁工具（AI / 协作者批量优化推荐）

当场景数量很多、不适合手改整个 JSON 时，使用补丁文件逐条修改：

```powershell
node scripts/maintenance/apply-scene-patch.js --patch patch.json
```

默认是 `dry-run`，只输出每条场景/蓝图的前后 diff，不写盘。确认无误后：

```powershell
node scripts/maintenance/apply-scene-patch.js --patch patch.json --apply
```

补丁文件格式：

```json
[
  { "id": "sc042", "type": "scene", "changes": { "prompt": "...", "animaCaption": "..." } },
  { "id": "raiden_shogun_tenshukaku", "type": "blueprint", "changes": { "promptProse": "...", "promptTokens": ["..."] } }
]
```

特性：
- 经典场景与热门角色蓝图统一支持
- 命中 `data/prompt-pinned-scenes.json` 的受保护字段时拒绝整批；基线缺失或损坏同样拒绝
- 写盘前自动备份到 `runtime/maintenance-backups/`
- 写盘后自动跑 `validate-scenes.js` + `validate-content-contracts.js`
- 校验失败自动回滚
- `--out report.json` 可输出完整 diff 报告，便于审阅“优化得好不好”

## 一键质量门槛

```powershell
npm run validate
```

该命令依次检查：

- 聚合文件是否与分片完全一致；
- 场景实际编译后的镜头、Prompt 与负面词契约是否一致；可选格式建议不等于必须重写正文；
- 内容分级是否与场景描写一致；
- Scene ID、角色、时间、日文叙事与角色 DNA 是否有效。
- 前端、网关和模块依赖边界及对应行为回归。
- 本地备份能否创建、迁移旧版本、合并记录并拒绝未知的新版本。

通过仅表示本次源码/产物与所选工程契约检查通过，不包含生产网页构建、真实出图、参考图片或桌面设备验收；按[分层规则](workflow.md#门禁与构建)补受影响范围。

## 维护约束

- 不直接编辑 `data/scenes.json`、`data/popular-characters.json`、`data/scene-blueprints.json`；它们是生成文件。
- 聚合产物不入库（2026-08-28 起 scenes/popular、2026-09-05 blueprints 收口，`.gitignore` 维护）：Git 只版本控制语义源（`data/scenes/`、`data/popular/`、`data/blueprints/`、`curation.json`）。产物缺失/陈旧由 `scripts/lib/ensure-data-build.js` 自愈——网关启动陈旧即重建；`scenes:build / popular:build / blueprints:build --check` 仅在产物从未构建时自建、已构建但陈旧仍报红（保留"改源忘重建"守卫）。
- 场景新增/批量改动走 `scene-store.js` 写回（自动按 50/批维护 `data/scenes/*.N.json`），热门角色新增/改动直接编辑对应 `data/popular/<系列>.json`，热门蓝图直接编辑 `data/blueprints/<系列>.json`，再运行对应 `:build`（或 `:import` 从聚合回写）。
- 新增场景：往所属系列批次文件追加（或走场景管理页面），跑 `npm run scenes:normalize` 与 `npm run validate`。
- 新增热门角色：编辑其系列文件（`data/popular/` 下），跑 `npm run popular:build` 与 `npm run validate`；新系列自动出现在分片，无需手改 manifest。
- 不在 HTML 中硬编码精选场景 ID 或情绪入口，统一写入 `data/curation.json`。
- 招牌场景必须同时存在于 `curatedSceneIds`，并在 `recommendationReasons` 中说明推荐理由。
- 新增自然语言搜索词时，在 `searchAliases` 中提供至少一组能够命中现有场景的同义词。
- 修改搜索或推荐权重时，同步扩展 `scripts/tests/test-scene-ux.js`，覆盖整句拆解、相关度和偏好排序。
- 修改快速参数格式或路由时，同步扩展 `scripts/tests/test-quick-create.js`。
- 修改 SD 错误识别或恢复动作时，同步扩展 `scripts/tests/test-sd-error.js`。
- 修改备份字段、迁移或合并规则时，同步扩展 `scripts/tests/test-data-backup.js`。
- 不把导演台的新逻辑重新堆回 `PromptBuilderView.vue`；按状态与生命周期所有权拆到 store、composable、组件或纯工具，并同步扩展 `scripts/tests/test-prompt-builder-modules.js`。
- 场景色调、镜头、光照与构图推断集中维护在 `src/utils/sceneInference.ts`，不要复制回视图或场景卡。
- 新增角色时，同时增加角色资料、对应分片、Manifest 条目和校验规则。
- 批量脚本必须通过 `scene-store.js` 写回，避免只改聚合文件。
