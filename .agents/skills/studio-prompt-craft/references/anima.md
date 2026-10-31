# Anima 提示词编译与输入规范

适用于 Anima 架构模型（MiaoMiao 1.6、Base、Aesthetic、Yume 等）。

## 1. 核心编译架构：六段式结构

项目采用六段式结构组织最终输入，将结构化标签与自然语言有机融合：

| 序号 | 分段 | 格式与内容 | 说明 |
| --- | --- | --- | --- |
| **01** | **质量 / 安全词** | `masterpiece, best quality, score_7, ...` | 由所选 checkpoint 的 profile 决定，不手动照抄通用模板。 |
| **02** | **人数与角色** | `1girl, solo, frieren,` | 真实人数与角色 ID 触发词；多人使用 `2girls` 或 `1girl, 1boy`。 |
| **03** | **作品名称** | `sousou no frieren,` | 官方/社区标准作品版权词，独立成段。 |
| **04** | **画师风格（可选）** | `@kantoku,` | Danbooru 画师名加 `@` 前缀；未选择画师时直接省略该段。 |
| **05** | **普通画面标签** | `sitting, reading book, forest, window light,` | **核心事实承载段**，涵盖动作、神态、衣装/裸露、道具、场景与光影。 |
| **06** | **自然语言补充（可选）** | 独立换行，1–2 句简短英文 | 补充细微神态、肢体接触或空间关系；标签足够时省略。 |

### 示例

```text
masterpiece, best quality, score_7, sensitive,
1girl, solo, frieren,
sousou no frieren,
@kantoku,
sitting under tree, reading book, white dress, green forest, dappled sunlight,
She looks peaceful and slightly sleepy with gentle wind blowing.
```

## 2. 标签编写规则

- **标准化**：小写英文、空格分词、英文逗号分隔。优先遵循 Gelbooru 规范写法。
- **关键事实完整**：
  - 核心画面信息（动作、姿势、神态、衣着状态、环境、光影、景别）**必须**体现在普通标签段中。
  - 不能将画面关键事实仅留在末尾描述句中。
- **全分级标签支持**：
  - 包含常规衣装（`school_uniform`, `coat` 等）、清凉/泳装（`bikini`, `swimsuit` 等）、情趣/局部裸露（`lingerie`, `open_shirt`, `cleavage` 等）及完全裸体（`nude`, `naked` 等）。
  - 各类 NSFW/R18 交互与细节标签依创作需求真实使用。
- **精确词保护**：`score_N`、LoRA 触发词及专名保持原样，不全局替换下划线。

## 3. 消费与组装逻辑

- **统一编译入口**：通过 [`compilePromptRecipe`](../../../../src/utils/promptRecipe.ts) 统一组装，调用方不手动另拼标签。
- **字段映射**：
  - 工作室场景读取 `scene.prompt` 与可选 `animaCaption`。
  - 热门蓝图读取 `blueprint.promptTokens` 与 `animaCaption`（若缺省沿用 `promptProse`）。
  - NSFW 分支同时注入 `nsfwTokens` / `nsfwProse`。
- **导演控制**：镜头（景别、视角）与光影选项优先于默认值，通过标准标签直接发送，不生成重复模板句。

## 4. 负面提示词策略

除 MiaoMiao 1.6 使用作者专属配方外，通用 Anima 基础负面为：
```text
worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration
```

- 仅按当前画面需要追加冲突排除项。
- 不盲目堆叠通用肢体、边框或手部模板词，避免与画面目标（如特写、多人、文字）产生矛盾。
