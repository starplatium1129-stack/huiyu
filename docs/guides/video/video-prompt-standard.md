# 视频提示词规范

> [!NOTE]
> - 模型参数与运行时能力见 [独立图像与视频推理](../independent-inference.md) 与 [适配清单](../../../tools/inference/adapter-models.json)，分镜工作流见 [视频与分镜工作流](video-ai-storyboard.md)。
> - 本规范约束提示词结构、工作台积木与多模型编译方向；实际成片画质、口型与音画同步以主力机实测为准。

## 核心原则

1. **写时间演化，不堆静态标签**：按「起势 → 过程 → 落幅」编写自然语言，不用 Danbooru 词条堆砌或 `(tag:1.2)` 权重语法。
2. **单一动作主线**：3–5 秒短片聚焦 1 个清晰主动作与 1 种克制运镜，不塞入多段硬切或相互矛盾的运动方向。
3. **按输入分工，不与素材打架**：首帧/尾帧已锁定的外貌、衣装与构图不重复堆砌；动作视频或配音已决定的肢体与口型不写冲突位移。
4. **全分级自由创作**：沿用 [NSFW 与全分级 CG 提示词规范](../prompts/nsfw-cg-prompt-standard.md)，支持全年龄至 NSFW/R18 自由创作；衣着状态、动作神态与亲密接触如实编写，不人为降级。

---

## 1. 输入模式写法边界

| 模式 | 画面主责 | 推荐句序 | 核心避坑 |
| --- | --- | --- | --- |
| 文生视频（`text`） | 提示词定义全部画面 | 媒介与景别 → 主体与场景 → 单一动作过程 → 运镜 → 环境动态与收尾（+声景） | 忌写成无时间变化的静物描写 |
| 图生视频（`image`） | 首帧锁定外貌、衣装与构图 | 承接首帧状态 → 主体动作与神态变化 → 运镜 → 环境/光影响应 → 收尾 | 忌大段复述静态外貌，或写与首帧矛盾的服饰与背景 |
| 首尾帧（`first-last-frame`） | 首帧定起点、尾帧定终点 | 首帧起步 → 可观测中间过渡 → 动作/机位/光影收敛到尾帧 | 忌并排写两段静态图描写；优先单镜头连续过渡 |
| 动作驱动（`wan-animate-2`） | 角色图 + H.264 MP4 动作视频 | 画风/光影/环境氛围 + 角色身份与画面稳定 | 忌写与参考视频冲突的大幅走位、转身或换装 |
| 配音驱动（`longcat-avatar-1.6`） | 角色图 + PCM WAV 配音 | 说话神态与情绪基调 + 自然头肩微动 + 光影与稳机位 | 忌写闭嘴、背对镜头或大幅位移；不重复输入台词全文 |

> **跳舞 / 律动图生视频要点**：3–5 秒单镜头聚焦 1 组节拍明确的连续动作（踩拍晃肩、轻旋扬裙、甩袖/摆胯）与发梢、衣摆惯性跟随，配合固定机位或低幅缓弧运镜；需要长段复杂编舞时，优先用「动作驱动（`wan-animate-2`）」传参考舞蹈视频。

---

## 2. 模型家族速查与编译规则

### 2.1 原生视频模型能力速查

| 模型 ID | 支持模式 | 时长 / 帧率 | 原生音频 | 负向词 / CFG | 编译目标格式 |
| --- | --- | --- | --- | --- | --- |
| `minimax-h3` | `text` / `image` / `first-last-frame` | 5 / 10 秒 · 24 fps | 32 kHz | 否（`cfg=1`） | 英文三段式（关键帧对齐 + 音画 + 声景 + 配乐） |
| `ltx-2.3` | `text` / `image` | 3 / 5 秒 · 24 fps | 48 kHz | 是（`cfg=3`） | 英文单段现在时电影散文（画面与声音融合） |
| `ltx-2.5-distilled` | `text` / `image` | 3 / 5 秒 · 24 fps | 48 kHz | 否（`cfg=1`） | 同上；8 步蒸馏无负向词，正向需写得更具体 |
| `wan2.2-ti2v-5b` | `text` / `image` | 3 / 5 秒 · 24 fps | 无声 | 是（`cfg=5`） | 中/英自然语言视觉动态段 + 按需裁剪负向词 |
| `wan2.2-14b` | `text` | 3 / 5 秒 · 16 fps | 无声 | 是（`cfg=4/3`） | 同 Wan 2.2；双噪声阶段更响应光影层次与运镜 |
| `hunyuan-video-1.5` | `text`（480p） | 3 / 5 秒 · 24 fps | 无声 | 是（`cfg=6`） | 中/英自然语言视觉段；含 ByT5，画面文字用引号保原文 |
| `kandinsky-6-lite-distill` | `text` / `image` | 固定 5 秒 · 24 fps | 44.1 kHz 单声道 | 否（`cfg=1`） | 2–3 句精炼英文单主线动作 + 同步物理声景 |
| `wan-animate-2` | `image` + 动作视频 | 3 / 5 秒 · 24 fps | 无声 | 否（`cfg=1`） | 中/英简短定调（画风、光影、氛围与稳定性） |
| `longcat-avatar-1.6` | `image` + 配音 WAV | 3 / 5 秒 · 25 fps | 跟随配音 48 kHz | 否（`cfg=1`） | 英/中简短神态、微动作与光影定调（默认稳机位） |

