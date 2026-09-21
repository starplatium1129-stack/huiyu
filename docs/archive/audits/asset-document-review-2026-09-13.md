# 资产与资料复核记录（2026-09-13）

> 2026-09-21 合并归档。合并 Gemini 资产交付复核、后续任务范围及六报告的初始核对；工程后续 N/G 批次见 [工作流治理实施记录](workflow-governance-2026-09-13-14.md)。以下为当时观察，不是当前素材盘点或待执行派工。原文可从整理前提交 `d348b3d` 查询。

## 最终采纳口径

结构账本与元数据可以复算，文件存在不代表身份、画质或评级通过；外部根不可访问不等于文件缺失。首次报告中的伪 PNG、固定压缩收益、截图即 WCAG 证明和跨角色借图推断均撤回或降级。当前任务只查 [未来规划](../../roadmap.md)。

2026-09-13；基于 `e942116` 工作区的现有资源。复核对象为 `gemini-asset-audit.md/json`，保留原报告，以下修正不代表已修改资源或采纳其全部建议。

## 可以采纳的部分

独立读取磁盘图片，对 160 个角色的 thumbnail、baseDisplay、highResPortrait 共 480 条资产角色记录检查字节数、SHA-256、真实格式与尺寸：全部与 JSON 账本一致。三类角色可能引用同一物理文件，因此这不是 480 个独立文件，体积不能相加。

- 160 张高清原图共 268,964,651 B，约 256.50 MiB；缩略图共 2,816,246 B，约 2.69 MiB。
- 117 张 832×1216、41 张 1152×1536、2 张 1536×1152。
- 160 张原图均为 PNG。66 张带 Alpha，独立像素统计确认全部不透明。
- 参考索引重新计数为 4,508 条，其中 2,534 条有 URL、1,974 条 `pending:true`。当前网关解析器没有找到参考根目录。

结构提取可以继续承担批量工作；自然语言结论必须另行复核，不能因为生成快或报告长而直接采纳。

## 需要纠正或降级的结论

| 原报告结论 | 复核结果与处理 |
| --- | --- |
| 两张“伪 PNG”实际为 JPEG | 不成立。`popular-tachibana_mikari.png` 为 2,556,782 B，`popular-izumi_sagiri.png` 为 2,017,390 B；魔数均为 `89504e470d0a1a0a`。哈希与它自己的 JSON 账本一致，账本也记录 PNG。删除据此提出的格式修复任务 |
| Alpha 导致 20%～30% 或 40～60 MB 存储浪费 | 未做受控编码比较，不能把未压缩通道字节直接当磁盘或 GPU 节省。只保留“不透明 Alpha 可作为压缩实验候选” |
| 4 张截图证明当前 2560×1440 布局及 WCAG 合格 | 文件实际为 1000×625，修改时间为 9 月 7 日 UTC；未附采集提交、原始视口和缩放元数据。可能是缩放后的历史截图，不能据此确认当前版本、4K 或 WCAG。截图可保留为历史观察 |
| HomeView 横条加载高清原图 | 当前 `src/views/HomeView.vue` 使用 `popularPortraitSrc`，该函数返回 `thumbs/*.webp`。需追踪调用结果，不能只相信附近旧注释 |
| 43 位粒子角色 sourceSha256 全部校验通过 | 交付脚本检查的是 portrait-selections 的 portraitSha256；未发现粒子文件 sourceSha256 的对应验证。不能将两个契约的证据混用，需补验证或撤回 |
| 执行了 test-alpha.cjs | 交付目录没有该脚本，原步骤无法按所列命令复跑。本轮另行验证确认 Alpha 统计正确，但不替代原执行证据 |
| 外部缺少 2,534 张、约 1.2 GiB | 当前根目录不可用只能证明未访问，不能证明远端文件丢失，也不能给出现存体积。1.2 GiB 如为历史数须标出处与日期，否则写未知 |
| 无重复哈希意味着没有跨角色借图 | 只能证明没有完全相同字节的文件，不能排除缩放、重编码、裁切或语义重复 |
| “基础展示图”和“高清原图”是两份独立体积 | 158 位热门角色两个用途引用同一文件；按物理路径/哈希建立独立文件表，不能重复累计 |

