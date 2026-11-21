# 可维护性试点边界

规定作品历史、提示词工作台与观画适配模块的依赖方向与资源所有权边界。全局契约见 [工程契约](../../engineering-contracts.md)，实施状态见 [项目状态](../../project-status.md)。

---

## 1. 模块依赖方向

| 公开入口 | 内部依赖与边界约束 |
| --- | --- |
| `promptHistoryStore` | 经 `artworkRepository` 读写 `ArtworkRecord[]`、项目及软删/恢复（Web/桌面分流，持有读取代际） |
| `promptBuilderStore` | 创作状态经 `usePromptDraft`、`usePromptSceneFilters`、`usePromptArtworkHistory` 分层承载（后者共享 `historyStore` ref） |
| `types/promptHistory` | 新生成记录、角色与工作台纯类型 |
| `historyRecipe → usePromptHistoryApply` | 只读校验投影，不写库；无效引擎拒绝覆盖草稿，旧缺字段显式提示 |
| `generationApi → generationResponse → generationTask` | 统一客户端传输与边界校验，`generationTask` 唯一映射 UI 阶段（未知阶段保持 `unknown`） |

### 强制依赖约束（[module-boundaries.mts](../../../scripts/lib/module-boundaries.mts)）
- `runtime-rs/` 与 `tools/` 不得反向引用 `src/`（含纯类型与间接边）。
- `application`、`types/*`、`resultContext`、`historyRecipe`、`generationTask`、`promptPolicy`、`promptCatalog` 严禁直接或间接依赖页面、Store、Vue 或浏览器服务（`application` 亦不得依赖平台适配或 Node 模块）。
- `storage` 不得反向依赖页面、组件或 Store；`PhotoSwipe` 依赖仅限 `PhotoSwipeStage` 导入。
- WAI/生成接口校验与执行全部位于 `runtime-rs/src/generation/`，与存储保持单向依赖；`scripts/lib/generation/` 仅保留离线样张窄用途工具。

---

## 2. 资源所有权清单

- **成片归档路径**：桌面任务图片统一通过 `archiveTaskResult → saveTaskResult` 复用持久化媒体与冻结配方（共享 `taskArtworkId`，不重复上传）；`saveArtworkSnapshot` 仅留给浏览器直连与外部导入。异步写入前复制输入，应答丢失按作品 ID 读回，不误当回滚成功。

| 资源 | 唯一拥有者与清理动作 | 保持语义 |
| --- | --- | --- |
| PhotoSwipe 实例、ResizeObserver、解码对象 | `PhotoSwipeStage` 统一创建并在卸载/重建时 `dispose` | 失败通知 Gallery 回退；自建 Object URL 仅回收一次；过期事件不发布 |
| Gallery 外层 Dialog、键盘、焦点与滚动锁 | Gallery 原有组合逻辑 | 收藏/删除/Remix 绑定稳定作品 ID |
| 语音翻译、预热、播放与口型帧 | `useVoice` session / `AbortController` | `stop`、切角与 `destroy` 可靠收束等待中的 Promise |
| KeepAlive 失活与页面卸载 | 各页面生命周期 owner | 暂停可见任务，不清草稿，不取消后台生成任务 |
| Live2D 双后端 | `destroyRuntime` | 按 Pixi-first 顺序唯一销毁，保留 capability 分支 |

---

## 3. PhotoSwipe 适配与退出边界

- 默认查看器为 `ZoomableImageViewer`，`PhotoSwipe 5.4.4` 仅由用户开关显式启用。
- `PhotoSwipeStage` 仅接收作品列表与 `index`（抛出 `change`/`error`），禁止侵入作品仓储、配方、收藏或任务中心；许可证保留 [PhotoSwipe.txt](../../../public/licenses/PhotoSwipe.txt)。
- 若出现焦点冲突、身份错配或资源泄漏，可随时移除开关与 `PhotoSwipeStage` 接线并撤回依赖，回退至原查看器。
