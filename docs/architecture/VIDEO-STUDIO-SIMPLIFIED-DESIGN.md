# 极简点选式套图与短片创作工作流方案

> 状态：已定稿待实施（技术交接文档）  
> 适用范围：绘遇 · HUIYU 创作项目（`StudioProjectsView`）、H3-Image 关键帧工坊、原生视频管线与整片导出  
> 协作与验证基准：[AGENTS.md](../../AGENTS.md) · [视频与分镜工作流](../guides/video/video-ai-storyboard.md) · [视频提示词规范](../guides/video/video-prompt-standard.md)

---

## 1. 核心产品目标与设计原则

在吸收 2026 年社区主流本地动漫短片工作流（高一致性净底定妆、星型锚定、抽尾帧连续接力、全身神态对白、声画混音后制）的同时，**彻底隐藏复杂的多步工序与底层参数**：

1. **前台极简（点点手指即出好图、顺手成片）**：
   - 默认前台界面**不暴露**提示词手写框、4 行变化文本框、参考图 1/2/3/4 序号排序、模型下拉选择、像素画幅与种子设置；
   - 日常创作压成 **3 步点选**：`选角色 → 点衣柜/表情/动作/场景标签（或输入镜头台词） → 点生成 / 一键成片`。
2. **后台专业（先进工作流静默兜底）**：
   - 净底平光锚点缓存、星型锚定防漂移、语义参考槽装配、标签到 H3-Image 保真指令编译、单卡按模型串行排队、自动抽尾帧、本地 TTS 配音直出、微裁剪与 BGM 闪避混音全部由系统后台自动编排。
3. **不剥夺专家控制权（渐进披露）**：
   - 原有「自由指令编辑、手动排序参考图、切换底模/步数/种子、单镜返工精调」全部保留，收拢进安静的 **「高级编辑」** 折叠抽屉，按需展开。
4. **全分级创作自由**：
   - 标签编译与 H3-Image / 视频路由完整支持全年龄（SFW）至成人（NSFW/R18）衣装、神态与动作自由创作，不做人为降级或隐藏遮蔽。

---

## 2. 已实现基础与当前缺口

### 2.1 现有已跑通底座
- **关键帧工坊**（[KeyframeWorkbench.vue](../../src/components/studio/KeyframeWorkbench.vue)、[useKeyframeWorkbench.ts](../../src/components/studio/useKeyframeWorkbench.ts)）：本机 `sd-cpp` 已跑通 `minimax-h3-image-q4`（6 步、1–4 张有序参考图）与 `flux-kontext-dev`，支持每批最多 4 张候选入素材库并绑定镜头首/尾帧。
- **原生视频管线**（[StudioShotVideoPanel.vue](../../src/components/studio/StudioShotVideoPanel.vue)、[StudioExportPanel.vue](../../src/components/studio/StudioExportPanel.vue)、[studio-workflows.json](../../runtime-rs/src/video/studio-workflows.json)）：单卡按模型串行队列、缺帧自动先补帧、Wan 2.2 A14B GGUF 首尾帧/单图动态、MuseTalk 1.5 配音对口型、单镜返工与带配音/2x 超分/2x 插帧的桌面整片导出。
- **底层待接通模型资产**（[adapter-models.json](../../tools/inference/adapter-models.json)）：已适配 `longcat-avatar-1.6`、`minimax-h3`（本地量化 4/8 步 Turbo）、`ltx-2.5-distilled`、`wan-animate-2`、`qwen-image-2.1`，尚未接入分镜工作台。

### 2.2 核心缺口
1. 缺少 `outfit`（衣装差分）独立资产分类，衣柜/表情/动作标签未接入 H3 工坊，目前需纯手写变化指令。
2. 缺少「净底平光锚点」与「星型锚定」机制，连续换装易串脸、串背景或逐代漂移；换装一致性尚未完成真实出图验收。
3. 缺少跨镜连续接力（上一镜成片抽尾帧绑定下一镜首帧）与分镜内一键 TTS 生成 WAV 配音。
4. 整片导出缺少单镜首尾裁剪（Trim）、BGM 轨与人声自动闪避（Ducking）、字幕与动画帧率预设。
5. 分镜对白目前仅有局部贴嘴的 `MuseTalk 1.5`，尚未接通仓库已有的头身微动对白与原生音视频/动作驱动引擎。

---

## 3. 全链路资产规范与模型自动路由（后台隐式规则）

系统在后台统一遵循 **「净底定妆 → 净底差分 → 场景合光 → 视频表演与后制」** 四步标准，用户无需理解技术术语：

