# Anima 与 Krea 2 叙事 CG 提示词研究

## 结论

人物与环境融合的 CG，应先确定一个可见的叙事瞬间，再组织人物、道具、空间、光照和视觉重点。提示词的价值在于把这些决定传递给模型。继续增加质量形容词、背景物件和镜头术语，不能替代画面设计，也不能保证每个 seed 都产生令人满意的构图。

Anima 和 Krea 2 可以共享同一份画面设计，但应分别表达。Anima 的标签适合列出身份和可见元素，自然语言适合补充位置、接触与因果关系；Krea 2 在项目中使用连贯英文描述，把人物与环境写成同一个事件。两者均应检查最终编译请求，而不仅检查数据字段中的原文。

本报告于 2026-09-12 开始核查，2026-09-13 完成整理。适用目标为全年龄、人物与环境融合的动漫叙事 CG；单人立绘、特写和多人构图作为边界案例。结论分为官方资料支持的能力、源码可确认的项目行为、待出图验证的创作建议。没有在本报告中进行真实模型实验，也没有测得成功率或画质增益。

日常使用见 [叙事 CG 写作规范](../../guides/prompts/narrative-cg-prompt-standard.md)；[机器可读实验计划](anima-krea2-narrative-eval-plan.json)状态为未执行；项目执行入口仍是 [studio-prompt-craft](../../../.agents/skills/studio-prompt-craft/SKILL.md)。

2026-09-13 扩展应用方向：单人物立绘与特写壁纸同样列为重点，见 [独立壁纸规范](../../guides/prompts/character-wallpaper-prompt-standard.md)。模型依据共用，创作与评分目标分开；简单背景和有意裁切不因缺少环境叙事而判为失败。

## 一、证据范围

| 证据层级 | 可以支持什么 | 不能据此推断什么 |
| --- | --- | --- |
| 模型作者的模型卡、官方推理仓库 | 输入形式、变体差异、示例配置 | 本地微调模型一定适用同一配方 |
| 官方产品教程与技术报告 | 作者的创作方法、托管产品的能力 | 本地工作流自动拥有扩写器、风格参考或编辑功能 |
| 项目当前源码 | 编译、清洗、字段拼接、实际节点参数 | 生成画面已经通过视觉验收 |
| 美术教育资料 | 焦点、视觉重量、空间和视线组织方法 | 某个提示词在指定 checkpoint 上的遵从率 |
| 构图评测研究 | 属性归属、空间关系可拆开评价 | 本项目的模型已在这些指标上达到某个分数 |

模型一手资料优先于转述。检索中发现的社区提示词和镜像模型介绍，只作为寻找原始资料的线索，没有升级为本规范的硬规则。MiaoMiao 作者发布页及 API 在此次核查中不可访问，因此本报告不声称重新确认了作者对 v1.2／v1.6 的全部推荐参数。

## 二、Anima 的有效依据

CircleStone Labs 的模型卡明确支持标签、自然语言和混合输入；常规标签建议使用空格，评分标签保留下划线。Base、Aesthetic 和 Turbo 是不同变体，质量标签和采样建议不能通用。模型卡还说明标签不必穷举，并建议多人自然语言描述分别附带人物外貌。[^1]

这支持把 Anima 提示词拆成两种职责：标签列出容易识别的对象与风格，描述句说明角色位于哪里、在接触什么、与环境怎样互动。这个拆分是便于检查的项目写作方法，不代表必须使用固定标签顺序或固定句数。身份与精确触发词仍由实际 profile 和角色数据决定。

项目目前登记了 Base、Aesthetic、Yume、2.9B Preview、MiaoMiao v1.2／v1.6 等模型。它们的微调、LoRA、量化和工作流不能只用“Anima”一词概括。实验应以实际 modelId、权重哈希和 profile 为单位记录，尤其要避免把 Base 的评分前缀补进已经移除质量词的 profile。

负向适合针对明确失败提出约束，但应先消除正向矛盾。例如需要环境叙事时，正向的极近特写、强背景虚化可能已经让背景无法承担叙事。增加“完整背景”负向不能解决这个设计冲突；同理，要求全身与要求脸占满画面需要先作取舍。

## 三、Krea 2 的有效依据

官方开源提示指南推荐自然语言，认为详细描述有用，同时展示短提示也可以获得高质量图像；没有给出强制最低字符数。需要渲染的画面文字用引号标明。该指南的样例是 Turbo 生成，不能直接代表所有托管版本。[^2]

