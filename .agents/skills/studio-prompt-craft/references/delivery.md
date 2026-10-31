# 仓库写入与生成验收

用于数据维护、提示词编译核对、批量重写及出图验收。

## 1. 数据分层与工作流

- **工作权威**：人物、服装、场景与蓝图以运行目录 `content/catalog.sqlite` 为工作权威，通过记录 API 或 `npm run wf -- content:catalog` 维护。
- **项目快照**：`data/catalog/` 为 Git 跟踪的项目快照，经显式 export 导出。
- **全分级自由创作**：支持自由选择 SFW、NSFW、R18 等任意分级；蓝图 `adult` 字段声明分级属性，`sampleRating` 标记样张分级。展示遵循目录缩略图遮罩、作品册直接展示的边界。

## 2. 字段与编译核对规范

| 层级 | 关键检查点 |
| --- | --- |
| **角色** | `characterTokens` 标记名字/别名，`copyrightTokens` 提供作品名；保留鲜明身份锚点，避免将长篇 `identityProse` 直接灌入 Anima 标签流。 |
| **服装** | 当前 `outfitId` 与 `outfits[].tokens/prose` 严格一致；换装时清除旧衣装冲突词；穿衣或裸体由场景明确决定，不随意推断或篡改原穿着状态。 |
| **蓝图与场景** | Anima 的核心动作、姿态、道具、环境进入 `promptTokens`；可选细微补充进 `animaCaption`。NSFW 场景的专门描写进入 `nsfwTokens` / `nsfwProse`，双字段协同生效。 |
| **构图与人数** | 支持单人、多人（`compositionIntent: group`）与分格叙事（`triptych`），全分级开放；多人需分别绑定各自主体的特征与服饰，避免特征串染。 |
| **最终请求** | 核对最终完整 positive / negative、LoRA、画幅及采样参数。通过 `compilePromptRecipe` 统一编译，禁止在编译后手动拼接乱序标签。 |

## 3. 验收与交付要求

1. **草稿阶段**：标明目标引擎、必要假设与正负向策略，注明“未编译 / 未出图”。
2. **实际数据变更**：必须通过 `compilePromptRecipe` 检查最终编译内容，并以真实渲染画面作为视觉审核依据。
3. **批量维护**：逐条审查并核对交付差异，不进行模板机械拼接。
4. **定稿保护**：`data/prompt-pinned-scenes.json` 保护字段批量任务自动跳过；单条改动需先真实出图，再运行 `npm run scenes:pin-capture` 更新。
5. **交付汇报**：交付结果简明清晰，列出修改范围、核心依据、编译核验及未完成项。
