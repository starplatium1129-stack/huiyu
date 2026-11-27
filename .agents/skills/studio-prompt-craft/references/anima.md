# Anima 提示词编译与输入规范

适用于全部 Anima 架构底模（详见 `data/presets.json`）。

## 1. 六段式结构

| 序号 | 分段 | 示例内容 | 说明 |
| --- | --- | --- | --- |
| **01** | 质量 / 安全词 | `masterpiece, best quality, score_7, ...` | 由目标 checkpoint profile 注入，正文不重复手写 |
| **02** | 人数与角色 | `1girl, solo, frieren,` | 多人保留实际人数（如 `2girls`、`1girl, 1boy`） |
| **03** | 作品名称 | `sousou no frieren,` | 标准作品版权词，独立成段 |
| **04** | 画师风格（可选） | `@kantoku,` | Danbooru 画师名加 `@`；无画师时省略 |
| **05** | 普通画面标签 | `sitting, reading book, forest, window light,` | **核心事实承载段**：外貌、衣装/裸露、动作、道具、场景、光影与景别 |
| **06** | 自然语言补充（可选） | `She looks peaceful with gentle wind blowing.` | 独立换行，1–2 句简短英文补充微妙神态与接触关系；足够时省略 |

## 2. 标签编写规则

- **格式与来源**：模型标签字段（`promptTokens`、`nsfwTokens`、`identityTokens`、`outfit.tokens`）统一小写英文、空格分词、英文逗号分隔（检索元数据 `sceneTags`/`tags` 及旧工作室 `scenes.json` 仍允许下划线，Anima 编译层自动转空格）。普通标签须有 D/G 凭据（优先 Gelbooru，见 [标签溯源](tag-provenance.md)）；复杂关系拆成已核验基础词 + 第 6 段短句，禁止拼造 ≥ 5 词英文短语或整句下划线标签。
- **核心事实不后置**：动作、衣装/裸露（`bikini`、`lingerie`、`nude` 等）、地点与景别必须写入第 5 段标签，不可仅靠末尾自然语言承载；角色名、作品名与固有发色瞳色由 `characterTokens`/`copyrightTokens`/`identityTokens` 承载，勿在 `promptTokens` 重复手写。
- **角色、作品与精确词**：热门角色名与作品名在 Anima 编译时正常转空格（`popularPromptBuilder.ts` 不将其列入 `preserveTokens`），同名括号保留转义（如 `sylphiette \(mushoku tensei\)`）；仅 `score_N`、工作室 `nene_*`/`natsume_*` 与显式 LoRA 触发词保留原样。[Anima 官方说明](https://huggingface.co/circlestone-labs/Anima#prompting)

## 3. 底模差异与组装逻辑

| 底模 ID | LoRA | 质量前缀 / 剥离 | 负向与分级行为 | 默认采样 |
| --- | --- | --- | --- | --- |
| `anima-miaomiao-v1.6`（默认） | 支持 | 专属 8 词含 `sensitive`/`fair skin` | `rating_mode: "prompt"`；含 `shiny skin` 合并 | `euler/normal` 30 步 CFG 4.5 `832×1216` |
| `anima-miaomiao-2.9b-beta1.1` | **不支持** | `masterpiece, best quality, score_7, score_9, very aesthetic, ultra detailed` | 通用基础负面 + 按分级自动追加负向 | `euler/sgm_uniform` 30 步 CFG 4.5 `832×1216` |
| `anima-miaomiao-realskin-2.9b-v1.0` | **不支持** | 同 MiaoMiao 1.6（同样生效 `fair skin` 冲突移除） | `rating_mode: "prompt"`；`negative_mode: "replace"` 29 词专属负面 | `euler/sgm_uniform` 30 步 CFG 4 `928×1536` |
| `anima-aesthetic-v1.1` | 支持 | `quality_prefix: ""` 且 **`strip_quality_tokens: true`** | 负向不含并主动剥离 `score_*` | `res_multistep/simple` 30 步 CFG 4.5 `832×1216` |
| `anima-base-v1.0` / `anima-yume-v1.0` / `anima-miaomiao-v1.2` | 支持 | 各自 profile 质量词 | 通用基础负面 + 按分级自动追加负向 | `res_multistep/simple` 30 步 CFG 4.5 `832×1216` |

- **统一编译**：经 [`compilePromptRecipe`](../../../../src/utils/promptRecipe.ts) 组装（工作室场景读 `scene.prompt` + `animaCaption`；热门蓝图读 `promptTokens` + `nsfwTokens` 入第 5 段）。
- **`animaCaption` 与 `nsfwProse` 优先级**：热门蓝图只要填写了非空 `animaCaption`，Anima 第 6 段**仅取 `animaCaption` 而忽略 `nsfwProse`**；仅在 `animaCaption` 为空时才回落消费 `nsfwProse + promptProse`。
- **通用基础负面**（Base / Yume / MiaoMiao 1.2 / 2.9B Beta 1.1；Aesthetic 1.1 不含 `score_1..3`；MiaoMiao 1.6 与 RealSkin 2.9B 用各自专属负面）：
  ```text
  worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration
  ```
  蓝图 `negativeTokens` 仅追加当前画面明确冲突的排除项（无冲突写 `[]`），不堆砌通用肢体/边框词。
