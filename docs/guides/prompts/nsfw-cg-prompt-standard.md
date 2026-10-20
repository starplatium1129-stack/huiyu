# 成年角色分级与既有内容一致性

用于既有成人向场景、蓝图及其编译字段的中性审查与修复。创作范围遵循 [studio-prompt-craft](../../../.agents/skills/studio-prompt-craft/SKILL.md)，本页不提供露骨描写扩写配方，也不扩展模型调用授权。

## 分级与身份

- 项目成年创作设定、原作资料与当前正文分开核对。正文中的明确年龄矛盾单独处理；分级词和负向排除词都不能代替成年依据。
- `adult`、`rating`、`mature` 等字段用于各自记录的分级和展示，不按本机、远程、内容开关或旧成年资格字段门控。目录缩略图与用户作品册的展示边界统一见 [AGENTS.md](../../../AGENTS.md#质量红线)。
- 角色身份沿用真实 ID、已核验名字/作品和辨识特征。不要凭历史文档给身份添加不存在的年龄前缀、改名或臆造角色属性；实际身份处理以当前 `popularPromptBuilder` 和最终编译输出为准。

## 衣装、动作与场景

- 保留原条目的穿着状态和叙事功能，不因分级把穿衣改成裸体，也不把已有裸体内容统一改成穿衣。衣装名称、`outfitId`、中文描述与实际生效正文应一致。
- 当前热门成人蓝图不自动注入绑定衣装的 tokens/prose；已有服饰关系须在实际消费的场景字段中保留。不能只改 `outfitId` 后宣称完成换装，也不能把所有成人蓝图都写成相同穿着状态。
- `promptTokens` / `promptProse` 与可选的 `nsfwTokens` / `nsfwProse` 共同参与既有编译路径，不要求重复填满两套字段。后两者是否参与由当前分支决定；最终请求才是消费依据。
- 检查主体数量、每只手的占用、物件接触、画内/画外关系和当前瞬间。移除矛盾时保留原事件；多人分别绑定身份与衣装，不能把同伴的衣服或发色合到主角身上。
- 地点、天气、时段和光源须在描述、标签与散文中一致。主光、补光、环境反射按场景实际关系区分，不为“层次”统一追加灯笼、月光、轮廓光或体积光。具体规则见 [构图参考](../../../.agents/skills/studio-prompt-craft/references/narrative-composition.md)。

## 模型与最终编译

- Anima 普通标签优先 Gelbooru，画师使用 Danbooru 名称；格式、精确词保护与六段顺序统一见 [Anima 参考](../../../.agents/skills/studio-prompt-craft/references/anima.md)。成人分支不另建竞争的标签排序规范。
- 质量与负向由目标 checkpoint 的 profile 和本条明确排除项共同决定。MiaoMiao 1.6 遵循 [版本配方](../../../.agents/skills/studio-prompt-craft/references/miaomiao-v16.md)，不根据评级元数据自动增删正负向词，不自动补手部、解剖或年龄长模板。
- 对负向词按本条画面判断是否冲突，不按词表机械删除。例如已穿衣的场景不能默认排斥所有衣服；镜面、多人、文字或分格也应保留各自意图。负向词不能保证修好结构。
- 本地 Krea 2 使用英文自然语言，负向为空；具体消费和能力边界见 [Krea 参考](../../../.agents/skills/studio-prompt-craft/references/krea.md)。不把“首句权重最高”等未经对应模型核验的经验写成通用契约。
- 核对实际发送内容，确认身份、衣装、导演设置和空间关系没有被旧字段覆盖。源码行为、编译结果与真实画面分别说明。

## 保存与交付

人物、衣装、场景与蓝图以运行目录 `content/catalog.sqlite` 为工作权威，通过记录 API 或 `content:catalog` 预览和保存，之后显式导出 `data/catalog/`。旧 `data/blueprints/` 分片只作升级来源，不直接回写。

批量按真实记录逐条审查，定稿字段保留单条处理边界，具体流程见 [字段与交付](../../../.agents/skills/studio-prompt-craft/references/delivery.md)和[内容维护](../../maintenance.md#迁移与保护)。验收按当前用户授权执行；未出图只能说明源码、内容或编译检查结果，不标记画质通过。
