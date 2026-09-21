# 工作流治理实施与复核记录（2026-09-13–14）

> 2026-09-21 合并归档。由 GLM 交接、分批任务、W1 首次实施/复核及六报告的工程后续记录整理而来。以下数字、失败和“待修”均属于所标基线；不构成重新派工。当前实现查 [项目状态](../../project-status.md)，剩余验收查 [未来规划](../../roadmap.md)。原文可从整理前提交 `d348b3d` 查询。

## 合并范围与结论

W1 元数据与覆盖报告、A/RB/RC、N1–N3、G1–G16 的办公机实施和复核已留证；RD 只覆盖部分故障用例。蓝图适配器当时不等于保存事务接线，后续接线情况以项目状态为准。真实素材、审核发布、安装、物理断电与设备范围不因文档合并关闭。

旧分批任务的实施细节由下方实际结果取代，删除额度安排、并行派工、共享工作区与提交指令。只读描述元数据不等于执行许可，候选字节核验不等于已审核发布。

## 首轮盘点的修正依据

原报告值得作为实施线索。已重新运行注册表审计，确认 74 项入口无断链/循环；检查其一次性脚本后重新运行，主要规模与引用差额能复现。重点源码已核实：

- `render-all-outfits-references.js` 与 `generate-all-scenes-showcase-miaomiao.js` 默认网关确为 3123，`reference:render` 的注册说明写 3000，存在配置说明不一致。先明确默认及覆盖规则，不能全仓替换 3123。
- `render-showcase-gaps.js` 在 dry-run 判断前 mkdir，成功出图后直接写目标清单并把 `review.verdict` 填为 pass；必须拆清生成成功、已审核和已发布。仅把 pass 改 pending 并不能防止原图已写进活跃目录。
- `generate-all-scenes-showcase-miaomiao.js` 使用固定版本目录。候选输出、审核和发布边界需要专门改造与故障测试。
- 971 套热门服装中有 357 套未在标准参考库登记；现有 register 只处理整角色标准服装为空的情况。该差额是覆盖待办，不是悬空引用，不授权自动补描述、机位或触发出图。
- CSS 的 historia_reiss 选择器没有对应 canonical krista_lenz；除默认主题角色 nene 外，8 个角色未匹配显式主题。需区分旧别名、允许默认与待补，不能统一套一套颜色或直接改为硬失败。

报告需更正：DATA_VERSION 当前为 13 个产物，不是 12；“只读门禁（11）”与实际枚举不符；“只读但默认即写”分类不适合作为机器元数据。热门/蓝图检查是解析对象序列化比较，场景部分只比较数量，不能宣称全域逐字节零漂移。参考 URL 非空也不表示图片已完成。本次未把 74 个底层脚本全部重新逐行审计。

## W1 初版设计与已知局限

### 0. 盘点修订（复核更正落实）

[glm-governance-inventory.md](../../research/engineering/glm-governance-inventory.md) / [.json](../../research/engineering/glm-governance-inventory.json) 顶部新增「复核更正」节（JSON `meta.review.corrections`），逐条保留可追溯记录：

- R1 DATA_VERSION 哈希域 12 → **13**（`scripts/lib/data-version.js:18-23` 注释明示）；
- R2 「分片↔聚合逐字节零漂移」改为准确表述：popular/blueprint 为**解析后逐条 JSON 序列化比较**，场景为数量与 scenes-index 计数一致；
- R3 「只读门禁（11）」枚举失实 → §3.3 改为 facet 描述；单一「只读但默认即写」标签不进入机器元数据；
- R4 补记：参考 URL 非空 ≠ 图片已交付/通过审核；缺登记 357 项是**覆盖待办而非悬空引用**。

另按实数据核补：nene 的 `accent_color(#38bdf8)` 与 tokens.css `:root` 默认色 `#ff75a0` 不同源，「nene 走默认主题」属人工约定，不可由数据推导（影响 B 的实现选择，见 §2）。

### 1. A：W1 工作流执行元数据

#### 设计

