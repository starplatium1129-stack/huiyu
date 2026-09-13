# 六份盘点报告的汇总复核

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

## 后续分工

GLM 5.3 Flash 按 [分批任务包](../../guides/engineering/glm-flash-next-batches.md) 先修工作流说明，再完成可复算资产清单和有证据的字段职责材料。每批有确定产物和停止条件，不用更多报告替代实现。主任务负责核心保存缺陷、报告判断、最终 Git 写操作和必要验收。原六份报告不整体升级为权威文档，也不因数量多就全部采纳。
