# 成年角色非露骨 CG 稳定性研究与检查规范

## 范围与结论

本报告处理明确成年角色的非露骨图像，包括成熟气质、时装／泳装造型、暧昧互动和含蓄亲密关系；不提供露骨性行为、生殖器细节或以性刺激为目的的提示词优化，也不提供绕过分级或访问限制的方法。人物年龄需有明确依据，不能用一个 adult 标签覆盖原本未成年或年龄不明的角色。

“非全年龄”不是一个足够精确的画面简报，也不能作为统一提示词模板。成熟时装、亲密氛围、衣装变化和人物互动需要不同的构图与评价目标。当前没有一组代表性的最终请求、失败图及相同参数对照，因而不能定量认定所有失败都来自提示词，也不能声称本报告已经解决现有生成问题。

结论是先减少跨层矛盾：明确本次允许表现的非露骨目标，确认角色与衣装，单独指定姿态和景别，再核对最终输入。若反复修改的是同一类遗漏，应把它变成可复现的编译或生成用例，而不是每张图继续追加一组质量词。

## 一、能确认的模型依据

Anima 的官方资料支持标签与自然语言混合输入，同时区分 Base／Aesthetic 等变体。由此可以采用“明确元素＋关系描述”的组织方式，但没有证据表明标记成熟内容就会自动提高人物姿态或衣装遵从度。[^1]

Krea 2 官方指南推荐自然语言；扩写指导强调保留人物属性、动作和空间关系，避免擅自增加物件或高度具体的衣装细节。[^2][^3] 对非露骨成人创作，这意味着将所需气质落到可见姿态、服装材质、目光和光照上，而不是依赖一个含义宽泛的尺度形容词。

模型卡、官方案例和本地特定 checkpoint 的实际表现是不同证据。MiaoMiao 作者页此前未能直接核验，本报告继续保留该限制。Krea 的本地增强链路与官方裸模型不完全一致；效果差异必须固定实际 workflow 比较。

## 二、把“感觉不对”分成可检查的问题

| 问题类别 | 如何确认 | 非露骨范围内的处理方向 |
| --- | --- | --- |
| 身份或成熟气质漂移 | 对照既有成年角色外貌及原始设计 | 保留身份锚点，用姿态、衣装与表情表达气质，不擅自改年龄或身体设定 |
| 衣装不一致 | 对比已选 outfit 与最终正向，查看是否同时存在另一套衣装 | 找到信息来源并消除冲突；明确需要保留的衣装结构，不默认提高暴露程度 |
| 姿态或接触失败 | 看清手、物件、支撑面与身体方向 | 在非露骨样例中减少同时执行的动作，写清接触对象和相对位置 |
| 镜头改变目标 | 检查特写／半身／全身及实际裁切 | 同一次实验保留一个明确景别，不用全身与极近面部互相竞争 |
| 光照与材质失真 | 比较未后处理原图与最终图 | 固定增强和锐化，先确定问题来自生成还是后处理 |
| 文本与画面不相符 | 对照源字段、编译文本、实际请求和输出 | 区分字段遗漏、自动补词、模型遵从不足与审核偏好 |

这张表是诊断框架，不是对现有全部数据的审计结果。失败图至少应与最终请求、实际衣装 ID、模型及 workflow 一起保留，否则“修改后好一点”无法可靠归因。

## 三、项目链路的中性核查

`popularContent.ts`、`promptCompiler.ts` 和对应组装 composable 共同决定人物、衣装、蓝图、导演描述与负向的合成结果。不同分级、衣装覆盖和场景选择会经过不同分支；仅查看蓝图里的一段文本不能代表最终输入。

对明确成年且衣装完整的非露骨候选，建议逐层记录：

1. 身份来源与可见特征；不要把服装或环境混进稳定身份。
2. 实际 outfitId、是否有显式覆盖，以及最终是否保留所选衣装。
3. 蓝图、视觉描述、镜头和光照是否表达同一目标。
4. 最终正向是否有重复或冲突；负向是否排除了本次请求中的正常人物、衣装、道具或取景。
5. 实际工作流的编码器、模型、采样与后处理，是否与界面摘要一致。

分级字段是接入和内容治理的一部分，不是自动修改衣装或提高画面质量的按钮。此类检查不要求降低限制、开放远程成人访问或调整原有遮罩；也不在本报告中更改生产分级数据。

## 四、非露骨写作原则

### 明确成年身份与衣装

原创人物可以在简报中明确成年年龄；已有角色依据项目的可靠身份来源。衣装描述写清可见的结构、颜色和材质。气质与尺度分开：自信、优雅、克制或亲密，均可以在衣装完整的条件下表达。

### 情绪落到可见行为

用目光方向、肩颈姿态、轻微微笑、人物间距离和环境照明表达情绪。含蓄关系可以通过共同看向同一物品、轻扶手臂或相邻坐姿表达；不自动升级为露骨动作。多人时先确认该工作流允许的人数和构图，再分别绑定属性。

