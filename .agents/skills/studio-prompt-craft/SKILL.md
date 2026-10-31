---
name: studio-prompt-craft
description: 编写或审查 AI-CG-Studio 图像提示词及编译一致性；支持全分级自由创作，覆盖 Anima 标签、Krea 2 自然语言与 MOSS 提示词。
---

# Studio Prompt Craft

为 AI-CG-Studio 编写与审查图像生成提示词，将创作意图精准转化为模型可执行的视觉描述。

**核心原则**：
- **全分级自由创作**：项目完全支持自由选择各个分级创作（涵盖全年龄 SFW、敏感向 Sensitive、各类露骨/成人向 NSFW/R18 等所有分级），不设任何露骨场景限制或分级门控。
- **所想即所见**：准确还原角色身份、衣装状态（常服、泳装、情趣、全裸等）、动作交互、神态光影与场景构图。
- **按引擎编写**：Anima 使用精炼标签与可选短句，Krea 2 使用自然语言，MOSS 支持自然语言、标签及布局 JSON。

## 引擎与参考导航

- **MiaoMiao 1.6**：参考 [MiaoMiao 1.6 专属配方](references/miaomiao-v16.md) 与 [Anima 标签与编译](references/anima.md)。
- **其他 Anima 底模**（Base / Aesthetic / Yume 等）：参考 [Anima 标签与编译](references/anima.md)，不套用 1.6 专属词。
- **Krea 2**：参考 [Krea 散文写作规范](references/krea.md)。
- **MiaoMiao Harem MOSS**：使用下方 MOSS 写法，不套用 Anima 1.6 配方。
- **画面构图与景别**：参考 [构图与光影设计](references/narrative-composition.md)；壁纸需求参考 [桌面壁纸规范](../../../docs/guides/prompts/character-wallpaper-prompt-standard.md) 与 [手机壁纸规范](../../../docs/guides/prompts/mobile-wallpaper-prompt-standard.md)。
- **NSFW / R18 创作**：参考 [NSFW 全分级规范](../../../docs/guides/prompts/nsfw-cg-prompt-standard.md) 与 [词条出图语义](../../../docs/guides/prompts/tag-visual-semantics.md)。
- **仓库写入与定稿交付**：参考 [数据字段与交付](references/delivery.md)。

## 提示词架构与编写规范

### 1. Anima 六段式编译结构

Anima 模型基于混合输入训练，普通标签段承担核心视觉事实：

1. **质量与评分词**：按目标底模 profile 注入（例如 MiaoMiao 1.6 含 `best quality, score_7, score_9, very aesthetic...`；Base/Aesthetic 不套用 1.6 评分词）。
2. **人数与角色名**：例如 `1girl, solo, frieren,`；多人场景保留实际人数与角色组合（如 `2girls,` 或 `1girl, 1boy,`）。
3. **作品名（版权词）**：例如 `sousou no frieren,`，独立成段。
4. **画师风格（可选）**：Danbooru 画师名加 `@`，例如 `@kantoku,`。
5. **普通画面标签（核心事实）**：
   - 优先 Gelbooru 规范写法，小写英文，空格分词。
   - 覆盖：外貌特征、衣装/裸露状态（`nude`, `lingerie`, `open_shirt` 等）、主动作与姿势、身体交互与接触、表情神态、道具、环境地点、光照与景别。
   - 所有关键视觉元素必须有对应标签，不能仅写在描述句中。
6. **自然语言补充（可选尾句）**：
   - 独立换行，1–2 句简短英文，精炼描述微妙神态、肢体接触或视线空间关系。
   - 标签已足够时可直接省略，不写冗长故事或心理活动。

### 2. Krea 2 自然语言散文

- 输出自然流畅的英文描写，清除 Danbooru 堆词、括号权重与质量评分词。
- 结构清晰：`画面媒介与主体 → 身份与衣着状态 → 动作姿势与互动关系 → 环境与光影氛围 → 镜头与景别`。
- 本地工作流默认 `negative = ''`，依靠清晰的正向描述定义画面。

