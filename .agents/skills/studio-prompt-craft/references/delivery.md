# 仓库写入与生成验收

## 1. 数据权威与创作红线

- 全分级自由创作（SFW/NSFW/R18）、SQLite 工作权威（`runtime/content/catalog.sqlite`）与定稿基线保护统一遵循 [AGENTS.md](../../../AGENTS.md#质量红线) 与 [内容维护手册](../../../docs/maintenance.md)。
- **新增角色立绘/样张**：统一使用**无画师配方**（保留角色与作品标签，确认最终正向无 `@画师` 且未挂画师风格 LoRA）。

## 2. 编译字段核对矩阵

| 层级 | 检查要点 |
| --- | --- |
| 角色 | `characterTokens` 标定名字/别名，`copyrightTokens` 给作品名；不将长篇 `identityProse` 灌入 Anima 标签流 |
| 服装 | `outfitId` 与 `outfits[].tokens/prose` 一致，换装清除旧衣装冲突，穿衣/裸露按场景原意保留 |
| 场景 / 蓝图 | 核心动作/道具/环境入 `promptTokens`，细微关系入 `animaCaption`；NSFW 专门描写入 `nsfwTokens`/`nsfwProse` |
| 构图意图 | `single` / `group`（各自绑定特征服饰防串染）/ `triptych` 均全分级可用 |
| 最终请求 | 统一经 `compilePromptRecipe` 组装（MOSS 另核对 `renderMossDrawingPrompt`/`compileMossPrompt`），禁止编译后手工乱拼 |

## 3. 交付与自动纠正边界

- **状态实事求是**：严格区分「未编译/未出图」「已写入」「已编译」「来源待核」「已查看实图」；修改 skill 本身无需触发批量数据修改或出图。
- **非阻断批处理**：优先本地可信凭据，仅应用语义确定且通过编译的修补，冲突或无法确定项保留原文继续处理。定稿保护基线（`data/prompt-pinned-scenes.json`）批量跳过，单条更新按 [维护手册](../../../docs/maintenance.md#4-迁移与数据保护) 执行。
