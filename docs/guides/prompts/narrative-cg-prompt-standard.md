# 人物与环境融合的叙事 CG 提示词规范

## 适用范围

面向 Anima 与项目本地 Krea 2 的全年龄图像创作，重点是人物参与环境的单幅叙事 CG。它是写作与审核规范，不是采样参数预设，也不承诺每张输出达到同一审美水平。

同等关注的单人物立绘／特写壁纸见 [壁纸规范](character-wallpaper-prompt-standard.md)。两种目标分别写作与评分，不强制壁纸增加故事事件或复杂环境。

规则依据及来源分级见 [研究来源与采用边界](../../research/README.md)。模型语法按官方能力与当前编译实现核对；下文的构图方法、案例和实验数量属于项目创作建议，尚未通过本地 checkpoint 成对出图验证。既有角色身份、衣装、分级、定稿和用户明确意图优先。

## 一、先写画面简报

起笔前明确以下问题。允许根据题材省略不适用项，不把表格机械填满后直接拼接进模型。

| 需要决定的事 | 应形成的可见信息 | 应避免的替代写法 |
| --- | --- | --- |
| 这一刻发生什么 | 谁正对哪个对象做什么，动作处于哪个瞬间 | 只有“温馨”“宿命感” |
| 第一眼看哪里 | 脸、手与道具、轮廓或人物与环境的关系 | 所有区域同时最亮、最锐、最详细 |
| 人物如何位于空间中 | 人物所在平面、支撑面、方向与关键物件位置 | 一串独立的人物和地点名词 |
| 环境为什么重要 | 能说明地点或事件的建筑／物件，以及与人物的关系 | 任意添加花瓣、灯光、星星填空 |
| 光从哪里来 | 主要可见光源、照到的面、必要的辅助光与反射 | 没有来源的全身轮廓光和多个矛盾时段 |
| 哪些细节应该清楚 | 动作接触点、关键地标、身份与衣装特征 | 同时要求浅景深和远处细节清晰 |
| 画面如何结束 | 合理取景边界、物件完整度、边缘与材质层级 | 无意义裁断、浮空道具、全部区域同等纹理 |

“一个主要叙事动作”是降低矛盾的起点，不是禁止次要动作。例如“收起雨伞并看向站牌”可以是同一瞬间；“站在门口、坐在椅上、走向远处”则应选择一幕。

## 二、构图与环境融合

### 1. 先定景别，再安排背景任务

- **环境叙事中景**：人物表情或手部动作需要读清，同时保留人物所处空间及关键道具。
- **环境叙事远景**：环境承担主要事件信息；人物可以较小，通过轮廓、颜色或明暗关系形成焦点。
- **特写**：保留与叙事有关的背景线索即可，不要求把整座建筑和街道都塞进画面。
- **全身图**：确认脚与支撑面、头顶／脚边空间及画幅一致；不要同时要求极近面部。

横幅或竖幅按人物动作方向、环境结构和交付用途决定。在项目当前支持的尺寸中选取，不把显示器 4K 分辨率等同于模型起始生成尺寸，也不为使用新比例擅自增加工作流能力。

### 2. 用关系组织空间

优先写清人物与关键对象的关系，例如“她站在长凳右端，把杯子放在空座位边缘”，而不只是“woman, bench, cup”。左右统一指画面坐标；人物身体左右在需要时明确区分。

前景、中景、背景按画面需要选择。前景可以用有来由的门框、桌沿或雨棚建立观看位置，但应保留脸与关键动作的可读性。背景可以留白、虚化或简化，只要不抹掉叙事必须识别的部分。

### 3. 把人物和环境接起来

检查四类联系：

- **接触**：脚／座位／手／道具的支撑关系。
- **光照**：人物、地面和附近物体受到可解释的光源影响。
- **运动**：风、雨、衣物和人物姿态方向相容。
- **叙事**：至少能指出某个环境细节为什么属于这一刻；不强制道具数量。

不要给每个题材都加水面反射、体积光、飘落花瓣和亮粒子。这些可以是具体场景的设计，但不能成为统一完成度模板。

### 4. 丰富度来自选择

先保留必须出现的对象与关系，再考虑次要层次和材质。角色身份、当前服装和主要动作不能为了增加背景内容而被稀释。天空、墙面和安静暗部可以承担留白，人物较小也不等于缺乏重点。

一个简单的复核办法：删除某个细节后，如果人物关系、地点或叙事均不受影响，且画面更清楚，就不必保留该细节。这个办法用于人工判断，不作为自动删除规则。

### 5. 完整度单独检查

