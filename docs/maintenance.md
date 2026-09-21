# 场景库维护手册

场景库采用“维护页面 → 分片源文件 → 自动构建 → 浏览器产物”的结构。日常维护通过网页完成；底层仍按小文件保存，网页继续读取一个兼容的聚合文件。

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

本地作品备份恢复会先暂存新图片，再统一更新作品和项目；覆盖恢复保留旧原图，确认结果后可通过存储清理释放空间。清理会保护回收站、项目与当前标签页草稿引用；操作前先关闭其他创作标签页并导出备份。失败时保留恢复候选，可重试；细节及设备验收边界见[剩余功能升级记录](archive/audits/remaining-features-upgrade-2026-09-10.md)。

所有颜色都应该通过 `var(--xxx)` 引用设计 token，不要直接写 `#XXXXXX`。
做完任何 CSS 改动后养成运行 `npm run lint:colors` 的习惯，可以避免设计退化。

## 目录与产物

| 目录 | 职责 |
| --- | --- |
| src/ | Vue 页面、组件、状态、样式与浏览器 API |
| server/、routes/、services/ | 网关基础能力、HTTP 路由和服务逻辑 |
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
| `data/scenes.json`、`data/scenes-nene/natsume/shared.json`、`data/scenes-core.json`、`data/scenes-index.json` | 供静态网页读取的构建产物；**不入库**（2026-08-28 起），由 `scripts/lib/ensure-data-build.js` 在网关启动/门禁缺失时自愈重建 | 否 |
| `data/character-reference-standards.json` | 角色 × 多服装 4 视角参考标准的手写权威源；结构契约 `scripts/contracts/character-reference-standards.schema.json`（ajv，`test:contract` 阶段校验） | 是，改后跑 `node scripts/tests/test-character-reference-contract.js` |
| `data/character-reference-view.json` | 前端懒加载的参考档案视图；视角字段必须逐字段镜像 standards，由同一契约测试交叉校验（漂移即红） | 否，改 standards 后同步此文件 |
| `data/curation.json` | 精品层级、推荐理由、语义搜索和情绪入口 | 场景推荐由网页维护；搜索规则变化时编辑 |
| `scripts/lib/scene-store.ts` | 所有维护脚本共用的读写层 | 结构变化时编辑 |
| `src/utils/sceneUX.ts` | 搜索意图、相关度和本机偏好排序的共享逻辑 | 搜索规则变化时编辑 |
| `tools/nav.ts`、`tools/local-status.ts` | 静态 HTML 手册导航与轻量服务状态；不控制 Vue 应用导航 | 页面入口或服务状态契约变化时编辑 |
| `src/utils/quickCreate.ts` | 最近成功参数的规范化、存取、摘要和快速路由 | 快速创作规则变化时编辑 |
| `src/utils/storageHealth.ts` | 历史损坏、缺图、孤立图和容量诊断 | 存储体检规则变化时编辑 |
| `src/utils/sdError.ts` | SD 错误分类、用户提示与恢复动作建议 | 出图异常或恢复策略变化时编辑 |
| `src/utils/sdRequest.ts` | 浏览器与维护脚本共用的 SD 请求构建、扩展参数和响应解析 | SD 参数或扩展协议变化时编辑 |
| `src/utils/backupCore.ts` | 本地备份格式、版本迁移、校验与合并规则 | 备份结构变化时编辑 |
| `src/views/PromptBuilderView.vue`、`src/stores/promptBuilderStore.ts`、`src/components/` | 导演台编排、状态与独立生命周期组件 | 修改对应职责时编辑 |
| `server.ts`（运行 `server.js`） | 只负责组装网关、中间件、静态资源、SD 代理和进程启动 | 新增顶层能力时编辑 |
| `server/config.ts`、`server/security.ts`（运行对应 .js） | 运行时配置、目录发现、Token 与安全响应头 | 配置项或访问策略变化时编辑 |
| `routes/*.ts`（运行对应 .js） | HTTP 输入校验、响应格式与客户端断开处理 | API 契约变化时编辑 |
| `services/*.ts`（源码）/ `*.js`（编译产物） | Ollama、翻译、GPT-SoVITS、Live2D 检查及串行资源调度 | 上游协议或调度策略变化时编辑 |
| `src/views/ChatView.vue`、`src/composables/chat/useChatStorage.ts`、`useVoice.ts`、`useLive2D.ts` | 角色房间编排、存储、实时配音和 Live2D 生命周期 | 修改对应职责时编辑 |
| `src/assets/css/chat.css` | 角色房间独立布局、动效和响应式样式 | 只修改视觉时编辑 |

