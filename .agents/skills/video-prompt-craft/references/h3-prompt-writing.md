# H3 Prompt Writing

> 来源：MiniMax 官方仓库 `MiniMax-AI/MiniMax-H3`。项目中由 [prose.rs](../../../../runtime-rs/src/video/prose.rs) 按 [h3-base-en.txt](h3-base-en.txt) 三段式结构组装 `minimax-h3` 提示词；全参考模式使用 [h3-ref-en.txt](h3-ref-en.txt) 六段式。

## 输入模式与结构

1. 识别模式：`T2VA`、`I2VA`、`FL2VA`、`L2VA` 或全参考 `Ref2VA`。
2. 基础/关键帧模式读 [h3-base-en.txt](h3-base-en.txt)，全参考模式读 [h3-ref-en.txt](h3-ref-en.txt)，严格保留字段名、段落顺序、参考标签与时间戳记法。

- **基础模式（`h3-base-en.txt`）**：
  - `T2VA`（纯文生音画时间线） · `I2VA`（由首帧向前展开） · `FL2VA`（首尾帧连续过渡） · `L2VA`（收束至尾帧）。
  - 顺序：`integrated_multimodal_description` → `overall_soundscape` → `non_diegetic_music`。
- **全参考模式（`h3-ref-en.txt`）**：
  - 顺序：`subject_definitions` → `summary` → `retention_analysis` → `detailed_description` → `overall_soundscape` → `non_diegetic_music`。

## 写作约束

- 正文各段统一使用英文；仅对白、歌词与画面内可见文字保留原语言并原样引用。
- 写清构图、主体、环境、动作、镜头运动、声音与参考切入时间戳；避免剧情概述、未定义标签或时长错配。