### 2.2 分家族要点

- **MiniMax H3**：按 [H3 格式指南](../../../.agents/skills/video-prompt-craft/references/h3-prompt-writing.md) 组装。`image` 首行写 `For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.`；`first-last-frame` 首行写 `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the S.SS-second mark of the target video.`，空一行后依次写 `integrated_multimodal_description`、`overall_soundscape`、`non_diegetic_music`。对白用 `(S1)` 与 `<d>[Language] 原文</d>`，无配乐写 `N/A`。（原生接口当前 `references` / `dialogue` 独立字段尚待接入，以 `adapter-models.json` 的 `pendingVideo` 为准。）
- **LTX-2.3 / LTX-2.5 Distilled**：本地推理关闭内置扩写（`enable_prompt_enhancement=False`），输入正文须自带完整细节。统一写为**单段英文现在时电影化散文**：`画风与构图 → 主体连续动作与微表情 → 镜头运动 → 光线与环境响应 → 同步环境音/音效/对白`。不用标签堆砌，不写 `masterpiece`、`8k` 等空泛画质词；`ltx-2.5-distilled` 不接收负向词。
- **Wan 2.2（5B / 14B）与 HunyuanVideo 1.5**：中英文自然语言均可，聚焦可见动态与运镜，**自动剥离配乐与纯声音描写**（无声模型写声音词会稀释视觉权重）。负向词从基础负面起步并剔除冲突项（如需要轻柔微动/定格时删去「静止/静态」，需要画面文字时删去「字幕/文字」）；Hunyuan 1.5 画面文字用双引号保留原文。
- **Kandinsky 6.0 Lite Distill**：本地推理关闭内置扩写（`expand_prompts=False`），固定 5 秒且不支持负向词。用 2–3 句简洁英文写清「单一动作主线 + 明确运镜 + 对应物理环境声」，不在 5 秒内切换多镜头。
- **驱动类（Wan-Animate-2 / LongCat-Avatar 1.6）**：提示词仅作辅助定调（画面质感、光线色温、微表情倾向与镜头稳定），不写大幅位移、换装或与驱动源矛盾的口型/姿态；`cfg=1` 不传负向词。

---

## 3. 工作台积木槽位与编译契约

面向「场景预设 + 点选积木 + 自动编译」的统一数据结构：

| 槽位 | 内容职责 | 生效模式 | 编译取舍 |
| --- | --- | --- | --- |
| `framing` | 景别与机位视角 | `text`（`image` 仅作承接参考） | 驱动模式省略；I2V 不覆盖首帧构图 |
| `subject` | 开场主体、衣着状态与场景锚点 | `text` | `image` / `first-last-frame` 隐去外观复述，仅保留动作起点 |
| `action` | 1 条主动作 + 神态变化（或 FL2V 过渡路径） | `text` / `image` / `first-last-frame` | 驱动模式降级为轻量神态与稳定提示 |
| `camera` | 运镜类型、幅度与速度 | 除配音驱动外均可用 | 若正文已写明确运镜，编译层不重复追加兜底运镜句 |
| `atmosphere` | 风/雨/光影/粒子等物理与环境响应 | 全模式 | 驱动模式重点保留光照与氛围 |
| `ending` | 动作落幅、定格节奏或尾帧收敛状态 | `text` / `image` / `first-last-frame` | FL2V 必须收束至尾帧姿势与构图 |
| `audio` | 环境声景、物理音效、对白与配乐选择 | 仅原生带音视频模型 | Wan 2.2 / Hunyuan 1.5 / Wan-Animate-2 编译时自动剥离 |

**防冲突规则**：
1. **同槽单选互斥**：运镜方向（推进/拉远/横移/环绕/固定）、景别与节奏等互斥项单选，避免出现自相矛盾的运动指令。
2. **按模式与模型动态裁剪**：无声模型隐藏声景与配乐积木；I2V 隐藏重复静态外观槽；驱动模式仅露出氛围、光影与神态定调；`negative: false` 模型隐藏负向输入框。
3. **不机械重复拼接**：用户或预设已在 `action` 写清运镜或动作幅度时，编译层直接复用，不再叠写默认英文/中文兜底句。

