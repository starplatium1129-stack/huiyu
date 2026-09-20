# 统一工作流手册

> 维护日期：2026-09-15。命令注册与默认参数以 scripts/workflow.ts 源码为准，运行入口 scripts/workflow.js 由构建生成；此页解释操作顺序，不重复易漂移的脚本数量、角色规模和历史测试用例数。

## 先查入口

`node scripts/workflow.js audit:workflow-conditions --json` 从当前注册表报告运行条件、入口/文档存在性及递归复合副作用覆盖。`--domain audit` 按工作流分组筛选；`--root` 仅替换文件存在性核验根，不加载该目录中的 JavaScript。`--help/--plan` 不读取目标根或启动子进程。结构问题退出 1，所有命令执行状态始终为 `not-run`；元数据通过不代表实际运行通过。`showcase:fill-gaps` 实际生成需网关与显式候选目录，只写待审核候选；`--dry-run` 不写盘、不调用模型，不回填活跃源登记。

条件报告的 JSON 还保留已声明的 `switches`、`notes`、`needs`（缺省分别为 `{}`、`[]`、`null`），不从说明文字推断副作用。默认文字按项列出默认行为、开关及效果、前置条件、说明和未知项；不改变命令执行、旧 JSON 字段或退出码。

`apply-scene-patch.js --patch <JSON> [--out <报告JSON>]` 保持默认 dry-run：不写数据或备份，显式 `--out` 仅写报告。报告保留旧字段，并增加 schema/version、sourceFiles、changedRecords、protectedFieldDecision、derivedOutputs、writeStatus、applyStatus、rollbackCapability。输入 patch 仍为 v1 数组格式；保护字段拒绝整批，不产生允许报告。`--out` 禁止覆盖 data 目录、输入、源、派生产物、基线及压缩兄弟文件，核对现有父目录的真实路径。`--apply` 先保存可读 manifest 和原始字节，再逐文件原子替换；重建/校验异常恢复声明范围内原文件及压缩文件，并删除原先不存在的产物。失败报告区分已回滚与回滚失败。此契约不覆盖进程被强杀、断电、并发写入和回调未声明的额外文件；不构成真实保存 API 或跨进程事务。

`npm run workflow -- --help` 查看全部命令，`node scripts/workflow.js reference --help` 查看分组。具体命令帮助只展示注册信息，绝不启动底层脚本。`--plan` 统一预览实际命令，分别标注默认行为与本次所带开关的关联行为，不出图、不写数据；`--dry-run` 是底层脚本参数，仅在该脚本明确支持时使用。

每个注册项带结构化 `run` 元数据（W1）：`nature`（默认行为 facet，如 read-only / writes-source / writes-product / writes-release / external-model）、`machine`（node / windows / python-pillow / gateway / comfyui / vision-api 等）、`switches`（显式开关改变的行为，如 `--check` 的自愈与守卫）、`resume`（idempotent / checkpoint / na）、`evidence`（核实位置）与 `unknown`。help 的详细 JSON 与 `--plan` 预览、`audit:workflows` 审计共用这份元数据；它只用于描述与审计，不改变任何执行步骤，也不做运行时拦截。复合工作流的 nature 必须覆盖子步骤的副作用；真实纯只读的组合可以保留只读标记。开关关联行为不是完整执行模式，不替代底层参数组合与优先级规则。

没有入口时查 scripts/maintenance 或运行 `npm run workflow -- audit:orphans --json`。有现成流程必须复用；新增脚本同时登记 WORKFLOWS、本手册分组，新增文档登记 INDEX.md；一次性脚本用完归入 scripts/archive。

## 日常快捷操作

统一短入口：`npm run wf -- <命令>`（与 workflow 完全等价）。

| 想做什么 | 命令 |
| --- | --- |
| 查找命令 | `npm run wf -- search 样张`（中英文关键词均可） |
| 查看一个命令的运行条件 | `npm run wf -- <命令> --help`（详细 JSON 含 run 元数据） |
| 生成品牌图标 | `npm run wf -- brand:build`（母版 `assets/brand-mark.svg` → 深浅字标、favicon、Windows ICO、安装器线条） |
| 文档迁移后检查链接 | `npm run wf -- docs:check`（含旧地址映射；不联网核验外部来源） |
| 查看一个分组 | `npm run wf -- reference` |
| 查看参数与依赖 | `npm run wf -- reference:design --help` |
| 预览即将执行的命令 | `npm run wf -- data:build --plan` |
| 检查入口是否失效 | `npm run wf -- audit:workflows --json` |
| 检查工作流行为回归 | `npm run wf -- check:workflows` |
| 检查维护脚本孤儿 | `npm run wf -- audit:orphans --check`（已纳入 check 与 CI，候选须人工复核） |
| 查看内容覆盖差额 | `npm run wf -- audit:coverage`（只读报告：热门服装→参考登记、角色→主题选择器；`--json` 机器可读；信息性，不作为门禁失败依据） |
| 开发前端 / 启动网关 | `npm run wf -- dev:web` / `npm run wf -- dev:server`（分别在两个终端运行） |
| 检查办公机工程入口 | `npm run wf -- office:health`（只检查目录与入口，不代替工具链验证） |
| 只读严格检查 TypeScript | `npm run wf -- check:typescript`（服务、网关、工具与独立浏览器脚本） |
| 验证构建和开发重启行为 | `npm run wf -- check:typescript-build`（中性隔离夹具） |
| 按当前改动验证 | `npm run wf -- gate:quick` |
| 跨域/构建链等全量验证 | `npm run wf -- gate:full` |
| 检查本机桌面打包能力 | `npm run wf -- desktop:doctor --json`（只检测，不安装） |
| 检查安装包网关资源完整性 | `npm run wf -- desktop:verify-gateway`（需要已暂存资源；隔离目录真实启动，打包前自动执行） |
| 生成本机测试安装包 | `npm run wf -- desktop:package-local`（跳过压缩，不安装） |

所有执行固定在项目根目录。Node/npm 参数保留空格，npm 自动补转发分隔符。复合步骤失败即停止；reference:full 由专用候选入口处理公共参数和人工审核待验状态。只读审计覆盖注册文件、npm 入口、文档存在性、复合依赖循环和 run 元数据合法性，不代表模型、账户、外部服务或桌面安装已经验收。

### 内容覆盖差额报告

`audit:coverage` 对照热门服装分片与参考索引（standards/view）、characters.json 与 `tokens.css` 主题选择器，输出差额清单：缺参考登记、登记未出图（pending）、URL 已填缺实图、无法核实（素材根缺失，与 `check:ref-urls` 同一解析）、参考库独有形态（来源需另行核对，不直接判为自动生成或可删除）；主题侧区分显式主题、默认主题允许项（nene）、待补与旧别名选择器（如 `historia_reiss` → 建议 `krista_lenz`，须人工确认）。结构错误（清单缺文件、跨分片重复 ID、manifest 批次数缺失/不符、standards↔view 镜像破坏）退出 1；覆盖差额只报告，恒退出 0——历史覆盖缺口是待办清单，不是门禁失败，也不授权自动登记或补图。

### 只读交付证据审计（W2 最小切片）

默认文字输出按错误、待验、通过分组，列出数量及每项文件/字段/原因；待验继续区分未知与未运行。显式文件、证据比较、HEAD/worktree、限制和未执行建议按已启用项呈现，完整标识与结构仍由 `--json` 提供。格式化层不改变状态、退出码、旧证据适配或文件边界，也不执行建议命令。

`--compare-evidence <root内相对JSON路径>` 可重复，与主 `--evidence` 独立比较，结果列入 `comparisons`（primary/other 的 files、ids、sharedIds、status、失败 message）。双方各解析最多一层 versioned evidence / delivery-receipt 关联；必须有完整最终 commit 和至少一个共有构建 SHA 字段，全部共有 ID 大小写归一后必须一致。识别 `build.*Sha256`（排除 source/snapshot/baseline）及 `browser.distIndexSha256BeforeAndAfter`（对应 build.distIndexSha256）。关联内明确标识冲突同样报错。缺失、格式不支持、坏 JSON、相对路径或真实路径越界进入 errors，退出 1。仅单边存在的构建字段保留在 ids；不自动合并机器、状态、安装或模型验收，比较 matched 不消除主证据 pending。可叠加 HEAD/worktree 与显式文件核验；未启用不读取第二文件，help/plan 不读取。示例：`node scripts/workflow.js audit:delivery --evidence office.json --compare-evidence main.json --json`。

