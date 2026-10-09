# 手机竖屏人物壁纸规范

## 目标与使用边界

手机壁纸作为与 [桌面人物壁纸](character-wallpaper-prompt-standard.md)、[叙事 CG](narrative-cg-prompt-standard.md)并列的图像交付方向。应用本身仍以 PC 端为主，本规范不要求开发手机版界面。

模型语法和证据分级沿用 [研究来源与采用边界](../../research/README.md)。本页新增的布局建议和候选尚未真实出图或手机验收。主验收机型已明确为 iPhone 17 Pro，同时覆盖其他常见长竖幅；实际锁屏时钟、组件和通知布局仍需在设备上确认。

## 一、先确定目标屏幕

记录手机型号、实际壁纸显示比例、用途（锁屏／主屏）、时钟和组件位置、通知展示方式以及系统裁切／缩放结果。Apple 和 Pixel 的官方指南都说明锁屏可自定义，Pixel 还提供动态时钟等选项；因此安全区域需要按实际配置检查，不能对全部设备固定使用同一百分比。[^1][^2][^3]

iPhone 17 Pro 的官方显示规格为 2622×1206 像素，因此本项目竖屏交付基准取 **1206×2622**（宽×高）；这不是要求模型原生输出相同尺寸。屏幕圆角、顶部区域以及实际壁纸缩放仍需预览，不能只凭图片尺寸宣称适配完成。[^4]

可用于兼容性检查的比例包括 9:16、9:19.5、9:20；它们是测试目标，不是声明所有手机都采用这些比例。最终像素尺寸以具体设备与交付方式为准。

### 裁切如何影响构图

按等比放大填满屏幕且不扩画时，若原图更宽，保留的宽度比例为“目标宽高比 ÷ 原图宽高比”。例如 2:3 原图填满 9:20，只保留约 67.5% 的横向内容；约 32.5% 会被裁去。9:16 填满 9:20 则保留约 80% 的宽度。

这些数值是几何示例，不代表每个系统一定采用相同裁切方式。实际应在手机壁纸预览中确认。长发、伸出的手、伞沿和衣摆需要为侧边裁切留出空间；不能靠横向压缩人物避免裁切。

生成尺寸仍受 checkpoint、节点和项目白名单限制。优先在已支持尺寸里设计可裁切构图；若需要扩画或新增原生比例，另行确认工作流能力，不声称修改提示词就能改变节点尺寸。

## 二、锁屏与主屏分别设计

| 用途 | 画面安排 | 实际检查 |
| --- | --- | --- |
| 锁屏 | 避免把脸、眼睛或重要发饰放在时钟／组件的主要覆盖区；上方可留安静色块 | 时钟大小变化、通知出现和消失、底部快捷操作遮挡 |
| 主屏 | 图标较多的区域减少细碎高对比纹理；主体位置按图标布局决定 | 图标与标签可读性、底部 Dock、横向页面移动时的裁切 |
| 锁屏与主屏配套 | 同一人物和视觉风格，可分别调整构图或背景细节 | 不要求一张图同时满足两种完全不同的遮挡布局 |

壁纸源图不烘焙时钟、图标、手机外框或通知栏。预览遮挡蒙版与最终图片分开保存，避免模型把“为时钟留白”理解成绘制一个时钟。

## 三、人物构图

- **全身立绘**：竖向轮廓清楚，头、脚和侧向肢体满足最终裁切；人物与地面承托合理。留白来自画面设计，不通过拉长人体获得。
- **半身或特写**：脸和表情可辨认，肩部与发丝裁切自然；不叠加要求全身、鞋履全部入镜的描述。
- **人物环境图**：纵向建筑、树干、窗框或光色可组织空间，但只使用场景需要的元素，不为填满长屏增加无关装饰。
- **安静主屏图**：轮廓、色彩和留白可以完成画面；背景简洁不等于质量低。

位置应表达为画面内部关系。先确定人物与空白区域，再在最终屏幕上调整位置；没有适用于所有设备的“脸必须落在某个固定高度”。

## 四、原创候选

以下为全年龄原创成年人物，未编译、未出图、未审核。结构写法可以借鉴，人物身份、服装及目标尺寸不能机械替换进生产数据。

