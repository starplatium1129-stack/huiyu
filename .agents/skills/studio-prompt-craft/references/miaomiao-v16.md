# MiaoMiao Harem Anima 1.6 专属配方

适用于 `anima-miaomiao-v1.6` / `miaomiaoHarem_anima16.safetensors`。

## 1. 作者一手推荐基准

根据作者 MiaoKa 发布规范，1.6 版本的推荐基础正负向为：

```text
positive: best quality, score_7, score_9, sensitive, very aesthetic, ultra detailed, fair skin, high contrast
negative: worst quality, low quality, score_1, score_2, score_3, artist name, shiny skin
```

- **推荐采样**：Euler 或 Euler ancestral，调度器 `normal`，步数 30，CFG 4.0–5.0。
- **项目落地档位**：本地网关与 profile 统一为 `euler/normal`、30 步、CFG 4.5；默认画幅 832×1216。

## 2. 字段合并与画面定制

- **质量词归属**：质量与评分词由模型层 profile 统一提供，场景正文不重复写入前缀。
- **分级处理**：
  - 默认保留作者的 `sensitive`。
  - 当场景正文、显式输入或反推标签包含明确分级词（如 `safe`, `nsfw`, `r18` 等）时，自动替换默认分级。
  - 项目支持全分级自由创作，自由调配 SFW 与各类 NSFW/R18 场景。
- **肤色与对比度适配**：
  - 作者默认包含 `fair skin, high contrast`。
  - 当角色或场景明确指定深色肤色、晒黑等不同特征时，编译时仅移除 `fair skin`，保留用户与角色原词；无冲突时保留完整配方。
- **负面词合并**：
  - 基础负向采用作者原配方（含 `shiny skin`）。
  - 场景仅添加自身明确需要的针对性排除项，不堆叠通用手部/肢体/边框模板。

## 3. 编写示例

```text
safe, 1girl, solo, silver hair, amber eyes, blue cardigan, long skirt, sitting, writing, notebook, window light, medium shot
She writes in the notebook while holding its page flat beside the window.
```

- 标签层明确核心外貌、衣装、动作、道具与光影。
- 描述句精简补充接触或动态细节。
- 质量与负面均由 profile 自动装配，无需在场景正文中冗余粘贴。
