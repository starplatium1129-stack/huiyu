# 统一工作流手册

> 维护日期：2026-09-13。命令注册与默认参数以 scripts/workflow.js 为准；此页解释操作顺序，不重复易漂移的脚本数量、角色规模和历史测试用例数。

## 先查入口

`node scripts/workflow.js audit:workflow-conditions --json` 从当前注册表报告运行条件、入口/文档存在性及递归复合副作用覆盖。`--domain audit` 按工作流分组筛选；`--root` 仅替换文件存在性核验根，不加载该目录中的 JavaScript。`--help/--plan` 不读取目标根或启动子进程。结构问题退出 1，所有命令执行状态始终为 `not-run`；元数据通过不代表实际运行通过。`showcase:fill-gaps` 为需网关的样张补缺入口，会调用模型并写产物及源登记，办公机报告不执行它。

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
| 按当前改动验证 | `npm run wf -- gate:quick` |
| 跨域/构建链等全量验证 | `npm run wf -- gate:full` |
| 检查本机桌面打包能力 | `npm run wf -- desktop:doctor --json`（只检测，不安装） |
| 检查安装包网关资源完整性 | `npm run wf -- desktop:verify-gateway`（需要已暂存资源；隔离目录真实启动，打包前自动执行） |
| 生成本机测试安装包 | `npm run wf -- desktop:package-local`（跳过压缩，不安装） |

所有执行固定在项目根目录。Node/npm 参数保留空格，npm 自动补转发分隔符。复合步骤失败即停止；reference:full 不接受公共参数，定向操作请分别调用子步骤。只读审计覆盖注册文件、npm 入口、文档存在性、复合依赖循环和 run 元数据合法性，不代表模型、账户、外部服务或桌面安装已经验收。

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
| 聚合反向写回分片 | data:import / popular:import / blueprints:import | 覆盖写入操作，先核对 diff；popular:split/blueprints:split 只拆分 |
| 数据契约与版本 | data:validate | DATA_VERSION 哈希域以 scripts/lib/data-version.js 为唯一事实源 |
| 分类与规范化 | data:normalize | 会写数据，不用于只读文档审计；遵守定稿保护 |

