# 工程与角色接入契约

> 维护日期：2026-09-28。与 [AGENTS.md](../AGENTS.md) 配套阅读；此页保留模块约束，当前规模只维护在 [项目状态](project-status.md)。

## 模块边界

- **前端架构**：Vue 3 + Vite + TypeScript + Pinia（`src/stores/` + `src/views/` 路由全懒加载）。
- **组件与逻辑分层**：
  - 复杂业务逻辑与状态机下沉至专属 composable（如 `usePromptSdQueue`、`useAnimaInpaint`、`usePopularPromptAssembly`），保持 View 纯粹。
  - `src/application/` 编排用例与端口，不依赖具体存储、API、Pinia、Vue 或 Node 平台实现；`src/platform/web/` 与 `src/platform/desktop/` 提供适配，`src/api/` 处理传输和响应解码。跨端 DTO 放根目录 `types/` 或对应 runtime 纯模块；runtime 不反向依赖 `src/`，包括纯类型与间接导入。
- **网关服务**：产品后端为 `runtime-rs/` 的独立 Rust 进程，桌面与独立服务共用 HTTP/流式协议；依赖锁定于 `runtime-rs/Cargo.lock`。SPA fallback 排除 `/api`，网页优先使用已构建的 `dist/`。旧 Node 源码及其测试暂留作行为对照，不随产品充当回退后端；Node/npm 仍可用于前端、开发维护与构建编排。
- **原生与交付边界**：图像和 ONNX DLL 按 `runtime-rs/native-dependencies.windows-x64.json` 的真实字节/哈希暂存，构建回执绑定 Rust 源码、EXE、DLL 与许可证清单。`releaseReady=false` 不等于可发行；真实权重、安装、UAC与设备效果必须另有证据。新运行时的回退不能启动另一后端同时写同一 workspace。
- **运行时维护**：产品请求使用 Rust 内容/资源事务及原生恢复入口，不能 fork Node 脚本补未迁功能。启动聚合只从权威源生成产物；完整发布包保持只读。桌面场景维护以运行目录 `content/data` 为可写权威（首次从包内数据原子初始化，已有副本不被升级覆盖），维护快照、聚合静态读取和远程过滤必须使用同一副本；内置图片资源仍从安装资源根读取；自定义角色立绘在用户运行目录 `character-art` 中保存并原子发布原画、缩略图和粒子同一版本，仅经本机受限接口读取，不覆盖参考库或 Live2D 模型。pin、参考发布审核、资源独立审批及未知状态拒绝均保持原契约，静态挂载和哈希不代表视觉交付。
- **生图双引擎**：
  - **Anima (ComfyUI / Pencil)**：高质量动漫与局部换装（Inpaint），支持 TeaCache 加速、手绘/CLIPSeg 遮罩与 `ImageCompositeMasked` 像素级原图回贴。
  - **Krea 2（自研 DiT + Qwen3-VL 编码器，非 SD3.5 系）**：当前本地编译使用英文 prose，清理标签堆词、评分词和括号权重，negative 为空；CFG 以实际节点定义为准，不把本地约束泛化为所有版本能力。提示词按 [studio-prompt-craft](../.agents/skills/studio-prompt-craft/SKILL.md) 执行，人物环境融合见 [叙事 CG 规范](guides/prompts/narrative-cg-prompt-standard.md)；历史研究不覆盖当前实现与后续证据。
- **Live2D 双后端**：浏览器走 `wl-live2d`（按需加载贴图，`blinkScheduler` 双眼同步，静止动态降帧节能）；桌面端走原生 Overlay 桥。组合式拆分方案见 `docs/archive/completed/live2d-composable-refactor-plan.md`。
- **配音与陪伴**：GPT-SoVITS + 本机翻译管道，自动剥离台词舞台提示，长句分段与 in-flight 缓存去重。

作品历史/工作台的纯类型、配方解码、资源所有权和可执行依赖方向见 [可维护性试点边界](guides/engineering/maintainability-boundaries.md)。类型兼容转导出不改变持久化格式。

