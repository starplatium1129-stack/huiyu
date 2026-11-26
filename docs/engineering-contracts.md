# 工程与架构契约

规范系统模块分层、数据生命周期、持久化契约与接入标准。

---

## 1. 模块边界与分层

### 前端架构
- **技术栈**：Vue 3 + Vite + TypeScript + Pinia，路由视图全部懒加载。
- **展示与状态分离**：复杂状态与状态机下沉至专属 Composable（如 `usePromptSdQueue`、`useAnimaInpaint`），View 纯粹负责排版与渲染；单文件有效行数建议 ≤500 行。
- **分层与用例**：
  - `src/application/`：用例编排与接口定义，不直接依赖具体存储、Pinia、Vue 或 Node 平台实现。
  - `src/platform/web/` 与 `src/platform/desktop/`：提供不同平台的适配实现。
  - `src/api/`：API 客户端与数据传输边界校验。
  - 跨端 DTO 类型统一定义在根目录 `types/`，`runtime-rs` 不反向依赖前端。
- **UI 控件复用**：弹窗复用 `useFluidDialog`，浮层复用 `StudioDropdownMenu`，大图查看复用 `ArtworkViewerStage`（`ZoomableImageViewer` 默认，`PhotoSwipeStage` 仅在用户开关显式启用时按列表与 `index` 接入并独立 `dispose`，不侵入仓储或任务中心；许可保留 [PhotoSwipe.txt](../public/licenses/PhotoSwipe.txt)）。禁止在具体页面中手写重复的焦点、按键与弹层控制逻辑。

### 模块依赖方向与强制边界

| 公开入口 | 内部依赖与边界约束 |
| --- | --- |
| `promptHistoryStore` | 经 `artworkRepository` 读写 `ArtworkRecord[]`、项目及软删/恢复（Web/桌面分流，持有读取代际） |
| `promptBuilderStore` | 创作状态经 `usePromptDraft`、`usePromptSceneFilters`、`usePromptArtworkHistory` 分层承载（后者共享 `historyStore` ref） |
| `types/promptHistory` | 新生成记录、角色与工作台纯类型 |
| `historyRecipe → usePromptHistoryApply` | 只读校验投影，不写库；无效引擎拒绝覆盖草稿，旧缺字段显式提示 |
| `generationApi → generationResponse → generationTask` | 统一客户端传输与边界校验，`generationTask` 唯一映射 UI 阶段（未知阶段保持 `unknown`） |

强制依赖约束（[module-boundaries.mts](../scripts/lib/module-boundaries.mts)）：
- `runtime-rs/` 与 `tools/` 不得反向引用 `src/`（含纯类型与间接边）。
- `application`、`types/*`、`resultContext`、`historyRecipe`、`generationTask`、`promptPolicy`、`promptCatalog` 严禁直接或间接依赖页面、Store、Vue 或浏览器服务（`application` 亦不得依赖平台适配或 Node 模块）。
- `storage` 不得反向依赖页面、组件或 Store；`PhotoSwipe` 依赖仅限 `PhotoSwipeStage` 导入。
- WAI/生成接口校验与执行全部位于 `runtime-rs/src/generation/`，与存储保持单向依赖；`scripts/lib/generation/` 仅保留离线样张窄用途工具。

### 后端与网关
- **产品后端**：由 `runtime-rs/` 的独立 Rust 进程承载，提供 HTTP 及流式通信。
- **无测试与旧代码清理**：旧 Node 后端（`server.ts`、`server/`、`services/`）已退役；项目严禁编写和运行任何自动化测试。
- **数据权威**：开发环境以 `runtime/content/catalog.sqlite` 为唯一权威，`data/catalog/` 为显式导出快照（维护命令与校验规则见 [维护手册](maintenance.md)）。

---

<a id="重构期间的任务与持久化边界"></a>
## 2. 任务生命周期与持久化契约

### 单一持久化权威
- **独立平台边界**：Web 环境以浏览器 IndexedDB 为数据持久源；桌面环境激活后由本机 SQLite 全权持有，禁止双主并发写入，旧浏览器数据仅作迁移来源。
- **状态与缓存**：Pinia 仅维护前端展示与编辑状态，内存缓存不替代持久化记录。

### 任务所有权与幂等设计
- **任务归属**：Rust runtime 接受的任务由其全权持有生命周期与结果；页面关闭或卸载仅解除前端订阅，不隐式取消后台任务。显式取消需由用户发起取消命令。
- **幂等请求键**：生图、分镜与视频请求在提交前必须由调用方写稳原请求键（Key）；重试或刷新时优先按原 Key 查询已有任务，避免重复提交。
- **结果归档**：
  - 生成结果经 `archiveTaskResult → saveTaskResult` 入册，统一通过 `taskArtworkId` 保持唯一标识。
  - 任务媒体文件受工作区独占保护，未确认落盘前禁止提前释放。
- **草稿保护机制**：分镜、漫画及普通生图草稿在网络请求发出前必须落盘写稳；页面重入或刷新时仅恢复原草稿和原 Key。

---

## 3. 媒体与资源生命周期

### 图片与缓存管理
- **读取槽与并发控制**：原图查看和批量预览复用受限的读取槽与 Worker，避免超出并发预算。
- **图库内存预算**：桌面端图库缩略图缓存受 96 项 / 8 MiB 上限约束；离页或组件停用时主动释放原图与 Blob URL。
- **通用图片加载**：单张图片加载统一复用 `useRuntimeImage` / `RuntimeImage`，内部处理 URL 校验与刷新，避免页面重复编写加载/失败状态。

### 资源所有权与生命周期清单

| 资源 | 唯一拥有者与清理动作 | 保持语义 |
| --- | --- | --- |
| Live2D 双后端 | `destroyRuntime` 按 Pixi-first 顺序唯一销毁 | 桌宠隐藏或停用时释放模型与 GPU 上下文，保留配置；重新显示按需懒加载 |
| PhotoSwipe 实例、ResizeObserver、解码对象 | `PhotoSwipeStage` 统一创建并在卸载/重建时 `dispose` | 失败通知 Gallery 回退；自建 Object URL 仅回收一次；过期事件不发布 |
| Gallery 外层 Dialog、键盘、焦点与滚动锁 | Gallery 原有组合逻辑 | 收藏/删除/Remix 绑定稳定作品 ID |
| 语音翻译、预热、播放与口型帧 | `useVoice` session / `AbortController` | `stop`、切角与 `destroy` 可靠收束等待中的 Promise |
| KeepAlive 失活与页面卸载 | 各页面生命周期 owner | 暂停可见任务，不清草稿，不取消后台生成任务 |

---

<a id="角色接入"></a>
## 4. 角色接入与创作契约

- **创作红线**：全分级（SFW/NSFW/R18）自由创作、新增角色无画师配方及定稿保护约束统一见 [AGENTS.md](../AGENTS.md#质量红线) 与 [维护手册](maintenance.md)。
- **构图意图**：蓝图 `compositionIntent` 支持 `single`（单人，默认）、`group`（多人）与 `triptych`（三格叙事）。描述、标签与画幅需与构图意图保持一致。
- **资产与主题契约**：
  - 新增角色需维护人物、服装与蓝图关联，并导出项目快照。
  - 角色强调色由 `profile.accent_color`、`characterTheme.ts` 和设计系统令牌统一派生。
