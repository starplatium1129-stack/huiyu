# 成年角色 NSFW / R-18 CG 提示词与蓝图编译规范

## 适用范围与定位

本规范面向 **Anima** 与本地 **Krea 2** 两大生成引擎，针对明确成年角色（`adultEligibility === 'adult'`）的成人向（R-18 / NSFW / 成人向 CG）画面创作与蓝图（Blueprint）编写。

本规范旨在填补既往文档在露骨场景、私密细节、体位姿态、服装半脱以及体液表现上的技术标准空白。所有规则严格建立在项目的工程契约与分级边界之上：
- **成年合法依据**：必须是明确成年的角色，严禁对未成年或年龄不明角色进行露骨创作；
- **Fail-Closed 保护**：仅在角色具备成年资格且本地宿主环境开启 `adultEnabled` 时放行；
- **真实出图验证**：编写的 Token 与自然语言描述必须经过真实渲染核对，拒绝无法落地的“概念化词条”。

---

## 一、工程契约与生成流水线底线

在 AI-CG-Studio 架构中，成人内容并不是简单地“追加两个露骨词条”，而是经过 `popularContent.ts`、`promptCompiler.ts` 和 `promptPolicy.ts` 三层深度过滤与转换的精密流水线。理解底层机制是编写高质量 NSFW 蓝图的前提。

### 1. 双重门禁与 Fail-Closed
* **放行公式**：`adultGranted = blueprint.adult && character.adultEligibility === 'adult' && options.adultEnabled === true`。
* **拦截表现**：三项中任何一项不满足，编译器直接返回 `null`，任何露骨词条均绝不进入渲染请求，前端保持安全遮罩（blur mask）或拒绝状态。

### 2. 身份散文自动重塑（`adultIdentityProse`）
* **词汇清洗**：为了避免公共模型拦截以及角色低龄化形变，编译器在 `adultGranted` 成立时会自动将角色身份描述中的学生与年轻词汇转换：
  * `girl` / `young girl` $\rightarrow$ `adult woman`
  * `schoolgirl` / `student` / `high-school student` $\rightarrow$ `adult alumna`
  * `teen` / `teenager` $\rightarrow$ `adult`
  * 强制前置：`The unmistakably adult, age-twenty-plus version of [Character]`
* **黑名单清洗**：`ADULT_IDENTITY_EXCLUDE_RE` 会过滤掉身份词中的 `child`, `loli`, `underage`, `minor`, `schoolgirl` 等标签。**编写蓝图时切勿手动塞回这些词条**，否则会触发编译器防御或引发画面崩坏。

### 3. 服装剥离与脱衣防冲突铁律
* **常服压制陷阱**：在全年龄模式下，编译器会注入 `She wears [outfit]` 或 `wearing [outfit]`。如果直接追加裸体词，模型会因为常服描述的高权重产生严重撕裂（例如：穿着全套校服却长着裸露器官，或衣服完全脱不下来）。
* **自动剥离机制**：当 `adultGranted` 生效时：
  1. 编译器会将 `outfitProse` 强行**置空（`''`）**；
  2. `isGarmentToken` 会将常服标签从注入列表移除；
  3. **编写铁律**：角色的裸露状态、半脱状态或情趣衣着（如吊带、丝袜、内衣、衬衫敞开），**必须完全由 `nsfwProse`（自然语言）和 `nsfwTokens`（底层标签）显式承载**。

### 4. 负向词动态清洗（`stripNegativeNsfw` / `adaptNegative`）
* **自动解禁**：在评级达到 `R18`（或蓝图标记为 `adult: true`）时，`promptPolicy.ts` 会自动从负向词中移除 `nsfw`, `nude`, `naked`, `explicit`，确保模型能够自由渲染肉体细节。
* **安全垫注入**：系统会自动在负向词中补充 `child`, `loli`, `underage` 进行年龄安全防范，并附加 `NEGATIVE_PROTECTION` 保护手部与解剖结构。
* **编写禁忌**：切勿在蓝图的 `negativeTokens` 中手动填写 `nude` 或 `nsfw`，否则等于正反抵消，导致出图失败。

---

## 二、双引擎（Anima vs. Krea 2）编写范式

