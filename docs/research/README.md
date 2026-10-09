# 研究来源与采用边界

整理日期：2026-10-09。合并旧研究的必要来源与未完成范围。本次未联网重新核验来源、编译候选或调用模型；原查阅时期为 2026 年 8–9 月。旧草稿、名单和参数快照可从 Git 历史查回，不在此建立第二份角色库或模型参数表。

## 来源原则

官方作者资料优先；百科、社区标签、LoRA 训练资料和镜像仅作辅助，不冒充原词条正文。来源描述、源码行为、创作建议与真实图片结果分别记录。现行实现见[工程契约](../engineering-contracts.md)，人物/服装/场景/蓝图通过运行目录 content/catalog.sqlite 读取，data/catalog 仅为项目快照。

## 模型与图像方法

- [Anima 作者模型](https://huggingface.co/circlestone-labs/Anima)。不同 Base/Aesthetic/Turbo/微调 profile 不互套参数，普通标签与精确触发词分别处理；现行 MiaoMiao 作者规则查[项目 skill](../../.agents/skills/studio-prompt-craft/SKILL.md)。
- [Krea 2 源码](https://github.com/krea-ai/krea-2)、[提示词说明](https://github.com/krea-ai/krea-2/blob/main/docs/prompting.md)、[扩写定义](https://raw.githubusercontent.com/krea-ai/krea-2/main/docs/expansion.txt)、[技术报告](https://www.krea.ai/blog/krea-2-technical-report)、[Diffusers](https://huggingface.co/docs/diffusers/api/pipelines/krea2)。RAW/Turbo、本地工作流和托管功能分别核对；自然语言建议不等于最低字数要求，也不自动赋予本地风格参考/扩写能力。
- [Getty 构图原则](https://www.getty.edu/education/teachers/building_lessons/formal_analysis2.html)与[形式分析](https://www.getty.edu/education/teachers/building_lessons/formal_analysis.html)；[组合生成评测研究](https://papers.neurips.cc/paper_files/paper/2023/hash/f8ad010cdd9143dbb0e9308c093aff24-Abstract-Datasets_and_Benchmarks.html)。接触、空间、光照建议需本地画面验证，不是成功率承诺。
- [画师与明日方舟参考](prompts/arknights-artists-research-2026-08-31.html)保留稳定阅读地址，只作风格来源参考，既有画师词不自动注入生成。

最终请求和节点配置优先于展示默认值。负向、guidance 和增强能力限定具体实现；创作细节只在[专题指南](../guides/README.md#prompts)维护。

## 明确成年非露骨一致性检查

年龄需有可靠依据，不能以 adult 标签替代。按身份→outfitId/覆盖→场景/镜头→最终正负向→实际 workflow 排查，先处理正向矛盾，区分身份混乱、衣装漂移、接触错误、编译丢失与模型未遵从。保留代表性失败、原图/后处理图及请求；旧研究不代表生产内容已逐图验收，也不改变分级或访问边界。

## 人物资料入口

下表继承来源线索，不重新宣称每项均已双源确认。当前角色 ID 与内容从记录库读取；历史接入配额不转成新任务。

| 角色 | 旧研究保留入口与限制 |
| --- | --- |
| 玛奇玛 | [百科](https://en.wikipedia.org/wiki/Makima)、[作品社区](https://chainsaw-man.fandom.com/wiki/Makima) |
| 木更 | [Project Engage](https://en.wikipedia.org/wiki/Project_Engage)、[角色资料](https://anibase.net/en/character/mRPoM/Kisara)；须与天童木更区分 |
| 楪祈 | [索引数据集](https://huggingface.co/datasets/deepghs/character_index/blob/main/pages/guilty_crown.md)、[角色资料](https://yenraphotography.com/wiki/Inori_Yuzuriha/)；数据集不冒充官方设定 |
| 时崎狂三 | [作品社区](https://date-a-live.fandom.com/wiki/Kurumi_Tokisaki)；左右眼以角色自身视角 |
| 御坂美琴 | [词条](https://safebooru.donmai.us/wiki_pages/misaka_mikoto)、[作品社区](https://toarumajutsunoindex.fandom.com/wiki/Misaka_Mikoto)、[索引](https://huggingface.co/datasets/deepghs/character_index/blob/main/pages/toaru_majutsu_no_index.md)；wiki 不包含完整外貌/校服标签清单 |
| 雷电将军 | [作品社区](https://genshin-impact.fandom.com/wiki/Raiden_Shogun) |
| 芙莉莲 | [作品百科](https://zh.wikipedia.org/wiki/葬送的芙莉莲) |
| 伊蕾娜 | [角色词条](https://safebooru.donmai.us/wiki_pages/elaina_%28majo_no_tabitabi%29)、[索引](https://huggingface.co/datasets/deepghs/character_index/blob/main/pages/majo_no_tabitabi.md) |
| 莱万汀 | 原研究以用户提供的官方高清立绘为视觉来源，社区 LoRA/统计为辅助；旧机器原图路径不代表当前可用，旧 v8/v14 prompt 不作为现行默认 |

8/31 接入八角色与 9/6 批准 49 人是旧批次。批准不等于实物完成，剩余按[规划 V02](../roadmap.md#素材与设备验收)以当前 ID 对账，不恢复强制固定视角配额。

## 候选与未执行实验

- Gemini 图片库存原 45 位候选、115 位待确认；43 项旧 All 登记与两个先导样例不等于新分级或逐图验收，采用前按实际文件重建路径/哈希。
- 场景原 60 概念、12 深化、3 修订稿均未编译/出图/发布；未选 48 条未完整复审。优先复核旧草稿 ID draft_c01_01、draft_c02_02、draft_c05_03，sourceDraftId 不是生产 ID。原正文从 Git 查回，恢复前对当前身份、衣装和对照实体重查。
- 对照实验保持 not-executed / autoRun=false。叙事、桌面壁纸、手机壁纸、明确成年非露骨题材分开评价；单 checkpoint、一案例、baseline/candidate、seeds 101/202/303 共六图只是原小样草案，须有本次算力范围才执行，不自动扩大旧批次。
- 冻结模型 hash/profile、LoRA、尺寸、seed、节点参数、增强、引用图与最终请求；保留失败和平局，模型缺失不静默换模。4K 是展示/裁切目标，不保证原生 4K，手机锁屏/主屏遮挡需设备验收。

## 工程参考

原研究项目包括 [PhotoSwipe](https://github.com/dimsemenov/PhotoSwipe)、[tagcomplete](https://github.com/DominikDoom/a1111-sd-webui-tagcomplete)、[Dynamic Prompts](https://github.com/adieyal/sd-dynamic-prompts)、[SwarmUI](https://github.com/mcmonkeyprojects/SwarmUI)、[InvokeAI](https://github.com/invoke-ai/InvokeAI)、[AIRI](https://github.com/moeru-ai/airi)、[Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber)、[Reka](https://github.com/unovue/reka-ui)、[TanStack Virtual](https://github.com/TanStack/virtual)和[fflate](https://github.com/101arrowz/fflate)。链接为历史来源，非本次选型推荐。

当前保留 Vue/TypeScript、Rust/Axum、Tauri；Reka 已用，PhotoSwipe 为显式试验，TanStack/fflate 待实际需求。统一词条、随机快照、任务阶段、配方恢复和语音生命周期已落地，不重新列为待开发。触屏/Tauri/大图集、GPU 长时、真实模型/TTS/口型见[统一规划](../roadmap.md)。
