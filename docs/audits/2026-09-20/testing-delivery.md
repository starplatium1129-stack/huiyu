# 测试、构建、CI 与交付审计

审计日期：2026-09-20。代码基线：`39d955e6186e16f68f30b8b7d74136d88b896a43`。本次交付为报告，不修订生产代码、阈值、测试或安装包。最终执行结果与日志摘要见 [证据](evidence.json)，优先级与批次见 [实施计划](implementation-plan.md)。

## 范围与判断

核对 package scripts、五份 GitHub Actions 配置、TypeScript 分项目配置、测试清单及隔离夹具，运行当前全量门禁并在首个静态失败后单独补跑完整 check 清单。全量门禁使用 `AICS_REFERENCE_AUDIT_MODE=structure`，只证明参考库结构；测试默认的 WD14 替身和独立运行目录已核对。没有调用真实生成模型、麦克风、安装器或原生桌宠。

当前测试体系覆盖面较广：前端组件/状态单测、Node 单测、HTTP 契约、浏览器行为与原生设备测试有独立入口。质量汇总要求各 lane 成功；Actions 固定到提交 SHA、常规任务只有读取权限，Node 22.18 最低版本另设兼容 lane。已有契约并发白名单、失败分类、超时与未执行计数，值得保留。

本次全量检查不能判为通过。以下是实际阻断与管线覆盖缺口，不使用历史 PASS 替代当次结果。

## TEST-01 · P1 · E2E 类型入口与现有源码语法不兼容

**证据：确认。** `tsconfig.json:4` 使用 Node16，且没有 `allowImportingTsExtensions`；`include` 引入浏览器用例及其源码依赖。`npm run typecheck` 的第一个子命令实际出现：

- `src/api/client.ts:1`、`src/utils/particlePortrait.ts:2`：TS5097，导入路径带 `.ts`。
- `src/utils/popularPortraitSource.ts:1`：TS2823，当前 module 不支持 JSON import attributes。
- `tests/e2e/character-particle-stage.spec.ts:76,99`、`tests/e2e/particle-gpu.spec.ts:82,97`：TS2683，Canvas mock 的 `this` 未声明类型。

影响：Quality 的静态检查失败，并且 `&&` 编排导致其后 Node、tests、browser-tools 类型步骤未在该命令中执行。应用 `vue-tsc` 独立通过不抵消此失败。`build:runtime` 的缓存命中也不覆盖独立 E2E tsconfig。

落实步骤：

1. 在隔离工作区用同一提交、Node 24.18.0/锁文件复现，保留当前错误清单。
2. 将 E2E 配置定位为浏览器代码的无输出类型检查；评估与现有 `tsconfig.tests.json` 一致的 Preserve/Bundler 组合，并显式允许 `.ts` 导入。不要全局关闭 strict、skip 检查或批量删除源码导入后缀。
3. 给四处 Canvas 函数声明 `this: HTMLCanvasElement`，保持原始函数返回类型与模拟行为。
4. 运行 `npm run typecheck`、受影响粒子浏览器用例和最低 Node lane；确认配置变化没有改变运行时编译产物。
5. 单独提交配置与测试修复；如加载行为变化，回退该提交，保留已记录的失败基线。

## TEST-02 · P2 · 响应式断点违反现有回归契约

**证据：确认。** 完整 check 补跑为 17 组通过、2 组失败；`test-ux-regressions.js` 报 `ColorLightNotebook.vue` 的 760px 媒体查询不在允许档位。该文件尾部还存在 520px 查询，首个失败输出只报到 760px。允许档位为 480/600/768/900/1000/1200/1380/2560；布局宽度与图片 sizes 不属于本规则。

落实步骤：

1. 查看 520/760 两处查询承担的排版职责，分别在相邻标准档位试排，不机械替换所有数值。
2. 优先复用 480/600/768 中实际合适的档位；若确需新档位，先更新设计决策和回归规则，不能仅删断言。
3. 在深浅主题、390/480/600/768/1440 宽度检查图文顺序、卡片高度、标题换行与溢出；执行 `test-ux-regressions.js` 和相关页面浏览器回归。
4. 以一份局部样式提交交付，可独立回退；无须触碰场景、提示词或模型参数。

## TEST-03 · P1 · 多项新浏览器回归没有进入自动运行清单