| 维度 | Anima (Pencil-XL / SDXL) | Krea 2 (Flow / Diffusion) |
| :--- | :--- | :--- |
| **核心驱动** | 标签矩阵（Danbooru Tags）为主，散文为辅 | 纯自然语言散文（Prose）主导 |
| **NSFW 载体** | `nsfwTokens` 进入 `exactControls` | `nsfwProse` 置于 `sceneProse` 最首位 |
| **权重特征** | 标签靠前权重高，支持微调权重 | **首句权重最高（Front-loading rule）** |
| **擅长领域** | 精准器官细节、明确体位、特定符号道具 | 肌肤光影质感、感官氛围、衣料受光与解脱动态 |
| **失真风险** | 标签堆叠过多易多肢体、多手指、解剖畸变 | 医学化生硬词易产生抽象形变，需具象感官词 |

### 1. Anima 引擎的 Token 编排语法
在 Anima 中，`nsfwTokens` 会与角色的 `exactTokens`、`adult` 标签共同编译。建议遵循以下**由内而外、由大到小**的逻辑编排链：
$$\text{[POV/视角]} \rightarrow \text{[体位与支撑面]} \rightarrow \text{[暴露程度与服装破损]} \rightarrow \text{[私密器官细节]} \rightarrow \text{[体液与光泽]} \rightarrow \text{[表情与反应]}$$

* **正确示范**：
  `pov, on_back, spread_legs, m_legs, completely_nude, bare_breasts, pink_nipples, pussy, pussy_juice, heavy_blush, open_mouth, teary_eyed`
* **常见错误**：
  * 缺少支撑姿态（只写 `spread_legs` 容易导致双腿浮空漂移）；
  * 混合冲突的服装词（同时写 `completely_nude` 与 `skirt`）。

### 2. Krea 2 引擎的 Prose 编写语法
Krea 2 是自然语言模型，不能理解下划线标签堆砌。编译器会把 `nsfwProse` 拼在整段场景散文的最开头（优先解析）。编写时应遵循**感官叙事原则**：
* **前 25 词锁定肉体核心**：开门见山点明姿态、接触面与着装状态；
* **动词具象化**：用 `arching her back`、`legs parted wide`、`fabric slipping off her shoulders` 替代生硬名词；
* **光影烘托质感**：强调光线在皮肤、锁骨与微汗处的反光（`warm highlights along her glistening skin`）。

---

## 三、高频 NSFW 核心词汇与语义矩阵（Danbooru 体系）

在编写蓝图的 `nsfwTokens` 时，应使用标准 Danbooru 词条；在编写 `nsfwProse` 时转化为对应英文自然语言。

### 1. 暴露程度与服装互动（Undress & Garment State）
| 标签（Danbooru Tag） | 中文含义 | 自然语言散文表达（Krea 2） |
| :--- | :--- | :--- |
| `completely_nude` | 全裸 | entirely nude, fully exposed without any clothing |
| `topless` | 上身裸露 | topless, bare-chested with upper garments removed |
| `bottomless` | 下身裸露 | bottomless, waist down completely exposed |
| `panties_aside` | 内裤拉偏/移位 | pulling her panties aside with one hand |
| `lifted_skirt` | 掀起裙子 | lifting her skirt up to reveal her hips |
| `partially_unbuttoned` | 纽扣半解 | shirt unbuttoned to the navel, parting open |
| `lingerie` / `underwear` | 情趣内衣/内衣 | delicate lace lingerie clinging to her body |
| `thighhighs` / `garter_straps` | 过膝袜 / 吊袜带 | black sheer thighhighs held up by garter straps |
| `clothes_pulled_down` | 衣物褪下至局部 | dress pushed down around her waist |

### 2. 姿势体位与机位构图（Poses & Camera Angles）
| 标签（Danbooru Tag） | 中文含义 | 自然语言散文表达（Krea 2） |
| :--- | :--- | :--- |
| `pov` / `first-person_view` | 第一人称主观视角 | from a direct first-person POV looking down |
| `on_back` / `lying` | 仰卧 | lying on her back across the soft bed sheets |
| `spread_legs` / `m_legs` | 开腿 / M字腿 | resting with her legs spread wide in an M-pose |
| `all_fours` | 趴伏/四肢着地 | on all fours on the floor, arching her lower back |
| `kneeling` | 跪姿 | kneeling upright on the plush carpet |
| `from_above` | 俯视构图 | high-angle overhead shot looking down |
| `from_below` | 仰视构图 | low-angle upward perspective |
| `looking_back` | 回头顾盼 | glancing back over her bare shoulder |
| `head_back` | 仰头喘息 | tilting her head back in ecstasy |

