# GLM 5.3 Flash 后续分批任务

2026-09-13。用户希望优先使用即将到期的 GLM 5.3 Flash 额度。此处按任务边界安排工作，不声明其通用能力或基准排名。依据见 [六报告复核](../../research/engineering/six-task-review-2026-09-13.md)。

最新复核：A、RB、RC、N1/N2/N3、G1–G10 已整合；RD 的部分用例仍未验收。记录见 [汇总复核](../../research/engineering/six-task-review-2026-09-13.md)。当前执行文末 G11/G12/G13，三项可并行；旧批次不重复启动或重做报告。查修前版本使用 git show，不得 stash、切分支或自行提交。

## 执行与交付

- 在 `D:\code\ai-cg-studio-main` 工作，遵循 AGENTS.md。只读取本批有关文件。开始记录 HEAD 和已有改动，结束列出自己修改的文件及实际检查结果。
- A、B、C 可交给同一模型的三个独立会话同时进行；每个会话独占下列路径。若只有一个会话，按 A → B → C → D 连续完成，不必每批询问是否继续。
- 共享文档、生产内容和 Git 由主任务统一整合：不自行提交、推送、切分支，不覆盖其他会话改动。A 只修改明确列出的工程文件；B/C/D 只写各自输出目录。
- 不调用生成模型，不改提示词/评级/服装绑定，不下载或删除资源，不安装/发布。报告或索引存在不代表内容验收；常规只读检查及明确隔离夹具可直接执行。
- 完成定义：产物可重现、差异有证据、实际检查与未运行项分开，输出完成即结束本批；遇到超范围缺陷记录后继续独立部分，不扩成全库审计。

## A：落地工作流说明与元数据修正

独占写入：`scripts/workflow.js`、`docs/workflow.md`；确有必要时仅补 `scripts/tests/test-workflow-runner.js` 内相关行为用例。回执写 `scripts/archive/glm-next-a/result.md`。

1. 核对 `deploy-desktop.bat` 与转发目标的实际参数。为两个 deploy 注册项补充已支持开关及对应副作用、前置条件说明，尤其是 `-UseInstaller`；不要更改部署执行、默认参数或 UAC 流程。nature/switches 语义沿用现有 runner，未知项写未知，不新增一套权限框架。
2. 修正 check:rewrite 和 deploy 的漂移 evidence，引用真实实现；避免继续指向与实现无关的注册表行号。
3. data:build 的说明明确区分默认构建写 DATA_VERSION 与 `--check` 的缺失自愈/陈旧守卫行为。
4. 文档 gate:full 说明澄清 typecheck 已在 check 内；澄清工作流 test:e2e:critical 使用无 build 的 npm `:run` 入口。
5. 验收：现有 workflow-runner 与 workflow-conditions 隔离测试、工作流结构审计、docs:check；对部署只能使用确认不启动执行器的 plan 或模拟调用。不得实际安装/重启应用。

该批涉及工作流，正式交付仍按仓库要求完成 gate:full。并行会话不得构建共享 dist：GLM 做上述定向验证并在回执标记“待主任务统一 gate:full”；主任务在收齐相关变更后统一运行。不能把本批定向通过写为全量通过。

## B：修复错误的素材统计，建立可复算资源清单

独占写入：`scripts/archive/glm-next-b/`。不修改旧报告及其他会话的一次性脚本；读旧材料仅作线索。

1. 从已有新49批次来源核对成员，然后从当前 characters.json 读取声明立绘，重新统计。主任务已验证旧脚本遗漏 `?v=` 导致误报，当前 49/49 存在；不要为了匹配这个数字硬编码结果。
2. 实现本批一次性只读清点脚本：明确处理查询参数、片段、相对路径、URL 编码和允许的本地资源映射；远程 URL、未知挂载或越出允许根的路径标 unknown，不读取任意外部目录。检查普通文件，不把目录当图片。
3. 用小型临时夹具验证：带/不带版本参数指向同一文件、编码空格、真实缺失、目录、远程 URL、越界路径。已有能力可复用，脚本不放进正式维护入口。
4. 重新统计 assets，JSON 每条记录路径、字节、类别、引用证据、存在性、审核声明状态。类别必须互斥，总和能回算；无法分类的保留 unknown。动态引用列出解析函数和输入 ID，不以搜索无结果断言可删除。
5. 输出 inventory.json、reconciliation.md、清点脚本及夹具验证结果；保留旧数值到新数值的修正说明。不要读取图片像素或伪造视觉审核，不承诺安装包压缩率，不生成或改写图片。

完成后，同一会话可继续 D。该清单用于后续 R1 实施输入，不自动修改打包白名单。

## C：把字段盘点整理成可采纳的职责材料

独占写入：`scripts/archive/glm-next-c/`。

1. 以任务 02/03 报告及主任务复核为线索，只核对人物档案、热门身份、服装、参考 view、蓝图五个域。
2. 每域交付一张简洁表：字段/字段组、权威源、实际读取者、写入者、派生或合并规则、ID 作用域、证据路径与符号、未知项。静态工具中的手写职责说明不替代追踪实际调用者。
3. 至少完整追踪 nene、frieren 和一个多服装角色。跨域 ID 不同只记录差异，只有找到明确的错误连接行为才能称缺陷；不创建别名映射、不统一 default/isDefault。
4. 更正原报告对 traits 运行异常、参考 view 必须纯覆盖、芙莉莲原作争议根因等无证据断言。保留字段实际不一致，不决定哪一边语义正确。
5. 输出 ownership.md、relations.json、corrections.md；正文聚焦维护者如何找源和判断写入边界，不复制大段 JSON 或重新讲项目概况。蓝图保存缺陷由主任务负责，本批仅链接准确入口。

