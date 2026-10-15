# Anima：数据标签与模型输入分开

先确认 checkpoint。MiaoMiao 1.6 的版本配方查 [作者版本说明与项目差异](miaomiao-v16.md)；Base、Aesthetic、Yume 和其他版本不能继承其默认词与参数。

项目源数据可以保留下划线标签；最终普通标签由 `formatPromptForEngine` 转成空格。`score_N`、注册 exact tokens / prefixes 和 LoRA 控制词按编译器保护，不能全局替换下划线。

2026-10-15 核查 [Anima 官方模型卡](https://huggingface.co/circlestone-labs/Anima#prompting)：支持标签、自然语言及混合输入；普通标签优先 Gelbooru 的差异写法，模型训练使用随机标签丢弃，不必列全所有细节。自然语言只补标签难以表达的动作、接触与空间关系。

普通标签用英文、小写、空格分词和英文逗号；源数据兼容下划线不代表完整句子应写成一个长标签。角色用名字、作品与鲜明外貌特征即可，衣装保留主特征，未指定细节由模型补全；不按固定字数/标签数截断。专名与 exact tokens 不随普通标签规则改写。站点拼写有差异才核对 Gelbooru，不把空格转换宣称为已完成站点词义校对。

画师名沿用 Danbooru 名称并加 `@`，例如 `@ask \(askzy\)`；角色/作品名称中的字面括号同样转义，`(tag:1.2)` 权重括号保留。推荐顺序是质量/分级、人数/角色、作品、可选画师、普通标签，再补必要关系句；各段内部不机械排序。

人物与环境叙事优先按 [构图参考](narrative-composition.md) 建立可见关系，再核对关系是否保留在最终标签和描述中，不靠通用“完成度”尾句替代具体构图。

当前项目的 Anima 风格与光效按 [工程契约](../../../../docs/engineering-contracts.md#模块边界)处理：未选风格不强制平涂、线稿或饱和度；画师可选。显式 `animaCaption` / 热门 `sceneProse` 保留关键画面关系，导演控制继续生效；不再把 `subjectProse` 和 `outfitProse` 全文重复追加到已有标签后。关系本身清楚即可，不要求逐一描写受光面、投影和反光。

- 质量词以目标 checkpoint 的依据及实际 profile 为准。MiaoMiao 1.6 作者推荐包含评分词，不能被通用“不加评分词”误删；其他模型不能反向套用。`strip_quality_tokens` 启用时不能靠反复手填补回，应先核对其是否属于所选模型的契约。不要套用 Pony 的 `_up` 系列。
- 权重是节点/解析器与 checkpoint 的联合行为，不把 `1.5` 写成模型极限。默认保持已有已验证值；要调整就单变量实测，检查括号与精确词保护。
- 负向从最终调用链核对：`renderPromptPlan` 的 Anima 返回空负向，上层 `assembleNegative` 仍组装 profile 基础、场景明确排除项及分级词。Anima 不继承 SD 的通用手部/边框模板，热门路径不再默认叠加分屏/克隆长串；新增针对实际问题的负面应能保留。
- 针对实际失败补负向，先排查正向矛盾。要求全身时避免裁切，要求头像时不要机械加入 `cropped`；负向不保证修好手部。
- 自由输入 `visualDescription` 当前经 `plainEnglish` 的 ASCII 门控；这属于项目实现限制，不能写成官方模型不理解中文的结论。工作室明确的 `animaCaption` 优先于自动 caption，自动路径只保留部分动作/环境；热门路径读取 `sceneProse`。关系写进真实生效的字段，并在最终请求中确认，尤其核对旧 caption 与新镜头/服装的冲突。

## 精简负面基础

当前项目按用户选择采用官方 Anima 基础词表：

```text
worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration
```

Aesthetic 不加评分词；MiaoMiao 1.6 作者原配方与当前项目选择的差异见[版本参考](miaomiao-v16.md)。场景不重复粘贴基础词，按需要补 `text, watermark, signature` 或实际缺陷词；没有问题不预先堆叠几十项。标准 CFG=1 路径没有通常 CFG 的负面引导作用，Turbo 应先把正向写清楚，不将其他节点的 NegPiP 能力当作项目已支持功能。