本轮没有逐图复核 Gemini 的 11 个内容样本，不确认“视觉无损”“必定削顶”或具体人工分级。高风险描述保留为待核实观察，当前不据此改图、改 CSS 或修改分级。

## 可复跑证据

一次性独立检查：`node scripts/archive/gemini-review-20260913/verify.cjs`，输出 `scripts/archive/gemini-review-20260913/verification.json`。该脚本仅读取生产素材，结果写入被忽略的临时目录。本轮无生产文件修改、无模型调用、无安装和发布。

## 六份盘点的交叉复核

2026-09-13；复核基线 `ac29219`，开工工作树干净。原报告为本机 `scripts/archive/task-01` 至 `task-06` 的 Markdown 及附件，属于被忽略的工作材料，不作为远端可用依赖。本页保存可以独立理解的复核结论；未重跑历史全量门禁或进行真实出图、安装与设备验收。

## 可采纳的发现

| 原任务 | 本次复核结论 | 处理 |
| --- | --- | --- |
| 01 待办状态 | 006 的 W1/D1/D3/D4 状态表落后于正文及代码；sc063/sc087 的 rating 和 usage 当前均含 R15 | 已同步 006 与 roadmap，真实画面缺口保留 |
| 02 人物/服装 | 存在双默认字段、跨域服装 ID 和字段文本差异；覆盖工具仍列出 8 位缺显式主题、1 个历史别名候选 | 仅作为有范围的核对项，不批量迁移 ID、统一色值或修改提示词 |
| 03 场景/蓝图 | 保存 API 的蓝图分支只写聚合；真实存储/自愈函数在临时目录已复现修改被旧源覆盖 | 提升为优先核心保存修复项，由强模型处理；尚未跑完整 HTTP/UI 保存 |
| 04 工作流 | 部署可转发安装等开关，但元数据 switches 为空；若干 evidence 行号和构建描述过时 | 交 GLM 修说明/元数据，保持执行行为不变 |
| 05 素材 | 参考条目 4,508，显式 pending 1,974，有 URL 2,534；批次的登记/历史审核与实际资产需分开 | 数量已重新计算；不关闭 V01/V02 |
| 06 资源 | assets 当前 629 文件、353,211,795 字节（336.849 MiB）；详情图出错分支隐藏图片，没有缩略图回退 | 文件统计已复算；页面故障效果待浏览器验证，安装包收益未测 |

## 必须纠正的推断

1. **任务 05 的“新 49 角色仅 6 位有立绘、43 位缺图”是误报。** 一次性脚本 `reconcile-task-05.js` 仅去掉 `../`，没有去掉 URL 查询参数，导致 `popular-*.png?v=...` 被当作文件名。本次按同批 49 个 ID 从 characters.json 重新取路径，剥离查询/片段后逐文件 stat，结果 **49/49 普通文件存在**；全部 158 位热门角色的声明立绘亦存在。存在性不证明画质、身份或分级合格，不能据此补写审核结果。
2. **任务 02 把多种设计差异直接称为缺陷。** `src/utils/characterProfiles.ts` 的档案解析没有输出 traits，不能由原始 traits 的对象/字符串差异推导当前页面必然异常。`report-content-ownership.js` 明确将参考 view 定义为合并投影，不能先假定其必须纯覆盖生成，再称合并写入违规。不同用途的服装 ID、颜色值也不能自动统一。
3. **芙莉莲字段确有内部不一致，但报告给出的原作争议与历史根因没有证据。** 当前 visual_dna/tags/identityTokens 为绿眼，traits/canon.formNotes 中有紫眼；本次只确认字段差异，不裁定原作事实，不改生成内容。
4. **任务 06 的“基础包保证 100% 页面可用”和“安装包削减 98%”未成立。** 336.849 MiB 是源 assets 文件总量；不同分组的小计在原报告中还相互矛盾。没有安装包构建测量、依赖闭包和离线视觉验收，不能推导完整程序压缩包收益，也不能据此删除打包资源。
5. **断外网不等于本地 Live2D 不可用。** 当前模型经本地网关读取；应分开验证外网断开、素材缺失、网关不可达，不把按需激活误称已实现在线下载。
6. **未访问外部素材根，不等于证明图片不存在或历史审核未发生。** 本机无当次验收证据时写“未核验”；pending/URL/文件存在/审核声明/画面验收分别记录。对暂停的审计不得自行恢复出图。

