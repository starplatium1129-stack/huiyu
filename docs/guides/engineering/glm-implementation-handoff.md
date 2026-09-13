# GLM 治理报告复核与首批实施交接

2026-09-13。复核 [GLM 盘点](../../research/engineering/glm-governance-inventory.md) 与 [JSON](../../research/engineering/glm-governance-inventory.json)，基于 `e942116` 后的当前工作区。仅完成只读核验和任务分配，未启动下面的工程实施。

## 复核结论

原报告值得作为实施线索。已重新运行注册表审计，确认 74 项入口无断链/循环；检查其一次性脚本后重新运行，主要规模与引用差额能复现。重点源码已核实：

- `render-all-outfits-references.js` 与 `generate-all-scenes-showcase-miaomiao.js` 默认网关确为 3123，`reference:render` 的注册说明写 3000，存在配置说明不一致。先明确默认及覆盖规则，不能全仓替换 3123。
- `render-showcase-gaps.js` 在 dry-run 判断前 mkdir，成功出图后直接写目标清单并把 `review.verdict` 填为 pass；必须拆清生成成功、已审核和已发布。仅把 pass 改 pending 并不能防止原图已写进活跃目录。
- `generate-all-scenes-showcase-miaomiao.js` 使用固定版本目录。候选输出、审核和发布边界需要专门改造与故障测试。
- 971 套热门服装中有 357 套未在标准参考库登记；现有 register 只处理整角色标准服装为空的情况。该差额是覆盖待办，不是悬空引用，不授权自动补描述、机位或触发出图。
- CSS 的 historia_reiss 选择器没有对应 canonical krista_lenz；除默认主题角色 nene 外，8 个角色未匹配显式主题。需区分旧别名、允许默认与待补，不能统一套一套颜色或直接改为硬失败。

报告需更正：DATA_VERSION 当前为 13 个产物，不是 12；“只读门禁（11）”与实际枚举不符；“只读但默认即写”分类不适合作为机器元数据。热门/蓝图检查是解析对象序列化比较，场景部分只比较数量，不能宣称全域逐字节零漂移。参考 URL 非空也不表示图片已完成。本次未把 74 个底层脚本全部重新逐行审计。

## 分工决定

让 GLM 先实施 W1 的工作流元数据及只读覆盖报告，主任务复核后整合。发布目录、审核状态、默认端点的实际运行兼容，以及角色主题与真实素材修复由主任务另批处理。当前不让 GLM 一口气落实原报告的十项建议。

## 发给 GLM 的提示词

```text
你的治理盘点已复核，继续做首批工程实现。先读 docs/guides/engineering/glm-implementation-handoff.md，按其中的更正修订你原有的 glm-governance-inventory.md/json，保留可追溯的更正记录。

只实施下面两项，先完成 A 的隔离验收，再做 B：

A. W1 工作流执行元数据
- 在 scripts/workflow.js、scripts/lib/workflow-runner.js 和现有测试内，建立最小、结构化、可复用的运行条件与副作用描述，供 help/plan/audit 共用。
- 覆盖全部当前注册入口。允许同一命令包含多种副作用，区分默认行为、显式开关、前置缺失时自愈；复合工作流不能仅标成只读。未知项标未知并附核实位置，不猜。
- 不改变任何现有命令执行步骤、参数、默认端点、生成参数、目录或发布行为，不新增基于元数据的运行拦截策略。保留兼容入口，发现脚本缺陷只登记给主任务。
- 测试真实检验 help/plan 不调用执行器、元数据合法、复合与参数条件描述准确、旧调用仍按原参数运行；不要写只重复实现内容的快照测试。

B. 只读内容覆盖差额报告
- 复用现有 store/manifest 读取器与校验能力，输出热门服装→参考登记差额，以及角色 canonical ID→主题选择器的覆盖差额。
- 输出对象 ID、所在源文件、差额类型和关联位置。将缺参考登记、缺实图、pending、默认主题允许项、旧别名分开。
- 本批只输出报告，不批量登记服装、不创建图片、不改人物/服装/场景/蓝图/提示词/主题。历史覆盖缺口只作信息，不直接让现有 CI 因 357 个缺口失败。
- 新维护入口按 AGENTS 登记 scripts/workflow.js 和 docs/workflow.md。临时脚本不能原封不动转正式门禁：补双方 ID 集合、缺文件、重复 ID、缺批号与结果可复跑的隔离测试；不要用“数量相同”证明内容一致。

工作区规则：开工检查 git status/diff，保护其他任务改动。你的源码范围限 workflow 注册表、runner、必要的只读报告模块及相应测试；文档仅你的报告、docs/workflow.md 和独立实施记录。不要编辑共享 INDEX、roadmap、AGENTS、skill、UI 或生产 data/assets。需要超出范围时记录原因，继续独立部分。

不修改 render-showcase-gaps、batch-miaomiao、reference:render 的执行逻辑，不碰发布清单和审核 verdict。这些由主任务另批处理。

按仓库工作流要求完成受影响检查；使用临时夹具，不连接生产服务、不调用模型、不安装、不发布、不提交或 push。交付列明改动文件、行为变化、测试证据、已知限制及未完成项。未知或失败不得标完成；完成 A/B 后停止，不扩到原报告其余建议。
```