本批成果供维护手册或现有 ownership 工具后续采用，不直接修改共享工程契约、生产数据或审核状态。

## D：准备可执行的离线资源验收用例

独占写入：`scripts/archive/glm-next-d/`。可与 A/C 并行；如使用 B 的统计，需要等 B 输出完成。

1. 查现有浏览器测试与隔离启动方式，复用已有页面和选择器。给首页、角色列表/详情、场景卡片、参考灯箱、Live2D 静态底图各写必要的故障用例。
2. 每例写明前置条件、拦截的具体资源请求、操作、预期 DOM 状态、恢复操作、深浅主题截图要求和证据文件名。区分资源 404、网关不可达、外网断开；本地文件不因断外网就必然失效。
3. 可以在本批目录提供待集成的 Playwright 用例草稿；不能改正式测试配置、启动共享浏览器测试服务器或重建 dist。草稿只做语法/选择器源码核对，未执行须明确标记。
4. 不用当前存在的错误行为反向定义成功标准；例如详情图加载失败，验收目标应是有可理解的回退或缺失状态。测试预期是产品要求，当前是否满足另列。

输出 acceptance.md 和必要草稿。主任务统一选择用例、实现回退与浏览器验收；不把本批当作真机验收完成。

## RB：修复资源解析器的 Windows 路径边界

仅修改 `scripts/archive/glm-next-b/`，与 RC/RD 可并行。保留修正记录，直接修代码和夹具，不再只写建议。

- 当前脚本在 URL 解码前检查反斜杠，解码后使用 posix 路径判断；Windows 最终 stat 却按本机分隔符解析，编码反斜杠可越出 assets。`assets/characters%5c..%5c..%5coutside.txt` 必须在隔离夹具中被拒绝，不能返回 file/bytes。
- 解码后重新校验分隔符、路径根和盘符/绝对路径；同时核对真实路径，拒绝 junction/symlink 指向允许根外的目标。不存在的路径检查最近存在父级，不能用“目标不存在”跳过真实路径边界。
- 目录遍历本身也不得跟随根外链接。验证输出目录和读取范围，保留正常的 `?v=`、fragment、编码空格与本地挂载映射。未知外部挂载不访问。
- 临时夹具覆盖编码反斜杠、斜杠穿越、混合分隔符、目录冒充图片、非法编码、远程 URL、junction 越界和正常文件；越界例使用夹具自己建立的无敏感文件，并证明未 stat/read 越界目标。测试不可只检查最终 kind。
- 修复后重跑夹具和清单，更新 fixture-results.json、inventory.json、reconciliation.md；引用分类仍是来源线索，不把硬编码 ReferencedBy 当完整动态依赖证明。不要改生产工具或读取真实库外文件。

## RC：修订职责材料中的过度推断

仅修改 `scripts/archive/glm-next-c/`，与 RB/RD 可并行。

- 重新核实原文对 `kitagawa_marin / sheer_bathrobe` 未进入参考标准的解释；不得以 isNsfw 推断过滤原因。实际同步函数、磁盘完整机位判定及旧记录合并分别追踪，无对应运行输入则写原因未知。
- 将“无消费者”“不存在崩溃路径”“不影响任何运行时行为”等绝对结论收窄到实际检查的解析链与调用者；每条涉及行为的结论引用函数/字段，不以全文搜索无匹配证明全系统无使用。
- accent_color 应列出 report-content-coverage.js 的真实读取/报告用途，不能称只有文案提及。参考 isDefault 的 `o.default || idx === 0` 会无条件标首套，不能改述成“仅无默认标记时兜底”。
- 对 ownership.md、relations.json、corrections.md 逐项一致性检查；删除错误因果，不改生产字段或裁定角色设定。无需重新全仓盘点。
- 额外交付一个简洁的 maintenance-insert.md：只包含已核实的五域源/产物/写入边界，供主任务插入既有维护手册，避免再产生一份长篇重复文档。

## RD：让故障用例真正等待并验证故障

仅修改 `scripts/archive/glm-next-d/`，与 RB/RC 可并行。本批仍不运行真实模型、原生设备或共享浏览器服务。

- F11/F12 不能以 not-ready 和允许 idle 作为通过；先确认拦截请求实际命中，再等待当前实现支持的明确失败终态和对应失败说明。检查 src/composables/live2d 的实际状态枚举/转换，不发明 fallback DOM 状态。若产品目标当前未实现，标为待实现，不能放宽断言。
- 对每个故障用例记录拦截次数并断言命中；草稿中的运行用例必须验证故障状态和恢复操作，而不是只截图或确认容器存在。没有真实可用恢复夹具的用例继续标未就绪。
- F7 的 canvas 可见不证明几何回退已渲染。明确可观察证据；若源码没有可稳定观测的接口，保留为待人工视觉验证，不添加空断言冒充自动覆盖。
- F1 不应同时要求原损坏 img 的 naturalWidth 非零和另一 fallback 可见；移除损坏图片后显示可理解占位也可满足产品要求。断言按最终支持的回退策略写，不能把实现形态写死。
- F8 用受控参考索引与图片夹具区分卡片成功/灯箱失败，避免并发缩略图消耗“第二次请求”计数；F9 大图路径按实际 manifest 字段匹配，不依赖未知外部素材。
- 语法检查后更新 acceptance.md，逐例区分源码核对、语法通过、浏览器未执行及产品待实现；删去未经执行的“已满足”措辞。回执列出已修复断言和仍不可自动验证的用例。