## 重构期间的任务与持久化边界

以下约束已按 [重构总计划](architecture/REFACTOR-EXECUTION-PLAN.md) 接入 R0–R11 主线，并继续约束后续维护；实现、本机迁移与交付范围见 [主线记录](architecture/R3-R11-EXECUTION-REPORT.md)。实际模型、其他设备和历史来源的未覆盖条件继续按 roadmap 单列，不用代码完成替代这些验收。

- **任务所有权**：runtime 已接受的任务由 runtime 持有身份、执行和结果状态；页面卸载只解除订阅、停止页面查询并释放页面拥有的媒体与监听资源。用户明确取消通过独立任务取消命令表达，不能由页面卸载、客户端读取超时或连接断开隐式代替。尚未被接受的交互请求可取消；接受应答丢失属于未知结果，须按稳定请求身份查询，不能据此断言未接受或自动重提。
- **单一持久权威**：每个领域在每个数据域只有一个可写权威。Web adapter 是长期合法的平台实现，继续拥有独立浏览器数据；桌面 workspace 激活后，旧作品库仅作受控迁移来源或只读保留，不得因 runtime 不可用自动回落写入旧库，不得双写两份主库。Pinia 保留编辑和展示状态，缓存不构成第二份持久事实。
- **迁移适配的窄例外**：允许读取旧数据格式和旧来源的 importer，但须记录支持的来源/版本、用途和退出条件；其保留期由支持的升级跨度决定。此例外不允许新增无限期 deprecated shim、任意错误 fallback 或双主写入，也不要求删除仍在使用的真实 Web adapter。
- **依赖护栏**：既有违规边按 source、target、依赖种类、规则和退出批次精确登记，只减不增；不以整个目录豁免。类型边与运行时边分开处理，runtime 反向依赖前端连纯类型也受约束；既有纯领域根的更严格可达依赖规则继续有效。静态依赖检查不禁止所有 `AbortController` / `onUnmounted`，也不把正常 unsubscribe 误报为任务取消；任务所有权由 R6 行为测试证明。规则、旧边清单和当次验证见 [R0 实施记录](architecture/R0-EXECUTION-REPORT.md)。

## 普通图片资源

单 URL 的普通图片复用 `useRuntimeImage`；简单图片或循环卡片使用 `RuntimeImage`。它们沿用平台 URL/CORS 解析，按资源来源与 runtime epoch 重置状态，以每次加载身份拒绝旧事件；正常健康轮询不重载图片。不要在页面重复维护同一图片的失败集合，也不要让未解析的 `srcset` 覆盖已解析 URL。响应式 picture、画布采样、临时 Blob 所有权和原生 Live2D 仍由各自专用消费链管理，分级判定留在业务层。

## Live2D 生命周期

destroyRuntime 保持全库唯一、Pixi-first 销毁顺序；双后端 capability 分支及 lifecycleToken 语义不能在重构时改变。拆分已完成，见 [完成记录](archive/completed/live2d-composable-refactor-plan.md)，不再列入未来待办。

桌宠显式隐藏或舞台停用时，经同一 destroyRuntime 取消在途连接并释放模型，保留启用、角色、服装和画质偏好；重新显示时按需恢复。普通浏览器标签页后台及减少动态效果仍只暂停。原生 Destroy 保留轻量 HWND、线程和命令通道，但释放 GPU context、设备资源池和模型；下一次 SetCharacter 懒建，不把正常卸载广播成故障 stopped。无模型的迟到帧和输入不得恢复渲染或新建 GPU 资源。

桌面工作台不进行全库缩略图预热；桌面缩略图内存缓存受 96 项、8 MiB 双上限约束，Web 持久缓存预热独立保留。图库 KeepAlive 只保留页面状态与缩略图，停用时撤销高清原图和查看器 Blob URL，重入后按可见范围读取；迟到异步结果不得填回旧激活代次。

## 角色接入