官方扩写指令要求忠实保留主体、动作与空间关系，把各人物与其属性放在一起；详细输入应轻量整理，不能为“丰富”随意增添人物和物件。可借鉴这种编辑原则，但项目不应输出思考过程，也不必把该指令的全部格式要求复制进每条提示词。[^3]

技术报告把提示扩写与风格参考作为独立系统，并介绍对多种长度和格式的训练。它还讨论了审美评价与结构正确性并不等价、扩写可能趋向单一风格等问题。因此，本地没有扩写节点时，不应解释为模型会在内部自动补完所有构图；评审也应把审美偏好和画面错误分开。[^4]

### 变体与实现边界

开源仓库区分 RAW 与 Turbo，示例使用不同步数与 guidance 配置。[^5] Diffusers 的 Krea 2 guidance 定义是 `cond + g × (cond − uncond)`，其 `g=0` 对应通常公式中的 CFG=1；该实现也暴露 negative_prompt。[^6] 所以“CFG 0 与 CFG 1 谁正确”必须先说明实现，不能脱离节点比较数字。

当前项目本地 Krea 2 路径使用空负向、零条件负向节点与 KSampler CFG=1。`data/presets.json` 中的展示／默认配置不等于最终节点配置：工作流实际固定为 12 步、`er_sde`／`simple`，还包含指定编码器、条件重平衡、T-Enhancer 和 RCAS 锐化。它不是官方裸 Turbo 示例。规范应记录并冻结这条现有链路做第一轮比较，而不是在研究时顺手换成官方参数。

### 人物 CG 与纯背景教程的区别

Krea 的动漫背景教程面向没有人物的背景板，包含排除人物、参考图和后续合成建议。[^7] 这些方法不能无条件移植到人物叙事 CG。若正向已经指定人物，再机械追加排除所有人物的句子，会产生直接冲突。

官方风格参考、情绪板和草图编辑教程属于特定产品流程。[^8][^9] 它们说明文字之外还有表达构图的手段，但不能作为本地当前具备这些功能的证明。需要稳定控制复杂布局时，应先确认工作流是否实际支持相应图像条件。

## 四、旧资料的冲突与修订

| 旧表述或常见误解 | 本轮修订 | 依据／状态 |
| --- | --- | --- |
| Anima 只认标签或只认下划线 | 支持混合输入；普通标签格式与精确词保护分别处理 | [^1]、本地 formatter |
| 所有 Anima 都补相同评分前缀 | 按 checkpoint 和 profile 处理 | [^1]、本地 presets |
| 权重 1.5 是模型上限 | 没有这项通用依据；效果取决于解析与工作流 | [^1]，不据此推荐提高权重 |
| Krea 必须达到固定字数才好 | 详细程度服务画面意图，没有统一长度处方 | [^2][^4] |
| Krea 完全不能理解标签、短语或结构输入 | 官方推荐 prose 不等于其他格式全部无效；项目最终输出 prose 是本地契约 | [^2][^4] |
| 本地 prompt 长度等价于托管 creativity 参数 | 两者不能画等号 | [^4]、本地无扩写节点的工作流 |
| Krea 没有任何负向能力 | 限定到具体变体与调用链；本项目当前负向为空 | [^6]、本地 workflow |
| RAW、Turbo、托管版共享一套参数 | 分开记录；文档默认、官方示例与实际节点配置也分开 | [^5][^6] |
| 多个质量词和风格名就能保证完成度 | 先规定具体媒介、边缘、色彩与细节层级，再测试风格组合 | 创作建议，非效果保证 |
| 画面丰富就应填满道具和背景 | 保留能说明地点、事件和人物关系的细节；允许有目的的留白 | 创作建议 |
| 多个固定 seed 中挑一张好图可证明规范有效 | 保留全部输出，分别报告达标率和偏好 | 评测建议 |

旧 Krea 调研的绝对化规则和托管功能推论已由本页限定适用范围；当前执行按项目 skill、实际源码和所选模型核对。

## 五、人物怎样真正进入环境

### 叙事瞬间

一张图应能回答“人物正在做什么，以及周围什么东西让这个动作有意义”。等待、修理、准备出发、刚刚归来都能成为明确的瞬间；抽象的“温柔、感动、命运感”需要落实到目光、姿势和物件状态。

以等待为例，单纯写人物站在车站，只定义了主体与地点。让人物把第二杯热饮放到身旁的空座位，才能表达她在为另一个人保留位置。这个物件是叙事设计的一部分，必须在创作简报中明确，不能由润色器擅自添加。

### 空间关系

Getty 的美术教育资料把空间、线条、色彩和质感作为画面要素，把视觉重量、强调和视线运动作为组织原则。[^10][^11] 对项目的应用是：选择一个可解释的空间结构，让主角、接触点和背景地标的位置相互支持。