## N1：实现首页图片失败回退

本批直接改产品，不再盘点。独占 `src/views/HomeView.vue`、`src/assets/css/home.css`、新测试 `tests/e2e/home-image-recovery.spec.ts`；回执目录 `scripts/archive/glm-home-recovery/`。不改 CharacterView、通用测试配置、分级数据或打包资源。

- 首页英雄图、热门横条图片请求失败时显示合适的占位或回退，保持角色名、作品标签、行动按钮可读；不显示裸裂图。复用现有缩略图、占位或 ArchiveIcon，不创作新图片，不增加图库或下载逻辑。
- 为每张图片单独跟踪失败状态；切换角色、图片 src 或版本后重新尝试，不能一个失败让其他卡片消失，也不能形成错误源递归重试。
- 兼容深浅主题、现有响应式布局及减少动画设置。不要重设计首页，不新增全局色值或非合成动画；新增图标遵循 ArchiveIcon。
- 补故障与恢复测试，参考已验证 `tests/e2e/resource-recovery.spec.ts` 的 awaited route、请求命中、同目标解码和失败截图方式；不要复制旧草稿的假通过断言。
- 必须完成相关逻辑/样式检查；共享工作区不构建 dist、不启动共享浏览器服务，双主题浏览器和构建由主任务收齐 N1/N2 后统一执行。回执写清验证和待主任务浏览器验收，不把测试草稿称通过。不做 Git 写操作。

## N2：实现角色详情立绘缺失状态

与 N1 可并行。独占 `src/views/CharacterView.vue`、`src/assets/css/character-view.css`、新测试 `tests/e2e/character-detail-recovery.spec.ts`；回执目录 `scripts/archive/glm-character-recovery/`。

- 修复 brokenPortraits 只移除图片而没有解释状态的问题：主图失败后优先尝试该角色现有的可用缩略图；缩略图也失败或没有时显示明确、可读的缺失状态，保持详情布局、角色名和来源可用。
- 同一角色的 src/版本变化要清除对应旧失败状态；切角色不能串用上一角色的图或错误提示。每个来源最多尝试一次，禁止 fallback 循环或自动请求外部 URL。
- 保留待补立绘的真实状态和所有现有分级/访问限制；回退图片不冒充已审核原图。不修改参考索引、生产图片、热门数据或生成请求。
- 补主图失败→缩略图成功、两者失败、切角色/换 src 后恢复的定向用例；断言同一角色的实际图片解码及可理解状态，不只检查 img/标签存在。复用现有工具，不改正式通用测试配置。
- 深浅主题使用现有令牌，文字对比度与版式由主任务统一浏览器验收。GLM 执行相关逻辑/样式检查，不构建共享 dist、不启动共享浏览器服务、不做 Git 写操作；回执明确剩余视觉验证。

## N3：补齐场景手帖与 404 页插图回退

这是已核实的剩余 UI 缺口：SceneExplorerView 的两位陪伴角色大图和 NotFoundView 的 Q 版插图仍是无错误处理的 img。直接实现，不再写盘点报告。

- 独占 `src/views/SceneExplorerView.vue`、`src/views/NotFoundView.vue`（均含本地样式）及新测试 `tests/e2e/illustration-recovery.spec.ts`；回执写 `scripts/archive/glm-illustration-recovery/result.md`。不改 HomeView、CharacterView、共享令牌或测试配置，不做 Git 写操作。
- 场景手帖：一张陪伴图失败时显示对应角色的可理解占位，角色切换、原有台词和场景入口继续工作；另一位角色不受影响。用户切换后允许新一轮有界重试，旧请求事件不能污染当前状态，不自动无限重试。
- 404 页：插图失败后保留清晰的缺图/装饰占位，页面标题、错误路径和返回链接保持可读可操作。无需新图，不改变路由行为。
- 参考已交付 N1/N2 的模式：状态复杂时复用或独立封装；图片实际解码前不要宣布恢复成功；复用 ArchiveIcon 和主题令牌。先核对真实 CSS 层叠，缺图文字不得被 figcaption 或装饰渐变压淡。
- 补两页图片 404、成功恢复、场景手帖按角色隔离/切换的双主题测试。拦截必须命中，恢复验证同目标图片解码，分别保存失败和恢复截图，不能只检查标签存在。复用现有 test helpers，不新增维护工具。
- 执行相关类型、逻辑与样式检查；不构建共享 dist、不启动共享浏览器服务，主任务统一构建与双主题/窄屏视觉验收。报告明确区分已运行检查与未执行浏览器用例，不下载/删图/改分级或触发模型。

## G1/G2/G3：工程治理实施批次

2026-09-13，分派时基线 `75e6224`。用户已要求继续按并行实施、主任务复核的节奏推进。下面是实际代码任务，不是新一轮盘点。

共同边界：先记录实际 HEAD 与已有改动；仅编辑本批允许文件。三个会话都不修改 scripts/workflow.js、docs/workflow.md、roadmap、共享测试注册表或 Git 状态，文档增补建议写入各自回执目录，由主任务统一更新及提交。保持现有命令名、JSON 旧字段、退出码及权限边界；不执行生成、安装、下载、发布或生产数据写入。可自主执行明确隔离的定向测试，失败须修复后重跑；共享 dist 构建与最终门禁由主任务统一执行。不要把“测试文件存在/被收集”写成测试通过。