| 生产阶段 | 资产类型（`StudioAssetKind`） | 参考图标准规范 | 系统默认路由模型 | 防漂移与一致性约束 |
| --- | --- | --- | --- | --- |
| **1. 净底定妆** | `character`（后台可关联隐式净底锚点版本） | 单人正面/微 3/4 侧面、全身或七分身、**纯浅中性灰（`#EAECEF`）或纯白底 + 均匀平光**、无文字/色卡/强偏色打光；按需配 1 张面部近景特写 | 从 0 建角色用 **Anima（MiaoMiao 1.6 + 角色 LoRA，无画师）**；已有带背景立绘由 **H3-Image / Qwen-Image-2.1** 自动洗出净底平光版 | 不拼低分辨率多格图（防 1024px 下小脸模糊）；复杂转身戏再拆独立侧/背单图 |
| **2. 净底差分** | **新增 `outfit`（衣装差分）**、`expression`（表情差分）、`pose`（动作差分） | 同样保持**纯色浅底 + 均匀平光**，先稳住服装/表情/姿态，不与复杂背景抢权重 | **MiniMax H3-Image Q4**（主力，6 步批出 4 张快选）；高清精修或高分辨率三视图拆图由 **Qwen-Image-2.1** 承担 | **强制星型锚定**：所有换装永远固定 `图 1 = 原始净底角色主图`，严禁「换装 A → 换装 B」链式编辑 |
| **3. 场景合光成套图 / 关键帧** | `scene`（绝对无人物空镜）+ `keyframe`（带环境光影的成片/首尾帧） | 场景参考图必须**无人物**、画幅与目标成片一致 | 空镜：Anima / MOSS（与角色同画风无缝融合）或 Krea 2 Turbo（电影空间感）；合光：**H3-Image Q4** | 后台固定参考槽语义：`图 1 净底衣装差分 + 图 2 净底脸/近景(可选) + 图 3 无人物场景空镜`；连续镜直接抽**上一镜成片尾帧**做首帧 |
| **4. 视频表演与整片后制** | `audio`（项目内 TTS 直出或导入 WAV）+ `clip` + 整片 MP4 | 优先使用带环境合光后的清晰首尾帧；对白首帧需正面或微侧清晰人脸 | 轻动/转场：Wan 2.2 FLF/I2V；对白：MuseTalk 1.5（快草稿）→ `longcat-avatar-1.6`（精片）；原生音画/复杂动作逐步接入 `minimax-h3` / `ltx-2.5` / `wan-animate-2` | 单卡按模型串行；导出自动微裁剪防首尾抖动，支持 BGM 闪避与 24fps 动画节奏保持 |

---

## 4. 三阶段落地方案

### Phase 1：点点手指出一套好看的图（换装工坊极简重构 + 一致性验收）

**核心目标**：把现有手写表单工坊改造成「选角色 → 点衣柜/表情/动作/场景标签 → 一键出 4 张好看的图」，并完成 H3-Image 连续换装真机验收。

#### 1.1 资产分类与草稿模型扩展
- **涉及文件**：
  - [types/studioProject.ts](../../types/studioProject.ts)
  - [src/storage/studioProjectRepository.ts](../../src/storage/studioProjectRepository.ts)
  - [runtime-rs/src/storage/studio.rs](../../runtime-rs/src/storage/studio.rs) · [studio-schema.sql](../../runtime-rs/src/storage/studio-schema.sql)
  - [src/components/studio/projectAssets.ts](../../src/components/studio/projectAssets.ts) · [keyframeDraft.ts](../../src/components/studio/keyframeDraft.ts)
- **改动要点**：
  1. 在 `studioAssetKinds` 与 Rust/SQLite 校验枚举中新增 `'outfit'`（`衣装差分`），支持素材库 [StudioAssetHub.vue](../../src/components/studio/StudioAssetHub.vue) 独立按「衣装差分」筛选与一键复用。
  2. 为角色基准资产增加轻量来源元数据标识（标记是否为「净底平光锚点」及其源角色 ID），用于后台自动执行星型锚定，不向用户暴露额外概念。
  3. 更新 `keyframeDraft.ts`：
     - `CandidateKind` 扩展为 `'outfit' | 'expression' | 'pose' | 'keyframe'`；
     - `defaultForm()` 在本机 `minimax-h3-image-q4` 可用时默认选中 `minimax-h3-image-q4`（保留 `flux-kontext-dev` 兼容与回退）；
     - 在 `canvases` 补充 `1024` 档（如 `768×1024` 竖幅、`1024×768` 横幅、`1024×1024` 方形，按所选模型 `maxSize`/`alignment` 自动过滤），保证角色面部像素充足。

