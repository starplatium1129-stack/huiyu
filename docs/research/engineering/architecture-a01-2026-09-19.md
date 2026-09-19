# 长期架构首批：结果上下文与类型依赖边界

对应 [长期架构计划](../../../plans/architecture-evolution.md)；剩余任务只维护在 [roadmap](../../roadmap.md)。首批复用现有类型归属，实施 A01.2 和必要的 A07.1；不抽取入册用例、不调整数据库或生成引擎。

## A00：实际基线

- 实施基线：`1646c680c50cbdb09210300500131408d3d62214`，独立分支 `codex/architecture-a01-20260919`，工作区 `architecture-a01-20260919/ai-cg-studio-main`。基线工作区 clean；首次验证针对未提交 diff，工作树 dirty。验证绑定实际源文件与构建字节，不能把基线 SHA 或 HEAD 匹配当作本批最终提交；后续提交身份通过 capture:delivery 的 finalize 流程绑定。
- 工具链：Windows、Node `v24.18.0`、npm `11.16.0`。复用已安装依赖的目录联接，不安装/升级依赖；构建、临时夹具、日志归独立 worktree。
- A00 启动时的 `f679729` 在实施期间被新的可维护性批次推进。已在本 worktree 快进到上述新基线，重新核对源码；原先重做类型迁出的修改已退出本批。旧基线的 63 项定向回归和中止的完整门禁不作为最终交付证据。
- 新基线已具备 `types/promptHistory.ts`、Store 兼容导出、宽松 `ArtworkRecord`、`historyRecipe` 投影、`generationResponse` 解码和 ESLint 依赖试点。A01.1 不重复开发；部分 A01.3 / A03 已有能力保留，其余范围继续盘点。
- 修改前运行时构建通过；七个既有前端测试文件共 69 项通过。日志：`runtime/architecture-a01/main-baseline-runtime.log`、`main-baseline-behavior.log`。

## 影响表与实现

| 入口 → 调用链 | 本批改动 | 不变量与验证 |
| --- | --- | --- |
| 工作区 / SD 队列 → `captureResultContext` → 入册 / 视频 | 接收 `ResultContextInput`，只声明实际使用的身份、故事、选择、风格、项目字段；函数不再导入 Store 类型 | 原调用者仍可按结构传入 Store；纯测试可直接传普通/冻结对象；捕获字段、默认值、时机和数组复制不变 |
| `AnimaResultContext.history` → 公共历史字段 | `HistorySnapshot` 位于既有 `types/promptHistory.ts`，保持深只读形状，不借 Vue 或 Store 定义 | 类型相等断言核对原 `DeepReadonly<Partial<HistoryEntry>>`；不增加运行代码或更改记录字段 |
| 历史入册 / 软删 / 恢复 / 旧配方 | 复用基线 Repository 与兼容模型，不改变实现 | `creationRecovery`、`useTempResult`、`usePromptHistoryApply`、`promptVideoActions`、`promptBuilderStore`、`artworkRepository`、`historyRecipe` 回归 |
| 公共类型 / 纯结果规则 → 可达依赖 | 增量图检查在既有 ESLint 直接依赖检查之上补充间接路径；共享 AST 读取器 | 正反例验证真实别名、再导出、require、动态 import、SFC、类型边/运行边与 unknown；原页面架构 API 输出保持兼容 |

实际生产调用者：`src/composables/prompt/usePromptWorkspace.ts` 的提交上下文适配，`src/composables/prompt/usePromptSdQueue.ts` 的任务快照。兼容导出仍由 `promptBuilderStore` 指向唯一 `promptHistory` 定义。没有迁移用户数据或重写提示词映射常量。

新增纯对象测试覆盖热门/工作室、基础/专家模式、冻结只读输入，以及捕获后修改身份、故事、项目、嵌套选择和三种集合。手动标签保留工作台实际使用的 Set，同时允许只读数组，验证插入顺序与复制隔离。旧记录测试覆盖字符串/数字 ID、缺失父作品、未知扩展、null/缺省、不回写与嵌套结果字段复制。不把这些兼容测试当作 A01.3 全链盘点完成。

## A07.1 范围

入口 `npm run wf -- check:domain-types`，同时注册到 `test:architecture` 与 check 套件；夹具注册到 unit 套件。复用已安装 TypeScript / Vue SFC 解析器，无新依赖。

根为 `types/promptHistory`、`artwork`、`generation`、`anima`、`utils/resultContext` 及其可达本地源码。解析使用真实 app tsconfig、文件真实路径和 TypeScript 模块解析；检查 import type、内联 type、类型查询、再导出、require/import-equals、字面量动态导入及 Vue 两种脚本块/外部脚本。经纯模块中转到 Store/Composable/Component/View/router/HTTP route 同样拒绝；上述纯模块也不再依赖 Vue/Pinia 的类型。