- 元数据**内联**在每个 `WORKFLOWS` 注册项（`scripts/workflow.js`），字段：
  - `nature`：默认（无开关）行为的 facet 多值；枚举 `EFFECTS`（read-only / preview / self-heal-missing / guard / writes-source / writes-product / writes-release / writes-baseline / delete / external-model / network-download / publish-remote / service / isolated-fixture）；
  - `machine`：`MACHINES`（node / windows / windows-toolchain / python-pillow / gateway / comfyui / vision-api / network / playwright-browser / build-present）；
  - `switches`：显式开关 → 行为 facet（如 `data:build --check` → `['self-heal-missing','guard']`、`runtime:clean --prune` → `['delete']`）；
  - `resume`：idempotent | checkpoint | na；`evidence`：核实位置（文件:行）；`unknown`：未核实点；`notes`：已确证缺陷登记（如 C1/C2/C3，不改执行）。
- **共用**：`node scripts/workflow.js <命令> --help` 的详细 JSON 输出 `run` 字段；`--plan` 预览每步追加 `[nature]` 标注；`audit:workflows` 校验元数据（缺字段/未知枚举/复合只读/开关格式/空 evidence 均报错并计入退出码）。`audit:workflows --json` 实测 `count=75, errors=[]`。
- **零行为变化**：runner 的 `main/plan/invocation` 执行路径不读取 `run`，无基于元数据的拦截；所有命令、参数、默认端点、目录、发布行为不变（`deploy-desktop.bat`、`render-showcase-gaps.js`、`generate-all-scenes-showcase-miaomiao.js`、`reference:render` 的执行逻辑一律未动，缺陷只在 `notes` 里登记）。
- 复合工作流（`reference:full`/`showcase:full`）显式给 `run`，审计强制「复合不得仅标 read-only/preview/夹具」。

#### 测试证据（scripts/tests/test-workflow-runner.js，15/15 通过）

新增 5 个真实行为测试（非快照）：

1. 74+1 项 `validateRun` 全部合法；
2. 审计拒绝：缺 run、复合只读、未知枚举、非 `--` 开关、非法 resume、空 evidence；
3. **元数据仅描述性**：`machine:['windows']` 的 node 命令在任何平台按原参数执行（无拦截）；
4. **旧调用不变**：注入 run spy 断言 `data:build`/`check:content`/`showcase:scene-candidates` 的真实 cmd/args 逐字节不变（npm 无转发参数时不插 `--`，语义保持）；
5. **help/plan 不调用执行器**（注入会抛错的 run）；help 输出含 run 与 `self-heal-missing`；`--plan` 输出 `[preview]` 标注且必填参数校验照常生效；
6. 语义一致性不变式：external-model 必须声明 gateway/comfyui/vision-api 之一、默认 preview 的发布器不得默认写入、复合 nature 与子步骤有交集、定点校验（`data:build --check` 自愈+守卫、`reference:register` 默认写、`runtime:clean --prune` 删除、`showcase:full` 发布步无 writes-release）。

### 2. B：只读内容覆盖差额报告

#### 设计（scripts/maintenance/report-content-coverage.js）

- **入口**：`npm run wf -- audit:coverage [--json] [--root <夹具根>]`（已登记 WORKFLOWS + docs/workflow.md「内容覆盖差额报告」节）。
- **复用现有读取器**：`scripts/lib/popular-store.js`（分片+manifest，通过 `AICS_DATA_ROOT` 支持夹具根）、`server/config.resolveCharRefRoot`（素材根解析，与 `check:ref-urls` 同口径）；standards/view/characters/tokens.css 只读。
- **输出分类**（每条含对象 ID、所在源文件、差额类型、关联位置）：
  - 参考：`missing-reference-registration`（357，109 角色，含分片文件名）、`reference-pending`（282 套形态存在 pending 视角）、`missing-image`（URL 已填但素材根 statSync 缺文件）、`unverified`（素材根不存在/structure 模式，不冒充缺图也不冒充通过；本机 2324 条属此类）、`reference-only-forms`（30，sync 自动追加机制，单列不混入差额）；
  - 主题：explicit 151 / default-allowed `nene`（显式清单，附证据注释）/ 待补 8（含 characters.json 的 accent_color 供修复参考）/ 旧别名 `historia_reiss`（经 popular 别名归一匹配建议 `krista_lenz`，标「待人工确认」）/ 未归类 `triad`（共享主题，人工归类）。
