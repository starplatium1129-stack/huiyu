# MiaoMiao Harem Anima 1.6

适用于 `anima-miaomiao-v1.6` / `miaomiaoHarem_anima16.safetensors`。这是 checkpoint 专属写作参考，不自动修改生产配置，也不适用于 1.2、Anime Coloring 或 Anima Aesthetic。

## 一手依据与版本优先级

2026-10-05 核查了 [MiaoKa 在 SeaArt 的原创发布页](https://www.seaart.ai/pt/models/detail/d88ps7de878c738fimi0)及其链接的 [MIAOKA 作者账户](https://www.seaart.ai/pt/user/MIAOKA)。该页选中 1.6，底部版本介绍给出其专属参数与正/负向建议；页面主体仍保留 V1.0 的通用介绍和旧配方，冲突时采用选中版本的说明。

[Civitai 1.6 发布入口](https://civitai.com/models/934764?modelVersionId=3248362)来自项目模型登记，本次页面和版本 API 未能读取；不声称已核验 Civitai 全文。不以转载站、其他用户返图或 Base 模型卡替代作者的版本规则。

作者通用说明允许标签、自然语言及混合输入，普通标签宜小写并用空格；评分标签保留下划线。自然语言可用于衣装、构图、氛围和事件关系，纯标签并非唯一正确写法。来源：[作者发布页的提示词建议](https://www.seaart.ai/pt/models/detail/d88ps7de878c738fimi0)。

## 1.6 作者建议

版本说明的词表（去掉占位符和多余逗号）：

```text
positive: best quality, score_7, score_9, sensitive, very aesthetic, ultra detailed, fair skin, high contrast
negative: worst quality, low quality, score_1, score_2, score_3, artist name, shiny skin
```

采样起点为 Euler 或 Euler ancestral，搭配 normal 调度器；30 步，CFG 4.0–5.0。页面将采样器与调度器合写在 Scheduler 一项；对应本地网关字段分别核对 `sampler` 与 `scheduler`，不要把整段展示文字当作一个 API 值。来源：[1.6 版本介绍](https://www.seaart.ai/pt/models/detail/d88ps7de878c738fimi0)。

这些是作者推荐起点，不能承诺所有题材和 seed 的效果，也不能从页中其他版本的尺寸或放大图推断 1.6 唯一有效的分辨率。

## 按画面取舍

- 质量/评分词属于模型层；正式写入 profile 时去重，场景正文不重复粘贴整段前缀。不把旧版本的其他质量词或风格触发词混入后称为“1.6 官方默认”。
- 分级词按场景实际评级选择，不能让作者示例的默认分级覆盖全年龄场景，也不能同时出现互相冲突的分级。是否可绘制成年题材仍由项目宿主与角色资格决定。
- 默认肤色词具有画面含义：保留角色原有肤色，不能用于改白深色肤色角色。对比度、细节强度同样按目标画风取舍；柔和低对比画面可以偏离作者示例，并说明原因。
- 负向按作者基础、现有项目必需项与场景实际排除项核对。镜头需要文字、留白、分格或指定材质时，指出与通用负向的冲突；不要手填重复长模板，也不要未经授权取消项目保护。镜面/潮湿/光泽材质可能受皮肤去光泽词影响，是否影响需实际画面判定。
- 精确角色/LoRA 触发词保持原样；画师词和 LoRA 的效果依赖此 checkpoint，不能假定与 Base 完全相同。

## 项目当前差异（源码核查，2026-10-05）

[`data/presets.json`](../../../../data/presets.json) 的 `anima_miaomiao_v16` 已采用作者推荐的质量与两项评分词，场景不重复粘贴整段前缀。分级由评级字段提供，浅肤色与高对比按人物及画面实际选择，避免模型层覆盖深色肤色或柔和场景。基础负向采用作者版本词表，解剖、分级保护和逐条场景排除项由现有上层装配、去重。

2026-10-05 的采样迁移已将该 profile 和网关主采样统一为 `euler/normal`、30 步、CFG 4.5，默认画幅仍为 832×1216。扩散高清阶段采用同一采样组合，步数沿用现有二次采样策略。后续本机 MiaoMiao 1.6/SageAttention 同输入对照将 TeaCache 默认阈值调为 0.10，起止比例仍为 0–1；用户接受同种子重画，同时要求保留人物结构和画面丰富度。[缓存节点作者的 Euler 保守建议](https://github.com/CocyNoric/ComfyUI-Anima-TeaCache#recommended-settings)仍为 0.05；本机档位不属于 MiaoMiao 作者配方，效果按实际输入确认。评级由 `rating_all/rating_r15/rating_r18` 分开处理，这个边界应保留。

完整负向还由 [`assembleNegative`](../../../../src/utils/promptPolicy.ts) 追加解剖、文字、边框与分级保护。数据字段的 negative、底层渲染返回值与最终发送的 negative 是不同层次；报告必须标清检查的是哪一层。

## 写作示例（原创草稿，未编译/未出图）

下例仅展示画面正文。质量层由目标 1.6 profile 单独管理，负向沿用基础建议和必要项目项，不在场景中重复嵌入。

```text
safe, 1girl, solo, silver hair, amber eyes, blue cardigan, long skirt, sitting, writing, notebook, window light, medium shot
An adult woman sits at a desk beside a window. Her right hand writes in an open notebook while her left hand holds the page flat. Frame her from the waist up with the notebook visible along the lower edge. Soft daylight enters from the left and casts gentle shadows across the desk.
```

标签负责人物和画面元素，句子负责左右手、纸张接触、可见范围和入光方向。这是本项目的组织建议，不是官方强制顺序或长度配额。已有角色必须换成内容库中的真实身份与衣装；不能把此示例模板批量套入全部场景。

审查时分别记录官方建议、当前 profile 和候选正文。确认关键动作及空间关系进入最终请求后，再按任务实际授权决定是否出图；仅维护此 skill 不启动生成或全库重写。
