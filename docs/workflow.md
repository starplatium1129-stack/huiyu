# 统一工作流手册

> 整理日期：2026-10-09。命令注册与默认参数以 scripts/workflow.ts 源码为准，scripts/workflow.js 为开发工具的生成入口；产品后端由 Rust 提供，此页不以 Node 工具生成完成代替后端构建。

## 先查入口

新 worktree 复用已有依赖时，若工具 `.js` 入口尚未生成，先执行一次 `npm run build:runtime`。维护和登记修改 `.ts` 源文件；`.js` 是运行入口，不直接编辑。工具源或配置未变化时，不因普通 UI 小改动重复准备工具。

`node scripts/workflow.js audit:workflow-conditions --json` 从当前注册表报告运行条件、入口/文档存在性及递归复合副作用覆盖。`--domain audit` 按工作流分组筛选；`--root` 仅替换文件存在性核验根，不加载该目录中的 JavaScript。`--help/--plan` 不读取目标根或启动子进程。结构问题退出 1，所有命令执行状态始终为 `not-run`；元数据通过不代表实际运行通过。`showcase:fill-gaps` 实际生成需网关与显式候选目录，只写待审核候选；`--dry-run` 不写盘、不调用模型，不回填活跃源登记。

条件报告的 JSON 还保留已声明的 `switches`、`notes`、`needs`（缺省分别为 `{}`、`[]`、`null`），不从说明文字推断副作用。默认文字按项列出默认行为、开关及效果、前置条件、说明和未知项；不改变命令执行、旧 JSON 字段或退出码。

`apply-scene-patch.js --patch <JSON> [--out <报告JSON>]` 保持默认 dry-run：不写数据或备份，显式 `--out` 仅写报告。报告保留旧字段，并增加 schema/version、sourceFiles、changedRecords、protectedFieldDecision、derivedOutputs、writeStatus、applyStatus、rollbackCapability。输入 patch 仍为 v1 数组格式；保护字段拒绝整批，不产生允许报告。`--out` 禁止覆盖 data 目录、输入、源、派生产物、基线及压缩兄弟文件，核对现有父目录的真实路径。`--apply` 先保存可读 manifest 和原始字节，再逐文件原子替换；重建/校验异常恢复声明范围内原文件及压缩文件，并删除原先不存在的产物。失败报告区分已回滚与回滚失败。此契约不覆盖进程被强杀、断电、并发写入和回调未声明的额外文件；不构成真实保存 API 或跨进程事务。

`npm run workflow -- --help` 查看全部命令，`node scripts/workflow.js reference --help` 查看分组。具体命令帮助只展示注册信息，绝不启动底层脚本。`--plan` 统一预览实际命令，分别标注默认行为与本次所带开关的关联行为，不出图、不写数据；`--dry-run` 是底层脚本参数，仅在该脚本明确支持时使用。

每个注册项带结构化 `run` 元数据（W1）：`nature`（默认行为 facet，如 read-only / writes-source / writes-product / writes-release / external-model）、`machine`（node / windows / python-pillow / gateway / comfyui / vision-api 等）、`switches`（显式开关改变的行为，如 `--check` 的自愈与守卫）、`resume`（idempotent / checkpoint / na）、`evidence`（核实位置）与 `unknown`。help 的详细 JSON 与 `--plan` 预览、`audit:workflows` 审计共用这份元数据；它只用于描述与审计，不改变任何执行步骤，也不做运行时拦截。复合工作流的 nature 必须覆盖子步骤的副作用；真实纯只读的组合可以保留只读标记。开关关联行为不是完整执行模式，不替代底层参数组合与优先级规则。

没有入口时查 scripts/maintenance 或运行 `npm run workflow -- audit:orphans --json`。有现成流程必须复用；新增脚本同时登记 WORKFLOWS、本手册分组，新增文档登记 INDEX.md；一次性脚本用完归入 scripts/archive。

## 桌面人工诊断

以下入口只由操作员显式调用，不属于默认门禁、CI或自动设备验收。`npm run wf -- diagnostics --help` 查看清单；工作流级 `--help` / `--plan` 只显示命令和副作用，不运行底层脚本。

| 显式入口 | 源文件与默认行为 |
| --- | --- |
| `diagnostics:window-capture -Out runtime/<PNG> [-Title <标题>] [-ProcessId <PID>] [-Scale 2]` | `scripts/maintenance/capture-window.ps1` 用 PrintWindow 截取指定窗口，写入PNG，可覆盖旧文件。默认标题为绘遇 Companion、倍率为2；工作流要求明确传入 `-Out`，输出父目录须预先存在 |

四个旧 `diagnostics:companion-*` CDP 探针已退出注册表。其源文件原样保留在 [历史探针归档](../scripts/archive/companion-cdp-20260930/README.md)，没有删除测试；旧选择器、固定截图目标与按 URL 子串选择最后一个页面的做法不构成当前有效的公共诊断 CLI，也不应直接运行。不能把归档探针输出作为现行桌宠功能或设备验收证据。

人工诊断的当次截图与日志归入被忽略的 `runtime/`，避免覆盖已有证据。常规隔离浏览器回归继续使用下方的Playwright入口，不以人工脚本代替。本次只核对注册和归档内容，未连接真实浏览器或执行探针。

## 日常快捷操作

统一短入口：`npm run wf -- <命令>`（与 workflow 完全等价）。

| 想做什么 | 命令 |
| --- | --- |
| 查找命令 | `npm run wf -- search 样张`（中英文关键词均可） |
| 查看一个命令的运行条件 | `npm run wf -- <命令> --help`（详细 JSON 含 run 元数据） |
| 生成品牌图标 | `npm run wf -- brand:build`（`assets/brand-mark.svg` → 深浅字标与安装器线条；夏目 Q 版头像母图 `assets/app-icon.png` → favicon、Windows ICO 与托盘 PNG） |
| 文档迁移后检查链接 | `npm run wf -- docs:check`（含旧地址映射与干净检出可移植性；不联网核验外部来源） |
| 查看一个分组 | `npm run wf -- reference` |
| 查看参数与依赖 | `npm run wf -- reference:design --help` |
| 预览即将执行的命令 | `npm run wf -- data:build --plan` |
| 检查入口是否失效 | `npm run wf -- audit:workflows --json` |
| 检查工作流行为回归 | `npm run wf -- check:workflows` |
| 检查部署退出与锁保护 | `npm run wf -- check:desktop-deploy`（Windows 隔离夹具，不操作实际安装） |
| 检查维护脚本孤儿 | `npm run wf -- audit:orphans --check`（已纳入 check 与 CI，候选须人工复核） |
| 查看内容覆盖差额 | `npm run wf -- audit:coverage`（只读报告：热门服装→参考登记、角色→主题契约；`--json` 机器可读；覆盖差额本身不作为门禁失败依据） |
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

`audit:coverage` 对照热门服装分片与参考索引（standards/view），输出缺登记、pending、URL 已填缺实图、素材根不可核实及参考库独有形态。主题侧识别 `tokens.css` 的通用运行时主题契约；当前角色强调色由 `characterTheme.ts` 从档案与调校例外派生，普通新角色无需新增选择器。没有通用契约的旧布局才区分显式选择器、默认允许项、缺失与旧别名。报告不验证颜色对比度、CSS 层叠或视觉效果。结构错误退出 1；覆盖差额本身只报告、不授权自动登记或补图。

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