- **结构错误退出 1**（清单缺文件、跨分片重复角色/服装 ID、manifest 条目缺 count 或批次数不符、standards↔view 镜像破坏）；**覆盖差额恒退出 0**（信息性，不作为门禁失败依据）。不写任何文件、不批量登记、不出图、不改主题。
- 输出确定性：排序稳定、无时间戳（可复跑 diff）。

#### 测试证据（scripts/tests/test-coverage-report.js，6/6 通过，已登记 unit 套件）

隔离夹具（tmp 目录，覆盖交接要求全部验收点）：双方 ID 集合差额精确断言；pending/缺实图/无法核实三分（注入 fileExists true/false/null）；standards 独有形态不混入差额；跨文件重复角色+重复服装 ID → 结构错误；standards↔view 镜像破坏 → 结构错误；manifest 批次数不符 → CLI 退出 1；分片缺文件 → CLI 退出 1；CLI 两次运行 stdout 逐字节一致；`fileExists` 区分「真缺图」与「素材根缺失」，越界路径拒绝。

#### 生产数据实测（2026-09-13，本机）

`node scripts/maintenance/report-content-coverage.js --json` → 退出 0，结构错误 0；缺登记 357 / pending 282 套 / 缺实图 0 / 无法核实 2324 / 参考库独有 30；主题 explicit 151 / 缺 8 / 旧别名 1（→krista_lenz）/ 未归类 1（triad）。与盘点数字一致。快照存 `scripts/archive/glm-governance/coverage-report-2026-09-13.json`（gitignored，非交付物）。


### 初版证据限制

初版 runner 15 项、覆盖报告 6 项的证据仅代表首次交付；复合只读限制、环境/模块缓存读取和若干漏检在下一节修正。初版未逐行核验 check:rewrite 主体；C1/C2/C3 当时仅记入 notes，未改执行逻辑。初版运行日志和覆盖快照在本机 scripts/archive/glm-governance，非远端交付物。

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

## 审核范围排除项

W1 当次没有审查生产提示词、分级或 NSFW 规范；Gemini 候选只能按未编译/未出图草稿理解。三条候选的源身份/衣装快照与原 60/12 批次的覆盖不能混算，未验证材料不得升级为生产规范。

## GLM A/B/C/D 后续产物复核

基线 `f753287`。A 提交了三个受控文件的工作流说明/元数据修改；B/C/D 均在各自本机临时归档目录交付，无生产内容修改。

- **A 工程修改已整合并补修**：安装开关原先只写 notes，主任务让批处理入口的单杠字母开关进入 switches 并在 plan 显示，其他入口校验及实际批处理参数转发不变。补充 DATA_VERSION 的 writes-source 和缓存清理的 delete 描述；澄清 build/check、无构建浏览器入口及证据位置。定向 workflow-runner/conditions 24 项通过，预览断言确认未调用部署执行器。
- **B 统计采纳，工具待修**：629 文件、353,211,795 字节独立复算一致；原有 18 项夹具重新执行通过，但未覆盖 Windows 解码后的反斜杠。`assets/characters%5c..%5c..%5cpackage.json` 会被误判为允许根内文件并 stat 到 assets 之外，已复现；junction/真实路径边界缺少保障，尚未做链接复现。不能将该一次性脚本作为正式资产边界工具。分组/引用线索不等于可删除资源清单。
- **C 部分采纳**：view 合并规则、跨文件 default→isDefault 派生和角色内服装 ID 解析有证据。Marin 某形态缺失被归因于 isNsfw 无依据，实际过滤还检查磁盘机位；accent_color 有覆盖审计读取者。绝对“无消费者”及未知根因须修正，不把整份材料直接升格为契约。
- **D 保留为未执行草稿**：F11/F12 用 not-ready 且接受 idle，不能证明故障已经发生；F7 容器可见不证明回退画面；F1 过度限定回退实现；F8 缓存/重复请求及多项恢复操作未闭环。未接入正式门禁、未作浏览器通过声明。


