# 仓库写入与生成验收

仅在实际维护数据、编译/生成验收、批量重写或定稿时读取。字段与脚本路径均相对仓库根目录。先按 [工作流](../../../../docs/workflow.md) 选择现成入口；人物、服装、场景和蓝图以运行目录 `content/catalog.sqlite` 为工作权威，经记录 API 或 `content:catalog` 维护，保存后显式 export 项目快照。`data/catalog/` 仅是导出快照，旧分片只作升级导入，不手改或聚合回写。具体边界查 [内容库设计](../../../../docs/architecture/CONTENT-CATALOG-DESIGN.md)。

批量以目标 ID、manifest 或 delivery 确定范围；委派时按不重叠的角色/场景分工，交代引擎、源文件与保护字段，主任务合并并复核证据。

## 字段与编译核对

| 层 | 要核对的内容 |
| --- | --- |
| 角色 | `identityTokens` / `identityProse`、原作、稳定外貌、exact tokens |
| 服装 | 当前 `outfitId` 与 `outfits[].tokens/prose` 一致，避免身份字段泄漏旧衣装 |
| 蓝图 | `description` / `action` 的可见核心分别进入 `promptTokens` / `promptProse`，按实际 schema 写字段 |
| 背景与光影 | 环境 CG 的可见背景与位置、入光及受光关系进入最终正文；地点名、笼统光效词、维护字段或未消费 hint 不算补齐；特写与留白按原意 |
| 导演 | 镜头、光照、构图、`recommendedSize` 和模型参数不互相覆盖冲突 |
| 最终请求 | 完整 positive / negative、模型/LoRA、seed、尺寸、采样参数及参考输入 |

原场景明确要求的镜面形象／幻影可用 `allowRepeatedSubject` 保留，实际同伴使用 `compositionIntent: group`，三格叙事使用 `triptych`；不能把这些字段当成所有场景的默认。SFW 时间线外貌冲突时，`identityTokensOverride` / `identityProseOverride` 只在该条蓝图中声明已有形态，不改变角色 ID；此类外貌变体拒绝成人蓝图或手动成人词请求。衣装字段只保留衣装，手持道具属于具体场景。

代码入口：`src/utils/popularContent.ts`、`src/composables/prompt/usePopularPromptAssembly.ts`、`src/utils/promptCompiler.ts`、`src/utils/promptPolicy.ts`；独立场景检查复用 `scripts/lib/scene-render-contract.js`。

分级沿用项目字段及 `adultEnabled = isLocalStudioHost()` 边界；远程、未知或未授权状态 fail-closed。不要为完成场景数量自动增添成人内容，不把分级标记当作人物成年依据。该 skill 提供全年龄、明确成年角色的非露骨创作与中性的分级/一致性审查，不提供露骨性描写的扩写配方。

## 验证与交付

- **草稿/解释**：标明目标引擎、必要假设、提示词及负向策略；不需要为了单纯草稿启动仓库工作流。没有真实运行就写“未编译/未出图”，不能称最终请求。
- **实际数据变更**：检查最终编译内容并真实出图，核对身份、衣装、动作/接触、人数/肢体、构图和环境。静态通过、生成成功或 UI 文案都不是视觉通过。
- **批量重写**：逐条真实改写并用 `node scripts/tests/test-prompt-rewrite-integrity.js --delivery <文件>` 验收。单点纠错如使用 `--targeted`，明确范围，不冒充全量重写。
- **定稿**：批量跳过 `data/prompt-pinned-scenes.json` 的保护字段。单条修改按项目要求先真实出图再 `npm run scenes:pin-capture`。
- **规则实验**：保持 checkpoint、LoRA、尺寸、采样器、步数及加速设置一致，用同一组固定 seeds 对比；一轮只改一个因素。建议先用 3 个 seed 小样筛查，不能据此推断全库效果。
- **记录**：保留候选清单、最终请求、参数和输出路径，逐图标记问题；区分生成失败、视觉未通过和未审核。只有实际查看过的图才能计为视觉审核。
- **仅修改 skill / 文档**：做结构、链接、规则一致性等必要检查即可，不把文档验收宣称为生成质量提升，也不机械运行与本次风险无关的完整构建或真实出图。
- **服务或素材阻塞**：先完成可独立进行的源数据检查、候选草稿或编译核对，记录缺失服务/输入与待验收 ID；不循环重试同一失败，不把候选发布为已验收结果。

交付按任务给出必要的提示词或改动、依据、当次检查及未完成项；涉及出图时附真实证据。单条草稿无需完整审计报告，批量交付需明确目标数、已改写数和已视觉验收数。
