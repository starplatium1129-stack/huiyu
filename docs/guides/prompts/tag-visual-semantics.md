# 词条出图语义参考（Tag → Visual Semantics）

> 当前编译规范见 [studio-prompt-craft](../../../.agents/skills/studio-prompt-craft/SKILL.md)，模型依据见 [研究来源与采用边界](../../research/README.md)。
> 置信度标记：🟢 官方/实测背书 · 🔵 多源社区一致 · 🟡 单源推断 · ❌ 反模式。

---

## 1. 词条先验层级与双引擎差异

| 层级 | 特征 | 示例 | 预期效果 |
| --- | --- | --- | --- |
| **L1 习得概念** 🟢 | Danbooru 高频标签 | `1girl` `solo` `blush` `empty_classroom` `no_panties` | 精确、稳定、可自由组合 |
| **L2 自然语言词** 🔵 | 英文实义短语 | `golden light` `wet hair` `stone bathtub` | 稳定；Anima (Qwen3) 理解良好 |
| **L3 自造复合词** 🟡 | 字面透明但无训练先验 | `tail_coil` `halo_focus` `cinematic_lighting` | 方向大致正确但强度较弱 |
| **L4 反模式** ❌ | 否定词、AI 玄学词、装配词 | `no_customers` `masterpiece` `8k` | 失效或反向召唤不需要的元素 |

- **Anima**：普通标签用空格分隔（影响 Qwen3/T5 分词），精确角色/作品 triggers（如 `ayachi_nene`）保留下划线；底模均开启 `strip_quality_tokens=true`，数据层不写质量词。
- **Krea 2**：纯英文散文 3–5 句，禁用否定短语和 `masterpiece`/`8k`/`stunning` 等通用空词。

---

## 2. 常用词条族与出图效果

### 构图与镜头
| 词条 | 预期画面 | 注意事项 |
| --- | --- | --- |
| `close-up` | 头肩特写，背景大幅弱化 | 🟢 勿同时叠加 `detailed_background` 或 `full_body` |
| `medium_shot` | 膝上构图，兼顾人物与环境 | 🟢 蓝图默认推荐景别 |
| `wide_shot` / `scenery` | 环境叙事为主，人物占比缩小 | 🔵 `scenery` 会将权重拉向风景 |
| `from_behind` / `looking_back` | 背影 + 回眸 | 🔵 组合稳定 |
| `dynamic_angle` | 低角度或斜透视张力 | 🟡 动作场景专用，手部易崩 |

### 光影、环境、衣装与动作
- **光影氛围（具体光源 × 时段 × 大气）** 🟢：优先写 `volumetric_lighting`、`depth_of_field`、`backlighting`/`rim_light`、`sunset` + `orange sky` 等成对光源词，优于堆砌泛化质量词（`detailed_background` + `cinematic_lighting` 在竖版动作图偶发白边，按需观察）。
- **环境与道具** 🔵：`empty_classroom`（空场）、`crowd`（热闹人群，勿用虚弱的 `crowd_implied`）；具体道具名词（如 `measuring_tape`）显著增强可信度。
- **服装与材质** 🔵：分层组合（`uniform`+`necktie`+`pleated_skirt`）优于单件罗列；同屏 ≤ 1 个服装族系；`wet_clothes` 须搭配 `rain`/`wet`/`steam` 等湿源；材质可用 `silk`、`leather`、`lace`。
- **姿势与表情** 🔵/🟡：`X_focus`（如 `thigh_focus`）需配合近景/特写镜头；动作词成对出现（`arms_up`+`stretching_pose`、`bent_knees`+`sitting_on_bed`）；表情阶梯 `gentle_smile` < `seductive_smile` < `smirk`、`blush` < `heavy_blush` < `flushed_cheeks`。
- **NSFW 词条**：支持全分级自由创作（`adult`/`rating` 字段声明，不设拦截）。高频概念（`no_panties` `no_bra` `spread_legs` `collar` `leash` `pantyhose_pull`）稳定可控 🟢；足部特写建议 `foot_focus`+`barefoot`+`5_toes`+`detailed_toes` 组合 🟡。

---

## 3. 双引擎消费路径

```text
promptTokens   ─▶ Anima: renderPromptPlan (strip_quality_tokens) → 空格 tag + visual direction
               └─ Krea:  不消费
nsfwTokens     ─▶ 按 R18 分级注入 Anima caption
promptProse    ─▶ Krea 散文织入；Anima visual direction
krea/animaStyleHint ─▶ 可选引擎配方或风格短语
recommendedSize     ─▶ 视图层 closestSupportedSize(activeModel) 收敛
```

---

## 4. 反模式与正向改写清单

扩散编码器对否定词不敏感（`negation-blind`），字面出现 `no X` 反而容易召唤出 X：

| 应避免的否定表达 ❌ | 推荐正向改写 ✅ |
| --- | --- |
| `with no other people present` | `with the whole place to herself` |
| `no other customers nearby/around` | `the place all to herself` |
| `no opponent and no other people anywhere` | `the court entirely hers` |
| `nobody else is in the room—she is alone` | `the room belongs to her alone` |
| `no_opponent` / `no_customers` / `no_visitors` | 删除，改用 `empty_<场所>` + `alone` |
| `crowd_implied`（需热闹氛围时） | `crowd` |

- **白名单（勿误删）**：`no_panties` / `no_bra`（Danbooru 习得概念）、`empty_*`、`deserted_*`、`alone`。
- **慎用作品名作场景词** 🟡：如把某部作品名当场景 tag 容易强行改变画风；质量词（`masterpiece`/`8k` 等）仅保留在 profile 装配层，严禁写入数据层。
- **维护入口**：通过内容维护页或 `npm run wf -- content:catalog` 预览修改并导出快照，遵循 [工作流](../../workflow.md)。