#### 1.2 「点点手指」极简工坊前台与标签编译器
- **涉及文件**：
  - [src/components/studio/KeyframeWorkbench.vue](../../src/components/studio/KeyframeWorkbench.vue)
  - [src/components/studio/useKeyframeWorkbench.ts](../../src/components/studio/useKeyframeWorkbench.ts)
  - 复用衣柜与标签数据源：[src/composables/prompt/useOutfitPresetLibrary.ts](../../src/composables/prompt/useOutfitPresetLibrary.ts) · [src/utils/outfitReplacement.ts](../../src/utils/outfitReplacement.ts)
  - 新增纯函数模块：`src/components/studio/h3TagCompiler.ts`（将点选标签与模式编译为 H3-Image 保真编辑指令）
- **极简前台交互结构**：
  - **顶层只需选 1 个创作模式**（4 枚卡片式分段，默认打开「换装 / 拍套图」）：
    1. **换装（`outfit`）**：选角色 → 在角色专属衣柜 + 通用衣柜卡片里点选 1–4 套服装（或部件标签组合）→ 点「生成衣装套图」；系统自动填入 1–4 组变化并一次批出 4 张。
    2. **表情 / 动作（`expression` / `pose`）**：选角色或已生成的衣装造型 → 点选 1–4 个表情/姿势卡片 → 一键批出差分。
    3. **进场景拍套图（`keyframe`）**：点选「当前造型」+ 点选「场景库预设/项目空镜」+ 点选「氛围/镜头感预设（特写 / 半身 / 全身 / 窗边回眸 / 对话构图等）」→ 一键出 4 张统一画风的高清场景套图。
    4. **一键整理净底（半自动入口）**：如果角色立绘带复杂背景，界面提供一键「整理为干净基准立绘」快捷动作（或在首次换装时自动提示/后台准备）。
  - **一键接力流转**：每张生成的候选卡上直接提供快捷动作：
    - 衣装卡：`用这套拍场景`（自动带入场景拍套图模式）/ `继续做表情` / `设为当前造型`
    - 场景成片卡：`用作首帧` / `用作尾帧` / `加入短片镜头`
  - **高级编辑折叠抽屉**：原有「参考图 1–4 手动排序、手写编辑指令、4 行手写变化、模型切换、具体分辨率与起始种子」全部收入默认收起的「高级编辑」中；用户点标签时同步生成可审阅/可微调的底层指令，不锁死高级用户。
- **后台自动星型锚定与 `h3TagCompiler.ts` 规则**：
  - 换装模式下，即使用户刚看完某张换装图并点击「再换一套」，后台仍自动以该角色的**原始净底基准图**锁定在参考槽 1，绝不拿上一轮换装图做二次换装输入。
  - 若引入外部服装参考图，自动在指令中注入防串脸守卫句（严格锁定参考图 1 的五官、瞳色、发型、发饰与二次元线稿画风，仅采纳参考图 2 的服装款式与材质）。
  - 场景合光模式下，后台按 `图 1 衣装造型 + 图 2 基准脸(若衣装为远景则自动附带) + 图 3 无人物场景空镜` 自动排槽，并生成统一光线融合指令。

#### 1.3 H3-Image 换装一致性实机验收协议（必须真实出图校验）
验收结果用于校准 `h3TagCompiler.ts` 的默认守卫句与推荐出图张数，**不以臆测代替实测**：
1. **对照组 A（星型锚定 vs 链式换装）**：同一角色（如宁宁 / 夏目）连续换 4 套跨度大的服装（校园制服 / 礼服 / 泳装或居家便服 / 复杂饰品和风），记录星型锚定与链式编辑在脸型、瞳色、呆毛/发饰、画风线稿上的保持度差异。
2. **对照组 B（多图合光防串脸）**：实测 `角色图 + 服装参考图 + 场景空镜`（2 图与 3 图输入），验证是否出现串脸或旧服装残留，确定最稳的槽位顺序与英文指令句式。
3. **对照组 C（换装后跨视角与强光影）**：拿换装差分图再出 45° 侧脸、坐姿、强逆光夜景，验证领结/纹样/袖口稳定性，并统计每批 4 张中的可直接采用率（用于决定默认候选张数）。

---

### Phase 2：套图一键连成有声短片（低显存高收益闭环）

