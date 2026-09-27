# 重构后的文档漂移整理

> 2026-09-27；核对基线 `e0e5c692` 及当时工作区。此次只整理文档、工作流帮助元数据和下载器注释；已有后端、弹窗与浏览器测试改动由原会话保留，未作为本次代码交付。当前能力查 [项目状态](../../project-status.md)，剩余事项查 [未来规划](../../roadmap.md)。

## 整理结果

| 漂移 | 修正与事实来源 |
| --- | --- |
| 状态页堆叠多轮“最新”安装与未安装记录 | 原状态页完整迁到 [分批快照](../../archive/completed/project-status-2026-09-27.md)，相对链接重基；现行页区分源码、最近有证据的 `60888df3` 安装和未覆盖范围。安装身份据 [内存优化证据](../../evidence/memory-optimization-2026-09-27.json)，本次未复验安装 |
| 参考规模与权威源落后 | 只读加载分片重算登记数量；从旧 644 形态 / 4,508 条 / 1,974 pending 更新为 1,001 / 7,007 / 4,473。权威源为 `data/references/`，旧 standards/view JSON 仅兼容聚合；据 `scripts/lib/reference-store.ts` 与 `src/utils/characterReferenceData.ts` |
| 架构规范仍称尚未上线、默认关闭 | Workspace、任务和桌面接入规范头部对齐 R3–R11；Web adapter 与桌面权威分开，旧来源只读保留，禁止失联降级双写。原 R0/R1/R2 及日期报告不改历史事实 |
| README / 启动说明仍描述旧控制室和启动链 | 对齐 `/control`、按服务停止、独立公网分享开关；首次生产浏览需构建 `dist`。据 `package.json`、`start.ps1`、`src/views/ControlView.vue` 和 `server.ts` |
| 存储、队列与取消被统一写成浏览器行为 | 说明 Web 存储与激活桌面 workspace 的差别；已接受任务显式取消，页面解除观察不替代取消。据 `src/storage/artworkRepository.ts`、`src/platform/initializePlatform.ts`、`src/api/runtimeTasks.ts` |
| 浅色主题被称为下线、检查范围和规模写死 | 对齐双主题、500 行单体预算及按影响面选择门禁；移除固定检查/路由数量。据 `src/composables/useTheme.ts`、`scripts/tests/test-monolith-budget.ts`、`scripts/maintenance/gate-quick.ts` |
| TypeScript 和原生桥说明沿用旧层次 | 源码位置用 `.ts/.mts/.cts`，执行命令保留生成的 `.js/.mjs/.cjs`；runtime 不反向依赖 `src`，Live2D 经 platform typed host API。据 `scripts/lib/refactor-boundaries.ts` 与 `src/platform/desktop/nativeLive2d.ts` |
| 桌面操作仍描述固定端口停进程和旧复制清单 | 对齐受管宿主维护退出、写入排空、锁释放与当前 staging，用户入口仍为 `deploy-desktop.bat`。据 `scripts/maintenance/deploy-desktop-quick.ps1`、`desktop-deploy-guard.ps1` 和 `desktop-stage-resources.ts` |
| 聊天绘画工具被承诺为自动出图/落盘/加分 | 对齐 `routes/desktop-tools.ts` 的 draft 回执；删除尚未实现的图片结果与生成奖励承诺，特殊互动按实际 bonus/好感度门控 |
| 开箱指南把设备推测写成性能保证 | 删除固定秒数、100% 还原和并发不爆显存保证；区分体检的模型目录扫描与网关配置。模型可达性、速度、画质不由目录存在证明 |
| 粒子资源“存在即完成”、视频源码入口过期 | 补充 portrait pending 门控，保留实际挂载页与资源状态边界；视频指南对齐 `generation/useBatchDraw.ts` 和当前文本能力，保留真实视频/批次取消语义 |
| 计划和目录重复旧待办 | 索引按契约、计划、执行报告、证据与研究路由；007/008/010/012 的入口区分已实现/已安装与剩余设备条件；历史素材和参数研究标明日期范围 |
| WD14 帮助文本与下载器实际默认源矛盾 | 帮助元数据和源码注释对齐默认 ModelScope、`--mirror` 使用 HF-Mirror、`--official` 使用 HuggingFace（同传时 official 优先）；未运行下载器 |

