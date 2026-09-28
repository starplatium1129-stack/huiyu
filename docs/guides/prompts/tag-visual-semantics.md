# 词条出图语义参考（Tag → Visual Semantics）

> 2026-08-24 · 场景蓝图词条出图语义研究产物。
> 数据基座：`data/scene-blueprints.json` 438 蓝图 / 1295 唯一词条普查；
> 证据源：项目本地实测文档（`three-engine-prompt-research.md` 等，🟢）+ NoobAI/Illustrious 官方口径（🔵）
> + Danbooru 标签体系惯例（🔵）+ 本项目 A/B 记录（`anima-training-record.md`，🟢）。
> 置信度标记：🟢 官方或本项目实测背书 / 🔵 多源社区一致 / 🟡 单源推断 / ⚪ 未验证。

---

## 一、词条如何变成画面：作用机制分层

词条的「出图可靠性」由它在训练字幕里的先验强度决定，从强到弱分四层：

| 层级 | 特征 | 例子 | 预期行为 |
|---|---|---|---|
| L1 习得概念词 🟢 | Danbooru 高频 tag，模型见过数万次 | `1girl` `solo` `blush` `empty_classroom` `no_panties` | 精确、稳定、可组合 |
| L2 自然语言透明词 🔵 | 普通英文实义词，NL caption 训练可解析 | `golden light` `wet hair` `stone bathtub` | 稳定；Anima(Qwen3 编码器)尤其友好 |
| L3 自造复合词 🟡 | 语义透明但无训练先验的组合 | `tail_coil` `halo_focus` `cinematic_lighting` | 依赖编码器字面理解；方向正确但强度弱、细节不保证 |
| L4 反模式 ❌ | 否定式、玄学词、装配层专属词 | `no_customers` `masterpiece`(数据层) `8k` | 不可靠甚至反作用（详见 §四） |

**双引擎差异要点：**
- **Anima（Qwen3-0.6B 文本编码器）**：LLM 族编码器对自然语言与词序敏感度高；超长 prompt 末尾 tag 权重衰减（"末尾=加噪声"，官方答疑 🟢）；underscore exact token 是身份/质量控制的硬锚点，普通场景词用空格形（v19 实测：`best_quality` 转空格→胸饰退化 🟢）。
- **Krea 2（自研 12B DiT + Qwen3-VL 编码器，非 SD3.5/T5 系）**：纯英文散文 3–5 句；禁否定短语与 AI 玄学词（`beautiful/stunning/masterpiece/8k` 会拉向 generic gloss 🟢 项目契约）。架构与提示词规范见 `docs/research/prompts/krea2-prompt-research-2026-08-30.md`。
- **Illustrious/NoobAI 系（CLIP）**：纯 tag 方言；质量锚点前置有效（官方口径 "quality tags help clean up the picture" 🔵），但 Anima 两底模均 `strip_quality_tokens=true`——质量词只属于 profile 装配层，数据层携带必被剥离且属死数据 🟢。

---

## 二、场景蓝图词条族 → 预期画面参考

### 2.1 构图/镜头族
| 词条 | 预期画面 | 强度/注意 |
|---|---|---|
| `close-up` | 头肩特写，背景信息大幅丢失 | 🟢 与壁纸级背景细节互斥，特写场景慎配 `detailed_background` |
| `medium_shot` | 膝上构图，人物+环境平衡 | 🟢 蓝图默认档 |
| `wide_shot` / `scenery` | 环境叙事为主，人物占比缩小 | 🔵 `scenery` 会把权重拉向风景，人物场景慎用 |
| `from_behind` / `looking_back` | 背影+回眸，发丝与背部线条主导 | 🔵 组合使用稳定 |
| `dynamic_angle` | 低角度/斜透视张力 | 🟡 手部崩坏率上升，动作场景专用 |

