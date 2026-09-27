# 分镜短片「AI 整理」链路（2026-08-16）

> 历史实现记录（2026-09-27 整理）：下文保留 8 月 16–17 日的交接、接口与验证范围，不代表当前完整视频功能或文件所有权。现行能力见 [项目状态](../../project-status.md)，未验收项见 [未来规划](../../roadmap.md)。当前源码入口为 `src/components/video/ShotListEditor.vue`、`src/api/videoApi.ts` 与 `routes/video-ai.ts`，已包含整批编排、对白建议、质量检查及脚本生成；批量绘图调度已移至 `src/composables/generation/useBatchDraw.ts`。历史执行命令中的 `.js` 为构建后入口，不应直接换成 `.ts` 执行。

> 给视频页分镜模式加的智能化层：从绘图页带入的镜头，点一次「✦ AI 整理分镜」
> 就把静态绘图提示词改写成视频分镜描述，并推断景别/镜头/主体运动/对白。
> 服务端新文件 `routes/video-ai.js`（不碰 `routes/video.js`），前端改动
> 集中在 `ShotListEditor.vue` + `src/api/videoApi.ts`。

## 绘图页批量出图 → 历史加入分镜（2026-08-17 追加）

多场景批量出图，让"出图 → 挑图 → 攒分镜"一条龙：

1. 绘图页点「批量出图 · 多场景」→ 面板多选场景蓝图 + 引擎（SD/Anima）+ 每场景 1/3 张；
2. `useBatchDraw`（`src/composables/useBatchDraw.ts`）串行逐张执行：
   - SD 走 `runJob` 同路径（复用现有参数/细节器/入册逻辑），
   - Anima 直接 `POST /api/anima/jobs` + 轮询 + fetchImage（`animaRequestPayload` 复用）；
   - 每张自动 `commitHistoryEntry` 入册历史（prompt 为该场景 prose + 角色锚点）；
3. 结果在「历史」面板挑选：每张历史图新增「加入分镜」按钮
   （`HistoryPanel` emit to-shots → `handleHistoryToShots`：IndexedDB 取 blob +
   条目 prompt → `tagsToVideoProse` → `appendShotsCtx`）；
4. 攒齐后「去分镜短片」→ AI 整理 → 批量生成。

要点：
- 批量 prompt = `场景 prose + 角色锚点`（热门角色 identityProse / 工作室 CHAR_PROMPT tag），
  不经过完整词条流——批量是快速选图场景，精修仍走单张出图；
- 3 候选 = baseSeed + variant*1000（锁定可复现）；
- 单张失败不打断整批；取消 = 当前张完成后停止；
- Anima 批量固定 `/api/anima/jobs`（Krea 2 不批量，与 3 组候选限制一致）。

## 用法

1. 绘图页出图 →「加入分镜」→「去分镜短片」；
2. 分镜页自动完成：角色锚点填充（ctx.characterId → identityProse）、
   逐镜景别/镜头/运动关键词推断（`inferShotParams`）；
3. 点「✦ AI 整理分镜」：逐镜改写（前端并发 2），失败单镜保留原描述可重试，
   应用前整批快照，「撤销整理」可一键恢复；
4. 检查后「生成全部镜头」。

## 端点

- `GET /api/video-ai/status`（公开）：`{ available, source: 'api'|'ollama', model, label, reason? }`
- `POST /api/video-ai/rewrite`（localOnly，批量改写消耗站主 LLM 额度）：
  `{ identity?, prompt(1-4000), shotSize?, camera?, motion?, dialogue? }` →
  `{ source, model, shot: { prompt, shotSize, camera, motion, dialogue } }`

## LLM 源（复用聊天配置，零新增设置）

1. 站主 API 托管配置优先（`chat_api_config.json`，与 `routes/chat.js` 同源）；
2. 否则本地 Ollama（`OLLAMA_HOST` + `OLLAMA_MODEL`，未配置时取已装第一个）。

DeepSeek vendor 自动关 thinking（改写是机械任务）。API 非流式 120s 超时；
Ollama 走 `ollama-service.streamChat`（NDJSON 累积 + 串行队列），180s 超时。

## 提示词契约

system prompt 要求输出**严格 JSON**（prompt/shotSize/camera/motion/dialogue）；
服务端 `cleanRewriteOutput` 宽容清洗：markdown 围栏提取、非法枚举回退输入原值、
非法景别回退 null、prompt 为空回退原描述——模型输出再离谱也不会弄坏镜头参数。
prompt 输出约束：1-3 句英文（H3 是自然语言模型），写动作/镜头/时间流动，
不重复身份锚点、不写首帧已锁定的构图细节。

## 踩坑记录

- 无 LLM 源时 rewrite 返回 409（非 502）：可预期状态，前端提示去聊天设置配置。
- Ollama mock 的 /api/chat 是 NDJSON 流式（即使请求 stream:false），
  因此 Ollama 源必须走 `streamChat` 累积而非直接 readBody 解析单 JSON。
- status 端点每次探测都会打一次 Ollama /api/tags（3s 超时）——本地可接受，未缓存。

## 测试

`scripts/tests/test-video-ai.js`（contract 套件）：无源 409、API 源（Bearer/
stream:false/提示词结构断言）、markdown 围栏、非法枚举回退、非 JSON 回退、
输入白名单 400、Ollama 源 NDJSON 累积、上游 502 统一信封。
