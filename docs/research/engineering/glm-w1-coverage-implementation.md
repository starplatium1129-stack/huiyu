# GLM 实施记录：W1 工作流元数据 + 覆盖差额报告（首批）

> 下文保留 GLM 首次交付记录；随后发现的遗漏、主任务修复及最终提交范围以 [实施复核](glm-w1-review-and-submit-scope.md) 为准，原测试数量与读取器实现不代表修复后现状。

2026-09-13。依据 [GLM 实施交接](../../guides/engineering/glm-implementation-handoff.md) 完成首批两项工程实施（A：W1 运行条件元数据；B：只读覆盖差额报告），并按复核更正修订了治理盘点。未提交、未 push；不连接生产服务、未出图。

## 0. 盘点修订（复核更正落实）

[glm-governance-inventory.md](glm-governance-inventory.md) / [.json](glm-governance-inventory.json) 顶部新增「复核更正」节（JSON `meta.review.corrections`），逐条保留可追溯记录：

- R1 DATA_VERSION 哈希域 12 → **13**（`scripts/lib/data-version.js:18-23` 注释明示）；
- R2 「分片↔聚合逐字节零漂移」改为准确表述：popular/blueprint 为**解析后逐条 JSON 序列化比较**，场景为数量与 scenes-index 计数一致；
- R3 「只读门禁（11）」枚举失实 → §3.3 改为 facet 描述；单一「只读但默认即写」标签不进入机器元数据；
- R4 补记：参考 URL 非空 ≠ 图片已交付/通过审核；缺登记 357 项是**覆盖待办而非悬空引用**。

另按实数据核补：nene 的 `accent_color(#38bdf8)` 与 tokens.css `:root` 默认色 `#ff75a0` 不同源，「nene 走默认主题」属人工约定，不可由数据推导（影响 B 的实现选择，见 §2）。

## 1. A：W1 工作流执行元数据

### 设计

- 元数据**内联**在每个 `WORKFLOWS` 注册项（`scripts/workflow.js`），字段：
  - `nature`：默认（无开关）行为的 facet 多值；枚举 `EFFECTS`（read-only / preview / self-heal-missing / guard / writes-source / writes-product / writes-release / writes-baseline / delete / external-model / network-download / publish-remote / service / isolated-fixture）；
  - `machine`：`MACHINES`（node / windows / windows-toolchain / python-pillow / gateway / comfyui / vision-api / network / playwright-browser / build-present）；
  - `switches`：显式开关 → 行为 facet（如 `data:build --check` → `['self-heal-missing','guard']`、`runtime:clean --prune` → `['delete']`）；
  - `resume`：idempotent | checkpoint | na；`evidence`：核实位置（文件:行）；`unknown`：未核实点；`notes`：已确证缺陷登记（如 C1/C2/C3，不改执行）。
- **共用**：`node scripts/workflow.js <命令> --help` 的详细 JSON 输出 `run` 字段；`--plan` 预览每步追加 `[nature]` 标注；`audit:workflows` 校验元数据（缺字段/未知枚举/复合只读/开关格式/空 evidence 均报错并计入退出码）。`audit:workflows --json` 实测 `count=75, errors=[]`。
- **零行为变化**：runner 的 `main/plan/invocation` 执行路径不读取 `run`，无基于元数据的拦截；所有命令、参数、默认端点、目录、发布行为不变（`deploy-desktop.bat`、`render-showcase-gaps.js`、`generate-all-scenes-showcase-miaomiao.js`、`reference:render` 的执行逻辑一律未动，缺陷只在 `notes` 里登记）。
- 复合工作流（`reference:full`/`showcase:full`）显式给 `run`，审计强制「复合不得仅标 read-only/preview/夹具」。

### 测试证据（scripts/tests/test-workflow-runner.js，15/15 通过）

新增 5 个真实行为测试（非快照）：