---

## 4. 多模型编译对照范例

### 范例 A：图生视频（`image`）· 雨夜回眸微动

- **工作台点选积木**：动作「微风拂动发梢，缓缓回眸微笑」 · 运镜「缓慢推近」 · 环境「细雨与窗面霓虹反光」 · 收尾「眼神落定、构图稳定」 · 声音「细雨声 + 轻柔钢琴」

**Wan 2.2（5B）**（中文视觉动态段，剥离音频）：
```text
保持首帧中的人物外貌、服装与场景结构，微风拂动她的发梢，她缓缓回眸露出柔和的微笑。镜头平稳缓慢推近，细雨在窗面滑落并映出流动的霓虹反光。动作自然收束，眼神落定后保持画面与构图稳定。
```

**LTX-2.3 / LTX-2.5 Distilled**（单段英文现在时电影散文，融合声景）：
```text
Continuing smoothly from the opening frame, a gentle breeze lifts the character's hair tips as she slowly turns her head over her shoulder and offers a soft smile. The camera pushes in steadily toward her face while fine rain streaks down the window beside her, reflecting soft neon glow across her eyes. Light rain taps against the glass over quiet ambient room tone and sparse gentle piano notes as her gaze settles.
```

**MiniMax H3**（I2VA 首行对齐 + 三段式）：
```text
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] 2D-animated, cinematic, the character shown in <Picture 1> remains in her pose and outfit as a gentle breeze lifts her hair tips. She slowly turns her head to look back with a soft smile while the camera pushes in at slow speed with small amplitude. Raindrops slide along the window, catching shifting neon reflections before her gaze settles steadily.

overall_soundscape: Soft rain taps steadily against the window glass with quiet indoor ambience and subtle fabric rustle.

non_diegetic_music: Soft piano notes at a slow tempo with delicate resonance, fading gently near the end.
```

**Kandinsky 6.0 Lite Distill**（5 秒单主线精炼英文 + 雨声）：
```text
From the first frame, the character turns her head gently with a soft smile as a light breeze moves her hair. The camera pushes in slowly while rain slides down the neon-lit window, accompanied by steady light rain tapping on the glass.
```

### 范例 B：文生视频（`text`）· 晨光窗边读信

- **工作台点选积木**：景别「半身中景」 · 主体「晨光书房窗边手持信纸的少女」 · 动作「指尖停在纸边，轻抬眼望向窗外」 · 运镜「固定机位」 · 环境「柔和晨光与轻晃白纱窗帘」 · 声音「安静室内与翻纸轻响，无配乐」

**Wan 2.2 / HunyuanVideo 1.5**（视觉动态段，剥离音频）：
```text
半身中景，2D 动画电影质感。清晨的柔和阳光照进安静书房，一位少女坐在窗边手持展开的信纸。她的指尖轻轻停在信纸边缘，随后缓缓抬眼望向窗外，微风吹动白色纱帘在光影中轻轻晃动。固定机位保持稳定，最后定格在她望向窗外的平静侧影。
```

**LTX-2.3 / LTX-2.5 Distilled**（英文现在时单段）：
```text
A 2D-animated cinematic medium shot frames a young woman seated beside a sunlit study window, holding an open letter in both hands. Her fingertips pause along the paper edge before she slowly lifts her gaze toward the bright window, while a sheer curtain sways gently in the morning breeze and warm light shifts across the page. The camera holds a steady static frame, capturing quiet room ambience and a soft rustle of paper with no background music.
```

**MiniMax H3**（T2VA 三段式，无配乐写 `N/A`）：
```text
integrated_multimodal_description: [Shot 1] 2D-animated, cinematic, a medium shot frames a young woman seated beside a sunlit study window holding an open letter. The camera holds a static shot as her fingertips pause on the paper edge and she slowly lifts her eyes toward the window, while soft morning light warms the room and sheer curtains sway in a light breeze.

overall_soundscape: Quiet morning room tone with a gentle breeze through the window and the faint crisp rustle of paper.

non_diegetic_music: N/A
```

---

## 5. 编写与审查清单

- [ ] **动态单一连贯**：有明确起势、过程与落幅；无静态标签堆砌或冲突运镜词。
- [ ] **输入职责清晰**：I2V 不复述首帧静态外貌，FL2V 描述中间过渡路径，驱动类不写冲突位移。
- [ ] **模型格式对齐**：H3 用三段式与关键帧首行，LTX 用单段现在时英文散文，无声模型已剥离音频与配乐。
- [ ] **负向与分级合规**：`cfg=1`（`negative: false`）模型不传负向词；负向词不与目标画面冲突；身份、衣着与全分级创作如实保留。
- [ ] **验证边界如实标注**：仅确认提示词结构与编译合规；真实画质、音画同步与口型仍待主力机实测。