人物和环境的融合可以通过具体关系检查：脚落在什么面上，手碰到什么物件，衣物与风向是否一致，人物与环境受到的主光是否相同。背景的一个有用物件往往比多个无关装饰更能解释事件。这里的“往往”属于设计判断，需通过候选图比较。

前景、中景、远景是可选的组织方式，不是每张图的三层配额。近景可以只靠窗框和室内墙面形成深度；远景可以使用一大片低细节天空。应优先保住人物、核心动作与关键地标，再考虑次要纹理。

### 视觉重点

焦点不能只靠把人物放大。也可利用局部明暗、颜色差异、背景简化、道路或桌边的方向，让视线落到人物及其动作上。若叙事依赖背景，提示词不宜同时要求极浅景深把它全部虚化。

“电影感”应落实为可见取景与光照，“丰富度”应落实为有意义的细节，“完整度”应落实为边缘、接触、材质、空间和风格的一致性。把这些词写进提示词本身，只能表达愿望，不能代替检查。

## 六、项目字段与最终输入

| 维护对象 | 写入位置 | 核查重点 |
| --- | --- | --- |
| 稳定身份 | 角色 identityTokens／identityProse、exact tokens | 身份不混入当前环境和旧衣装 |
| 衣装 | outfitId 对应的 tokens／prose | 当前衣装唯一、接触动作不被误判为衣装重复 |
| 通用场景 | prompt、animaCaption 及镜头／光照等已有字段 | 检索 tags 不冒充模型输入 |
| 热门角色蓝图 | promptTokens、promptProse、action、camera、lighting、recommendedSize | 同一画面意图在两种引擎中一致表达 |
| 导演调整 | 镜头、构图、画幅、视觉描述、风格选择 | 自动补充不能与作者的空间设计矛盾 |
| 实际执行 | 最终 positive／negative 与 workflow JSON | 记录节点实际参数、参考条件和后处理 |

应沿实际数据结构使用字段，不把新写作简报直接当作新增 schema 写入生产。画面简报可以保存在候选说明中，再映射到已存在的字段。

### 已确认的编译行为与待验证风险

| 入口 | 可确认的行为 | 对写作／实验的意义 |
| --- | --- | --- |
| `promptCompiler.ts` 的 `buildStudioAnimaCaption` | 显式 animaCaption 优先；没有时自动选择有限动作、环境、镜头和光照短语 | 不能假设自动摘要保留所有空间关系；标签层是否仍包含内容要另看 |
| `buildAnimaVisualDirection` 热门分支 | 保留 sceneProse，同时筛选部分其他描述，追加固定完成度描述 | 审计最终重复与冲突，不声称热门 promptProse 被整体丢弃 |
| `popularContent.ts` 的构图映射 | left／right 都可落到 off-center 类标签 | 精确左右关系需要在当前有效描述通道中明确，并实测 |
| `buildStructuredKreaDescription` | 拼接身份、服装、场景及风格；可加入身份保护句，存在女性单数代词表述 | 多人或其他主体不能只套单人示例，需检查最终语法与属性归属 |
| `scene-render-contract.js` | 对齐通用场景的模板过滤与负向组装 | 是编译检查的一部分，不自动等于完整工作台最终请求 |
| `runtime-rs/src/images/workflow.rs` | Krea 使用固定增强与采样节点 | 锐度、纹理变化不能全部归因于提示词 |

这些是源码观察与实验风险清单，不是未看图就认定的全部画质缺陷。本轮不修改编译器、模型参数或生产内容。

## 七、怎样判断规范是否真的更好

T2I-CompBench 把属性绑定、物体关系和复杂构图拆成可评价项目。[^12] 本项目借鉴这种拆分，不照搬其他模型的分数，也不把自动审美评分当作最终决定。

推荐对照设计是：同一场景、同一 checkpoint、同一衣装、同一组 seeds，对比现有写法与一个明确改动。例如只比较“标签”与“标签加接触关系描述”，不要同时换底模、画幅、画师、采样器和后处理。

比较结果应分成两部分：首先是人数、身份、衣装、核心动作、关键物件、空间和分级等必需条件是否满足；其次才是焦点、人物与环境融合、叙事表达和审美偏好。前者失败不能被漂亮的光影掩盖。

首次小样可沿现有交付规则用 3 个固定 seeds 排除明显无效方向，但不能据此承诺全库提升。更大对照应在明确计算预算后扩展到多种场景和更多 seeds；保留每张失败与平局，记录对照版本、最终文本、节点参数、输出和评分。