### G1：补齐 personaCoreSceneIds 保存清洗与主校验

独占写入：`routes/maintenance-validation.js`、`scripts/maintenance/validate-scenes.js`、`scripts/tests/test-maintenance.js`、`scripts/tests/test-scene-maintenance-save.js`。若确需共享纯函数，可新增小型 `scripts/lib/curation-core-validation.js`。回执：`scripts/archive/glm-g1-core-curation/result.md`。

事实起点：sanitizeCuration 处理 curated/signature/review，但遗漏 personaCoreSceneIds；validate-scenes 的策展段也未覆盖它。已有 test-scene-shard-integrity.js 会检查 core 引用、条数/包体等，不能宣称全项目没有检查，也不要复制这些预算或扩大约束。

- 保存清洗：对显式提供的 personaCoreSceneIds 沿用稳定顺序去重与删除非活跃引用的既有方式；显式非数组输入报明确错误。旧请求未提供此字段时保留既有兼容方式，不擅自将“字段缺省”解释为清空已保存核心精选。先追踪调用者确认现有快照行为。
- 主校验：字段存在时核对数组、非空字符串 ID、重复项和活跃引用，错误指出 personaCoreSceneIds 及具体 ID/位置。空数组与缺省保持兼容，不新增“必须非空”“必须是 curated 子集”或角色覆盖配额；不改现有 core 首屏预算规则。
- 不改 personaCoreReasons、推荐理由或其他策展层的语义，不删除/新增任何生产场景，不修改提示词或 pinned 基线。
- 隔离验证：合法/空/缺省、重复、未知或退役 ID、非数组、非字符串、稳定顺序、输入对象未被修改、其他策展字段未受影响；既有 signature→curated 与 review 互斥测试继续通过。至少有一次真实校验 CLI 对坏夹具返回非零且指出 core 字段，不能只断言源码字符串。
- 注意 validate-scenes 当前 dataDir 固定仓库路径，而 scene-store 可接受 AICS_DATA_ROOT。若通过环境变量运行夹具，必须让该脚本的全部数据输入使用同一夹具根；允许在本脚本内对齐这一个根目录，不重构共享根解析器。先验证隔离范围，不将生产 curation 临时改坏做测试。
- 不改蓝图保存事务、routes/maintenance.js 或源分片写入协议。回执列出原缺口、最终行为、定向命令/结果及需要主任务统一补的门禁。

### G2：完整呈现已有工作流条件元数据

独占写入：`scripts/maintenance/report-workflow-conditions.js`、`scripts/tests/test-workflow-conditions.js`。回执：`scripts/archive/glm-g2-workflow-report/result.md`。

事实起点：注册项已有 run.switches/run.notes 与顶层 needs，但条件报告当前只输出 nature/machine/resume 等，默认文字输出也只有 metadata valid/not-run。此批完善信息呈现，不改变执行逻辑。

- JSON 以加字段方式保留 switches、notes 和 needs；复制已有值，不从自然语言推断副作用或前置条件。旧字段与 schemaVersion 保持兼容；缺省值给出稳定的空集合/null，不假装已满足条件。
- 文字输出包含默认行为、所声明开关及其行为、前置条件、说明、已有错误/未知项。保持清楚简洁，不把整份注册表再序列化成大段 JSON；原有 `--json` 和 `--domain` 行为保持。
- 真实执行状态仍是 not-run；不能把元数据合法写成命令可安全执行或已验收。复合步骤的现有错误检查继续工作，不重新实现 runner 的执行或权限判断。
- 测试使用小型注册表/临时根：双杠普通开关、批处理单杠开关、多条 notes、needs、字段缺省、非法元数据和嵌套复合项。分别断言 JSON 结构与人类输出能看到关键条件；确认 help/plan 不读目标根或启动执行器，report 不改输入注册表。
- 允许为测试导出纯格式化函数，但不新增 CLI 命令、不改共享 runner 和注册表。测试不能只有完整大快照或字符串长度断言。

### G3：把已复核字段职责落实到 ownership 工具

独占写入：`scripts/maintenance/report-content-ownership.js`、`scripts/tests/test-content-ownership.js`。回执：`scripts/archive/glm-g3-ownership/result.md`。

阅读 docs/maintenance.md 的“人物、服装与参考域的维护边界”和六报告复核；旧 scripts/archive 报告只作线索。此批更新工具提供的职责知识，保持当前只读与浅层检查边界，不另造 schema 或图谱平台。

- 补齐 characters/popular/blueprints/references/themes 的实际读取者与写入者：人物档案解析、accent_color 覆盖报告、保存链推荐引用清洗；热门服装 default 解析与参考 isDefault 派生；蓝图 build/import/受控补丁/当前 API 聚合写入；view 合并与登记器双写。逐条核对当前函数，不把函数名、文件名或旧报告措辞当成执行证据。
- 明确源/产物方向和维护入口影响，特别保留蓝图当前只写聚合的未修风险，以及参考 sync 依赖磁盘机位、可能过滤形态的边界。不能宣布本批修好了这些写入行为。
- 将笼统字段描述改为实际用途：档案字段存在不代表详情页全部渲染；不同用途字段不机械合并；职责清单是核对范围内的说明，不声称穷尽所有写入者。保持资料维护与提示词变更的验收要求有区别，不给普通档案文字强加真实出图。
- 保持原 JSON 字段、domain 选择、未知外部资产状态、错误码和路径保护。读写者仍是静态职责说明，本批不加载或执行列出的维护脚本来“验证”。不要新增针对暂缺 readers/writers 文件的硬门禁，旧隔离夹具无需复制整套源码。
- 定向测试覆盖关键职责信息在 JSON/文字输出中可见、已有各 domain 与参数兼容、未知域拒绝、外部素材仍 unknown、help/plan 零目标读取及报告零写入。用少量关键行为断言，不把全文说明锁成大快照。
- 三个阶段不得同时改共享文档；把拟增补工作流说明写到自己的 result.md，由主任务合并。完成后停止本批，不自动开始资产下载、ID 迁移或蓝图事务修复。

