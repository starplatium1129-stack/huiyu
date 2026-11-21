# 研究来源与采用边界

汇总项目图像方法、角色资料线索与工程选型的一手来源。具体参数与编译规则以 [studio-prompt-craft](../../.agents/skills/studio-prompt-craft/SKILL.md) 和 [专题指南](../guides/README.md#prompts) 为准；现行实现见 [工程契约](../engineering-contracts.md)，待验范围见 [未来规划](../roadmap.md)。

---

## 1. 采用原则

- **官方一手优先**：模型与算法优先采用作者或官方仓库文档；社区标签、百科与 LoRA 训练卡仅作辅助，不冒充官方规范。
- **事实分离**：明确区分「上游宣称能力」「项目编译实现」「创作建议」与「真机出图结果」；未出图验证的草案不得当作生产基线或成功承诺。
- **全分级创作**：全面支持 SFW、NSFW、R18 等全分级自由创作（红线见 [AGENTS.md](../../AGENTS.md#质量红线)），排查出图问题依次核对：身份 → `outfitId`/覆盖 → 场景/镜头 → 最终正负向 → 实际 workflow。

---

## 2. 模型与构图核心来源

- **Anima**：[HuggingFace: circlestone-labs/Anima](https://huggingface.co/circlestone-labs/Anima)。各 Base / Aesthetic / Turbo / 微调版不互套参数；普通标签与精确触发词分开处理。
- **Krea 2**：[krea-2 仓库](https://github.com/krea-ai/krea-2)、[Prompting 文档](https://github.com/krea-ai/krea-2/blob/main/docs/prompting.md)、[扩写定义](https://raw.githubusercontent.com/krea-ai/krea-2/main/docs/expansion.txt)、[技术报告](https://www.krea.ai/blog/krea-2-technical-report)、[Diffusers Krea2](https://huggingface.co/docs/diffusers/api/pipelines/krea2)。本地工作流不自动赋予托管风格参考与扩写能力。
- **构图与组合评测**：[Getty 构图原则](https://www.getty.edu/education/teachers/building_lessons/formal_analysis2.html)、[形式分析](https://www.getty.edu/education/teachers/building_lessons/formal_analysis.html)、[组合生成评测研究](https://papers.neurips.cc/paper_files/paper/2023/hash/f8ad010cdd9143dbb0e9308c093aff24-Abstract-Datasets_and_Benchmarks.html)。

---

## 3. 角色参考线索

> 仅作外部背景与命名追溯；实际角色 ID 与资产以运行目录 `content/catalog.sqlite` 为准，历史未完角色按 [未来规划](../roadmap.md#素材与设备验收) 对账。

| 角色 | 参考来源与注意事项 |
| --- | --- |
| 玛奇玛 | [Wikipedia](https://en.wikipedia.org/wiki/Makima) · [Chainsaw Man Wiki](https://chainsaw-man.fandom.com/wiki/Makima) |
| 木更 | [Project Engage](https://en.wikipedia.org/wiki/Project_Engage) · [Anibase](https://anibase.net/en/character/mRPoM/Kisara)（注意区分天童木更） |
| 楪祈 | [HuggingFace character_index](https://huggingface.co/datasets/deepghs/character_index/blob/main/pages/guilty_crown.md) · [角色资料](https://yenraphotography.com/wiki/Inori_Yuzuriha/) |
| 时崎狂三 | [Date A Live Wiki](https://date-a-live.fandom.com/wiki/Kurumi_Tokisaki)（左右眼按角色自身视角） |
| 御坂美琴 | [Donmai Wiki](https://safebooru.donmai.us/wiki_pages/misaka_mikoto) · [Index Wiki](https://toarumajutsunoindex.fandom.com/wiki/Misaka_Mikoto) · [character_index](https://huggingface.co/datasets/deepghs/character_index/blob/main/pages/toaru_majutsu_no_index.md) |
| 雷电将军 | [Genshin Wiki](https://genshin-impact.fandom.com/wiki/Raiden_Shogun) |
| 芙莉莲 | [中文维基](https://zh.wikipedia.org/wiki/葬送的芙莉莲) |
| 伊蕾娜 | [Donmai Wiki](https://safebooru.donmai.us/wiki_pages/elaina_%28majo_no_tabitabi%29) · [character_index](https://huggingface.co/datasets/deepghs/character_index/blob/main/pages/majo_no_tabitabi.md) |
| 莱万汀 | 以官方高清立绘为视觉主源，社区统计仅作辅助 |

---

## 4. 工程技术参考来源

- **已采用 / 在用**：Vue 3 / TypeScript、Rust / Axum、Tauri 2、[Reka UI](https://github.com/unovue/reka-ui)、[TanStack Virtual](https://github.com/TanStack/virtual)（图库虚拟列表）、[PhotoSwipe](https://github.com/dimsemenov/PhotoSwipe)（显式开关试验）。
- **设计借鉴来源**：[tagcomplete](https://github.com/DominikDoom/a1111-sd-webui-tagcomplete)、[Dynamic Prompts](https://github.com/adieyal/sd-dynamic-prompts)、[SwarmUI](https://github.com/mcmonkeyprojects/SwarmUI)、[InvokeAI](https://github.com/invoke-ai/InvokeAI)、[AIRI](https://github.com/moeru-ai/airi)、[Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber)、[fflate](https://github.com/101arrowz/fflate)（按需备用）。