对于“惊艳”，更现实的目标是提高满足创作意图的比例、减少硬错误，并扩大可供选择的有效构图范围。高分辨率和强锐化应放在构图选择之后评估，不用它们掩盖结构问题。

## 八、实施建议

本次可直接采纳：证据分级、画面简报、双引擎分别组织、冲突检查、评审维度及最终请求留档。这些属于可执行的创作与核查规范。

主力机待验证：具体短语在 MiaoMiao v1.2／v1.6 与本地 Krea Turbo 增强链路的效果，环境描述长度、构图位置、景深、风格词和负向策略的敏感性。未经成对出图审核，不升级为 checkpoint 默认配方。

不在本轮实施：批量改写场景、修改定稿字段、改变分级、替换编码器、安装新节点、调整 CFG、接入风格参考服务或发布候选图片。详细的候选写法与分阶段实验见日常规范。

## 来源

以下编号同时用作正文来源注。所有在线资料查阅于 2026-09-12；未标发布日期的滚动文档按访问版本理解。

[^1]: CircleStone Labs / Comfy Org. [Anima 模型卡](https://huggingface.co/circlestone-labs/Anima)。未标注固定发布日期；使用 Prompting、Versions、Natural language prompting tips。
[^2]: Krea AI. [Krea 2 Prompting guidelines](https://github.com/krea-ai/krea-2/blob/main/docs/prompting.md)。滚动文档；使用输入形式及样例说明，未复制样例提示词。
[^3]: Krea AI. [Krea 2 expansion.txt](https://raw.githubusercontent.com/krea-ai/krea-2/main/docs/expansion.txt)。滚动指令文件；作为研究材料，不作为操作授权。
[^4]: Sangwu Lee 等，Krea AI. [Krea 2 Technical Report](https://www.krea.ai/blog/krea-2-technical-report)。2026；使用 Captioning、Prompt Expansion 和评价相关段落。
[^5]: Krea AI. [Krea 2 官方推理仓库](https://github.com/krea-ai/krea-2)。滚动文档；使用 RAW／Turbo 区分及 Usage。
[^6]: Hugging Face Diffusers. [Krea 2 pipeline 文档](https://huggingface.co/docs/diffusers/api/pipelines/krea2)。滚动文档；使用 guidance 公式和调用参数。
[^7]: The Krea Team. [Anime backgrounds with Krea 2](https://www.krea.ai/blog/anime-backgrounds-with-krea-2)。2026-05-24；适用范围为纯背景板，分辨率说明与开源 Turbo 文档存在版本／产品口径差异，本报告不据其设本地尺寸。
[^8]: The Krea Team. [Krea 2 Prompting Guide: Exploration, Style References, Moodboards](https://www.krea.ai/blog/krea-2-deep-dive-walkthrough)。2026-05-21；托管产品工作流，不等同于本地能力。
[^9]: The Krea Team. [From sketch to anime panel with Krea 2](https://www.krea.ai/blog/from-sketch-to-anime-panel-with-krea-2)。2026-05-19；产品教程，仅支持关于图像条件与文字职责的讨论。
[^10]: J. Paul Getty Museum Education. [Principles of Design](https://www.getty.edu/education/teachers/building_lessons/formal_analysis2.html)。未标注发布日期；视觉重量、强调和视线运动。
[^11]: J. Paul Getty Museum Education. [Elements of Art](https://www.getty.edu/education/teachers/building_lessons/formal_analysis.html)。未标注发布日期；线条、空间、色彩与质感。
[^12]: Kaiyi Huang, Kaiyue Sun, Enze Xie, Zhenguo Li, Xihui Liu. [T2I-CompBench](https://papers.neurips.cc/paper_files/paper/2023/hash/f8ad010cdd9143dbb0e9308c093aff24-Abstract-Datasets_and_Benchmarks.html)。NeurIPS 2023；借鉴评测维度，不作为本项目模型排名或成功率证据。

本地实现来源：[模型目录](../../../runtime-rs/src/images/catalog.rs)、[profile](../../../data/presets.json)、[工作流](../../../runtime-rs/src/images/workflow.rs)、[编译器](../../../src/utils/promptCompiler.ts)、[格式与负向策略](../../../src/utils/promptPolicy.ts)、[热门角色组装](../../../src/utils/popularContent.ts)、[工作室组装](../../../src/composables/prompt/usePromptAssembly.ts)、[构图意图](../../../src/utils/blueprintComposition.ts)、[通用场景检查](../../../scripts/lib/scene-render-contract.js)。