**证据：配置确认，属于覆盖缺口。** 基线有 74 份 `tests/e2e/*.spec.ts`。`package.json:92` 的 critical 显式选择 12 份，`:95` 的 nightly 显式选择另外 5 份；其余 57 份可由手动全量入口发现，但不在这两份自动清单内。例如 `particle-gpu.spec.ts`、`character-particle-stage.spec.ts`、`archive-route-transition.spec.ts`、若干图片恢复用例均未被两个入口选中。不能据此断言它们从未由人执行，也不能把 nightly 称为全部浏览器回归。

落实步骤：

1. 生成“用例文件 → 风险 → critical/nightly/device/manual → 理由”的清单，优先纳入远程授权、恢复并发、结果可靠性和当前新增 UI 主流程。
2. 对共享模拟上游用例继续遵守单 worker，独立页面用例按耗时分片；原生设备用例保留独立机器条件。
3. 给未归类的新 spec 设置清单检查失败，避免新增测试仅存在文件却从不自动运行。
4. 先记录各 lane 耗时、失败率与截图体积，再调整 CI 时限和分片；不以删除断言、无条件重试或放宽预算换取绿色。
5. 验收：新加入的故障注入用例确实出现在 Actions 日志；关闭同类路径一个保护条件时测试会失败。编排可单独回退，测试仍保留。

## TEST-04 · P2 · 依赖安全扫描只覆盖 npm 生态

**证据：确认的扫描范围。** 本次 `npm audit --json` 返回 714 个依赖、0 个已知 advisory；这不是源代码安全结论。`.github/workflows/dependency-audit.yml` 仅调用 npm audit；桌面存在 `desktop-tauri/src-tauri/Cargo.lock` 与 `desktop-tauri/native-live2d/Cargo.lock`，Windows 原生 lane 使用 Cargo 构建/测试，但未见 Rust advisory、产物依赖清单和外部原生 SDK 版本审计步骤。未运行 Rust 漏洞扫描，不能声明 Rust 无漏洞。

落实步骤：

1. 分别盘点发行桌面壳、原生渲染器、打包 Node 网关实际依赖；PoC 锁文件单独标为非发行范围。
2. 在专用 CI 中对实际发行锁文件接入 Rust advisory 检查，固定工具版本；网络故障标为检查失败，不按零漏洞处理。
3. 同步输出 npm/Cargo 清单、Cubism/随包 Node 版本及构建 SHA，附到已有 release receipt；不用仓库 MIT 标签推断所有模型/素材的再分发许可。
4. 对真实命中的 advisory 逐项确认调用路径、平台与修复版本，再执行定向升级、锁文件变更和桌面完整安装验收。
5. 验收应包含一个受控告警夹具与扫描不可用夹具。回退扫描编排时保留证据，不能回滚到已知有风险依赖作为默认方案。