详细文件职责见 [维护手册](maintenance.md#文件职责)。三个聚合构建脚本只在默认构建时同步 DATA_VERSION（写 src/stores/sceneStore.ts）；`--check` 不写版本——产物缺失时自愈重建（fresh clone），齐全但与源不一致时报错退出 1。校验失败需定位来源，不能只改版本掩盖数据漂移。

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

角色/服装报告的独立 `themes` 数组按所选角色（包括路径展开的角色）列出 `id/file/canonical/themeStatus/reason`。只读解析 root 下 `src/assets/css/director/tokens.css` 的规则选择器，复用 audit:coverage 的选择器提取与默认白名单；注释和声明字符串不算选择器。显式主题为 explicit，列入 related + revalidate；nene 无显式选择器时为 default。CSS 缺失、损坏或存在不支持的选择器语法为 unknown；无显式主题且 canonical 数据缺失/无效、角色属外部热门或身份无法确认时也为 unknown，不列 mustChange。仅当 `data/characters.json` 可证明 canonical 角色缺显式主题且不在默认白名单时为 missing，列 mustChange。显式选择器关系不依赖热门或 canonical 登记；不证明实际 CSS 层叠、配色与渲染。纯场景输入不展开角色主题。

角色/服装报告的独立 `outfitDefaults` 数组覆盖每个所选角色，输出 `id/status/defaultOutfit/defaultIds/isDefaultIds/reasons`。仅当全部服装的 `default` 与 `isDefault` 均为布尔值、集合一致且恰好一个默认项、默认 ID 非空且角色内唯一时为 explicit，`defaultOutfit` 为解析出的 ID；其余结果为 null。可证明的多默认/默认 ID 重复为 ambiguous、两字段冲突为 mismatch、默认 ID 缺失或完整双字段无默认项为 missing，逐条列 mustChange。字段缺失、非布尔、空列表或身份不唯一等无法证明的格式保持 unknown；不猜第一项。部分字段仍可证明的重复/冲突照常报告。省略 outfitId 的蓝图在 revalidate 原因中包含明确的默认 ID，否则同时保留 unknown；显式 outfit 过滤和引用检查不变。

`--showcase-manifest <root内相对路径>` 可重复（建议单个），例如 `node scripts/workflow.js audit:impact --scene sc001 --showcase-manifest reports/showcase.json --json`。独立 `showcase.manifests` 只读解析 JSON 的 entries 数组：显式 scene 匹配 entry.id，显式 character 匹配 entry.char 或 entry.type；路径输入不推断样张目标。匹配项列 related/revalidate，保留 index/id/type/char/rating/attempt、matchedBy 和 reviewPresent（provenance.review 字段是否存在，即使 null 也算存在），不输出 review 内容或图片路径。reviewPresent 不代表审核通过，不读取图片或执行生成/审核/发布。未提供时 unknown“样张清单在外部/未提供”；可读清单整体标记 partial，不证明完整覆盖。无匹配条目保持 unknown，不能列必改。显式文件缺失、非普通文件、JSON/entries 无效或真实路径越界时标记 error 并退出 1；参数中的绝对/越界路径退出 2。每个清单独立处理，坏清单不掩盖有效关联；所有清单均不证明缺失条目。帮助/预览不读取清单，不扫描外部目录。

推荐命令与操作性质来自工作流注册表，全部只列出、不执行；build 可能写数据和版本，不能因出现在报告里就当作只读检查。本批不提供自动增量检查：全域聚合顺序、浏览器分片、样张完整性、DATA_VERSION、压缩产物、历史删除/重命名未覆盖。公共构建器/契约路径建议全量 data:validate；未知路径不宣称影响为空。全域主题与参考覆盖沿用 audit:coverage；真实编译/画面验收仍需后续对应机器执行。

1. `reference:register --dry-run` 对账待登记形态；核对后按需登记。
2. `reference:render` 生成参考图；`reference:design` 补三视图设计图。合计 4 种肖像机位 + 3 种设计机位。
3. `reference:audit --force --keys <角色/服装/机位前缀>` 定向重审，`reference:repair` 修复。
4. `check:ref-urls` 与网关共用素材目录解析（AICS_CHARACTER_REF_ROOT → AI 工作区 → assets/character-references）。显式目录失效不会静默换库；pending 不等于真实资产，也不等于通过视觉审核。

`reference:full` 是 render → audit → repair，不包含自动完成所有新增形态登记与设计图的承诺。参考图片不入 Git；旧问题配方见 [历史参考审计](archive/audits/character-reference-audit-pending.md)。

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

`node scripts/workflow.js resource:pack --manifest <root内JSON> --name <包名> [--root <目录>] [--apply]` 是 R1 之后的受控复制工具，不是安装器、下载器或发布入口。默认只预览复制计划（stdout JSON：目标路径、条目、字节合计与核验摘要），零写入；但预览会读取清单并对源文件做与 `audit:resource-manifest` 同套的核验（读取不是零读取）。`--help` / `--plan` 仅打印用法，不读取目标文件。

显式 `--apply` 才实际复制：先复用现有清单核验，重复路径、非法/越界路径（含编码分隔符）、排除域（`assets/character-references`）、非空 unverified、文件缺失、字节或哈希不匹配任一失败即整体拒绝；通过后把清单已列普通文件复制到 `<root>/scripts/archive/resource-packs/<包名>/` 新目录，保留 `assets/...` 相对结构，不遍历补入未列文件，并写入可被 `audit:resource-manifest --root <包目录> --manifest manifest.json` 再次核验的 `manifest.json`。复制先写入本次专用暂存目录 `.staging-<包名>-<随机>`，逐条读回核验候选副本的字节与 SHA-256（复制时源已变化会被发现并终止），整体复核通过后才改名为最终包名，再做发布后核验；核验通过只输出「候选包已通过字节核验」，不代表图片质量、内容审核或部署完成。

安全边界：包名限字母、数字、下划线、短横线（1-64 字符），拒绝路径片段；目标只要已存在（含空目录、文件或链接）即拒绝，不覆盖任何旧包；目标祖先链中已存在的符号链接/junction（realpath 与字面路径不一致）先于任何写入被拒；复制期间源变化、候选写入失败或发布冲突都不报告成功，暂存目录保留并在结果中给出明确路径（残缺暂存不是可用候选包），不删除任何目录。不转换或重采样图片，不执行复制内容，无 ZIP 解压/安装/缓存淘汰与网络行为，写入范围限 `--root` 内候选目录。

退出码：0 表示预览计划可行或候选包已通过字节核验并落盘；1 表示目标或内容问题（清单核验失败/格式错误/不支持版本、目标已存在、目标链含链接、复制或发布后核验失败）；2 表示参数或环境问题（包名非法、参数缺失或无法识别、root 不可用、清单路径越界或不可读）。隔离回归：`node scripts/tests/test-resource-pack.js`（已登记 unit 套件，全部夹具位于临时目录，不导出真实素材）。

## 门禁与构建

按影响面选验证，不按“改了代码”或“准备提交”一律升级：

| 本次改动 | 验证边界 |
| --- | --- |
| 文档、AGENTS、skill | 结构、链接、规则一致性及典型请求走查；不构建、不出图 |
| 局部颜色、间距等样式 | 相关样式/对比度检查和受影响组件的双主题视觉检查；不默认跑 TypeScript、后端契约或全站回归 |
| UI 行为或局部业务逻辑 | 定向行为测试，或显式选择 `gate:quick ui/server/data`；补受影响的浏览器流程 |
| 依赖、配置、工作流、跨域重构、未知影响面，或用户明确要求 | `gate:full`，再按风险补浏览器/设备验收 |

构建用于验证产物或准备同步，不能代替视觉/设备验收。同一内容的检查不因提交而重跑；后续修复只重跑受影响范围。已核对隔离与权限边界的测试可直接执行和修复，无需逐步请求批准。

`gate:quick` 自动分类是保守兜底，测试文件/脚本路径会触发 full；已明确影响范围时可使用显式面积或定向入口。工具帮助中的“提交前”描述不表示所有提交都必须运行全量。本节规定选择原则，不改变脚本的实际分类行为。

| 入口 | 实际范围 |
| --- | --- |
| gate:quick ui/server/data/all | 按变更面积分层；默认检测 Git 改动；脚本、依赖、配置及未知代码路径升级 full；纯文档跳过 |
| check:quick | npm run check 的全部已注册并行检查 |
| check:full | npm run validate：check + frontend + unit + contract；包含 check 内的 typecheck:app，不包含 build |
| gate:full | npm run check（内含 typecheck:app/typecheck）+ vitest + unit + contract + build，全量入口 |
| build:web / build:runtime | 前端与预算/预压；服务 TypeScript 编译 |
| check:style-debt | 样式字面值、颜色、动画和双主题全局/角色令牌对比度；动态组件另做视觉验收 |
| check:monolith / check:pinned-scenes / check:rewrite | 体量、定稿与改写完整性；rewrite 交付需传 --delivery，基线经本地 Git 读取（默认 b1ccfc0，--baseline 可改） |
| check:popular / check:anima-routes / check:frontend | 热门、Anima 接口与前端单测 |
| test:contract / test:e2e:critical | 契约套件与关键浏览器回归；test:e2e:critical 工作流走无 build 的 `test:e2e:critical:run` 入口，复用已有构建产物（npm 脚本 `test:e2e:critical` 才先 build） |
| test:e2e:performance | 已构建产物的单 worker 冷／热进入与首次操作测量；与回归分开执行 |

关键浏览器回归包含 `ui-layout.spec.ts` 的双主题/多尺寸布局与可读性检查。独立 UI 预览可用 `AICS_UI_AUDIT_URL` 指向隔离服务；默认检查本机 3000，不依赖 networkidle 等待长轮询停止。

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

环境与本机凭据说明见 [启动与排错](../STARTUP.md)。H3 可选模型下载入口为 `models:download-h3 --models-root <ComfyUI模型目录>`；该操作下载大文件，不属于质量检查或普通安装的自动步骤。

现代安装器：`installer:modern --preview --capture --theme=dark --state=ready --dpi=144` 编译安全预览（不安装），支持 dark/light 与 ready/installing/done/error。正式发行脚本将现代展示层与 NSIS 核心一起打包并对最终 exe 签名。

底层游戏式安装器：`installer:build` 生成模板与素材，`installer:preview --capture --page=welcome` 安全预览；详情见 [安装界面维护](guides/desktop/game-installer.md)。`package:tauri` 已自动接入，无需手工修改生成的 NSIS 脚本。
仅更改安装界面且已有同版本程序时，`installer:bundle` 重新打包并签名；它不编译应用源码。

参考/样张链路需要 ComfyUI 和网关在线。ComfyUI 默认 8188，接入脚本网关默认 3000，配置可覆盖；3123 是历史端点，不作为通用默认。使用前核对所选脚本与本机服务配置。`comfy:start` 为现成启动入口。

桌面唯一入口是 `deploy-desktop.bat`，两个 deploy 工作流均调用它并保留 Cleanup 默认行为；自动调用不等待按键且保留失败退出码。`deploy:desktop` 默认跳过前端构建（dist 需已构建，数据聚合产物仍会刷新，并可能写源码中的 DATA_VERSION）；`deploy:desktop:full` 执行完整构建加增量流程；两个入口的默认增量模式都会清 WebView2 缓存并默认重启桌面端。

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