`--check-worktree` 显式在 root 对应仓库执行 `git status --porcelain=v1 --untracked-files=all`，独立 `repositoryWorktree` 输出 root、status（clean/dirty/unavailable）、changedFiles、message 和成功读取的 rawPorcelain。未提交项标记 uncommitted，未跟踪项标记 untracked；每项保留 indexStatus/worktreeStatus、pathPorcelain 和 raw，路径使用 Git 原始转义表示（重命名保留原始箭头表达式）。dirty、非 Git、命令失败或不可解析均进入 errors、退出 1。设置 GIT_OPTIONAL_LOCKS=0，避免刷新索引写入；不查询远端、不清理文件。与 `--check-head`、文件核验独立叠加；HEAD 匹配不能证明工作树 clean。unborn 仓库按 status 实际输出判定，组合 HEAD 检查时无提交由 repositoryHead 报 unavailable。未启用不增加结果；help/plan 不执行 Git。clean 仅表示此次 status 未报告改动，不证明忽略文件、产物或验收有效性。

`node scripts/workflow.js audit:delivery --evidence <JSON路径> --json` 显式读取已有 schemaVersion 1 证据，或已有无版本 delivery-receipt（commit + evidence），并解析一层关联回执/证据。路径相对 `--root <隔离目录>`（默认仓库根）；绝对路径和真实路径均须留在 root 内。不会扫描“最新”报告、复制或改写证据。

`--require checks.fullGate` 可重复指定本次必要门禁的证据字段；默认识别 fullGate/gate/checks.fullGate/checks.gateFull，未发现则待验，不自动要求全量门禁。`--expect-commit <完整Git SHA>` 核对最终 commit；baseline/baseCommit 仅作基线。`--expect-build build.manifestSha256=<SHA256>` 可重复核对明确的构建字段，支持已有 build 中的 Sha256 字段及 browser.distIndexSha256BeforeAndAfter；不以日期、日志成功或源哈希冒充构建标识。跨机交接需显式传相同预期标识；不传时仅检查记录格式。

报告分 errors/passed/pending/limitations；pending 每项保留 unknown/unrun/pending。精确 pass/passed（大小写兼容）与布尔 passed 才识别为通过，失败计数/非零 exitCode 优先，跳过或 flaky 保持待验；数字通过数量和自由文本不推断成功。通过项需有 log/transcript/report/sha256 索引。执行范围取 scope，机器/运行时取 environment.platform/node；旧证据缺字段如实未知，不要求改写历史文件。安装、设备及模型验收分别检查 installation/deviceAcceptance/modelAcceptance 对象的同类状态与索引；已有 deferred/limitations 原样列出，deployment 同步和回执推送状态均不替代这些验收。

`--verify-file <相对root路径>` 可重复检查普通文件存在性；`--expect-file-sha256 <相对root路径=64位SHA256>` 可重复检查文件并计算本地 SHA-256（哈希大小写兼容），无需同时传 verify-file。所有显式文件必须使用 root 内相对路径，realpath 校验拒绝符号链接/junction 越界；目录不算文件。独立 `verifiedFiles` 按请求列出 exists/matched/missing/mismatch/outside-root/not-file/error，哈希项包含 expectedSha256 和成功读取后的 actualSha256。缺失、不匹配及其他核验错误进入 errors。未指定时 verifiedFiles 为空并保持原有判定；不自动扫描证据中的 log/report 字符串，不从源哈希、日期或文件名推断产物哈希。存在或匹配只证明所选文件的本地状态，不证明日志内容真实性。

`--check-head` 显式启用本地 Git 只读检查：在 `--root` 对应仓库执行 `git rev-parse --verify HEAD^{commit}`。独立 `repositoryHead` 输出 root、commit、evidenceCommit、status 和原因；比较解析回执后的最终 commit，匹配为 matched，旧提交为 mismatch，缺最终提交为 missing-commit，非 Git 仓库/无 HEAD/Git 不可用为 unavailable；后三者进入 errors、退出 1。baseline 不替代最终 commit。只比较 HEAD commit，不覆盖 dirty working tree，不验证未提交改动，不查询远端。未启用时不执行 Git、不增加该结果；与 `--expect-commit` 和显式文件核验独立叠加。

退出码 0 仅表示所选记录及显式检查通过；1 表示错误/失败/标识冲突；2 表示参数错误；3 表示仍有未知、未运行或待验。`--help` 与 `--plan` 不读取证据或核验目标文件，也不执行 Git；建议命令从注册表读取，只列出不执行。范围限制：不认证声明真实性、不自动选择当前构建、不自动推导源码变化导致的证据失效、不合并任意历史格式和续跑/回滚记录。主力机真实安装、模型与设备验收仍须实际执行并保留对应证据。

## 数据维护

| 操作 | 入口 | 注意事项 |
| --- | --- | --- |
| 场景分片聚合 | data:build | data/scenes → scenes.json |
| 热门角色聚合 | popular:build | data/popular → popular-characters.json |
| 蓝图聚合 | blueprints:build | 使用既有蓝图分片源，不直接改聚合产物 |
| 词条分片与字典 | tags:build / tags:check | 校验 manifest、重复词/别名决策和源路径；保留旧 ID，生成聚合与字典，失效旧压缩 |
| 聚合反向写回分片 | data:import / popular:import / blueprints:import | 覆盖写入操作，先核对 diff；popular:split/blueprints:split 只拆分 |
| 数据契约与版本 | data:validate | DATA_VERSION 哈希域以 scripts/lib/data-version.js 为唯一事实源 |
| 分类与规范化 | data:normalize | 会写数据，不用于只读文档审计；遵守定稿保护 |