人物、服装、场景、蓝图及记录式文档通过 `content:catalog patch/import --runtime-root <实际运行目录>` 维护；默认预览，`--apply` 写入工作库，随后显式 `export --out data/catalog` 交付项目快照。具体格式见[维护手册](maintenance.md#批量修改与快照)。构建工具消费项目快照，不反向修改工作库。

| 操作 | 入口 | 注意事项 |
| --- | --- | --- |
| 场景快照构建 | data:build | data/catalog → scenes.json；旧项目才读取分片 |
| 人物／服装／场景统一同步 | content:sync | 默认只读校验与登记预览；--apply 修清单 count、补参考分片并构建聚合；--ids=a,b 仅限制参考登记 |
| 每人物参考分片聚合 | reference:build | data/references → standards/view 兼容聚合；--check 检查一致性（产物缺失会自愈）；聚合不入 Git |
| 热门角色快照构建 | popular:build | data/catalog → popular-characters.json |
| 蓝图快照构建 | blueprints:build | data/catalog → scene-blueprints.json |
| 词条分片与字典 | tags:build / tags:check | 校验 manifest、重复词/别名决策和源路径；保留旧 ID，生成聚合与字典，失效旧压缩 |
| 离线释义待补词统计 | tags:untranslated --input <文件> | 读取本地 PixAI JSON/JSONL 或 WD14 CSV；按现行界面释义区分完整中文、部分中文与英文回退，保留原词；--json 输出清单，--general-top / --character-top 只限制待补候选；分别标明样本出现次数与 Danbooru 频次，不以置信度代替频次；不上传、不翻译、不写词典 |
| 内容记录读写、历史与导出 | content:catalog | 显式运行目录；patch/import 默认预览，export 显式选择记录范围 |
| 数据契约与版本 | data:validate | DATA_VERSION 哈希域以 scripts/lib/data-version.js 为唯一事实源 |
| 未迁移旧资料修复 | legacy:* | 仅旧格式用途；已有内容库/快照拒绝回写，见[迁移与保护](maintenance.md#迁移与保护) |
| 桌面端个人内容目录 | desktop:content-sync | 默认只读预览；退出桌面端后，`--apply` 按打包白名单先备份覆盖项、逐文件原子写入，目标独有项保留；`--clear-webview-cache` 另清 WebView2 缓存；支持实际配置/资料根覆盖，完成后再启动，不证明界面 |

详细文件职责见 [维护手册](maintenance.md#文件职责)。三个聚合构建脚本默认计算 DATA_VERSION，客户端由 Vite 的 `virtual:data-version` 在构建时注入，不再改写 `src/stores/sceneStore.ts`；`--check` 不写版本——产物缺失时自愈重建（fresh clone），齐全但与源不一致时报错退出 1。校验失败需定位来源，不能只改版本掩盖数据漂移。

核心精选 `personaCoreSceneIds`：保存时对显式数组稳定去重并剔除非活跃引用，显式非数组报错；旧请求漏字段时，保存链在基线核对后的锁内保留现存核心精选，显式 `[]` 才清空。纯清洗函数没有旧快照时保留缺省；不合并其他策展字段。主校验检查该字段的数组、非空字符串、重复及活跃引用，空数组/缺省兼容；既有首屏预算仍由分片测试负责，不新增核心精选必须属于 curated 的限制。`validate-scenes.js` 的分片和 data 元数据统一采用 `AICS_DATA_ROOT`、`AICS_APP_ROOT`、仓库根的优先级，隔离夹具不再混读生产元数据。

场景语义门禁复用工作台的镜头过滤和负向组装（scripts/lib/scene-render-contract.js），检索 tags 不冒充发送给模型的词条。提示词不设置最低字符数、词数或句号数配额；门禁保留非空、身份/服装绑定、占位符、分级、构图冲突与编译消费检查。画面完整度与模型写法按 [studio-prompt-craft](../.agents/skills/studio-prompt-craft/SKILL.md) 审查，不能以静态长度代替真实画面；接口输入大小上限仍按对应协议执行。`optimize-scenes --check` 检查持久化数据的实际编译结果；changed 表示可选的格式改写建议，不要求机械改写提示词。分级脚本只维护分级/使用元数据，不再改写 negative；任何提示词改写仍须独立真实出图和定稿保护验收。

## 参考库

参考图库已退出角色档案及新增角色/服装的必备清单。分镜的角色和服装文字读取内容目录，参考图片按项目需要上传。以下入口仅用于主动维护既有参考素材；`content:sync` 与 `character:onboard` 不再自动登记或生成参考图库。

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

1. `reference:register --dry-run` 按服装粒度对账待登记形态；核对后按需登记。已登记形态不覆盖，新增项只写 7 个 pending 占位。
2. `reference:render --output <候选目录>` 生成四视角待审核候选；人工验收与发布仍须显式完成。`reference:design` 是独立的三视图设计图入口，行为不等同于候选生成器。
3. `reference:audit --force --keys <角色/服装/机位前缀>` 定向重审，`reference:repair` 修复。
4. `check:ref-urls` 与网关共用素材目录解析（AICS_CHARACTER_REF_ROOT → AI 工作区 → assets/character-references）。显式目录失效不会静默换库；pending 不等于真实资产，也不等于通过视觉审核。CLI 数据根为 `--root <完整项目根>` > AICS_DATA_ROOT > AICS_APP_ROOT > 仓库根，view 与审计 appRoot 对齐，显式外部素材配置保留；直接 `--help` / `--plan` 零目标读取。参数/根错误退出 2，缺失或损坏 view、审计问题退出 1。

`reference:audit` / `reference:repair` 仍用于旧活跃参考库的视觉检查/定向修复，不能用于新候选目录，也不能替代下面的人工决定。参考图片不入 Git；尚未交付素材与人工决定见 [未来规划](roadmap.md)。

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

热门候选生成默认采用 MiaoMiao v1.6：Euler/normal、30 步、CFG 4.5，TeaCache 阈值 0.10（起止比例 0–1、CUDA 缓存）。此缓存档位来自本机 RTX 4070 Ti SUPER 与 SageAttention 的同输入对照，按用户接受同种子重画、保留人物结构与画面丰富度的要求选择；不承诺像素一致或所有输入同等收益。主采样与需要扩散采样的高清／局部重绘阶段保持该采样组合；纯像素超分不增加采样。`--no-tea-cache` 可关闭缓存，`--model` 可显式选择其他已登记 Anima 模型，其参数按对应模型目录取得。Euler/normal 来自 [1.6 作者版本说明](https://www.seaart.ai/pt/models/detail/d88ps7de878c738fimi0)，[Anima TeaCache 节点作者](https://github.com/CocyNoric/ComfyUI-Anima-TeaCache#recommended-settings)的 Euler 保守起点仍为 0.05；本机调档不属于 MiaoMiao 作者配方。`--keys` 格式为 `popular:<角色id>:<蓝图id>`。续跑仅复用模型、提示词、画幅、采样和缓存参数全部一致的成功记录，配置变化会重新生成；不同配方建议使用独立候选目录。

`npm run wf -- showcase:full --output "E:/候选目录/本轮" --source <现有版本> --target <新版本> --plan` 可先检查链路；去掉 --plan 后会生成并审核，最后只预览发布。三步共用同一份 generation-manifest.json 和 audit-results.json。审核后用 `showcase:publish --from <该manifest> --source <现有版本> --target <新版本> --apply` 实际写入发布目录。该旧发布器并不自动切换网关配置，发布后还需按样张工艺检查活跃目录。当前 checkpoint 和采样参数以脚本/网关配置为准；生成后检查编译请求与实际画面，失败与未审记录保留。

### 旧热门样张的人工恢复

`publish-popular-showcase` 会替换源版本的全部 popular 条目，不是增量追加。当前仓库未提供旧热门样张的增量合并恢复工具；历史记录中的 `merge-showcase-legacy-popular` 命令已不可用，`build:runtime` 也不会生成它。不要将正常发布命令当作增量恢复命令使用。

如确需恢复旧版本中已审核、且目标版本缺失的条目，先完整备份目标版本，在非活跃副本中核对旧条目的审核记录、ID、分级、图片和缩略图；确认素材路径留在各自版本目录内。具体恢复方案及写入范围须另行确认，不从历史命令推断当前支持的参数或安全保障。正常候选发布仍按上一节的预览、审核和显式发布流程执行。

## 角色接入

`character:onboard --character <id>` 为自动化辅助；`--skip-render` 跳过出图，不能据此声明资产完成。历史 `--deploy` 仍直连底层 PowerShell，不作为现行安装入口；接入核验后另用 `deploy-desktop.bat` 完成桌面同步。必须同时核对 [六层契约](engineering-contracts.md#角色接入) 和 [接入步骤](guides/characters/character-onboarding-workflow.md)。

`audit:impact` 的 `referenceEvidence` 按所选角色/服装统计参考 view 的显式 references：total、pendingCount（pending=true 或缺非空 URL）、urlDeclaredCount、reviewDeclaredCount。pending 优先于 declared-unverified；空数组为 empty，缺角色/服装/references 为 missing，坏或缺 view 为 unknown，未知计数为 null。reviewStatus 仅区分字段声明与 unknown，assetStatus 始终 unverified。显式 outfit 仅过滤对应 character，路径带入其他角色保留全部服装。保留 reference 关联与复验；不访问 URL、图片或素材根，不把声明当成资产或审核通过。

## 内容归属只读报告

### 历史影响的实际检查与候选证据

`check:impact --base <本地commit/ref> --execute --json` 根据旧新源关系选择实际执行的只读检查；不带 execute 只预览，help/plan 零目标读取。只有可证明身份、关系、清单和顺序不变的受支持场景/蓝图记录字段变化才走 incremental；删除、重命名、未知路径、公共实现或不完整关系回退 full。`--full --execute` 无需 Git 即可检查七个已支持结构域。它复用现有解析器、参考 schema、内容纯函数和源/产物对照，不运行可能自愈写入的 builder。

输出分别记录 selection、execution.executed、逐检查状态、未知字段、`execution.fieldCoverage` 的源/派生顶层字段库存，以及跨域关系目标的实际存在性。局部或已支持完整结构域通过均不等于完整内容 gate：DATA_VERSION、压缩伴生物与未导出的语义规则仍保留完整门禁要求，退出 3；实际失败退出 1，参数错误退出 2，预览退出 0。读到文件或目录成员变化时返回 incomplete，不能用混合快照认证通过。`audit:ownership` 的 fieldValidation/readWriteCoverage 只说明规则与覆盖，不代表已执行这些检查。

`audit:content-evidence --root <源根> --candidate-root <候选根> --manifest <候选根相对清单> --source <源根相对源文件> --recipe <源根相对生成器> [--decisions <候选根相对审核JSON>] --json` 只读取明确允许的输入、原生候选账本和资产。source 可重复；旧机器路径不自动重定位。它分开报告结构、生成状态、源/请求/输入版本、实际文件字节、审核绑定和发布证据；源、图片或记录变化使旧审核 stale，遗漏新 attempt 或损坏字节不会被历史 pass 掩盖。

人工审核接受 reference-human-review 或 content-human-review 的版本化记录，绑定 runId、manifestSha256 及逐条 recordId/recordSha256/sha256/inputVersion/reviewedAt；缺决定保持 pending，匹配仅证明声明绑定，不证明审核者实际看过画面。额外 `--publication <候选根相对回执> --published-root <明确目录>` 可核对 content-publication-evidence 回执及对应发布字节；专用 reference-release 由参考版本解析器核验，不冒充格式兼容。退出 0 仅表示所选明确证据匹配，1 为失败，2 为参数错误，3 为未知/过期/待验。入口从不生成、审核画面、修改清单、复制资产或激活资源。

`node scripts/workflow.js audit:ownership --json` 只盘点旧格式升级源及其派生文件，保留人物、热门身份/服装、场景、蓝图、精选、退役、参考、主题和样张的旧字段职责。报告中的分片权威与写入链仅适用于旧格式，不代表当前 `content/catalog.sqlite` 工作库或 `data/catalog/` 快照；当前维护使用 `content:catalog`。`--root <隔离目录>` 可替换升级源根目录；`--domain <characters|popular|scenes|blueprints|curation|retired|references|themes|showcase>` 仅检查指定域。

entries 的 role 保留 source/product 职责；status 为 source/product/missing/invalid/external-unknown。manifest 按对应领域结构解析；场景按 .1 起连续批次优先，否则读取逻辑单文件。检查真实路径边界、JSON 及浅层容器，输出实际字段名；默认不证明完整 schema、源产物一致性、字段语义、审核或图片质量。参考权威在 `data/references/` 人物分片与 manifest，standards/view 是兼容聚合，登记器经 reference-store 同步写回源与产物；外部样张保持 external-unknown，不扫描外部清单或图片。

写入入口仅展示，不执行 builders（包括可能自愈写入的 --check）、模型或网络。`--help` / `--plan` 不读取目标目录；退出码 0 表示读取完成（允许 external-unknown），1 表示有 missing/invalid，2 表示参数或根目录错误。隔离回归：`node scripts/tests/test-content-ownership.js`。

## 本地资源清单生成与校验

`node scripts/workflow.js audit:resource-manifest [--root <目录>]` 默认只读生成 `root/assets` 普通文件的清单 JSON（stdout）：每条含 root 相对 posix 路径、字节数、SHA-256，路径按码元顺序稳定排序；`generatedAt` 仅信息性，不作为内容版本；首版以路径标识文件，不声称跨重命名身份稳定。`assets/character-references` 外部参考域整棵排除；不进入外部挂载、runtime 或用户作品目录；扫描根自身为符号链接/junction 时拒绝扫描；目录遍历不跟随符号链接/junction，非普通文件、目录不可读和无法合规表示的文件名（如含编码分隔符形态）单列 `unverified`，不伪造完整覆盖。

`--manifest <root内JSON>` 切换为校验（清单须位于 root 内）：检查重复路径、非法/越界路径、文件缺失、字节数或哈希不匹配。清单路径按字面文件路径处理，不做 URL 解码；含百分号转义时做单字节解码核对，解码引入分隔符、盘符、控制字符或改变段结构（编码反斜杠、编码穿越）先于任何文件访问被拒；条目在 stat/读取前先做真实路径边界检查，junction/symlink 指向 root 外即拒绝，目标缺失时沿最近存在祖先解析，不以「目标不存在」跳过边界。校验按 Windows 大小写语义检查重复路径与排除域，并核对真实目标仍在 assets 允许域中；清单含非空 unverified 时保留已列条目的核验数量，但整体结果失败（退出 1）。校验只核对已列条目，不发现未登记文件，不做隐式修复、删除或上传，不做任意 URL 抓取或全盘发现。清单保存由调用者显式重定向到自己的输出目录，本入口零写入。

`--manifest <旧JSON> --compare-manifest <新JSON>`（两份均须位于 root 内）切换为差异比较：先对两份清单做与校验一致的结构检查（schemaVersion、条目形态、重复与 Windows 大小写重复、路径合规），再按精确路径输出新增、移除、内容改变与未改变数量。结果顺序稳定；`changed` 携带前后 `bytes`/`sha256`，`added`/`removed` 保留对应条目；`old→new` 由参数顺序决定，不用 `generatedAt` 判定新旧，不按相同哈希猜测重命名。比较只读取这两份指定清单，不读取/哈希实际 `assets`，旧清单已移除的文件不因当前磁盘缺失而无法比较；除非空 `unverified` 外的任何结构错误都会阻止差异计算。非空 `unverified` 时仍列出已列条目差异，但整体失败：`identical` 只表示两份清单已列条目的集合与记录内容一致，`ok` 且 `identical` 同时为真才构成一致结论，且这仍不证明目录覆盖完整、当前文件存在、内容已审核或已交付。存在差异本身不算比较失败（退出 0）。

退出码：0 表示生成无未核验项、校验全部通过或比较有效完成（比较含结构错误/非空 unverified 时为 1，参数非法或 `--compare-manifest` 缺少 `--manifest` 为 2）；1 表示目标内容有问题（生成含未核验项、校验错误、清单格式错误或不支持的 schemaVersion）；2 表示参数或环境问题（参数非法、root/扫描根不可用、manifest 路径越界或不可读）。`--help` / `--plan` 不读取目标文件、不计算哈希。哈希相等只证明字节一致；文件存在不代表内容已交付、图片质量或审核通过，清单不代表可信发布源。隔离回归：`node scripts/tests/test-resource-manifest.js`（已登记 unit 套件）。

筛选覆盖报告可使用 `audit:coverage --character <规范ID> [--outfit <角色内ID>]`。outfit 必须与 character 同用，未知 ID 或缺参数退出 2。参考条目和计数按所选范围重算，JSON 增加 scope；全域结构错误仍保留，可能来自未选对象。素材存在性仅核对所选角色/服装的参考；不影响无筛选参数时的全库输出和退出码。

## 离线资源候选包暂存导出

本地 ZIP 图形安装可双击 `tools/Install-OfflineResources.cmd`；维护入口为 `offline:assistant`。助手从内置官方独立审批清单识别包，流式校验全部文件，用户确认退出绘遇后才调用原生 `offline-import`。支持进度、安全取消及同包恢复；不下载、不自动关闭应用、不改互斥或用户修改保护。图形助手需要本次支持 `--cancel-stdin` 的原生程序；尚未发布或安装，旧 1.8.0 安装程序不能视为已具备此能力。

面向新机器的完整发行使用 `offline:pack --showcase-root <已发布样张目录> --release <安全版本ID> --out <新输出父目录> [--root <项目根>] [--apply]`。已有资源的机器可增加 `--base-release <旧release.json>` 生成增量 ZIP，仅携带新增/变化的 assets 与画册图片、完整目标清单及基线身份；旧包只读元数据，可以上一增量继续制作。默认只读规划并核对真实来源字节；Windows `--apply` 生成 ZIP、两种 SHA-256 及独立 PowerShell 安装入口。导入不依赖 Node 或源码，外部审批指纹绑定 release.json 原始字节；增量要求配套原生 `offlineDelta` 能力（正式 1.9.1 不支持），匹配基础发行后从本机复用未变化文件，保留用户修改、旧版及事务恢复。导入前需退出桌面。完整步骤和发行边界见[离线资源安装与发行](guides/offline-resources.md)。此入口只导出已有素材，不安装模型、上传或生成/审核图片。

`offline:prerequisites-plan -Out <新目录>` 只读预览微软 VC++ x64 离线材料；`offline:prerequisites-prepare -Out <新目录>` 显式下载并核对有效微软签名、版本与真实字节/SHA-256，整批完成后发布新目录，不执行安装。将其离线 EXE、回执与说明作为发行前置附件，新机由用户完成 UAC 安装；WebView2 由本次 NSIS offlineInstaller 配置提供，二者用途不同。

原生前置下载与公开附件以[当前离线资源指南](guides/offline-resources.md)为准。ZIP 校验 SHA 与 release.json 审批 SHA 分别核对，不通过修改版本号沿用旧审批。模型、真实断网与干净 Windows 安装仍需对应验收。

当前 `--apply` 仅支持 Windows，其他平台拒绝写入、仍可预览。原因是普通目录 rename 在 POSIX 可覆盖并发出现的空目录；Windows 隔离回归已验证该冲突会拒绝。工具面向受控本地目录，不承诺抵御其他进程持续恶意替换路径的绝对事务隔离。

`node scripts/workflow.js resource:pack --manifest <root内JSON> --name <包名> [--base-manifest <root内旧JSON>] [--root <目录>] [--apply]` 是 R1 之后的受控复制工具，不是安装器、下载器或发布入口。默认只预览复制计划（stdout JSON：目标路径、条目、字节合计与核验摘要），零写入；但预览会读取清单并对源文件做与 `audit:resource-manifest` 同套的核验（读取不是零读取）。`--help` / `--plan` 仅打印用法，不读取目标文件。

资源清单生成、已列文件验证和候选包核验共用 64 KiB 分块 SHA-256 读取，避免把大纹理等素材整份装入内存；仍逐字节计算摘要，保持原有路径边界、排除域、错误分类与只读行为。

复制阶段也不再保留整文件 Buffer：单条源分块核验后，立即复核真实路径和普通文件类型，以 `COPYFILE_EXCL` 排他复制，再分块读回候选。源会增加一次系统复制读取；收益是限制进程缓冲内存，不能据此推断整体提速。副本字节/哈希不符仍拒绝发布，原有 SHA 诊断、失败暂存保留与原子发布规则继续适用。

显式 `--apply` 才实际复制：先复用现有清单核验，重复路径、非法/越界路径（含编码分隔符）、排除域（`assets/character-references`）、非空 unverified、文件缺失、字节或哈希不匹配任一失败即整体拒绝；通过后把清单已列普通文件复制到 `<root>/scripts/archive/resource-packs/<包名>/` 新目录，保留 `assets/...` 相对结构，不遍历补入未列文件，并写入可被 `audit:resource-manifest --root <包目录> --manifest manifest.json` 再次核验的 `manifest.json`。复制先写入本次专用暂存目录 `.staging-<包名>-<随机>`，逐条读回核验候选副本的字节与 SHA-256（复制时源已变化会被发现并终止），整体复核通过后才改名为最终包名，再做发布后核验；核验通过只输出「候选包已通过字节核验」，不代表图片质量、内容审核或部署完成。

`--base-manifest <root内旧JSON>`（与 `--manifest <新JSON>` 同用，缺 `--manifest` 退出 2）切换为增量候选包：复用 `audit:resource-manifest` 的纯比较，只把 added/changed 项写入候选，`unchanged` 不进候选文件，`removed` 仅作为差异记录，不删除任何源/目标资源。旧清单只做结构核验（schemaVersion、条目形态、重复、路径合规），不读取其对应的磁盘资产（removed 文件可已不存在）；新清单仍按全包同套完整核验，不能用增量绕过新清单损坏；任一清单结构错误或非空 unverified 即整体拒绝。候选 `manifest.json` 只列实际复制的 added/changed 项，可被现有 verifier 再次核验；另写 `delta.json` 记录旧/新清单内容身份（按稳定 path/bytes/sha256 计算的 contentIdentity，不含 `generatedAt`）、四类数量与移除路径，供以后基线匹配用；两个元数据都在最终改名前读回核对。增量产物不是完整可安装包，也不能当作已安装更新；零差异时输出明确的零资产候选（无 assets 目录）。复制/暂存/发布协议、目标冲突与 junction 拒绝与全包模式相同。

安全边界：包名限字母、数字、下划线、短横线（1-64 字符），拒绝路径片段；目标只要已存在（含空目录、文件或链接）即拒绝，不覆盖任何旧包；目标祖先链中已存在的符号链接/junction（realpath 与字面路径不一致）先于任何写入被拒；复制期间源变化、候选写入失败或发布冲突都不报告成功，暂存目录保留并在结果中给出明确路径（残缺暂存不是可用候选包），不删除任何目录。不转换或重采样图片，不执行复制内容，无 ZIP 解压/安装/缓存淘汰与网络行为，写入范围限 `--root` 内候选目录。

退出码：0 表示预览计划可行或候选包已通过字节核验并落盘；1 表示目标或内容问题（清单核验失败/格式错误/不支持版本、目标已存在、目标链含链接、复制或发布后核验失败；增量模式含任一清单结构错误或非空 unverified）；2 表示参数或环境问题（包名非法、参数缺失或无法识别、root 不可用、清单路径越界或不可读）。隔离回归：`node scripts/tests/test-resource-pack.js` 与 `node scripts/tests/test-resource-pack-delta.js`（已登记 unit 套件，全部夹具位于临时目录，不导出真实素材）。

## 增量候选包与基线兼容核验

`node scripts/workflow.js resource:verify-delta --base-manifest <root内JSON> --pack <root内候选目录> [--root <目录>]` 只读核验 G13 增量候选包与给定基线的兼容性，全程零写入、无安装/删除/网络；`--help` / `--plan` 仅打印用法，不读取目标文件。本入口仅核验增量候选：候选包内缺少 `delta.json` 的全包按 `missing-delta-json` 拒绝，不能冒充增量。核验通过只表示「相对于给定基线可重建声明目标且候选已列字节匹配」，不是数字签名、可信来源、当前安装状态或质量验收；空候选与仅删除候选可合法通过，不代表已安装更新。

核验分两层。元数据兼容层（纯函数）：先复用 `audit:resource-manifest` 同套结构检查（schemaVersion、条目形态、重复与 Windows 大小写重复、路径合规、非空 unverified），再核对 `delta.json` 的 kind/schemaVersion 与身份/数量字段形态；验证基线 `contentIdentity`/`entryCount`/`totalBytes` 与 `delta.baseManifest` 相符；以基线移除 `delta.removed` 后叠加候选 added/changed 重建目标条目，其身份三项必须与 `delta.newManifest` 相符；按基线→目标的实际集合关系重算 added/removed/changed/unchanged，与 `delta.totals` 逐项一致，且 `delta.candidate` 的 files/bytes/zeroAssets 与候选 manifest 实际条目一致。不只对比总数：removed 每项必须确实存在于基线且 bytes/sha256 相符，路径唯一且不得同时出现在候选中；候选与基线同路径同内容的条目不能冒充 changed。IO 层：只读取明确指定的基线 JSON、候选 `manifest.json`/`delta.json` 与候选已列资源（复用现有清单核验逐条核验候选实际字节）；不 stat/read 基线资产、不扫描安装目录，基线文件可已不存在而元数据仍可核验；基线清单、候选目录与内部路径遵守 root 与真实路径边界，junction 或坏路径访问外部目录在读取前拒绝。

退出码：0 核验通过；1 内容/不兼容（元数据缺失/损坏/不支持版本、清单结构错误或非空 unverified、基线或重建目标身份/数量失配、totals/candidate 与实际不符、候选实际字节核验失败）；2 参数/越界/环境（参数缺失或无法识别、root 不可用、基线清单越界/缺失/不可读、候选目录越界/缺失/不是目录/junction 逃逸、内部异常）。隔离回归：`node scripts/tests/test-resource-pack-verify.js`（已登记 unit 套件，候选包由 G13 导出器在临时夹具内生成，记录型 fs 证明旧资产零访问与全程零写入）。

## 办公机工程阶段入口（2026-09-15）

2026-09-22：日常人物／服装／场景维护统一入口与文件位置见[人物接入工作流](guides/characters/character-onboarding-workflow.md#日常维护入口)。参考库已按人物分片；新人物登记复制已有身份数据，不编造提示词、URL 或审核状态。只读预览不构建，显式 apply 不涉及模型/安装/发布；参考登记事务与后续聚合构建分阶段执行，失败后可修复并重跑。

本阶段衔接后端、场景管理界面、资源服务及维护工具；工程验证在办公机隔离环境执行，真实模型、资产质量和主力机安装/设备验收分别留存。

场景维护使用 `/api/maintenance/scenes/preview`、`/changes` 与独立 `/import`；旧 `/scenes` 全量请求保持兼容。预览与变更集接收 `{baseVersion, changeSet:{version:1, scenes:{upsert:[],remove:[]}, blueprints?, tags?, curation?}}`。upsert 是完整记录，未知字段保留，remove 只能列现有 ID，旧基线返回 409。普通界面保存仅提交实际变更，完整导入单独确认；读取和保存使用同一完整快照及基线，冲突保留草稿，在途编辑不被旧回执覆盖。预览显示新增、修改、退役、相关引用及未知检查范围，不冒充真实画面验收。前后端均支持 sc1000+ 规范安全整数，已退役 ID 不复用。桌面安装版与 Web 共用快照、预览、变更集和备份接口；安装版首次启动从包内 data 原子初始化到 `AICS_RUNTIME_ROOT/content/data`，后续以该用户副本为权威，保存不修改安装包。重启及升级不覆盖已有副本；包内新增内容不会自动合并，可通过维护页显式导入。损坏或不完整副本不回退写入安装包，须检查备份恢复；原生恢复 CLI 的 `--root` 应指向 `AICS_RUNTIME_ROOT/content`，`--runtime-root` 仍指向运行目录。保存后会作废场景与元数据缓存。源码构建操作仍不属于安装版能力。

成片下的「保存为场景」读取该图提交时冻结的角色、服装、提示词与参数；只需填写名称、画面说明并明确选择分级，再检查并保存。工作室角色进入场景库，热门角色进入对应蓝图库，可同时保存样张；图片上传失败单独重试，不重复新增记录。`generatedRecipe` 保留原始生成来源，使用独立白名单校验，不要求补写日文或长故事，也不执行旧提示词自动补全。分级只升不降，pin/本机权限/冲突/事务仍生效。维护页中来源提示词与角色只读，名称和说明可编辑；重新选择会恢复已记录的引擎/参数，提示词仍按当前规则重编译，不保证与原图完全相同。反推词参与了该次生成时会包含在来源提示词中；直接上传图片反推后保存尚未接入。

角色档案「更换立绘」进入维护页的「角色图片」。`GET/POST /api/maintenance/character-art` 使用 `{baseVersion,id,image}` 上传 PNG/JPEG/WebP data URL，或 `{baseVersion,id,reset:true}` 恢复内置；仅本机可访问。Rust 在用户运行目录 `character-art` 保存不可变版本，校正方向并生成透明 PNG、最长边 560 的缩略图及 128×192 以内粒子点阵，整组发布后原子切换清单，安装资源不变。图片最大 15 MiB、边长 8192、3200 万像素；极小/极细或全透明素材拒绝，旧形象保留。粒子使用实际图片色彩与透明度，不调用自动抠图模型。角色图片、缩略头像及粒子按同一 revision 刷新，其他窗口经消息/聚焦重新读取，远程继续使用内置资源。独立首页背景、场景样张、参考审核和 Live2D 模型保持各自入口。恢复内置撤销清单覆盖，旧版本文件保留；跨进程 OS 锁随退出释放。

保存同步场景/蓝图源分片、聚合、现有压缩伴生文件并重新计算 DATA_VERSION；客户端版本由 `virtual:data-version` 注入，不写回 `sceneStore.ts`。进程内队列结合持久化跨进程 lease/journal 和精确文件备份；活进程或未能证明已退出的进程不被抢锁。保存中或存在未恢复事务时，受保护内容读取拒绝返回半写状态。`/api/maintenance/recovery-status` 是本机只读状态入口；损坏元数据不会被自动清除。实际断电和文件系统持久性仍需设备验收。

`maintenance:recover --root <绝对项目根> --runtime-root <绝对运行目录> [--showcase-root <绝对样张根>] [--backup-id <ID>] [--out <新计划文件>]` 现调用原生 Rust 恢复 CLI，默认只读预览并输出 JSON；`--out` 不覆盖已有文件。审核后用相同根参数和 `--apply-plan <保存的签名JSON>` 显式应用，不能同时带 `--out` 或 `--backup-id`。重新核对签名、根身份、备份/当前字节、PID 与 nonce；活进程、未知锁、损坏 journal 或漂移拒绝恢复。需先 `rust:build`，也可直接运行 EXE 的 `maintenance-recovery` 子命令，无需启动网关。旧 Node 恢复工具不覆盖新启动聚合的词条备份范围。工作流 `--plan` 仍是零执行命令预览；退出 0 为可用预览/成功，1 为阻塞/失败，2 为参数错误。

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

记录式内容管理使用 npm run wf -- content:catalog --help。stats/query 读取工作库（首次使用会初始化）；record/history 读取完整记录与历史，character 返回含修订号的整位角色快照。query 支持排序、分页和带时区的创建时间范围；createdAt 仅允许以有来源的时间补录空值。patch/import 默认预览，--apply 写入；export --out 显式导出逐条项目快照，--character / --record 可重复选择并合并到既有快照，保留范围外内容；check 检查结构与关联，colors 复用原生配色检查。--root 默认当前项目，--runtime-root 必须显式指定，命令需要 Rust/Cargo。check:rewrite 可直接读记录快照及编写前 baseline-file，按角色/ID/SFW 选测并用 compiled-out 输出双引擎文本，不调用模型。权威边界和操作格式见[维护手册](maintenance.md)与[内容库设计](architecture/CONTENT-CATALOG-DESIGN.md)。

### 角色语音引擎

`npm run wf -- voice:service -AIWorkspaceRoot <AI目录> -RuntimeRoot <运行目录> -TtsHost http://127.0.0.1:9880 -Engine voxcpm2` 默认只探测状态。显式 `-Action Start` 加载已有 VoxCPM2 基座和角色 LoRA，写入 PID/日志；`-Action Stop` 只停止本应用启动的 VoxCPM2。GPT-SoVITS 使用 `-Engine gpt-sovits`，沿用 AI/Voice 的启停脚本。入口不下载模型，也不卸载绘图服务。

控制室保存 `ttsEngine` 与角色 `loraWeightsPath`、参考音频和原文，重启应用后生效；切换引擎前先停止原服务。VoxCPM2 默认基座位于 AI/Voice/models/pretrained/VoxCPM2，环境位于 AI/VoxCPM-env。宁宁和夏目使用各自 LoRA，单个基座依次切换，避免同时驻留两份模型。

`models:check` 按已保存的 `ttsEngine` 报告声线文件：VoxCPM2 检查参考音频和角色 LoRA，GPT-SoVITS 检查参考音频、GPT 与 SoVITS 双权重；未配置引擎时沿用 GPT-SoVITS。文件存在性、参考原文配置与实际语音验收分别记录，不会启动模型。

本机 PyTorch 2.7.1 + CUDA 12.8 使用 `triton-windows==3.3.1.post21` 启用模型官方 `torch.compile` 加速，版本对应见 [Triton Windows 文档](https://github.com/triton-lang/triton-windows#3-pytorch)。编译线程限为 1；首次预热会生成 AI/Voice/cache/voxcpm2 缓存，启动入口等待上限为 360 秒，后续复用缓存。无需更改 LoRA、参考音频或 10 步采样来加速。

聊天通过 `/api/tts-stream` 接收 48kHz 单声道 PCM 分片，第一片即可播放；下一句在当前句播放时预取。完整句保存为 WAV 供重播，取消的半句不进入缓存；`/api/tts` 保留整句播放与工作台变速。首句仍需积累足够台词，中文还需日语翻译；分片传输不代表零延迟。真实音色、首片延迟和显存占用需在用户绘图结束后另测。

### Rust 运行时迁移

产品后端为 `runtime-rs/`，Node 用于前端、维护工具、假上游及构建编排。仅工具源/配置变化或所需入口缺失时准备 `npm run build:runtime`；普通 Rust 检查不默认重建工具。按需运行：

- `npm run wf -- rust:check`：Rust 格式、Clippy 和隔离行为测试，不连接生产库或真实模型；显式原生素材/DLL用例与普通默认用例分开记录。
- `npm run wf -- rust:build`：按 `runtime-rs/Cargo.lock` 构建 release 二进制及 `runtime/rust-evidence/build.json` 源码/EXE绑定，不替换桌面安装。需已有 Rust/MSVC 工具链，首次可能下载锁定 crate。
- `npm run wf -- rust:parity`：使用现行 Rust 候选和带来源的旧 schema-3 固定夹具，核对 HTTP、回执重试、媒体 Range，并独立用 SQLite 读取 Rust 写入结果；不启动退役 Node 产品后端。可设 `AICS_RUST_RUNTIME_EXE` 指定候选，`AICS_RUST_PARITY_REPORT` 保存 JSON，保留实际分页行数/轮次；不视为整机内存或完整迁移收益。
- `npm run wf -- rust:licenses:collect`：PowerShell 7 按 `components.json` 的固定配方下载公开源码并提取许可材料，跳过已核验项；不安装或执行源码。缓存不入 Git，材料变化后必须更新 `materials.sha256.json` 及根 manifest 绑定。完整来源和发行待办见[原生材料说明](../runtime-rs/native-licenses/README.md)。

`rust:check` 仅在检查子进程环境中把 TEMP/TMP 规范为实际目录路径，避免 Windows 8.3 短路径令隔离夹具误触物理路径守卫；默认 Cargo 构建并发 2，避免多份集成测试同时链接超出 Windows 提交内存/页面文件额度，可通过已有 `CARGO_BUILD_JOBS` 选择实测安全并发。不改变生产路径校验、start/build 环境或用户资料目录。

PixAI 接入后，旧 WD14 ONNX／448 像素预处理代码已退出 Rust 产品链，其两份引用已删除模块的集成夹具与专用 toy model builder 也退出默认 Cargo 发现，由 Git 历史保留；不通过恢复兼容模块或缩小 all-targets 来绕过。现行 PixAI 子进程、Python worker、libvips atlas／thumbnail 与 Live2D 像素断言继续保留。仍在使用的 `interrogate/golden.mjs` 及原生像素夹具变量不因旧名称改动。

设置 `AICS_RUST_BROWSER_REPORT=<新证据目录>` 会在同一 parity 运行中调用 `browser.mjs`，用真实 Rust 服务执行图库/控制台双主题操作并保留截图；`AICS_RUST_APP_ROOT=<已暂存gateway>` 可验证该布局及其中的 EXE，未设置时使用源码应用根。夹具设置关闭真实模型/隧道并使用临时配置和 workspace，不能把它改指用户资料作普通回归。

- `npm run wf -- desktop:rust-bundle`：使用已暂存的实际 Rust EXE/DLL和 bundle 映射，在仓库外临时布局验证；不下载、安装或访问用户库。它替代旧 `desktop:workspace-sidecar`，不能以开发机上的 Node 启动成功替代原生包验证。

源码服务用 `npm start` / `npm run start:run`（开发包装器调用 Cargo/Rust）；直接入口为 `runtime-rs/target/release/huiyu-runtime.exe --app-root <项目目录> --bind 127.0.0.1:3210`。工作区须显式私有路径/身份或受控桌面激活；未知请求不落回 Node。`build:runtime` 仅生成维护、测试和独立浏览器工具 JS，不会产出 Rust EXE。

旧后端行为由标注来源的固定夹具承接，现行端到端由 `runtime-rs/tests/parity.mjs` 与其 `browser.mjs` 验证；最终结果、失败及默认浏览器测试栈切换分别记录，不能按路由挂载数量宣称完整覆盖。当前实现与安装身份见[项目状态](project-status.md)，剩余范围见[未来规划](roadmap.md)。真实模型、完整设备与原生许可材料仍未收口，`releaseReady=false`。

既有 `test-domain-type-boundaries` 也检查 Rust 任务契约、公共执行、存储与引擎模块的显式依赖方向，复用原边界门禁，不新增全仓测试入口。它识别 crate/super 路径和分组导入，不解析宏展开或完整符号依赖；编译与行为仍由 Cargo 验证。图片/视频编译及视频 AI 契约使用固定的独立旧实现期望，不再动态启动其 Node oracle；旧产品后端及其动态 oracle 已退出；仍有用途的维护工具对照独立保留。

### 按改动选择检查

性能资源诊断复用 `npm run test:e2e:performance -- --project=fluidity-office --grep "dark full round 1$"`，单 worker、隔离夹具、默认 20 轮，不与构建或其他浏览器测量并发。`AICS_OFFICE_RESOURCE_SAMPLES=20..100` 选择有证据需要的持续轮次；`AICS_OFFICE_HEAP_SNAPSHOTS=1` 显式保存基线/结束的 V8 堆快照，`AICS_OFFICE_IDLE_MS=0..30000` 增加静置后 GC（可同时保存第三份快照）。默认不启用两项额外诊断。快照会扰动运行，资源结果不能当作无探针时延或原生 GPU 验收；输出保存在 `runtime/ui-fluidity-office[-轮数]/`。

内容契约 CLI（`check:content` / `test:content`）支持 `AICS_DATA_ROOT || AICS_APP_ROOT || 仓库根`。该根须提供完整 data/assets/src/stores 布局；数据、压缩产物和 DATA_VERSION 核对均使用所选根，缺文件失败，不回退到仓库数据。校验规则代码仍从代码仓库加载；显式外部素材路径配置仍生效。隔离回归 `test-content-contract-root.js` 验证根优先级、损坏定位、零写入及不读取仓库数据域。

按影响面选验证，不按“改了代码”或“准备提交”一律升级；新增测试、证据复用与失败止损遵循 [协作指南](../AGENTS.md#风险验证)。失败先分类并缩小范围，没有相关修复或新诊断证据不原样重跑；同一失败再次出现须报告原因、影响和下一步，不用全量重跑或无关改动追求绿灯。

| 本次改动 | 验证边界 |
| --- | --- |
| 文档、AGENTS、skill | 结构、链接、规则一致性及典型请求走查；不构建、不出图 |
| 局部颜色、间距等样式 | 相关样式/对比度检查和受影响组件的双主题视觉检查；不默认跑 TypeScript、后端契约或全站回归 |
| UI 行为或局部业务逻辑 | 定向行为测试，或显式选择 `gate:quick ui/rust/data`；补受影响的浏览器流程 |
| 已登记 Rust 读取模块 | `rust:check --file <仓库相对路径>`；近期作品读索引复用 storage_preferences，内容查询/筛选缓存复用 catalog 现有用例；共享写入/存储/依赖等未知范围保持完整 runtime 检查 |
| Tauri / Native Live2D Rust 源码 | 自动选择 native；`rust:check-native --target host\|renderer` 编译对应 Cargo 目标，host 同时覆盖 renderer 依赖；缺 Windows/SDK/Cargo 时退出 3、记录未运行；设备/真实模型另验 |
| 依赖、跨域重构、未知影响面，或用户明确要求完整验证 | `gate:full`，再按风险补浏览器/设备验收 |

构建用于验证产物或准备同步，不能代替视觉/设备验收。同一内容的检查不因提交而重跑；后续修复只重跑受影响范围。已核对隔离与权限边界的测试可直接执行和修复，无需逐步请求批准。

日常使用 `npm test` 或 `npm run validate`（与 `gate:quick` 同一入口），默认按当前 Git 改动选择测试。前端 TS/Vue 使用 Vitest 原生导入图运行相关单测；UI 门禁在类型检查前仅补齐缺失的 `data/popular-characters.json`（复用 `ensurePopularBuilt({ onlyIfMissing: true })`），不重建其他数据域，也不覆盖已存在的陈旧产物；CSS 独立选择 `style` 的字面值、双主题对比度、颜色、动画扫描，不跑无关类型检查/单测；其他静态资源与显式 `ui` 仍运行整个前端套件。没有相关单测时明确显示只完成类型检查，不能当作浏览器验收。已登记的 Node 测试按文件选择并去重；critical/nightly 中的 E2E 测试本身变化只跑所改文件并复用已有 dist，混合 UI/style/data 改动先构建。已登记工具/CI消费者按现有用例定向；应用/Vitest配置选UI，Node整体构建配置仍保留full；未登记共享夹具、注册表、依赖、未知或删除的测试仍升级 full；manual/device 测试源修改只验证浏览器测试类型，不执行专项；真实设备与模型仍显式选择。

Node套件也可直接定向：`npm run test:unit -- test-api-client.ts`、`node scripts/tests/run-quality-suite.js check test-native-controls.ts`。支持登记的源文件或生成入口、稳定去重；错误文件名、跨套件文件及未知选项失败，不静默跳过。省略参数执行所选lane完整清单，整合验证使用 `gate:full`。unit/contract/optional 不自动 prebuild；工具源或配置变化、生成入口缺失时才先 `npm run build:runtime`，纯 Rust 检查不附带 Node 构建。

短期限的 `test-generation-workflow-safety` 独立于 Node 并发批次执行，保留其 250ms 夹具期限与显式超时场景；Windows 的 `test-desktop-deploy-guard` 使用真实 PowerShell 进程探测，也单独执行。其他文件仍并发 4。每个选中文件只执行一次，整体仍共用原 300 秒上限，阶段失败/未运行分别记录，不放宽退出与锁清理断言。

自动模式进一步比较已有 Vue 文件与 HEAD：仅 style 内容变化时选择 style；script、template、自定义块、style 属性或 CSS v-bind 依赖变化，以及 module 样式、新增/缺失基线、解析异常，继续选择 UI。显式 ui 的范围不变；纯样式仍需受影响页面的双主题视觉检查。

### 验证并发与复用

直接运行 `node scripts/maintenance/gate-quick.js --plan [--base <HEAD或完整SHA>]` 输出纯JSON选测范围及干净checkout所需的前置条件；只读Git与源码，不准备产物或执行测试。CI默认从 `AICS_HYGIENE_BASE_REF` 取基线；基线不可用时明确回退full，参数错误仍失败。统一workflow的 `--plan` 仍只预览命令，不替代这个选测报告。

`typecheck:app` 保持全部应用及前端测试的严格类型检查，通过 `.cache/typecheck/app.tsbuildinfo` 复用编译器信息。每次重新读取当前输入并保留错误退出码，不缓存PASS；冷启动仍完整检查。CI按工具链、依赖和配置恢复编译信息，源文件变化由编译器核对。

原生选测不会把通用 full 当作原生编译通过；即使混有需要 full 的改动，也保留 native 目标。Linux 等缺原生条件的执行器会得到未运行状态与退出码 3，需在有既有 SDK/工具链的 Windows 环境完成对应编译，不自动安装或调用设备。定向 Rust 选择仅登记已有覆盖的读取路径，匹配不到用例时拒绝通过；格式与库级类型/Clippy 检查继续保留。

quick的独立领域分别保留结果：测试失败或准备异常不记为通过，但其余已选领域继续；混合改动的页面构建失败只将依赖新dist的浏览器标为未运行。中断仍停止后续派发，完整full仍保持失败即停。失败须说明现行要求、与本次改动的关系及影响范围，不用无关全仓重跑替代归因。

文档链接检查在生成JS缺失时，仅接受已登记生成范围内存在的对应TS权威源；缺源、非生成范围和真实断链仍失败。新checkout的纯文档CI可直接运行TS工具，不必为这些链接先安装依赖或编译全部工具。

`npm run check` 的 `CHECK_JOBS` 默认 4、有效范围 1–4；首次失败停止待派发步骤，收完已在途任务并分别报告失败/未运行。`npm run check -- --all` 显式收集全貌；每步限时 10 分钟，超时只清理该执行器拥有的进程树，不原样循环重跑。

Quality CI 日常复用同一选测计划与 npm test，文档免依赖安装，Rust/浏览器/SPA仅按前置条件准备。quality-summary 必须要求所选任务成功；未选的最低 Node 专项仅允许 skipped。完整门禁、关键浏览器与最低 Node 兼容留在手动及北京时间02:15夜间入口；02:00扩展视觉继续独立执行，完整前端覆盖率集中到Quality。Rust专项只在相关路径变化时验证parity，日常rust:check由Quality承接；真实原生/GPU专项仅手动触发，不进入普通推送。

Rust Runtime 的准备步骤仅编译 Node 维护工具（`build:runtime -- --project node`），该 lane 的 Rust/parity 不消费生成的 Node 测试或浏览器工具。Quality 的 Cargo 缓存使用独立的 `quality-runtime` 主键和恢复前缀，避免命中另一个 lane 的 release-only 缓存后反复从零编译 debug/check 产物；首次使用新键仍需准备缓存，不代表已测得远端提速。

`test-interrogate-engine` 默认只在临时空目录验证无模型降级，并屏蔽模型目录环境变量；`test-interrogate-routes` 始终用 WD14 替身和本地 HTTP 夹具。只有显式设置 `AICS_TEST_REAL_WD14=1` 再运行 `node scripts/tests/test-interrogate-engine.js`，才会查找本机权重并执行真实 CPU 推理；该开关不属于普通 unit/contract/full 门禁的默认验收。

`test:contract` 和 `gate:full` 共用契约执行器。`CONTRACT_TEST_JOBS` 默认 2，有效范围 1–4；只有 `scripts/tests/contract-test-policy.ts` 已记录临时目录、独立进程和动态端口边界的文件进入并行批次，较慢文件先启动。该批次结束后，其余文件按原顺序串行；新测试默认串行，修改已有夹具的隔离边界时须重新复核登记。设 `CONTRACT_TEST_JOBS=1` 可按完整原顺序执行，便于对照或低内存机器排障。

失败时停止派发新测试，等待已启动的夹具结束；`--all` 继续执行全部文件。超时、信号、输出超限与启动失败均为失败，未执行项单独计数。中断或超时只终止执行器自己启动的进程树。并行契约的 `--verbose` 按文件完成后输出整块日志，避免混杂。单文件时限与单测已有并发不变，目录准备和真实断言没有省略。

生产构建的预压使用 `PRECOMPRESS_JOBS`（默认 2，范围 1–4）限制同时处理的文件数，继续使用 Brotli 11 / gzip 9，不缓存测试 PASS、不依赖文件时间戳跳过压缩，也不放宽包体预算。同步 `compress()` 接口保持兼容，`precompress --check` 仍只读核对源字节、孤儿与陈旧产物。

同一批内容已有通过证据时，后续局部修复只重跑受影响项；准备提交本身不要求再次构建。定向与完整门禁共用当前登记清单，删除/合并须记录保留覆盖与当次验收。耗时比较使用同机、同输入和相同参数独占测量。

测试精简已逐项核对当前前端、Node、浏览器与 Rust/Tauri/Python 的行为覆盖；重复用例合入所属套件，无消费者的旧后端/实验入口及其自测退出。现行测试 lane 直接登记，日常使用 `npm test` 按实际改动选测，类型、AA、权限和数据安全断言保持。

| 入口 | 实际范围 |
| --- | --- |
| npm test / validate / gate:quick ui/style/rust/data/all | 自动模式按文件选相关前端、样式、Node、Rust、常规 E2E；Rust 源码、Cargo 与 Rust 隔离夹具只派发 rust:check；显式参数选整个领域；已登记工具与域配置选相关检查；依赖及未知影响面升级full；文档只查链接 |
| check:quick | npm run check 的全部已注册并行检查 |
| gate:full / gate:all / check:full / validate:all | 同一 full 入口：check、Rust、前端覆盖率、unit、contract、tooling、release，最后一次 build:web:run（含打包预算）；默认失败即停，--all 收集全貌。不含浏览器、设备或真实模型验收 |
| test:tooling / test:release | 维护工具、发行/资源包专项；不作为纯前端改动的固定成本 |
| test:optional | 已登记测试自身变化精确到文件并去重；已登记工具消费者定向；其余工具/桌面消费者源码改动执行相关完整专项。纯 Rust 源码/Cargo/隔离夹具由 gate:quick 的 rust 区域处理，原生发行材料仍派发 release；未知影响面、无有效CI基线及配置变更保守全跑 |
| build:web / build:runtime / rust:build | 前端预算/预压；Node 开发维护脚本编译；Rust 产品后端 release 构建。三者不相互替代，`start:run` 启动 Rust |
| check:style-debt | 样式字面值趋势、颜色、动画和双主题全局/角色令牌对比度；包含 Vue/TS 工具类及 `@apply` 取样，维护约定见 [Tailwind 样式维护](guides/engineering/tailwind-styling.md)；字面量默认只报告，`npm run test:style-debt:strict` 才阻断；动态组件另做视觉验收 |
| check:monolith / check:pinned-scenes / check:rewrite | 体量检查覆盖应用、服务及 `scripts/maintenance` 维护入口、`scripts/lib` 支撑模块；定稿与改写完整性继续独立检查。rewrite 交付需传 --delivery，基线经本地 Git 读取（默认 b1ccfc0，--baseline 可改） |
| check:domain-types | 指定公共作品/生成类型、结果快照及保存用例的可达依赖；复用 AST/真实路径/别名/再导出/Vue 脚本解析；禁止直连具体存储/API/Node 平台；类型边单列，违规、未知路径和运行候选循环阻断 |
| check:popular / check:anima-routes / check:frontend | 热门、Anima 接口与前端单测 |
| test:contract / test:e2e:critical | 契约套件与关键浏览器回归；test:e2e:critical 工作流走无 build 的 `test:e2e:critical:run` 入口，复用已有构建产物（npm 脚本 `test:e2e:critical` 才先 build） |
| test:e2e / test:e2e:all | 默认 `test:e2e` 构建后只跑 critical；已有构建的 `test:e2e:all` 运行 critical + nightly，不包含 manual/device |
| test:e2e:performance | 已构建产物的单 worker 冷／热进入与首次操作测量；与回归分开执行 |

质量套件可设置 AICS_TEST_REPORT_DIR 为隔离日志目录，保存逐文件状态、失败分类、超时、耗时和Node跳过数量；失败与未运行不改标通过。Quality的前端使用Git基线关联测试，无有效基线时全跑；完整前端覆盖率和既有门槛由夜间及显式全量入口执行。旧 Node 后端及 legacy lane 已退役，核心contract不准备旧SPA；核心Rust CI与Node22.18检查保留。JSON与日志按[报告契约](guides/engineering/maintainability-boundaries.md#测试职责与报告)接入capture:delivery，报告不代替实际执行。

E2E 仅覆盖桌面客户端与桌面浏览器，不再运行 phone/tablet 项目或手机、平板专用尺寸及触屏用例。保留桌面窄窗口、分屏、双主题、键鼠可达性与减少动态效果检查；桌宠原生小窗口尺寸不属于移动端，继续覆盖。不要把手机尺寸替换成同数量的桌面尺寸来扩大矩阵。

分组清单为 `tests/e2e/e2e-lanes.json`：critical 保留生成/保存、并发数据安全、草稿与状态、主导航和键盘操作；nightly 保留主题、资源恢复与扩展交互；manual 保存按变更选择的独立专项；device 仍需明确的设备或模型资产条件。无断言的 `capture.spec.ts` 已删除。`npx playwright test tests/e2e/<文件>.spec.ts --project desktop --workers 1` 可显式运行普通浏览器专项，可再用 `--grep` 选择相关场景；真实维护和 Live2D 等继续使用各自的隔离入口。裸 `npx playwright test` 默认只发现 critical + nightly，与 `test:e2e:all` 一致；显式文件、正则或 `--test-list` 仍可选择 manual/device，设备专项配置保留，运行条件与授权不因显式选择而省略。

精确指定常规页面 E2E 文件时，只启动隔离 web Rust 服务；仅选择 flows 文件时，只启动 gateway 与模拟上游。少数 desktop 文件显式请求 gateway，保留双栈。未知/正则文件过滤、测试列表和仅 `--project desktop` 无法证明所需范围，保守保留原双栈；不复用已有服务，不降低分级、权限、并发存储、AA 或故障断言。当前执行入口由 run-e2e-lane 维护。

小改动先选测试，不先运行整套：工具/composable 逻辑用 `npx vitest run <相关spec>`；局部 UI 只运行相关 E2E 文件或场景，真实颜色/布局保留双主题，纯数据和状态逻辑不重复主题。提交本身不增加检查范围，同一产物已有证据可复用。`test:e2e` 的 critical 清单也不是每次局部修改都必跑；跨层核心改动与 PR 门禁才使用 critical。当前清单由 run-e2e-lane 枚举。

应用页面错误、溢出和可读性巡检统一在 `theme-audit.spec.ts`，文档由 `page-experience-docs.spec.ts` 一次完成主题、错误、键盘及实际 AA 检查，不重复页面巡游；`ui-layout.spec.ts` 仅保留独有的对比度、侧栏和交互检查，均为扩展回归。独立 UI 预览可用 `AICS_UI_AUDIT_URL` 指向隔离服务；默认检查本机 3000，不依赖 networkidle 等待长轮询停止。

`github-reference.spec.ts` 属于扩展回归：统一词条、固定种子候选、配方兼容检查和 PhotoSwipe 试验。图库使用中性本地图片夹具，保留鼠标缩放、键盘操作和双主题各 20 次开关；DOM/Blob URL 趋势保留在 `runtime/github-reference/`，不代表真实模型或 GPU 内存验收。

资源故障与恢复的定向用例在 `tests/e2e/resource-recovery.spec.ts`：角色列表头像、场景卡片、参考卡片与画册灯箱，共四种流程的深浅主题检查。使用本地响应夹具，确认故障请求命中并验证恢复后的图片加载。可运行 `node node_modules/@playwright/test/cli.js test tests/e2e/resource-recovery.spec.ts --project desktop --workers 1`；需要已有 dist，设置独立 AICS_E2E_PORT_OFFSET 可隔离服务端口与运行目录。该文件由默认 e2e 发现，未加入显式 critical 清单；不代表参考灯箱、Live2D 或全部离线资源验收。

首页英雄图/热门横条回退见 `home-image-recovery.spec.ts`，角色详情主图/缩略图失败及恢复见 `character-detail-recovery.spec.ts`；`image-fallback-visual.spec.ts` 覆盖两处新增文字 AA 对比度、标签避让与普通桌面/2560×1440 DPR1.5 的双主题截图。它们沿用上述 Playwright 定向入口，默认 e2e 可发现，未加入显式 critical 清单。DPR1.5 是浏览器等效视口，不替代主力机 Windows DPI/WebView2 验收；装饰遮罩与实际图像叠字仍需查看截图。

`illustration-recovery.spec.ts` 补充场景手帖两角色图片失败/切换/恢复与 404 页插图回退、返回导航；纯恢复逻辑执行一次，1440桌面占位/台词避让和 AA 检查保留双主题。404 插图的固定 src 会被构建成带哈希的资源地址，拦截测试须兼容实际打包路径，不能只核对源码 URL。

`workbench-loading.spec.ts` 检查生产构建的实际脚本请求：未打开的素材分类、专家面板和结果弹窗应保持未加载；首次打开后切换分类不丢搜索或草稿。覆盖场景／专家模式与深浅主题，防止只拆分文件却仍在首屏请求全部分片。

`office-code.spec.ts` 同属关键浏览器入口，覆盖文档安全策略、存储受限导航、键盘出图入册、按需对比面板及脱敏诊断下载；麦克风策略使用浏览器模拟设备与真实响应头，不读取操作员麦克风。`library-concurrency.spec.ts` 使用真实双页 IndexedDB/Web Locks，验证并发入册、收藏、软删恢复、备份合并与失败重试；页面壳是隔离夹具，仓储源码和存储未替换。`office-performance.bench.ts` 经独立性能入口执行，记录本机 runtime 下的冷／热进入与首次操作耗时，不与浏览器回归争抢资源。生成链路使用模拟上游，不代表真实模型或桌面安装验收。

`ui-fluidity-office.bench.ts` 默认每组 20 次往返；显式 `AICS_OFFICE_RESOURCE_SAMPLES=100` 可延长到 100 次（范围 20–100），每 10 次和最终检查点采集 GC 后堆/DOM/监听器。非默认样本数输出到 `runtime/ui-fluidity-office-<次数>/`，不覆盖旧 20 次证据。用 `--config=playwright.performance.config.ts --project=fluidity-office --grep 'full round 1$'` 选择深浅主题各一组；这不冒充默认完整三组或真实 GPU/进程内存验收。测试独占运行，不与构建、GPU 基准并发。

`npm run wf -- desktop:storage-benchmark` 独立运行桌面持久化候选比较：使用 Node 内置 `node:sqlite`、已安装 Playwright 浏览器（可设 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`）和临时目录，输出 JSON 后清理夹具，不连接生产网关、不打开真实浏览器资料。比较 1,000/10,000 条作品索引及 64 对原图/缩略图，各三轮；耗时不设 CI 阈值，运行时不要并发构建或浏览器测试。方法限制和推荐结论见 [剩余验收与规划](roadmap.md#pc-桌面架构整理后的验收)。迁移/任务日志故障注入原型已登记 unit 套件，均不接入生产运行时。

`npm run wf -- desktop:rust-bundle` 使用真实 bundle 映射和当前 Rust 载荷验证隔离安装布局；先准备 `rust:build` 与桌面 staging。旧 `desktop:workspace-sidecar` 已退出注册表，旧 Node worker测试仅作对照。临时库验证不能替代正式安装、WebView2 或物理断电验收。

`npm run wf -- desktop:renderer-process-check --exe <候选EXE> --assets-root <已有assets目录> --out <新证据目录>` 在 Windows 上验证 Live2D 独立渲染进程；先生成 Node 测试入口并构建支持 `--live2d-renderer-probe-host` / `--live2d-renderer-child` 的候选 EXE。脚本使用独立 config/profile、可见测试窗口与现有宁宁/夏目模型，记录 GPU 快照、帧数和 60/120/165 FPS 各两秒实测（可用 `--sample-ms` 调整），检验加载中杀子进程、超时、父进程存活、显式重连以及 Shutdown/EOF/父进程突然退出的无孤儿回收。GPU 快照须实际查看；帧率为测量值，没有把目标帧率视为性能门禁。只读模型资源，不启动已安装生产应用、不访问生产资料、不下载或调用 AI 生成。该入口与其他 GPU 测量串行，单独运行，不进入默认 unit/validate 套件；证据目录保留 JSONL、stderr、PNG 和结果 JSON。

R13 的旧 Node Electron PoC 已随旧后端退役删除，其历史对照仍可从 Git 查询。当前默认继续使用 Tauri；重新评估 Electron 需基于现行 Rust 协议另定范围，旧 PoC 不再登记为可执行设备验收入口。

`npm run wf -- desktop:thumbnail-benchmark` 复用生产 `galleryThumbnailWarmup.ts` 的调度核心，在临时 loopback 服务和私有浏览器上下文运行真实 IndexedDB 与图片解码；它测量 Web 预热，桌面 workspace 当前不做全库预热。1k/10k 历史共用 64 张中性 1024px 图，前台/后台/双页各三轮观察五秒；报告实际 visibility、读写/生成次数、重复图片读取、CDP JS 堆与脚本/任务时间及源码/夹具哈希。后台未实际 hidden 时标为 unavailable，不模拟后台性能，不把小图结果当作用户大图/GPU成本。独占运行后保存 stdout JSON；不新增性能阻断阈值。

`npm run wf -- desktop:restore-benchmark` 在新私有上下文按 1k/10k 历史各跑三轮，64 张确定性中性噪声 PNG 经真实 `buildBackupBlob → Blob.text → JSON.parse/normalizeBackup → restoreBackupData`，核对条目、原图字节数、图片重映射及旧原图保全。分别报告导出/读取/解析/恢复时间、实际备份字节与约 25ms CDP JS 堆采样；observedPeak 是观测下界，不含 Blob 原生后备内存、完整进程/GPU，也不代表 512MiB 峰值、可取消性或断电恢复。独占运行，无生产库访问。

`node scripts/maintenance/check-bundle-budget.js [dist目录] --json` 保留旧预算，同时报告入口与真实路由匹配链的静态 JS 文件并集（不计运行时动态请求）。映射来自 router AST；无 src 命名块只接受唯一匹配，缺失/歧义显式 unknown、总数 null，不能解释为零。新指标仅报告，包含文件集合、manifest/router 哈希；需将所选 dist 与相同源码配对，再用独占冷启动浏览器的 script 请求核对动态加载差异。

旧 SQLite 候选与模拟任务 journal 的重复原型测试已退役；`artwork-sqlite.ts` 仍供显式 storage benchmark 使用，基准内继续检查数量与字节，不能把候选原型当产品持久化验收。当前作品、任务与恢复边界由 workspace/持久任务及 Rust 存储测试负责；物理断电、浏览器恢复 journal 与 512 MiB 大包峰值仍是独立验收范围。旧逐文件删并决定可从 Git 历史查回。

`flows`、`anima-quick`、`office-code` 共用模拟上游，统一在 `flows` 项目的单 worker 中运行；其他页面和设备回归仍可并行。多会话验收时给每轮设置不同的 `AICS_E2E_PORT_OFFSET`（例如 `15000`），网关、浏览器和模拟上游按同一映射偏移端口，并使用隔离运行目录、拒绝复用已有服务。浏览器测试期间不得重建共享 dist；先完成构建再验收，并用独立 `--output` 目录保留每轮证据。

无参考素材的办公机可沿用 CI 的 `AICS_REFERENCE_AUDIT_MODE=structure` 执行结构校验；报告必须注明该模式，不能据此声明参考 URL 或图片验收通过。主力机不设置该变量，继续核对实际素材文件。

首次建立 worktree 仍按本次风险选检查：文档无需构建；所选 Node 工具缺少生成入口时才准备 `npm run build:runtime`；浏览器或产物检查需要匹配的 dist 时才执行 `npm run build`。缺少构建产物不自动升级为完整门禁。隔离验收副本只带入本任务文件，不能通过忽略其他会话的失败文件而宣称原共享工作区全量通过。

每周 Dependency Audit 同时检查运行时与完整依赖树，高危/致命阻断，并保留 JSON 报告 14 天。中危告警须按实际调用路径评估，不能把流程通过理解为零漏洞。

Dependency Audit 另以固定 `cargo-audit 0.21.2` 分别扫描 `desktop-tauri/src-tauri/Cargo.lock`（发行桌面壳）和 `desktop-tauri/native-live2d/Cargo.lock`（原生渲染器独立构建）；PoC 锁文件不冒充发行依赖。发现 advisory 或扫描不可用均失败，保留 JSON、stderr、退出码、工具版本、源码 SHA 和锁文件哈希。原生 SDK 不属于 Cargo advisory 数据库：`native-live2d/build.rs` 声明 Cubism Native 5-r.5，实际 SDK 字节与许可仍需发行机单独记录。两份 Cargo 清单与 npm 锁文件随 CI artifact 保存；14 天留存不能代替长期发行归档。

发行交接继续复用 `capture:delivery`：源码选择包含 npm/Cargo 锁文件与 SDK 构建配置，构建选择包含安装包、Rust EXE、原生 DLL/许可证清单、暂存资源及实际 Cubism SDK身份。Node是开发构建工具，不再填作随包后端。先捕获身份，再记录实际命令、环境、失败/跳过和日志；缺失安装包、SDK或原生发行材料保持 pending，不以声明值替代实测。

交付时将回执与选中的脱敏日志/哈希清单一并放入受控发行 artifact，或把脱敏摘要登记到 docs/evidence 并加入文档索引；仅引用 runtime 路径无法跨机器移交。接收方恢复相同相对路径后运行 `audit:delivery`，核对 source/build 和日志是否 fresh，分别填写 installation、deviceAcceptance、modelAcceptance。现有失效检查能检出选中源码、构建或日志字节变化；哈希不认证日志语义，也不补签未运行项目。

历史 Audit stability validation 已收口为人工触发、只读 token 和禁用 checkout 凭据持久化，仅保存重现补丁与证据，不提交或推送。普通 push/PR 不触发该历史工作流。`docs:check` 核对目标文件和 Git 忽略规则：本机存在的 runtime 日志/截图不能作为仓库文档的链接或图片，只记录路径与证据边界；受控生成 JS 仍可由权威 TS 源承接。`audit:workflow-conditions` 仅核对注册条件。标题锚点、描述语义、外部来源与实际运行结果另按范围检查。

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

聊天个人 API 密钥在 Windows 桌面版由系统凭据管理器按 API 地址保存，网页端只放在当前页面内存；浏览器持久设置保留地址/模型，不保存新密钥。旧明文记录只有安全写入和读回一致后才清除；失败保留可恢复旧值并提示重试，不降级为新明文写入。配置面板可独立清除个人密钥；备份导出排除尚未迁移的旧密钥。站主托管配置仍是服务端受限文件，与个人凭据迁移分开验收。原生测试仅使用唯一 `Huiyu/Test` 目标，不读取已有个人凭据；系统凭据库失败、升级与最终安装须另留真实 Windows 验收。

- `models:check [--json] [--verify-hashes]`：只读扫描硬件清单、ComfyUI 模型文件和 PixAI 回执/路径，按网关优先级报告配置缺失或无效、固定清单文件、Python/worker/timm/torch 文件状态；显式哈希检查才读取大权重。Python 包可导入性、CUDA/BF16与真实推理仍未验，不将文件存在称为引擎就绪；
- `models:download-wd14 [--target-dir <可写目录>]`：默认从固定 HuggingFace 发布者版本下载 WD14 MOAT v2（ONNX 约 311 MiB 与配套 CSV）；`--modelscope` / `--mirror` 可显式选择镜像，但同样核对固定字节与 SHA-256；`--plan` 不下载；
- `models:download-h3 --models-root <实际ComfyUI/models目录>`：下载当前工作流完整六文件（约 43.99 GB / 40.97 GiB，含 4/8-step LoRA），固定官方 revision 和 SHA-256；`--plan` 不下载。运行依赖与硬件见[模型开箱指南](guides/setup-and-models.md)，不属于质量检查或普通安装的自动步骤。

### PixAI 本机反推准备

`npm run wf -- models:prepare-pixai [--target-dir <独立可写runtime根>] [--python <已有Python或venv>] [--torch-site-packages <已有torch包目录>] [--reuse-from <已下载候选根>]` 准备固定 PixAI v1.0：官方 revision 为 `9fe10addf9326e292da8a85a98ea74cd91b41771`，FP32 safetensors 为 1,945,425,796 字节，模型、代码、配置逐项核对固定大小与 SHA-256。默认根为运行目录下的 `pixai/`；模型在 `model/`，固定 timm 1.0.30 仅装入独立 `deps/`，现有 Comfy/Python 包和生图模型不修改。已匹配文件直接复用；`--reuse-from` 核验既有候选，优先硬链权重、复制代码/配置，避免重复下载。

`--plan` 不联网、不写入、不读取目标回执、不启动 Python；`--check` 只读核验本机文件与依赖，不安装或推理。复查时按「显式参数 → 对应环境变量 → 指定目标的有效 `runtime-config.json` → 原默认」选择 Python/Torch 路径，不必重复已保存参数；已有回执损坏或路径不合法时在启动 Python 前失败，不默默改查 Comfy。模型、wheel 和独立依赖仍只检查指定目标目录，不跨库搜索，也不改写回执。

PixAI 要求 Python 3.11 或更新版本，解析解释器时先核对版本，再允许下载或安装；依赖检查也先拒绝旧版本。正常准备生成 `runtime-config.json`，包含实际 base Python、解释器版本、只读复用的 Torch 包目录、模型与独立依赖路径，供可信运行时配置采用。首次准备的 Python 首选显式参数或 `AICS_PIXAI_PYTHON`，否则查找现有 Comfy venv；包目录可用 `AICS_PIXAI_TORCH_SITE_PACKAGES` 指定。Windows worker 使用实际 base Python，避免 venv launcher 产生不能由直接取消回收的子进程。

准备阶段的 Python 子进程保留 30 秒期限与 64 KiB 响应上限。取消、超时或响应超限后保留首个停止原因，即使子进程随后正常退出并返回 JSON，也不作为成功；取消使用退出码 130，超时单独说明原因，结束时释放计时器与信号监听。

worker 仅离线加载，使用 BF16 模型与 FP32 sigmoid；默认一般标签阈值 0.17，角色阈值 0.27 单独输出，一般词条最多 100。图像上限 20 MiB，边长 8192、3200 万像素，GIF 只读取首帧。模型加载后保留至 runtime 关闭或活跃推理被取消/超时；生图启动不自动卸载。Torch 分配器预算为 3 GiB，CUDA 上下文另留余量；显卡不可用或显存不足明确失败，不隐式切换 CPU。准备命令不证明 GPU 效果或设备可用性。

现代安装器：`installer:modern --preview --capture --theme=dark --state=ready --dpi=144` 编译安全预览（不安装），支持 dark/light 与 ready/installing/done/error。正式发行脚本将现代展示层与 NSIS 核心一起打包并对最终 exe 签名。

程序发行使用 `npm run release:desktop`：同一份应用构建生成 `*-full-setup.exe` 与 `*-upgrade-setup.exe`，分别绑定和签名，自动更新清单指向升级包。完整包面向新装/修复并带 WebView2 与基础素材；升级包携带角色图片、缩略图和粒子素材，复用字节一致的 Live2D、chibi 和双人姿势素材，缺失或变化时要求完整包。样张继续独立发布。`--skip-build` 仍须匹配完整回执；新增的 NSIS 输入绑定缺失时不能复用旧回执。两种包均核对原生发行材料完整性；审批状态仅作记录，不替代用户明确发布授权，也不代表设备验收。

本机已有匹配的 NSIS 构建，只封装轻量包使用 `npm run wf -- desktop:upgrade-local --install-dir "C:\Program Files\AI-CG-Studio"`，对应 `release-desktop-update --manual --skip-build --upgrade-only --install-dir <目录>`。复用安装器检查器在升级包压缩前检查已有安装和素材；失败不安装、不停止应用，成功只生成升级包，不重包 full、不改 latest.json 或发布。该入口仍依赖首次 NSIS 构建。桌面构建回执排除无关历史包；部署保留三个检查点并消除检查点内的重复扫描。构建与部署的 `[desktop:timing]` 日志用于观察实际阶段耗时，不代替完整性验证。

底层游戏式安装器：`installer:build` 生成模板与素材，`installer:preview --capture --page=welcome` 安全预览；详情见 [安装界面维护](guides/desktop/game-installer.md)。`package:tauri` 已自动接入，无需手工修改生成的 NSIS 脚本。
仅更改安装界面且已有同版本程序时，`installer:bundle` 重新打包并签名；它不编译应用源码。

参考/样张链路需要 ComfyUI 和网关在线。ComfyUI 默认 8188，接入脚本网关默认 3000，配置可覆盖；3123 是历史端点，不作为通用默认。使用前核对所选脚本与本机服务配置。`comfy:start` 为现成启动入口，只支持 AI 工作区下 `ComfyUI/main.py` 与 `ComfyUI/venv/Scripts/python.exe` 的 Windows venv 布局。两条启动入口在已安装 SageAttention 且 CUDA 可用时默认启用，缺依赖仍用 PyTorch，不自动安装；启动进程可设 `AICS_COMFY_USE_SAGE_ATTENTION=0` 关闭，也保留显式 `-UseSageAttention` 开关。已经运行的服务不被自动重启，默认值在下次启动时生效。其他布局需自行启动并配置服务地址，不自动迁移或安装依赖。

桌面唯一入口是 `deploy-desktop.bat`，两个 deploy 工作流均调用它并保留 Cleanup 默认行为；自动调用不等待按键且保留失败退出码。`deploy:desktop` 默认复用匹配当前源码的桌面构建回执和暂存资源，不在安装目录重建数据；`deploy:desktop:full` 先执行完整桌面构建，再校验能否同步静态资源。只有宿主 EXE、Rust EXE 和 libvips DLL 均与安装版本一致时才允许增量，否则须完整安装。ORT 已从新包载荷退役，旧安装中的残留文件不会由此次源码清理自动删除。默认同步会清 WebView2 缓存并重启桌面端。

该入口只写安装目录，不覆盖个人 `content/catalog.sqlite`。人物/服装/蓝图/场景须通过内容维护或 `content:catalog` 预览并导入快照；参考索引等仍按文件维护的数据可用 `desktop:content-sync --apply --clear-webview-cache` 后重启。文件同步跳过已归记录库的目录和聚合，不读取、复制或删除它们，也不将旧目标记录分片列为多余。旧安装目录中的场景单文件等残留仍按 bat 默认 `-Cleanup` 的 `$STALE_ASSETS` 处理。装机后 [5/6][6/6]（清缓存、启动确认）在 NSIS 安装后可能不再回写，需自行核对。详见 [部署指南](desktop-deployment.md#数据改动如何到达桌面端)。

可附加开关（工作流入口仅接受无值开关，`-InstallDir <路径>` / `-InstallerPath <已验收EXE>` 需直接运行 bat）：`-UseInstaller` 使用完整安装包，默认先选择 `runtime/desktop-updates` 最新 `*-setup.exe`，也可显式指定 `-InstallerPath`；选择结果在 UAC 前固定并透传，避免提升权限期间换成另一份包。缺包退出 1，隐含跳过本地构建；`-QuietInstall` 仅随 `-UseInstaller` 静默安装，`-NoRestart` 结束后不启动，`-StartupRepair` 只同步当前绑定版本的文档、图标与快捷方式，与 `-UseInstaller` 互斥。非管理员时脚本经 UAC 重启，需用户确认。依赖/exe 变化的完整安装与 UAC 见[部署指南](desktop-deployment.md)。

批处理入口和显式 `powershell/pwsh -File <脚本.ps1>` 入口的单杠字母参数可以登记于 run.switches，help/plan/audit 共用；Node 等其他入口仍要求双杠元数据键，参数名中的空格、运算符及赋值文本仍拒绝。该识别只影响描述性元数据校验，执行路径与授权边界不变。`--plan` 显示所传开关的行为标签而不启动执行器；具体互斥及跳过行为以部署实现为准。

## 备份与清理

### 手动窗口截图与历史探针

Windows 上已授权的单窗口截图可用 `powershell -NoProfile -File scripts/maintenance/capture-window.ps1 -Title "绘遇 Companion" -Out "runtime/window-review.png" -Scale 1`。先建立输出父目录，选择新的 PNG 路径，并核对实际窗口标题；可加 `-ProcessId <进程ID>` 优先定位主窗口，定位失败仍按标题回退。实际参数名是 `-ProcessId`，不是旧文件头示例中的 `-Pid`。脚本使用 Windows `PrintWindow` 和 System.Drawing，写入 PNG，可能覆盖同名文件；不启动应用、不上传，也不截整个桌面。运行前确认当前设备及目标窗口截图已获授权，不得用作绕过受限的浏览器或设备访问。

`-Scale` 默认 2，只调整截图位图，不改变实际窗口、系统 DPI 或 CSS 视口。`PrintWindow` 返回失败仍可能落盘，日志里的 saved 不能证明画面正确；须人工打开 PNG 检查黑屏、透明或缺失内容，并独立记录实际分辨率、DPI/缩放和主题。此处仅说明静态审查确认的用途和限制，未宣称当次 Windows/WebView2 端到端验收。

2026-09-30 的四个旧 CDP 探针已原样移至 `scripts/archive/companion-cdp-20260930/`，本次特意保留 Git 跟踪供审阅与恢复，详见[归档理由](../scripts/archive/companion-cdp-20260930/README.md)。它们硬编码调试端口、存在失效 DOM 选择器/用户路径，且只打印状态而没有回归断言，因此不再作为维护入口或通过证据。当前陪伴交互回归见 `tests/e2e/companion-focus.spec.ts` 和 `tests/e2e/studio-live2d.spec.ts`，后者仍需对应模型/设备条件；归档不代表这些回归已在当前环境执行。

`backup:git` 创建本地 bundle 增量链（2 个锚点 + 默认 10 个增量），不能替代 push 或异地副本。`runtime:clean` 默认只预览；`--prune --days 60` 会实际清理。先检查路径与白名单，避免清除当前运行资料。

## 自动化检查与审计入口

| 自动化 | 触发与范围 |
| --- | --- |
| Quality | push / PR：构建、核心静态检查、关联前端、核心unit/contract、变更触发专项、关键浏览器回归 |
| Nightly visual regression | 每日北京时间 02:00 / 手动：完整前端覆盖率门槛、主题、截图与视觉矩阵 |
| Windows Native Live2D | main push / 手动：自托管 Windows 的 Tauri、Rust、原生自测与稳定性检查 |

Windows Native Live2D 的 `LIVE2D_CUBISM_SDK_DIR` 优先使用 runner 进程环境；未设置或仅含空白时才回退到同名仓库变量，避免不同机器的 SDK 路径互相覆盖。预检确认 Core 头文件、Framework 源文件和 Windows x64/143 Core 静态库均存在后，通过 `GITHUB_ENV` 传给后续步骤；显式配置的路径缺失或不完整会直接失败，不切换到另一个 SDK。

当前实现、安装范围与未执行项目见[项目状态](project-status.md)和[未来规划](roadmap.md)。发行范围见 [1.9.2 说明](releases/v1.9.2.md)。本机 gate:full 不包含浏览器、真实出图或原生桌面验收，这些仍按改动另行执行。

### 011 发行输入绑定（2026-09-21）

桌面 `build:tauri` / `package:tauri` 在锁内先从已显式导出的 `data/catalog/` 快照刷新人物、服装、场景、蓝图的数据聚合，再捕获源码身份及构建两份 UI；该写入准备不改变测试/只读检查的 `onlyIfMissing` 守卫行为。已存在的个人 `content/catalog.sqlite` 不会被安装覆盖，记录式内容通过内容维护或 `content:catalog` 预览并导入快照；参考索引等仍按文件维护的数据才使用 `desktop:content-sync`。交付范围见[部署指南](desktop-deployment.md#数据改动如何到达桌面端)。

完整桌面构建在锁内捕获受 Git 管理及未忽略源码（排除 docs、plans 和一般 Markdown；原生许可目录中的 Markdown 仍纳入），复用 delivery-identity 的路径/字节哈希。`runtime/delivery-evidence/desktop-build-binding.json` 绑定 dist、桌面内嵌 web、暂存 Rust gateway/原生 DLL/清单及桌面 EXE，打包构建另绑定 NSIS；`runtime/rust-evidence/build.json` 绑定后端源码和 release EXE。Cubism 的 Core 头文件、Framework 源码与 Core 静态库也以实际字节摘要进入桌面构建环境和回执；构建前后及复用时核对，保留旧时间戳的同路径替换也会使候选失效。直接运行 Cargo 仍使用文件变化监听，常规桌面构建请走既有入口。仅原生构建不把旧 NSIS 纳入新身份。

输入选择与回执归属核验使用路径集合和目录祖先查找，避免对数千项路径做两两扫描。选择项的大小写重复/目录覆盖仍拒绝；回执归属与明确选择项覆盖仍按原始大小写和路径判断。选择排序、摘要格式及全部文件字节检查保持原契约，不缓存历史 PASS。

隐式构建源码选择允许尚未暂存的删除：仅跳过 Git 已列为 deleted、且当次安全路径核对确认为 ENOENT 的项。暂存相同删除不会改变身份；删除和恢复文件仍分别改变源码摘要，使不匹配的旧回执失效。Git 查询失败、链接、读取权限错误与显式指定的缺失输入仍拒绝，不改 Git 索引或补写旧回执。

公开发布的 signed、manual 和 complete-manual 模式均核对绑定清单、完整材料索引、Rust EXE 与 DLL 字节；缺失材料或字节漂移仍在发行封装／上传前拒绝，独立 `publishRelease` 入口也再次核验。按用户 2026-10-06 的明确要求，`releaseReady`、pending 及许可审批标记不再阻断发布，原值保留在构建报告和更新说明中；发布仍须用户明确授权，不将公开发行写成材料审批或设备验收已完成。

安装器 payload、升级校验器、分发 SHA-256 与远端资产摘要比较使用 64 KiB 分块读取；当前预哈希格式 `ED` 的签名验证同样分块计算 BLAKE2b。每个字节仍参与校验，签名和可信注释验证保留；旧 `Ed` 原文签名沿用完整消息验证。此改动限制哈希缓冲内存，不跳过源码/产物绑定，也不复用旧摘要冒充当前文件。

skip-build、bundle-only、manual、complete-manual 均要求匹配回执；同版本源码不同、锁文件变化、混包、缺回执和篡改在封装/签名/上传前拒绝。封装后追加分发文件身份并在签名/上传前核对。正常版本修改先构建再提交相同字节可用，不要求循环提交 SHA；仅文档变化不失效。旧包缺回执不能补写身份冒认已构建，应在原源码完整重建并重新审核；不得将同版本重建包冒充原公开资产。

### 新用户自动准备（2026-10-06 源码）

控制室首次配置由 `runtime-rs/src/control/setup-models.json` 统一驱动模型、角色 LoRA、聊天权重与受管运行包。桌面选择数据目录后重启；一次确认组合即可顺序下载、校验、准备环境与启动。ComfyUI 的受管 Portable 发布在 AI 工作区 `.runtimes/comfy/`，模型继续放 `ComfyUI/models/`；llama.cpp 在 `Chat/runtime/`、GGUF 在 `Chat/models/`。部分下载在同目录保留并续传；原模型不被异内容替换。

`prepare-ai-environment.ps1` 是本机产品准备器，由 Rust 限定环境 ID、验证运行包后调用；没有新增通用命令权限或维护 CLI。当前选包支持 Windows x64 NVIDIA，Vulkan 为聊天进阶候选；驱动／系统许可与重启由用户完成。应用内文件准备完成不证明模型或设备验收。

源码已退出 SD 新生成与 WebUI 受管启动；旧任务查询、结果收集、取消、作品与原配方继续保留。没有原引擎的旧作品不推断为新模型的可复现配方。上述自动准备能力已进入当前发行，见 [1.9.2](releases/v1.9.2.md)，后续源码改动仍需对应构建与安装；公开 LoRA 附件独立有效。

## 独立推理运行库

`npm run wf -- models:convert-anima --profile anima-cosmos2b-v041 ...` 默认只读单文件结构计划；`--check` 在已有独立运行库中核验完整 meta 键/形状和本地 tokenizer；`--apply` 显式 CPU 离线转换到全新模型目录。未知架构拒绝，不联网/安装，不覆盖输入或已有输出。完整必填参数见[独立推理指南](guides/independent-inference.md#经架构核验的离线转换)。实际权重和 GPU 出图尚未验收。

`npm run wf -- models:benchmark-anima-comfy --workflow <Comfy API JSON> --sampler-node <KSampler id> --output-dir <全新runtime目录>` 复用原 ComfyUI benchmark 入口，默认只读计划、零网络。只有显式 `--run` 才向已准备的本机 ComfyUI 提交列出的任务；可用 `--teacache-node <AnimaTeaCache id>` 增加同工作流缓存对照。暖机独列、轮次变 seed、AB/BA 顺序、失败/整图缓存拒绝及 JSON/HTML 证据见 [worker 基准说明](../tools/inference/README.md#comfyui-comparison-evidence)。本工具不启动服务、不下载模型、不自动中断共享服务，不据同名 scheduler 宣称 native 等价或加速。

`npm run wf -- models:prepare-inference --target-dir <AI工作区/inference>` 默认只读预览；`--preflight --wheelhouse <目录>` 在任何 venv 写入前离线解析完整 wheel 依赖；`--check` 通过完整 worker 诊断核验本地回执、依赖与 helper；只有 `--apply --wheelhouse <可信离线wheel目录>` 创建全新独立 venv。任何模式均不下载模型或依赖，不复用/修改 ComfyUI。需已有受信 Python，平台发行材料与真实 GPU 推理另验。详见[独立推理候选接入](guides/independent-inference.md)。

`npm run wf -- models:calibrate-anima-teacache ...` 默认只读计划；`--run` 明确执行本地 CUDA 全计算采样、拟合与留出对照，`--accept-run ... --accept-quality --accept-performance` 在人工画质/性能验收和实际提速核对后写入模型校准档。已有档按精确 SHA-256 显式替换。无下载/安装，未验收档拒绝用于产品；见[TeaCache 校准与验收](guides/independent-inference.md#teacache-本机校准与验收)。

`npm run wf -- models:import-anima-directory --source-dir <完整模型目录> --target-dir <全新目标>` 默认只读布局计划；`--apply` 明确复制完整资源，不覆盖或移动来源。控制室提供同一能力的确认入口及离线运行库准备，沿用本机操作互斥与取消；文件证据不代表实际模型/GPU兼容，见[独立推理指南](guides/independent-inference.md#应用内离线准备与完整目录导入)。