构图通过后，再看衣物结构、人物轮廓、手与物件接触、地面承托、边缘遮挡、材质和阴影。锐化或超分不能自动修正这些关系，也不应让未通过构图的图进入“已定稿”。

## 三、分别写给两个引擎

### Anima

采用“模型／身份锚点＋必要标签＋关系描述”的可检查结构。它是建议的组织法，不是模型唯一接受的顺序。官方支持混合输入，具体语法依据见研究报告的 Anima 节。

1. 质量、分级、画师和精确触发词沿用当前 profile／角色配置，避免手工重复注入。
2. 标签描述人物、服装、道具、地点和取景。普通标签的空格／下划线转换交给现有 formatter；精确词原样保留。
3. 用当前有效描述字段说明位置、动作接触、光源和必要环境细节。通用场景可用已有 animaCaption，但必须与 prompt、导演镜头和尺寸一致；热门蓝图按现有 promptProse／promptTokens 及组装通道核对。
4. 同一关系只清楚表达一次，不用多层高权重反复喊同一概念。需要调权重时单独实验。
5. 负向只针对本次错误和意图，先检查正向冲突。特写不机械排斥所有裁切，多人画面不混入排斥第二人的负向。

不能仅因为上游 Base 推荐某组质量词，就覆盖 MiaoMiao／Aesthetic 的现有 profile。本轮没有验证新的默认质量词、权重、画师配方或参数。

### Krea 2

项目输出使用连贯英文描述。建议先给媒介与事件，再把人物、动作、空间和光照连接起来；顺序可以服务实际画面，不强制每次使用同一段落模板。

- 让属性与所属人物相邻，物件与动作相邻，避免长距离含糊代词。
- 媒介描述覆盖人物和环境；若需要统一手绘效果，应表达为整幅画面的风格，而不仅是人物的皮肤或轮廓。
- 写出可见事实，删除重复赞美。详细不等于越长越好，尤其不要同时给出互相竞争的取景和材质。
- 当前本地负向为空，排除项优先改写成所需状态，例如人物数量、衣装完整和场所空位。不要为加负向而修改 CFG。
- 托管扩写、风格参考、编辑和本地 txt2img 分开；不能假设当前工作流自动补全简略构图。
- 画面文字仅在需要时明确写出，文字原文加引号。不要在不需要文字时为丰富背景添加标签、说明牌或对白。

### 多人和跨风格边界

先确认项目 profile、构图意图和分级允许目标人数。允许多人时分别绑定人物外貌、位置、衣装、动作和接触对象，检查编译结果没有残留单人词或不适用的 She／Her 句式。不要复制单人模板再把人数改为 2。

纯背景、剪影远景、漫画分格和特写各自有目标。不能把“主体突出、分层背景、cinematic、无人物、无裁切”等要求同时作为所有模式的默认尾句。需要跨风格时先确定共有画面结构，再改变媒介；不把整个示例的服装和道具一起带过去。

## 四、三个原创候选案例

下列英文为**写作示例，未编译、未出图、未审核**。人物为原创成年女性，均为全年龄内容；不使用生产场景 ID，不作为角色身份、LoRA 或参数配方。Anima 示例不含项目 profile 自动添加的质量／分级前缀；Krea 示例不代表复制到任一生产字段后会原样成为完整请求。

### A：雨夜候车——道具让等待变得可见

简报：一位成年女性在雨棚下为尚未到场的人留下一杯热饮。画面只有她一人，长凳空位需要可读；环境为她的动作提供原因。主要焦点是她的手、杯子与期待的目光。第一轮比较不改变人物、服装、物件数量、画幅和光源。

Anima 候选：

```text
1girl, solo, adult woman, black bob hair, amber eyes, navy coat, cream scarf, bus stop, bench, paper cup, rain, wet pavement, evening, medium shot, three-quarter view, anime illustration
An adult woman stands at the right end of a sheltered bench, placing a paper cup beside a second cup already on the seat. She looks toward the empty seat with a restrained, expectant smile. The bench extends into the left side of the picture. Rain falls beyond the shelter, and the wet road leads toward a quiet row of shops. A warm lamp under the shelter lights her face, hands and the cups; cool evening light remains outside. Keep the empty seat and cup placement readable, with the distant storefronts less detailed than the foreground action.
```

Krea 2 候选：

```text
A hand-drawn anime narrative illustration of an adult woman waiting at a rain-soaked bus stop in the evening. She has a black bob, amber eyes, a navy coat and a cream scarf. Standing at the right end of a sheltered bench, she places a paper cup beside another cup already on the seat, then looks toward the empty seat with a restrained, expectant smile. She is the only person visible. The bench extends to the left, leaving the empty place readable. Beyond the shelter, the wet road recedes toward quiet shops. A warm overhead lamp lights her face, hands and both cups, while cool evening light colors the road. Use clear character linework and restrained painted backgrounds, preserving the contact between the cup and the seat and the spatial connection between the shelter and street.
```

