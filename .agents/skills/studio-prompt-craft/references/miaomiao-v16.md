# MiaoMiao Harem Anima 1.6 专属配方

适用于 `anima-miaomiao-v1.6` / `miaomiaoHarem_anima16.safetensors`。

## 1. 基础配方与默认档位

```text
positive: best quality, score_7, score_9, sensitive, very aesthetic, ultra detailed, fair skin, high contrast
negative: worst quality, low quality, score_1, score_2, score_3, artist name, shiny skin
```

- **采样基准**：作者推荐 Euler/Euler a、`normal`、30 步、CFG 4.0–5.0；本地默认 `euler/normal`、30 步、CFG 4.5、`832×1216`。

## 2. 编译合并规则

- **质量词归属**：由模型层 profile 自动注入，场景正文严禁重复粘贴前缀。
- **分级自动替换**：默认带 `sensitive`；当正文或标签含明确分级词（`safe` / `nsfw` / `r18` 等）时自动替换。
- **肤色碰撞处理**：若角色或场景明确指定深色皮肤/晒黑等特征，编译时自动移除 `fair skin` 并保留原特征词。
- **负面合并**：以作者基础负向（含 `shiny skin`）起步，仅追加当前画面明确冲突的排除项。
- **格式示例**：
  ```text
  safe, 1girl, solo, silver hair, amber eyes, blue cardigan, long skirt, sitting, writing, notebook, window light, medium shot
  She writes in the notebook while holding its page flat beside the window.
  ```
