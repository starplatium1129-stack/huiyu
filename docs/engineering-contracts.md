# 工程与角色接入契约

> 维护日期：2026-10-05。与 [AGENTS.md](../AGENTS.md) 配套阅读；此页保留模块约束，当前规模只维护在 [项目状态](project-status.md)。

## 模块边界

- **前端架构**：Vue 3 + Vite + TypeScript + Pinia（`src/stores/` + `src/views/` 路由全懒加载）。
- **组件与逻辑分层**：
  - 复杂业务逻辑与状态机下沉至专属 composable（如 `usePromptSdQueue`、`useAnimaInpaint`、`usePopularPromptAssembly`），保持 View 纯粹。
  - `src/application/` 编排用例与端口，不依赖具体存储、API、Pinia、Vue 或 Node 平台实现；`src/platform/web/` 与 `src/platform/desktop/` 提供适配，`src/api/` 处理传输和响应解码。跨端 DTO 放根目录 `types/` 或对应 runtime 纯模块；runtime 不反向依赖 `src/`，包括纯类型与间接导入。
- **网关服务**：产品后端为 `runtime-rs/` 的独立 Rust 进程，桌面与独立服务共用 HTTP/流式协议；依赖锁定于 `runtime-rs/Cargo.lock`。SPA fallback 排除 `/api`，网页优先使用已构建的 `dist/`。旧 `server.ts`、`server/`、`routes/`、`services/` 已删除，不能恢复为产品回退路径。仍有维护用途的纯工具归 `scripts/lib/`；Node/npm 用于前端、开发维护、假上游与构建编排。旧协议、任务指纹和存储格式由标注来源的固定夹具、独立 SQLite 检查及现行 Rust 行为测试验证，不以被测实现重写期望。
- **Rust 任务契约**：`task_contract` 定义持久任务记录、状态与可变字段命令；runtime 和 SQLite worker 在内部使用强类型，HTTP/provider 与持久化边界负责 JSON 转换。更新中的缺省字段保持原值，显式 null 只可清空可空字段；任务命令继续经过身份、取消和 writer epoch 检查。`execution` 持有跨引擎的输出、观察结果与执行 hooks，不依赖具体引擎或存储。前端任务快照与待确认请求由 `src/stores/runtimeTaskState.ts` 持有，API 不再转导出展示状态。
- **原生与交付边界**：libvips DLL 按 `runtime-rs/native-dependencies.windows-x64.json` 的真实字节/哈希暂存；已无产品调用的 ORT 不进入新包。构建回执绑定 Rust 源码、EXE、DLL 与许可证清单，缺失或字节漂移仍拒绝。`releaseReady` 和审批待项如实记录，不阻断经用户明确授权的发布，也不代表材料、真实权重、安装/UAC与设备效果已验收。新运行时的回退不能启动另一后端同时写同一 workspace。
- **运行时维护**：人物、服装、场景和蓝图以运行目录 content/catalog.sqlite 为唯一工作权威，通过 Rust 记录 API、事务和修订历史维护；data/catalog/ 仅作逐条初始化/发布快照，旧个人分片仅作升级导入来源。已有数据库不被升级包覆盖，启用后的缺库状态拒绝静默重建。静态 JSON 消费者读取数据库生成视图，构建读取显式导出的项目快照。资源事务、pin、参考审核发布及未知状态拒绝保留原契约；内置图片从安装资源根读取，自定义立绘仍在用户 character-art 中原子发布，不覆盖参考库或 Live2D。见[内容库设计](architecture/CONTENT-CATALOG-DESIGN.md)。
- **生图双引擎**：
  - **画面输入**：以角色/服装、场景已写好的词条与画面描述及用户明确选择为依据；Anima 未指定风格配方时不强制平涂、线稿或饱和度，画师词仅由用户显式选择。所选光效可补充相应的受光、投影、反光与明暗层次，不追加光源实体、道具、天气、星空、剪影或景深；显式 Anima 场景描述优先保留。情绪与检索资料不推导机位、光源或色调；台灯、烛光、炉火、晨光不借用其他光照预设。热门场景切换完整替换导演默认值（含 null），手写词条和显式设置按各自流程保留。
  - **场景形态与构图**：SFW 已有时间线形态可在蓝图用 identityTokensOverride / identityProseOverride 声明，角色 ID 保持，成人或手动成人词请求拒绝这种变体。allowRepeatedSubject 仅保留明确要求的镜面／幻影；group 和 triptych 继续区分同伴与分格。衣装不夹带必持道具，避免覆盖场景双手动作。
  - **Anima (ComfyUI / Pencil)**：高质量动漫与局部换装（Inpaint），支持 TeaCache 加速、手绘/CLIPSeg 遮罩与 `ImageCompositeMasked` 像素级原图回贴。
  - **Krea 2（自研 DiT + Qwen3-VL 编码器，非 SD3.5 系）**：当前本地编译使用英文 prose，清理标签堆词、评分词和括号权重，negative 为空；CFG 以实际节点定义为准，不把本地约束泛化为所有版本能力。提示词按 [studio-prompt-craft](../.agents/skills/studio-prompt-craft/SKILL.md) 执行，人物环境融合见 [叙事 CG 规范](guides/prompts/narrative-cg-prompt-standard.md)；历史研究不覆盖当前实现与后续证据。
