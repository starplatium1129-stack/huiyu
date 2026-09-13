# 工程工作流与内容数据治理盘点（glm）

> 2026-09-13。为 [计划 006](../../../plans/006-workflow-and-content-governance.md) 的 W1（工作流执行条件与命名）与 D1（内容实体与字段归属）提供实施依据。
> 机器可读版本：[glm-governance-inventory.json](glm-governance-inventory.json)（74 个工作流逐项字段 + 10 个数据域 + 统计 + 问题清单）。
> 本轮只读：未运行任何写数据的维护命令、未出图、未安装/发布/提交。一次性核查脚本在被忽略的 `scripts/archive/glm-governance/`。

## 1. 摘要

- `scripts/workflow.js` 注册 **74** 个工作流，内置审计 `audit:workflows --json` 实测 `count=74, errors=[]`；runner 的 `--help`/`--plan` 永不执行子进程，`--dry-run` 是脚本级参数而非 runner 级。
- 数据域跨域引用整体健康：蓝图→角色、蓝图→服装、策展→场景、定稿→场景、退役→场景、参考 view↔standards 全部 **0 悬空**；六类 ID 全部 **0 重复**；分片↔聚合逐字节 **0 漂移**（统计见 §5，全部来自运行结果）。
- 确证问题 5 组：① `reference:render`/`showcase:batch-miaomiao` 默认网关是历史端点 3123，与注册表/文档写的 3000 矛盾；② `showcase:fill-gaps` 直写活跃 manifest、verdict 硬编码 `pass`、`--dry-run` 仍有 mkdir 副作用；③ `showcase:batch-miaomiao` 直写固定版本目录绕过版本化发布；④ 参考库对热门服装覆盖缺口 357/971（109 角色），形态级差额无对账入口；⑤ 主题层漂移（`historia_reiss` 旧别名主题 + 8 角色无主题）。
- 工作区存在其他会话并行改动（`docs/INDEX.md`、`SKILL.md` 等），本轮未触碰。

> **复核更正（2026-09-13，依据 [GLM 实施交接](../../guides/engineering/glm-implementation-handoff.md)）**：
> 1. DATA_VERSION 哈希域为 **13** 个产物（`scripts/lib/data-version.js:18-23` 注释明示），原文误写 12；
> 2. 「分片↔聚合逐字节 0 漂移」表述过强：popular/blueprint 为**解析后逐条 JSON 序列化比较**（语义级，非文件字节级），场景分片仅数量与 scenes-index 计数一致；
> 3. 原 §3.3「只读门禁（11）」枚举与实际条目数不符，已改为按 facet 描述；「只读但默认即写」这类单一标签不适合作为机器元数据，机器元数据由后续 W1 实施以多值 facet 承担；
> 4. 参考 URL 非空仅代表索引声明，不表示图片已交付或通过审核（`check-ref-urls.js` 的 URL 检查须配合素材根存在性）。
> 复核同时确认：74 项入口审计、主要规模与引用差额可复现；覆盖缺口是**覆盖待办而非悬空引用**，不授权自动补写。

## 2. 方法与覆盖分母

| 项 | 说明 |
| --- | --- |
| 工作流分母 | `scripts/workflow.js` `WORKFLOWS` 注册表全部 74 项（`node scripts/workflow.js audit:workflows --json` 实测） |
| 证据深度 | `full-read` 8 项（runner、data:build、popular:build、blueprints:build、gate:quick、runtime:clean、reference:register、deploy bat）；`subagent-verified` 7 项（样张辅助链，子代理逐行核实后主会话复核）；其余 59 项 `code-verified`（头注释 + 参数解析 + 写入点/退出点关键行抽取核实，工具 `scripts/archive/glm-governance/summarize-scripts.js`） |
| 数据域分母 | 10 个数据域（档案/热门身份/服装/场景/蓝图/策展/参考索引/样张/退役+定稿+版本/主题），统计全部来自 `scripts/archive/glm-governance/check-governance.js` 只读运行 |
| 样例先行 | 工作流样例 8 项（data:build、gate:quick/full、check:quick、runtime:clean、reference:register、showcase:full 复合链、audit:workflows）；角色样例 3 个（nene 工作室角色、misaka_mikoto 热门角色、raiden_shogun 多服装角色），逐域走通后再覆盖全量 |
| 并行子代理 | 5 个并行子代理中 4 个因环境并发限制失败，其范围改由主会话完成；1 个（样张辅助 7 项）完成并被采纳 |

