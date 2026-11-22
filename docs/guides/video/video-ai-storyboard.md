# 视频与分镜工作流

从首页「故事短片」进入创作项目。项目分镜支持原生生成、单镜返工和桌面整片导出。下方的 AI 分镜编辑器也可从视频工作台使用。

## 创作项目里的成片

1. 绑定首尾帧后提交 Wan 动态镜头。角色对白镜头绑定一张脸部清晰的首帧和一段 WAV，选择配音驱动。
2. 在镜头历史中选用要放到时间线的版本，也可只返工这个镜头。提交后的新片在完成前不会占掉当前片段。
3. 在桌面「整片导出」选镜头并核对顺序。按需要启用配音、两倍超分或两倍插帧。完成后可下载 MP4。需要在另一台机器上继续返工时，使用工作区备份导出 `.huiyu`。模型和增强组件的安装命令见[本地模型配置](../setup-and-models.md#角色对白与整片导出)。

---

## 1. 使用流程

1. **创建与编辑**：绘图作品可加入分镜，或从故事梗概直接拆解镜头；自动读取内容目录中的角色与服装，按需上传首尾帧或参考图，并核对景别、运镜、时长与对白。
2. **AI 辅助整理**：支持逐镜改写动态描述、整批编排节奏、对白备选、质量检查与脚本生成（均带独立快照撤销，迟到结果不覆盖正在编辑的镜头）。
3. **提交与管理**：核对模型能力与首尾帧后提交单镜或整批；支持停止、单镜重试或合成整片（切页不取消后台任务）。

---

## 2. 源码边界与接口规范

| 职责 | 对应源码 |
| --- | --- |
| 分镜界面 | `src/components/video/ShotListEditor.vue` |
| AI 助手工具 | `src/components/video/useShotAiTools.ts` |
| 分镜状态与草稿 | `src/components/video/useShotWorkspace.ts`、`useShotDraft.ts` |
| 批次状态机 | `src/components/video/useShotBatchMachine.ts`、`src/composables/video/useVideoWorkspace.ts` |
| 绘图批次 | `src/composables/generation/useBatchDraw.ts` |
| 前端 API 边界 | `src/api/videoApi.ts`、`videoApiResponse.ts` |
| Rust 视频后端 | `runtime-rs/src/video/`（`http.rs`、`service.rs`、`batch.rs`、`storyboard.rs`、`ai.rs`） |

### 关键接口契约
- **主路由**：`/api/video/status`、`images`、`jobs`、`batches`、`storyboard`；AI 辅助入口为 `/api/video-ai/status` 与 `rewrite`/`polish`/`dialogue`/`review`/`script`（复用当前聊天模型配置）。
- **幂等与重试**：视频创建与单镜重抽（`retry`）均必须携带 `requestKey`；按 `requests/{key}` 或 `batch-requests/{key}` 查询与取消。重抽前先确认整批上游已结束，刷新恢复仅 `GET` 原 Key 而不重提；`concat` 作用于原批次。
- **验证边界**：AI 文案整理完成不代表视频已生成或达标；只展示后端真实返回阶段与进度。