## G4/G5/G6：继续实施，不重复盘点

共同约束沿用上文：开工核对 HEAD/diff，保护其他会话；不做 Git 写操作，不调用生成模型，不安装/下载/发布，不修改生产内容与分级。只做本批实现及明确隔离的定向检查；最终统一门禁、共享 dist 构建和浏览器视觉由主任务负责。G5 独占本轮工作流注册与文档文件，G4/G6 的说明写各自回执。

### G4：交付审计的人类可读输出

独占 `scripts/maintenance/audit-delivery.js`、`scripts/tests/test-delivery-audit.js`；确需拆分时可新增 `scripts/lib/delivery-report-format.js`。回执 `scripts/archive/glm-g4-delivery-output/result.md`。

- 默认输出目前按对象字段 JSON.stringify 拼接。改为简洁的总体状态、通过/错误/待验数量，以及每项对应文件、字段和原因；未知/未运行/失败/通过不得混为一谈。
- 让 commit/build 比较、显式文件核验、HEAD/worktree 检查中已存在的结果可读；未启用的检查不能显示已通过。空集合不堆砌整段 JSON，必要限制和未执行推荐命令仍能看到。
- `--json` 保持原结构和值；parse/report/state 判定、退出码、文件边界、旧证据适配保持不变。只抽出纯格式化层，不改历史证据文件，不扫描新日志，不执行建议命令。
- 测试覆盖 passed/failed/pending、缺失信息、多文件比较失败、异常兜底结果、JSON 与退出码兼容。用小型报告对象和现有隔离夹具验证，不新增大快照、不通过放宽判定来让文字更好看。
- 不修改 scripts/workflow.js 或 docs/workflow.md，文案补充写回执。完成定向测试后交主任务复核。

### G5：本地资源清单生成器与校验器

本批是 R1 后续代码基础，交付可复用工具；不开发下载器，不改变打包白名单，不复制/转换/删除图片。

独占新增 `scripts/lib/resource-manifest.js`、`scripts/maintenance/report-resource-manifest.js`、`scripts/tests/test-resource-manifest.js`，以及 `scripts/workflow.js`、`scripts/tests/quality-test-inventory.js`、`docs/workflow.md` 的必要注册。回执 `scripts/archive/glm-g5-resource-manifest/result.md`。没有必要则不新增依赖或 JSON Schema 文件。

- 提供纯函数/显式 root 的本地资产清单生成与校验。首版 schemaVersion=1，每条保留资源相对路径、字节数、SHA-256；路径按稳定排序输出，不能把时间戳当内容版本。首版以路径标识文件，不声称跨重命名身份稳定。
- 默认只清点 root/assets 下普通文件，排除 character-references 外部参考域；不自动进入外部挂载、不扫描 runtime/用户作品。目录遍历不跟随 symlink/junction，遇到非普通文件或无法核验项明确列出，不伪造完整覆盖。
- 校验清单中的重复路径、非法/越界路径、实际文件缺失、字节或哈希不匹配；路径解码/Windows 分隔符/真实路径安全复用 RB 已验证经验，不把 700 行临时脚本整体搬进正式工具。静态受控根即可，不增加任意 URL 抓取或全盘发现。
- 新入口 `audit:resource-manifest`：正常生成打印 JSON；显式 `--manifest <root内JSON>` 走校验。支持 --root/--help/--plan，帮助/预览不读目标文件或计算哈希。默认无文件写入，不提供隐式修复、删除或上传。清单要保存时由调用者显式重定向到自己的输出目录。
- 复用现有注册元数据并登记维护文档、测试清单；声明只读、不代表图片质量/审核/可信发布源。哈希相等只能证明字节一致，不把“文件存在”变为“内容已交付”。
- 临时夹具覆盖稳定输出、单文件改变后哈希变化、重复、缺失、错大小/哈希、编码与原始路径越界、junction、不支持 schemaVersion、help/plan 零读取、生成/校验零源写入。格式错误与未核验状态不得返回无条件成功；输出清楚的退出码契约。
- 每文件遵守 600 行预算，不扩成数据库、资源管理 UI 或缓存系统。定向测试/注册审计通过后交付，不构建共享 dist。

### G6：补齐八位角色的主题覆盖

独占 `src/assets/css/director/tokens.css`，可新增 `tests/e2e/character-theme-completion.spec.ts`；回执 `scripts/archive/glm-g6-character-themes/result.md`。不修改人物数据、色彩校验器、现有阈值或全局主题默认值。

本次只读覆盖报告仍缺：ereshkigal_fate、ishtar_fate、kasumigaoka_utaha、kochou_shinobu、krista_lenz、ling_arknights、shinomiya_kaguya、shokuhou_misaki。以开工时报告重核为准，不为凑数新增不存在的角色。

