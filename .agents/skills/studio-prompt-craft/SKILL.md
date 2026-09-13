---
name: studio-prompt-craft
description: 编写或审查 AI-CG-Studio 的 Anima/Krea 2 图像提示词及编译一致性；不用于视频、普通档案资料或 UI 修改。
---

# Studio Prompt Craft

保留用户的画面意图，依据实际引擎组织输入。协作与授权遵循 [AGENTS.md](../../../AGENTS.md)；本 skill 不扩展任务范围。

## 按任务读取

- Anima 提示词或编译检查：读 [Anima 规则](references/anima.md)。
- Krea 2 提示词或编辑描述：读 [Krea 规则](references/krea.md)。
- 叙事 CG 或单人物立绘／特写壁纸的构图与完成度：再读 [构图参考](references/narrative-composition.md)，按目标进入叙事或壁纸规范。
- 手机竖屏壁纸：读 [手机规范](../../../docs/guides/prompts/mobile-wallpaper-prompt-standard.md)；成年角色非露骨题材或中性一致性排查：读 [稳定性研究](../../../docs/research/prompts/adult-nonexplicit-cg-reliability-2026-09-13.md)。
- 成年角色成人向／NSFW 场景与蓝图规范：读 [NSFW 规范](../../../docs/guides/prompts/nsfw-cg-prompt-standard.md)（严格遵循 adult 资格与本地宿主放行）。
- 写入仓库、批量重写、换装/生成验收或定稿：再读 [字段与交付](references/delivery.md)。纯草稿不要求启动仓库工作流或出图。
- 仅在解释模型能力、参数来源或旧规范冲突时查 [调研记录](../../../docs/research/prompts/prompt-skill-research-2026-09-09.md)。不用默认加载所有引擎和历史指南。

## 共同约束

- 仅输出任务需要的引擎；共享蓝图变更才核对双引擎。模型/checkpoint、LoRA、profile、画幅及参考用途优先从任务和当前配置取得，不跨 Base/Aesthetic/Turbo/MiaoMiao 或 RAW/托管版本套参数。
- 现有角色/服装/蓝图的身份与 ID 从当前数据读取，精确触发词保持不变；热门无 LoRA 路径与宁宁/夏目 LoRA 路径分开。
- 按画面需要明确主体数量、身份、服装、主动作/接触、表情、关键环境、镜头与光影。合理补充缺项，不改变指定人数、关系、服装、分级或构图。
- 抽象情绪转成可见行为；多人分别绑定外貌、位置和动作，负向不能排除请求中的人物。对白只有在要求画面文字时才写入，并保留原文与位置。
- 身份只放稳定特征；衣装、环境和动作进入各自字段，换装时去除旧衣装冲突。删除重复与不可见赞美，不强制题材配额、字符数或主体占比；字符数不是 Token 数。
- 遵守仓库分级边界；该 skill 处理全年龄、明确成年角色的非露骨创作与中性一致性审查，不提供露骨内容扩写配方。不能为凑数量增添成人内容或把分级字段当成年依据。

草稿给出目标引擎、必要假设及正/负向策略；未经实际运行就注明未编译/未出图。数据交付以编译请求和真实画面为证据，不能拿状态文案或静态检查冒充视觉通过。