**核心目标**：补齐跨镜连贯、免手动倒腾音频与成片级后期，全部复用现有 FFmpeg 与本地 TTS，几乎零新增显存压力。

1. **「续拍下一镜」自动抽尾帧接力**
   - 涉及文件：[StudioVideoHistory.vue](../../src/components/studio/StudioVideoHistory.vue)、[StudioShotInputs.vue](../../src/components/studio/StudioShotInputs.vue)、[runtime-rs/src/video/transcode.rs](../../runtime-rs/src/video/transcode.rs)。
   - 在已完成的镜头片段上增加「续拍下一镜」按钮：后端用 FFmpeg 抽取该成片倒数第 2 帧（可切倒数第 1–3 帧防尾帧压缩糊）直接存为项目 `keyframe` 资产，新建下一镜头并自动绑定为 `firstVersionId`，同时继承上一镜的角色与场景上下文。
2. **镜头内台词直出角色 WAV 配音**
   - 涉及文件：[StudioShotInputs.vue](../../src/components/studio/StudioShotInputs.vue)、[StudioShotVideoPanel.vue](../../src/components/studio/StudioShotVideoPanel.vue)、既有 `runtime-rs/src/voice/`。
   - 用户只需在镜头台词栏打字并选角色（默认继承当前角色），点击「生成配音」即静默调用本机 TTS 合成 48kHz/PCM WAV 入素材库并绑定到 `audioVersionId`（保留手工上传 WAV 作为高级选项）。
3. **导演台前台意图化**
   - [StudioShotVideoPanel.vue](../../src/components/studio/StudioShotVideoPanel.vue) 默认展示 3 枚自然语言演出模式卡片：
     - `画面轻动`（自动映射 `wan22-i2v` + 温和运镜）
     - `首尾过渡`（自动映射 `wan22-flf`）
     - `开口说话`（自动走配音驱动模式，若镜头已有台词但未合成配音，提交前一键自动补齐 TTS WAV）
   - 运镜细节、步数、分辨率、工作流模板、种子锁全部收进「高级参数」折叠区。
4. **一键成片导出增强**
   - 涉及文件：[StudioExportPanel.vue](../../src/components/studio/StudioExportPanel.vue)、[runtime-rs/src/video/transcode.rs](../../runtime-rs/src/video/transcode.rs)、[runtime-rs/src/storage/studio-export-schema.sql](../../runtime-rs/src/storage/studio-export-schema.sql)。
   - 前台提供 3 档一键成品预设（细节可展开微调）：
     - `极速粗剪预览`：无超分、无插帧，秒级合片看整体节奏；
     - `动画电影成片（推荐）`：保持 24fps 动画节奏（防强插帧重影与肥皂剧感）+ 2x 动漫友好超分 + 自动轻裁头尾抖动；
     - `丝滑高清成片`：2x 超分 + 2x 镜内插帧。
   - 补齐 4 项纯 FFmpeg 成片能力：
     - **单镜入点/出点裁剪（Trim In/Out）**：轻松切掉前 0.3s 未起势或末尾 0.5s 轻崩帧，显著减少整镜返工；
     - **轻量转场**：硬切 / 0.3s 叠化 / 淡黑；
     - **BGM 音轨与人声自动闪避（Ducking）**：允许选一首背景音乐，遇到对白镜头自动压低 BGM 音量并做平滑淡入淡出；
     - **可选对白字幕**：直接从镜头台词导出 SRT 或烧录简洁字幕。

---

### Phase 3：后台静默换装更强视频大模型（前台零学习成本升级）

前台依然保持 Phase 2 的极简意图按钮，后台把 [adapter-models.json](../../tools/inference/adapter-models.json) 中已经就绪的新模型逐步接进 [studio-workflows.json](../../runtime-rs/src/video/studio-workflows.json) 与 [native.rs](../../runtime-rs/src/video/native.rs)：

1. **对白表演双档升级（`longcat-avatar-1.6`）**：
   - 保留 `musetalk-1.5` 作「极速草稿对白」，接通已适配的 **`longcat-avatar-1.6`**（后续可按需评估 `InfiniteTalk / Wan 2.2 S2V GGUF`）作「影视级全身神态对白」；在「开口说话」意图下自动按「快稿 / 精片」切换，说话时连带呼吸、抬头、眨眼与发丝一起动。