1. 74+1 项 `validateRun` 全部合法；
2. 审计拒绝：缺 run、复合只读、未知枚举、非 `--` 开关、非法 resume、空 evidence；
3. **元数据仅描述性**：`machine:['windows']` 的 node 命令在任何平台按原参数执行（无拦截）；
4. **旧调用不变**：注入 run spy 断言 `data:build`/`check:content`/`showcase:scene-candidates` 的真实 cmd/args 逐字节不变（npm 无转发参数时不插 `--`，语义保持）；
5. **help/plan 不调用执行器**（注入会抛错的 run）；help 输出含 run 与 `self-heal-missing`；`--plan` 输出 `[preview]` 标注且必填参数校验照常生效；
6. 语义一致性不变式：external-model 必须声明 gateway/comfyui/vision-api 之一、默认 preview 的发布器不得默认写入、复合 nature 与子步骤有交集、定点校验（`data:build --check` 自愈+守卫、`reference:register` 默认写、`runtime:clean --prune` 删除、`showcase:full` 发布步无 writes-release）。

## 2. B：只读内容覆盖差额报告

### 设计（scripts/maintenance/report-content-coverage.js）

- **入口**：`npm run wf -- audit:coverage [--json] [--root <夹具根>]`（已登记 WORKFLOWS + docs/workflow.md「内容覆盖差额报告」节）。
- **复用现有读取器**：`scripts/lib/popular-store.js`（分片+manifest，通过 `AICS_DATA_ROOT` 支持夹具根）、`server/config.resolveCharRefRoot`（素材根解析，与 `check:ref-urls` 同口径）；standards/view/characters/tokens.css 只读。
- **输出分类**（每条含对象 ID、所在源文件、差额类型、关联位置）：
  - 参考：`missing-reference-registration`（357，109 角色，含分片文件名）、`reference-pending`（282 套形态存在 pending 视角）、`missing-image`（URL 已填但素材根 statSync 缺文件）、`unverified`（素材根不存在/structure 模式，不冒充缺图也不冒充通过；本机 2324 条属此类）、`reference-only-forms`（30，sync 自动追加机制，单列不混入差额）；
  - 主题：explicit 151 / default-allowed `nene`（显式清单，附证据注释）/ 待补 8（含 characters.json 的 accent_color 供修复参考）/ 旧别名 `historia_reiss`（经 popular 别名归一匹配建议 `krista_lenz`，标「待人工确认」）/ 未归类 `triad`（共享主题，人工归类）。
- **结构错误退出 1**（清单缺文件、跨分片重复角色/服装 ID、manifest 条目缺 count 或批次数不符、standards↔view 镜像破坏）；**覆盖差额恒退出 0**（信息性，不作为门禁失败依据）。不写任何文件、不批量登记、不出图、不改主题。
- 输出确定性：排序稳定、无时间戳（可复跑 diff）。

### 测试证据（scripts/tests/test-coverage-report.js，6/6 通过，已登记 unit 套件）

隔离夹具（tmp 目录，覆盖交接要求全部验收点）：双方 ID 集合差额精确断言；pending/缺实图/无法核实三分（注入 fileExists true/false/null）；standards 独有形态不混入差额；跨文件重复角色+重复服装 ID → 结构错误；standards↔view 镜像破坏 → 结构错误；manifest 批次数不符 → CLI 退出 1；分片缺文件 → CLI 退出 1；CLI 两次运行 stdout 逐字节一致；`fileExists` 区分「真缺图」与「素材根缺失」，越界路径拒绝。

### 生产数据实测（2026-09-13，本机）

`node scripts/maintenance/report-content-coverage.js --json` → 退出 0，结构错误 0；缺登记 357 / pending 282 套 / 缺实图 0 / 无法核实 2324 / 参考库独有 30；主题 explicit 151 / 缺 8 / 旧别名 1（→krista_lenz）/ 未归类 1（triad）。与盘点数字一致。快照存 `scripts/archive/glm-governance/coverage-report-2026-09-13.json`（gitignored，非交付物）。

## 3. 改动文件清单

| 文件 | 变化 |
| --- | --- |
| scripts/workflow.js | 74 项加 `run` 元数据 + 新增 `audit:coverage` 注册（命令行为零变化） |
| scripts/lib/workflow-runner.js | 新增 `EFFECTS/MACHINES/RESUME_MODES/PASSIVE_EFFECTS/validateRun`；audit 校验元数据；help/plan 展示 run（执行路径不变） |
| scripts/tests/test-workflow-runner.js | +5 个元数据行为测试（15/15） |
| scripts/maintenance/report-content-coverage.js | 新增（只读报告） |
| scripts/tests/test-coverage-report.js | 新增（6/6，隔离夹具） |
| scripts/tests/quality-test-inventory.js | unit 套件登记 `test-coverage-report.js`（1 行） |
| docs/workflow.md | 更新维护日期、元数据说明、audit:coverage 行与专节 |
| docs/research/engineering/glm-governance-inventory.md/.json | 按复核更正修订（见 §0） |

