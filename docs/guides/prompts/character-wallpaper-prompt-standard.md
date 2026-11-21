# 单人物立绘与特写壁纸提示词规范

面向 Anima 与本地 Krea 2 的桌面单人物壁纸创作规范（故事化场景见 [叙事 CG 规范](narrative-cg-prompt-standard.md)，手机竖屏见 [竖屏壁纸规范](mobile-wallpaper-prompt-standard.md)）。不要求复杂剧情，重点在于人物清晰、轮廓分离与桌面留白。

---

## 1. 壁纸类型与画幅

| 类型 | 画面重点 | 主要检查项 |
| --- | --- | --- |
| **全身立绘** | 整体轮廓、姿态、衣装结构与脚部承托 | 头脚完整、肢体自然、衣装一致、人物背景分离 |
| **半身立绘** | 表情、上身衣装与手势 | 脸与手的关系、裁切边界、肩颈与发丝轮廓 |
| **面部特写** | 眼神、微表情、发丝与光色 | 五官稳定、面部清晰、有意裁切、不强求全身 |

- **桌面基准**：主力交付目标为 **3840×2160（16:9）**（Windows 150% 缩放不影响壁纸分辨率）。横幅按构图生成而非拉伸竖图，超分/扩画需确认实际工作流支持。
- **桌面留白**：人物面部与关键轮廓避开常用图标与任务栏区域；留白侧（左/右）按实际桌面排版决定，背景可用低对比渐变或简洁光色，与主体保持统一视觉语言。

---

## 2. 写法要点

- **身份与衣装**：严格沿用角色数据与当前 `outfitId`，特写仅写画面可见部位，不擅自更改发色、瞳色或年龄。
- **光影与分离**：通过明度反差、局部色差或柔和轮廓光分离主体与背景，避免全身高对比与过度锐化；避免给特写叠加 `full body` 或在叙事场景里机械照抄模板尾句。
- **双引擎差异**：
  - **Anima**：保留 profile 与精确词；标签明确单人、景别与可见衣装，描述句补足站位、轮廓、光源与留白。
  - **Krea 2**：用连贯英文描述「人物肖像/立绘 + 画面位置 + 姿态表情 + 背景与光照」。

---

## 3. 原创参考示例（未编译/未出图）

### W1：全身立绘横幅（左侧留白）

- **Anima**：
  ```text
  1girl, solo, full body, standing, short silver hair, blue eyes, navy long coat, cream blouse, dark trousers, ankle boots, relaxed pose, anime illustration, simple background
  A woman stands on the right side of a wide composition, shown completely from the top of her hair to both boots. Her body turns slightly toward the left while she looks toward the viewer with a calm expression. Her arms rest naturally at her sides, keeping the coat silhouette clear. Soft light from the upper left defines her face and the folds of the navy coat, with a restrained contact shadow beneath her boots. The left side remains a quiet blue-gray background with broad, low-contrast tonal changes. Keep clear space above her hair and below her feet without stretching her proportions to fill the frame.
  ```
- **Krea 2**：
  ```text
  A full-length anime character illustration composed as a wide desktop wallpaper. A woman with short silver hair and blue eyes stands on the right, wearing a navy long coat over a cream blouse, dark trousers and ankle boots. Her body turns slightly left and her calm gaze meets the viewer. Her arms rest naturally at her sides so the coat forms a readable silhouette. Show her entire figure, including the top of her hair and both boots, with comfortable space around the figure. Soft upper-left light shapes her face and fabric folds, and a restrained shadow grounds her feet. The left half is a quiet blue-gray field of broad, low-contrast tones, using the same restrained anime painting language as the character.
  ```

### W2：面部特写横幅（眼神与发丝）

- **Anima**：
  ```text
  1girl, solo, close-up, face, shoulders, long dark hair, amber eyes, subtle smile, cream blouse, anime portrait, soft side lighting, simple background
  A close-up anime portrait of a woman placed to the right of a wide image, with her face and upper shoulders visible. Her head turns slightly left while her eyes look toward the viewer. Dark hair forms clear overlapping shapes around her face without covering the eyes. Gentle light from the left creates a warm highlight on her cheek and a quieter shadow on the far side. The left side of the image is an uncluttered muted plum background, with softer detail than the face. Preserve the shape of both eyes, the small smile and the clean separation between hair and background; the shoulders may continue beyond the lower edge.
  ```
- **Krea 2**：
  ```text
  A wide anime portrait wallpaper centered on the expression of a woman with long dark hair and amber eyes. Her face and upper shoulders occupy the right side, her head turned slightly left as she looks toward the viewer with a small, relaxed smile. Draw the hair as clear overlapping shapes around her face, leaving both eyes visible. Gentle light from the left warms her near cheek while the far side remains softly shaded. The muted plum background on the left is quiet and uncluttered, with broad color transitions and little fine detail. Use controlled anime linework and soft painted shading across the image, keeping the eyes and mouth precise and allowing the shoulders to extend naturally past the lower edge.
  ```

---

## 4. 审核与对照交付

- **分开评价**：壁纸不要求故事事件或复杂环境，重点考察身份辨识、轮廓分离、光色、留白和 16:9 裁切适配（对照测试以 3 seeds 小样 → `W1/W2 × 8 seeds × 2 写法` = 32 张分别对比原图与裁切后桌面遮挡）。
- **字段与交付**：遵循 [研究来源与采用边界](../../research/README.md) 与 [字段与交付](../../../.agents/skills/studio-prompt-craft/references/delivery.md)。