### 3. MiaoMiao Harem MOSS BASE v1.0

- **画面描述**：优先用英文自然语言，中文也支持；写清人物、衣装、动作互动、空间关系、环境、光影与景别，细节随创作需求增减。参考 OpenMOSS 的[自然语言样例](https://github.com/OpenMOSS/MOSS-Image/blob/main/assets/images/007/parameters.json)和[标签样例](https://github.com/OpenMOSS/MOSS-Image/blob/main/assets/images/009/parameters.json)。
- **标签**：可与自然语言结合；按质量 → 评分、元信息、年份（按需）→ 角色 → 作品 → 画师 → 画面标签排列，不臆造缺省类别。不要默认照搬 Anima 专属评分词或角色 LoRA。
- **项目编译**：普通提示词自动补入作者的质量词；布局 JSON 不加前缀。本地管线不解析 `(tag:1.2)` 权重，结构化标签中的此类权重会被剥除。正、负向各含模板不超过 4096 tokens，超限会报错。
- **文字与负面**：准确写出画面文字并保留原文和换行；需要文字时，检查最终负面并移除 `text`、`english text`。仅当布局 JSON 含非空 `items[].text` 且负面恰为作者默认值时，项目才自动移除这两项；避免负面与创作分级或画面内容冲突。
- **布局 JSON**：用于文字定位、多格或复杂元素关系；以 `summary.caption` 描述整体，`items` 描述各元素。`bbox` 为以画布中心为原点的像素坐标，顺序 `[y_min, x_min, y_max, x_max]`；布局尺寸须与生成尺寸一致。格式及限制见[官方指南](https://github.com/OpenMOSS/MOSS-Image/blob/main/USERGUIDE.md#layout-prompts-experimental)。
- **参数参考**：MIAOKA 推荐 Euler、30–50 步、CFG 3.5 起步及 768×1280 等尺寸；以[作者版本说明](https://www.tensor.art/models/1060118844061793689/MiaoMiao-Harem-MOSS-Image-MIAOKA-BASE-v1.0_fp16)和实际画面为准。原模型示例不等于该微调版的实测效果。

### 4. 分级与 NSFW 创作支持

- **自由开放**：无论全年龄还是 NSFW/R18，均依创作者意图真实编写，不进行自我阉割或人为降级。
- **衣着与裸露**：明确穿衣就保留完整衣装词，明确裸体或半裸（`naked`, `nude`, `topless`, `bottomless`, `panties_pull` 等）就准确反映，不含糊其辞。
- **性暗示与动作交互**：如体位、接触、体液、特殊焦点（如 `navel_focus`, `thigh_focus`）等，使用模型熟练习得的标准标签与正向表达。
- **字段协同**：蓝图支持 `promptTokens` / `promptProse` 与 `nsfwTokens` / `nsfwProse`；根据使用场景自由调配，确保最终编译请求完整生效。

### 5. 负面提示词原则

- 从底模推荐的基础负面开始，避免无脑套用庞大的通用黑名单。
- MiaoMiao 1.6 使用作者推荐的 `worst quality, low quality, score_1, score_2, score_3, artist name, shiny skin`。
- 仅添加与当前画面冲突的针对性排除项；不要盲目添加与画面目标相悖的负面词（例如需要文字时不加 `text`，需要多人时不加 `multiple girls`，需要特定裸露时不加遮蔽词）。

## 交付与审查清单

- **身份与衣装**：角色特征与标志性服饰准确，换装时旧衣装特征彻底替换。
- **画面瞬间明确**：画面是凝固的单一片刻，而非连续动作的叠加。
- **编译对齐**：通过对应引擎的工作台预览或编译结果核对词序、负面与参数；MOSS 使用 `nativeDrawingPrompt` / `compileMossPrompt`。
- **真实出图验证**：文档与提示词的修改以实际渲染效果为最终检验标准。
