---
name: studio-prompt-craft
description: 编写或审查 AI-CG-Studio 图像提示词及编译一致性；支持全分级自由创作，覆盖 Anima 标签、Krea 2 自然语言与 MOSS 提示词。
---

# Studio Prompt Craft

将创作意图精准转化为各图像引擎可执行的提示词，遵循 **全分级自由创作**（全面支持 SFW、Sensitive、NSFW/R18，不设门控或自我阉割）与 **先定画面后写词**（先明确核心瞬间、动作接触与空间关系，不以堆词代替设计）。

## 引擎与专项导航

- **Anima（通用结构与编译）**：[Anima 提示词规范](references/anima.md)
- **MiaoMiao 1.6（默认 Anima 底模）**：[MiaoMiao 1.6 专属配方](references/miaomiao-v16.md)（其他底模勿套用 1.6 评分词）
- **Krea 2（自然语言散文）**：[Krea 散文规范](references/krea.md)
- **画面构图与光影**：[构图与视觉设计](references/narrative-composition.md)；壁纸专项见 [桌面壁纸](../../../docs/guides/prompts/character-wallpaper-prompt-standard.md) 与 [竖屏壁纸](../../../docs/guides/prompts/mobile-wallpaper-prompt-standard.md)
- **标签来源与纠错**：[D/G 标签溯源](references/tag-provenance.md) 与 [词条出图语义](../../../docs/guides/prompts/tag-visual-semantics.md)
- **全分级细则与数据交付**：[NSFW 全分级规范](../../../docs/guides/prompts/nsfw-cg-prompt-standard.md) 与 [数据字段与交付](references/delivery.md)

---

## 核心编写与编译准则

1. **Anima（六段式，详见 [anima.md](references/anima.md)）**
   - 顺序：`质量/分级 → 人数与角色 → 作品版权 → 画师(@可选) → 普通画面标签 → 可选 1–2 句英文关系补充`。
   - 关键视觉事实（身份、衣装/裸露状态、动作、道具、地点、光影、景别）必须落在普通标签段（D/G 凭据优先、空格分词），不能只留在末尾补充句。
2. **Krea 2（详见 [krea.md](references/krea.md)）**
   - 纯英文连贯描写，禁止 Danbooru 标签堆砌、括号权重与 `masterpiece`/`8k` 等质量词；本地工作流默认 `negative = ''`。
3. **MiaoMiao Harem MOSS BASE v1.0 / v1.1**
   - **普通 vs 布局 JSON**：普通场景用英文或中文自然语言写清人物、动作与接触（自动补质量词，不套用 Anima 评分词或 LoRA）；明确站位、逐格动作或画面文字时编译为布局 JSON（整体光影镜头写入 `summary.caption`，分格动作进对应元素，不加质量前缀）。[自然语言样例](https://github.com/OpenMOSS/MOSS-Image/blob/main/assets/images/007/parameters.json) · [标签样例](https://github.com/OpenMOSS/MOSS-Image/blob/main/assets/images/009/parameters.json)
   - **文字与负面**：本地管线剥除 `(tag:1.2)` 权重，正负向各含模板 ≤ 4096 tokens。需要画面文字时保留原文/换行并移除作者默认负面里的 `text` 与 `english text`（非空 `items[].text` 与文字指令会自动移除，自由描述需人工复核）。
   - **布局坐标**：模型 `bbox` 使用中心原点 `abs_centralized / yxyx` `[y_min, x_min, y_max, x_max]`；工作台支持左上原点 `abs / xyxy` 草稿并按画幅换算。[官方布局说明](https://github.com/OpenMOSS/MOSS-Image/blob/main/USERGUIDE.md#layout-prompts-experimental)
   - **参数基线**：Euler、30–50 步、CFG 3.5 起步（参考 [作者版本页](https://www.tensor.art/models/1060118844061793689/MiaoMiao-Harem-MOSS-Image-MIAOKA-BASE-v1.0_fp16)）。
4. **全分级与 NSFW 支持**
   - 穿衣与裸露状态依意图如实编写（`nude`、`topless`、`lingerie`、`panties_pull` 等标准词）；蓝图 `promptTokens`/`promptProse` 与 `nsfwTokens`/`nsfwProse` 协同编译。
5. **负面提示词原则**
   - 仅使用对应底模推荐基础负面，追加与**当前画面明确冲突**的排除项；禁止套用与画面目标矛盾的通用模板（如需多人不加 `multiple girls`、需文字不加 `text`、需局部裸露不加遮蔽词）。

---

## 交付前快检

- 身份、换装与构图意图（`single` / `group` / `triptych`）匹配且无旧服装残留。
- 仅引用经 D/G 核验或明确保留待核的标签，不把未出图/未查看的结果宣称为视觉通过；遵守 [delivery.md](references/delivery.md) 的数据库与定稿基线保护规则。