审核重点：两个杯子是否各自落在合理位置；单人限制是否保持；空位是否被人物或杂物填满；暖光是否照到同一组相邻对象。若动作失败，优先简化杯子接触的表达，不同时加入雨伞、行李和车辆动作。

### B：修理风铃——人物动作与室内空间一致

简报：成年工匠在窗边检查刚修好的风铃。风铃、手和工作台是主要信息，房间工具只作环境线索。希望看出空间深度，但不把所有工具画得一样锐利。

Anima 候选：

```text
1girl, solo, adult woman, chestnut hair, tied hair, green apron, long sleeves, workshop, wooden workbench, wind chime, window light, medium shot, side view, anime illustration
An adult craftswoman stands to the left of a wooden workbench and holds a repaired wind chime by its top loop above the table. Her free hand rests on the table as she watches the hanging pieces settle. The workbench runs diagonally from the lower right toward her hands. A small pair of pliers and a short coil of cord lie near the repair area; shelves farther back are simplified. Daylight from the window on the right lights the chime and the same side of her face, with a soft shadow on the workbench. Keep the hanging parts separated and the hand-to-loop contact visible.
```

Krea 2 候选：

```text
A quiet anime illustration set in a small repair workshop. An adult craftswoman with tied chestnut hair wears a green apron over a long-sleeved shirt. She stands to the left of a wooden workbench, holding a repaired wind chime by its top loop above the surface while her other hand rests on the table. Her gaze follows the hanging pieces as they settle. The workbench forms a diagonal from the lower right toward her hands, where a pair of pliers and a short coil of cord explain the work just completed. Daylight enters from a window on the right and reaches both the chime and her face; the table carries their soft shadows. Draw the figure and room in compatible hand-painted anime colors, with the repair area clearly articulated and the distant shelves quieter.
```

审核重点：主光方向、手的任务分配、风铃悬挂关系、工作台透视。若背景压过动作，先降低远处工具的细节描述；不直接把背景全部虚化成无法辨认的色块。

### C：海边归航——人物较小也可以有重点

简报：成年女性站在码头上看一艘归来的船。人物与船的关系就是事件，环境需要留出距离。焦点通过衣物颜色与码头方向建立，而不是要求人物占固定比例。

Anima 候选：

```text
1girl, solo, adult woman, short dark hair, red raincoat, boots, harbor, pier, fishing boat, overcast sky, sea, wide shot, back view, anime landscape illustration
An adult woman in a red raincoat stands on the left side of a wooden pier, seen from behind, watching a small fishing boat approach the harbor entrance in the distance. Both boots rest on the boards and one hand touches the railing. The pier narrows toward the approaching boat, leaving a broad area of quiet gray-green water between them. Wind pushes the edge of her coat in the same direction as the ripples. Soft overcast light belongs to the whole scene, and the red coat provides a clear accent against the restrained sea and sky. Keep the boat recognizable without making the distant rigging compete with the figure.
```

Krea 2 候选：

```text
A wide hand-painted anime scene of a quiet harbor under an overcast sky. An adult woman with short dark hair stands on the left side of a wooden pier, seen from behind in a red raincoat and boots. Both feet are supported by the boards and one hand rests on the railing. She watches a small fishing boat returning through the distant harbor entrance. The pier narrows in the direction of the boat, connecting her position to it across an open stretch of gray-green water. Wind moves her coat edge in the direction suggested by the ripples. Use soft shared daylight and restrained background detail, with the red coat as a distinct color accent. The open water should preserve the distance and quiet anticipation between the figure and the arriving boat.
```

审核重点：人物能否迅速辨认、船是否可识别、码头是否连接到合理空间、风向是否一致。人物不必转身看镜头，不因“看不到脸”就判定构图失败。

### 补充边界案例

双人互动可以选择两位成年人物隔着工坊桌共同检查同一件物品，分别指定画面左右和各自手的任务。先验证人数、属性归属和接触，再评价氛围。当前单人生成路径是否支持这种目标必须先核对，不能仅通过更换人数标签绕过能力或内容约束。

情绪特写可以保留窗边冷光和手中的信封作为线索，不需要完整三层大环境。只要关键事件可读，安静背景就是合理选择，不能因为物件数量少而机械扣分。

## 五、落入项目字段时的检查