- 沿现有角色主题格式补齐强调色与关联变量，以项目现有资料/立绘和当前设计令牌为依据，不凭记忆编角色设定，不统一套同一组色值。深浅主题均需可读；先核对实际 CSS 消费链，不能仅让选择器计数变绿。
- krista_lenz 的旧 historia_reiss 选择器保留兼容，可让规范 ID 与旧别名共用对应规则；不重命名任何角色/服装 ID，不删除旧兼容样式。nene 的默认主题保持原有方式。
- 运行覆盖报告和相关颜色/样式/动画/单体预算检查；记录修前/修后缺口、每个 ID 对应规则及实际对比度结果。不得降低 AA 阈值或将问题角色加入忽略名单。
- 补双主题的针对性浏览器测试草稿：按真实路由/选择方式展示这些角色，验证身份正确、实际强调色生效与文字可读。不要直接改 DOM 数据属性再声称真实选择流程已验收；不调用生成。
- 本批不构建共享 dist、不启动共享浏览器服务。主任务会用当前构建逐角色检查双主题和实际布局；GLM 回执明确未执行视觉验收，不把覆盖报告当视觉通过。

## G7：资源清单差异比较

2026-09-14。G5 的清单生成/核验已交付，下一步实现供增量资源更新使用的只读差异；不启动下载、删除或打包调整。

独占 `scripts/lib/resource-manifest.js`、`scripts/maintenance/report-resource-manifest.js`、`scripts/tests/test-resource-manifest.js`，以及 `scripts/workflow.js`/`docs/workflow.md` 中该入口的必要选项说明。回执 `scripts/archive/glm-g7-resource-diff/result.md`。开工核对 HEAD/diff，不做 Git 写操作，不修改他人文件。

- 新增纯比较函数及 `--manifest <旧清单> --compare-manifest <新清单>` 模式。`--manifest` 单独使用继续执行已有文件核验，默认模式仍生成；新参数缺少旧清单时明确报参数错误。帮助/预览不读取清单或资源。
- 对两个清单做现有 schema/路径/重复项等结构检查，再按路径输出新增、移除、内容改变、未改变数量。结果顺序稳定；changed 带前后 bytes/sha256，added/removed 保留对应条目。不要用 generatedAt 判断新旧，不按相同哈希猜重命名。
- 比较只读取明确指定的 root 内两份清单，不读取/哈希实际 assets；旧清单中已移除的文件不应因当前磁盘缺失而无法比较。复用现有根目录和路径边界，不能把“结构比较”误用成“实际文件校验”。
- 非空 unverified 或不可支持格式不得得出“完整一致”的成功结论；清楚区分已列条目的差异与目录覆盖完整性。两份清单相同不证明当前文件存在、已审核或已交付。
- 用隔离夹具覆盖新增、删除、同大小改哈希、大小变化、完全相同、输入条目乱序、空清单、重复/坏路径/坏版本、带 unverified、参数错误；记录型 IO 证明未访问任何资产文件、两份输入不变，help/plan 零目标读取。已有生成/核验和排除域/junction 回归必须继续通过。
- 不重构成资源数据库、不新增网络行为、不复制或删除图片。必要时在 600 行内拆纯辅助模块，不重复制造另一套路径检查器。定向测试与注册审计通过后写回执，最终全量门禁由主任务统一处理。

## G8/G9/G10：工具可用性与资源导出基础

2026-09-14，分派时基线 `d1a1953`。用户明确希望继续利用 GLM 完成更多实际工作。本轮三项文件互不重叠；G10 独占工作流注册和文档，G8/G9 的注册/文档补充写在回执中交主任务统一处理。所有会话先核对实际 HEAD/diff，不做任何 Git 写操作，不构建共享 dist、不启动共享浏览器服务、不调用生成模型、不安装/下载/发布。定向隔离测试可直接执行并修复失败；不得用新增报告替代要求的实现。

### G8：影响报告的人类可读输出

独占 `scripts/maintenance/report-content-impact.js`、可新增 `scripts/lib/content-impact-format.js`，以及 `scripts/tests/test-content-impact.js` 或新增 `scripts/tests/test-content-impact-format.js`。回执 `scripts/archive/glm-g8-impact-output/result.md`。若新增测试文件，列明注册位置交主任务处理，不改共享测试清单。

- 默认文字输出目前逐段 JSON.stringify。改为清楚的目标/范围摘要、必改/需复验/仅关联数量与条目、未知范围、未执行建议命令。每个问题保留 kind/id/原因或现有对应标识，不丢失定位依据。
- 默认服装、主题、参考状态、场景和显式样张关系以易读短行呈现；区分 pending、URL 声明、实际存在性未知，不把关联对象全称为必须修改。空集合省略，长清单如截断须注明剩余数量及 --json 入口。
- `--json` 的结构/数值、parse/report 的判定、退出码、所有已有选项和只读行为保持。格式化层只处理报告结果，不重新查文件、不执行建议、不改内容或推荐范围。
- 测试覆盖必改/复验/关联分离、未知项保留、空集合、多目标定位、异常兜底、输入对象不变；同一隔离夹具下 JSON 与旧 report 结果一致，文字与 JSON 的退出码一致。复用既有 CLI/零写入测试，不锁整份长文本快照。
- 不修改 scripts/workflow.js、docs/workflow.md 或其他批次文件。完成代码、定向测试及简洁回执。

### G9：覆盖缺口报告支持角色/服装筛选