本次完整门禁通过，见 [执行日志](../../evidence/glm-workflow-gate-2026-09-13.txt)：check、vitest、623 项 unit、26 组 contract 和生产构建，总计 2 分 18 秒。显式使用 AICS_REFERENCE_AUDIT_MODE=structure，仅验证外部参考索引结构，不验证文件可用性或画质。工作流注册审计 79 项、文档检查 184 文件/1003 链接通过；未实际运行部署、安装或浏览器 UI 验收。

## RB/RC/RD 修订后的验收

基线 `e34cad7`。本段覆盖上节待修项的新状态，旧记录保留为过程证据。

- **RB 可收尾**：主任务重跑 38 项临时夹具，失败 0、跳过 0，包括编码反斜杠拒绝、junction 真实路径边界、缺失目标祖先检查和遍历不跟随链接。重新运行清点主流程，629 个文件/353,211,795 字节，160/160 声明立绘文件存在，新49四份成员证据差集为空且 49/49 文件存在。工具仍是本机一次性盘点，不是生产安全边界或图片质量证明。
- **RC 已落入维护手册**：采纳五域入口、角色内服装寻址、参考 view 合并、accent_color 机器读者及 sync 的磁盘过滤边界。没有采纳“档案编辑必跑全量 validate”“必跑参考 sync”的建议，也没有复制全系统无读者等绝对判断。见 [维护边界](../../maintenance.md#人物服装与参考域的维护边界)。
- **RD 部分已实际验收**：原草稿首次浏览器抽验 2 过/3 失败，另外 5 项因 maxFailures 未运行；两处 F05 失败源于断言隐藏图片可见，F08 灯箱故障未稳定触发。不能把这些失败归为产品回归。
- 主任务修正 F03 的同角色解码/恢复检查、F05 的隐藏图片与同卡提示、F08b 的恢复解码、故障态截图，以及 route 注册/响应的 await。选取 F03/F05/F08b/F09 纳入 `tests/e2e/resource-recovery.spec.ts`，独立端口使用既有构建及本地图片/JSON 响应夹具，深浅主题 **8/8 通过**。不依赖外部参考目录，不调用生成模型；截图与 DOM 断言不等同于 WCAG 全站视觉验收。
- F01/F02/F04 的产品回退仍待实现；F08 的缓存/故障触发、F07 的像素视觉、F10–F12 的模型前置与失败恢复尚未验收，未纳入正式测试。整份 RD 不标为全部完成。


当次统计、夹具结果与测试源码哈希见 [验收摘要](../../evidence/resource-recovery-2026-09-13.json)，正式测试执行见 [浏览器日志](../../evidence/resource-recovery-browser-2026-09-13.txt)。本机一次性脚本和旧失败 trace 留在 scripts/archive，远端复验浏览器流程使用已提交的测试文件，不依赖这些临时路径。

整合后的 [完整门禁](../../evidence/resource-recovery-gate-2026-09-13.txt) 通过：check、vitest、623 项 unit、26 组 contract 与生产构建，总计 2 分 5 秒。仍显式使用 structure 参考模式。首次门禁被上一轮日志在本机保留的 CRLF 阻断，已将该工作树文件换行规范到 Git 中的 LF 后重跑；没有修改历史测试结果或放宽门禁。

## N1/N2 首页与角色详情图片回退

基线 `afeb050`。GLM 提交首页英雄图/热门横条的逐图失败占位，以及角色详情主图→缩略图→缺失说明的实现。主任务复核后移除未纳入本批验收的最近作品封面扩展，保留本批页面边界。

角色详情的失败/加载状态移入 `usePortraitFallback`：角色或主图/缩略图变化产生新尝试周期，每个来源在同周期只尝试一次；旧周期 load/error 不影响当前图片、加载状态或宽高比。4 项单测覆盖同实例 A→B→A、相同 URL 跨角色、迟到事件和相同主/缩略图去重。回退成功提示只在图片实际 load 后显示。

新增缺失文字使用主题背景与文本令牌，不能沿用“画框永远深色”的假设：workspace-layout 实际将资料库画框改为透明。来源和回退说明改成可换行的正常布局，避免窄画框相互覆盖。没有修改图像资产、提示词、分级、参考索引或安装包资源清单；R1 下载、独立资源包和完整安装验收仍是后续工作。

验收已完成：完整门禁（623 项 unit、26 组 contract、前端测试与构建）通过；首页 8 项、详情 10 项、视觉 6 项和既有资源恢复 8 项合计 **32 项浏览器检查通过**。视觉检查复用实际层叠文字对比度工具，新增文字均满足 4.5:1，来源与说明无重叠；覆盖深浅主题、1440×960、2560×1440 DPR1.5 和 390×844。

看截图发现首页窄屏底部渐变仍压淡占位文字，最终在缺图状态关闭图片装饰渐变（正常图片保留），并将占位置于装饰层之上。该调整后重新通过样式检查、前端类型检查、构建和相关 **14 项浏览器复验**，没有因局部层级修正重复无关全量测试。代表截图已人工查看；4K/150% 为浏览器等效视口，不替代物理设备/DPI/WebView2 验收。

源码/构建哈希、验证范围和日志索引见 [N1/N2 验收摘要](../../evidence/image-fallback-2026-09-13/summary.json)。截图示例：[首页窄屏浅色](../../evidence/image-fallback-2026-09-13/home-phone-light.png)、[首页桌面深色](../../evidence/image-fallback-2026-09-13/home-desktop-dark.png)、[详情缺图浅色](../../evidence/image-fallback-2026-09-13/portrait-missing-desktop-light.png)、[详情缺图深色](../../evidence/image-fallback-2026-09-13/portrait-missing-desktop-dark.png)、[缩略图回退浅色](../../evidence/image-fallback-2026-09-13/portrait-fallback-4k150-light.png)、[缩略图回退深色](../../evidence/image-fallback-2026-09-13/portrait-fallback-4k150-dark.png)。

## N3 场景手帖与 404 页插图回退

基线 `c3db914`。场景手帖按角色记录图片失败，保留台词与场景入口，切换回失败角色时允许一次新的尝试；404 页插图失败改为明确占位，保留错误路径和返回链接。没有修改图片文件、分级、生成请求或通用路由逻辑。

主任务补充占位区域的台词留白；仅提高 z-index 不能证明文字不重叠。浏览器视觉用例检查两个文本 Range 的实际位置，并对新增占位文字核对 4.5:1 对比度；覆盖深浅主题及 1440、768、390 三种视口宽度，同时验证 404 页返回首页的真实导航。

完整门禁通过（623 项 unit、26 组 contract、前端测试和构建，总计 2 分 6 秒，structure 参考模式）。首轮浏览器中的 404 失败来自测试未拦截 Vite 生成的带哈希图片地址，已修正夹具匹配；最终 **14 项通过**：N3 行为 6 项、布局/对比度 6 项、既有场景卡回归 2 项。代表截图经主任务查看，占位与台词无重叠，返回入口保持可用；不等同于真机安装、模型或全站离线验收。

源码/构建标识及日志见 [N3 验收摘要](../../evidence/illustration-recovery-2026-09-13/summary.json)。截图：[场景窄屏浅色](../../evidence/illustration-recovery-2026-09-13/scene-390-light.png)、[场景窄屏深色](../../evidence/illustration-recovery-2026-09-13/scene-390-dark.png)、[404 窄屏浅色](../../evidence/illustration-recovery-2026-09-13/notfound-390-light.png)、[404 桌面深色](../../evidence/illustration-recovery-2026-09-13/notfound-1440-dark.png)。N1–N3 图片回退批次已收尾，独立资源包/下载/离线导入和蓝图保存持久化仍按 roadmap 单独追踪。

## G1/G2/G3 治理实施复核

基线 `266d61f`，三个批次独占文件，无生产数据修改。

- **G1**：补核心精选保存清洗、主校验及统一数据根。主任务补修旧请求漏字段时的保存链：在已有锁与 baseVersion 检查后，将当前核心精选提供给清洗函数；缺省保留现存值、显式空数组清空，不合并其他字段。GLM 原测试只证明“不补空数组”，实际仍会删除磁盘字段，现已替换为真实 HTTP 保存保留/清空断言。CLI 夹具验证重复、退役、非字符串/非数组、空和缺省；没有修改预算、策展层级或蓝图事务。
- **G2**：条件报告增加 switches/notes/needs 原值及清楚的文字格式，旧字段、schemaVersion、not-run 和退出码保持；相应帮助、预览、复合项和输入不变性测试通过，未发现执行或只读边界回归。
- **G3**：五域职责说明已落实工具。主任务纠正“traits 只存在 JSON”的误导表述，补提示词组装读取者；loadPopularShards 只称 build/自愈的分片聚合入口，不再称 split/所有审计共用的唯一入口。静态说明不等于穷尽消费者或实际执行验收。

既有 test-scene-shard-integrity 已有 core 引用/预算检查，本批补的是保存入口与主校验缺口，不称全项目从无校验。普通档案维护与生成字段变更的验收边界保持分开；蓝图保存持久化和完整资源分发仍未交付。

最终验收通过：G1 定向 24 项、G2/G3 定向 21 项；完整门禁含 **632 项 unit、26 组 contract、前端测试与构建**，总计 2 分 7 秒，显式 structure 参考模式。新增测试的正则空格写法及未使用变量曾阻断 lint，已修正并重跑通过，未放宽规则。注册审计 79 项通过；条件报告仍将所有入口标记 not-run，报告成功不冒充命令执行验收。源码哈希与范围见 [G1–G3 摘要](../../evidence/governance-g1-g3-2026-09-13/summary.json)，执行记录见 [门禁日志](../../evidence/governance-g1-g3-2026-09-13/gate.txt)。


## G4/G5/G6 复核与验收（2026-09-14）

基线 `3a7c095`。G4 的交付审计文字输出已整合，保持 JSON、状态与退出码兼容；32 项定向测试通过。G5 增加正式 `audit:resource-manifest` 入口及资源清单库；G6 补齐八位角色主题，保留 historia_reiss 兼容选择器与 nene 默认主题。

主任务补强 G5 四项边界：Windows 大小写及 junction 别名不得绕过参考排除域；assets 扫描根自身是链接时不遍历；生成清单携带未核验项时，校验不能将其升级为整体通过；Windows 大小写重复路径不得重复计作已核验。15 项隔离测试全部通过且无跳过；当前仓库只读生成/校验往返核实 **629 文件、353,211,795 字节**，清单列出的 629 项全部匹配。没有删除、转换或分发图片，未将文件匹配写成画质或可信发布验收。

G6 真实深链选择八角色并核对名称与颜色，另测选择面板点击、旧别名编译规则，共 **18 项浏览器检查通过**。标准表面颜色与真实渐变按钮分别测量；真实控件取样先结束动画、暂时隐藏文字截取背景再恢复，不把纯色公式套到渐变背景，也不降低 4.5 阈值。16 张深浅截图已逐角色查看，角色面板与相关控件文字清晰；截图包含短暂切换通知，不宣称全页所有浮层均无遮挡。缺显式主题由 8 降到 0，旧别名仍在覆盖报告中，属于刻意兼容。

完整门禁 **653 项 unit、26 组 contract、前端测试与构建**通过，总计 2 分 12 秒；80 个工作流入口结构审计通过。最后的浏览器测试修正后，TypeScript 与定向 ESLint 再次通过。曾遇到新增测试的两处 CRLF，已规范到 LF 后重跑，未调整门禁规则。G6 回执披露曾临时使用 stash 查询旧版本；主任务确认当前 stash 为空、已核对本批差异，后续读取旧版本只用 git show，禁止 stash 等 Git 写操作。

源码/构建标识、验证范围和 16 张截图索引见 [G4–G6 摘要](../../evidence/governance-g4-g6-2026-09-14/summary.json)，[门禁日志](../../evidence/governance-g4-g6-2026-09-14/gate.txt)、[浏览器日志](../../evidence/governance-g4-g6-2026-09-14/browser.txt)。本批未做真实生成、安装或原生设备验收；蓝图持久化、资源下载/离线导入及完整分发仍单列待办。

## G7 资源清单差异比较（2026-09-14）

基线 `2ea9455`。纯结构检查与清单读取在生成/核验/比较入口之间复用；新增 `--manifest <旧> --compare-manifest <新>`，明确以参数决定方向，按精确路径列出 added/removed/changed 和 unchanged 数量。改变记录保留前后字节数与哈希，不按时间戳判新旧、不猜重命名。原生成与单清单文件核验模式保持。

主任务和独立复核未发现阻塞问题，补了一项冻结输入及同哈希改路径的正式回归。结构错误不计算差异；非空 unverified 时可列已知条目差异，但 ok=false、退出 1，identical 仅描述已列条目，不能独自代表完整一致。比较阶段只读取两份指定清单，不访问/哈希实际资产；测试包含旧文件已从夹具删除的情况。

当前仓库新生成清单与上一批保留清单经真实 CLI 比较：ok=true、identical=true，629 项 unchanged，added/removed/changed 均为 0。这是清单条目比较，不替代目录覆盖、图片质量、可信发布或安装验收。

最终资源测试 22 项通过；完整门禁含 **660 项 unit、26 组 contract、前端测试与构建**，总计 2 分 5 秒，structure 参考模式；80 项注册审计通过。见 [G7 验收摘要](../../evidence/resource-diff-2026-09-14/summary.json)及[门禁日志](../../evidence/resource-diff-2026-09-14/gate.txt)。本批无需浏览器验收，未修改 UI 或生产资产。

## G8/G9/G10 工具筛选与候选包导出（2026-09-14）

基线 `be1c0b3`。G8 改为人类可读影响报告，保留 JSON/退出码；主任务修正推荐命令 nature 实为数组导致性质漏显，并补路径截断剩余数量。G9 增加角色/服装筛选并保留全域结构错误；复核修复共用 URL 时未选条目抬高 verified 数量、热门零服装角色误判未知及全域重复身份字段丢失，参数异常明确拒绝。

G10 实现默认只读预览、显式 apply 导出候选包。复核补上发布前读取磁盘 manifest 并与预期完整比较，防止清单写坏或漏条目后先发布再失败；复制前重核源真实排除域，写前/发布前复核目标祖先，副本独占写入。实际复制限定 Windows，测试中在 rename 瞬间创建同名空目录，确认拒绝覆盖；其他平台可预览但拒绝 apply。仍不承诺面对恶意本地进程不断替换路径的绝对事务隔离。

定向用例 G8 46、G9 20、G10 20，既有清单 22 项；完整门禁含 **696 项 unit、26 组 contract、前端测试与构建**通过，structure 参考模式；81 项注册审计通过。初次门禁发现四处测试未使用变量，修正后完整重跑；新测试 CRLF 也已规范，未放宽检查规则。见 [G8–G10 验收摘要](../../evidence/governance-g8-g10-2026-09-14/summary.json)与[门禁日志](../../evidence/governance-g8-g10-2026-09-14/gate.txt)。

本批无 UI 改动，不需浏览器视觉复验；所有导出写入测试使用临时夹具，没有复制真实素材、安装或下载。候选字节核验不等于质量/审核/安装验收，完整资源分发及蓝图保存事务仍未完成。后续隔离根、规划器和增量候选的结果见下节。

## G11/G12/G13 隔离根、蓝图规划与增量候选（2026-09-14）

基线 `407011d`。G11 使内容契约 CLI 按 AICS_DATA_ROOT/AICS_APP_ROOT/仓库根优先级读取完整布局，数据、压缩产物和版本检查同根，缺文件不回退生产；规则代码仍来自仓库。主任务补 CLI 预加载 fs 探针，验证夹具校验不读取仓库 data/assets/src/stores 且无写入；明确外部素材环境配置仍保留。12 项隔离回归通过。

G12 纯规划器输出分片写删、未变项、manifest 与聚合，不读写文件。复核补拒绝既有分片 Windows 设备名，修正 Object.assign 遇 JSON 自有 __proto__ 字段导致扩展字段丢失，并补完整字段保真断言。19 项测试通过；真实当前库只读规划 1692 条蓝图、70 个分片，dirty=false，零写删。保存路由及跨文件回滚尚未接入，本项不关闭蓝图持久化缺陷。

G13 增量候选只复制 added/changed，removed 仅记录；旧清单结构核验、新清单全部已列文件核验，保持全包安全复制通道。清单内容身份按稳定 path/bytes/hash 计算，候选 manifest 只列实际复制项，delta.json 保留基线/目标身份。主任务补最终改名后所有元数据读回验证，避免 delta.json 在该阶段损坏仍报告成功；增加身份稳定性及未复制的 unchanged 新资产损坏仍拒绝回归。增量 15 项、全包 20 项测试通过。

完整门禁 **742 项 unit、26 组 contract、前端测试与构建**通过，总计 2 分 50 秒，structure 参考模式；81 项注册审计通过。新 G11 测试的一处未使用参数已在完整门禁前清理。见 [G11–G13 验收摘要](../../evidence/governance-g11-g13-2026-09-14/summary.json)及[门禁日志](../../evidence/governance-g11-g13-2026-09-14/gate.txt)。未修改 UI/生产内容或资源，未安装/下载/真实生成，所有导出写入仍只用临时夹具；增量候选不等于已安装更新或可信发布。


## G14/G15/G16 参考根、增量核验与蓝图写入适配（2026-09-14）

基线 `b655487`。用户同时进行 UI 设计升级，本轮仅整合指定 scripts 工具、测试与工程文档，未修改或暂存 UI 文件。完整验证采用 detached 基线的独立 worktree，只叠加本轮受控工具文件；依赖单独复制、构建仅写隔离目录，不借用或更新原工作区 dist，结果不涵盖并行 UI 升级。

G14 参考校验 CLI 支持显式 root 与双环境根优先级，view/appRoot 对齐，保留显式素材根及原 API 判定；help/plan 零读取。主任务补畸形嵌套视图的可定位失败处理，清理测试未用变量；10 项根回归及既有内容/参考回归通过。

G15 实现增量候选与给定基线的只读兼容核验。复核补重建目标的完整结构检查，拒绝 Windows 基线/候选之间大小写冲突；候选目录先检查真实边界再访问，内部 manifest/delta 不能通过别名读到包外同根文件。18 项回归通过；核验只证明相对于指定基线可重建声明目标且候选字节匹配，不证明安装状态、可信来源或画质。

G16 磁盘准备/应用适配器复用纯规划器与已有快照约定。原实现未将 unchanged 分片纳入过期检查，且公开 Buffer 可修改、prepared 可仿造；复核改用 WeakMap 认证原始对象，保留私有全部源基线，快照篡改和未变分片漂移均在写入前拒绝。apply 重验目录防准备后换 junction；传给写适配器的字节为副本，防修改预期值绕过读回核验；临时文件随机命名并独占创建，计划复制后冻结，不冻结调用方目标。19 项回归通过，保存锁/统一备份/HTTP 路由和跨域回滚仍待主任务接入。

隔离完整门禁 **789 项 unit、26 组 contract、前端测试与构建**通过，structure 参考模式；82 项注册审计通过。首次新检出缺少 dist，聊天 SPA 回退契约因此失败；在隔离目录先构建再完整重跑，未使用并行 UI 产物。见 [G14–G16 验收摘要](../../evidence/governance-g14-g16-2026-09-14/summary.json)与[门禁日志](../../evidence/governance-g14-g16-2026-09-14/gate.txt)。本轮无生产数据/素材写入，无真实生成、安装或下载；蓝图适配器不计作保存事务已修复。