### 服装与材质保留层次

画面完成度可检查面料结构、褶皱受力、配饰和轮廓，不需要为了成熟感增加皮肤暴露。Getty 对视觉强调与重量分配的说明支持按主次组织画面；具体提示词效果仍需当前模型实测。[^4]

### 负向和参数不作通用补救

先消除正向矛盾，再针对具体可见错误调整。不能把某个 checkpoint 的负向长模板当作所有模型配方。项目本地 Krea 负向策略和 CFG 约定沿用当前实现，不为了此类创作去改变过滤或编码链路。

## 五、原创非露骨候选

以下是用于检验衣装、姿态、景别和气质的原创成年人物案例，未编译、未出图、未审核。不是露骨内容优化配方，也不替换生产角色。

### M1：晚宴前的时装肖像

Anima 候选：

```text
1girl, solo, adult woman, age 28, long brown hair, green eyes, dark green evening dress, long sleeves, small earrings, standing, three-quarter view, fashion illustration, anime style
An adult woman stands beside a tall window before an evening reception, wearing an opaque dark green dress with a high neckline and long sleeves. She turns her shoulders slightly toward the viewer, resting one hand lightly on the back of a chair while the other arm remains relaxed. Her confident gaze and small smile carry the mood. Warm light from the room defines the fabric folds, with cooler window light along the far side. Keep the dress construction and the hand-to-chair contact clear, against a restrained interior background.
```

Krea 2 候选：

```text
A refined anime fashion portrait of a 28-year-old woman preparing for an evening reception. She has long brown hair and green eyes and wears an opaque dark green dress with a high neckline, long sleeves and small earrings. Standing beside a tall window, she turns her shoulders slightly toward the viewer and rests one hand on the back of a chair. Her other arm is relaxed, and her confident gaze and small smile create the atmosphere. Warm room light reveals the dress folds while cooler window light touches the far side. Keep the clothing design consistent and the hand supported by the chair, with a quiet interior that does not compete with her expression.
```

检查：所选衣装是否保留、手椅接触、肩颈结构、表情与光源。不能仅因“成熟题材”就自动提升项目分级；分级按实际内容和现有约定判断。

### M2：含蓄双人关系的设计用例

设计简报可以是两位明确成年的原创人物在咖啡馆相邻而坐，共同看一本相册，一人轻扶另一人的手臂。检查两人属性、位置、视线和正常接触是否一致。该用例先确认模型能力与项目多人路径；没有确认前不生成可直接套用的生产提示词，也不借修改人数词绕过能力边界。

## 六、减少反复修改的实验方法

先选择一个非露骨单人用例，不同时改变场景、衣装和模型。用同一组 3 个 seeds 比较基准与一个明确改动，保存最终输入而不仅是编辑文本。先判身份、衣装、正常接触、景别是否达标，再评价气质和完成度。

若修改在多个 seeds 上稳定解决同一错误，才能形成该 checkpoint 的条件性建议；若改善不稳定，保留为待验证假设。两轮仍出现同一系统性失败时，先检查最终请求和工作流，再决定是否继续生成。停止条件应依据证据和预算，不无限扩写或反复撞 seed。

输出记录建议包含：问题类别、基准／候选差异、人物与衣装标识、模型、实际参数、最终正负向、原图、后处理图、逐项结果及人工意见。不得把生成成功直接记为视觉通过。

## 七、后续边界

此报告可以用于成年角色非露骨时装、泳装及含蓄关系的创作和中性一致性检查。现有生产非全年龄内容未在本轮重写、逐图审核或优化；露骨内容不在报告交付范围内。主要待办是收集允许范围内的代表性失败案例，建立可复现的定位与主力机对照，不宣称已有统一解决配方。

## 来源

查阅日期为 2026-09-13。模型一手资料支持一般输入能力；下文艺术方法与案例是项目建议，没有模型成功率证据。

[^1]: CircleStone Labs / Comfy Org. [Anima 模型卡](https://huggingface.co/circlestone-labs/Anima)。使用版本差异和输入形式说明，未提取露骨生成配方。
[^2]: Krea AI. [Prompting guidelines](https://github.com/krea-ai/krea-2/blob/main/docs/prompting.md)。自然语言与详细描述的适用范围。
[^3]: Krea AI. [expansion.txt](https://raw.githubusercontent.com/krea-ai/krea-2/main/docs/expansion.txt)。忠实于已有主体、属性、动作及空间关系。
[^4]: J. Paul Getty Museum Education. [Principles of Design](https://www.getty.edu/education/teachers/building_lessons/formal_analysis2.html)。视觉重量与强调。

本地依据：[热门角色组装](../../../src/utils/popularContent.ts)、[编译器](../../../src/utils/promptCompiler.ts)、[profile](../../../data/presets.json)、[工作流](../../../runtime-rs/src/images/workflow.rs)、[工程契约](../../engineering-contracts.md)、[技能交付要求](../../../.agents/skills/studio-prompt-craft/references/delivery.md)。
