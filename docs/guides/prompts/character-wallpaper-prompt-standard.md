# 单人物立绘与特写壁纸提示词规范

## 适用范围

与 [人物环境叙事 CG](narrative-cg-prompt-standard.md)并列的创作方向，面向 Anima 和项目本地 Krea 2。目标是单人物立绘或肖像在桌面上形成清楚、耐看的视觉重点；不要求一定发生故事事件，也不把背景简单视为完成度不足。

手机使用见 [竖屏壁纸规范](mobile-wallpaper-prompt-standard.md)：以 iPhone 17 Pro 为主，兼容常见手机长屏；锁屏与主屏遮挡单独验收。

模型语法、版本和编译边界沿用 [研究来源与采用边界](../../research/README.md)。本页为项目创作建议和原创候选，尚未真实出图验证；不覆盖既有身份、服装、分级、参数或定稿约束。

## 一、先确定壁纸类型

| 类型 | 画面重点 | 主要检查 |
| --- | --- | --- |
| 全身立绘壁纸 | 人物整体轮廓、姿态、衣装结构与脚部承托 | 头脚完整、肢体清楚、衣装一致、人物与背景分离 |
| 半身壁纸 | 表情、上身衣装和必要手势 | 脸与手的关系、取景边界、肩颈与发丝轮廓 |
| 面部特写壁纸 | 眼神、微表情、发丝与光色 | 五官稳定、脸部清晰、裁切有意图、不强求全身 |

先确定全身、半身或特写，再写提示词。全身与极近特写不叠加；面部特写不能机械使用排斥所有裁切的负向。姿态、目光和轮廓足以成为主题，不必给人物额外安排手持道具。

## 二、桌面使用与画幅

主力桌面的目标为 **3840×2160，16:9**。Windows 150% 缩放影响界面逻辑尺寸，不把壁纸目标分辨率自动改成 2560×1440。

- 构图先按最终横幅思考，不把一张竖版人物图拉伸成横幅。
- 只使用实际 checkpoint／工作流支持的生成尺寸。若不支持目标比例，先规划有意裁切并验证头脚或面部安全区；扩画、超分只有在实际流程支持时才使用。
- 4K 指最终交付目标，不要求所有模型原生直出 4K，也不把单纯像素放大当成细节提升。
- 根据实际桌面图标位置选择留白侧。左侧留白、人物偏右只是下方案例的一种设计，不是所有壁纸固定采用的构图。
- 人物脸部和关键轮廓尽量避开常用图标与任务栏覆盖区。背景可使用低对比渐变、简化光色或少量形状，不必纯白，也不必完全无细节。
- 最终检查原尺寸、缩小预览及实际桌面遮挡效果；避免过强锐化、光晕、边缘噪点和失去材质层次。

## 三、写法重点

### 身份与衣装

现有角色的稳定身份、精确触发词和当前 outfitId 沿用项目数据。全身图要让服装主要结构与配饰能被辨认，特写只强调画面可见部分。不要为了“更惊艳”擅自改变发色、眼睛、衣装和人物年龄。

### 轮廓、光照与质感

先明确姿势、身体方向、头部方向和目光，再选择主光。轮廓可通过背景明度、局部色差或合理的边缘光分开，不强制每张加发光描边。

完成度重点检查脸、发丝块面、衣料层次、手部和轮廓边缘。背景细节可以少，但色彩、明暗与人物应属于同一套视觉设计。不要让整个画面每一处都同样锐利或高对比。

### Anima 与 Krea 2

- Anima 保留 profile 与精确词，标签明确单人、景别、姿态和可见衣装，描述句补位置、轮廓、光源与留白；不复制叙事 CG 的场景尾句凑丰富度。
- Krea 2 用完整英文说明“人物肖像／全身插画＋所处画面位置＋姿势与表情＋背景与光照”。背景不承担故事时，无需写复杂地点和事件。
- 全身图检查是否被自动镜头、风格词或 caption 拉成半身；特写检查是否被全身、鞋履或脚部描述拉远。
- 检查最终正负向及自动注入：通用的 layered background、cinematic 或 off-center 描述不一定符合本次目的。发现冲突先记录，不能仅在文档里假设它们已被移除。

## 四、原创候选案例

以下均为原创成年女性的全年龄说明，**未编译、未出图、未审核**。不包含角色 LoRA 或 profile 自动注入部分，不作为生产场景或模板批量套用。

### W1：全身立绘横幅——完整轮廓与安静留白

设计：成年女性穿已有明确设计的长外套，完整站姿位于画面右侧；左侧保留安静背景。示例中的原创衣装仅用于说明，替换为既有角色时必须读取其真实衣装数据。

Anima 候选：

