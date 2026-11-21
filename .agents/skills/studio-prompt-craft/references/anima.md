# Anima 提示词编译与输入规范

适用于 Anima 架构模型（MiaoMiao 1.6、Base、Aesthetic、Yume 等）。

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

- **格式与来源**：小写英文、空格分词、英文逗号分隔。普通标签须有 D/G 凭据（优先 Gelbooru，见 [标签溯源](tag-provenance.md)）；复杂关系拆成已核验基础词 + 第 6 段短句，禁止拼造整句下划线标签。
- **核心事实不后置**：动作、衣装/裸露（`bikini`、`lingerie`、`nude` 等）、地点与景别必须写入第 5 段标签，不可仅靠末尾自然语言承载。
- **角色、作品与精确词**：角色与作品按 D/G 转小写空格，同名括号保留转义（如 `sylphiette \(mushoku tensei\)`）；`score_N`、LoRA 触发词及锁定的精确词原样保留。[Anima 官方说明](https://huggingface.co/circlestone-labs/Anima#prompting)

## 3. 组装逻辑与基础负面

- **统一编译**：经 [`compilePromptRecipe`](../../../../src/utils/promptRecipe.ts) 组装（场景读 `scene.prompt` + `animaCaption`；热门蓝图读 `promptTokens` + `animaCaption`/`promptProse`，NSFW 同步注入 `nsfwTokens`/`nsfwProse`；导演镜头与光影优先生效）。
- **基础负面**（MiaoMiao 1.6 用自身专属配方，其余通用 Anima）：
  ```text
  worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration
  ```
  仅追加与当前画面冲突的排除项，不堆砌通用肢体/边框词。