### P1：竖屏全身人物

Anima 候选：

```text
1girl, solo, adult woman, full body, standing, short brown hair, green eyes, long blue coat, dark trousers, boots, relaxed arms, anime illustration, simple background
An adult woman stands in the central lower part of a tall composition, with her entire head and both boots visible. Her arms remain close to her body and her coat forms a narrow, readable silhouette. Soft light from the left gives shape to her face and clothing, with a small shadow beneath her boots. Leave an uninterrupted area of muted blue color above her head and quiet space beside her figure. Keep her hands, hair and clothing comfortably inside the side edges of the final narrow crop.
```

Krea 2 候选：

```text
A tall anime character illustration of an adult woman with short brown hair and green eyes, wearing a long blue coat, dark trousers and boots. She stands in the central lower area with a relaxed posture and her arms close to her body. Show the complete figure with clear space around her head, hands and feet. Gentle light from the left defines her face and clothing, and a restrained ground shadow supports her stance. The upper area is a quiet expanse of muted blue, while the side regions use broad low-contrast tones. Keep the figure narrow enough to remain intact when the picture is cropped to a taller phone display.
```

检查：最终裁切后的头脚和双手、人物比例、锁屏覆盖区、站姿承托。提示词中的裁切描述只表达意图，不能代替实际几何检查。

### P2：竖屏情绪肖像

Anima 候选：

```text
1girl, solo, adult woman, portrait, face, shoulders, long dark hair, amber eyes, gentle smile, cream blouse, soft side lighting, anime illustration
An adult woman looks toward the viewer with a quiet smile in a tall portrait. Her face and upper shoulders sit below a calm area of muted warm-gray background. Dark hair frames her cheeks without covering either eye and continues naturally beyond the lower portrait edge. Soft light from the right shapes her face, while the background stays broad and low in detail. Preserve the eyes, mouth and important hair features within the narrow central region, allowing the outer shoulders to be cropped naturally.
```

Krea 2 候选：

```text
A tall anime portrait of an adult woman with long dark hair and amber eyes, wearing a cream blouse. Her face and upper shoulders are placed below a quiet warm-gray background area, and she meets the viewer with a small relaxed smile. Soft light from the right defines her expression. Keep the hair clear of her eyes and draw its major shapes distinctly against the subdued background. The eyes, mouth and recognizable hair features remain inside the central narrow region, with the shoulders extending naturally toward the lower edges. Use restrained linework and painted shading without adding background objects or lettering.
```

检查：五官与身份、自然裁切、时钟／组件是否压脸，主屏标签是否被发丝和亮斑干扰。不按全身完整度评判此案例。

## 五、验收与实验

先固定一个模型与尺寸，用 3 个 seeds 比较一个构图因素。扩大时 P1／P2 各 8 seeds、两种写法，每 checkpoint 32 张；原始生成与后续裁切分别留档。没有实际设备遮挡预览时，只能标记尺寸／比例预检通过，不能写“iPhone 17 Pro 已完成实机适配”。

验收分三层：原图的身份／姿态／画质；目标比例裁切的关键区域；实际手机锁屏／主屏遮挡。分别保留无通知、带通知和常用图标布局的预览结果，不能只展示空白手机界面。

实验登记见 [研究来源与采用边界](../../research/README.md)。此处所有示例是图像创作建议，不涉及安装版 UI 或真实设备设置变更。

## 来源

查阅日期为 2026-09-13；系统版本、机型和用户配置影响实际遮挡范围。

[^1]: Apple. [Create a custom iPhone Lock Screen](https://support.apple.com/en-ph/guide/iphone/iph4d0e6c351/ios)。iPhone 用户指南；使用锁屏自定义的范围说明，不据此假定具体机型。
[^2]: Google. [Customize the lock screen on your Pixel phone](https://support.google.com/pixelphone/answer/16520562?hl=en)。时钟与锁屏配置说明。
[^3]: Google. [Change wallpaper on your Pixel phone](https://support.google.com/pixelphone/answer/7289143?hl=en)。锁屏与主屏壁纸设置说明。
[^4]: Apple. [iPhone 17 Pro — Tech Specs](https://support.apple.com/en-nz/125090)。显示分辨率和圆角范围说明。