### 3. 私密构造与身体细节（Anatomy Details）
| 标签（Danbooru Tag） | 中文含义 | 自然语言散文表达（Krea 2） |
| :--- | :--- | :--- |
| `bare_breasts` | 裸胸 | full bare breasts exposed to the air |
| `nipples` / `pink_nipples` | 乳头 / 粉色乳头 | prominent pink nipples blushing against pale skin |
| `cleavage` | 乳沟 | deep sensual cleavage |
| `pussy` / `vaginal` | 私密部位/阴部 | delicate intimate folds softly illuminated |
| `clitoris` | 阴蒂 | sensitive clitoris flushed with pink |
| `cameltoe` | 紧勒痕迹/骆驼趾 | tight outline pressing visibly against thin fabric |
| `collarbone` / `navel` | 锁骨 / 肚脐 | sharply defined collarbones and tender navel |

### 4. 体液、湿润度与光泽（Fluids & Sheen）
| 标签（Danbooru Tag） | 中文含义 | 自然语言散文表达（Krea 2） |
| :--- | :--- | :--- |
| `sweat` / `sweaty` | 汗水 / 汗涔涔 | glistening with a light coat of fine sweat |
| `glossy_skin` / `skin_sheen` | 皮肤光泽 | glowing skin highlighted by soft moisture |
| `wet_body` / `wet_hair` | 湿身 / 湿发 | soaked wet skin with damp strands of hair clinging |
| `water_droplets` | 皮肤凝结水珠 | crystal water droplets slowly trailing down her torso |
| `pussy_juice` | 爱液/体液湿润 | glistening wetness trailing along her inner thighs |
| `saliva` / `drool` | 唾液 / 嘴角垂丝 | a thin silver thread of saliva between parted lips |
| `cum` / `creampie` | 精液 / 体内流出 | warm white fluid dripping down inner thighs |

### 5. 神态、表情与心理张力（Facial Expressions & Mood）
| 标签（Danbooru Tag） | 中文含义 | 自然语言散文表达（Krea 2） |
| :--- | :--- | :--- |
| `heavy_blush` / `flushed` | 潮红/满面通红 | cheeks heavily flushed crimson with arousal |
| `parted_lips` / `open_mouth`| 樱唇微张 | lips softly parted in a gentle gasp for breath |
| `tongue_out` | 吐舌 | tip of her pink tongue playfully resting on her lip |
| `ahegao` | 阿黑颜/极乐恍惚 | dazed expression of overwhelming pleasure |
| `teary_eyed` | 眼角含泪 | glistening tears welling at the corners of her eyes |
| `heart_eyes` | 心形瞳孔 | faint heart-shaped glints in her dilated pupils |
| `half-closed_eyes` | 媚眼微阖/迷离 | hooded, languid eyes gazing seductively forward |
| `submissive` / `embarrassed`| 羞耻顺从 | flustered, trembling expression of shy surrender |

---

## 四、四大典型 NSFW 场景范式与实战配方

### 模式 A：闺房情趣与半脱微露（Boudoir & Lingerie）
* **核心美学**：布料撕扯或滑落的动态、半透织物与蕾丝肌理、欲拒还迎的优雅张力。
* **构图建议**：中景（Medium Shot），人物侧卧或斜倚在床头，环境以暖调卧室、柔和台灯为主。
* **蓝图字段建议**：
  * `nsfwTokens`: `lingerie, panties_aside, bare_breasts, pink_nipples, thighhighs, garter_straps, bed, lying_on_side, heavy_blush, seductive_smile`
  * `nsfwProse`: `Reclining on her side across silk sheets, she pulls her delicate lace lingerie aside with slender fingers, her bare breasts and blushing nipples bathed in warm lamp light as she casts a seductive gaze.`

### 模式 B：浴室水汽与湿身透视（Wet Skin & Steam）
* **核心美学**：透明水感、湿发贴肤、水珠凝结下滑、潮热蒸汽带来的红晕。
* **构图建议**：特写到中景，瓷砖浴室或温泉边缘，柔和高光与边缘漫反射。
* **蓝图字段建议**：
  * `nsfwTokens`: `completely_nude, wet_body, water_droplets, steam, bathroom, wet_hair, sitting, hugging_knees, bare_shoulders, pink_nipples, flushed_face`
  * `nsfwProse`: `Sitting nude on the wet bathroom tiles amidst drifting steam, glistening water droplets cascade down her glowing bare skin and flushed collarbones as she softly hugs her knees.`

