# 仓库写入与生成验收

## 1. 数据权威与创作红线

- 全分级自由创作（SFW/NSFW/R18）、SQLite 工作权威（`runtime/content/catalog.sqlite`）与定稿基线保护统一遵循 [AGENTS.md](../../../../AGENTS.md#质量红线) 与 [内容维护手册](../../../../docs/maintenance.md)。
- **新增角色立绘/样张**：统一使用**无画师配方**（保留角色与作品标签，确认最终正向无 `@画师` 且未挂画师风格 LoRA）。

## 2. 两类内容契约对比（工作室场景 vs 热门蓝图）

| 维度 | 工作室场景（`kind: scene` / `data/scenes.json`） | 热门蓝图（`kind: blueprint` / `data/scene-blueprints.json`） |
| --- | --- | --- |
| 适用角色 | 仅 `nene`、`natsume`、`triad`（ID 格式 `sc001`） | 全部热门角色（关联 `characterId` + `outfitId`） |
| 正向字段 | 字符串 `prompt` + `animaCaption` + `promptProse` | 数组 `promptTokens` + `nsfwTokens` + `promptProse` + `nsfwProse` + `animaCaption` |
| 负面契约 | 仅写场景专属排除项，现行校验由 Rust `catalog/validation.rs` + `prompt_guard.rs` 负责（旧 `validate-scenes.ts` 为历史 SDXL 遗留脚本） | 仅写当前画面专属排除项，无则 `[]`；**`prompt_guard.rs` 硬拦截** `bad hands`/`extra fingers`/`worst quality`/`score 1..3` 等通用模板 |
| 保护规则 | 命中 `data/prompt-pinned-scenes.json` 时锁定 6 字段：`prompt, negative, animaCaption, recommendedSize, rating, mature` | 含 `generatedRecipe` 的实图冻结蓝图豁免模板/必填校验 |

## 3. 编译字段核对与 `prompt_guard` 校验矩阵

| 层级 | 检查要点 |
| --- | --- |
| 角色 | `characterTokens` 标定名字/别名，`copyrightTokens` 给作品名；每个热门角色**有且仅有 1 套 `default: true` 服装**；不将长篇 `identityProse` 或服装句灌入 Anima 标签流 |
| 服装 | `outfitId` 与 `outfits[].tokens/prose` 一致；`prose` 必须为英文；换装清除旧衣装冲突；成人蓝图未显式换装时由蓝图自身承载衣装/裸露 |
| 场景 / 蓝图 | 核心动作/道具/环境入 `promptTokens`（不重复写角色名/发色瞳色），细微关系入 `animaCaption`（≤ 2 句）；NSFW 标签入 `nsfwTokens`，Krea/MOSS 成人散文入 `nsfwProse`（注意 `animaCaption` 非空时 Anima 忽略 `nsfwProse`） |
| 构图意图 | `single` / `group`（自动移除 `solo` 与多人负面，Anima 用 `BREAK` 分区，MOSS 用多框布局 JSON + `duplicate character, clone`）/ `triptych`（移除分格/边框负面）；镜像分身设 `allowRepeatedSubject: true` |
| 最终请求 | 统一经 `compilePromptRecipe` 组装（MOSS 另核对 `renderMossDrawingPrompt`/`compileMossPrompt`），禁止编译后手工乱拼 |

**`runtime-rs/src/catalog/prompt_guard.rs`（`studio-prompt-craft/source-v1`）写入校验**：
- **5 类硬拒绝（422 `PROMPT_CRAFT_REJECTED`）**：`unresolved-placeholder`、`retrieval-token`（`official_cg`/`visual_audited`）、`studio-identity-leak`（热门角色混入 `ayachi_nene`/`shiki_natsume`/`nene_*`/`natsume_*`）、`environment-in-identity`（身份/服装混入 16 个环境词）、`blueprint-negative-boilerplate`。
- **2 类警告**：`model-default-in-content`（正文含 `masterpiece`/`best quality`/`score 7`/`score 9`/`very aesthetic`）、`positive-negative-overlap`。

## 4. 交付与自动纠正边界

- **状态实事求是**：严格区分「未编译/未出图」「已写入」「已编译」「来源待核」「已查看实图」；修改 skill 本身无需触发批量数据修改或出图。
- **非阻断批处理**：优先本地可信凭据，仅应用语义确定且通过编译的修补，冲突或无法确定项保留原文继续处理。定稿保护基线（`data/prompt-pinned-scenes.json`）批量跳过，单条更新按 [维护手册](../../../../docs/maintenance.md#4-迁移与数据保护) 执行。