```text
1girl, solo, adult woman, full body, standing, short silver hair, blue eyes, navy long coat, cream blouse, dark trousers, ankle boots, relaxed pose, anime illustration, simple background
An adult woman stands on the right side of a wide composition, shown completely from the top of her hair to both boots. Her body turns slightly toward the left while she looks toward the viewer with a calm expression. Her arms rest naturally at her sides, keeping the coat silhouette clear. Soft light from the upper left defines her face and the folds of the navy coat, with a restrained contact shadow beneath her boots. The left side remains a quiet blue-gray background with broad, low-contrast tonal changes. Keep clear space above her hair and below her feet without stretching her proportions to fill the frame.
```

Krea 2 候选：

```text
A full-length anime character illustration composed as a wide desktop wallpaper. An adult woman with short silver hair and blue eyes stands on the right, wearing a navy long coat over a cream blouse, dark trousers and ankle boots. Her body turns slightly left and her calm gaze meets the viewer. Her arms rest naturally at her sides so the coat forms a readable silhouette. Show her entire figure, including the top of her hair and both boots, with comfortable space around the figure. Soft upper-left light shapes her face and fabric folds, and a restrained shadow grounds her feet. The left half is a quiet blue-gray field of broad, low-contrast tones, using the same restrained anime painting language as the character.
```

验收：头脚不被意外截掉；衣装与身体比例一致；空白区域有意图；人物站得住。背景装饰少不扣分。若完整人物难以保留，先调整景别与裁切方案，不能只靠重复 full body 或盲目增加权重。

### W2：面部特写横幅——眼神与光色

设计：成年女性的脸和肩部位于画面偏右，使用微弱微笑、眼神与发丝结构形成焦点；背景平静。构图允许肩部和头发延伸到画面外，重点保护五官及需要保留的发饰。

Anima 候选：

```text
1girl, solo, adult woman, close-up, face, shoulders, long dark hair, amber eyes, subtle smile, cream blouse, anime portrait, soft side lighting, simple background
A close-up anime portrait of an adult woman placed to the right of a wide image, with her face and upper shoulders visible. Her head turns slightly left while her eyes look toward the viewer. Dark hair forms clear overlapping shapes around her face without covering the eyes. Gentle light from the left creates a warm highlight on her cheek and a quieter shadow on the far side. The left side of the image is an uncluttered muted plum background, with softer detail than the face. Preserve the shape of both eyes, the small smile and the clean separation between hair and background; the shoulders may continue beyond the lower edge.
```

Krea 2 候选：

```text
A wide anime portrait wallpaper centered on the expression of an adult woman with long dark hair and amber eyes. Her face and upper shoulders occupy the right side, her head turned slightly left as she looks toward the viewer with a small, relaxed smile. Draw the hair as clear overlapping shapes around her face, leaving both eyes visible. Gentle light from the left warms her near cheek while the far side remains softly shaded. The muted plum background on the left is quiet and uncluttered, with broad color transitions and little fine detail. Use controlled anime linework and soft painted shading across the image, keeping the eyes and mouth precise and allowing the shoulders to extend naturally past the lower edge.
```

验收：眼神、微表情和身份特征优先；裁切应自然，不按全身图要求判定缺脚；背景不与脸竞争。只有请求出现手部时才增加手势，避免为了丰富度引入新的解剖风险。

## 五、与叙事 CG 分开评价

| 评价问题 | 叙事 CG | 单人物壁纸 |
| --- | --- | --- |
| 是否必须读出事件 | 主要目标之一 | 非必需，姿态和表情可以成立 |
| 背景需要多少信息 | 以人物与环境关系为准 | 以人物衬托、耐看与桌面使用为准 |
| 全身是否必须完整 | 由简报景别决定 | W1 必须；W2 不适用 |
| 主要审美维度 | 叙事、空间、人物环境融合 | 身份辨识、轮廓、表情、衣装、光色、桌面留白 |

候选先检查人数、身份／衣装、景别和分级。W1 增加全身完整、脚部承托；W2 检查五官、发丝与有意裁切。再用内部 0–3 量表记录主体表现、轮廓分离、光色、完成度、留白和最终壁纸裁切适配，不要求壁纸通过环境叙事量表。

## 六、主力机实验与交付

先从 W1 或 W2 选一个，保持 checkpoint、人物、衣装、画幅和实际工作流不变，用 3 个固定 seeds 比较一个写作因素。扩大时 W1／W2 各 8 seeds、两种写法，共每 checkpoint 32 张；与叙事组的 48 张分别记录，不因新增方向自动启动两组全部生成。

最终 16:9 裁切／放大检查单独记录所用方法。先比较原始生成构图，再比较最终壁纸，避免把后处理差异归因于文本。保留所有候选和失败，不只展示最好的一张。

共用 [研究来源与采用边界](../../research/README.md)。本页扩展于 2026-09-13，尚无真实出图验收结果。生产数据写入仍遵循现有 [字段与交付](../../../.agents/skills/studio-prompt-craft/references/delivery.md)。