详细文件职责见 [维护手册](maintenance.md#文件职责)。三个聚合构建脚本默认计算 DATA_VERSION，客户端由 Vite 的 `virtual:data-version` 在构建时注入，不再改写 `src/stores/sceneStore.ts`；`--check` 不写版本——产物缺失时自愈重建（fresh clone），齐全但与源不一致时报错退出 1。校验失败需定位来源，不能只改版本掩盖数据漂移。

核心精选 `personaCoreSceneIds`：保存时对显式数组稳定去重并剔除非活跃引用，显式非数组报错；旧请求漏字段时，保存链在基线核对后的锁内保留现存核心精选，显式 `[]` 才清空。纯清洗函数没有旧快照时保留缺省；不合并其他策展字段。主校验检查该字段的数组、非空字符串、重复及活跃引用，空数组/缺省兼容；既有首屏预算仍由分片测试负责，不新增核心精选必须属于 curated 的限制。`validate-scenes.js` 的分片和 data 元数据统一采用 `AICS_DATA_ROOT`、`AICS_APP_ROOT`、仓库根的优先级，隔离夹具不再混读生产元数据。

场景语义门禁复用工作台的镜头过滤和负向组装（scripts/lib/scene-render-contract.js），检索 tags 不冒充发送给模型的词条。`optimize-scenes --check` 检查持久化数据的实际编译结果；changed 表示可选的格式改写建议，不要求机械改写提示词。分级脚本只维护分级/使用元数据，不再改写 negative；任何提示词改写仍须独立真实出图和定稿保护验收。

## 参考库

评级诊断：`node scripts/maintenance/classify-scene-ratings.js --check --json`（`--explain` 同义）只读输出 totals、changedCount、changes 的 current/expected rating/mature/category/usage 及推导来源。sources 汇总 manual/policy/existing-mature/pinned；差异退出 1，参数或结构无效退出 2。诊断禁止与 `--write` 组合，不生成文件；默认人类汇总及正常 `--write` 路径保留。隔离测试通过 `AICS_DATA_ROOT` 定位夹具，入口为 `node scripts/tests/test-scene-rating-diagnostics.js`。

归属报告支持 `node scripts/workflow.js audit:ownership --domain scene-ratings --json`：人工表 `scripts/lib/manual-scene-ratings.js` 为源，`classify-scene-ratings.js` 为读取/派生入口，场景分片的 rating/mature/category/usage 为字段产物。这些字段不属于提示词正文；人工审核语义与真实画面仍未验证。人工表静态解析，缺失、未知值、重复键或缺值报告 missing/invalid，不执行表内代码。

归属报告的 readers/writers 是按已检查函数整理的静态说明，不执行列出的脚本，也不声称穷尽读写者。人物、热门身份、蓝图、参考与主题五域已补实际解析/写入入口；traits 不在详情解析输出中，但有提示词组装读取者，不能误写为无运行时使用。相关链路变更后应同步核对说明。

### 只读变更影响预览（D2 第一批）

显式 `--path data/curation.json` 在三层 ID 数组均合法时选择当前成员，独立输出 curation-source 关联/复验；`--path data/retired-scenes.json` 从合法 records.id 选择当前退役成员，输出 retired-source、retired-scene 关联/复验。每个所选场景沿用 curation/aggregate/retirement 状态检查。显式登记缺失、损坏或字段不完整时退出 1，不采用部分 ID；空登记及历史删除记录保持 unknown，缺少历史 diff 本身不列必改。`--git-diff` 复用同一路径处理。`data/scenes.json`、manifest 及其他历史路径仍不从当前聚合猜受影响 ID。

`--git-diff` 可单独使用或与 character/scene/path/showcase-manifest 组合：`node scripts/workflow.js audit:impact --git-diff --json`。仅启用时在 root 工作树根目录只读收集 HEAD 对比的 staged/unstaged 路径及未跟踪文件，独立 `gitChanges` 输出 status/raw/paths/reason。NUL 分隔避免引号、中文、空格和换行被拆分；关闭重命名检测以保留旧、新两端。路径复用既有分片/场景分析，主题及工作流路径列复验，未知路径仍为 unknown，不推断字段或历史内容语义。Git 不可用、命令失败、无 HEAD、root 非工作树根目录、编码或路径无法解析均退出 1，丢弃部分采集路径，保留 raw 和原因；显式输入仍独立处理。未启用、帮助及预览不执行 Git；不写索引、不查询远端。受忽略文件不纳入未跟踪集合。

`npm run wf -- audit:impact --character <canonical-id> --outfit <角色内服装id>` 查询热门源及关联蓝图/参考 view；省略 outfit 查询整位角色。`--path data/popular/<系列>.json` 可重复传入明确 Git 变更路径，不自动调用 Git；路径模式保守纳入整个分片，无法推断删除或字段差异。`--root <目录>` 指定隔离夹具。

`node scripts/workflow.js audit:impact --character <id> --json` 输出机器可读报告；`--help` 查看参数，`--plan` 仅预览命令，均无写入。报告的 mustChange 为已证明的结构问题/源聚合失配，revalidate 为需复验对象，related 仅表示关联，unknown 明示未解析边界。全域快照问题不归因于当前输入；源与聚合比较 JSON 内容，不检查字节格式。退出码 0 表示报告完成（可能仍有未知项），1 表示结构问题，2 表示输入错误。

默认文字输出按目标、必改/需复验/仅关联数量与定位原因排版，未知项和未执行建议命令独立显示；默认服装、参考状态、主题、场景和样张关系用短行呈现。推荐命令保留操作性质；空集合省略，长列表截断注明剩余数量和 `--json` 入口，完整结构与数值保持不变。

`--scene sc001` 查询单个场景；`--path data/scenes/<逻辑组>.json` 按当前 manifest 展开全部批次，`--path data/scenes/<逻辑组>.2.json` 只选择该实际批次。报告 scenes 列出源/逻辑组、数组聚合比较、curatedSceneIds/signatureSceneIds/personaCoreSceneIds 三层独立成员关系及退役登记。目标重复、聚合失配、悬空精选和活跃/退役冲突列为结构问题；无关场景的聚合内容不比较。源清单不完整、批次缺号/并存、未登记文件会明确报告；未知 ID、删除/重命名、manifest/聚合/元数据路径的历史影响列入 unknown，不从旧聚合猜测源归属。

角色/服装报告的独立 `themes` 数组按所选角色（包括路径展开的角色）列出 `id/file/canonical/themeStatus/reason`。只读解析 root 下 `src/assets/css/director/tokens.css` 的通用 data-character 契约，并结合 runtime `characterTheme.ts` 的数据/调校目录；注释和声明字符串不算选择器。运行时主题为 explicit，列入 related + revalidate；没有通用契约时才按旧版静态选择器与默认白名单判定。CSS/主题目录缺失、损坏或存在不支持的选择器语法为 unknown；仅当 `data/characters.json` 可证明 canonical 角色缺主题契约时为 missing，列 mustChange。主题契约不证明实际 CSS 层叠、配色与渲染。纯场景输入不展开角色主题。

角色/服装报告的独立 `outfitDefaults` 数组覆盖每个所选角色，输出 `id/status/defaultOutfit/defaultIds/isDefaultIds/reasons`。仅当全部服装的 `default` 与 `isDefault` 均为布尔值、集合一致且恰好一个默认项、默认 ID 非空且角色内唯一时为 explicit，`defaultOutfit` 为解析出的 ID；其余结果为 null。可证明的多默认/默认 ID 重复为 ambiguous、两字段冲突为 mismatch、默认 ID 缺失或完整双字段无默认项为 missing，逐条列 mustChange。字段缺失、非布尔、空列表或身份不唯一等无法证明的格式保持 unknown；不猜第一项。部分字段仍可证明的重复/冲突照常报告。省略 outfitId 的蓝图在 revalidate 原因中包含明确的默认 ID，否则同时保留 unknown；显式 outfit 过滤和引用检查不变。

`--showcase-manifest <root内相对路径>` 可重复（建议单个），例如 `node scripts/workflow.js audit:impact --scene sc001 --showcase-manifest reports/showcase.json --json`。独立 `showcase.manifests` 只读解析 JSON 的 entries 数组：显式 scene 匹配 entry.id，显式 character 匹配 entry.char 或 entry.type；路径输入不推断样张目标。匹配项列 related/revalidate，保留 index/id/type/char/rating/attempt、matchedBy 和 reviewPresent（provenance.review 字段是否存在，即使 null 也算存在），不输出 review 内容或图片路径。reviewPresent 不代表审核通过，不读取图片或执行生成/审核/发布。未提供时 unknown“样张清单在外部/未提供”；可读清单整体标记 partial，不证明完整覆盖。无匹配条目保持 unknown，不能列必改。显式文件缺失、非普通文件、JSON/entries 无效或真实路径越界时标记 error 并退出 1；参数中的绝对/越界路径退出 2。每个清单独立处理，坏清单不掩盖有效关联；所有清单均不证明缺失条目。帮助/预览不读取清单，不扫描外部目录。

推荐命令与操作性质来自工作流注册表，全部只列出、不执行；build 可能写数据产物，版本由 `virtual:data-version` 按产物内容解析，不能因出现在报告里就当作只读检查。本批不提供自动增量检查：全域聚合顺序、浏览器分片、样张完整性、DATA_VERSION、压缩产物、历史删除/重命名未覆盖。公共构建器/契约路径建议全量 data:validate；未知路径不宣称影响为空。全域主题与参考覆盖沿用 audit:coverage；真实编译/画面验收仍需后续对应机器执行。

1. `reference:register --dry-run` 对账待登记形态；核对后按需登记。
2. `reference:render --output <候选目录>` 生成四视角待审核候选；人工验收与发布仍须显式完成。`reference:design` 是独立的三视图设计图入口，行为不等同于候选生成器。
3. `reference:audit --force --keys <角色/服装/机位前缀>` 定向重审，`reference:repair` 修复。
4. `check:ref-urls` 与网关共用素材目录解析（AICS_CHARACTER_REF_ROOT → AI 工作区 → assets/character-references）。显式目录失效不会静默换库；pending 不等于真实资产，也不等于通过视觉审核。CLI 数据根为 `--root <完整项目根>` > AICS_DATA_ROOT > AICS_APP_ROOT > 仓库根，view 与审计 appRoot 对齐，显式外部素材配置保留；直接 `--help` / `--plan` 零目标读取。参数/根错误退出 2，缺失或损坏 view、审计问题退出 1。

`reference:audit` / `reference:repair` 仍用于旧活跃参考库的视觉检查/定向修复，不能用于新候选目录，也不能替代下面的人工决定。参考图片不入 Git；旧问题配方见 [历史参考审计](archive/audits/character-reference-audit-pending.md)。

### 参考库候选审核与版本发布

`reference:full --output <候选目录> --source <现有参考库目录> --target <新版本目录> [--root <项目根>]` 生成或续跑候选，再核对记录、实际 PNG 字节和生成时的源版本。缺少人工审核返回 3（pending）；结构通过不表示画面合格。`--dry-run` 仅规划生成，不写盘、不调用模型；工作流 `--plan` 连目标数据也不读取。

`reference:inspect --from <候选目录/reference-generation-manifest.json>` 输出最新候选的 key、recordId、图片 sha256、inputVersion 和完整性状态。将真实看过图片的决定写入候选目录内的 decisions.json：每个 key 对应 `{ "verdict": "pass", "recordId": "实际记录ID", "sha256": "实际图片哈希", "inputVersion": "实际输入版本", "reviewedAt": "实际审核时间ISO", "notes": "审核意见" }`，verdict 也可为 fail。调用 `reference:review --from <清单> --decisions <决定JSON> --out <候选目录/manual-review.json>`，只新建审核记录，拒绝覆盖。漏审保持 pending；源、图片、记录或重试版本变化后，旧决定失效。审核文件记录人工声明，不认证声明真实性。

`reference:publish --from <候选清单> --review <审核JSON> --source <现有库目录> --target <新目录> [--root <项目根>]` 默认只读预览。只有显式 `--apply` 且全部所选候选均具备当前有效人工通过决定时，才复制保留旧资源、加入批准图片及对应 view 投影，在完整核验后原子发布新目录。目标已存在且身份一致时幂等返回；不同内容拒绝覆盖。失败不改旧库或项目源索引，保留专用暂存供排查；进程中断后重试会回收已死亡进程的锁，活进程/未知锁拒绝抢占。断电持久性仍需设备验收。

新版本含 reference-release.json 和 character-reference-view.json，前者绑定所有图片、投影、源标准/view、候选和审核哈希。显式将网关参考库根配置为该版本并重启后，由版本解析器核验再同时提供图片和索引；损坏或源版本不匹配拒绝接入。回滚重新选用保留的旧目录。本入口不自动改配置、不安装、不将待审核图片写入活跃库。

`reference:full` 可附 `--review <审核JSON>`，或 `--decisions <决定JSON> --out <新审核JSON>` 走到发布预览；始终不自动 apply。需要重试画面时用 `reference:retry --output <原候选目录> --keys <reference:角色:服装:机位,...>`，沿用原配方生成新记录并重新人工审核，不继承旧通过状态。

旧参考库 URL 迁移使用 `reference:repair-urls --dry-run` 预览；核对后移除 `--dry-run` 才会修改文件并生成备份。日常断链检查仍用 `check:ref-urls`。

## 样张

| 操作 | 入口 |
| --- | --- |
| 热门/场景批量调度 | showcase:batch --source popular 或 --source scenes |
| 当前 MiaoMiao 批次 | showcase:batch-miaomiao |
| 指定独立场景 MiaoMiao v1.2 候选（不发布） | showcase:scene-candidates --ids sc001,sc002 --output <新候选目录> |
| 活跃 manifest 缺口补齐 | showcase:fill-gaps |
| 生成、审核、发布 | showcase:generate / showcase:audit / showcase:audit:scene / showcase:publish |
| 复合链路 | showcase:full（generate → audit → 发布预览） |
| 人工逐图联系表 | showcase:review-sheets --audit <候选审核目录>（Python + Pillow） |
| 汇总人工决定 | showcase:manual-review --manifest <生成清单> --decisions <决定文件> |
| 旧独立场景发布 | showcase:scene-publish --from <生成清单> --source <旧版本> --target <新版本>（默认预览） |
| 仅刷新分级清单 | showcase:rating-refresh --source <旧版本> --target <新版本>（默认预览） |

人工决定按 `{"scene:sc001":{"verdict":"pass","recordId":"实际看过的生成记录ID","notes":"审核意见"}}` 填写，`verdict` 可为 pass/fail。缺少决定的图片保持 pending；旧图的决定不会自动转给重试生成的新图。`--latest-attempt` 会拒绝非最新成功记录的决定。旧独立场景发布器仍要求完整人工审核清单，`--apply` 才会写新版本；历史固定模型实验已归入被忽略的 `scripts/archive/`，不作为日常维护入口。

候选生成必须传 `--output`，热门审核传 `--manifest` 和 `--out`，场景审核传 `--manifest`，发布传 `--from`、`--source` 和 `--target`，避免底层历史脚本选中旧批次。source 填实际现有版本，target 填新版本。

热门候选生成默认采用 MiaoMiao v1.2 与 TeaCache 0.08 加速；`--no-tea-cache` 可关闭加速，`--model anima-miaomiao-v1.6` 可显式指定另一 MiaoMiao 版本。`--keys` 格式为 `popular:<角色id>:<蓝图id>`。续跑仅复用模型、提示词、画幅和采样参数全部一致的成功记录，换底模或精修场景会重新生成；不同底模建议使用独立候选目录。

`npm run wf -- showcase:full --output "E:/候选目录/本轮" --source <现有版本> --target <新版本> --plan` 可先检查链路；去掉 --plan 后会生成并审核，最后只预览发布。三步共用同一份 generation-manifest.json 和 audit-results.json。审核后用 `showcase:publish --from <该manifest> --source <现有版本> --target <新版本> --apply` 实际写入发布目录。该旧发布器并不自动切换网关配置，发布后还需按样张工艺检查活跃目录。旧参数与实测方法见 [样张工艺记录](archive/troubleshooting/showcase-generation-craft.md)，当前 checkpoint 以脚本/网关配置为准。

## 角色接入

`character:onboard --character <id>` 为自动化辅助；`--skip-render` 跳过出图，不能据此声明资产完成；`--deploy` 涉及桌面同步。必须同时核对 [六层契约](engineering-contracts.md#角色接入) 和 [接入步骤](guides/characters/character-onboarding-workflow.md)。

`audit:impact` 的 `referenceEvidence` 按所选角色/服装统计参考 view 的显式 references：total、pendingCount（pending=true 或缺非空 URL）、urlDeclaredCount、reviewDeclaredCount。pending 优先于 declared-unverified；空数组为 empty，缺角色/服装/references 为 missing，坏或缺 view 为 unknown，未知计数为 null。reviewStatus 仅区分字段声明与 unknown，assetStatus 始终 unverified。显式 outfit 仅过滤对应 character，路径带入其他角色保留全部服装。保留 reference 关联与复验；不访问 URL、图片或素材根，不把声明当成资产或审核通过。

## 内容归属只读报告

### 历史影响的实际检查与候选证据

`check:impact --base <本地commit/ref> --execute --json` 根据旧新源关系选择实际执行的只读检查；不带 execute 只预览，help/plan 零目标读取。只有可证明身份、关系、清单和顺序不变的受支持场景/蓝图记录字段变化才走 incremental；删除、重命名、未知路径、公共实现或不完整关系回退 full。`--full --execute` 无需 Git 即可检查七个已支持结构域。它复用现有解析器、参考 schema、内容纯函数和源/产物对照，不运行可能自愈写入的 builder。

输出分别记录 selection、execution.executed、逐检查状态及未知字段。局部或已支持完整结构域通过均不等于完整内容 gate：DATA_VERSION、压缩伴生物与未导出的语义规则仍保留完整门禁要求，退出 3；实际失败退出 1，参数错误退出 2，预览退出 0。读到文件或目录成员变化时返回 incomplete，不能用混合快照认证通过。`audit:ownership` 的 fieldValidation/readWriteCoverage 只说明规则与覆盖，不代表已执行这些检查。

`audit:content-evidence --root <源根> --candidate-root <候选根> --manifest <候选根相对清单> --source <源根相对源文件> --recipe <源根相对生成器> [--decisions <候选根相对审核JSON>] --json` 只读取明确允许的输入、原生候选账本和资产。source 可重复；旧机器路径不自动重定位。它分开报告结构、生成状态、源/请求/输入版本、实际文件字节、审核绑定和发布证据；源、图片或记录变化使旧审核 stale，遗漏新 attempt 或损坏字节不会被历史 pass 掩盖。

人工审核接受 reference-human-review 或 content-human-review 的版本化记录，绑定 runId、manifestSha256 及逐条 recordId/recordSha256/sha256/inputVersion/reviewedAt；缺决定保持 pending，匹配仅证明声明绑定，不证明审核者实际看过画面。额外 `--publication <候选根相对回执> --published-root <明确目录>` 可核对 content-publication-evidence 回执及对应发布字节；专用 reference-release 由参考版本解析器核验，不冒充格式兼容。退出 0 仅表示所选明确证据匹配，1 为失败，2 为参数错误，3 为未知/过期/待验。入口从不生成、审核画面、修改清单、复制资产或激活资源。

`node scripts/workflow.js audit:ownership --json` 读取当前根目录结构，报告人物档案、热门身份/服装、场景、蓝图、精选、退役、参考标准/view、主题及外部样张的字段职责、读取者、写入边界和机器条件。`--root <隔离目录>` 可替换数据根；`--domain <characters|popular|scenes|blueprints|curation|retired|references|themes|showcase>` 仅检查指定域。

entries 的 role 保留 source/product 职责；status 为 source/product/missing/invalid/external-unknown。manifest 按当前 files 结构解析；场景按 .1 起连续批次优先，否则读取逻辑单文件。检查真实路径边界、JSON 及浅层容器，输出实际字段名；不证明完整 schema、源产物一致性、字段语义、审核或图片质量。参考 view 是合并投影且登记器也会写入；外部样张固定 external-unknown，不扫描外部清单或图片。

写入入口仅展示，不执行 builders（包括可能自愈写入的 --check）、模型或网络。`--help` / `--plan` 不读取目标目录；退出码 0 表示读取完成（允许 external-unknown），1 表示有 missing/invalid，2 表示参数或根目录错误。隔离回归：`node scripts/tests/test-content-ownership.js`。

## 本地资源清单生成与校验

`node scripts/workflow.js audit:resource-manifest [--root <目录>]` 默认只读生成 `root/assets` 普通文件的清单 JSON（stdout）：每条含 root 相对 posix 路径、字节数、SHA-256，路径按码元顺序稳定排序；`generatedAt` 仅信息性，不作为内容版本；首版以路径标识文件，不声称跨重命名身份稳定。`assets/character-references` 外部参考域整棵排除；不进入外部挂载、runtime 或用户作品目录；扫描根自身为符号链接/junction 时拒绝扫描；目录遍历不跟随符号链接/junction，非普通文件、目录不可读和无法合规表示的文件名（如含编码分隔符形态）单列 `unverified`，不伪造完整覆盖。

`--manifest <root内JSON>` 切换为校验（清单须位于 root 内）：检查重复路径、非法/越界路径、文件缺失、字节数或哈希不匹配。清单路径按字面文件路径处理，不做 URL 解码；含百分号转义时做单字节解码核对，解码引入分隔符、盘符、控制字符或改变段结构（编码反斜杠、编码穿越）先于任何文件访问被拒；条目在 stat/读取前先做真实路径边界检查，junction/symlink 指向 root 外即拒绝，目标缺失时沿最近存在祖先解析，不以「目标不存在」跳过边界。校验按 Windows 大小写语义检查重复路径与排除域，并核对真实目标仍在 assets 允许域中；清单含非空 unverified 时保留已列条目的核验数量，但整体结果失败（退出 1）。校验只核对已列条目，不发现未登记文件，不做隐式修复、删除或上传，不做任意 URL 抓取或全盘发现。清单保存由调用者显式重定向到自己的输出目录，本入口零写入。

`--manifest <旧JSON> --compare-manifest <新JSON>`（两份均须位于 root 内）切换为差异比较：先对两份清单做与校验一致的结构检查（schemaVersion、条目形态、重复与 Windows 大小写重复、路径合规），再按精确路径输出新增、移除、内容改变与未改变数量。结果顺序稳定；`changed` 携带前后 `bytes`/`sha256`，`added`/`removed` 保留对应条目；`old→new` 由参数顺序决定，不用 `generatedAt` 判定新旧，不按相同哈希猜测重命名。比较只读取这两份指定清单，不读取/哈希实际 `assets`，旧清单已移除的文件不因当前磁盘缺失而无法比较；除非空 `unverified` 外的任何结构错误都会阻止差异计算。非空 `unverified` 时仍列出已列条目差异，但整体失败：`identical` 只表示两份清单已列条目的集合与记录内容一致，`ok` 且 `identical` 同时为真才构成一致结论，且这仍不证明目录覆盖完整、当前文件存在、内容已审核或已交付。存在差异本身不算比较失败（退出 0）。

退出码：0 表示生成无未核验项、校验全部通过或比较有效完成（比较含结构错误/非空 unverified 时为 1，参数非法或 `--compare-manifest` 缺少 `--manifest` 为 2）；1 表示目标内容有问题（生成含未核验项、校验错误、清单格式错误或不支持的 schemaVersion）；2 表示参数或环境问题（参数非法、root/扫描根不可用、manifest 路径越界或不可读）。`--help` / `--plan` 不读取目标文件、不计算哈希。哈希相等只证明字节一致；文件存在不代表内容已交付、图片质量或审核通过，清单不代表可信发布源。隔离回归：`node scripts/tests/test-resource-manifest.js`（已登记 unit 套件）。

筛选覆盖报告可使用 `audit:coverage --character <规范ID> [--outfit <角色内ID>]`。outfit 必须与 character 同用，未知 ID 或缺参数退出 2。参考条目和计数按所选范围重算，JSON 增加 scope；全域结构错误仍保留，可能来自未选对象。素材存在性仅核对所选角色/服装的参考；不影响无筛选参数时的全库输出和退出码。

## 离线资源候选包暂存导出

当前 `--apply` 仅支持 Windows，其他平台拒绝写入、仍可预览。原因是普通目录 rename 在 POSIX 可覆盖并发出现的空目录；Windows 隔离回归已验证该冲突会拒绝。工具面向受控本地目录，不承诺抵御其他进程持续恶意替换路径的绝对事务隔离。

`node scripts/workflow.js resource:pack --manifest <root内JSON> --name <包名> [--base-manifest <root内旧JSON>] [--root <目录>] [--apply]` 是 R1 之后的受控复制工具，不是安装器、下载器或发布入口。默认只预览复制计划（stdout JSON：目标路径、条目、字节合计与核验摘要），零写入；但预览会读取清单并对源文件做与 `audit:resource-manifest` 同套的核验（读取不是零读取）。`--help` / `--plan` 仅打印用法，不读取目标文件。

显式 `--apply` 才实际复制：先复用现有清单核验，重复路径、非法/越界路径（含编码分隔符）、排除域（`assets/character-references`）、非空 unverified、文件缺失、字节或哈希不匹配任一失败即整体拒绝；通过后把清单已列普通文件复制到 `<root>/scripts/archive/resource-packs/<包名>/` 新目录，保留 `assets/...` 相对结构，不遍历补入未列文件，并写入可被 `audit:resource-manifest --root <包目录> --manifest manifest.json` 再次核验的 `manifest.json`。复制先写入本次专用暂存目录 `.staging-<包名>-<随机>`，逐条读回核验候选副本的字节与 SHA-256（复制时源已变化会被发现并终止），整体复核通过后才改名为最终包名，再做发布后核验；核验通过只输出「候选包已通过字节核验」，不代表图片质量、内容审核或部署完成。

`--base-manifest <root内旧JSON>`（与 `--manifest <新JSON>` 同用，缺 `--manifest` 退出 2）切换为增量候选包：复用 `audit:resource-manifest` 的纯比较，只把 added/changed 项写入候选，`unchanged` 不进候选文件，`removed` 仅作为差异记录，不删除任何源/目标资源。旧清单只做结构核验（schemaVersion、条目形态、重复、路径合规），不读取其对应的磁盘资产（removed 文件可已不存在）；新清单仍按全包同套完整核验，不能用增量绕过新清单损坏；任一清单结构错误或非空 unverified 即整体拒绝。候选 `manifest.json` 只列实际复制的 added/changed 项，可被现有 verifier 再次核验；另写 `delta.json` 记录旧/新清单内容身份（按稳定 path/bytes/sha256 计算的 contentIdentity，不含 `generatedAt`）、四类数量与移除路径，供以后基线匹配用；两个元数据都在最终改名前读回核对。增量产物不是完整可安装包，也不能当作已安装更新；零差异时输出明确的零资产候选（无 assets 目录）。复制/暂存/发布协议、目标冲突与 junction 拒绝与全包模式相同。

安全边界：包名限字母、数字、下划线、短横线（1-64 字符），拒绝路径片段；目标只要已存在（含空目录、文件或链接）即拒绝，不覆盖任何旧包；目标祖先链中已存在的符号链接/junction（realpath 与字面路径不一致）先于任何写入被拒；复制期间源变化、候选写入失败或发布冲突都不报告成功，暂存目录保留并在结果中给出明确路径（残缺暂存不是可用候选包），不删除任何目录。不转换或重采样图片，不执行复制内容，无 ZIP 解压/安装/缓存淘汰与网络行为，写入范围限 `--root` 内候选目录。

退出码：0 表示预览计划可行或候选包已通过字节核验并落盘；1 表示目标或内容问题（清单核验失败/格式错误/不支持版本、目标已存在、目标链含链接、复制或发布后核验失败；增量模式含任一清单结构错误或非空 unverified）；2 表示参数或环境问题（包名非法、参数缺失或无法识别、root 不可用、清单路径越界或不可读）。隔离回归：`node scripts/tests/test-resource-pack.js` 与 `node scripts/tests/test-resource-pack-delta.js`（已登记 unit 套件，全部夹具位于临时目录，不导出真实素材）。

## 增量候选包与基线兼容核验

`node scripts/workflow.js resource:verify-delta --base-manifest <root内JSON> --pack <root内候选目录> [--root <目录>]` 只读核验 G13 增量候选包与给定基线的兼容性，全程零写入、无安装/删除/网络；`--help` / `--plan` 仅打印用法，不读取目标文件。本入口仅核验增量候选：候选包内缺少 `delta.json` 的全包按 `missing-delta-json` 拒绝，不能冒充增量。核验通过只表示「相对于给定基线可重建声明目标且候选已列字节匹配」，不是数字签名、可信来源、当前安装状态或质量验收；空候选与仅删除候选可合法通过，不代表已安装更新。

核验分两层。元数据兼容层（纯函数）：先复用 `audit:resource-manifest` 同套结构检查（schemaVersion、条目形态、重复与 Windows 大小写重复、路径合规、非空 unverified），再核对 `delta.json` 的 kind/schemaVersion 与身份/数量字段形态；验证基线 `contentIdentity`/`entryCount`/`totalBytes` 与 `delta.baseManifest` 相符；以基线移除 `delta.removed` 后叠加候选 added/changed 重建目标条目，其身份三项必须与 `delta.newManifest` 相符；按基线→目标的实际集合关系重算 added/removed/changed/unchanged，与 `delta.totals` 逐项一致，且 `delta.candidate` 的 files/bytes/zeroAssets 与候选 manifest 实际条目一致。不只对比总数：removed 每项必须确实存在于基线且 bytes/sha256 相符，路径唯一且不得同时出现在候选中；候选与基线同路径同内容的条目不能冒充 changed。IO 层：只读取明确指定的基线 JSON、候选 `manifest.json`/`delta.json` 与候选已列资源（复用现有清单核验逐条核验候选实际字节）；不 stat/read 基线资产、不扫描安装目录，基线文件可已不存在而元数据仍可核验；基线清单、候选目录与内部路径遵守 root 与真实路径边界，junction 或坏路径访问外部目录在读取前拒绝。

退出码：0 核验通过；1 内容/不兼容（元数据缺失/损坏/不支持版本、清单结构错误或非空 unverified、基线或重建目标身份/数量失配、totals/candidate 与实际不符、候选实际字节核验失败）；2 参数/越界/环境（参数缺失或无法识别、root 不可用、基线清单越界/缺失/不可读、候选目录越界/缺失/不是目录/junction 逃逸、内部异常）。隔离回归：`node scripts/tests/test-resource-pack-verify.js`（已登记 unit 套件，候选包由 G13 导出器在临时夹具内生成，记录型 fs 证明旧资产零访问与全程零写入）。

## 办公机工程阶段入口（2026-09-15）

本阶段衔接后端、场景管理界面、资源服务及维护工具；工程验证在办公机隔离环境执行，真实模型、资产质量和主力机安装/设备验收分别留存。

场景维护使用 `/api/maintenance/scenes/preview`、`/changes` 与独立 `/import`；旧 `/scenes` 全量请求保持兼容。预览与变更集接收 `{baseVersion, changeSet:{version:1, scenes:{upsert:[],remove:[]}, blueprints?, tags?, curation?}}`。upsert 是完整记录，未知字段保留，remove 只能列现有 ID，旧基线返回 409。普通界面保存仅提交实际变更，完整导入单独确认；读取和保存使用同一完整快照及基线，冲突保留草稿，在途编辑不被旧回执覆盖。预览显示新增、修改、退役、相关引用及未知检查范围，不冒充真实画面验收。前后端均支持 sc1000+ 规范安全整数，已退役 ID 不复用；安装版源库写入仍返回 501。

保存同步场景/蓝图源分片、聚合、现有压缩伴生文件并重新计算 DATA_VERSION；客户端版本由 `virtual:data-version` 注入，不写回 `sceneStore.ts`。进程内队列结合持久化跨进程 lease/journal 和精确文件备份；活进程或未能证明已退出的进程不被抢锁。保存中或存在未恢复事务时，受保护内容读取拒绝返回半写状态。`/api/maintenance/recovery-status` 是本机只读状态入口；损坏元数据不会被自动清除。实际断电和文件系统持久性仍需设备验收。

`maintenance:recover --root <项目根> [--runtime-root <运行目录>] [--showcase-root <可信样张根>]` 默认只读预览，恢复计划输出 stdout。保存该 JSON 后，显式 `--apply --recovery-plan <保存的预览JSON>` 才恢复；执行时重新核对签名、根身份、备份/当前字节、PID 与事务 nonce。`--plan` 是工作流保留的零执行预览，不能用来传恢复文件；`--help` 与裸 `--plan` 均不读取目标。活进程、未知状态、损坏 journal 或漂移计划拒绝恢复，失败保留精确回滚记录。退出 0 为可用预览或恢复成功，1 为阻塞/冲突/失败，2 为参数错误。

`audit:impact --base <本地commit/ref>` 对照历史与当前源/产物，保留删除、重命名、旧新角色/服装关系和字节证据；`audit:ownership --consistency` 核对热门角色、蓝图、场景分组/core/index 与已覆盖参考字段镜像。未知约束明确保留，增量报告仅生成计划，不执行命令；不能将局部相等视为全库通过。impact 参数错误退出 2、已证明问题退出 1；ownership 显式一致性检查的 unknown/mismatch 退出 1。

`capture:delivery` 先用 `--scope`、可重复的 `--source-file`/`--source-tree`、`--build-file`/`--build-tree` 捕获执行前身份；执行检查后用 `--baseline` 与 `--record` 绑定实际结果及日志。结果 JSON 须携带执行前证据的 `baselineSha256`，不能将生成记录当作执行门禁。`--save runtime/delivery-evidence/<新文件>.json` 显式创建文件并拒绝覆盖，默认仅输出 JSON。`--finalize-commit <完整SHA>` 可将已测的相同源码/构建关联到最终提交，保留原执行 HEAD；`--machine main` 接收办公机证据不消除安装、设备、模型的 pending。

`audit:delivery` 自动重算 tracking 中的明确选择项与日志；受影响通过项失效为 stale，旧无 tracking 通过项保持 unknown，范围外文档不使代码检查过期。退出码为 0=所选记录核验通过、1=错误/陈旧、2=参数错误、3=未知/未运行/待验；仅认证选定字节关系，不认证日志语义或真实设备。

资源生命周期入口共用 `--config <可信本地JSON>`：`resource:install`、`resource:download` 另需 `--release <已配置ID>`；`resource:recover`、`resource:rollback` 复用已登记事务/旧版本。四者默认预览，显式 `--apply` 才写入；下载仅存候选，不自动安装。配置包含已存在的 userDataRoot、应用/作品 protectedRoots、独立审核的来源与发布 policy，固定使用 userDataRoot 下 resource-library-v1。支持完整/增量包、哈希核对、取消、已知事务恢复和旧版保留；不提供默认托管，不以哈希相同代替来源批准，不执行包中代码。

`resource:installed` 核对实际安装字节、pending 与旧版健康，会短暂获取并释放专用锁，不能描述为零写入审计。Ctrl+C 请求取消；CLI 参数问题退出 2、内容/操作失败退出 1、取消退出 130。网关已接入只读启动解析与控制室“离线资源库”面板；没有安装、配置未知或资源失效时使用随包基础资源，不自动下载、修复或放宽访问。

### 资源库的本机接入

启动环境中的 `AICS_RESOURCE_CONFIG=<可信本地JSON绝对路径>` 显式选择资源配置；`AICS_RESOURCE_MANAGEMENT=trusted` 独立允许本机管理。HTTP 请求和普通应用设置不能选择文件、授予权限或审批来源。配置沿用上面的 userDataRoot/protectedRoots/policy，并额外保护应用、资源、作品输出和参考库根。配置字节变化立即撤销当前操作授权，需重新检查后再操作。未配置时基础页面仍可运行。

`GET /api/resources/status[?refresh=1]` 返回已批准版本、安装状态、任务和恢复提示，不新建资源库；`POST /api/resources/tasks` 只接受 `{action, releaseId?}`，action 为 import/download/recover/rollback，版本仅从本地已批准策略中选择。`POST /api/resources/tasks/<id>/cancel` 取消在途操作。所有管理接口沿用本机来源、Host 与转发检查；状态不暴露本地配置或磁盘绝对路径。下载不自动安装，页面打开不触发下载，响应丢失后只查询状态而不重复写入。

任务回执保存在专用资源库，重启将未完成任务显示为 interrupted；恢复按钮使用原操作和已验证暂存，旧版本保留可回退。已安装允许清单中的媒体覆盖对应本机资源路径，每次返回前复核字节；Live2D 按完整模型依赖组采用或整组回退，避免新模型混用旧纹理。配置/版本/字节损坏时回退随包基础资源。远程资源服务仍沿用原有分级与访问边界，不挂载本机扩展库。

桌面暂存入口支持 `AICS_DESKTOP_RESOURCE_PROFILE=full|base`，默认 full 保持既有资产字节。base 只在 stageResources 新建并复制的隔离暂存目录缩小符合条件的热门立绘，保留原 URL、缩略图、品牌、占位与完整 Live2D；原资产和已安装程序不修改。内部 desktop-resource-profile 子步骤不作为独立安装入口。输出 resource-layers.json 记录随包/原始/可选字节与首次必要下载量；夹具压缩结果不代表真实包体或画质收益。正式安装仍只用 deploy-desktop.bat，并按主力机实际资源验收。

`reference:render`、`showcase:batch-miaomiao`、`showcase:fill-gaps` 经工作流调用均需 `--output <隔离候选目录>`，包括预览；底层直接脚本的 dry-run 可省略 output。网关优先级为 `--gateway > GATEWAY_URL > BASE > AICS_COMMS_BASE > http://127.0.0.1:3000`。候选 review 始终 pending；已知 job 恢复，响应丢失的未知提交需核对后显式 `--retry-unknown`。参考库 full 使用上面的独立人工审核与发布预览；真实模型/画面及激活验收按对应机器执行。

## 门禁与构建

内容契约 CLI（`check:content` / `test:content`）支持 `AICS_DATA_ROOT || AICS_APP_ROOT || 仓库根`。该根须提供完整 data/assets/src/stores 布局；数据、压缩产物和 DATA_VERSION 核对均使用所选根，缺文件失败，不回退到仓库数据。校验规则代码仍从代码仓库加载；显式外部素材路径配置仍生效。隔离回归 `test-content-contract-root.js` 验证根优先级、损坏定位、零写入及不读取仓库数据域。

按影响面选验证，不按“改了代码”或“准备提交”一律升级：

| 本次改动 | 验证边界 |
| --- | --- |
| 文档、AGENTS、skill | 结构、链接、规则一致性及典型请求走查；不构建、不出图 |
| 局部颜色、间距等样式 | 相关样式/对比度检查和受影响组件的双主题视觉检查；不默认跑 TypeScript、后端契约或全站回归 |
| UI 行为或局部业务逻辑 | 定向行为测试，或显式选择 `gate:quick ui/server/data`；补受影响的浏览器流程 |
| 依赖、配置、工作流、跨域重构、未知影响面，或用户明确要求 | `gate:full`，再按风险补浏览器/设备验收 |

构建用于验证产物或准备同步，不能代替视觉/设备验收。同一内容的检查不因提交而重跑；后续修复只重跑受影响范围。已核对隔离与权限边界的测试可直接执行和修复，无需逐步请求批准。

`gate:quick` 自动分类是保守兜底，测试文件/脚本路径会触发 full；已明确影响范围时可使用显式面积或定向入口。工具帮助中的“提交前”描述不表示所有提交都必须运行全量。本节规定选择原则，不改变脚本的实际分类行为。

### 验证并发与复用

`test-interrogate-engine` 默认只在临时空目录验证无模型降级，并屏蔽模型目录环境变量；`test-interrogate-routes` 始终用 WD14 替身和本地 HTTP 夹具。只有显式设置 `AICS_TEST_REAL_WD14=1` 再运行 `node scripts/tests/test-interrogate-engine.js`，才会查找本机权重并执行真实 CPU 推理；该开关不属于普通 unit/contract/full 门禁的默认验收。

`test:contract` 和 `gate:full` 共用契约执行器。`CONTRACT_TEST_JOBS` 默认 2，有效范围 1–4；只有 `scripts/tests/contract-test-policy.ts` 已记录临时目录、独立进程和动态端口边界的文件进入并行批次，较慢文件先启动。该批次结束后，其余文件按原顺序串行；新测试默认串行，修改已有夹具的隔离边界时须重新复核登记。设 `CONTRACT_TEST_JOBS=1` 可按完整原顺序执行，便于对照或低内存机器排障。

失败时停止派发新测试，等待已启动的夹具结束；`--all` 继续执行全部文件。超时、信号、输出超限与启动失败均为失败，未执行项单独计数。中断或超时只终止执行器自己启动的进程树。并行契约的 `--verbose` 按文件完成后输出整块日志，避免混杂。单文件时限与单测已有并发不变，目录准备和真实断言没有省略。

生产构建的预压使用 `PRECOMPRESS_JOBS`（默认 2，范围 1–4）限制同时处理的文件数，继续使用 Brotli 11 / gzip 9，不缓存测试 PASS、不依赖文件时间戳跳过压缩，也不放宽包体预算。同步 `compress()` 接口保持兼容，`precompress --check` 仍只读核对源字节、孤儿与陈旧产物。

同一批内容已有通过证据时，后续局部修复只重跑受影响项；准备提交本身不要求再次构建。这里优化的是执行开销，完整门禁仍覆盖相同测试清单。前后对照和实际验证记录见 [验证性能优化](research/engineering/validation-performance-2026-09-19.md)。

| 入口 | 实际范围 |
| --- | --- |
| gate:quick ui/server/data/all | 按变更面积分层；默认检测 Git 改动；脚本、依赖、配置及未知代码路径升级 full；纯文档跳过 |
| check:quick | npm run check 的全部已注册并行检查 |
| check:full | npm run validate：check + frontend + unit + contract；包含 check 内的 typecheck:app，不包含 build |
| gate:full | npm run check（内含 typecheck:app/typecheck）+ vitest + unit + contract + build，全量入口 |
| build:web / build:runtime | 前端与预算/预压；服务、网关、维护/测试及独立浏览器脚本的严格检查与编译 |
| check:style-debt | 样式字面值、颜色、动画和双主题全局/角色令牌对比度；动态组件另做视觉验收 |
| check:monolith / check:pinned-scenes / check:rewrite | 体量、定稿与改写完整性；rewrite 交付需传 --delivery，基线经本地 Git 读取（默认 b1ccfc0，--baseline 可改） |
| check:domain-types | 指定公共作品/生成类型、结果快照及保存用例的可达依赖；复用 AST/真实路径/别名/再导出/Vue 脚本解析；禁止直连具体存储/API/Node 平台；类型边单列，违规、未知路径和运行候选循环阻断 |
| check:popular / check:anima-routes / check:frontend | 热门、Anima 接口与前端单测 |
| test:contract / test:e2e:critical | 契约套件与关键浏览器回归；test:e2e:critical 工作流走无 build 的 `test:e2e:critical:run` 入口，复用已有构建产物（npm 脚本 `test:e2e:critical` 才先 build） |
| test:e2e:performance | 已构建产物的单 worker 冷／热进入与首次操作测量；与回归分开执行 |

质量套件可设置 AICS_TEST_REPORT_DIR 为隔离日志目录，保存逐文件状态、失败分类、超时、耗时和 Node 跳过数量；原有单项命令与 fail-fast/--all 语义不变。JSON 与日志按 [报告契约](guides/engineering/maintainability-boundaries.md#测试职责与报告) 接入 capture:delivery；报告不是已执行门禁的替代品。Quality 仍独立构建各 lane，并新增 Node 22.18 的锁定安装、构建和网关烟雾检查。

关键浏览器回归包含 `ui-layout.spec.ts` 的双主题/多尺寸布局与可读性检查。独立 UI 预览可用 `AICS_UI_AUDIT_URL` 指向隔离服务；默认检查本机 3000，不依赖 networkidle 等待长轮询停止。

`github-reference.spec.ts` 已加入关键回归：统一词条、固定种子候选、配方兼容检查和 PhotoSwipe 试验。图库使用中性本地图片夹具，双主题各 20 次开关；DOM/Blob URL 趋势保留在 `runtime/github-reference/`，双指采用 CDP 模拟，不代表真实模型、实体触屏或 GPU 内存验收。

资源故障与恢复的定向用例在 `tests/e2e/resource-recovery.spec.ts`：角色列表头像、场景卡片、参考卡片与画册灯箱，共四种流程的深浅主题检查。使用本地响应夹具，确认故障请求命中并验证恢复后的图片加载。可运行 `node node_modules/@playwright/test/cli.js test tests/e2e/resource-recovery.spec.ts --project desktop --workers 1`；需要已有 dist，设置独立 AICS_E2E_PORT_OFFSET 可隔离服务端口与运行目录。该文件由默认 e2e 发现，未加入显式 critical 清单；不代表参考灯箱、Live2D 或全部离线资源验收。

首页英雄图/热门横条回退见 `home-image-recovery.spec.ts`，角色详情主图/缩略图失败及恢复见 `character-detail-recovery.spec.ts`；`image-fallback-visual.spec.ts` 覆盖两处新增文字 AA 对比度、标签避让与普通桌面/2560×1440 DPR1.5/390×844 窄屏的双主题截图。它们沿用上述 Playwright 定向入口，默认 e2e 可发现，未加入显式 critical 清单。DPR1.5 是浏览器等效视口，不替代主力机 Windows DPI/WebView2 验收；装饰遮罩与实际图像叠字仍需查看截图。

`illustration-recovery.spec.ts` 补充场景手帖两角色图片失败/切换/恢复与 404 页插图回退、返回导航；内含双主题及 1440/768/390 宽度的占位/台词避让和 AA 检查。404 插图的固定 src 会被构建成带哈希的资源地址，拦截测试须兼容实际打包路径，不能只核对源码 URL。

`workbench-loading.spec.ts` 检查生产构建的实际脚本请求：未打开的素材分类、专家面板和结果弹窗应保持未加载；首次打开后切换分类不丢搜索或草稿。覆盖场景／专家模式与深浅主题，防止只拆分文件却仍在首屏请求全部分片。

`office-code.spec.ts` 同属关键浏览器入口，覆盖文档安全策略、存储受限导航、键盘出图入册、按需对比面板及脱敏诊断下载；麦克风策略使用浏览器模拟设备与真实响应头，不读取操作员麦克风。`library-concurrency.spec.ts` 使用真实双页 IndexedDB/Web Locks，验证并发入册、收藏、软删恢复、备份合并与失败重试；页面壳是隔离夹具，仓储源码和存储未替换。`office-performance.bench.ts` 经独立性能入口执行，记录本机 runtime 下的冷／热进入与首次操作耗时，不与浏览器回归争抢资源。生成链路使用模拟上游，不代表真实模型或桌面安装验收。

`npm run wf -- desktop:storage-benchmark` 独立运行桌面持久化候选比较：使用 Node 内置 `node:sqlite`、已安装 Playwright 浏览器（可设 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`）和临时目录，输出 JSON 后清理夹具，不连接生产网关、不打开真实浏览器资料。比较 1,000/10,000 条作品索引及 64 对原图/缩略图，各三轮；耗时不设 CI 阈值，运行时不要并发构建或浏览器测试。方法限制和推荐结论见 [计划 005](../plans/005-desktop-architecture-consolidation.md)。迁移/任务日志故障注入原型已登记 unit 套件，均不接入生产运行时。

`flows`、`anima-quick`、`office-code` 共用模拟上游，统一在 `flows` 项目的单 worker 中运行；其他页面和设备回归仍可并行。多会话验收时给每轮设置不同的 `AICS_E2E_PORT_OFFSET`（例如 `15000`），网关、浏览器和模拟上游按同一映射偏移端口，并使用隔离运行目录、拒绝复用已有服务。浏览器测试期间不得重建共享 dist；先完成构建再验收，并用独立 `--output` 目录保留每轮证据。

无参考素材的办公机可沿用 CI 的 `AICS_REFERENCE_AUDIT_MODE=structure` 执行结构校验；报告必须注明该模式，不能据此声明参考 URL 或图片验收通过。主力机不设置该变量，继续核对实际素材文件。2026-09-09 的工程治理历史见[当时记录](archive/audits/engineering-debt-2026-09-09.md)。

首次建立无构建产物的 worktree 时，先执行 `npm run build:runtime` 与 `npm run build`，再运行完整门禁；聊天契约会实际请求已构建的 SPA。隔离验收副本只带入本任务文件，不能通过忽略其他会话的失败文件而宣称原共享工作区全量通过。

每周 Dependency Audit 同时检查运行时与完整依赖树，高危/致命阻断，并保留 JSON 报告 14 天。中危告警须按实际调用路径评估，不能把流程通过理解为零漏洞。9-09 的依赖问题见[历史审计](archive/audits/remaining-dimensions-2026-09-09.md)，9-11 的 `adm-zip` 升级、重新审计及安装验收边界见[办公机收尾记录](archive/audits/office-code-2026-09-11.md)。

预算包括路由 JS 140 KiB、CSS、入口与依赖闭包等，完整阈值见 check-bundle-budget.js。测试规模与路由数量以当次输出为准；历史 PASS 不能代替本次检查。

## 服务与桌面部署

### 本机 Live2D 候选导入

已下载的 LPK 可复用夏目使用的 [LpkUnpacker](https://github.com/ihopenot/LpkUnpacker) 命令行工具：`LpkUnpacker.py <包.lpk> <隔离输出目录> -c <同包config.json>`。本轮工具源码版本为 `906d4cdd5597403ebf46dde8fb47d9c81a352d19`，仅需 CLI 的 filetype 依赖；不需要 GUI/Live2D Python 运行库。芙宁娜与雷电将军输出到 `runtime/live2d-unpacked/<角色>`，由配方的 `unpackedEntry` 接入。原 LPK、config 与作者说明保持原样。

个人桌面同步：`npm run wf -- live2d:sync-local --source <导入根> --target <用户模型根>` 默认只预览，`--apply` 核验完整源哈希后复制，保留目标旧版本。正常桌面部署使用 `deploy-desktop.bat -SyncLocalModels`，将模型写入 `%APPDATA%/com.aics.studio/gateway/live2d-imports`；安装包与公开资源清单仍不包含这些私有模型。修改 Rust 后使用 `-UseInstaller -QuietInstall -SyncLocalModels` 完整安装，UAC 仍由用户处理。

需要更新已导入模型的配方或校准时，可使用 `--apply --refresh`：先核对旧版本文件哈希，将旧目录保留为 `runtime/live2d-imports/.previous-<角色>-<唯一标识>`，再切换完整新副本；失败恢复旧目录。不带 `--apply` 的 `--refresh` 仍仅预览。不要手动覆盖作者模型或删除旧版本来绕过损坏检查。

`npm run wf -- live2d:import-candidates` 核对 `data/live2d-candidates.json` 中的本机候选，默认仅预览；`--ids hatsune_miku,frieren` 可缩小范围，`--apply` 将已完整核对的运行依赖复制到 `runtime/live2d-imports/<角色ID>`。源压缩包与解压目录不修改；仅在副本修复明确缺失的可选表情、登记已有表情与动作。相同内容重跑核验后保持不变，不同或损坏内容拒绝覆盖。每个模型保留 SOURCE.md、源清单哈希、文件哈希及修复记录。入口不下载、不解包受保护的 LPK、不发布、不安装。

本机直连的陪伴页、聊天页从 `/api/live2d-companions` 加载本机身份与 Adapter Profile；资源仅经本机受限接口按导入文件清单提供。远程/隧道请求不返回本机角色和模型，候选原件也不进入静态资产路由、资源包或桌面暂存。新角色尚无专属音色时保持文字聊天，不借用内置角色声音。Cubism 3 本机模型支持浏览器与 Native；Cubism 2 的蕾姆保持浏览器回退。原生端仅接受与本机导入回执身份一致且引用完整的模型，不接收 WebView 的任意文件路径。

真实模型浏览器检查：完成构建和导入后，设置 `AICS_LIVE2D_IMPORTS=1` 与独立 `AICS_E2E_PORT_OFFSET`，运行 `node node_modules/@playwright/test/cli.js test tests/e2e/live2d-imports.spec.ts --project desktop --workers 1`。未显式设置时跳过私有资产测试；开启后使用实际运行库、模型及贴图，保存双主题截图，不替代原生 GPU 或音频设备验收。

环境与本机凭据说明见 [启动与排错](../STARTUP.md) 与 [全功能硬件配置与模型开箱指南](guides/setup-and-models.md)。
- `models:check`：扫描当前硬件显存与 ComfyUI/反推模型就绪状态；
- `models:download-wd14`：一键从国内高速镜像（hf-mirror）下载本地 WD14 真实反推模型（约 150MB）；
- `models:download-h3 --models-root <ComfyUI模型目录>`：H3 可选模型下载入口；该操作下载大文件，不属于质量检查或普通安装的自动步骤。

现代安装器：`installer:modern --preview --capture --theme=dark --state=ready --dpi=144` 编译安全预览（不安装），支持 dark/light 与 ready/installing/done/error。正式发行脚本将现代展示层与 NSIS 核心一起打包并对最终 exe 签名。

底层游戏式安装器：`installer:build` 生成模板与素材，`installer:preview --capture --page=welcome` 安全预览；详情见 [安装界面维护](guides/desktop/game-installer.md)。`package:tauri` 已自动接入，无需手工修改生成的 NSIS 脚本。
仅更改安装界面且已有同版本程序时，`installer:bundle` 重新打包并签名；它不编译应用源码。

参考/样张链路需要 ComfyUI 和网关在线。ComfyUI 默认 8188，接入脚本网关默认 3000，配置可覆盖；3123 是历史端点，不作为通用默认。使用前核对所选脚本与本机服务配置。`comfy:start` 为现成启动入口。

桌面唯一入口是 `deploy-desktop.bat`，两个 deploy 工作流均调用它并保留 Cleanup 默认行为；自动调用不等待按键且保留失败退出码。`deploy:desktop` 默认跳过前端构建（dist 需已构建，数据聚合产物仍会刷新，版本由 `virtual:data-version` 运行时解析）；`deploy:desktop:full` 执行完整构建加增量流程；两个入口的默认增量模式都会清 WebView2 缓存并默认重启桌面端。

可附加开关（工作流入口仅接受无值开关，`-InstallDir <路径>` 需直接运行 bat）：`-UseInstaller` 改跑 `runtime/desktop-updates` 最新安装包（前置：先用 `package:tauri` 产出 `*-setup.exe`，缺失退出 1；隐含跳过本地构建）、`-QuietInstall`（仅随 `-UseInstaller` 静默安装）、`-NoRestart`（结束后不启动）、`-StartupRepair`（1.6.0 窄修复，与 `-UseInstaller` 互斥）。非管理员时脚本经 UAC 重启并透传全部参数，需用户确认。依赖/exe 变化的完整安装与 UAC 见 [部署指南](desktop-deployment.md)。

批处理入口的单杠字母开关可以登记于 run.switches，help/plan/audit 共用；其他入口仍要求双杠元数据键。`--plan` 会显示所传安装开关的行为标签而不启动执行器。默认与开关标签是可能副作用说明，不做标签抵消或参数权限判断；具体互斥及跳过行为以本段和部署实现为准。

## 备份与清理

`backup:git` 创建本地 bundle 增量链（2 个锚点 + 默认 10 个增量），不能替代 push 或异地副本。`runtime:clean` 默认只预览；`--prune --days 60` 会实际清理。先检查路径与白名单，避免清除当前运行资料。

## 自动化检查与审计入口

| 自动化 | 触发与范围 |
| --- | --- |
| Quality | push / PR：构建、静态检查、前端覆盖率、unit、contract、关键浏览器回归 |
| Nightly visual regression | 每日北京时间 02:00 / 手动：主题、截图与视觉矩阵 |
| Windows Native Live2D | main push / 手动：自托管 Windows 的 Tauri、Rust、原生自测与稳定性检查 |

当前办公机修复与未执行范围见 [1.7.1](releases/v1.7.1.md)；[独立审计（2026-09-12）](archive/audits/office-independent-audit-2026-09-12.md) 保留修复前证据，[工作流审计（2026-09-08）](archive/audits/workflow-audit-2026-09-08.md) 保留为历史。本机 gate:full 不包含浏览器、真实出图或原生桌面验收，这些仍按改动另行执行。