### 2.2 光影氛围族（壁纸级质感主力，已全量注入）
| 词条 | 预期画面 | 置信度 |
|---|---|---|
| `volumetric_lighting` | 光束体积感、空气中的光雾层次 | 🟢 项目原数据高频使用 |
| `depth_of_field` | 焦外虚化，主体从背景中剥离 | 🟢 同上 |
| `detailed_background` | 背景细节密度提升（壁纸向） | 🔵 特写构图慎配 |
| `cinematic_lighting` | 电影级明暗对比、主光明确 | 🟡 NL 透明词，Qwen 可解析；CLIP 系响应弱 |
| `backlighting` / `rim_light` | 轮廓金边/剪影化 | 🔵 强词，逆光场景才放 |
| `golden hour` 类时段词 | 暖调长影 + 天空渐变 | 🔵 时段+光源成对给（如 `sunset`+`orange sky`）比单给更稳 |

> 项目结论（`prompt-image-quality-roadmap.md` 🟢）：**明确主光源比堆泛化质量词更有效**。壁纸层的正确姿势是「具体光源 × 时段 × 大气效果」三元组，而非 quality 词。

### 2.3 环境/场所族
| 词条 | 预期画面 | 置信度 |
|---|---|---|
| `empty_classroom` 等 empty_场所 | 对应场所的空景（课桌椅整齐无人） | 🔵 Danbooru 高频（empty classroom 12k+ 图） |
| `deserted_*` 形容词组 | 荒凉/无人感的场所 | 🟡 NL 透明，Qwen 可渲染；CLIP 系偏弱 |
| `crowd` vs `crowd_implied` | 画面内人群 vs 画外暗示 | 🔵 灯会/市集要热闹必须用 `crowd`（本次已修正 dusk 灯会） |
| 具体道具词（`measuring_tape` `mixing_console`） | 小物件入画，提升叙事可信度 | 🔵 具体名词 > 抽象名词 |

### 2.4 服装/材质族
- 分层组合（`uniform`+`necktie`+`pleated_skirt`）比单件罗列稳定 🔵；同屏 ≤1 个服装族系，两个族系互相打架（`promptPolicy.ts` 校验器同款规则 🟢）。
- 材质词直接映射视觉物理：`silk`(高光流垂)、`leather`(硬质反光)、`lace`(半透镂空) 🔵。
- 湿身系：`wet_clothes` 必须配湿源（`rain`/`wet`/`steam`）否则凭空湿 🔵。

### 2.5 姿势/动作族 & 身体 focus 族
- `X_focus` 后缀（`armpit_focus`/`navel_focus`/`thigh_focus`）：非 Danbooru 标准，但 NL 透明——Qwen 编码器按字面理解「聚焦该部位」，配合构图词（`close-up`）才可靠；单放在全身构图中会被稀释 🟡。
- 动作对：`arms_up`+`stretching_pose`、`bent_knees`+`sitting_on_bed` 成对给，孤立动作词易被忽略 🔵。
- 手部交互（`interlocked_fingers`/`palm_kiss`）：手部是崩坏重灾区，负面词已有压制，正面词只引导不保证 🟡。

### 2.6 表情/情绪族
- 强度阶梯：`gentle_smile` < `seductive_smile` < `smirk`；`blush` < `heavy_blush` < `flushed_cheeks` 🔵。
- 角色性格锚定词（如玛奇玛 `intimidating`、Dusk `serene`）在 identityProse 已覆盖时，蓝图内重复出现无害但增益有限 🟡。

### 2.7 特殊 NSFW 词条（成人蓝图 nsfwTokens）
| 类型 | 例子 | 出图可靠性 |
|---|---|---|
| Danbooru 习得概念 ✅ | `no_panties` `no_bra` `spread_legs` `collar` `leash` `pantyhose_pull` | 🟢 高频训练标签，精确可控（这是它们与 `no_customers` 的本质区别） |
| 部位 focus 组合 | `foot_focus`+`barefoot`+`5_toes`+`detailed_toes` | 🟡 四件套齐给才稳（本次 Dusk/Surtr 补强即此逻辑） |
| 角色专属自造词 | `tail_coil` `halo_touched` `wing_focus` | 🟡 NL 透明、方向正确；无社区先验，建议生成后抽验 |

---

## 三、双引擎消费路径速查

```
promptTokens ──► Anima: renderPromptPlan(strip_quality_tokens 后) → 空格形 tag 流 + visual direction 行
            └─► Krea:  不消费（Krea 只吃 promptProse/identityProse/outfitProse 散文）
nsfwTokens  ──► 仅 adult 角色 + adultEnabled 双门禁通过后注入 Anima caption
promptProse ──► Krea 散文织入（3-5 句预算）；Anima visual direction
kreaStyleHint ► Krea 配方 id（r18_* 强制前缀）；animaStyleHint 为自由标签短语
recommendedSize► 视图层 closestSupportedSize(activeModel) 收敛
```

