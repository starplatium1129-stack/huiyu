# GLM W1 实施复核与提交范围

2026-09-13。复核工作流元数据、只读覆盖报告和测试；保护其他任务文件。本轮没有模型调用、素材发布或桌面安装。

## 修复结论

GLM 完成了有效的实现，但原定向测试漏掉了若干边界，本轮直接修复：

- `--plan` 原先只显示默认 nature，带 `--apply` 仍只看到 preview。现分别显示默认行为与本次开关关联行为，不假设组合开关优先级，也不改变执行命令。
- 复合审计原先禁止任何纯只读组合，却不能发现部分漏报副作用。现根据实际子步骤检查副作用覆盖，允许真正只读的组合；元数据列表类型校验与显示要求一致。
- 元数据补记 fill-gaps 的 dry-run 仍会创建目录，以及 gate:quick 可能升级 full 构建。这里只纠正描述，不改变这两个入口的业务行为。
- 覆盖报告原先遇到部分机位 pending 就跳过整套剩余 URL；现逐项检查可核实图片。
- 重复角色/形态被 Map/Set 隐藏、manifest count 未实际比较、同文件及空服装角色重复漏报等均补结构校验；原 count 测试有被其他错误误触发的假阳性，已增加精确断言。
- `--root` 改为显式只读加载，固定复用项目配置解析器，不执行夹具内 config，也不依赖模块缓存或继承环境来确定夹具根；先校验 URL，再判断参考根是否可访问。
- 根 TypeScript 失败来自先前 API 类型接入引入的前端实现链，并非 GLM 本批新增：SceneBlueprint/BlueprintCompositionIntent 移入独立纯类型模块，原路径保留类型导出。没有弱化 tsconfig、使用 any 或改变生成逻辑。
- 修复本轮相关源码、计划文件的 LF 行尾；Gemini 报告和候选仅做尾部空格/末尾换行整理，没有修改其结论、分级或提示词内容。

## 本机检查

- 工作流定向回归 18 例、覆盖报告隔离回归 10 例通过。
- `npm run typecheck` 通过；仓库文本规范检查通过。
- `audit:workflows` 为 75 项，错误 0。覆盖报告实际库只读检查结构错误 0；357 套缺登记、282 套有 pending、2,324 条图片未核实。后者只统计本报告覆盖的热门服装机位，不是全参考库的 2,534 条 URL；未核实不等于缺图。
- 完整 `gate:full` 通过，耗时 2 分 17 秒：check、前端单测、536 项 unit、26 组 contract、构建与预算均通过。办公机使用 `AICS_REFERENCE_AUDIT_MODE=structure`，不把该模式当成真实素材验收。日志为 `scripts/archive/glm-governance/full-review-final.log`；首次运行的行尾失败记录保留在 `full-review.log`，修正后定向复验再重跑完整门禁。

## 可提交范围

**工程提交**：scripts/workflow.js、scripts/lib/workflow-runner.js、scripts/maintenance/report-content-coverage.js、scripts/tests/test-workflow-runner.js、scripts/tests/test-coverage-report.js、scripts/tests/quality-test-inventory.js、docs/workflow.md；再附纯类型边界修复 src/types/sceneBlueprint.ts、src/types/api.ts、src/utils/popularContent.ts、src/utils/blueprintComposition.ts。搭配本复核记录与 GLM 原实施记录，索引仅选择对应已审核条目。

**可以按草稿性质另行归档**：主任务写的模型交接说明、Gemini 两轮复核说明、场景 review.md 与 reviewed-three.json。三条候选保留完整源身份/衣装快照，可独立阅读，明确未编译/未出图，不能作为生产场景发布。原 60/12 批次暂留工作区，sourceDraftId 仅标明原交付映射；复核记录注明原稿未随本次提交归档。

**不宜当作已验证成果提交**：Gemini 仍有误报的文档证据表/验收用例、未完成源依据纠正的原 60/12 场景稿；如需保留，仅作为未审核原始交付归档，不升级成规范。NSFW 提示词规范及其 skill/索引接线未经过本轮内容审查，不属于本轮已验证范围，继续保持独立。

共享 docs/INDEX.md、docs/guides/README.md 和 skill 当前混有其他任务内容，不能整文件无选择暂存。也不应 `git add .`，临时脚本、截图、日志与素材不入本次提交。