## 3. 工作流盘点（W1 依据）

### 3.1 runner 机制（全部 74 项共享）

`scripts/lib/workflow-runner.js`（逐行核实）：

- **发现与执行分离**：`--help`/`search`/分组列举只打印注册信息并 `return 0`（:78-90，注释 "Never execute a child for discovery/help"）。执行前强制校验 `required` 参数（:93-95），子进程环境固定注入 `AICS_WORKFLOW_NONINTERACTIVE=1`（:104）。
- **`--plan` 与 `--dry-run` 是两层**：`--plan` 被 runner 拦截（:91-99），打印每步实际命令且不执行，不转发给底层脚本；`--dry-run` 会原样转发，仅当底层脚本自身支持才有效（如 `reference:register`、`showcase:scene-candidates`、`reference:design` 支持；`reference:render`、`showcase:generate` 不支持）。
- **复合命令**：`reference:full`（render→audit→repair）与 `showcase:full`（generate→audit→publish）不接受公共参数（:28 强制），失败即停返回该步退出码；`showcase:full` 在 `plan()`（:37-53）有参数白名单与分发特例，发布步永远只预览。
- **Windows 守卫**：`.bat` 入口仅 Windows、仅接受 `-Switch` 形式参数（:100-103），杜绝路径插值。
- **npm 间接入口**：`audit()` 校验 npm script 存在、脚本/文档路径存在、复合无循环；74 项全过。

### 3.2 full / check / dry-run / plan 辨析（W1 验收点）

| 命令 | 实际展开 | 是否含 build | 是否只读 |
| --- | --- | --- | --- |
| `check:quick` | `npm run check` → `run-check-parallel.js` 23 步并发（CHECK_JOBS=6） | 否 | 是，例外：池启动前 `ensureAll(onlyIfMissing)` 在产物缺失（fresh clone）时落盘自愈（:57，头注释声明） |
| `check:full` | `npm run validate` = check + vitest + unit + contract | **否** | 同上例外 |
| `gate:quick [面积]` | `gate-quick.js` 按 git 改动分类：ui/server/data；scripts/tests/desktop-tauri/.github/package.json/config 一律升级 full；纯文档跳过 | 否（full 面积除外） | data 面积跑三个 `--check` 构建守卫 |
| `gate:full` | `gate-quick.js full` = check + vitest + unit + contract + **`npm run build`**（:174-189） | **是**（末步真实 vite build+预算+预压） | 同 check 例外 |
| `data:build` 等聚合 | 默认写聚合+同步 DATA_VERSION；`--check` 产物缺失自愈、齐全但陈旧报错退出 1 | — | 默认**写** |
| `showcase:scene-publish` / `rating-refresh` | 默认即预览（发布类脚本的"预览是默认模式"），`--apply` 才写 | — | 默认只读，代码确认（:506-509 / :193-196） |
| `showcase:fill-gaps` | `--dry-run` 打印首个缺口任务 | — | **否**：`--dry-run` 仍无条件 mkdir（确证问题 C2） |
| `reference:full` / `showcase:full --plan` | 复合展开 | 否 | `--plan` 全链不执行；`reference:full` 无参数共享 |

### 3.3 分类清单（按操作性质，facet 描述）

完整逐项记录（命令展开、机器条件、输入输出、副作用、help/预览、续跑条件、file:line 证据）见 JSON 的 `workflows` 数组。同一命令可同时具有多种副作用，且默认行为、显式开关与前置缺失时的自愈需要分开（例如三个 `*:build` 默认写聚合，`--check` 在产物缺失时自愈、齐全但陈旧时只报错）。按"默认行为的主要 facet"归纳：

