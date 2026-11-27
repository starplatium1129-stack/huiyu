# Krea 2 自然语言提示词规范

适用于本地 Krea 2 引擎（`krea2-raw` / `krea2-turbo` / `krea2-turbo-fp8`）。

- **文风与结构**：输出连贯具象的纯英文散文（禁用中文、标签堆叠、括号权重与 `masterpiece`/`8k`/`ultra detailed` 等质量词），按 `画风与媒介 → 主体身份与衣着 → 动作神态与空间互动 → 环境与光影 → 镜头景别` 自然组织。
- **全分级表达**：对日常到亲密/NSFW 题材均使用准确具象的自然英语描述身体状态与接触关系；成人蓝图的 `nsfwProse` 会前置到场景散文开头以获得最高权重。
- **实际组装链路（`promptKreaRenderer.ts`）**：由 `kreaStyleHint`/`artistProse` → 角色 `identityProse` → `outfit.prose` → 蓝图 `promptProse`（及 `nsfwProse`）与 **`promptTokens`/`nsfwTokens` 翻译短语** → 导演景别/光影/色调共同拼合；纯空景无主体时自动追加 `no characters, no people, no figures`。需确保 `outfit.prose` 与 `promptProse` 均为自然英文且避免机械重复 `wearing ...`。
- **负面与本地预设基线**：本地分支 `capabilities.negative = false`（默认 `negative = ''`），排除项改写为明确正向目标状态（如 `a single person in a quiet room`）；支持 3 档配置：`krea2-raw`（`euler` 52 步 CFG 3.5 `1024×1024`）、`krea2-turbo`（原生 8 步 CFG 0 `1024–1536`）、`krea2-turbo-fp8`（`euler/simple` 8 步 CFG 1 `1024–1536`）；原生分支可挂 1 个强度为 `1` 的风格 LoRA。