## 证据入口与验证范围

- 保存分支：`routes/maintenance.js` 的 `blueprints !== undefined` 写入；重建：`scripts/lib/ensure-data-build.js` 的 `ensureBlueprintsBuilt`、`scripts/lib/blueprint-store.js` 的 `aggregateIsCurrent`/`writeBlueprintAggregate`；启动调用在 `server.js`。
- 档案解析及容错：`src/utils/characterProfiles.ts`、`src/views/CharacterView.vue` 的 `brokenPortraits`；参考 view 的已声明边界在 `scripts/maintenance/report-content-ownership.js`。
- 部署说明：`scripts/workflow.js` 的两个 deploy 条目、`deploy-desktop.bat` 及其 PowerShell 目标；default nature 已有 writes-release/service，不能把遗漏 switches 夸大为全部标成只读。
- 本次重新执行只读 `report-content-coverage.js --json`，structuralErrors 为空，8 位缺显式主题及 historia_reiss 别名候选仍在。它是覆盖报告，不是浏览器或图片质量验收。
- 重新计算参考显式 pending/URL、资产数量与字节、49/158 个声明立绘的文件存在性、sc063/sc087 元数据；未运行生成器、下载器或安装流程。

蓝图隔离复现已执行：在临时根创建单条虚构蓝图，使用真实 writeJson 按保存路由表达式只改聚合，断言源字节不变且 aggregateIsCurrent 为 false；调用真实 ensureBlueprintsBuilt 后返回 rebuilt:true，标题被恢复为旧值。断言通过，不等于完整 HTTP/UI 验收。当前事务快照未覆盖蓝图源，不能只追加 split 调用；validate-content-contracts.js 还固定读取仓库根，后续隔离 HTTP 测试需先明确校验根目录。这两项与源/聚合一致性一起修，不能交给仅修改说明的批次。

## 后续资料的已交付范围

原 G0–G5 派工已由资料交付取代；这里的“完成”仅指报告整理，未执行的测试不升级为通过。详细口径见 [工程资料索引](../../research/engineering/README.md) 与 [历史进度 JSON](../../research/engineering/gemini-followup-progress.json)。

| 批次 | 保留产物与已核验范围 | 仍未证明的内容 |
| --- | --- | --- |
| G0 | [资产账本](../../research/engineering/gemini-asset-audit.md)与 JSON；修正格式/重复用途统计 | 图片质量、外部素材及安装包收益 |
| G1 | [视觉候选](../../research/engineering/gemini-visual-inventory.md)：45 条候选元数据，43 条既有 All 登记、2 个先导样例 | 完整逐图审核及其余 115 位；未新增评级 |
| G2 | [容器与资源调用](../../research/engineering/gemini-crop-usage.md)：5 类容器实际代码 | 裁切预测不能冒充页面视觉缺陷 |
| G3 | [文案复核](../../research/engineering/gemini-ui-copy-review.md)：1 项确认、4 项建议、1 项撤回 | 报告当时未修改 UI 或验证用户理解 |
| G4 | [文档证据索引](../../research/engineering/gemini-doc-evidence-index.md)：8 份文档原文/入口，撤回假引文 | 历史说明不能证明当前设备通过 |
| G5 | [资源验收用例](../../research/engineering/gemini-resource-acceptance.md)：6 项当时现状、3 项当时未来 R1 用例 | 9 项均未执行；未来/现状标签为历史基线 |

## 保留的复核方法与边界

- 按对象 ID、实际文件、SHA-256/版本记录观察、推断和待确认项；Markdown 与原始 JSON 对账。
- 格式和字节数以磁盘元数据为准；缩放预览、联系表和文件大小不证明画质。疑点回到单图核对。
- 容器核对实际 URL、比例、object-fit/object-position 及回退，不按旧注释猜测，不制定全库固定裁切规则。
- 记录截图提交、视口与 DPR；缺元数据的截图仅作历史观察。
- 故障用例明确前置、步骤、预期、证据和恢复；区分断网、素材缺失、网关不可达及尚未接通能力。
- 原报告不授权改图、压缩/删除资源、改变分级、恢复暂停审计或自动出图；当前验收以 roadmap 的 V 项为准。