- **读取/校验类**（默认不写盘）：`check:contrast`、`check:animations`、`check:rewrite`、`check:popular`、`check:bundle`、`check:monolith`、`check:content`/`data:validate`、`docs:check`、`audit:workflows`、`audit:orphans`、`desktop:doctor`、`runtime:clean`（默认 dry-run）；其中带守卫语义（不一致即退出非零）的有 `check:contrast --check`、`check:animations --check`、`check:style-debt`、`check:ref-urls`、`check:pinned-scenes`、`check:bundle`、`audit:orphans --check`
- **隔离夹具测试**：`check:workflows`、`desktop:storage-benchmark`、`desktop:verify-gateway`、`check:anima-routes`、`check:frontend`、`test:contract`、`test:e2e:critical`、`test:e2e:performance`
- **默认写产物/源数据**（部分需显式开关才写）：三个 `*:build`（默认写聚合+DATA_VERSION；`--check` 产物缺失自愈、齐全但陈旧报错）、`check:quick`/`gate:*`/`check:full`/`test:contract`（只读为主，fresh clone 产物缺失时 ensureAll 落盘自愈）、`data:import`/`popular:import`/`blueprints:import`/`*:split`（`--write` 必需）、`data:normalize`（`--write` 链+定稿保护）、`data:apply`、`reference:register`（默认写 standards/view，`--dry-run` 才只读）、`reference:repair-urls`（默认写但有快照）、`character:onboard`（跨 9 域一站式）
- **调用外部模型/服务**：`reference:render/audit/repair/design`、`showcase:generate/audit/audit:scene/batch/batch-miaomiao/scene-candidates/fill-gaps`、`models:download-h3`（大文件下载）。视觉审核走本地 CLIProxyAPI（8317，回退 8000），出图走网关 3000 或 ComfyUI 8188 直连
- **发布/打包/部署**：`showcase:publish`/`scene-publish`/`rating-refresh`（默认预览+`--apply` 写）、`deploy:desktop(:full)`（Windows+UAC）、`installer:*`、`desktop:package-local`、`installer:bundle`（`--publish` 推 GitHub Releases）、`brand:build`、`build:web`、`build:runtime`、`backup:git`
- **启动服务**：`dev:web`、`dev:server`（prestart 先编译）、`comfy:start`

### 3.4 机器条件要点（W1“在哪类环境执行”）

- Node >= 22.18（`package.json` engines；脚本直接 `require('*.ts')` 依赖内建类型剥离）。
- 仅 Windows：`deploy:desktop(:full)`、`installer:*`、`comfy:start`、`desktop:package-local`（Tauri/Rust/NSIS）。
- Python+Pillow：`showcase:review-sheets`、样张图片转换链（fill-gaps、publish 系列）。
- 网关 3000：showcase 生成链、`reference:repair`、`character:onboard`；**3123：`reference:render` 与 `showcase:batch-miaomiao` 的脚本默认（确证问题 C1）**；ComfyUI 8188 直连：`reference:design`。
- 视觉审核：CLIProxyAPI `127.0.0.1:8317/v1`（`gemini-3.7-flash-high`），key 取 `VISION_API_KEY` 或 `runtime/vision-api-key.txt`。
- 仓库外路径：候选/审核默认 `../AI/Reviews/...`，参考素材 AI 工作区 `CharacterReferences`，样张库 `../AI/SceneShowcase`。

## 4. 数据域盘点（D1 依据）

### 4.1 域关系总览

