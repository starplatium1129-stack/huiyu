# H3 Prompt Writing

> 来源：MiniMax 官方仓库 `MiniMax-AI/MiniMax-H3`。项目中带 `promptRecipe` 的工作台请求由 [prompt_compiler/mod.rs](../../../../runtime-rs/src/video/prompt_compiler/mod.rs) 与 [dialects.rs](../../../../runtime-rs/src/video/prompt_compiler/dialects.rs) 按 [h3-base-en.txt](h3-base-en.txt) 三段式组装（不自动前置 `2D-animated, cinematic`）；无 `promptRecipe` 的旧 ComfyUI 分支走 [prose.rs](../../../../runtime-rs/src/video/prose.rs)。全参考 [h3-ref-en.txt](h3-ref-en.txt) 六段式规范保留作参考，原生推理尚未接入（见 `adapter-models.json` 的 `pendingVideo`）。

## 输入模式与结构

1. 识别模式：`T2VA`、`I2VA`、`FL2VA`（工作台与原生推理支持）；`L2VA`（仅尾帧）仅旧 `prose.rs` 支持，工作台 `prompt_compiler` 会直接返回 400 拒绝；`Ref2VA` 尚待接入。
2. 基础/关键帧模式读 [h3-base-en.txt](h3-base-en.txt)，全参考离线起草读 [h3-ref-en.txt](h3-ref-en.txt)，严格保留字段名、段落顺序、参考标签与时间戳记法。

- **基础模式（`h3-base-en.txt`）**：
  - `T2VA`（纯文生音画时间线） · `I2VA`（由首帧向前展开） · `FL2VA`（首尾帧连续过渡） · `L2VA`（仅旧路径收束至尾帧）。
  - 顺序：`integrated_multimodal_description` → `overall_soundscape` → `non_diegetic_music`。
  - 原生支持 `5 / 10` 秒（24 fps）；ComfyUI 路径支持 `3 / 5 / 10 / 15` 秒。
- **全参考模式（`h3-ref-en.txt`，规划参考）**：
  - 顺序：`subject_definitions` → `summary` → `retention_analysis` → `detailed_description` → `overall_soundscape` → `non_diegetic_music`。

## 写作约束

- 正文各段统一使用英文；仅对白、歌词与画面内可见文字保留原语言并原样引用。
- 写清构图、主体、环境、动作、镜头运动、声音与参考切入时间戳；避免剧情概述、未定义标签或时长错配。
