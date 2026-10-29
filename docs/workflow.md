# 统一工作流手册

> 命令注册和默认参数以 `scripts/workflow.ts` 为准；`scripts/workflow.js` 是生成的维护工具入口，产品后端由 Rust 提供。

## 先查入口

`npm run wf -- --help` 查看命令，`npm run wf -- search <关键词>` 搜索，`npm run wf -- <分组>` 查看分组。`--help` 只展示注册信息；`--plan` 预览实际命令和所带开关的副作用，不执行底层脚本。`--dry-run` 是底层脚本参数，仅在明确支持时使用。

命令、运行条件和默认参数以 `scripts/workflow.ts` 及其注册表为准。`audit:workflows` 核对注册项，`audit:workflow-conditions --json` 列出运行条件与复合副作用；二者不证明模型、设备或实际执行通过。维护工具的 TypeScript 是源码，生成的 JavaScript 不手改；只在工具源／配置变化或所需入口缺失时运行 `npm run build:runtime`。

优先复用现有流程；找不到入口时查 `scripts/maintenance/` 或使用 `audit:orphans`。新增维护入口同步登记注册表和本手册；新增文档登记索引。一次性脚本放在被忽略的 `scripts/archive/`。

## 桌面人工诊断

以下入口只由操作员显式调用，不属于默认门禁、CI或自动设备验收。`npm run wf -- diagnostics --help` 查看清单；工作流级 `--help` / `--plan` 只显示命令和副作用，不运行底层脚本。

| 显式入口 | 源文件与默认行为 |
| --- | --- |
| `diagnostics:window-capture -Out runtime/<PNG> [-Title <标题>] [-ProcessId <PID>] [-Scale 2]` | `scripts/maintenance/capture-window.ps1` 用 PrintWindow 截取指定窗口，写入PNG，可覆盖旧文件。默认标题为绘遇 Companion、倍率为2；工作流要求明确传入 `-Out`，输出父目录须预先存在 |

截图与日志放入被忽略的 `runtime/`，使用新文件名避免覆盖已有证据。`-ProcessId` 可优先定位窗口，失败时按标题回退；`-Scale` 只改变图片尺寸，不改变实际窗口或 DPI。截图须人工检查黑屏、透明和缺失内容，并分别记录屏幕、缩放与主题。历史 CDP 探针已退役，旧输出不能作为当前设备验收证据。

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
| 检查维护脚本孤儿 | `npm run wf -- audit:orphans --check`（候选须人工复核） |
| 查看内容覆盖差额 | `npm run wf -- audit:coverage`（只读报告：热门服装→参考登记、角色→主题契约；`--json` 机器可读；覆盖差额本身不作为门禁失败依据） |
| 开发前端 / 启动网关 | `npm run wf -- dev:web` / `npm run wf -- dev:server`（分别在两个终端运行） |
| 检查办公机工程入口 | `npm run wf -- office:health`（只检查目录与入口，不代替工具链验证） |
| 只读严格检查 TypeScript | `npm run wf -- check:typescript`（服务、网关、工具与独立浏览器脚本） |
| 检查本机桌面打包能力 | `npm run wf -- desktop:doctor --json`（只检测，不安装） |
| 桌面部署 | `deploy-desktop.bat`；纯资源及首次安装／修复的参数见[部署指南](desktop-deployment.md) |

所有执行固定在项目根目录。Node/npm 参数保留空格，npm 自动补转发分隔符。复合步骤失败即停止；reference:full 由专用候选入口处理公共参数和人工审核待验状态。只读审计覆盖注册文件、npm 入口、文档存在性、复合依赖循环和 run 元数据合法性，不代表模型、账户、外部服务或桌面安装已经验收。

### 只读交付证据审计（W2 最小切片）

`audit:delivery --evidence <root内JSON> --json` 读取指定证据，区分失败、待验和通过，不执行建议命令。`--require`、`--expect-commit`、`--expect-build` 可限定所需证据或身份；`--check-head` 检查本地提交，`--check-worktree` 独立检查未提交和未跟踪文件，二者都不查询远端。

`--compare-evidence` 比较显式指定的证据，要求完整最终提交和至少一个共有构建 SHA 一致；`--verify-file` 或 `--expect-file-sha256` 核验 root 内指定文件。证据或文件路径不得越过 root 的真实路径。已有 tracking 的输入、构建或日志变化使对应结果失效；旧证据缺 tracking 时保持 unknown。退出码 0 为所选记录检查通过，1 为错误、失败或身份冲突，2 为参数错误，3 为未知、未运行或待验。字节一致不证明日志内容、安装、模型或设备验收。

`capture:delivery` 可在执行前捕获所选源码和构建身份，再用 `--baseline`、`--record` 绑定实际结果；`--save` 才写新文件，拒绝覆盖。`--finalize-commit` 关联最终提交并保留执行前 HEAD。详见命令帮助；捕获身份本身不执行检查。

## 数据维护