2. **打通 `minimax-h3` 原生音视频与 Ref2VA + `ltx-2.5-distilled`**：
   - 解除 [native.rs](../../runtime-rs/src/video/native.rs#L88-L96) 对 `references` / `dialogue` / `dialogueLang` / `shotSize` 的占位拒绝，接入 H3 Ref2VA 与原生对白/声景参数；高显存机器（24GB+）可直接由「净底衣装 + 场景空镜 + 台词」一步出 5–10 秒原生音画镜头。
3. **动作驱动（`wan-animate-2`）与进阶辅助**：
   - 将已适配的 `wan-animate-2` 接进演出模式的「参考动作驱动」（绑定简短动作参考视频解决复杂转身/拥抱/舞蹈穿模）；
   - 按需补充「一键生成多视角定妆表并自动拆单图」「关键帧局部遮罩修补回流绘制台」与「无声镜头 AI Foley 拟音」。

---

## 5. 并行开发边界建议

| 阶段 | 工作包 | 独占文件域 | 前置依赖 |
| --- | --- | --- | --- |
| **Phase 1A** | `outfit` 分类全栈打通 + 1024 画幅与默认 H3-Image 配置 | `types/studioProject.ts`、`src/storage/studioProjectRepository.ts`、`runtime-rs/src/storage/studio*`、`src/components/studio/projectAssets.ts`、`keyframeDraft.ts` | 无 |
| **Phase 1B** | 极简点选工坊 UI + 衣柜/表情/动作标签接入 + `h3TagCompiler.ts` + 星型锚定 | `src/components/studio/KeyframeWorkbench.vue`、`useKeyframeWorkbench.ts`、`h3TagCompiler.ts`、`StudioAssetHub.vue` | 依赖 1A 资产类型 |
| **Phase 1C** | H3-Image 换装一致性实机 3 组对照验收并校准编译器守卫句 | 实机运行（临时样张放 `runtime/`，不进 Git），回写 `h3TagCompiler.ts` 模板 | 依赖 1B |
| **Phase 2A** | Rust 侧：抽尾帧接口、导出 Trim/转场/BGM Ducking/字幕与预设 | `runtime-rs/src/video/transcode.rs`、`runtime-rs/src/storage/studio-export-schema.sql`、对应 HTTP 路由 | 无（可与 Phase 1 并行） |
| **Phase 2B** | 前端侧：续拍下一镜、分镜内 TTS 直出、演出意图化、导出预设 UI | `StudioShotInputs.vue`、`StudioVideoHistory.vue`、`StudioShotVideoPanel.vue`、`StudioExportPanel.vue` | 依赖 2A |
| **Phase 3** | 后台新模型路由：`longcat-avatar-1.6`、`minimax-h3` Ref2VA、`ltx-2.5`、`wan-animate-2` | `runtime-rs/src/video/studio-workflows.json`、`native.rs`、`tools/inference/*` | 依赖 Phase 2 意图路由框架 |

---

## 6. 验收与门禁标准

遵循 [AGENTS.md](../../AGENTS.md) 规范：**严禁新增或运行任何测试脚本**；以构建门禁、静态检查与主力机真机出图/成片实测验收。

### 6.1 构建与静态门禁
- `npm run typecheck` 通过
- `npm run build` 通过（核对 `check-bundle-budget.js` 未突破路由/入口预算）
- `cargo check`（`runtime-rs`）与 `npm run build:tauri`（`main` 工作区）通过
- `npm run wf -- docs:check` 通过

### 6.2 真机端到端体验验收
1. **点点手指出套图（Phase 1）**：不展开「高级编辑」、不手写任何提示词，仅通过「选角色 → 点 3–4 套衣柜标签 → 点生成」稳定批出 4 张衣服准确且脸/发型/画风不漂移的衣装差分，自动归入 `衣装差分` 分类；任选一张点击「用这套拍场景」能直接出统一光影的场景套图。
2. **换装一致性实测记录（Phase 1）**：完成 3 组对照（星型 vs 链式、多图合光防串脸、侧脸/强光影回验）并记录真实可用率，确认默认提示词编译器无需用户手调即可稳定过关。
3. **点点手指成有声短片（Phase 2）**：从套图挑 3 个镜头，用「续拍下一镜」接力 1 镜，在 1 个镜头里直接打字一键生成角色 TTS 配音并选择「开口说话」，单卡串行跑完后一键导出带 BGM 闪避、头尾微裁剪与字幕的 24fps 完整 MP4，全程无需离开项目页或手动准备外部 WAV。
4. **高阶模型无缝提质（Phase 3）**：在 24GB+ 机器开启新模型后，前端沿用同一套意图按钮，确认对白镜头自动呈现头身微动与表情联动、H3 Ref2VA 原生音画正常落盘。