| 域 | 权威源 | 聚合产物（不入库） | 构建入口 | 主要读取者 | ID 作用域 |
| --- | --- | --- | --- | --- | --- |
| 人物档案 | `data/characters.json`（160） | 自身即被读取 | 手工编辑 | sceneStore(required)、usePromptAssembly、聊天/语音、维护路由、`data-version` 哈希 | 角色全局唯一 |
| 热门生成身份 | `data/popular/*.json`（70 分片+manifest） | `popular-characters.json`（158） | `popular:build` | sceneStore、showcase 生成链、参考同步链 | 角色全局唯一 |
| 服装 | popular（模型输入）/ standards（参考素材）/ view（前端视图）三镜像 | 同上 + 两个参考 JSON | `popular:build`、`reference:register`、`sync-multi-outfit-standards.js` | popularContent.ts、render-design-sheets、check:ref-urls | 服装 id **按所属角色解析** |
| 通用场景 | `data/scenes/`（manifest 5 组，batchSize 50，物理 8 文件） | `scenes.json`(302)+`scenes-nene/natsume/shared`+`scenes-core`+`scenes-index` | `data:build`；维护走 `POST /api/maintenance/scenes`（D5 增量） | sceneStore 分角色分片、维护路由 | `scNNN`，写入侧分配稳定 ID |
| 角色蓝图 | `data/blueprints/`（70 分片） | `scene-blueprints.json`（1692） | `blueprints:build` | sceneStore、showcase 生成链 | `<characterId>_<语义>` 全局唯一；`outfitId` 1692 全部已填 |
| 策展 | `data/curation.json` | 自身 | 网页维护 | sceneStore、useSceneExplorerWorkspace、维护路由 | 引用 `scNNN`（0 悬空） |
| 参考索引 | `character-reference-standards.json`（手写权威，ajv schema） | `character-reference-view.json`（镜像） | `reference:register`→`render`→`sync` | `characterReferenceData.ts`（懒加载）、check:ref-urls | 7 机位 × 形态 |
| 样张清单 | 仓库外 `../AI/SceneShowcase/<版本>/manifest.json` | — | generate→audit→publish（版本化） | `/scene-showcase/manifest.json`、ShowcaseView | 条目 id `pc_*`/`scNNN`；本办公机无此目录（机器分工） |
| 退役 | `data/retired-scenes.json`（records[{id,retiredAt,reason}]，4 条） | — | 维护页下架 | scene-write 完整性校验、validate-scenes | 退役 id 不复用（0 冲突） |
| 定稿+版本 | `prompt-pinned-scenes.json`（100 条字节基线）；`scripts/lib/data-version.js` | — | `scenes:pin-capture` | check:pinned-scenes、validate-content-contracts | DATA_VERSION 哈希 **13** 个聚合文件 → `sceneStore.ts` |

### 4.2 展示文案 vs 模型输入（D1 原则的落地现状）

- **热门域是纯模型输入**：`identityProse/identityTokens/exactTokens/exactPrefixes/outfit.prose|tokens/negativeTokens` 经 `src/utils/popularContent.ts` 直接进提示词编译；`adultEligibility` 门控成人资格。
- **档案域主要是展示**：`visual_dna/personality/likes/bg_story/speech` 供 UI 与聊天；但 `lora`（name/weight）与部分 `identity` 字段参与组装，`accent_color/bg_color` 与主题 CSS 并存（两层来源）。
- **场景域混合**：`prompt/animaCaption/negative` 是模型输入；`story/storyJa/tags/category` 是展示/检索——`docs/workflow.md:48` 已声明"检索 tags 不冒充发送给模型的词条"。
- **蓝图域是模型输入**：`promptProse/promptTokens/nsfwProse/recommendedSize`；`compositionIntent` 缺省即 `single`（53 条显式填写：group 41/single 11/triptych 1）。
- `characters.json` 与热门身份未合并，符合 D1 "不强行合并"的边界；两者通过同名 id 关联（158 热门角色全部有档案；仅 nene/natsume 为纯档案角色）。

### 4.3 样例角色走查（D1 验收）

- **nene（工作室角色）**：档案在 `characters.json`；不在热门域；场景 151 条（nene core 68 + after_story 83）；无蓝图；参考 standards 4 形态（含 nsfw_nude）×7 机位；策展 curated/signature/personaCore 全部指向 nene 场景；`lora.recommended_scene` 指向场景 id（0 悬空）；主题走 `:root` 默认（设计）。
- **misaka_mikoto（热门角色）**：popular 3 服装 + standards/view 4 形态（多出的 `nsfw_nude` 为 sync 自动追加，tokens/prose 完整）；蓝图 10 条全填 outfitId；参考 4×7 全部已填 url。
- **raiden_shogun（多服装热门）**：5 服装 + nsfw_nude；蓝图 10 条覆盖全部 5 服装（6 条 adult）；参考 6×7 全部完成（0 pending）；`recommendedEngine=anima-miaomiao-v1.2`、`supportedEngines` 含 krea2；有档案。