## 4. 已知限制与未完成项

- `check:rewrite` 的 run.nature/evidence 依据注册与盘点（code-verified 级），脚本主体未逐行核实，已标注 `unknown`。
- 元数据中 `notes` 登记的 C1/C2/C3 缺陷**保持原样**，按交接由主任务另批处理；本批未修改三个脚本的执行逻辑。
- `historia_reiss→krista_lenz`、`triad` 归类、8 个待补主题、357 缺登记均为**报告内容**，须人工确认后另行处理；本批未做任何数据/主题修改。
- audit:coverage 未纳入 CI 门禁（按交接保持信息性）；其测试已进 unit 套件随 CI 运行。

## 5. 验证结果（2026-09-13，办公机实测）

| 检查 | 结果 |
| --- | --- |
| `node scripts/tests/test-workflow-runner.js` | **15/15 通过**（含新增 5 个元数据行为测试） |
| `node --test scripts/tests/test-coverage-report.js`（unit 套件成员） | **6/6 通过**；随 `npm run test:unit` 全套 **532 用例通过** |
| `node scripts/workflow.js audit:workflows --json` | **count=75, errors=[]**（含 run 元数据校验） |
| `npm run test:frontend` | **634/634 通过**（92 文件） |
| `npm run test:contract` | **26 过 / 0 挂** |
| `npm run build`（+打包预算+预压） | **通过**（18 路由预算内；index.js lazy 923.4/1000 KiB 超 90% 警告为既有提示） |
| `npm run check`（`AICS_REFERENCE_AUDIT_MODE=structure`，办公机文档化模式） | **20/22 步通过**；2 步失败均与本批无关（见下） |

**check 套件 2 个失败步的甄别（均非本批引入）**：

1. `typecheck`：`tsc -p tsconfig.json` 对已提交 src 文件报 TS5097（`.ts` 后缀导入）/TS2307（`@/` 别名）。根 tsconfig 的 include 是 `cd2221c`（桌面 1.5.5 发布提交）扩大的，涉事源码（promptPolicy.ts 等，最近 d73959d 2026-09-09）两个会话都未触碰——**HEAD 既有状态**。`vue-tsc -p tsconfig.app.json`（typecheck:app）通过。
2. `test:check`：repo-hygiene 对 `plans/006-workflow-and-content-governance.md` 报 CRLF。该文件磁盘字节 2026-09-12 16:49 起即为 CRLF（早于本批任何写入），`git diff` 无修改（text 属性自动归一），本批未触碰该文件——**工作区既有状态**，建议主任务按行尾规范处理。

另：不做 structure 模式时 `ref-urls`/`content-contracts` 因本机素材根未配置（`runtime/config.json` 仅有 sceneShowcaseDir）失败 2534/2534 缺图——按 docs/workflow.md 记载属办公机预期，structure 模式下两步均通过（2534 unverified 如实标注）。

## 6. 验证命令

```
node scripts/tests/test-workflow-runner.js          # 15/15
node --test scripts/tests/test-coverage-report.js   # 6/6
node scripts/workflow.js audit:workflows --json     # count=75, errors=[]
node scripts/maintenance/report-content-coverage.js # 退出 0，数字与盘点一致
npm run test:frontend / test:unit / test:contract / build   # 全部通过
AICS_REFERENCE_AUDIT_MODE=structure npm run check   # 20/22；2 步既有失败见 §5
```

### 注册表零漂移证明

以 `git show HEAD:scripts/workflow.js` 与本批版本逐字段比对（desc/cmd/steps/builtin/required/opts/docs/needs）：74 项 **0 漂移**，仅新增 `audit:coverage`；runner 执行路径行为由注入 spy 的等参测试覆盖（§1 测试 3/4）。
