# 热门角色接入工作流

完整契约见 [工程契约](../../engineering-contracts.md#角色接入)，SQLite 读写与导出命令见 [维护手册](../../maintenance.md)。

---

## 1. 维护入口与文本准则

- **内容库维护**：人物档案、热门身份、服装、场景与蓝图均通过内容维护页或 `content:catalog` 在 `content/catalog.sqlite` 维护，并按需显式 `export` 至 `data/catalog/`（旧分片文件不再手工编辑，旧 `content:sync` 仅作只读/聚合兼容）。
- **故事与提示词分工**：角色档案与场景故事使用 [humanizer-zh](../../../.agents/skills/humanizer-zh/SKILL.md)；图像提示词与编译遵循 [studio-prompt-craft](../../../.agents/skills/studio-prompt-craft/SKILL.md)。
- **立绘与参考图定位**：角色档案展示立绘、资料与场景，不要求补齐固定四视角或三视图；参考图库（`data/references/`）为可选隔离资产，无参考图不阻塞角色创建或分镜使用。

---

## 2. 新角色交付清单

1. **目录数据**：维护人物、服装、场景与蓝图记录，确保 `outfitId` 与归属一致并显式导出快照。
2. **主题配色**：在档案提供有效 `accent_color`（由 `characterTheme.ts` 派生双主题变量），仅特殊微调登记 override，不在 CSS 新增角色专属选择器；双主题视觉对比度需目视核对。
3. **场景编写与保护**：按内容契约逐条编排提示词并核对编译 Token 与真实出图；批量操作跳过 `data/prompt-pinned-scenes.json` 定稿基线。
4. **立绘、头像与粒子**：生成立绘原图后同步 WebP 缩略图，并按需运行 `npm run particles:build` 更新点云与交付状态。
5. **代码与桌面同步**：按实际影响完成类型检查与产品构建；桌面端统一通过 `deploy-desktop.bat` 同步，仅精确提交本次审查过的文件。

---

## 3. 可选参考库候选审核与发布

统一入口 `npm run wf -- <命令>`（详细参数见 [工作流](../../workflow.md#参考库候选审核与版本发布)）：

| 阶段 | 命令与行为 | 完成标准 |
| --- | --- | --- |
| 登记占位 | `reference:register [--dry-run]` | 按服装粒度补齐 `standards/view` 占位（状态 `pending`） |
| 生成候选 | `reference:render --output <隔离目录> --ids=<id>` | 产出候选图片与清单（未审核） |
| 人工核对 | `reference:inspect` → 写 `decisions.json` → `reference:review` | 每条决定绑定 `recordId`、`sha256` 与 `inputVersion` |
| 发布版本 | `reference:publish [--apply]` | 全部所选图人工通过；保留旧版本 |
| 网关接入 | 配置网关参考根并重启，按需同步桌面端 | 索引与文件一致（`pending` 不算已交付） |

> **历史活跃库工具说明**：`character:onboard`、`reference:design`、`sync-multi-outfit-standards` 为旧活跃库维护入口，可能直接写源或调模型，不得用于新候选发布。