人物、服装、场景、蓝图及记录式文档通过 `content:catalog patch/import --runtime-root <实际运行目录>` 维护；项目开发固定使用 `--runtime-root runtime`，先用 stats 核对实际库路径。默认预览，`--apply` 写入工作库，随后显式 `export --out data/catalog --record <kind:id>` 或 `--character <id>` 交付项目快照。已有目标拒绝无范围整库覆盖及来源不明的记录替换；全库备份使用新目录，升级导入拒绝已接收上游版本回退。具体格式见[维护手册](maintenance.md#3-导出与快照同步)。构建工具消费项目快照，不反向修改工作库，并核对定稿文档与保护基线一致。

| 操作 | 入口 | 注意事项 |
| --- | --- | --- |
| 场景快照构建 | data:build | data/catalog → scenes.json；旧项目才读取分片 |
| 旧分片人物／服装／场景同步 | content:sync | 已有 catalog 快照或迁移身份时拒绝预览和写入，改用 content:catalog；旧来源默认只读，--apply 修清单 count 并构建派生产物，不读写参考库；参数支持 --apply / --dry-run / --root= |
| 每人物参考分片聚合 | reference:build | data/references → standards/view 兼容聚合；--check 检查一致性（产物缺失会自愈）；聚合不入 Git |
| 热门角色快照构建 | popular:build | data/catalog → popular-characters.json |
| 蓝图快照构建 | blueprints:build | data/catalog → scene-blueprints.json |
| 词条分片与字典 | tags:build / tags:check | 校验 manifest、重复词/别名决策和源路径；保留旧 ID，生成聚合与字典，失效旧压缩 |
| 离线释义待补词统计 | tags:untranslated --input <文件> | 读取本地 PixAI JSON/JSONL 或 WD14 CSV；按现行界面释义区分完整中文、部分中文与英文回退，保留原词；--json 输出清单，--general-top / --character-top 只限制待补候选；分别标明样本出现次数与 Danbooru 频次，不以置信度代替频次；不上传、不翻译、不写词典 |
| 内容记录读写、历史与导出 | content:catalog | 显式运行目录；patch/import 默认预览，export 显式选择记录范围 |
| 单条定稿基线更新 | scenes:pin-capture | `--id=<场景ID>`，可用 `--candidate=<完整scene记录JSON>`；不批量捕获，不写工作库 |
| 数据契约与版本 | data:validate | DATA_VERSION 哈希域以 scripts/lib/data-version.js 为唯一事实源 |
| 未迁移旧资料修复 | legacy:* | 仅旧格式用途；已有内容库/快照拒绝回写，见[迁移与保护](maintenance.md#迁移与保护) |
| 旧的文件域同步工具 | desktop:content-sync | 默认只读预览，仅处理文件维护域，不更新记录库；本项目桌面同步使用 `deploy-desktop.bat` |

详细文件职责见 [维护手册](maintenance.md#文件职责)。三个聚合构建脚本默认计算 DATA_VERSION，客户端由 Vite 的 `virtual:data-version` 在构建时注入，不再改写 `src/stores/sceneStore.ts`；`--check` 不写版本——产物缺失时自愈重建（fresh clone），齐全但与源不一致时报错退出 1。校验失败需定位来源，不能只改版本掩盖数据漂移。

核心精选 `personaCoreSceneIds`：保存时对显式数组稳定去重并剔除非活跃引用，显式非数组报错；旧请求漏字段时，保存链在基线核对后的锁内保留现存核心精选，显式 `[]` 才清空。纯清洗函数没有旧快照时保留缺省；不合并其他策展字段。主校验检查该字段的数组、非空字符串、重复及活跃引用，空数组/缺省兼容；首屏读取与包体预算按实际消费者和产品构建审查，不新增核心精选必须属于 curated 的限制。`validate-scenes.js` 的旧格式分片和 data 元数据统一采用 `AICS_DATA_ROOT`、`AICS_APP_ROOT`、仓库根的优先级，不混读其他运行目录。

场景语义门禁复用工作台的镜头过滤和负向组装（scripts/lib/scene-render-contract.js），检索 tags 不冒充发送给模型的词条。提示词不设置最低字符数、词数或句号数配额；门禁保留非空、身份/服装绑定、占位符、分级、构图冲突与编译消费检查。画面完整度与模型写法按 [studio-prompt-craft](../.agents/skills/studio-prompt-craft/SKILL.md) 审查，不能以静态长度代替真实画面；接口输入大小上限仍按对应协议执行。`optimize-scenes --check` 检查持久化数据的实际编译结果；changed 表示可选的格式改写建议，不要求机械改写提示词。分级脚本只维护分级/使用元数据，不再改写 negative；任何提示词改写仍须独立真实出图和定稿保护验收。

## 参考库

参考图库是可选素材，不是新增角色或服装的必备交付。`data/references/` 的人物分片与 manifest 是参考数据源，standards/view 为兼容聚合。参考图片不入 Git；分镜图片按需上传。

- `reference:register --dry-run` 预览待登记形态；去掉该参数会写入 pending 占位。`reference:render --output <候选目录>` 调用模型并只写隔离候选；实际参数先看 `--help` 和 `--plan`。
- `reference:design` 是旧活跃库的三视图工具：调用模型后会回填参考索引，不属于隔离候选流程。已知任务沿原编号续查；接收不明时不自动重发，取消未确认或遗留锁时先核对任务和进程。
- `reference:audit`、`reference:repair` 与 `reference:repair-urls` 也用于旧活跃库，不替代新候选的人工审核和发布。URL 修复先 `--dry-run`；`check:ref-urls` 核对既有索引与配置的素材根，不把 pending 当成已交付。

`audit:impact` 可只读查看关联和未知范围，不能证明图片存在或已审核；用法见[内容影响检查](#内容归属只读报告)。

### 参考库候选审核与版本发布

`reference:full --output <候选目录> --source <现有参考库目录> --target <新版本目录> [--root <项目根>]` 生成或续跑候选，再核对记录、实际 PNG 字节和生成时的源版本。缺少人工审核返回 3（pending）；结构通过不表示画面合格。`--dry-run` 仅规划生成，不写盘、不调用模型；工作流 `--plan` 连目标数据也不读取。

`reference:inspect --from <候选目录/reference-generation-manifest.json>` 输出最新候选的 key、recordId、图片 sha256、inputVersion 和完整性状态。将真实看过图片的决定写入候选目录内的 decisions.json：每个 key 对应 `{ "verdict": "pass", "recordId": "实际记录ID", "sha256": "实际图片哈希", "inputVersion": "实际输入版本", "reviewedAt": "实际审核时间ISO", "notes": "审核意见" }`，verdict 也可为 fail。调用 `reference:review --from <清单> --decisions <决定JSON> --out <候选目录/manual-review.json>`，只新建审核记录，拒绝覆盖。漏审保持 pending；源、图片、记录或重试版本变化后，旧决定失效。审核文件记录人工声明，不认证声明真实性。

`reference:publish --from <候选清单> --review <审核JSON> --source <现有库目录> --target <新目录> [--root <项目根>]` 默认只读预览。只有显式 `--apply` 且全部所选候选均具备当前有效人工通过决定时，才复制保留旧资源、加入批准图片及对应 view 投影，在完整核验后原子发布新目录。目标已存在且身份一致时幂等返回；不同内容拒绝覆盖。失败不改旧库或项目源索引，保留专用暂存供排查；进程中断后重试会回收已死亡进程的锁，活进程/未知锁拒绝抢占。断电持久性仍需设备验收。

新版本含 reference-release.json 和 character-reference-view.json，前者绑定所有图片、投影、源标准/view、候选和审核哈希。显式将网关参考库根配置为该版本并重启后，由版本解析器核验再同时提供图片和索引；损坏或源版本不匹配拒绝接入。回滚重新选用保留的旧目录。本入口不自动改配置、不安装、不将待审核图片写入活跃库。

`reference:full` 可附 `--review <审核JSON>`，或 `--decisions <决定JSON> --out <新审核JSON>` 走到发布预览；始终不自动 apply。需要重试画面时用 `reference:retry --output <原候选目录> --keys <reference:角色:服装:机位,...>`，沿用原配方生成新记录并重新人工审核，不继承旧通过状态。

## 样张

| 操作 | 入口 |
| --- | --- |
| 热门/场景批量调度 | showcase:batch --source popular 或 --source scenes |
| 当前 MiaoMiao 批次 | showcase:batch-miaomiao |
| 指定独立场景 MiaoMiao v1.6 候选（不发布） | showcase:scene-candidates --ids sc001,sc002 --output <新候选目录> |
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

`character:onboard` 是旧活跃库维护工具，可能写入源或调用模型，不是当前内容库的日常写入口。接入步骤、参考候选及验收见[角色接入工作流](guides/characters/character-onboarding-workflow.md)；安装获授权后使用 `deploy-desktop.bat`。

## 内容归属只读报告

以下入口只读取指定资料，不自动执行报告中建议的命令。旧分片报告不代表当前 SQLite 工作库；日常内容维护使用 [content:catalog](maintenance.md)。

| 入口 | 用途与边界 |
| --- | --- |
| `audit:impact` | 按 `--character`、`--outfit`、`--scene` 或重复的 `--path` 查看关联；`--git-diff` 读取工作树变更，`--base` 比较指定本地历史。可显式提供 `--showcase-manifest`。未知路径、删除或无法确定的关系保持 unknown；不读取图片或证明人工审核 |
| `check:impact` | 默认预览；`--base <ref> --execute` 执行所选只读结构检查，`--full --execute` 检查支持的完整结构域。执行后即使局部通过也返回 3，表示完整内容门禁未运行；未知与未覆盖范围保留 |
| `audit:ownership` | 盘点旧格式升级源与派生文件；`--domain` 缩小范围，`--consistency` 比较已实现的源／产物投影。外部样张和未覆盖字段仍为 unknown |
| `audit:content-evidence` | 只核对明确指定的来源、候选、人工决定与可选发布回执；图片或输入变化使旧审核失效。匹配只能证明声明与字节绑定，不能证明实际看图 |
| `audit:coverage` | 对照旧热门服装、参考登记和主题契约；差额只提示，不自动补图或登记，也不验证配色效果 |

用各命令 `--help` 查看参数和退出码。`--plan` 不读取目标数据；真实模型、编译结果及画面仍按任务范围分别验收。

## 本地资源清单生成与校验

`audit:resource-manifest --root <目录>` 只读生成 `assets/` 的文件路径、大小与 SHA-256；参考图库、外部挂载和用户作品不纳入。显式 `--manifest <root内JSON>` 核对已列文件，`--manifest <旧JSON> --compare-manifest <新JSON>` 只比较两份清单，不读取实际资产。非法或越界路径、结构错误和未核验项不能作为完整通过；清单校验不会发现未登记文件。

## 离线资源候选包暂存导出

新装用完整 ZIP 与增量包的制作、安装及 VC++ 前置材料见[离线素材指南](guides/offline-resources.md)。`offline:pack` 默认预览，`--apply` 才在 Windows 写入新目录；增量包须匹配基础发行，模型权重和私有参考不随包发布。

`resource:pack --manifest <root内JSON> --name <包名> [--base-manifest <旧JSON>]` 是独立的受控复制入口，默认预览并读取源文件核验；显式 `--apply` 才复制到 root 内的 `scripts/archive/resource-packs/` 新目录。目标已存在、清单无效、路径越界或字节不匹配时拒绝覆盖；失败暂存保留以便排查。增量候选只包含新增／变化文件，并记录移除项，不是完整安装包。

## 增量候选包与基线兼容核验

`resource:verify-delta --base-manifest <root内JSON> --pack <root内候选目录>` 只读核验基线、增量元数据和候选文件字节，不读取基线资产或安装目录。通过只表示可相对指定基线重建声明的目标，不证明来源可信、画面审核或安装完成。

## 内容恢复与资源库

样张、角色图片和受支持的旧文件事务使用各自的锁、备份与恢复记录；`/api/maintenance/recovery-status` 只检查其支持的文件事务，不能代替内容库健康检查。`maintenance:recover --root <绝对项目根> --runtime-root <绝对运行目录>` 默认只读预览；保存计划后，以同一组根路径和 `--apply-plan <签名JSON>` 显式恢复。恢复前重新核对根、备份、当前字节和锁；活进程、未知锁或损坏记录会阻止恢复。需要 Rust 构建，也可使用原生 EXE 的 `maintenance-recovery` 子命令；工作流 `--plan` 只显示命令。

资源生命周期入口 `resource:install`、`resource:download`、`resource:recover`、`resource:rollback` 共用 `--config <可信本地JSON>`，安装和下载还需 `--release <已配置ID>`。默认预览，显式 `--apply` 才写专用用户资源库；下载不自动安装，保留旧版本和用户作品，哈希不能代替来源审批。`resource:installed` 核对安装状态时会短暂持有专用锁。

### 资源库的本机接入

启动环境通过 `AICS_RESOURCE_CONFIG` 指定可信本地配置，另设 `AICS_RESOURCE_MANAGEMENT=trusted` 才允许本机管理；HTTP 请求和普通设置不能授予这些权限。配置变化撤销当前操作授权。未配置或资源失效时使用随包基础资源，不自动下载或修复。

本机 `/api/resources/status` 查询状态，`/api/resources/tasks` 创建已批准的导入、下载、恢复或回退任务，取消使用任务的 cancel 入口。重启后未完成任务显示 interrupted，可按原操作恢复；已安装资源按允许清单核验，Live2D 依赖组整体采用或回退。

桌面暂存默认 `AICS_DESKTOP_RESOURCE_PROFILE=full`；显式 `base` 只处理隔离暂存副本，保留原资产和已安装程序。设备和画质需另行验收。

## 门禁与构建

仓库按用户要求移除全部测试、夹具、测试框架依赖和 CI 测试入口。不运行或恢复单测、组件测试、E2E、对抗性测试、覆盖率与测试门禁；旧报告中的测试结果只作历史记录。

按任务授权审查源码、差异和已有日志。产品构建、类型检查及真实维护操作保留独立入口，不在提交、推送或普通代码审查时自动执行：

| 入口 | 用途 |
| --- | --- |
| npm run build:runtime | 从 TypeScript 生成维护与独立浏览器工具，不生成测试或 Rust EXE |
| npm run typecheck | 应用、Node 维护工具与独立浏览器工具类型检查 |
| npm run wf -- models:native-adapter-catalog | 以 -I -B 隔离且禁止写脚本缓存，只读列出原生图像/视频适配声明、来源版本及许可证；不导入 ML，不代表实机可用 |
| npm run wf -- images:manga-screen-catalog | 以 -I -B 隔离且禁止写脚本缓存，只读列出 MangaScreen 后处理操作和参数；不导入图像库、不处理图片，待主力机验证 |
| npm run build | 前端构建、包体预算与预压缩 |
| npm run wf -- rust:build | 按锁文件构建 Rust release 及源码/EXE 绑定回执 |
| npm run wf -- rust:build:dev | 独立缓存构建快速 dev 后端，不生成发行回执 |
| npm run build:tauri / package:tauri | 原生桌面构建 / 安装包制作 |

仅工具源或配置变化、所需生成入口缺失时准备 build:runtime；不手改生成的 JS。未运行构建或产品验收时如实记录，不把源码审查视为行为通过。

记录式内容管理使用 npm run wf -- content:catalog --help。stats/query 读取工作库；record/history 读取记录与历史；authoring 按角色返回带修订号的人物、服装与精简蓝图索引，新角色须显式给出参考角色；`--kind scene` 返回现有场景修订与定稿保护，或下一个可用编号，这些上下文读取不写记录。patch/import 默认预览，--apply 写入；export --out 显式导出项目快照，保留范围外内容。check 检查工作库结构与关联，colors 检查配色，均为真实内容维护。权威边界见[维护手册](maintenance.md)与[内容库设计](architecture/CONTENT-CATALOG-DESIGN.md)。

`authoring` 使用只读连接，运行目录不存在时拒绝而不初始化。写入链在事务内检查变更的提示词源字段，明确违规以 `PROMPT_CRAFT_REJECTED` 拒绝整批；有歧义的问题在 `promptReview.issues` 返回建议。`promptPolicy` 公开版本及覆盖边界，规则与视觉复核的区别见[维护手册](maintenance.md#提示词写入检查)。

首次迁移个人内容时，`--root` 指向个人内容目录，`--seed-root` 指向随包默认内容目录；前者提供工作记录，后者只提供升级比较基线。未知的旧分片基线保持为空，不把个人修改登记为默认值。已有内容库继续读取数据库，不重新初始化。

### 角色语音引擎

npm run wf -- voice:service -AIWorkspaceRoot <AI目录> -RuntimeRoot <运行目录> -TtsHost http://127.0.0.1:9880 -Engine voxcpm2 默认只探测状态。显式 -Action Start 加载已有基座和角色 LoRA；-Action Stop 只停止本应用启动的服务。GPT-SoVITS 使用 -Engine gpt-sovits。入口不下载模型；真实调用按用户授权。

控制室保存 ttsEngine、loraWeightsPath、参考音频和原文，重启后生效；切换引擎前先停止原服务。models:check 只报告已配置声线文件，不启动模型。

<a id="rust-运行时迁移"></a>

### Rust 运行时

`content:catalog import --file <快照> --preserve-local` 是升级时保留个人内容的显式策略，默认仍为只读预览，追加 `--apply` 才写入。完整保留本地修改记录、保存原始新快照基线，回执含 `preservedLocal`；关联变更触碰保留项时整次拒绝。普通导入仍拒绝冲突，具体边界见[维护手册](maintenance.md#批量修改与快照)。

产品后端为 runtime-rs，Node 用于前端、维护工具及构建编排。源码服务使用 npm start / npm run start:run；直接入口为 runtime-rs/target/release/huiyu-runtime.exe --app-root <项目目录> --bind 127.0.0.1:3210。工作区须显式私有路径/身份或受控桌面激活。

`npm start` 会先执行 `prestart` 生成维护工具，`npm run start:run` 则直接使用现有生成产物；相同的脚本正文不代表相同的 npm 生命周期。`legacy:*` 仍由 `workflow-legacy.ts` 登记为旧格式升级入口，不能仅因名称或当前内容已入库就批量删除。

rust:build 需要已有 Rust/MSVC 工具链，首次可能下载锁定 crate，不替换桌面安装。rust:licenses:collect 按 components.json 的固定配方下载公开源码并提取许可材料，不安装或执行源码；材料变化后更新摘要绑定，见[原生材料说明](../runtime-rs/native-licenses/README.md)。

### Rust 快速开发

日常后端修改使用 `npm run dev:server`：构建成功后先认证关闭旧网关，再运行新 EXE 的副本；构建失败保留旧服务，关闭未确认时不启动第二个写入者。单次构建使用 `npm run rust:build:dev`（工作流 `rust:build:dev`），单次启动使用 `npm run start:dev -- <服务参数>`（工作流 `rust:start:dev`）。服务参数、私有工作区路径与身份规则和正式启动相同。

这些入口只向开发子进程设置 `CARGO_PROFILE_DEV_DEBUG=1`，沿用 Cargo dev 的优化等级、增量编译、安全检查和 panic 行为。保留源文件/行号及调用栈定位，但不保留完整变量和类型信息；需要查看局部变量、参数或复杂类型时，在当前 PowerShell 设置 `$env:AICS_RUST_DEV_MODE='standard'`，回到原始 dev 默认值和普通 target。断点和单步的实际调试器体验另行确认。恢复快速模式用 `Remove-Item Env:AICS_RUST_DEV_MODE`。已有 `CARGO_PROFILE_DEV_DEBUG` 等显式覆盖始终优先，因此 standard 不保证覆盖环境下的完整符号。

Windows x64 MSVC 后端保留原链接器；桌面 dev 默认使用当前活动 Rust 工具链自带的 `rust-lld.exe`，不安装工具、不改全局配置。它只设置对应 target 的子进程 linker 环境变量，会覆盖 Cargo 配置文件的同 target linker；设置 `$env:AICS_RUST_DEV_LINKER='default'` 可保留 Cargo 原选择，移除此变量恢复入口默认。已设置的 target linker、`RUSTFLAGS` 或 `CARGO_ENCODED_RUSTFLAGS` 不会被改写。其他平台不自动切换链接器，Linux 尚未实测。

默认缓存为各 Cargo.toml 所在目录下的 `target/development/<链接器选择>`；首次需单独预热。回退 standard 使用普通 target，不清理已有缓存。显式 `CARGO_TARGET_DIR` / `CARGO_BUILD_TARGET_DIR` 优先；改变调试信息、链接器、feature、flags 或 toolchain 可能使缓存失效，日常保持参数稳定。EXE 位置读取 Cargo 产物消息，兼容 target 子目录覆盖。

`npm run dev:tauri` 构建开发后端，宿主显式使用本次 Cargo 返回的 EXE 和开发原生 DLL 环境；跳过 release 后端、安装器、资源暂存与预压缩。默认复用 `dist` 和 `desktop-tauri/web`，缺失时准备两种路由入口；修改 UI 或内容后运行 `npm run dev:tauri -- --refresh-ui`。CLI 只监视桌面 Rust，后端改动需退出并重新执行桌面开发命令；后端持续开发使用 `dev:server`。开发窗口沿用认证网关或 native bundled 来源，不引入新的可信来源。

`npm start` / `start:run`、`rust:build`、`prepare:tauri`、普通桌面 build/package 及 `maintenance:recover` 默认保持 release 流程和回执绑定。`dev:tauri -- --release` 也保留原发行准备。`rust:build --profile desktop-local` 可单独构建本机优化档位的后端；`npm run build:tauri -- --local` 同时构建两个本机原生程序及资源，不生成安装包。Cranelift 在 Windows 上缺少所需 panic unwinding，当前不提供该入口。

`deploy-desktop.bat` 和 `desktop:package-local` 默认选择独立的 `desktop-local` 档位：继承 release，设置 `opt-level=2`、`lto="off"`、`codegen-units=16`、`incremental=true`。后端与宿主各自复用 `target/desktop-local` 缓存，首次须预热；后端回执为 `runtime/rust-evidence/build-desktop-local.json`，不替换 release 的后端回执。暂存、桌面绑定和安装清单使用实际档位对应的 EXE。正式 `release:desktop` 继续使用原 release 配置，`--skip-build`、`--bundle-only` 和发布入口拒绝本机快速构建。同步方式见[部署指南](desktop-deployment.md)。

## 服务与桌面部署

### 本机 Live2D 候选导入

已下载的 LPK 可复用夏目使用的 [LpkUnpacker](https://github.com/ihopenot/LpkUnpacker) 命令行工具：`LpkUnpacker.py <包.lpk> <隔离输出目录> -c <同包config.json>`。本轮工具源码版本为 `906d4cdd5597403ebf46dde8fb47d9c81a352d19`，仅需 CLI 的 filetype 依赖；不需要 GUI/Live2D Python 运行库。芙宁娜与雷电将军输出到 `runtime/live2d-unpacked/<角色>`，由配方的 `unpackedEntry` 接入。原 LPK、config 与作者说明保持原样。

个人桌面同步：`npm run wf -- live2d:sync-local --source <导入根> --target <用户模型根>` 默认只预览，`--apply` 核验完整源哈希后复制，保留目标旧版本。正常桌面部署使用 `deploy-desktop.bat -SyncLocalModels`，将模型写入 `%APPDATA%/com.aics.studio/gateway/live2d-imports`；安装包与公开资源清单仍不包含这些私有模型。修改 Rust 后使用 `deploy-desktop.bat -QuietInstall -SyncLocalModels` 构建并安装升级包，UAC 仍由用户处理。

需要更新已导入模型的配方或校准时，可使用 `--apply --refresh`：先核对旧版本文件哈希，将旧目录保留为 `runtime/live2d-imports/.previous-<角色>-<唯一标识>`，再切换完整新副本；失败恢复旧目录。不带 `--apply` 的 `--refresh` 仍仅预览。不要手动覆盖作者模型或删除旧版本来绕过损坏检查。

`npm run wf -- live2d:import-candidates` 核对 `data/live2d-candidates.json` 中的本机候选，默认仅预览；`--ids hatsune_miku,frieren` 可缩小范围，`--apply` 将已完整核对的运行依赖复制到 `runtime/live2d-imports/<角色ID>`。源压缩包与解压目录不修改；仅在副本修复明确缺失的可选表情、登记已有表情与动作。相同内容重跑核验后保持不变，不同或损坏内容拒绝覆盖。每个模型保留 SOURCE.md、源清单哈希、文件哈希及修复记录。入口不下载、不解包受保护的 LPK、不发布、不安装。

本机直连的陪伴页、聊天页从 `/api/live2d-companions` 加载本机身份与 Adapter Profile；资源仅经本机受限接口按导入文件清单提供。远程/隧道请求不返回本机角色和模型，候选原件也不进入静态资产路由、资源包或桌面暂存。新角色尚无专属音色时保持文字聊天，不借用内置角色声音。Cubism 3 本机模型支持浏览器与 Native；Cubism 2 的蕾姆保持浏览器回退。原生端仅接受与本机导入回执身份一致且引用完整的模型，不接收 WebView 的任意文件路径。

实际 Live2D 模型与原生 GPU、音频设备按用户授权进行人工验收。

环境与本机凭据说明见 [启动与排错](../STARTUP.md) 与 [全功能硬件配置与模型开箱指南](guides/setup-and-models.md)。

聊天个人 API 密钥在 Windows 桌面版由系统凭据管理器按 API 地址保存，网页端只放在当前页面内存；浏览器持久设置保留地址/模型，不保存新密钥。旧明文记录只有安全写入和读回一致后才清除；失败保留可恢复旧值并提示重试，不降级为新明文写入。配置面板可独立清除个人密钥；备份导出排除尚未迁移的旧密钥。站主托管配置仍是服务端受限文件，与个人凭据迁移分开验收。系统凭据库失败、升级与最终安装须另留真实 Windows 验收。

- `models:check [--json] [--verify-hashes]`：只读扫描硬件清单、ComfyUI 模型文件和 PixAI 回执/路径，按网关优先级报告配置缺失或无效、固定清单文件、Python/worker/timm/torch 文件状态；显式哈希检查才读取大权重。Python 包可导入性、CUDA/BF16与真实推理仍未验，不将文件存在称为引擎就绪；
- `models:download-wd14 [--target-dir <可写目录>]`：默认从固定 HuggingFace 发布者版本下载 WD14 MOAT v2（ONNX 约 311 MiB 与配套 CSV）；`--modelscope` / `--mirror` 可显式选择镜像，但同样核对固定字节与 SHA-256；`--plan` 不下载；
- `models:download-h3 --models-root <实际ComfyUI/models目录>`：下载当前工作流完整六文件（约 43.99 GB / 40.97 GiB，含 4/8-step LoRA），固定官方 revision 和 SHA-256；`--plan` 不下载。运行依赖与硬件见[模型开箱指南](guides/setup-and-models.md)，不属于质量检查或普通安装的自动步骤。

### PixAI 本机反推准备

新机在「控制室 → 图片反推」点击「一键准备」：按随包固定清单自动下载独立 CPython 3.11、PyTorch CUDA 12.8 及其依赖、PixAI v1.0 模型与 timm，无需 ComfyUI、系统 Python、pip 或单独安装 CUDA Toolkit。运行库复用 AI 工作区内 `inference/<固定运行库版本>/`，仅准备环境，不下载生图模型；PixAI 模型在 `PixAI/model/`，timm 在按 wheel 版本与 SHA 命名的 `PixAI/deps/` 子目录。来源、空间、路径、进度和取消在同一面板显示，下载支持续传并核对完整 SHA-256；Windows VC++ 共享组件如需提权由系统 UAC 处理，系统安装阶段须等待结束或在 Windows 安装器中取消。

准备成功后原子写入运行目录 `pixai/runtime-config.json` 并刷新反推服务，无需重启；失败保留既有环境和下载缓存，重新准备可继续。关闭页面仅停止进度观察。显式 `AICS_PIXAI_*` 路径覆盖须先移除并重启后才能一键准备，避免下载完成却仍使用旧环境。受管包支持 Windows x64、单张兼容 NVIDIA CUDA/BF16 显卡与清单规定驱动；反推时需要约 4 GiB **空闲**显存。准备只核验文件、依赖导入和设备能力，不执行真实模型反推。以下 CLI 为复用已有环境的高级维护入口。

`npm run wf -- models:prepare-pixai [--target-dir <独立可写runtime根>] [--python <已有Python或venv>] [--torch-site-packages <已有torch包目录>] [--reuse-from <已下载候选根>]` 准备固定 PixAI v1.0：官方 revision 为 `9fe10addf9326e292da8a85a98ea74cd91b41771`，FP32 safetensors 为 1,945,425,796 字节，模型、代码、配置逐项核对固定大小与 SHA-256。默认根为运行目录下的 `pixai/`；模型在 `model/`，固定 timm 1.0.30 仅装入独立 `deps/`，现有 Comfy/Python 包和生图模型不修改。已匹配文件直接复用；`--reuse-from` 核验既有候选，优先硬链权重、复制代码/配置，避免重复下载。

`--plan` 不联网、不写入、不读取目标回执、不启动 Python；`--check` 只读核验本机文件与依赖，不安装或推理。复查时按「显式参数 → 对应环境变量 → 指定目标的有效 `runtime-config.json` → 原默认」选择 Python/Torch 路径，不必重复已保存参数；已有回执损坏或路径不合法时在启动 Python 前失败，不默默改查 Comfy。模型、wheel 和独立依赖仍只检查指定目标目录，不跨库搜索，也不改写回执。

PixAI 要求 Python 3.11 或更新版本，解析解释器时先核对版本，再允许下载或安装；依赖检查也先拒绝旧版本。正常准备生成 `runtime-config.json`，包含实际 base Python、解释器版本、只读复用的 Torch 包目录、模型与独立依赖路径，供可信运行时配置采用。首次准备的 Python 首选显式参数或 `AICS_PIXAI_PYTHON`，否则查找现有 Comfy venv；包目录可用 `AICS_PIXAI_TORCH_SITE_PACKAGES` 指定。Windows worker 使用实际 base Python，避免 venv launcher 产生不能由直接取消回收的子进程。

准备阶段的 Python 子进程保留 30 秒期限与 64 KiB 响应上限。取消、超时或响应超限后保留首个停止原因，即使子进程随后正常退出并返回 JSON，也不作为成功；取消使用退出码 130，超时单独说明原因，结束时释放计时器与信号监听。

worker 仅离线加载，使用 BF16 模型与 FP32 sigmoid；默认一般标签阈值 0.17，角色阈值 0.27 单独输出，一般词条最多 100。图像上限 20 MiB，边长 8192、3200 万像素，GIF 只读取首帧。模型加载后复用至最后一次请求完成后连续空闲 10 分钟；新请求复用时取消旧计时，完成后重新计时，空闲回收与请求共用准入锁。runtime 关闭或活跃推理被取消/超时会立即清理对应进程；生图启动不自动卸载。Torch 分配器预算为 3 GiB，CUDA 上下文另留余量；显卡不可用或显存不足明确失败，不隐式切换 CPU。准备命令不证明 GPU 效果或设备可用性。

现代安装器预览与维护入口见[安装界面指南](guides/desktop/game-installer.md)。桌面同步、首次安装／修复和正式发行统一按[部署指南](desktop-deployment.md)操作：日常程序更新使用 `deploy-desktop.bat`，纯资源同步显式使用 `-ResourcesOnly` 并核对已安装 EXE/DLL，首次安装或修复显式选择发行完整包。`-SkipBuild` 只复用匹配源码和环境的构建；正式发行继续使用 release 与 LZMA，不复用本机快速包。UAC 由用户操作。

参考和样张工具使用配置的图像网关；候选生成必须指定隔离 `--output`，已知任务沿原编号恢复，接收不明时先核对再决定是否重试。`comfy:start` 支持 AI 工作区内的 Windows ComfyUI venv 布局，其他布局自行配置。SageAttention 仅在已安装且 CUDA 可用时启用；`AICS_COMFY_USE_SAGE_ATTENTION=0` 可在下次启动时关闭，不自动安装或重启现有服务。

## 备份与清理

`backup:git` 创建本地 bundle 增量链（2 个锚点 + 默认 10 个增量），不能替代 push 或异地副本。`runtime:clean` 默认只预览；`--prune --days 60` 会实际清理。先检查路径与白名单，避免清除当前运行资料。

## 自动化审计入口

依赖安全审计仍保留；验证入口见[门禁与构建](#门禁与构建)，设备和模型验收见[项目状态](project-status.md)与[规划](roadmap.md)。

### 发行输入绑定

桌面构建先从显式导出的 `data/catalog/` 快照刷新派生数据，再绑定源码、SDK、UI、Rust EXE、原生 DLL 和构建产物；打包还绑定 NSIS 输入。`--skip-build`、`--bundle-only` 及发布必须使用匹配回执，缺失、漂移或混包时拒绝，不补写身份冒认旧包。一般文档变化不影响源码绑定，原生许可目录内的材料除外。

发行继续核对原生材料索引及实际字节；`releaseReady` 和 pending 按原值记录，不因这些标记自动阻止已授权发布，也不等于材料审批或设备验收。公开发布仍需明确授权，具体模式见[部署指南](desktop-deployment.md)。

### 首次配置与自动准备

控制室首次配置由 `runtime-rs/src/control/setup-models.json` 统一驱动模型、角色 LoRA、聊天权重与受管运行包。桌面选择数据目录后重启；一次确认组合即可顺序下载、校验、准备环境与启动。ComfyUI 的受管 Portable 发布在 AI 工作区 `.runtimes/comfy/`，模型继续放 `ComfyUI/models/`；llama.cpp 在 `Chat/runtime/`、GGUF 在 `Chat/models/`。部分下载在同目录保留并续传；原模型不被异内容替换。

`prepare-ai-environment.ps1` 是本机产品准备器，由 Rust 限定环境 ID、验证运行包后调用；没有新增通用命令权限或维护 CLI。Windows x64 绘图提供 NVIDIA 包及实验性官方 AMD Portable v0.39.0 包（固定大小与 SHA-256）；Radeon 880M/890M 首装推荐 AMD，安装前确认 ROCm 可识别设备，启动采用分块注意力与低显存模式，避开 880M 上会停住的上游 AOTriton flash 能力探测。核显共享内存不按 WMI 专用显存大小判断；其他 AMD 设备、画质与性能仍需验收；已登记本机连通记录见[项目状态](project-status.md)。原生运行库继续仅支持 NVIDIA。AMD 本地聊天首装选择现有 Vulkan 路线；驱动／系统许可与重启由用户完成。文件准备完成不证明模型或设备验收。

源码已退出 SD 新生成与 WebUI 受管启动；旧任务查询、结果收集、取消、作品与原配方继续保留。没有原引擎的旧作品不推断为新模型的可复现配方。自动准备范围以当前源码与已选发行版本为准；源码改动需对应构建与安装，公开 LoRA 附件单独核对。

## 独立推理运行库

`models:prepare-inference` 预览或用已有 wheelhouse 离线准备独立运行库；`models:import-anima-directory` 预览或导入完整模型目录；`models:convert-anima` 按已登记架构离线转换单文件 checkpoint。各入口默认预览，显式 `--apply` 才写入新目录，不覆盖已有模型或下载依赖。完整步骤见[独立推理指南](guides/independent-inference.md)。

`models:calibrate-anima-teacache` 是显式维护研究路径，默认只规划，`--run` 才执行本地 CUDA 出图对照。校准结果只有在画质和性能验收后才能显式接纳；产品日常使用内置策略，不自动采用维护档案。参数与适用边界见[独立推理指南](guides/independent-inference.md)和[worker 说明](../tools/inference/README.md)。真实设备效果和成本按授权单独验收。
