# 项目文档索引

日常只读下面八个入口；遇到具体问题再查专题。历史测试结果不能替代当前验收。

## 日常入口

| 文档 | 用途 |
| --- | --- |
| [项目说明](../README_zh.md) | 定位、安装与功能入口 |
| [设计规范](../DESIGN.md) | 品牌特色、主题与交互原则 |
| [项目状态](project-status.md) | 当前能力、数据规模与边界 |
| [未来规划](roadmap.md) | 待办、优先级与验收目标 |
| [统一工作流](workflow.md) | 现成命令与操作顺序 |
| [维护手册](maintenance.md) | 目录职责与常见维护 |
| [工程契约](engineering-contracts.md) | 模块、数据与生命周期约束 |
| [桌面部署](desktop-deployment.md) | 构建、同步、完整安装与 UAC |

协作执行规则单独见 [AGENTS.md](../AGENTS.md)。

图像提示词维护见 [skill 入口](../.agents/skills/studio-prompt-craft/SKILL.md)；按任务选择 [Anima](../.agents/skills/studio-prompt-craft/references/anima.md)、[Krea](../.agents/skills/studio-prompt-craft/references/krea.md) 或 [数据写入与验收](../.agents/skills/studio-prompt-craft/references/delivery.md)，不默认全部读取。

## 当前审计与待办

- [GLM W1 实施复核与提交范围](research/engineering/glm-w1-review-and-submit-scope.md)：元数据预览、覆盖漏检、类型边界修复及分批提交建议。
- [Gemini 场景候选复核与修订](research/prompts/gemini-scene-candidates/review.md)：60 份概念／12 份深化稿核对，三条双引擎修订候选，均未出图。
- [Gemini 第二轮复核与场景创作交接](guides/engineering/gemini-scene-draft-handoff.md)：已纠正项、新误报与 60 份场景概念／12 份双引擎草稿任务；不写生产内容。
- [GLM 报告复核与实施交接](guides/engineering/glm-implementation-handoff.md)：先做工作流元数据和只读覆盖报告，发布与真实内容变更单列。
- [Gemini 资产交付复核](research/engineering/gemini-asset-review-2026-09-13.md)与[后续任务包](guides/engineering/gemini-followup-tasks.md)：结构账本复核、报告更正、视觉初筛与文案/文档整理。
- [场景保存提交复审](archive/audits/scene-save-review-2026-09-13.md)：草稿 ID、快照版本、增量分片、完整性与失败恢复修复。
- [GLM / Gemini 任务提示词](guides/engineering/model-task-briefs.md)：工作流与字段职责盘点、资产对账与视觉初审；输出范围分离，统一复核。
- [手机竖屏壁纸](guides/prompts/mobile-wallpaper-prompt-standard.md)与[成年角色非露骨 CG 研究](research/prompts/adult-nonexplicit-cg-reliability-2026-09-13.md)：iPhone 17 Pro／通用长屏适配、非露骨创作及中性一致性检查；候选未出图。
- [单人物立绘与特写壁纸规范](guides/prompts/character-wallpaper-prompt-standard.md)：与叙事 CG 同列重点，分别评价人物表现和桌面适配；案例尚未出图。
- [叙事 CG 提示词规范](guides/prompts/narrative-cg-prompt-standard.md)与[研究依据](research/prompts/anima-krea2-narrative-cg-research-2026-09-12.md)：Anima／Krea 2 人物环境融合；示例及实验计划尚未真实出图。
- [工作流与内容数据治理计划（006）](../plans/006-workflow-and-content-governance.md)：后续工作流优化与人物、服装、场景、资产数据维护规划。
- [PC 桌面架构整理（005）](../plans/005-desktop-architecture-consolidation.md)：布局与状态接口整理、持久化和恢复原型、职责映射及本轮验收记录。
- [场景滚动与角色档案补全](archive/audits/scene-scroll-character-profiles-2026-09-12.md)：专家模式完整列表滚动、旧字段恢复显示与六位角色资料来源。
- [全站交互细节优化（2026-09-12）](archive/audits/interaction-detail-polish-2026-09-12.md)：状态联动、菜单/搜索/灯箱焦点、录音、分镜反馈与双主题页面复验。
- [1.7.1 办公机修复](releases/v1.7.1.md)：独立审计 A01–A05 的修复、浏览器契约整理与发布验收边界。

- [办公机独立全面审计（2026-09-12）](archive/audits/office-independent-audit-2026-09-12.md)：当前源码、当次门禁、隔离复现与浏览器结果；区分代码缺陷、已验证范围和无出图环境的验收缺口。
- [未完成事项](roadmap.md)：本次确证问题、保留的素材/真机验收、暂停任务与待决策项。历史记录中的“待办”不自动成为当前执行指令。

## 按需查阅

- [启动与排错](../STARTUP.md)：干净工作区启动、AI 服务端点、模型目录与本机凭据恢复。
- [专题指南](guides/README.md)：角色与粒子、提示词、美术、视频、桌面、工程设计。
- [研究与候选方案](research/README.md)：调研依据与待评估提案。
- [历史记录](archive/README.md)：审计、批次、实验、故障与过期方案。
- [版本更新](releases/v1.7.1.md)：当前修复及验收边界；[1.7.0](releases/v1.7.0.md)、[1.6.1](releases/v1.6.1.md)、[1.6.0](releases/v1.6.0.md) 与 [1.5.10](releases/v1.5.10.md) 保留为历史版本。
- [暂缓提案](../plans/README.md)：未启动的专项提案。
- [浏览器阅读入口](index.html)与[上手教程](getting-started.html)：面向使用者的静态手册。

## 文档放在哪里

| 目录 | 收录内容 | 维护规则 |
| --- | --- | --- |
| docs 根目录 | 上述日常入口与阅读门户 | 不追加单次报告 |
| guides/ | 可重复使用的专题指南 | 更新已有指南，注明历史段落 |
| research/ | 未采纳或待复核研究 | 执行优先级只写入 roadmap |
| archive/audits/ | 按日期记录的审计 | 保留失败项与原始验收边界 |
| archive/batches/ | 角色、场景接入批次 | 不把登记数量当成交付数量 |
| archive/completed/ | 已完成事项 | 只收录有完成依据的记录 |
| archive/troubleshooting/ | 故障与实验经验 | 保留可追溯的原因和证据 |
| evidence/ | 机器可读的审计证据 | 与报告链接对应，不重复抄入正文 |

新增文档登记到本页或对应分类索引。规模只在项目状态维护，待办只在规划维护。
移动文档需同步相对链接、脚本引用及 `redirects.json` 中的旧站内地址，并运行 `npm run wf -- docs:check`。