---

## 四、反模式清单（本次研究修正项）

### 4.0 实机 A/B 实证（2026-08-24，anima-aesthetic-v1.1 / RTX 4070 Ti SUPER，同 seed 对比）
- **否定召唤实锤**：`yui_tennis_court_afternoon` 基线 prompt 含 `no opponent`/「no one else around」，出图**真实出现了隔网对手**；正向化后对手退化为远景小人——方向正确但未根除（`tennis racket`+`action shot` 的人物先验极强）。负面位藏匿的 `no other people/no crowd/no bystanders` 已全部清除（7 蓝图）。
- **氛围句有效**：raiden 天守阁 new 版烛光分层、对称构图、暖冷对比显著优于基线——模板句「Candlelight pools in soft golden layers…」直接显形。
- **cinematic 构图词的 seed 偶发风险**：`detailed_background+cinematic_lighting` 在竖版 action 场景偶发上下白边（1/2 seed 复现；另一 seed 正常）。建议动作类场景观察，必要时按场景剔除。
- **人群场景豁免缺失（编译器层 TODO）**：装配层对单人场景统一追加 `crowd/bystanders` 负面压制，会抵消灯会等场景的正向 `crowd` tag——需要 per-blueprint 豁免机制（本次测试以工作流补丁绕过）。

### 4.1 否定式词条/短语 ❌ → 正向改写 ✅
扩散编码器 negation-blind：「no X」的字面 token 反而可能召唤 X。项目 Krea 契约早已禁止同义短语，本次把全部蓝图对齐：

| 原文（❌ 347 处 prose + 6 处 tag） | 改写（✅） |
|---|---|
| `with no other people present` | `with the whole place to herself` |
| `no other customers nearby/around` | `the place all to herself` |
| `no opponent and no other people anywhere` | `the court entirely hers` |
| `nobody else is in the room—she is alone` | `the room belongs to her alone` |
| tag `no_opponent/no_customers/no_visitors/no_walkers/no_colleagues` | 删除（空场意图由 `empty_场所`+`alone` 承担） |
| tag `crowd_implied`（灯会要热闹） | `crowd` |

**白名单（保留，勿误伤）**：`no_panties`/`no_bra`（Danbooru 习得概念）、`empty_场所` 系列、`deserted_*` 形容词、`alone`（单人习得暗示）。
契约守卫：`test-popular-content.js` 「negation-free prompts」用例。

### 4.2 数据层质量词 ❌（2026-08-23 已出清）
`masterpiece/best_quality/absurdres/highres/intricate_details/8k/4k` 属 profile 装配层（`quality_prefix` 全句恰好一次）或 AI 玄学词；两 Anima 底模 `strip_quality_tokens=true`，数据层携带=死数据+重复风险。保留的具体光影环境 tag 见 §2.2。

### 4.3 其他注意事项
- `emiya-san_chi_no_kyou_no_gohan` 类作品名作场景词：会把画风拉向原作而非复现场景，慎用 🟡。
- 构图标签勿叠加（`close-up`+`full_body` 互相打架，Illustrious 官方告诫同理 🔵）。
- 角色 exact token（`ayachi_nene` 等）是 underscore 硬锚点，永远不要转空格或删除 🟢。

---

## 五、维护流程

1. 新增/修改词条后跑 `node scripts/tests/test-popular-content.js`（22 用例含否定词禁令）。
2. 词条普查一键审计：
   ```powershell
   node -e "const d=require('./data/scene-blueprints.json');const f={};d.blueprints.forEach(b=>(b.promptTokens||[]).forEach(t=>f[t]=(f[t]||0)+1));console.log(Object.entries(f).sort((a,b)=>a[1]-b[1]).slice(0,20))"
   ```
   （低频头部即高风险区：仅出现 1 次的词条共 828 个，新增词条优先复用既有词汇。）
3. 散文层批量改写一律走迁移脚本规则表 + `--refresh-prose`，禁止手工散改（防中间态污染）。
