# 统一工作流手册

> 维护日期：2026-09-13。命令注册与默认参数以 scripts/workflow.js 为准；此页解释操作顺序，不重复易漂移的脚本数量、角色规模和历史测试用例数。

## 先查入口

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

## 数据维护

| 操作 | 入口 | 注意事项 |
| --- | --- | --- |
| 场景分片聚合 | data:build | data/scenes → scenes.json |
| 热门角色聚合 | popular:build | data/popular → popular-characters.json |
| 蓝图聚合 | blueprints:build | 使用既有蓝图分片源，不直接改聚合产物 |
| 聚合反向写回分片 | data:import / popular:import / blueprints:import | 覆盖写入操作，先核对 diff；popular:split/blueprints:split 只拆分 |
| 数据契约与版本 | data:validate | DATA_VERSION 哈希域以 scripts/lib/data-version.js 为唯一事实源 |
| 分类与规范化 | data:normalize | 会写数据，不用于只读文档审计；遵守定稿保护 |

详细文件职责见 [维护手册](maintenance.md#文件职责)。构建脚本会同步版本；校验失败需定位来源，不能只改版本掩盖数据漂移。

场景语义门禁复用工作台的镜头过滤和负向组装（scripts/lib/scene-render-contract.js），检索 tags 不冒充发送给模型的词条。`optimize-scenes --check` 检查持久化数据的实际编译结果；changed 表示可选的格式改写建议，不要求机械改写提示词。分级脚本只维护分级/使用元数据，不再改写 negative；任何提示词改写仍须独立真实出图和定稿保护验收。

## 参考库

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
| gate:full | typecheck + check + frontend + unit + contract + build，全量入口 |
| build:web / build:runtime | 前端与预算/预压；服务 TypeScript 编译 |
| check:style-debt | 样式字面值、颜色、动画和双主题全局/角色令牌对比度；动态组件另做视觉验收 |
| check:monolith / check:pinned-scenes / check:rewrite | 体量、定稿与改写完整性；rewrite 交付需传 --delivery |
| check:popular / check:anima-routes / check:frontend | 热门、Anima 接口与前端单测 |
| test:contract / test:e2e:critical | 契约套件与关键浏览器回归 |
| test:e2e:performance | 已构建产物的单 worker 冷／热进入与首次操作测量；与回归分开执行 |

关键浏览器回归包含 `ui-layout.spec.ts` 的双主题/多尺寸布局与可读性检查。独立 UI 预览可用 `AICS_UI_AUDIT_URL` 指向隔离服务；默认检查本机 3000，不依赖 networkidle 等待长轮询停止。

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

桌面唯一入口是 `deploy-desktop.bat`，两个 deploy 工作流均调用它并保留 Cleanup 默认行为；自动调用不等待按键且保留失败退出码。`deploy:desktop` 默认跳过构建，必须已有新构建；`deploy:desktop:full` 执行完整增量流程。依赖/exe 变化的完整安装与 UAC 见 [部署指南](desktop-deployment.md)。

## 备份与清理

`backup:git` 创建本地 bundle 增量链（2 个锚点 + 默认 10 个增量），不能替代 push 或异地副本。`runtime:clean` 默认只预览；`--prune --days 60` 会实际清理。先检查路径与白名单，避免清除当前运行资料。

## 自动化检查与审计入口

| 自动化 | 触发与范围 |
| --- | --- |
| Quality | push / PR：构建、静态检查、前端覆盖率、unit、contract、关键浏览器回归 |
| Nightly visual regression | 每日北京时间 02:00 / 手动：主题、截图与视觉矩阵 |
| Windows Native Live2D | main push / 手动：自托管 Windows 的 Tauri、Rust、原生自测与稳定性检查 |

当前办公机修复与未执行范围见 [1.7.1](releases/v1.7.1.md)；[独立审计（2026-09-12）](archive/audits/office-independent-audit-2026-09-12.md) 保留修复前证据，[工作流审计（2026-09-08）](archive/audits/workflow-audit-2026-09-08.md) 保留为历史。本机 gate:full 不包含浏览器、真实出图或原生桌面验收，这些仍按改动另行执行。