本批共整理 39 份 Markdown 文档（含本记录和历史快照）。数量、最新安装身份只在项目状态维护，其他入口使用链接；日期报告保留自己的固定基线。提示词规范只移除表头未经核对的引擎架构称谓，不改 Token、示例或编译参数。

## 核对范围与方法

先核对 Git 状态与差异，保护原工作区；三部分并行审查只编辑互不重叠的文档，Git 写操作未委派。本次逐项对照根 README/启动、现行状态/规划/工作流/契约/维护、桌面架构与指南、内容/视频操作指南、计划入口及目录索引。历史审计、发布说明与研究保留原日期事实，通过入口区分用途，不将旧性能与 PASS 改写成当次证据。

当前数据使用 `loadPopularShards`、`loadBlueprintShards`、`loadSceneShards`、`loadReferenceShards` 只读返回值及 `data/characters.json` 统计。未使用 manifest 的声明 count 代替实际条目；未重建数据、检查外部参考文件或访问用户 workspace。

验证使用现有 `docs:check`、`audit:workflows`、`audit:workflow-conditions` 和受影响工作流回归；另核对现行指南中的 npm/工作流名称、具体源码路径与改动涉及的标题锚点。各项实际输出和范围在交付时记入下段。文件链接门禁只验证目标存在，不证明外网、模型、设备或命令真实执行成功。

## 验证记录

| 检查 | 当次结果 | 范围 |
| --- | --- | --- |
| `npm run wf -- docs:check` | PASS：236 份文档、1,817 处本地文件链接、70 条旧地址映射；0 失效 | 目标存在性；不检查外网或语义 |
| 标题片段补查 | PASS：306 处本地 Markdown 标题/显式 HTML ID 引用，0 无目标 | 236 份文档；不是浏览器点击或布局验收 |
| npm / 工作流名称补查 | PASS：49 份现行入口/指南/计划，278 次引用，0 未登记名称 | 允许有效工作流分组；不执行命令 |
| 具体源码位置补查 | 新定位已核对；3 处旧路径保留在明确标注的历史材料内 | 旧模型参数指南、三引擎研究与视频早期实现；不把它们作为现行执行入口 |
| `audit:workflows --json` / `audit:workflow-conditions --json` | PASS：112 个注册项，结构/条件错误 0 | 注册元数据，不验证外部运行条件 |
| `node scripts/build-node.mts --project node` | PASS：358 个源码检查并生成 358 个运行文件 | 当前 Node 项目；未运行完整 `validate` 或前端构建 |
| `node scripts/tests/test-workflow-runner.js` | PASS：25 项，0 失败/跳过 | 包括全部注册 help/plan 不启动执行器、参数透传和副作用声明；最终帮助元数据构建后重跑 |
| WD14 `--mirror --help` / `--mirror --plan` | PASS：显示 ModelScope 默认、镜像与官方开关，预览保持零下载 | 未执行下载器 |
| 状态快照保真 | PASS：历史正文与 `e0e5c692` 原文件等价 | 统一换行、解析重基链接目标后逐字比较；原文 SHA-256 为 `e43964dd5f084d9115249d8d1b8ad4e5729a97d9a28071f4b93525a7fe8bb5da` |
| `git diff --check` | PASS | 包含最终受控文档与帮助修改；未暂存或提交 |

## 保留边界

- 模型出图、外部来源、URL 可达性、逐图审核、音频/GPU/多屏/休眠、安装/UAC/发布本次均未执行；对应任务继续在 roadmap 按 ID 保留。
- 012 的 85 项外部条件和历史审计差额保留为有日期检查点，未批量销账；新参考计数仅代表登记结构。
- 旧参数研究、协议目标和日期报告保留当时语义；新增任务仍需核对现行实现及目标环境，不能把这次文档校准称为全功能验收。
- 历史 `character:onboard --deploy` 实现仍直接调用旧 PowerShell 部署脚本；帮助已标明历史路径，现行桌面同步按部署指南单独使用 `deploy-desktop.bat`，本次不改其执行行为。
- 本次未新增永久审计脚本、依赖或测试阈值。工作流只更新帮助描述、下载开关副作用声明与旧部署入口说明，执行路径和下载实现未变。