### 模式 C：第一人称主观肉感特写（POV & Sensual Solo）
* **核心美学**：强烈的临场互动感、M字开腿或仰卧姿势、受力清晰的肢体曲线与体液光泽。
* **构图建议**：俯视第一人称（POV / From Above），大腿跨立在画面两侧，引导视线直达核心部位。
* **蓝图字段建议**：
  * `nsfwTokens`: `pov, first-person_view, on_back, spread_legs, m_legs, completely_nude, bare_breasts, nipples, pussy, pussy_juice, heavy_blush, parted_lips, trembling`
  * `nsfwProse`: `Captured from a direct POV looking down, she lies on her back with her legs parted wide in surrender, intimate folds glistening with moisture while her chest heaves with flushed, parted lips.`

### 模式 D：拘束道具与支配/顺从张力（Bondage & Captive Props）
* **核心美学**：皮革、锁链、手铐等冷硬材质与柔软温热肉体的质感碰撞；紧绷的肌肉与羞耻的神态。
* **构图建议**：跪姿（Kneeling）或俯卧，双臂被束于身后，强调颈部项圈（Collar）与手腕拘束的受力点。
* **蓝图字段建议**：
  * `nsfwTokens`: `kneeling, handcuffs, collar, leash, completely_nude, bare_breasts, pink_nipples, hands_behind_back, head_back, arched_back, teary_eyed, open_mouth, heavy_blush`
  * `nsfwProse`: `Kneeling upright with her wrists secured behind her back and a leather collar around her throat, she arches her back in helpless surrender, tears glistening at her eyes as her flushed body shivers under the spotlight.`

---

## 五、蓝图（Blueprint）JSON 配置规范

向 `data/blueprints/<series>.json` 录入成人蓝图时，必须完整提供以下字段：

```json
{
  "id": "character_sensual_boudoir_01",
  "title": "角色名 · 闺房微醉与丝滑半脱",
  "category": "私密情趣",
  "characterId": "character_id",
  "description": "中文场景描述（用于前端界面与画廊展示，包含情景、动作与氛围细节）。",
  "location": "昏黄温暖的丝绒卧室大床",
  "action": "斜倚在丝绸床单上，单手挑开情趣内衣系带，双腿微曲露出私密部位。",
  "timeOfDay": "night",
  "lighting": "dim warm lamp, golden skin specular highlights",
  "camera": "close-up, low angle, focus on hips and torso",
  "mood": "沉醉迷离",
  "sceneTags": [
    "bedroom",
    "silk_sheets",
    "pillow",
    "dim_lighting"
  ],
  "promptProse": "A luxurious bedroom draped in soft shadows and silk sheets.",
  "promptTokens": [
    "bedroom",
    "bed_sheets",
    "soft_lighting"
  ],
  "negativeTokens": [
    "bad anatomy",
    "extra fingers",
    "missing limbs",
    "deformed"
  ],
  "recommendedSize": "1152x1536",
  "adult": true,
  "sampleRating": "R18",
  "coverageTags": [
    "special_nsfw"
  ],
  "kreaStyleHint": "r18_sensual_cg",
  "animaStyleHint": "r18_sensual_cg",
  "nsfwTokens": [
    "completely_nude",
    "spread_legs",
    "bare_breasts",
    "pink_nipples",
    "pussy",
    "pussy_juice",
    "heavy_blush",
    "parted_lips"
  ],
  "nsfwProse": "Lying sensually across the silk bed with her legs parted wide, her bare skin glistens under the dim golden lamp light as she gasps with heavily flushed cheeks."
}
```

### 交付核对清单（Checklist）
1. **身份与分级一致**：该角色的 `adultEligibility` 必须为 `adult`，严禁在未成年角色上配置 `adult: true`。
2. **脱衣解耦**：检查 `nsfwTokens` 是否混入了与脱衣相冲突的常服词；如果需要保留部分服饰（如丝袜、手套），必须明确指明具体物件。
3. **负向词无自相矛盾**：确认 `negativeTokens` 中**没有**包含 `nsfw`、`nude`、`naked`、`explicit`。
4. **双引擎字段完备**：`nsfwTokens`（Anima 专用）与 `nsfwProse`（Krea 2 专用）同时提供，不得留空或简单互相复制。
5. **真实出图验证**：按照项目工作流在本地环境真实跑通出图，核对解剖结构、受光反光和姿势自然度，方可作为定稿提交。
