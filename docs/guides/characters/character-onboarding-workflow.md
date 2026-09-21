# 热门角色接入工作流

> 2026-09-22。完整规则见 [工程契约](../../engineering-contracts.md#角色接入)。登记、生成、人工审核、发布、安装验收分别记录，不能相互替代。

## 日常维护入口

只编辑源文件，完成后运行 `npm run wf -- content:sync` 查看检查结果与参考登记计划；使用 `npm run wf -- content:sync --apply` 同步。该入口不调用模型、不发布、不安装。

| 要做的事 | 编辑位置 |
| --- | --- |
| 新增人物 | `data/characters.json` 补档案；`data/popular/<作品>.json` 补完整人物、身份与服装 |
| 新增服装 | 对应 popular 分片的 `outfits`，提供独立 ID、名称、tokens、prose |
| 新增人物场景 | `data/blueprints/<作品>.json`，填写正确的 `characterId` 和 `outfitId`；普通场景继续使用场景管理页或 `data/scenes/` |
| 新增作品系列 | 新建 popular／blueprints 分片并登记对应 `manifest.files`；统一同步会修正 count |
| 维护参考图片登记 | `data/references/<人物ID>.json` 中的 `standard` 与 `view`；共用机位与顺序在 `manifest.json` |

统一同步先检查人物档案、重复 ID、分片归属和蓝图服装引用；错误时在写入前退出。通过后修正清单计数、按需补登记新人物/服装的 pending 参考项，并构建人物、场景、蓝图与参考库聚合。`--ids=人物ID` 只缩小参考登记范围，其他内容仍整体校验与构建。主题、正文质量、真实模型出图与图片人工审核仍按下方清单验收。

参考库一人一文件；`character-reference-standards.json` 与 `character-reference-view.json` 是不入 Git 的兼容产物，不手工编辑。仅改参考源后可运行 `npm run wf -- reference:build`，`--check` 检查产物是否一致，fresh clone 缺产物时会重建。网关启动也会同步产物。前端按当前人物请求参考档案，已安装的参考资源版本继续优先，远程访问继续拒绝。

参考登记复用维护事务备份；写入失败回滚，异常退出留下 journal 时按 `maintenance:recover` 流程处理。统一同步不是跨所有构建步骤的单一事务：后续构建失败会明确报错，修复后可幂等重跑。旧维护脚本同步回写参考分片；它们仍可能变更已有资产记录，不能当作新候选发布入口。

## 交付清单

1. 在 data/popular、data/blueprints 分片和 characters.json 维护身份、服装、场景与档案，运行 content:sync 预览，再以 --apply 同步；保持归属与 outfitId 一致。
2. 档案提供有效 accent_color，由 characterTheme.ts 与通用 CSS 派生主题；特殊调校才登记 override。普通角色不新增 CSS 选择器，两种主题均需对比度与视觉验收。
3. 按既有内容契约逐条编写场景；检查编译 Token 与真实成图；保护 pinned 场景。
4. 原图生成后同步 WebP 头像，并按需要重建对应点云，核对图片指纹。
5. 每人物参考分片登记全部服装的 4 种参考机位和 3 种设计机位（content:sync 自动补齐缺项），按下方候选流程发布；pending 不能计为完成。
6. 按修改范围完成类型、内容、接口、前端与构建检查；桌面同步只走 deploy-desktop.bat，依赖或 exe 变化须完整安装，精准 commit + push。

样张发布目录从配置解析，不能沿用历史固定版本目录；参考资产不入 Git。

## 新候选的生成、审核与发布

统一入口为 `node scripts/workflow.js <命令>`。先用 `--help` 查看当前参数、`--plan` 查看执行计划，二者不调用模型或修改数据。

| 阶段 | 入口与副作用 | 完成条件 |
| --- | --- | --- |
| 登记 | `reference:register --dry-run` 只读预览；去掉 dry-run 写源，按 popular→standards/view 的服装粒度差额补齐 | standards/view 占位一致，状态仍为 pending |
| 候选 | `reference:render --output <隔离候选目录> --ids=<id>`，设计图用 `reference:design`；调用模型并写候选 | 有实际图片与生成清单；未审核 |
| 检查 | `reference:inspect --from <候选清单>` 只读 | 核对图片、记录和输入身份 |
| 人工审核 | 查看图片后写 decisions，再 `reference:review` 创建审核记录 | 每条决定绑定当前 recordId、sha256、inputVersion；漏审仍 pending |
| 发布 | `reference:publish` 默认只读预览；显式 `--apply` 写新版本 | 所选图片均通过有效人工审核；保留旧版本 |
| 接入与验收 | 显式配置网关参考根并重启，按需桌面同步 | 安装版图片/索引一致，设备结果独立登记 |

完整参数和审核 JSON 见 [参考库候选审核与版本发布](../../workflow.md#参考库候选审核与版本发布)。自动视觉检查不替代人工决定；发布不自动激活、安装或改写项目源索引。

## 历史活跃库维护

`character:onboard`、`sync-multi-outfit-standards` 与旧 URL 修复用于维护旧活跃库，可能直接写源/图片或调用模型，不能作为新候选发布入口。`character:onboard --skip-render` 仍有写入行为；`--deploy` 也不证明安装或设备验收。需要旧库维护时先检查当前帮助、计划和受控 diff；不以旧流水线的“成功”关闭新资产交付。

## 验收

执行 [分层门禁](../../workflow.md#门禁与构建)，另逐层核对主题、头像、参考图片与实际样张。保留来源、构建及审核/发布回执；结构校验通过不等于实际图片或设备通过。