- **Live2D 双后端**：浏览器走 `wl-live2d`（按需加载贴图，`blinkScheduler` 双眼同步，静止动态降帧节能）；桌面端走原生 Overlay 桥。运行时维护见 [Live2D 指南](guides/desktop/live2d-native-runtime.md)。
- **配音与陪伴**：VoxCPM2 角色 LoRA / GPT-SoVITS + 本机翻译管道，自动剥离台词舞台提示与长句分段。VoxCPM2 分片即播、下一句预取、完整句缓存；GPT 整句播放保留 in-flight 去重。停止播放取消所属 PCM 请求并释放音频节点，半句不作为可重播音频。

作品历史/工作台的纯类型、配方解码、资源所有权和可执行依赖方向见 [可维护性试点边界](guides/engineering/maintainability-boundaries.md)。类型兼容转导出不改变持久化格式。

## 重构期间的任务与持久化边界

以下约束已接入现行主线并继续约束维护；实现、本机迁移与交付范围见 [项目状态](project-status.md)。实际模型、其他设备和历史来源的未覆盖条件在 roadmap 单列。

- **任务所有权**：runtime 已接受的任务由 runtime 持有身份、执行和结果状态；页面卸载只解除订阅、停止页面查询并释放页面拥有的媒体与监听资源。用户明确取消通过独立任务取消命令表达，不能由页面卸载、客户端读取超时或连接断开隐式代替。尚未被接受的交互请求可取消；接受应答丢失属于未知结果，须按稳定请求身份查询，不能据此断言未接受或自动重提。
- **单一持久权威**：每个领域在每个数据域只有一个可写权威。Web adapter 是长期合法的平台实现，继续拥有独立浏览器数据；桌面 workspace 激活后，旧作品库仅作受控迁移来源或只读保留，不得因 runtime 不可用自动回落写入旧库，不得双写两份主库。Pinia 保留编辑和展示状态，缓存不构成第二份持久事实。
- **旧 SD 等待队列**：新生成已经退役，已接收的旧任务保持查询、取消与结果收集；旧记录仍按窗口角色保存稳定请求身份，不再新增 SD 意图；重建窗口默认暂停，未知接收只查询原 key。已接受项的执行与结果仍由 runtime 持有；删除未知提交须先确认取消意图，取消回执丢失保留待确认标记。清空等待不取消在途任务，旧浏览器队列不回灌为桌面权威，多窗口共享编辑不在此契约内。
- **迁移适配的窄例外**：允许读取旧数据格式和旧来源的 importer，但须记录支持的来源/版本、用途和退出条件；其保留期由支持的升级跨度决定。此例外不允许新增无限期 deprecated shim、任意错误 fallback 或双主写入，也不要求删除仍在使用的真实 Web adapter。
- **依赖护栏**：既有违规边按 source、target、依赖种类、规则和退出批次精确登记，只减不增；不以整个目录豁免。类型边与运行时边分开处理，runtime 反向依赖前端连纯类型也受约束；既有纯领域根的更严格可达依赖规则继续有效。静态依赖检查不禁止所有 `AbortController` / `onUnmounted`，也不把正常 unsubscribe 误报为任务取消；任务所有权由 R6 行为测试证明。规则与旧边清单见 [依赖护栏配置](../scripts/lib/refactor-boundaries.ts)，任务所有权另以行为回归验证。

## 普通图片资源

单 URL 的普通图片复用 `useRuntimeImage`；简单图片或循环卡片使用 `RuntimeImage`。它们沿用平台 URL/CORS 解析，按资源来源与 runtime epoch 重置状态，以每次加载身份拒绝旧事件；正常健康轮询不重载图片。不要在页面重复维护同一图片的失败集合，也不要让未解析的 `srcset` 覆盖已解析 URL。响应式 picture、画布采样、临时 Blob 所有权和原生 Live2D 仍由各自专用消费链管理，分级判定留在业务层。

首页 Hero 与场景维护预览共用 `useHomeHeroes`，默认使用内置 `*-home-cg-1024.webp`。只有当前样张目录中由维护上传写入 `source: "upload"` 且文件存在的条目才覆盖内置图；历史无来源清单保留原文件，但不再视作当前首页替换。恢复操作移除该角色覆盖记录，两页均回到同一内置图，不回溯旧样张版本。

## Live2D 生命周期

destroyRuntime 保持全库唯一、Pixi-first 销毁顺序；双后端 capability 分支及 lifecycleToken 语义不能在重构时改变。拆分已完成，见 [Live2D 运行时契约](guides/desktop/live2d-native-runtime.md)，不再列入未来待办。

