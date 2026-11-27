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
- **画面构图与光影**：[构图与视觉设计](references/narrative-composition.md) · [叙事 CG 规范](../../../docs/guides/prompts/narrative-cg-prompt-standard.md)；壁纸专项见 [桌面壁纸](../../../docs/guides/prompts/character-wallpaper-prompt-standard.md) 与 [竖屏壁纸](../../../docs/guides/prompts/mobile-wallpaper-prompt-standard.md)
- **标签来源与纠错**：[D/G 标签溯源](references/tag-provenance.md) 与 [词条出图语义](../../../docs/guides/prompts/tag-visual-semantics.md)
- **角色服装设计**：[角色服装设计规范](references/outfit-design.md)（防八股模板、五要素穿搭与词条洁净度）
- **全分级细则与数据交付**：[NSFW 全分级规范](../../../docs/guides/prompts/nsfw-cg-prompt-standard.md) 与 [数据字段与交付](references/delivery.md)

---

## 核心编写与编译准则

1. **Anima（六段式，详见 [anima.md](references/anima.md)）**
   - 顺序：`质量/分级 → 人数与角色 → 作品版权 → 画师(@可选) → 普通画面标签 → 可选 1–2 句英文关系补充`。
   - 关键视觉事实（身份、衣装/裸露状态、动作、道具、地点、光影、景别）必须落在普通标签段（D/G 凭据优先、空格分词），不能只留在末尾补充句；质量前缀由各底模 profile 注入（`anima-aesthetic-v1.1` 会主动剥离质量词）。
2. **Krea 2（详见 [krea.md](references/krea.md)）**
   - 纯英文连贯描写，禁止 Danbooru 标签堆砌、括号权重、中文字符与 `masterpiece`/`8k` 等质量词；本地工作流默认 `negative = ''`。编译器同时消费 `promptProse`/`nsfwProse` 与 `promptTokens`/`nsfwTokens`。
3. **MiaoMiao Harem MOSS BASE v1.0 / v1.1**
   - **普通 vs 布局 JSON**：普通场景用英文或中文自然语言写清人物、动作与接触（`compileMossPrompt` 自动补 `MOSS_QUALITY`，不套用 Anima 评分词或 LoRA）；明确站位、多人卡司（`castLayout`）、三联画（`左格/中格/右格` 或 `Left/Middle/Right panel`）、参考图布局或画面文字时编译为布局 JSON（整体光影镜头写入非空 `summary.caption`，分格元素 `items[].label` 仅限 `character | object | text`，不加质量前缀）。[自然语言样例](https://github.com/OpenMOSS/MOSS-Image/blob/main/assets/images/007/parameters.json) · [标签样例](https://github.com/OpenMOSS/MOSS-Image/blob/main/assets/images/009/parameters.json)
   - **权重与文字负面**：仅 `renderMossDrawingPrompt` 对结构化标签流剥除 `(tag:1.2)` 权重，`compileMossPrompt` 不改自由文本/布局/负面权重；正负向各含模板 ≤ 4096 tokens。需要画面文字时保留原文/换行并移除 `MOSS_NEGATIVE` 里的 `text` 与 `english text`（自动剔除仅在传入负面与 `MOSS_NEGATIVE` **逐字完全一致**且检测到非空 `items[].text`、引号文字指令或 `text`/`chinese_text`/`japanese_text`/`lettering`/`speech_bubble` 时生效，自定义负面需人工复核）。
   - **布局坐标**：模型原生 `bbox` 为 `abs_centralized / yxyx` `[y_min, x_min, y_max, x_max]`；草稿模式 `abs / xyxy` 必须附带 16 倍数顶层 `width`/`height` 且不含多余顶层键。[官方布局说明](https://github.com/OpenMOSS/MOSS-Image/blob/main/USERGUIDE.md#layout-prompts-experimental)
   - **参数基线**：默认 `Euler`、50 步、CFG 3.5、`shift=5`、`uncondSkipLayers=[22]`（白名单 16 倍数画幅，上限 1536），内置 ER-SDE 预览档（`er-sde/simple`、25 步、CFG 2.5，支持 Spectrum 加速）。[作者版本页](https://www.tensor.art/models/1060118844061793689/MiaoMiao-Harem-MOSS-Image-MIAOKA-BASE-v1.0_fp16)
4. **全分级与 NSFW 支持**
   - 穿衣与裸露状态依意图如实编写（`nude`、`topless`、`lingerie`、`panties pull` 等空格分词标准词）。
   - 成人蓝图（`adult: true`）在未显式换装时由蓝图自身承载着装/裸露状态（编译器不注入默认 `outfit`）；`nsfwTokens` 进入第 5 段标签流与 Krea/MOSS；若同时填写 `animaCaption` 与 `nsfwProse`，**Anima 仅消费 `animaCaption` 而忽略 `nsfwProse`**（`nsfwProse` 供 Krea 2 / MOSS 及缺 `animaCaption` 时回落），因此 `animaCaption` 须自带完整成人关系且 ≤ 2 句。
5. **负面提示词原则**
   - 热门蓝图（`blueprints`）仅在 `negativeTokens` 中写**当前画面明确冲突**的排除项，无专属排除时为 `[]`（`prompt_guard.rs` 会直接拦截 `bad hands`、`extra fingers`、`worst quality` 等通用模板）。
   - 工作室场景（`data/scenes.json`）同样只写场景专属排除项（现行校验由 Rust `catalog/validation.rs` + `prompt_guard.rs` 执行；旧 `validate-scenes.ts` 为历史 SDXL 遗留脚本，不再作为门禁）；所有分级均禁止套用与目标冲突的排除词（如需多人不加 `multiple girls`、需文字不加 `text`、需裸露不加 `nude`/`explicit`）。

---

## 交付前快检

- 身份、换装与构图意图（`single` / `group` / `triptych`）匹配且无旧服装/外貌残留；`outfit.prose` 须为英文。
- Anima 第 5 段齐全、第 6 段 ≤ 2 句且不被 `animaCaption`/`nsfwProse` 互相遮蔽；无景别/姿态/视线自冲突。
- 仅引用经 D/G 核验或明确保留待核的标签，不把未出图/未查看的结果宣称为视觉通过；遵守 [delivery.md](references/delivery.md) 的 `prompt_guard` 校验与定稿基线保护规则。
