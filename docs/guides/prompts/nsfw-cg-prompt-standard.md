# NSFW 与全分级 CG 提示词规范

本项目全面支持全分级自由创作，包括全年龄（SFW）、敏感向（Sensitive）及各类露骨／成人向（NSFW／R18）场景与蓝图。创作者可自由选择分级与表现手法，平台不设任何限制。

## 1. 分级与展示原则

- **自由开放**：创作内容自由选择分级，不设门控或审查拦截。
- **元数据与展示**：`adult`、`rating`、`mature` 字段用于声明记录属性与展示偏好；目录缩略图保留 R18 默认模糊遮罩，用户作品册与大图预览直接展示无遮罩。
- **身份一致性**：角色身份采用真实 ID、标准角色名与作品名，不添加冗余的前缀修饰；按实际配置精准编译。

## 2. 衣装、姿态与画面设计

- **着装与裸露状态真实表达**：
  - 穿衣场景完整保留衣装细节与剪裁特征。
  - 局部解衣、内衣、泳装或完全裸露（如 `lingerie`, `nude`, `bare_shoulders`, `open_shirt` 等）依创作者意图准确编写，不含糊其辞或反向改动。
- **肢体动作与亲密互动**：
  - 明确主体数量、姿态体位、接触受力点以及关键视线方向。
  - 多人场景（`compositionIntent: group`）分别绑定各自主体的特征与服饰，防止特征串染。
- **字段协同**：
  - 蓝图中的 `promptTokens` / `promptProse` 承载核心动作与环境。
  - `nsfwTokens` / `nsfwProse` 用于承载专门的 NSFW 标签与生动散文描述，最终由编译器统一解析装配。

## 3. 编译与交付入口

- **精简负向原则**：仅使用对应底模推荐的基础负面并追加与当前画面明确冲突的排除项，绝不机械套用与裸露度、局部特写或多人构图目标冲突的通用排除词。
- **引擎编译语法与模型配方**：Anima 六段式、Krea 2 散文、MOSS 与负向细则统一见 [Studio Prompt Craft](../../../.agents/skills/studio-prompt-craft/SKILL.md)（含 [Anima 参考](../../../.agents/skills/studio-prompt-craft/references/anima.md) · [Krea 参考](../../../.agents/skills/studio-prompt-craft/references/krea.md)）。
- **仓储、字段核对与定稿保护**：统一见 [仓库写入与生成验收](../../../.agents/skills/studio-prompt-craft/references/delivery.md) 与 [项目内容维护手册](../../maintenance.md)。