## 5. 统计结果（全部来自运行结果）

`node scripts/archive/glm-governance/check-governance.js`（只读）：

| 指标 | 值 | 分母/说明 |
| --- | --- | --- |
| 档案 / 热门 / 服装 / 蓝图 / 场景 | 160 / 158 / 971 / 1692 / 302 | 与计划 006 基线一致 |
| 分片↔聚合 | popular 解析后逐条序列化漂移 0；blueprint 解析后逐条序列化漂移 0；场景分片组合 302=302；scenes-index orderedIds 302=302（均为语义级一致，非文件字节级） | JSON.stringify 逐条浅比较 / 数量比对 |
| 重复 ID | 六类（档案/热门分片/蓝图分片/场景/standards 形态/popular 形态）全部 0 | Map 去重 |
| 跨域悬空 | 蓝图→角色 0、蓝图→服装 0、策展→场景 0、定稿→场景 0、退役→活跃 0、onboarding→热门 0、lora→场景 0、view↔standards 双向 0 | 全量集合比对 |
| 参考条目 | 4508（pending 1974 / 已填 url 2534） | 644 形态 × 7 机位；**已填 url 仅代表索引声明，不等于图片已交付或通过审核**（存在性检查见 `check:ref-urls`，素材根缺失时为 unverified） |
| 服装参考缺口 | **357/971（109 角色）** | popular 有、standards/view 无 |
| standards 独有 nsfw_nude | 23 | sync 脚本自动追加机制，设计行为 |
| 主题 | css 唯一 data-character id 153；缺 8 角色；`historia_reiss` 为旧别名主题 | 与 characters.json 全量比对 |
| 蓝图 sampleRating | R18 657 / SFW 392 / All 52 / 无 591 | 分布统计 |
| compositionIntent | 53/1692 显式填写（缺省=single 符合契约） | 分布统计 |

## 6. 问题清单

### 6.1 已确认问题（5 组）

1. **C1 网关默认端点漂移**：`render-all-outfits-references.js:26` 与 `generate-all-scenes-showcase-miaomiao.js:30` 默认 `http://127.0.0.1:3123`，而 `workflow.js:126` needs 写 3000、`docs/workflow.md:143` 明确 3123 是历史端点。不设 `GATEWAY_URL/BASE` 时按注册表描述准备环境会连不上。
2. **C2 `showcase:fill-gaps` 绕过版本化发布**：直写活跃 manifest（:199-204，无版本切换/备份）；`provenance.review.verdict` 硬编码 `'pass'`（:196）；`--dry-run` 因模块顶层 mkdir 仍有副作用（:60-61 早于 :142 判断）。
3. **C3 `showcase:batch-miaomiao` 直写固定版本目录**：输出与 manifest 直写 `AI/SceneShowcase/2026-09-02_v27-miaomiao/`，与 C2 同属绕过 preview→publish 链路的直写入口。
4. **C4 形态级参考覆盖缺口**：357/971 热门服装无参考登记（109 角色）；`register-pending-reference-outfits.js:48-52` 只处理"standards 整角色为空"，当前 `view_only_chars_needing_register=[]`，形态级漂移无人接管，且无门禁报数。
5. **C5 主题层漂移**：`tokens.css` 的 `historia_reiss` 主题挂在旧别名上（canonical `krista_lenz`，`data/popular/attack-on-titan.json:146-168` 证实），对正式 id 不生效；另 8 角色无专属主题，回落默认粉色，与工程契约"主题层必做"不符。

### 6.2 待核实疑点（3 项，不自动判错）

1. `publish-rating-refresh.js:161-166/:187` 的 `filter(isRecord)` 与 index 对位比较在 manifest 含非对象项时错位（正常数据不触发）。
2. 591 条蓝图无 `sampleRating`：发布链对缺失 fail-open（adult→R18/All），是否需补齐取决于链路依赖。
3. `render-all-outfits-references.js:2` 头注释规模数字过期（35×177 vs 160/971），易被误当现状引用。

