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
- 默认完整保留作者的 `sensitive`。场景正文、手动输入或采纳的反推标签已有分级词时，以这些显式词替换默认分级；不按场景评级字段另外生成正面分级或负面排除词。场景本身写入的正负向词继续合并，项目角色按成年创作设定处理。
- 作者默认包含 `fair skin, high contrast`，模型层按原配方提供。MiaoMiao 1.6 编译时，角色、用户输入或采纳的反推内容明确指定深色、晒黑或其他冲突肤色，就只移除模型默认的 `fair skin`；用户与角色原词不删改，没有冲突则保留作者完整配方。兼容的浅肤色及皮肤质感词不触发删除，其他模型不套用此规则。`high contrast` 仍按默认提供，需要柔和低对比时由用户显式调整。
- 基础负面采用作者原配方，包含 `shiny skin`；场景只加自身明确的排除项，不预先堆叠通用手部、边框或克隆词。需要文字、留白、分格或指定材质时，审查与所需画面冲突的负面。
- 精确角色/LoRA 触发词保持原样；画师词和 LoRA 的效果依赖此 checkpoint，不能假定与 Base 完全相同。

## 项目默认与组装边界

[`data/presets.json`](../../../../data/presets.json) 的 `anima_miaomiao_v16` 完整采用上面的作者正负向默认词，包含 `sensitive, fair skin, high contrast` 和负面的 `shiny skin`。`rating_mode: prompt` 表示分级只取提示词自身，不从评级元数据自动增删词。未选场景时只有模型默认与当前人物、用户输入；选场景后合并其实际内容。桌面旧预设加载时仅迁移已知历史默认正负向，保留自定义配方和其他参数；不宣称画质已经改善。

2026-10-05 的采样迁移已将该 profile 和网关主采样统一为 `euler/normal`、30 步、CFG 4.5，默认画幅仍为 832×1216。扩散高清阶段采用同一采样组合，步数沿用现有二次采样策略。后续本机 MiaoMiao 1.6/SageAttention 同输入对照将 TeaCache 默认阈值调为 0.10，起止比例仍为 0–1；用户接受同种子重画，同时要求保留人物结构和画面丰富度。[缓存节点作者的 Euler 保守建议](https://github.com/CocyNoric/ComfyUI-Anima-TeaCache#recommended-settings)仍为 0.05；本机档位不属于 MiaoMiao 作者配方，效果按实际输入确认。内容评级仍用于资料分类和缩略图展示，不等同于模型提示词。

[`assembleNegative`](../../../../src/utils/promptPolicy.ts) 为 1.6 合并作者基础负面与本条明确排除项，不按评级追加或删除词，不强制追加解剖、文字、边框模板；热门分支也不自动追加分屏/克隆长串。数据 negative、底层返回值与最终发送值须分开核对。

## 写作示例（原创草稿，未编译/未出图）

下例仅展示画面正文。质量层由目标 1.6 profile 单独管理，负向沿用基础建议和必要项目项，不在场景中重复嵌入。

```text
safe, 1girl, solo, silver hair, amber eyes, blue cardigan, long skirt, sitting, writing, notebook, window light, medium shot
She writes in the notebook while holding its page flat beside the window.
```

标签保留人物鲜明特征与关键元素，句子只补纸张接触关系，其余交给模型补全。已有角色须使用内容库真实身份与衣装；不能把此示例模板批量套入全部场景。

审查时分别记录官方建议、当前 profile 和候选正文。确认关键动作及空间关系进入最终请求后，再按任务实际授权决定是否出图；仅维护此 skill 不启动生成或全库重写。