场景蓝图的 `compositionIntent` 可取 `single`（默认）、`group` 或 `triptych`。只有明确标记的 SFW 蓝图会放行多人或三格叙事；正文、人物数量、标签、镜头和画幅必须一起描述该构图。核心编译器与候选生成入口共用构图规则，不能在一端放行后又在另一端补回矛盾的单人/禁分格负面词。成人蓝图仍使用原有主体限制，构图字段不能改变成人资格或远程访问边界。未知取值视为无效蓝图。场景真实生成后由人工验收，不以参数通过替代画面通过。

数据层沿用既有 `adultEligibility: "adult"` 默认约定；远程访问授权仍以网关门控为准，字段默认值不能替代访问授权判断，也不能证明角色在具体剧情时期已成年。

角色接入必须同步完成以下六层：

1. **数据层与大盘**：`data/popular/<franchise>.json`（身份+服装）、`data/blueprints/<franchise>.json`（蓝图）与 `data/characters.json`（人物档案、视觉DNA、性格世界观、`accent_color`）；`npm run wf -- content:sync` 只读预览，`--apply` 统一校验/登记/构建。参考权威源为 `data/references/<人物ID>.json` 与 manifest，两个旧参考 JSON 仅为兼容聚合产物；
2. **UI 主题与强调色系统（必做项）**：在 `data/characters.json` 提供有效十六进制 `accent_color`，由 `src/utils/characterTheme.ts` 和 `src/assets/css/director/tokens.css` 的通用令牌派生主题。既有 `CHARACTER_THEME_OVERRIDES` 调校优先，缺失或非法颜色回退默认强调色；普通新角色无需新增 CSS 选择器，特殊调校才加入例外。核对角色切换、默认/缺失/非法颜色及两主题实际效果，保留 WCAG AA 与图片叠字视觉验收；
3. **全量场景蓝图（SFW/NSFW 姿势解剖防崩）**：每位角色配齐 10~11 套场景蓝图（6~7 SFW 唯美日常 + 4~5 R18 成人专属）；成人蓝图严格遵守**「后入/俯身 $\rightarrow$ 强制 `1536x1152` 横画幅 + POV扶腰受力」**与**「仰卧/POV $\rightarrow$ 强制 `1152x1536` 竖画幅 + 揉胸/分腿层级」**黄金法则，杜绝悬浮器官与断腰；
4. **立绘原图与 WebP 紧凑头像缩略图**：在发布样张原图（`assets/characters/popular-<id>.png`）后，**必须同步执行 `python scripts/maintenance/build-character-thumbs.py`** 编译生成 `assets/characters/thumbs/popular-<id>.webp`，确保生图左侧选择器、首页横条卡片不掉头像；
5. **全视角参考标准库接入**：为新角色及全部服装登记 4 个参考机位和 3 个设计机位。先用 `reference:register --dry-run` 预览，再显式登记 pending（写源）；`reference:render`/`reference:design` 调用模型，仅写隔离候选。经 `reference:inspect` 只读核验、人工查看图片、`reference:review` 写入绑定当前候选的审核决定，再 `reference:publish` 预览，显式 `--apply` 发布到新版本目录。缺审核保持 pending，发布不自动激活或安装。参数以[候选审核与版本发布](workflow.md#参考库候选审核与版本发布)为准。旧 `sync-multi-outfit-standards` 与 URL 修复仅用于已核验旧库维护，不能代替新候选发布；
6. **门禁、质检与桌面端同步**：必须跑通 `node scripts/tests/test-popular-content.js`、`npm run typecheck:app` 与 `npm run build`，并执行 `deploy-desktop.bat -SkipBuild` 完成桌面端闭环同步与 Git 推送。

自动化辅助入口见 [接入工作流](guides/characters/character-onboarding-workflow.md)。脚本执行成功不等于主题、头像、所有形态参考图和真实样张全部验收通过；必须逐层核对。场景数量是接入目标，不能为凑数覆盖已定稿内容；现存更多场景无需删减。