## 人物、服装与参考域的维护边界

2026-09-13 按实际解析和写入链核对。此处补充上表，不另建一套字段契约；验证范围仍按 [工作流分层规则](workflow.md#门禁与构建) 选择，不因编辑档案就默认执行全部构建或参考同步。

| 域 | 维护与读取入口 | 要保留的边界 |
| --- | --- | --- |
| 人物档案 | `data/characters.json` → `src/utils/characterProfiles.ts` → CharacterView | 详情解析仅保留其显式字段；JSON 中存在 traits/visual_dna 等字段不代表详情页正在展示。保存链还会清理 lora.recommended_scene 引用 |
| 热门生成身份 | `data/popular/` 源 → popular:build → 聚合 → `src/utils/popularContent.ts` | 展示档案与生成身份用途独立；不能把两份同名字段机械合并 |
| 服装 | 热门分片 outfits，经 parseOutfit 解析；工作室服装另见 useDirectorCatalog、promptPolicy 与 promptBuilderStore | 热门服装按角色 ID + 服装 ID 定位；parseOutfit 保留 default，不保留分片 isDefault；参考 view 的 isDefault 属于另一条派生链 |
| 参考标准与视图 | standards/view；写入者包括 sync-multi-outfit-standards 和 register-pending-reference-outfits | view 是合并投影且登记器会写入，不是纯覆盖产物。镜像契约通过不代表图片存在或已审核 |
| 角色蓝图 | `data/blueprints/` 源 → blueprints:build → 聚合；运行时按角色解析 outfitId | UI 保存通过变更集与持久化事务同步源分片、聚合及版本；旧基线返回 409 并保留草稿，存在未恢复事务时读取拒绝半写状态。隔离验证与真实断电边界见 [当前实现](project-status.md) 和 [剩余验收](roadmap.md#后续工作流与内容数据治理)；旧风险证据保留在 [历史复核](archive/audits/asset-document-review-2026-09-13.md) |

参考同步有实际数据写入，不能作为档案编辑后的固定必跑步骤：`sync-multi-outfit-standards.js` 根据磁盘四个参考机位是否齐全过滤热门服装，并允许角色级旧机位路径回退；在缺素材根的机器上运行可能写出空形态。名称启发式产生的 isNsfw 与该磁盘过滤是两条独立逻辑，不能据此解释某形态缺失原因。同步中的 `o.default || idx === 0` 无条件将首套标成默认；若其他服装也标 default，需检查输出是否出现双默认，不能称为“仅无标记时兜底”。

`accent_color` 有机器读取者：覆盖审计 `report-content-coverage.js` 将其带入缺主题报告，但不与 tokens.css 比对。主题渲染以实际 CSS 为准；不同颜色值不能直接判为数据冲突。更多已核实范围与未验收项见 [盘点复核](archive/audits/asset-document-review-2026-09-13.md)。

## 角色聊天、实时语音与 Live2D

角色房间按“页面状态 → 浏览器能力控制器 → 网关路由 → 上游服务”分层：

1. `ChatView.vue` 只编排会话与用户操作；聊天记录由 `useChatStorage.ts` 统一迁移、裁剪和保存。
2. `useVoice.ts` 负责句子切分、翻译/TTS 取消、顺序播放、重播与真实音频振幅口型；不要把这些状态重新写回视图。
3. `ChatCharacterStage.vue` 与 `useLive2D.ts` 负责按需加载、尺寸观察、WebGL 丢失恢复和静态立绘回退；模型完整性由 `services/live2d-service.js` 在服务端检查。
4. `routes/` 只处理 HTTP 契约。上游请求、模型切换和 GPU 队列统一留在 `services/`，方便使用模拟上游做测试。
5. Ollama 和 GPT-SoVITS 都必须在完整响应结束后才释放串行队列。客户端点击停止、切角色或关闭页面时，应通过 `AbortController` 一直取消到上游请求，避免后台继续占用显存。

`tools/local-status.ts` 是静态 HTML 手册共享的轻量状态入口，只探测现有
`/api/health`、`/api/chat-status`、`/api/tts-status` 和 SD 代理，不管理进程。
启动、停止和显存模式切换仍由 `routes/control.js`、共享服务与控制台负责，避免
每个页面各自实现一套调度逻辑。

聊天页与导演台会在角色确定后调用 `POST /api/voice/prepare`，并行预热翻译模型和当前角色的 GPT-SoVITS 权重。一次聊天回复必须锁定同一个 `referenceEmotion` 与 `consistency: locked`，句子情绪只能驱动表情，不能逐句更换身份参考音。TTS 使用固定 seed 与完整短句非流式 WAV；客户端在当前句播放时继续生成下一句。导演台按句生成并立即播放已经完成的片段，完整 WAV 仍会在全部片段完成后提供重播与下载。

控制面板的健康检查必须等待 SD、GPT-SoVITS 与 Ollama 的实际探测结束后再返回；耗时操作通过统一 `operation` 状态公开阶段、完成或失败。任一 GPU 操作进行时拒绝重复启动另一个操作。“停止网站网关”只关闭网关与分享隧道，不能隐式关闭绘图、语音或聊天服务。

中日翻译默认使用单束搜索并批量处理句子。需要用质量换速度时可通过 `AICS_TRANSLATION_BEAMS` 调整为 `1` 至 `4`，本机实时链路建议保持 `1`。改动模型、显卡驱动或 TTS 参数后，可在网关和语音服务已启动时运行：

```powershell
npm run benchmark:voice
```

报告会分别显示翻译冷/热耗时、角色权重预热、首个音频字节、完整语音耗时，以及 WAV 时长、RMS、峰值、静音比例和质量问题。若要同时比较 GPT-SoVITS 的底层流式模式，可额外传入网关和语音服务地址：`node scripts/maintenance/benchmark-voice.js http://127.0.0.1:3000 http://127.0.0.1:9880`。延迟更低但出现静音、严重削波或异常直流偏移时不能视为优化成功。

新增角色时，静态立绘可以先工作。若要启用 Live2D，在 `assets/live2d/<角色 ID>/` 放置 `<角色 ID>.model3.json` 及它引用的全部 Moc、纹理、动作、表情和物理文件；状态接口只有在引用完整时才声明可用。没有模型的角色会明确显示“静态立绘”，不会阻断聊天或语音。

修改这些链路后至少运行：

```powershell
npm run test:chat
npm run test:resource
npm run test:voice-quality
```

`test:chat` 会使用模拟 Ollama 与 GPT-SoVITS 检查 NDJSON 分片恢复、模型切换卸载、完整音频结束前不换权重、Live2D 文件完整性，以及网关实际启动和安全响应头。`test:voice-quality` 使用合成 PCM 样本检查 WAV 解析、时长、响度、静音、削波和直流偏移。

## 作品册

作品册由 `src/views/GalleryView.vue` 提供展览布局，`useKVStore` 与 `useImageStore` 负责 IndexedDB 数据。展墙按作品记录尺寸和图片解码后的真实尺寸保留比例，禁止为统一卡片高度使用 `object-fit: cover`。列表只延迟读取缩略展示，进入观画模式后再加载选中作品；离开页面或切换筛选时必须释放 Blob Object URL。

修改作品册后至少运行 `npm run test:gallery`，并分别检查横图、竖图、方图、空作品册、键盘方向键、侧栏和移动端两列布局。

## 页面与控制逻辑边界

应用页面统一由 `src/views/*.vue` 承载，并通过路由懒加载。跨页面状态放在 Pinia store，可复用业务和生命周期放在 composable，纯规则放在 `src/utils/`；不要恢复旧 `tools/*.html` 控制器或向 `index.html` 注入全局脚本。

`npm run test:architecture` 会检查 SPA 入口、路由懒加载、SFC 结构、共享组件所有权和路由专属 CSS。新建应用页面时应把它加入 `src/router/index.ts`，并同步扩展 `scripts/tests/test-page-architecture.js`。

`npm run test:e2e` 使用本机 Chrome/Edge 或 Playwright Chromium 打开首页、导演台、场景管理、作品册、控制面板与角色房间，覆盖外部控制器加载、场景数据、作品比例、沉浸观画、首页性能预算和热页 chrome。本机可设 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 或依赖配置中的本机浏览器探测。测试产物位于 `test-results/`，仅失败诊断使用，不提交到项目。

前端由 `vue-tsc` 检查 SFC 与 TypeScript；网关运行时模块由 `tsconfig.runtime.json` 编译为同目录 `.js`/`.d.ts`，这些产物被 Git 忽略，不提交。新增共享契约时优先定义在生产模块旁或 `src/types/`，测试直接加载生产 TypeScript，不再维护 JavaScript 测试副本。

CI 在 `.github/workflows/quality.yml`：push 与 PR 执行 `npm ci` → `npm run validate` → Playwright Chromium e2e。

`scripts/maintenance/validate-content-contracts.js` 检查角色 ID、身份锚点、肖像文件、LoRA 强度、测试场景和场景角色引用。它已进入 `npm run validate`，修改 `characters.json` 或 `loras.json` 时不再依赖人工发现引用断裂。

控制面板的操作状态机源文件是 `services/control-operation.ts`（emit 为同目录 `.js`）。它统一负责耗时操作互斥、阶段进度、完成/失败状态和过期回调保护；`routes/control.js` 编排具体服务。新增 GPU 操作时必须复用这个状态机，不要再创建另一套 busy 标志。修改该模块后运行 `npm run build:runtime` 与 `npm run test:control-operation`。

GPU 串行队列源文件是 `services/serial-queue.ts`（emit 为同目录 `.js`）。语音、翻译与聊天等单通道任务通过它排队，失败任务不得阻断后续任务。修改后运行 `npm run build:runtime` 与 `npm run test:serial-queue`。

上游 HTTP 客户端源文件是 `services/http-client.ts`（emit 为同目录 `.js`）。Ollama、TTS、翻译与路由共用它处理超时、中止、JSON/二进制读取与 `UpstreamError`。修改后运行 `npm run build:runtime` 与 `npm run test:http-client`。

TTS 服务源文件是 `services/tts-service.ts`（emit 为同目录 `.js`）。负责声线校验、参考音频/权重切换与 GPT-SoVITS 串行合成。修改后运行 `npm run build:runtime`、`npm run test:voice-profile` 与 `npm run test:chat`。

Ollama 服务源文件是 `services/ollama-service.ts`（emit 为同目录 `.js`）。负责模型列表、keep_alive 切换与 NDJSON 流式对话。修改后运行 `npm run build:runtime`、`npm run test:chat` 与 `npm run test:resource-scheduling`。

翻译服务源文件是 `services/translation-service.ts`（emit 为同目录 `.js`）。负责常驻中日翻译进程、缓存、HTTP 请求与 spawn-per-call 回退。修改后运行 `npm run build:runtime` 与 `npm run test:resource-scheduling`。

Live2D 服务源文件是 `services/live2d-service.ts`（emit 为同目录 `.js`）。负责模型清单引用收集、路径逃逸防护与可用性检查。修改后运行 `npm run build:runtime` 与 `npm run test:live2d`。

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
5. 系统会自动创建完整事务备份、写入正确分片、同步 Tag 与推荐层级、统一评级与提示词，并运行场景校验。

页面顶部会显示待保存修改数量。标题和故事是必填项，招牌场景还必须填写推荐理由；如果带着未保存修改离开，浏览器会先提醒。检查失败时，场景分片、聚合文件、Tag、推荐配置、角色/LoRA 引用、Manifest 和受影响样张会作为一个事务恢复。下架场景也只有在点击“保存到项目”并通过校验后才会真正生效。

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
- 个人偏好只读取浏览器本机的作品历史，根据使用次数、五维评分、收藏和最近使用时间计算；不上传、不新增远程追踪。
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

- 备份文件通过 `src/utils/backupCore.ts` 统一声明格式与版本，脚本测试直接覆盖该生产核心。历史记录仍会在恢复后经过现有的历史迁移函数，旧记录无需手动转换。
- 合并恢复以记录 ID 去重，备份中的同 ID 数据优先；覆盖恢复会先明确确认，并替换当前项目、记录、设置与本地图片。
- 网关维护备份落在 `runtime/maintenance-backups/`，每次“保存到项目”或替换样张前都会写入一份带时间戳与 label 的完整快照；场景管理 → 维护工具 → 备份历史可查看最近 50 份清单（ID / label / 创建时间 / 文件数）。
- 队列任务在加入时冻结 Prompt、负面词、角色、场景、构图、项目和 SD 参数，后续修改工作台不会污染已排队任务或其作品记录。
- 队列只负责当前页面会话中的顺序生成，不持久化未完成任务，避免刷新后意外继续调用 SD。

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
- 自动跳过 `data/prompt-pinned-scenes.json` 中受保护字段
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
- 标签、Prompt 和负面词是否已经规范化；
- 内容分级是否与场景描写一致；
- Scene ID、角色、时间、日文叙事与角色 DNA 是否有效。
- 导演台外部模块是否完整、可解析，并按既定顺序载入。
- 本地备份能否创建、迁移旧版本、合并记录并拒绝未知的新版本。

只要该命令通过，提交中的场景源和网页读取数据就是同步的。

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