1. 从当前角色与服装源读取身份，不把原创案例的外貌或衣装写入已有角色。
2. 将场景事件映射到 promptTokens／promptProse 或通用场景已有 prompt／animaCaption；不新造 schema 字段。
3. 使用已有镜头、光照与尺寸字段表达可结构化的部分；字段与散文表达同一决定。
4. 保留原始画面简报，并查看**完整最终 positive、negative 和 workflow**。标记关键关系是否仍在、是否重复、是否被自动默认值反向覆盖。
5. 对 Anima，检查自动 caption 的短语筛选，但不能把 caption 层减少等同于标签层也丢失；对 Krea，检查自动身份句、风格前缀与代词归属。
6. 记录真实 tokenizer／编码节点信息；若只有字符数、标签计数或近似估算，应明确标注，不把它们称为模型 token 数。
7. 如果当前编译器无法表达必要关系，记录复现与最终请求差异。编译器修复另行实现并按项目要求出图验收，不能只靠规范掩盖。

## 六、主力机对照实验

### 第一步：小样筛查

从 A／B／C 或对应的已授权全年龄候选中选一个场景，按现有规则使用同一组 3 个固定 seeds。只比较一个因素，例如基准描述与增加明确接触／位置关系后的版本。先运行一个实际 checkpoint，发现明显失败就停止扩批并修正假设。

### 第二步：多场景验证

确认可用方向后，建议对 A／B／C 分别使用 8 个固定 seeds，比较基准与候选两种写法：每个 checkpoint 为 `3 × 8 × 2 = 48` 张。Anima 与 Krea 分别评价；若再加入 MiaoMiao 另一个版本，单独增加实验组。这是预算起点，不是统计充分性的保证，也不自动启动生成。

同编号 seed 只用于同一模型、同一尺寸和流程内的配对比较，不代表不同模型输出可逐像素或等构图比较。改变分辨率、编码器、LoRA、采样器、增强器等时另建组。

### 建议比较因素

| 实验 | 唯一主要变化 | 其余条件 |
| --- | --- | --- |
| 标签与关系描述 | 增加人物／道具接触及空间描述 | 冻结风格、人物、物件、画幅、参数 |
| 环境细节层级 | 保留同一组物件，明确主次清晰度 | 不顺带增加更多装饰 |
| 景别与叙事 | 在相同画幅内改变取景描述 | 另组测试，不与上一实验混合 |
| 风格归属 | 明确媒介作用于整幅场景 | 维持事件、空间与光照 |
| 扩写强度 | 基准与轻量润色；不更换事件 | 不假装具有托管 creativity 参数 |

### 逐图评审

先逐项判断人数、身份／衣装、核心动作／物件、支撑与接触、取景及分级。再对下列维度作 0–3 的内部记录：焦点可读性、人物环境融合、空间连贯性、细节主次、叙事表达、风格／完成度。评分是项目内部量表，不是客观审美标准。

建议把基准与候选随机摆放，记录胜／平／负及理由，保留所有失败图。自动 VLM 可协助标记，但手部接触、细小结构与审美仍需实际查看。若可行，由第二位审阅者独立复核争议样本；不以一个总分掩盖必需条件失败。

交付记录至少包括：候选 ID、版本、模型与权重标识、profile、LoRA、正负向、实际尺寸、seed、采样与加速设置、编码器／增强节点、输出文件、硬条件结果、分项评价及异常。生成失败、生成成功未审、审核不通过和通过必须分开。

### 升级为默认建议的条件

候选在不同场景和多个 seeds 上表现稳定，关键约束没有退化，失败案例已解释，才考虑成为该 checkpoint 的默认写法。否则保留为特定题材技巧。不得用选出的最好一张推断“每次都惊艳”。

## 七、日常交付清单

- 画面简报能说清一个可见事件，关键人物与环境关系明确。
- 两种引擎按需分别表达，身份和服装来自实际数据。
- 无人物数量、景别、光照、衣装及正负向冲突。
- 只有与故事有关的细节被强调，留白与背景简化有明确目的。
- 最终请求已核对；未执行时如实写“未编译／未出图／待审核”。
- 生产数据修改和定稿仍遵循 [字段与交付](../../../.agents/skills/studio-prompt-craft/references/delivery.md)，本规范不改变授权、分级或真实出图要求。

## 来源与状态

模型资料入口和未执行实验的参数冻结要求统一保存在[研究来源与采用边界](../../research/README.md)，不维护第二份参数表。上文案例为本项目原创说明，没有复制官方示例；原 2026-09-13 检查点尚无本地真实出图结果，本次整理未增加模型验收。后续按明确算力范围进行固定流程对照，研究草案不是执行器或生产 ID 清单。
