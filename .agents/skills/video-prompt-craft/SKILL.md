---
name: video-prompt-craft
description: 编写、改写或审查 AI-CG-Studio 视频提示词、场景预设与多模型编译规则；支持全分级自由创作，覆盖 MiniMax H3、LTX-2.x、Wan 2.2、HunyuanVideo 1.5、Kandinsky 6 及动作/配音驱动模型。
---

# Video Prompt Craft

为 AI-CG-Studio 编写、组装与审查视频生成提示词，确保同一创作意图在各视频模型上都能正确编译执行；支持全年龄至 NSFW/R18 全分级自由创作。

## 权威参考导航

- **完整视频规范、积木槽位契约与对照范例**：[视频提示词规范](../../../docs/guides/video/video-prompt-standard.md)
- **MiniMax H3 详细格式与模板**（三段式、时间戳与 Ref2VA）：[H3 格式指南](references/h3-prompt-writing.md)（含 `h3-base-en.txt` / `h3-ref-en.txt`）
- **创作台积木库与编译器**：[prompt-library.json](../../../runtime-rs/src/video/prompt-library.json) · [prompt_compiler/mod.rs](../../../runtime-rs/src/video/prompt_compiler/mod.rs)（含 `dialects.rs` / `input.rs`）
- **全分级创作与原生能力**：[NSFW 全分级规范](../../../docs/guides/prompts/nsfw-cg-prompt-standard.md) · [原生视频适配清单](../../../tools/inference/adapter-models.json)

## 模型家族快速路由

| 模型家族 | 语言与正文结构 | 音频字段 | 负向词策略 | 本地管线注意 |
| --- | --- | --- | --- | --- |
| `minimax-h3` | 英文；I2VA/FL2VA 首行对齐 + `integrated_multimodal_description` / `overall_soundscape` / `non_diegetic_music` | 原生 32 kHz（写入后两段） | 不支持（`cfg=1`） | 对白 `<d>[Language] 原文</d>`；无配乐写 `N/A`；工作台仅支持 T2VA/I2VA/FL2VA（拒绝仅尾帧） |
| `ltx-2.3` / `ltx-2.5-distilled` | 单段英文现在时电影散文；忌空泛画质词 | 原生 48 kHz（融入正文末尾，支持对白） | 2.3 透传用户输入（无默认模板/不裁剪）/ 2.5 不支持 | `enable_prompt_enhancement=False`，正文需自足；对白编为 `The subject says in {Lang}, "..."` |
| `wan2.2-ti2v-5b` / `wan2.2-14b` | 中或英自然语言视觉动态段（积木编为中文） | 无声（自动剥离音频槽与常见听觉句） | 支持（合并 `WAN_NEGATIVE` 并按微动/文字自动裁剪） | 视觉正文亦勿写节拍/重低音等声音词 |
| `wan2.2-i2v-a14b-gguf` | 中或英自然语言视觉动态段（`image` / `first-last-frame`） | 无声 | **不支持**（4/8 步蒸馏 `cfg=1`） | 16 fps、2/3/5 秒；首尾帧缺省 `ending` 自动补 `match-last` |
| `hunyuan-video-1.5` | 中或英自然语言视觉段（480p T2V） | 无声（自动剥离音频槽与常见听觉句） | 支持（合并 `WAN_NEGATIVE` 并自动裁剪） | 含 ByT5，画面内文字自动转双引号保原文 |
| `kandinsky-6-lite-distill` | 2–3 句简洁英文单主线动作 + 声景 | 原生 44.1 kHz 单声道（**仅保留 `sound`，丢弃配乐与对白**） | 不支持（`cfg=1`） | `expand_prompts=False`，固定 5 秒、忌多镜头 |
| `wan-animate-2` | 简短画风、光影、神态定调（积木编为中文） | 无声（驱动输入强制 `supports_audio=false`） | 不支持（`cfg=1`） | 禁用 `framing`/`camera`，硬编码稳机位；不写与参考视频冲突位移 |
| `longcat-avatar-1.6` / `musetalk-1.5` | 简短神态、微动作与光影定调（积木编为中文） | 跟随配音 48 kHz WAV（积木编译剥离音频槽） | 不支持（`cfg=1`） | 禁用 `framing`/`camera`，硬编码稳机位；不写闭嘴、背对镜头或冲突口型（`musetalk-1.5` 为 1 步 25 fps 2–15 秒） |

## 积木编译与交付自查

1. **槽位对齐**：工作台按 6 个互斥视觉槽（`framing` 仅 `text`、`subject`、`action`、`camera` 仅非驱动模式、`atmosphere`、`ending`）+ 结构化 `audio: { sound?, music?, dialogue?, language? }`（对白 ≤ 300 UTF-16 字符，`language` ∈ `auto|en|zh|ja`）组织。自由正文支持 `integrated_multimodal_description:` / `overall_soundscape:` / `non_diegetic_music:` / `dialogue:`（及中文等效行头）自动拆段；正文已写运镜或动作时自动抑制对应积木与兜底句。
2. **模式裁剪**：I2V 不复述首帧静态外观；FL2V 只写中间过渡（缺 `ending` 自动补 `match-last`）；无声模型由编译器剥离音频槽及常见听觉句，但视觉正文仍应避开纯声音/鼓点词；`negative: false` 模型不传负向词。
3. **身份与分级保真**：按「起势 → 过程 → 落幅」写单一动作主线与自然语言（不用 Danbooru 标签/权重），如实保留角色状态、衣着或裸露描述。
4. **实事求是**：规范审查只确认结构与编译规则对齐，真实画质与音画同步待主力机生成后确认。
