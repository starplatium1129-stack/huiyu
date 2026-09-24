# AI-CG-Studio 协作指南

本文件保留仓库执行边界；历史报告只作线索。查现状用 [项目状态](docs/project-status.md)，查待办用 [未来规划](docs/roadmap.md)，找专题用 [索引](docs/INDEX.md)，无需每次全部读取。

## 指令优先级与自主执行

- 当前用户要求优先于仓库一般指导；skill 仅补充适用领域的约束。意图明确时按合理、可逆的假设完成实现和必要验收，已有授权不重复询问。确需新授权时先准备可审核结果；阻塞不影响独立部分继续推进。
- 中途补充或压缩上下文后，保留原目标、约束、已完成工作和有效证据；仅在明确取消或目标不兼容时替换任务。
- 只读取影响本次决策的资料。涉及服务/数据边界查 [工程契约](docs/engineering-contracts.md)，寻找命令或准备构建/部署查 [工作流](docs/workflow.md)；复用已读上下文。文档条款导致暂停时指出文件与原文，区分真实要求和自己的推断。
- 独立模块、分批内容或审查可在明显提效时委派，交代目标、文件/ID 边界和验收标准；主会话继续其他工作并复核产物。小改动和强依赖步骤直接处理。

## Skills 适用与维护

- 图像提示词创作/编译一致性用 [studio-prompt-craft](.agents/skills/studio-prompt-craft/SKILL.md)；UI、普通档案文字和代码任务不因涉及角色就加载它。本机可选的 apple-design 仅辅助相关设计，不要求重做页面或安装动画库。
- skill 描述保持简短且准确；入口只放共同约束与任务路由，条件细节放参考文件。只记录模型不易从代码得出的项目知识，不复制本文件或把旧示例、默认值升级为硬规则。共享规范兼容不同模型，不把编码代理建议当作 Anima/Krea 参数。

## 开工与工作区保护

- 写入前核对 git status、git diff，保护其他会话改动。禁止 git add .、git reset --hard；仅暂存已验证的受控文件，每次提交后 push。
- 同一工作区只由一个会话做 Git 写操作；并行使用 worktree 或错峰，长期并行关闭自动 gc（git config gc.auto 0）。本地 bundle 不替代远端副本。
- 查找操作优先使用现有工作流；入口不明时用 npm run workflow -- --help，仍无入口再查 scripts/maintenance。新增维护脚本登记 scripts/workflow.js 与 docs/workflow.md，新增文档登记 docs/INDEX.md；一次性脚本归入被忽略的 scripts/archive/。

## 质量红线

- 提示词、蓝图、服装绑定、换装变更必须核对编译 Token 与真实渲染画面；不能用界面文字、状态或静态测试代替出图。场景切换需同步 outfitId、镜头和参数。
- 批量内容逐条真实重写；必须通过 `node scripts/tests/test-prompt-rewrite-integrity.js --delivery <文件>`，不得用模板、追加词条或虚报覆盖率交付。
- `data/prompt-pinned-scenes.json` 的 prompt/negative/animaCaption/recommendedSize/rating/mature 为字节级保护基线，批量任务跳过。单条改动须先真实出图，再 `npm run scenes:pin-capture`，提交说明附证据。
- 高频动画只用 transform/opacity；例外必须写 `/* compositor-exempt: 理由 */` 并评审基线。新增或修改图标使用 `ArchiveIcon.vue` 的手绘线条 SVG，不使用 Emoji 或实心图标。
- 当前支持深浅主题，新增/修改 UI 均需两种主题视觉审查、WCAG AA 对比度与扫光不压字。禁用文字用 `--text-disabled`，不得 opacity 压字。check-contrast 覆盖双主题全局令牌与角色强调色；组件动态样式、图片叠字和实际布局仍需浏览器视觉验收。
- 保持本机/远程分级边界：`adultEnabled = isLocalStudioHost()`；远程、隧道、未知或未授权状态 fail-closed，保留拒绝与模糊遮罩。分级字段约定见 [内容与接入契约](docs/engineering-contracts.md#角色接入)。
- `assets/character-references/` 不入 Git；运行时经 `/data/character-reference-view.json` 懒加载。pending 占位不能计为已交付资产。
- 单体有效行数上限 600；存量豁免只降不升，门禁为 `test-monolith-budget.js`，基线为 `scripts/tests/monolith-baseline.json`。

## 实施与交付

- 复杂状态放 composable，View 负责展示。按改动核对工程契约和上面的质量红线。
- **实现克制与反过度设计**：不做推测性抽象；单一场景直接实现，延迟至第二个真实用例出现才提取通用能力，不预留无用配置项。
- **重构删除优于兼容**：内部逻辑重构时直接清理过时实现，严禁新增兼容垫片（deprecated shim）与死分支；单文件逼近 600 行红线时必须先拆分解耦。
- **边界清晰与模型隔离**：生图网关协议、本地 JSON 持久化数据、Pinia 状态与 View 视图模型严禁互相泄漏，数据在边界处完成转换校验，不跨层共享可变引用。
- **依赖自律与避免重复发明**：引入新功能前先检索当前依赖库（package.json），不臆断缺少能力，严禁重复自研通用工具，不引入非必要三方依赖。
- **并发、竞态与资源回收**：生成与长耗时调用必须支持取消（AbortController/连接断开）、超时与防重入；涉及 Live2D、Pixi、音频播放等长生命周期对象，必须保证严格释放，杜绝内存与显存泄漏。
- **上下文留存**：特殊引擎 Hack、模型缺陷绕过与规避逻辑必须写明“原因、约束与预期消除条件”；严禁留下缺少上下文的悬空 TODO。
- 验证以 [工作流的分层选择](docs/workflow.md#门禁与构建) 为准。局部样式不因属于“代码”就跑全量；新增测试应检验行为与回归风险。提交本身不升级检查范围。同内容已有证据可复用，后续改动只重跑受影响项；必要检查通过后交付，不扩成无关审计。
- 已确认使用隔离夹具、无生产访问的本地测试可自主执行、修复本次导致的失败并定向重跑。真实模型/设备调用、安装和发布仍按实际任务授权，不能把所有测试都当作无副作用。
- 桌面同步只用 deploy-desktop.bat；已有当前构建可用 -SkipBuild，依赖或 exe 变化需完整安装；UAC 由用户操作。详见 [部署指南](docs/desktop-deployment.md)。
- 简洁说明结果、验证和剩余限制；未执行、失败或需设备验收的步骤如实列出，历史 PASS 不替代当次证据。

维护依据：[OpenAI 关于 Astra 的 skills 与提示词建议](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)（2026-09-12 核对）。项目质量红线属于本地约束。
