# 剧情短片工作流调研与本项目应用方案

> 日期：2026-08-16 · 状态：调研完成 · **2026-08-23 已落地纯点击流闭环**（蓝图一键剧本 + 一键首帧 + 剧本模式直通分镜，当前状态见 [项目状态](../../project-status.md)），本文档转为历史调研留档
> 范围说明：本文只做调研与方案设计，**不改动** `routes/video.js` / `VideoStudioView.vue`（此为原调研时的协作分工，不构成当前文件所有权）。本文档为新增独立文件，供其接手时直接引用。
> 本机核查日期：2026-08-16（`E:\code\2\lora\AI\ComfyUI\comfy_extras\nodes_minimax_h3.py`）
> 时效注记（2026-08-31）：文中「训练台」指当时的 LoRA 训练 UI，该 UI 已于 2026-08-29 连根删除（commit 2afd449），**角色 LoRA 资产（权重 + 数据集）仍可用**，后续指令式稳定换装走 Qwen-Image-Edit 路线（见 [未来规划](../../roadmap.md)）。

## 一、结论摘要

1. **行业共识的剧情短片流水线是「编排层」问题，不是模型问题**：剧本 → 分镜表 → 角色/场景资产 → 逐镜头图生视频（3–15s/镜）→ 配音音效 → 剪辑合成。市面工具的差距不在单段生成能力，而在「分镜管理 + 批量编排 + 跨镜一致性 + 合成」这条链。
2. **本项目已具备约 70% 的要素**：角色 LoRA 资产（训练台 UI 已于 2026-08-29 下线，现有权重仍可用，后续走 Qwen-Image-Edit 路线）、三引擎出图（Anima/Krea/WAI + LoRA + 场景蓝图）、H3 I2VA（首帧参考图驱动法，即行业最主流的「参考图驱动」）、H3 原生音频（工作流已挂 audio VAE）、ComfyUI 任务管线（队列/轮询/取消/结果）。缺的是分镜数据模型、批量任务编排、跨镜一致性链路与成片合成。
3. **本机 ComfyUI 的 H3 节点原生支持首尾帧**（`MiniMaxH3ImageToVideo` 有 `first_frame` 与 `last_frame` 两个可选输入），即行业用的「镜 N 尾帧 → 镜 N+1 首/尾帧」衔接方案在本地直接可行，只差应用层接线（对应 roadmap P3）。
4. **建议按 P5–P8 分四步落地**（见第四节），第一步（P5 分镜模式 + 批量生成）即可把「几秒单镜头」升级为「6–12 镜、30–60 秒剧情短片」。

## 二、行业工作流调研（附来源）

### 2.1 六阶段标准流水线