独占 `scripts/maintenance/report-content-coverage.js`、`scripts/tests/test-coverage-report.js`；如需拆分可新增纯辅助 `scripts/lib/coverage-selection.js`。回执 `scripts/archive/glm-g9-coverage-filter/result.md`，注册与文档修改建议交主任务，不碰 G10 的共享文件。

- 给 audit:coverage 增加 `--character <规范ID>` 与可选 `--outfit <角色内ID>`；outfit 必须同时指定 character，未知角色/服装明确报参数错误，不能返回貌似正常的空报告。
- 无筛选参数时保留现有全库输出、版本与退出码。筛选时只列所选角色/服装的参考覆盖结果和该角色主题状态，数量按所选范围重算，JSON 增加明确 scope，不把局部结果称为全库通过。
- manifest、重复身份、standards/view 镜像等既有全域结构检查仍执行且问题保留，并注明全域错误不一定由所选对象造成。不要靠先丢弃其他角色来掩盖全库结构错误。
- 文件存在性核对仅针对所选参考范围；未选角色不应额外触发其素材文件检查。允许为全域结构检查读取已有元数据 JSON，但不得把未检查图片计为 verified。
- 测试覆盖单角色、单服装、缺登记、pending、素材根未知、参考独有形态、无关角色不出现在局部条目中、全域结构错误仍可见、未知ID/不合法参数、输入不变及零源写入；记录型 fileExists 证明不检查未选参考文件。
- 使用现有 buildReport/analyseReferences 等逻辑，避免整套重写；保留默认主题和兼容别名。不要注册服装、不补描述、不生成图片、不修改分级或主题。

### G10：离线资源候选包导出

这是 R1 后续的受控复制工具，不是安装器或下载器。GLM 仅用临时夹具执行写入验收；本机真实素材导出由主任务另行选择，不在本批自动进行。

独占新增 `scripts/lib/resource-pack.js`、`scripts/maintenance/stage-resource-pack.js`、`scripts/tests/test-resource-pack.js`，以及 `scripts/workflow.js`、`scripts/tests/quality-test-inventory.js`、`docs/workflow.md` 的必要注册。可只读复用 resource-manifest 库，不修改它；回执 `scripts/archive/glm-g10-resource-pack/result.md`。

- 新入口 `resource:pack --manifest <root内JSON> --name <包名> [--root <目录>] [--apply]`。默认只预览计划，零写入；--help/--plan 不读取目标。包名限字母、数字、下划线、短横线，不允许路径片段。
- 首版输出固定在 `<root>/scripts/archive/resource-packs/<包名>/` 的新目录。先校验最终路径及所有已存在祖先的真实位置，拒绝 symlink/junction 绕出允许候选目录；目标只要已存在（包括空目录）就拒绝，不覆盖任何旧包。
- 显式 --apply 才复制清单已列普通文件，保留 `assets/...` 相对结构，并写入可被已有 manifest 工具核验的 manifest.json。先复用清单核验，遇到不支持格式、重复/越界、排除域、未核验项、缺失、错大小/哈希须拒绝；不遍历补入未列文件，不执行任何复制内容。
- 写到本次专用临时目录，逐项核验候选副本与声明字节/哈希一致，全部成功后才将该目录放到最终包名。源在复制期间变化、写入失败、目标冲突等都不能报告成功；失败候选可保留并明确路径，不删除无关目录，不把残缺包当成可用包。
- 不转换或重采样图片，不编辑原 manifest，不运行资产中的脚本；不写安装目录、生产 assets、用户作品或外部托管，不生成可执行更新逻辑，不做 ZIP 解压/安装/缓存淘汰。输出仅称“候选包已通过字节核验”，不能称质量/审核/部署完成。
- 临时夹具至少覆盖预览零写入、正常导出且原文件字节不变、同名目标拒绝、坏清单拒绝、排除域/路径/junction拒绝、复制失败或源变化不发布最终包、导出后用现有 verifyManifest 校验通过。清理只针对明确由本测试创建并已确认位于临时根内的路径，不能递归清理链接目标。
- 新命令登记默认 preview/read-only 与 --apply 的 writes-product 行为，注册定向测试和文档；不把它标为发布入口。遵守单文件 600 行预算。完成定向验证后交主任务统一门禁与写入边界复核。

## G11/G12/G13：隔离校验、蓝图保存基础与增量候选包

2026-09-14。在主任务完成 G8–G10 整合后开始，以实际 HEAD 为准。三项独占文件，可并行。共同约束：不做 Git 写操作、不启动共享 build/browser、不改生产 data/assets/提示词/分级、不调用真实模型或安装下载。只用自建临时夹具验证写入；完成实现和定向检查后回执，不用研究报告代替代码。G13 独占注册和工作流文档，G11/G12 将注册建议写入回执交主任务。

### G11：内容契约校验统一隔离根

独占 `scripts/maintenance/validate-content-contracts.js`、可新增 `scripts/tests/test-content-contract-root.js` 与必要纯辅助 `scripts/lib/content-contract-root.js`；不改现有 store/data-version 库或其他测试。回执 `scripts/archive/glm-g11-content-root/result.md`。

