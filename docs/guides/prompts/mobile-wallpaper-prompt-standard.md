# 手机竖屏人物壁纸规范

与 [桌面人物壁纸](character-wallpaper-prompt-standard.md)、[叙事 CG](narrative-cg-prompt-standard.md) 并列的交付规范（本应用仍以 PC 端为主）。实验记录与来源分级见 [研究来源与采用边界](../../research/README.md)。

---

## 1. 目标屏幕与裁切边界

- **主力目标**：参考 iPhone 17 Pro 官方显示规格，竖屏交付基准取 **1206×2622**；兼容性检查覆盖 `9:16`、`9:19.5`、`9:20` 长屏（最终以实际机型锁屏/主屏预览为准）[^1][^2][^3][^4]。
- **等比裁切比例**：若原图更宽且等比填满屏幕，保留宽度比例为 `目标宽高比 ÷ 原图宽高比`（如 2:3 填满 9:20 约保留 67.5% 横向内容，两侧各裁去约 16%；9:16 填满 9:20 约保留 80%）。长发、伸手、伞沿和衣摆须预留两侧安全区，严禁横向压缩人物。
- **生成尺寸**：在当前模型与白名单支持尺寸内设计可裁切构图（不把模型原生出图尺寸等同于 1206×2622）。

---

## 2. 锁屏与主屏构图策略

| 用途 | 画面设计原则 | 实际设备检查 |
| --- | --- | --- |
| **锁屏** | 避开顶部时钟与底部快捷按钮覆盖脸部或关键发饰；上方可留安静色块 | 时钟字体大小、通知弹窗及底部按钮遮挡 |
| **主屏** | 图标密集区减少高对比碎纹理，主体按图标排布错开 | 图标与文字标签可读性、Dock 与滑屏裁切 |
| **通用原则** | **严禁在图片中烘焙时钟、图标、状态栏或手机外框** | 在无通知与带通知状态下分别实机预检 |

- **全身立绘**：竖向轮廓紧凑，头脚与两侧预留安全距，留白靠构图而非拉长人体。
- **半身 / 特写**：肩部与发丝自然裁切出画，不叠加全身或鞋履描述。

---

## 3. 原创参考示例（未编译/未出图）

### P1：竖屏全身人物

- **Anima**：
  ```text
  1girl, solo, full body, standing, short brown hair, green eyes, long blue coat, dark trousers, boots, relaxed arms, anime illustration, simple background
  A woman stands in the central lower part of a tall composition, with her entire head and both boots visible. Her arms remain close to her body and her coat forms a narrow, readable silhouette. Soft light from the left gives shape to her face and clothing, with a small shadow beneath her boots. Leave an uninterrupted area of muted blue color above her head and quiet space beside her figure. Keep her hands, hair and clothing comfortably inside the side edges of the final narrow crop.
  ```
- **Krea 2**：
  ```text
  A tall anime character illustration of a woman with short brown hair and green eyes, wearing a long blue coat, dark trousers and boots. She stands in the central lower area with a relaxed posture and her arms close to her body. Show the complete figure with clear space around her head, hands and feet. Gentle light from the left defines her face and clothing, and a restrained ground shadow supports her stance. The upper area is a quiet expanse of muted blue, while the side regions use broad low-contrast tones. Keep the figure narrow enough to remain intact when the picture is cropped to a taller phone display.
  ```

### P2：竖屏情绪肖像

- **Anima**：
  ```text
  1girl, solo, portrait, face, shoulders, long dark hair, amber eyes, gentle smile, cream blouse, soft side lighting, anime illustration
  A woman looks toward the viewer with a quiet smile in a tall portrait. Her face and upper shoulders sit below a calm area of muted warm-gray background. Dark hair frames her cheeks without covering either eye and continues naturally beyond the lower portrait edge. Soft light from the right shapes her face, while the background stays broad and low in detail. Preserve the eyes, mouth and important hair features within the narrow central region, allowing the outer shoulders to be cropped naturally.
  ```
- **Krea 2**：
  ```text
  A tall anime portrait of a woman with long dark hair and amber eyes, wearing a cream blouse. Her face and upper shoulders are placed below a quiet warm-gray background area, and she meets the viewer with a small relaxed smile. Soft light from the right defines her expression. Keep the hair clear of her eyes and draw its major shapes distinctly against the subdued background. The eyes, mouth and recognizable hair features remain inside the central narrow region, with the shoulders extending naturally toward the lower edges. Use restrained linework and painted shading without adding background objects or lettering.
  ```

---

## 4. 验收分层

验收分三层记录（缺少实机预览时仅标记比例预检通过）：**原图画质与身份 → 目标比例裁切安全区 → 实际手机锁屏/主屏无通知与有通知遮挡**。对照实验采用 3 seeds 小样与 `P1/P2 × 8 seeds × 2 写法`（32 张）分别留档。

[^1]: Apple. [Create a custom iPhone Lock Screen](https://support.apple.com/en-ph/guide/iphone/iph4d0e6c351/ios)
[^2]: Google. [Customize the lock screen on your Pixel phone](https://support.google.com/pixelphone/answer/16520562?hl=en)
[^3]: Google. [Change wallpaper on your Pixel phone](https://support.google.com/pixelphone/answer/7289143?hl=en)
[^4]: Apple. [iPhone 17 Pro — Tech Specs](https://support.apple.com/en-nz/125090)