### 6.3 已核实无问题（避免重复怀疑）

moodRails 的 `shared` character 合法（query 驱动，`useSceneExplorerWorkspace.ts:425-436`）；`run-check-parallel` 的 fresh-clone 自愈已文档化；注册表无断链/循环；`--help`/`--plan` 零副作用；复合步骤失败即停。

### 6.4 最值得实施的 10 项改进

1. `reference:render`、`showcase:batch-miaomiao` 网关默认改 3000（或在注册表 needs/opts 声明 3123 + 覆盖方式）。
2. `fill-gaps`：移除 `--dry-run` 的顶层 mkdir；写活跃 manifest 前快照或改走 `--target` 版本目录；verdict 改记 pending。
3. `batch-miaomiao` 输出目录参数化，生成与发布分离（与 2 同类合并实施亦可）。
4. 形态级参考覆盖对账：`reference:register` 加形态级差额模式；popular↔standards 差额计数转为 check 门禁（`check-governance.js` 可直接转化）。
5. 主题对账：`historia_reiss`→`krista_lenz`；8 角色补主题或登记豁免；纳入 check 门禁。
6. W1 结构化元数据：`WORKFLOWS` 增加 `nature/machine/resume` 字段，runner/help/audit 共用单一来源。
7. `rating-refresh` 改按 id 匹配消除对位错位。
8. `data:apply`/`showcase:batch` 等把 opts 文本参数提升为 `required` 声明，让 runner 启动前校验生效。
9. 清理脚本头注释中的历史规模数字，改指向实时统计。
10. `sampleRating` 缺失语义确认：依赖则补齐，否则文档注明回退行为。

## 7. 未覆盖项与限制

- 59/74 工作流为"关键行核实"级（非逐行全文），已逐项标注 `coverage` 字段。
- 样张清单与参考素材真实图片在本办公机不存在（计划 006 机器分工），数量/质量未盘点；结构以 `src/utils/showcaseManifest.ts` 为准。
- 视觉审核真实上游（CLIProxyAPI 之后的模型）取决于本机代理配置，仓库内不可确认。
- 按任务约束未运行任何写数据命令；写行为结论均来自代码分支，未做运行时实测。
- 语义相似度检查本轮未发现需上报的冲突候选，仅保留疑点通道（未做自动合并）。
- 工作区并行改动（其他会话）：`.agents/skills/studio-prompt-craft/SKILL.md`、`docs/INDEX.md`、`docs/guides/README.md` 修改，`docs/guides/prompts/nsfw-cg-prompt-standard.md`、`docs/research/engineering/`（gemini-* 系列）新增——本轮未触碰。

## 8. 本轮执行命令与产物

| 命令 | 结果 |
| --- | --- |
| `git status` / `git diff --stat` / `git log --oneline -5` | 初始 clean；中途出现其他会话改动（未触碰） |
| `node scripts/workflow.js audit:workflows --json` | `{"count":74,"errors":[],"ok":true}` |
| `node scripts/workflow.js --help` / `npm run wf` 等价 | 全 74 项列出，无执行子进程 |
| `node scripts/archive/glm-governance/inspect-data-shapes.js` | 各域结构与样例字段 |
| `node scripts/archive/glm-governance/check-governance.js` | §5 全部统计（只读，不落盘） |
| `node scripts/archive/glm-governance/summarize-scripts.js <脚本…>` | 59 个工作流底层脚本关键行抽取 |
| 样例角色/域走查（node -e 只读查询） | nene、misaka_mikoto、raiden_shogun 跨域一致 |

产物：本文件 + [glm-governance-inventory.json](glm-governance-inventory.json) + `scripts/archive/glm-governance/{inspect-data-shapes,check-governance,summarize-scripts}.js`（一次性只读脚本，已登记于 scripts/archive/，不进 Git）。共享索引（docs/INDEX.md 等）未改，待主任务统一登记。

按任务边界，本轮停在报告阶段：W1/D1 的实施（元数据落地、门禁新增、主题/参考修复）均未启动。