桌宠显式隐藏或舞台停用时，经同一 destroyRuntime 取消在途连接并释放模型，保留启用、角色、服装和画质偏好；重新显示时按需恢复。普通浏览器标签页后台及减少动态效果仍只暂停。原生 Destroy 保留轻量 HWND、线程和命令通道，但释放 GPU context、设备资源池和模型；下一次 SetCharacter 懒建，不把正常卸载广播成故障 stopped。无模型的迟到帧和输入不得恢复渲染或新建 GPU 资源。

桌面工作台不进行全库缩略图预热；桌面缩略图内存缓存受 96 项、8 MiB 双上限约束，Web 持久缓存预热独立保留。图库 KeepAlive 只保留页面状态与缩略图，停用时撤销高清原图和查看器 Blob URL，重入后按可见范围读取；迟到异步结果不得填回旧激活代次。

## 角色接入

场景蓝图的 `compositionIntent` 可取 `single`（默认）、`group` 或 `triptych`。只有明确标记的 SFW 蓝图会放行多人或三格叙事；正文、人物数量、标签、镜头和画幅必须一起描述该构图。核心编译器与候选生成入口共用构图规则，不能在一端放行后又在另一端补回矛盾的单人/禁分格负面词。成人蓝图仍使用原有主体限制，构图字段不能改变成人资格或远程访问边界。未知取值视为无效蓝图。场景真实生成后由人工验收，不以参数通过替代画面通过。

数据层沿用既有 `adultEligibility: "adult"` 默认约定；远程访问授权仍以网关门控为准，字段默认值不能替代访问授权判断，也不能证明角色在具体剧情时期已成年。

角色接入必须同步完成以下六层：

1. **数据层与大盘**：人物记录保存 profile/popular，服装和蓝图通过稳定 ID 关联；通过内容维护或 content:catalog 保存，显式 export 到 data/catalog/ 后进入项目构建。参考权威源仍为 data/references/<人物ID>.json 与 manifest，两个旧参考 JSON 仅为兼容聚合产物；资源登记、渲染和发布继续走各自入口；
2. **UI 主题与强调色系统（必做项）**：在 `data/characters.json` 提供有效十六进制 `accent_color`，由 `src/utils/characterTheme.ts` 和 `src/assets/css/director/tokens.css` 的通用令牌派生主题。既有 `CHARACTER_THEME_OVERRIDES` 调校优先，缺失或非法颜色回退默认强调色；普通新角色无需新增 CSS 选择器，特殊调校才加入例外。核对角色切换、默认/缺失/非法颜色及两主题实际效果，保留 WCAG AA 与图片叠字视觉验收；
3. **全量场景蓝图（SFW/NSFW 姿势解剖防崩）**：每位角色配齐 10~11 套场景蓝图（6~7 SFW 唯美日常 + 4~5 R18 成人专属）；成人蓝图严格遵守**「后入/俯身 $\rightarrow$ 强制 `1536x1152` 横画幅 + POV扶腰受力」**与**「仰卧/POV $\rightarrow$ 强制 `1152x1536` 竖画幅 + 揉胸/分腿层级」**黄金法则，杜绝悬浮器官与断腰；
4. **立绘原图与 WebP 紧凑头像缩略图**：在发布样张原图（`assets/characters/popular-<id>.png`）后，**必须同步执行 `python scripts/maintenance/build-character-thumbs.py`** 编译生成 `assets/characters/thumbs/popular-<id>.webp`，确保生图左侧选择器、首页横条卡片不掉头像；
5. **可选参考素材**：新增角色和服装无需登记或补齐固定机位图库；档案不展示图库与完整度，分镜的身份/服装文字从内容目录读取，图片按项目需求手动上传。只有确有需要且已授权制作参考素材时，才使用以下旧参考库工具。先用 `reference:register --dry-run` 预览，再显式登记 pending（写源）；`reference:render`/`reference:design` 调用模型，仅写隔离候选。经 `reference:inspect` 只读核验、人工查看图片、`reference:review` 写入绑定当前候选的审核决定，再 `reference:publish` 预览，显式 `--apply` 发布到新版本目录。缺审核保持 pending，发布不自动激活或安装。参数以[候选审核与版本发布](workflow.md#参考库候选审核与版本发布)为准。旧 `sync-multi-outfit-standards` 与 URL 修复仅用于已核验旧库维护，不能代替新候选发布；
6. **门禁、质检与桌面端同步**：必须跑通 `node scripts/tests/test-popular-content.js`、`npm run typecheck:app` 与 `npm run build`，并执行 `deploy-desktop.bat -SkipBuild` 完成桌面端闭环同步与 Git 推送。

自动化辅助入口见 [接入工作流](guides/characters/character-onboarding-workflow.md)。脚本执行成功不等于主题、头像、按需制作的参考图和真实样张全部验收通过；必须逐层核对。场景数量是接入目标，不能为凑数覆盖已定稿内容；现存更多场景无需删减。
