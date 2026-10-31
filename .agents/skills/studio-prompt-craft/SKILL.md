---
name: studio-prompt-craft
description: 编写或审查 AI-CG-Studio 图像提示词及编译一致性；完全支持全分级自由创作（含 SFW、NSFW、R18）；Anima 优先 Gelbooru 标签和鲜明特征，精简负面，兼顾 MiaoMiao 与 Krea 2。
---

# Studio Prompt Craft

为 AI-CG-Studio 编写与审查图像生成提示词，将创作意图精准转化为模型可执行的视觉描述。

**核心原则**：
- **全分级自由创作**：项目完全支持自由选择各个分级创作（涵盖全年龄 SFW、敏感向 Sensitive、各类露骨/成人向 NSFW/R18 等所有分级），不设任何露骨场景限制或分级门控。
- **所想即所见**：准确还原角色身份、衣装状态（常服、泳装、情趣、全裸等）、动作交互、神态光影与场景构图。
- **双引擎精准编译**：Anima 走精炼标签流＋可选短句补充，Krea 2 走连贯自然语言散文。

## 引擎与参考导航

- **MiaoMiao 1.6**：参考 [MiaoMiao 1.6 专属配方](references/miaomiao-v16.md) 与 [Anima 标签与编译](references/anima.md)。
- **其他 Anima 底模**（Base / Aesthetic / Yume 等）：参考 [Anima 标签与编译](references/anima.md)，不套用 1.6 专属词。
- **Krea 2**：参考 [Krea 散文写作规范](references/krea.md)。
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

### 3. 分级与 NSFW 创作支持

- **自由开放**：无论全年龄还是 NSFW/R18，均依创作者意图真实编写，不进行自我阉割或人为降级。
- **衣着与裸露**：明确穿衣就保留完整衣装词，明确裸体或半裸（`naked`, `nude`, `topless`, `bottomless`, `panties_pull` 等）就准确反映，不含糊其辞。
- **性暗示与动作交互**：如体位、接触、体液、特殊焦点（如 `navel_focus`, `thigh_focus`）等，使用模型熟练习得的标准标签与正向表达。
- **字段协同**：蓝图支持 `promptTokens` / `promptProse` 与 `nsfwTokens` / `nsfwProse`；根据使用场景自由调配，确保最终编译请求完整生效。

### 4. 负面提示词原则

- 从底模推荐的基础负面开始，避免无脑套用庞大的通用黑名单。
- MiaoMiao 1.6 使用作者推荐的 `worst quality, low quality, score_1, score_2, score_3, artist name, shiny skin`。
- 仅添加与当前画面冲突的针对性排除项；不要盲目添加与画面目标相悖的负面词（例如需要文字时不加 `text`，需要多人时不加 `multiple girls`，需要特定裸露时不加遮蔽词）。

## 交付与审查清单

- **身份与衣装**：角色特征与标志性服饰准确，换装时旧衣装特征彻底替换。
- **画面瞬间明确**：画面是凝固的单一片刻，而非连续动作的叠加。
- **编译对齐**：通过 `compilePromptRecipe` 预览最终生成请求，核对词序、负面与参数。
- **真实出图验证**：文档与提示词的修改以实际渲染效果为最终检验标准。