类型图与非显式 type 的运行候选图分别报告；未标 type 的导入保守计入运行候选边，不模拟 tree-shaking。计算路径、缺失/无法解析文件、非法 SFC 和可达测试/vendor/非源码文件报告为 unknown，当前门禁阻断。node_modules 与 Node 内置模块作为外部边登记，不深入包源码；JavaScript 路径优先解析回 TypeScript 源，可达纯 JavaScript 仍解析。类型循环报告但不冒充运行循环；不宣称完成全仓或第三方依赖审查。

`source-imports.ts` 保留已有页面架构用的 `sourceImports` 返回形状，同时增加完整依赖读取；没有新建第二份 AST 遍历。原 `module-boundaries.mts` 的 ESLint / PhotoSwipe / 存储规则保留，未放宽门槛。

## 当次验证

| 检查 | 当次结果 | 日志（本 worktree 的 `runtime/architecture-a01/`） |
| --- | --- | --- |
| `npm run build:runtime` | PASS；Node/测试/服务/浏览器工具严格检查及生成 | `aligned-runtime.log` |
| `npm run typecheck:app` | PASS；窄接口适配所有现行调用者、旧类型导出与深只读相等断言 | `aligned-app-types.log` |
| 九个文件的前端定向回归 | 76 / 76 PASS；包含新纯对象与旧数据兼容测试 | `aligned-behavior.log` |
| 新图检查/夹具 + 原 ESLint/页面架构 | 19 / 19 PASS；无跳过 | `aligned-boundaries.log` |
| 固定新基线与当前生产代码擦除类型后比较 | 三个受影响文件输出一致；只证明本批生产类型改动，不证明全应用无缺陷 | `aligned-runtime-equivalence.log` |
| 文档链接与文本卫生 | PASS；最终文档定向复验，202 份文档 / 1,209 个本地链接无断链，`git diff --check` 通过 | `final-docs.log`、`final-hygiene.log` |
| 完整门禁 | PASS，退出 0，7 分 59 秒：17 项质量检查、970 项前端测试、1,069 项 Node 测试通过（另 2 项环境跳过）、34 组契约、生产构建和包体预算 | `aligned-full-gate.log` |

完整门禁使用办公机 `AICS_REFERENCE_AUDIT_MODE=structure`，验证后恢复环境变量；外部参考素材实物不在此模式验收范围。执行前通过现有 `capture:delivery` 捕获 source/build，快照为 `runtime/delivery-evidence/architecture-a01-aligned-baseline.json`。本批不引用新主干历史 PASS 代替当次测试。

两项 Node 环境跳过分别为文件符号链接不可用（同类 junction 测试仍执行）和工作区没有 `AI/SceneShowcase` 实物。新增测试均无跳过。未扩大包体或测试时限门槛；既有包体接近预算的提醒仍保留。

验证结果通过 `capture:delivery --baseline … --record …` 绑定到 `runtime/delivery-evidence/architecture-a01-aligned-office.json`，结果输入为同目录的 `architecture-a01-aligned-results.json`；质量执行器原始报告在 `runtime/architecture-a01/quality/`。审计确认 source/build 均 fresh、`checks.fullGate` 为 passed、errors 为空；`aligned-audit.log` 总退出码为 3，因为通用交接格式的安装/设备/模型字段如实记录 not-run，本批无相应运行行为变化，不以伪造通过关闭这些字段。

| 受测身份 | SHA-256 |
| --- | --- |
| 捕获的 source 集合 | `4e83687ada9d751f6c6b0e5e4b9073dd1d741ffbf5c42e56fa5f7e13cbb7aec7` |
| 捕获的完整 dist 集合 | `6ed4fed48273925b3e442fa43c63e906aec06bf0e86a21ea611fdd8815c8a8fe` |
| `dist/index.html` | `21f1125c1d452e06c33d4f32e041f2fcdd380550de1190739b1cf9517addc7d6` |

以上绑定范围见快照选择器；随后仅回填文档，不改变受测源码或 dist。文档链接和文本卫生另作最终定向复验。首次验证时未提交或安装；提交阶段复用相同受测源/构建证据，不重新计为一次完整测试。

浏览器、真实模型、设备和桌面安装未执行：生产变化仅为输入类型和快照类型归属；生成请求、UI/主题、数据写入和生命周期未改。擦除类型后的生产代码等价检查与构建用于核对这一界限；不把它们表述成真实模型或设备通过。后续 A02 的运行逻辑修改按其影响另行验证。

## 回退

回切本批窄接口/快照类型与增量检查即可；保持主干已有公共类型、API 和旧配方修复。没有持久化迁移，无需覆盖或恢复用户图库。检查器按注册项、夹具、图遍历与共享 AST 扩展一并回切，原 ESLint 试点和页面架构能力继续保留。
