# MiaoMiao Harem Anima 1.6 专属配方

适用于 `anima-miaomiao-v1.6` / `miaomiaoHarem_anima16.safetensors`。

## 1. 基础配方与默认档位

```text
positive: best quality, score_7, score_9, sensitive, very aesthetic, ultra detailed, fair skin, high contrast
negative: worst quality, low quality, score_1, score_2, score_3, artist name, shiny skin
```

- **采样基准**：作者推荐 Euler/Euler a、`normal`、30 步、CFG 4.0–5.0；本地默认 `euler/normal`、30 步、CFG 4.5、`832×1216`。

## 2. 编译合并规则

- **质量词归属**：由模型层 profile 自动注入，场景/蓝图正文严禁重复粘贴前缀（含 `high contrast`、`fair skin`）。
- **分级自动替换与 `rating_mode: "prompt"`**：默认带 `sensitive`；当正文或标签含明确分级词（`safe`/`general`/`nsfw`/`explicit`/`r18` 等）或 R18 蓝图编译传入 `nsfw` 时自动替换；**无显式 `safe` 标签的常规 SFW 蓝图默认保留 `sensitive`**。因采用 `rating_mode: "prompt"`，编译层跳过其他 Anima 底模的自动负面分级注入（不自动追加 `nsfw/nude/explicit` 或 `child/loli/underage`）。
- **肤色碰撞处理**：若角色、场景或 `animaCaption` 明确指定深色/晒黑或非人类有色皮肤（`dark/tan/brown/olive/bronze/blue/green/purple/red/gray/orange/yellow/pink skin(ned)`，忽略否定句），编译时自动移除 `fair skin` 并保留原特征词（同逻辑适用于 `anima-miaomiao-realskin-2.9b-v1.0`）。
- **负面合并**：以作者基础负向（含 `shiny skin`）起步，仅追加当前画面明确冲突的排除项。
- **格式示例**：
  ```text
  safe, 1girl, solo, silver hair, amber eyes, blue cardigan, long skirt, sitting, writing, notebook, window light, medium shot
  She writes in the notebook while holding its page flat beside the window.
  ```

## 3. 2.9B 衍生底模速记

- **`anima-miaomiao-2.9b-beta1.1`**：40 层 2.9B，`lora: false`，前缀含 `masterpiece, best quality, score_7, score_9, very aesthetic, ultra detailed`（不含 `fair skin`/`sensitive`），`euler/sgm_uniform`、30 步、CFG 4.5、`832×1216`。
- **`anima-miaomiao-realskin-2.9b-v1.0`**：40 层 2.9B，`lora: false`，正向同 MiaoMiao 1.6，`negative_mode: "replace"` 使用作者 29 词专属负面，`euler/sgm_uniform`、30 步、CFG 4、`928×1536`。
