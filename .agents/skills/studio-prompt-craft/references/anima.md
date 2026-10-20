# Anima：数据标签与模型输入分开

先确认 checkpoint。MiaoMiao 1.6 的版本配方查 [作者版本说明与项目差异](miaomiao-v16.md)；Base、Aesthetic、Yume 和其他版本不能继承其默认词与参数。

## 标签与六段顺序

项目源数据可以保留下划线标签；最终普通标签由 `formatPromptForEngine` 转成空格。`score_N`、注册 exact tokens / prefixes 和 LoRA 控制词按编译器保护，不能全局替换下划线。

2026-10-15 核查 [Anima 官方模型卡](https://huggingface.co/circlestone-labs/Anima#prompting)：支持标签、自然语言及混合输入；普通标签优先 Gelbooru 的差异写法，模型训练使用随机标签丢弃，不必列全所有细节。自然语言只补标签难以表达的动作、接触与空间关系。

普通标签用英文、小写、空格分词和英文逗号；源数据兼容下划线不代表完整句子应写成一个长标签。角色用名字、作品与鲜明外貌特征即可，衣装保留主特征，未指定细节由模型补全；不按固定字数/标签数截断。专名与 exact tokens 不随普通标签规则改写。站点拼写有差异才核对 Gelbooru，不把空格转换宣称为已完成站点词义校对。

画师名沿用 Danbooru 名称并加 `@`，例如 `@ask \(askzy\)`；角色/作品名称中的字面括号同样转义，`(tag:1.2)` 权重括号保留。项目最终发送固定为六段：**质量/分级 → 人数/角色名 → 作品 → 可选画师 → 普通标签 → 自然语言**。普通标签包含鲜明外貌、当前服装、动作、环境、风格与导演控制；服装不随角色名提前，作品不夹在外貌里。自然语言独立放在末尾换行；没有选择画师时直接省略画师段，各段内部不机械排序。

## 分类与编译消费

Anima/Krea 完整编译统一调用 [`compilePromptRecipe`](../../../../src/utils/promptRecipe.ts)，通过 `kind: 'studio' | 'popular' | 'free'` 选择内容来源；工作台、批量和维护预览传入同一角色、衣装、场景、profile、LoRA 与导演上下文。内容 builder 解析来源和覆盖关系，公共 `createPromptPlan` 建立计划，`renderPromptPlan` 分派 Anima 标签与 Krea 自然语言表达；这些内部层不替代完整入口。编译后的完整 prompt 不再拼接画师、人数或普通标签，也不拆回字符串重新猜测计划。

角色名和作品通过 `characterTokens` / `copyrightTokens` 显式分类；前者只识别已输入的名字/别名，不把所有别名自动补到正文，后者提供独立作品段。热门角色从内容库读取这两个字段，内置角色使用 `STUDIO_PROMPT_SUBJECTS`；`franchise` 只供展示，不能将厂商分组或英文展示名猜成版权标签。角色与作品同名时分别登记经核验的标签，名称括号中的文字不代替独立作品字段。身份词在最终标签流去重，不按预设黑名单先删场景特征：默认身份可能没有提供该条所需的长度、数量或配饰。画外手、前臂与接受者关系不因含有 `male` 等词就判为额外可见人物。

图片反推同样保留类别再编译：PixAI 的 `characterTags` / `copyrightTags` 分别进入角色与作品段；依据[固定 v1.0 词表](https://huggingface.co/pixai-labs/pixai-tagger-v1.0/blob/9fe10addf9326e292da8a85a98ea74cd91b41771/config.json)，项目将专门的 `styleTags` 映射为 `@画师名称`，不受 UI 推荐画师目录限制。这是固定版本的工程映射，官方类别仍名为 style；一般视觉风格仍是普通标签，不从 `artist name` 等通用词猜画师。自由主题采用识别结果并保存分类，质量由当前 profile 提供，分级采用反推最高置信度标签；没有作品结果时，只用内容库明确对应关系补全。套用已有角色时保持目标身份与作品，只迁移服装、动作、环境和画师，用户显式选择的画师优先。草稿、蓝图导入与撤销须保留分类；删除反推标签时同步删除其分类，不能在编译时重新注入。标签派生的 `captionDerived` 不冒充自然语言重复追加；真实画面描述仍单独放末尾。

人物与环境叙事优先按 [构图参考](narrative-composition.md) 建立可见关系，再核对关系是否保留在最终标签和描述中，不靠通用“完成度”尾句替代具体构图。自然语言可保留完整句子和场景特有的光影、神态，让读者想象出同一瞬间；精简不等于删掉接受者、视角、接触与位置。原生动作标签可与补充接触关系的句子并存，不因同一句中出现物件就删掉对应标签。绑定衣装与蓝图共同审查语义重复，确定各使用路径都会注入衣装后，场景才省去重复清单；成人分支等未注入衣装的路径仍须保留本条所需衣装特征。LoRA 训练包是条件注入，不能当作无 LoRA 或其他引擎的衣装来源；源层保留必要结构，最终输入合并相同词条。

编译时按景别、俯仰角与朝向分别消解镜头标签，同一画面只保留当前景别，兼容机位可以并存。导演选择通过 `directorSources` 逐项记录 `scene`（场景继承）或 `manual`（用户选择，包括主动清空），已有来源时不能仅凭当前值与默认值相等判为继承；缺少来源的旧记录才走兼容推断，草稿、历史与批量保留来源。手动标签和主动更改的导演选项优先；自动继承的宽泛选项不能把 `full body` 或 `cowboy shot` 改成 `wide shot` 或 `medium shot`。保留 camera 字段的兼容维度，分格与 BREAK 的独立画面分别判断。正文已有的可识别镜头只在相同维度替换，不能用 `low angle` 覆盖 `medium shot`，前／后三分之四视点也不能只剩“三分之四”。导演标签已经发送时不再补 `Frame it / Light it` 模板句；默认光照未被更改时保留手写的具体光影关系，不能把台灯与窗外月光全部改成同一光源，也不能将 `after sunset` 或 `blue dusk` 等时段／环境色误推成黄金时刻主光。语义去重与场景修正依赖逐条内容审查，不把自动删除词语当成全库精修。

当前项目的 Anima 风格与光效按 [工程契约](../../../../docs/engineering-contracts.md#模块边界)处理：未选风格不强制平涂、线稿或饱和度；画师可选。显式 `animaCaption` / 热门 `sceneProse` 保留关键画面关系，导演控制继续生效；不再把 `subjectProse` 和 `outfitProse` 全文重复追加到已有标签后。关系本身清楚即可，不要求逐一描写受光面、投影和反光。

- 质量词以目标 checkpoint 的依据及实际 profile 为准。MiaoMiao 1.6 作者推荐包含评分词，不能被通用“不加评分词”误删；其他模型不能反向套用。`strip_quality_tokens` 启用时不能靠反复手填补回，应先核对其是否属于所选模型的契约。不要套用 Pony 的 `_up` 系列。
- 权重是节点/解析器与 checkpoint 的联合行为，不把 `1.5` 写成模型极限。默认保持已有已验证值；要调整就单变量实测，检查括号与精确词保护。
- 负向以 `compilePromptRecipe` 返回的完整结果为准：`renderPromptPlan` 的 Anima 空负向只是渲染层结果，场景与热门 builder 通过 `assembleNegative` 合并 profile 基础与场景明确排除项，自由主题保留其用户和 profile 负面契约；调用方不再自行补拼。是否按评级追加词取决于 profile，MiaoMiao 1.6 不追加。Anima 不继承 SD 的通用手部/边框模板，热门路径不再默认叠加分屏/克隆长串；新增针对实际问题的负面应能保留。
- 针对实际失败补负向，先排查正向矛盾。要求全身时避免裁切，要求头像时不要机械加入 `cropped`；负向不保证修好手部。
- 自由输入 `visualDescription` 当前经 `plainEnglish` 的 ASCII 门控；这属于项目实现限制，不能写成官方模型不理解中文的结论。工作室读取明确的 `animaCaption`，热门路径读取 `sceneProse`，用户补充描述进入 `visualDescription`；未提供手写 caption 时不从标签重建动作、环境或光照模板散文。关系写进真实生效的字段，并在最终请求中确认，尤其核对旧 caption 与新镜头/服装的冲突。

## 精简负面基础

除 MiaoMiao 1.6 使用作者专属配方外，当前项目采用以下 Anima 基础词表：

```text
worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration
```

Aesthetic 不加评分词；MiaoMiao 1.6 的作者默认词及显式分级优先规则见[版本参考](miaomiao-v16.md)。场景不重复粘贴基础词，`text, watermark, signature`、`bad hands, extra fingers` 等只按实际需要追加，不堆叠手部、肢体、边框、克隆或人数同义词，且不能与所需文字、多人、分格或镜像冲突。标准 CFG=1 路径没有通常 CFG 的负面引导作用，Turbo 应先把正向写清楚，不将其他节点的 NegPiP 能力当作项目已支持功能。