- 当前 validate-content-contracts 固定仓库 ROOT，维护保存及其他 store 已支持 AICS_DATA_ROOT/AICS_APP_ROOT。使该 CLI 的数据读取、参考核对、压缩产物、DATA_VERSION 计算和读取统一采用 `AICS_DATA_ROOT || AICS_APP_ROOT || repoRoot`。明确 root 表示完整项目布局根（含 data/assets/src/stores），不能在夹具缺文件时回退读生产。
- TS 校验规则的 require 仍来自代码仓库，区分规则代码与待校验数据。不得复制整套规则到夹具、跳过分级/引用/压缩/版本检查或修改生产 DATA_VERSION；保持无环境参数时的行为与 validateContent 导出兼容。
- 缺文件/坏 JSON 等输出可定位失败，不得异常后继续报告成功；校验全程只读，不调用自愈/build/sync。若发现额外根相关库缺口，先记录，勿扩大所有库改造。
- 隔离 CLI 测试覆盖两种环境变量及优先级；至少一个完整有效夹具能通过，改变夹具的引用/压缩产物/版本分别会失败。用两个不同根证明选错根不会假通过；快照/记录型 IO 证明零写入且不读取生产数据。参考检查采用夹具或 structure 模式，不能访问真实素材。保留已有契约规则，测试不要只断言字符串里出现变量。
- 新测试注册由主任务处理，不改共享文件；遵守 600 行预算。

### G12：蓝图分片变更的纯规划器

独占新增 `scripts/lib/blueprint-change-plan.js`、`scripts/tests/test-blueprint-change-plan.js`。只读参考 `blueprint-store.js`、`popular-store.js`、场景增量保存实现与蓝图保存复现记录；不修改它们，不接入 routes 或实际磁盘写入。回执 `scripts/archive/glm-g12-blueprint-plan/result.md`。

- 为后续主任务修复蓝图保存提供可直接复用的纯函数：输入当前 manifest、各分片解析对象和原始文本、完整目标 blueprints 数组及已有角色→franchise 映射，输出下一 manifest/聚合及明确 writes/deletes/unchanged 计划。参数与返回结构自行设计并写清楚；模块不 require fs、不读环境、不执行命令、不自带自动 apply。
- 校验输入完整、manifest 文件唯一且为安全 JSON basename（拒绝 traversal/绝对/分隔符/Windows 大小写冲突）、来源分片齐全、蓝图 ID 非空且唯一；未知角色或无法确认 franchise 必须明确错误，不归入 unknown 自动建片。旧 manifest/franchise 冲突不得静默合并。
- 同 franchise 沿用既有文件名和 manifest 顺序；新 franchise 用现有 franchiseSlug 规则并检查冲突，按目标首次出现顺序追加。保留目标条目全部字段与组内顺序，不改内容、评级或绑定；跨 franchise 移动须在旧片移除、新片加入。聚合使用 version 2 与 manifest 顺序拼接。
- 不变分片保留原始字节，不因格式化整库改写；变化分片输出与现有 jsonText 格式兼容，manifest count 精确更新。删除计划只能包含输入 manifest 声明的已知片，不能扫描或删除未登记文件。空 franchise 可删除其已知片及 manifest 项；全空目标返回明确拒绝（当前 reader 不接受空 manifest），不伪称已支持清空整个库。
- 测试覆盖不变零写计划、修改、新增系列、删除最后条目、跨系列移动、顺序/count、重复与路径/slug 冲突、未知身份、缺片、全空拒绝、冻结输入不变；以计划应用到内存后再聚合证明结果正确。不得修改生产蓝图或编译提示词；本批只是保存事务前的规划模块，不宣称保存/回滚已修好。

### G13：只复制差异文件的增量候选包

独占 `scripts/lib/resource-pack.js`、`scripts/maintenance/stage-resource-pack.js`、`scripts/tests/test-resource-pack.js`；可新增纯辅助 `scripts/lib/resource-pack-delta.js` 与相应测试。独占必要 `scripts/workflow.js`、`scripts/tests/quality-test-inventory.js`、`docs/workflow.md` 注册。只读复用 resource-manifest 库，不修改它。回执 `scripts/archive/glm-g13-resource-delta/result.md`。

- 在现有入口新增可选 `--base-manifest <root内旧JSON>`，与 `--manifest <新JSON>` 同用；无此参数保留 G10 全包行为。复用现有纯比较结果，新增/改变项才复制，unchanged 不进候选文件，removed 仅作为差异记录，不删除任何源/目标资源。
- 明确产物是增量候选，不是完整可安装包。候选 manifest.json 只列实际复制的 added/changed 项，可由已有 verifier 核验；另写 delta.json 记录旧/新清单内容身份（稳定路径/bytes/sha256，不依赖 generatedAt）、四类数量和移除路径，供以后基线匹配用。不要冒充数字签名/可信来源，不实现安装或执行删除。
- 旧清单仅做结构核验，不读取旧资产（其 removed 文件可已不存在）；新清单实际文件继续按 G10 完整核验，不能用增量缩小绕过新清单损坏。任一清单结构错误/非空 unverified 拒绝。默认 preview 零写入，help/plan 零目标读取；完全无差异也可输出明确的零资产候选，不能称已安装更新。
- 复用现有安全复制与 staging 协议，不另造宽松通道。manifest.json 和 delta.json 都须在最终改名前读回核对；副本哈希失败、元数据损坏、目标冲突、源或路径变化不报告成功。保留 Windows-only apply、排除域、独占写入、同名拒绝等所有 G10 回归。只用临时夹具，不导出真实资产。
- 测试旧 removed 文件缺失仍可比较、added/changed 字节正确且 unchanged 未复制、仅删除/无差异、坏旧/新清单、时间戳不影响身份、预览不写、两个元数据写坏不发布、已有全包模式兼容。文件接近 600 行时拆独立辅助/测试文件；主任务统一最终门禁。
