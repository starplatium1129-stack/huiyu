# 视频与分镜工作流

整理日期：2026-10-09。合并原视频调研和 AI 整理记录；操作与实现入口按当前源码核对，真实视频质量、声音、成本和设备仍待[规划 V06](../../roadmap.md#素材与设备验收)。

## 使用流程

1. 绘制作品可加入分镜，也可从故事梗概创建镜头。角色/服装从内容目录读取，参考图按需要上传；核对人物、衣装、动作、景别、运镜、时长与对白。
2. AI 整理逐镜改写动态描述，失败保留原文，可重试和撤销；整批编排调整节奏，独立快照撤销。另有对白备选、质量检查和脚本生成；迟到结果不覆盖正在编辑的镜头，忙碌时阻止重复操作。
3. 核对首尾帧及所选模型能力后提交单镜/整批；按实际任务停止、重试失败镜头或合成。离开页面不取消已接受任务。

## 维护入口

| 职责 | 当前源码 |
| --- | --- |
| 分镜展示 | src/components/video/ShotListEditor.vue |
| AI 工具 | src/components/video/useShotAiTools.ts |
| 分镜状态 | src/components/video/useShotWorkspace.ts、useShotDraft.ts |
| 批次和单镜 | src/components/video/useShotBatchMachine.ts、src/composables/video/useVideoWorkspace.ts |
| API 边界 | src/api/videoApi.ts、videoApiResponse.ts |
| Rust 视频 | runtime-rs/src/video/http.rs、service.rs、batch.rs、storyboard.rs、ai.rs |
| 绘图批次 | src/composables/generation/useBatchDraw.ts |

视频接口包括 /api/video/status、images、jobs、batches、storyboard；批次支持 shots/{index}/retry 和 concat。/api/video-ai/status 查询可用源，rewrite/polish/dialogue/review/script 复用现行聊天模型配置，写调用要求本机直连。模型和文件名以运行时目录为准，不使用旧 Node routes 或 SD 新生成方案。

## 验证边界

图像走受控上传和输入校验，模型能力按实际目录/服务状态核对。只显示真实返回阶段/进度，保留超时、取消与恢复；AI 整理完成不代表视频已生成或质量合格。按[工作流](../../workflow.md#门禁与构建)选受影响检查；首尾帧、停止/重试、成片、音画同步和成本需要真实任务证据，本次未运行。