综合多篇行业指南（[掘金《AI短剧创作入门》](https://juejin.cn/post/7673940698534199296)、[塔猴《AI短剧怎么制作：2026年全流程指南》](https://www.tahou.com/article/211936539248722949)），市面 AI 剧情短片的制作流水线为：

| 阶段 | 核心任务 | 关键产出 | 行业代表工具 |
| --- | --- | --- | --- |
| 1 剧本创作与拆解 | 强冲突快节奏剧本；拆成逐镜头的场景/角色/动作/对白 | 剧本 + 分镜表（1–2 分钟片 = 8–15 个分镜） | DeepSeek/ChatGPT/Kimi 辅助；天工短剧工作台、火山剧创、小云雀 AI 自动拆解 |
| 2 角色设计与一致性管理 | 定妆照（正/侧/3/4、表情、服装变体）+ 角色卡片 + LoRA | 角色资产库、场景概念图 | Midjourney、即梦、Stable Diffusion + LoRA |
| 3 分镜规划与镜头控制 | 每镜明确景别/构图/站位/运镜/情绪 | 分镜脚本（镜头语言） | 天工工作台、LibTV 3D 导演台、LTX Studio |
| 4 视频生成 | 每镜独立生成，多抽卡选优 | 视频素材片段 | 即梦 Seedance 2.0、可灵 3.0、H3/海螺、Runway、Vidu |
| 5 配音与音效 | TTS 对白（带情绪）+ BGM + SFX | 完整音频轨道 | 剪映 AI、讯飞配音、ElevenLabs；或模型原生音画同步 |
| 6 后期剪辑与发布 | 时间线拼接、转场、字幕、调色 | 最终成片 | 剪映专业版、Premiere |

要点（均来自上述两篇文章的原文信息）：

- **角色一致性是行业头号痛点**：76% 的 AI 短剧创作者把「角色变脸」列为第一大难题。最可靠解法是「**图生视频参考图驱动法**」——先用图像模型出角色定妆照，之后每个镜头都以这张图为参考生成，提示词只写动作与场景，角色外貌由参考图像素锚定；进阶方案是训练角色 LoRA；再配合「角色卡片」（外貌锚点描述段落，逐镜原样粘贴，不凭感觉改写）。
- **分镜密度**：1–2 分钟短剧约 8–15 个分镜（约 8 镜/分钟），单镜 3–10 秒主流；AI 短剧每集通常 1–3 分钟。
- **视频生成按模型分工**：即梦 Seedance 2.0 强在「导演级分镜调度 + 图文音视四维输入」；可灵 3.0 强在中文剧情理解与人物肢体动作；H3 强在「单次生成内的多镜头叙事 + 音画同步 + 全能参考」。
- **成本数据**：据中国网络视听协会（塔猴引用），2026 年一季度上线的微短剧约 12.8 万部，其中 AI 短剧占比超 95%；AI 短剧成本约为真人短剧的十分之一。

### 2.2 典型案例：《山海奇镜之劈波斩浪》

首部广受关注的全 AI 微短剧（快手星芒，创作者闲人一坤/陈坤），制作复盘（[aiduanjuquan 复盘](https://aiduanjuquan.com/behind-the-scenes/ai-short-drama-kling-case)、[新榜对话](https://news.qq.com/rain/a/20240719A04MHS00)）：

- 流程：**两个月打磨剧本 → 生成角色设定图/神兽设定图 → 可灵图生视频逐镜生成 → 剪辑合成**；题材选「玄幻+亲情」以适配当时模型承载力（单镜头时长短、复杂叙事难展开）。
- 明确承认的四大技术软肋：**人物一致性差、场景难以统一、角色表演僵硬、运动幅度受限**；异兽（训练素材少）一致性比人类角色更难；「角色开口说话不自然」靠可灵对口型/微表情迭代解决。
- 结论：该案例验证了「设定图 → I2V → 拼接」是当前最成熟的 AI 剧情片路径，也印证了 2.1 的一致性痛点。

### 2.3 海外叙事工具

- **LTX Studio**（Lightricks，[ltx.studio](https://www.lightricks.com/ltx-studio)）：端到端 AI 电影制作——剧本 → 故事板 → 角色一致性管理 → 逐镜生成 → 时间线编辑，是「把编排层做成产品」的代表。
- **Runway Act-One**（[runwayml.com](https://runwayml.com/)）：表演迁移——用一段真人表演视频驱动 AI 角色面部表情/情绪，专攻对白与情绪镜头，解决「AI 角色不会演」的问题。

### 2.4 MiniMax H3 官方能力（与本项目直接相关）

来源：[官方仓库 README](https://github.com/MiniMax-AI/MiniMax-H3)（2026-08-15 同步到 `.agents/skills/h3-prompt-writing/`）与第三方参数整理（[minimaxh3.art 解读](https://minimaxh3.art/zh/blog/minimax-h3-hailuo-3-what-we-know-zh)，仅作参数佐证）：

- **H3-Base-FL2VA**：0/1/2 张图输入 = T2V / 首帧 / 首尾帧；单次 4–15 秒、24fps、原生 32kHz 立体声（**对白 11 种语言稳定支持** + 音效 + 环境音同步生成）。
- **H3-Base-Ref2VA（全能参考，官方 API 侧）**：≤9 图 + ≤3 段参考视频 + ≤3 段参考音频，混合输入 ≤12 个文件——多镜头连贯性的「终极方案」：角色定妆照 + 前段成片一起喂，锁形象与风格。
- **H3-Context-IR**：官方托管的多模态指令理解与改写系统（未开源，仅 API 提供），官方明确「强烈建议接入或按其 Prompting Guidance 自行构建」——本地开源链路没有它，提示词质量直接影响成片。
- **本地开源版与 API 版的差距**：本地 = 768p、无 Context-IR、无 Ref2VA（节点只有 FL2VA）；API = 2K（H3-Regenerate-2K）、Context-IR、Ref2VA。本地链路做剧情短片必须靠「应用层编排」补差距。

### 2.5 行业一致性方案可靠性排序

| 方案 | 原理 | 可靠性 | 本项目对应 |
| --- | --- | --- | --- |
| 参考图驱动（I2V） | 首帧像素锚定角色/场景 | ★★★★★ | 已有：H3 I2VA（`POST /api/video/images` + `first_frame`） |
| 角色 LoRA | 模型记忆角色特征 | ★★★★☆ | 已有：LoRA 权重 + 三引擎出图（训练台 UI 已于 2026-08-29 下线，后续走 Qwen-Image-Edit 路线） |
| 首尾帧衔接 | 镜 N 尾帧 → 镜 N+1 首/尾帧，动作空间连续 | ★★★★☆ | 本机节点已支持（`last_frame`），应用层未接线 |
| Ref2VA 多模态参考 | 图+视频+音频参考锁定 | ★★★★★ | 仅官方 API；本地不可用 |
| 角色卡片统一注入 | 每镜提示词粘贴同一外貌锚点段落 | ★★★☆☆ | 可做（数据已有：角色设定/出图词条） |
| 固定风格锚点 + 固定配方 | 统一 `[Shot N]` 风格声明、模型、参数 | ★★★☆☆ | 已有：`H3_STYLE` + 固定工作流 |

## 三、本项目现状盘点

### 3.1 已有能力（可直接复用）

- **角色资产**：角色 LoRA 权重 + 角色特征词条（训练台 UI 已于 2026-08-29 下线 commit 2afd449，**现有 LoRA 权重 + 数据集仍可用**，后续指令式稳定换装走 Qwen-Image-Edit 路线），出图链路（Anima/Krea/WAI）已支持 LoRA 权重 → 可产出「定妆照/角色参考图」与「角色卡片文本」。
- **场景资产**：`data/scene-blueprints.json` 的 `promptProse`/`promptTokens` 已按「可驱动 5–10 秒视频」的标准撰写（AGENTS.md 2026-08-15 指示），是分镜场景描述的现成来源。
- **单镜生成**：`routes/video.js` 已落地 H3 T2VA/I2VA（官方三段式提示词组装、画质档位、任务队列/取消/结果转存），前端 `VideoStudioView.vue` + `useVideoBridge.ts` 已打通「出图 → 出视频」。
- **音频**：H3 工作流已挂 `VAEDecodeAudio` + 双 VAE（视频/音频），原生音频链路存在（真实 GPU 验证待权重安装）。
- **一致性约束句**：组装层已固定追加 `Character identity, clothing, lighting, and scene structure remain consistent from start to finish.`。
- **本机 ComfyUI 节点核查（2026-08-16）**：`MiniMaxH3ImageToVideo` 可选输入 `first_frame` **和 `last_frame`** 均存在；`length` 范围 5–3600 帧（24fps），训练区间 124–362 帧（≈5–15s，更长未测试）——**首尾帧工作流与 15 秒长镜在本地都可行**。

### 3.2 缺口（应用层缺失项）

1. **分镜表数据模型与编辑器**：无任何「镜头列表」概念（已核查 `VideoStudioView.vue` 无 shot/batch/分镜）。
2. **批量任务编排**：现有 API 一次一镜；无「整批提交、逐镜排队、进度总览、单镜重抽」。
3. **跨镜一致性链路**：无角色卡片统一注入、无尾帧抽取/传递、无 Ref2VA 接入点。
4. **对白规范**：提示词组装未支持「台词行 + 说话人 + 情绪」（官方 11 语言对白能力未利用）。
5. **成片合成**：无 ffmpeg 拼接/字幕/封面帧。
6. **单镜质量门**：无逐镜审核与重抽流程（可复用 showcase 审核教训：防漏判、并发审核）。

### 3.3 硬约束（方案必须尊重）

- 16GB 显存（RTX 4070 Ti SUPER）：H3 standard 档单条约 2.5–4.5 分钟、fine 档 3.5–6 分钟；`MAX_PENDING=2`、单任务超时 45 分钟、队列令牌桶 capacity 3（本机直连放行）。
- 3 秒档（73 帧）低于模型训练区间下限（124 帧）；剧情片建议默认 5 秒档。
- 本地无 Context-IR / Ref2VA / 2K；质量差距靠提示词规范与编排补偿。
- AGENTS.md「明确不做」：不把 H3 视频原生音频与 GPT-SoVITS 配音链路强行合并（对白走 H3 原生；GPT-SoVITS 维持独立角色配音用途）。
- 安全契约不变：白名单字段、不接受任意工作流、结果校验、受控文件名。

## 四、应用方案（P5–P8，供视频链路负责人评估实施）

> 以下接口与数据结构为建议草案，实施时由视频链路负责人按现有契约风格（`validateInput` 白名单、错误信封、测试锚点）落地并写回 `docs/engineering-contracts.md`。

### P5 · 分镜模式（Shot List）+ 批量生成 ——「几秒单镜」→「30–60 秒短片」的最小闭环

**分镜数据模型**（一行一镜，JSON 结构）：

```jsonc
{
  "shots": [
    {
      "index": 1,
      "sceneId": "blueprint-id 或自由文本",   // 联动场景蓝图 → promptProse
      "characterId": "角色 id",               // 联动角色卡片 → 身份锚点段
      "shotSize": "wide | medium | closeup",  // 景别（新枚举，映射英文句）
      "camera": "still | push | pull | pan | orbit", // 复用现有枚举
      "motion": "subtle | natural | expressive",     // 复用现有枚举
      "action": "角色动作自然语言句",
      "dialogue": "台词（≤ 20 字/句，可空）",
      "duration": 5,                          // 剧情片默认 5s（训练下限）
      "quality": "standard",
      "prompt": "最终提示词（可编辑，预填 = 蓝图 prose + 角色卡 + action + 镜头句）",
      "firstFrame": null,                     // 参考图（复用 /api/video/images 上传）
      "linkLastFrame": true,                  // 自动用上一镜尾帧作本镜尾帧（P6 生效）
      "seed": null,                           // 空 = 随机；重抽固定
      "status": "draft", "resultUrl": null
    }
  ]
}
```

**前端**：`VideoStudioView` 增加「分镜」创作方式——分镜表格（每行：景别/镜头/动作/对白/时长/状态/预览），行内展开编辑；提供「从剧本粘贴批量生成」入口（按空行/编号拆分，或直接让用户逐行填）；整批「全部生成」。

**后端**：建议新增批量端点而非前端循环（保持编排与限流在服务端）：

- `POST /api/video/batches`：白名单校验每镜（复用 `validateInput` 逻辑 + 新字段 `shotIndex`），返回 batchId；服务端按顺序把每镜投入现有 job 管线（尊重 `MAX_PENDING`），单镜失败不影响其他镜。
- `GET /api/video/batches/:id`：逐镜状态/进度/resultUrl/error。
- `DELETE /api/video/batches/:id`：取消未完成镜。
- 单镜结果契约、媒体转存、TTL 清理全部复用现有代码。

**验收**：6–12 镜、30–60 秒剧情短片跑通（8–15 镜/分钟 的行业密度）；单镜重抽不重跑整批。

### P6 · 跨镜一致性链路

1. **角色卡片统一注入**：新增角色资产 JSON（外貌锚点英文段，源自定妆照/训练数据/出图词条），每镜组装时在 H3 三段式内固定注入 `Character identity: <角色卡片>`（不重复写服装时用 `identityWithoutOutfit` 同类剥离逻辑，参考 Krea 链路经验）。
2. **首尾帧衔接（本地已可行）**：镜 N 成功后，服务端用 ffmpeg 从结果 MP4 抽尾帧 → 作为镜 N+1 的 `last_frame`（FL2VA 工作流：`MiniMaxH3ImageToVideo` 已支持）；同场景连续镜可同时传首帧与尾帧锁定空间连续性。抽帧文件走受控文件名（`aics_video_input_*`）与生命周期清理。
3. **重抽策略**：单镜「再抽一次」固定 seed/提示词/参考图，多抽卡人工选优；批量视图记录每镜尝试次数。
4. **进阶（可选，官方 API）**：Ref2VA——把角色定妆照（≤9 图）+ 前段成片（≤3 段视频）作参考提交官方 API 生成关键镜头，本地链路保持现状不依赖。

### P7 · 对白与音频

- H3 提示词内嵌台词：组装层新增 `dialogue` 字段 → 按官方规范写入描述（说话人 + 台词原文 + 情绪/语气），soundscape/music 继续用现有 `deriveH3Soundscape/Music`（已按场景信号派生）。
- 台词规范：单镜 ≤ 20 字/句、明确说话人、避免与画面动作矛盾（沿用 `CAMERA_MENTION_RE`/`MOTION_MENTION_RE` 的让位思路，做「对白与动作冲突」检查可后续再加）。
- GPT-SoVITS 不并入视频链路（AGENTS.md 约束）；如未来需要「AI 配音 + 非 H3 画面」的旁白，走独立轨道，不在本方案内。

### P8 · 成片合成与交付

- 服务端 ffmpeg：同分辨率镜头直接 concat；不同分辨率先 scale/pad 到统一画布（按 batch 的 aspectRatio 统一）→ 整片 MP4。
- 可选字幕：对白时间线 → SRT / 烧录软字幕（剪映可二次精剪）。
- 产物进 P4 视频作品册（元数据 + 运行时媒体目录，封面帧取 batch 首镜首帧）。
- 每镜质量门：沿用 showcase 审核教训（`parseVerdict` 先判「不通过」再判「通过」、详情正则防漏判、批量审核并发）——单镜抽帧送审，硬伤（手/脸/串位/变脸）标记重抽。

### 验收路线与风险

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| H3 权重未安装，本地成片质量/耗时/音频未实测 | 方案依赖本地 GPU 结论 | 先完成 roadmap「权重安装 + 真实 GPU 出片记录」再动 P5 后端 |
| 本地无 Context-IR，长提示词/多镜头质量打折 | 单镜质量波动 | 严格按官方 skill 组装 + 角色卡片 + 固定配方；关键镜人工精修 |
| 16GB 显存批量吞吐慢（12 镜 ≈ 30–60 分钟） | 等待时间长 | 默认 standard 档、5s 镜、批量视图显示预计耗时；支持夜间挂批 |
| 对白口型与多说话人效果未知 | 对白镜质量风险 | P7 前先用 2–3 镜对白实测（无对白片可先上线） |
| 单镜失败/超时打断整批 | 批量可靠性 | 逐镜独立状态 + 失败重试 + 断点续批（进度落盘，参考 showcase 并发池教训） |

## 五、参考来源

- [掘金：AI短剧创作入门：剧本、分镜、生成、剪辑](https://juejin.cn/post/7673940698534199296)（2026-08-15，六阶段流水线与工具对比）
- [塔猴：AI短剧怎么制作：2026年全流程指南](https://www.tahou.com/article/211936539248722949)（2026-07-17，含 76% 一致性痛点、8–15 分镜/分钟、参考图驱动法、成本数据）
- [AI短剧圈：闲人一坤《山海奇镜》可灵AI制作全复盘](https://aiduanjuquan.com/behind-the-scenes/ai-short-drama-kling-case)
- [新榜对话：Ai短剧《山海奇镜》全网刷屏背后](https://news.qq.com/rain/a/20240719A04MHS00)
- [MiniMax H3 官方仓库（能力规格/FL2VA/Ref2VA/Context-IR）](https://github.com/MiniMax-AI/MiniMax-H3)（本项目 `.agents/skills/h3-prompt-writing/` 已同步其官方 skill）
- [minimaxh3.art：全面解读 MiniMax H3（参数佐证，二手整理）](https://minimaxh3.art/zh/blog/minimax-h3-hailuo-3-what-we-know-zh)
- [LTX Studio（Lightricks）](https://www.lightricks.com/ltx-studio)、[Runway（Act-One 表演迁移）](https://runwayml.com/)
- 本机核查：`E:\code\2\lora\AI\ComfyUI\comfy_extras\nodes_minimax_h3.py`（`first_frame`/`last_frame`/`length` 训练区间）

## 六、留档要求

按 AGENTS.md（2026-08-15 决策）：实施过程中反复排查才解决的疑难（如 FL2VA 尾帧接线、批量队列竞态、对白口型问题），必须把「现象 → 根因 → 修复 → 验证」追加到本文档或 `docs/engineering-contracts.md`（由视频链路负责人维护），标注日期。