Cargo 可用机器可读依赖图辅助盘点，命令格式以 [Cargo 官方 metadata 文档](https://doc.rust-lang.org/cargo/commands/cargo-metadata.html) 为准；它本身不等于漏洞或许可审计。

## TEST-05 · P3 · 本地换行异常与 Git 状态口径不同

**证据：仅本地环境。** 初始 `git status` 干净，但 hygiene 扫描发现 `tests/e2e/archive-route-transition.spec.ts:49` 一处 CRLF。读取 Git HEAD blob 为 3,086 字节、0 处 CRLF，工作文件为 3,087 字节、1 处 CRLF。Git 的文本规范化可让这种差异不显示为内容变更。这不是已提交文件本身含 CRLF 的证据。

落实：按 `.gitattributes` 将该文件工作区规范化为 LF，核对 Git blob 未变，再定向重跑 hygiene；编辑器遵守 `.editorconfig`。不要因此改宽卫生门禁或批量重写全仓文件。本轮仅记录此环境差异。

## TEST-06 · P1 · full/CI 没有实际执行四个完整样式扫描

**证据：编排与源码确认。** `package.json` 的 `test:style-debt` 是五段命令：样式债测试，以及字面值、对比度、颜色、动效四个完整扫描。`run-check-parallel.ts:22` 的清单没有这四步，check 套件仅运行 `test-style-debt.js`；后者测试内联样式、令牌完整性及对比度解析器夹具，没有调用四个扫描入口。`test-quality-gates.ts` 的注释把单个测试文件误当成完整 npm 脚本，并用“避免重复”断言禁止编排加入扫描。于是现有 full/CI 与文档宣称的范围不一致。

本次另行运行 `npm run test:style-debt`，五段全部通过；对比度检查覆盖深浅主题，动效扫描报告 3 处已批准布局豁免及 48 处非阻断重绘型过渡。这里发现的是未来回归可能漏检，不能把它写成当前对比度失败或 48 处已证明性能故障。

落实步骤：

1. 指定一个唯一拥有者运行完整样式门禁：让 check 编排调用完整 npm 脚本，或在质量执行器明确登记五步，避免同时执行两遍 `test-style-debt.js`。
2. 修正 `test-quality-gates.ts` 的断言，让它验证完整可执行范围，不能只检查一个文件名出现。
3. 在隔离副本分别注入低对比度令牌、未豁免布局动画、硬编码颜色和超预算字面值；确认完整门禁均会失败，再移除夹具复验。
4. 同步 workflow 的范围说明与 CI 日志摘要；保留所有现有基线和豁免审核，不放宽阈值。

验收：本地 full 与 CI 都实际产生四类扫描结果，受控违规能阻断且无重复执行。回滚只调整编排方式，不能撤掉扫描保证。

## TEST-07 · P1（CI 出口）· 当前关键浏览器回归不能通过

**证据：当次 333 项选择全部运行，303 通过、30 失败，耗时 11.0 分钟，退出 1。** 运行 `test:e2e:critical:run`，使用独立端口、运行目录和 2 workers，保留失败截图、error-context 与 trace。30 是项目/用例组合数，不是 30 个独立根因。下表给出已能定性的类别；其余导航、肖像、工作台与聊天分支仍需按 evidence 的完整失败清单逐项定位，不能合并写成“应用不可用”或“都是旧测试”：

| 现象 | 当前能证明什么 | 下一步 |
| --- | --- | --- |
| 桌宠聊天按钮默认 hidden | 旧用例没使用新版右键/Shift+F10 入口；不证明聊天不可用 | 按 UX-05 更新前置交互并继续检验桥调用和布局 |
| `/companion` 无 h1 | 实际 DOM 语义与项目既有契约不一致；部分布局检查因此未运行到 | 补适合透明窗的标题语义，分离页面就绪与标题断言 |
| 聊天迁移断言多出 6 个合法角色的 default outfit | 固定“两角色字典”预期落后于角色目录扩展 | 断言旧两角色迁移不丢且新增角色默认正确；继续执行原凭据/持久化断言 |
| `.room-setup`、`.mood-card` 不存在 | 当前 DOM 与旧定位不符，不能据此推断实际聊天/风格功能失败 | 按新界面验证相同业务结果和可访问名称，避免纯 CSS 绑定 |
| Anima 夏目选择器匹配 2 个按钮 | 文本包含匹配同时命中夏目与双人；失败发生在请求断言之前 | 使用现有唯一可访问名称，继续保留实际请求/LoRA/多人限制验证 |
| Live2D 加载/换装/角色竞争用例失败 | 当次断言未满足；尚未逐项证明是素材条件、UI 前置或运行逻辑 | 按 trace 核对资源 HTTP 与当前模型身份，使用明确夹具补测；不宣称真实设备通过 |

落实步骤：将每个失败关联到“缺陷/测试契约/资源条件/未知”与源码基线；先复核第一处失败，不以延时、重试或 skip 覆盖；修正组件与测试分别说明；受影响用例定向通过后，再执行 critical 确认整体。最终记录失败清零或明确未执行条件，不能把本次失败仅写入日志而继续宣称 CI 绿色。

回滚：测试前置与对应产品行为同步回退；既有用户数据、角色目录及私有素材不因测试需要被删改。该条是回归出口治理，与 UX-05 的具体修复合并安排，不重复计问题数量。

## 交付证据与未验证范围

全量门禁、扩展 check、依赖审计、浏览器检查分别记录，失败项不能被其他项通过抵消。当次追加覆盖率运行通过：153 份前端测试、1,068 用例，lines 44.56%、branches 32.07%、functions 37.48%、statements 42.37%。基线阈值仍是全库 lines 17%、branches 11%，且 stores/utils/config/task-center 有独立更高阈值；优化宜从高风险变更模块补行为测试，不要求全库机械达到一个百分比。

GitHub combined-status 接口此次返回空 statuses，不能用它推断 Actions 成功、失败或 main 保护规则。原生 Windows runner 的可用性、实际流水线结果、Rust 编译、安装迁移、WebView2、真实模型/显卡及多屏功耗均未在本次审计中验收。提交这批报告不构成发布许可或运行代码修复。
