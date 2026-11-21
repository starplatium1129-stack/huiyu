# 人物与环境融合的叙事 CG 提示词规范

面向 Anima 与本地 Krea 2 的单幅叙事 CG 写作与审校规范（支持全分级自由创作）。单人物立绘/壁纸见 [桌面壁纸规范](character-wallpaper-prompt-standard.md) 与 [竖屏壁纸规范](mobile-wallpaper-prompt-standard.md)，模型语法依据见 [研究来源与采用边界](../../research/README.md)。

---

## 1. 先写画面简报

起笔前明确核心元素（按题材省略不适用项，勿机械拼表）：

| 决定事项 | 应写的可见信息 | 避免的空话 |
| --- | --- | --- |
| 这一刻发生什么 | 谁对什么对象做什么（同一瞬间动作） | 只有“温馨”“宿命感”；或堆砌多个先后动作 |
| 第一眼看哪里 | 脸、手与道具、轮廓或人物-环境焦点 | 全图所有区域同时最亮、最锐 |
| 人物如何入景 | 所在平面、支撑面、朝向与物件相对位置 | 一串互不关联的人物/地点名词 |
| 环境线索 | 能说明地点或事件的建筑/物件与关系 | 无故加花瓣、星星、发光粒子填空 |
| 主光与时段 | 明确光源、受光面与必要反射 | 无来源的全身轮廓光或矛盾时段 |
| 清晰与取舍 | 动作接触点、地标与角色衣装特征 | 同时要求浅景深与远景绝对锐利 |

---

## 2. 构图、景别与环境联系

- **景别与画幅**：按动作和空间选定（中景兼顾表情与环境、远景靠轮廓/色块定焦、特写仅留叙事线索、全身须保脚与支撑面）；在项目支持尺寸内选取，横竖幅匹配人物朝向。
- **空间组织**：用关系句定位（例：“站在长凳右端，把杯子放在空位边缘”），左右统一指画面坐标；前景可借门框、桌沿建立视点，但不得遮挡脸部与关键动作。
- **四类联系检查**：**接触**（脚/手/道具承托）、**光照**（人物与周围共享可解释光源）、**运动**（风向、雨丝、衣摆与姿态一致）、**叙事**（每个核心道具服务于这一刻，多余装饰删去更清晰）。

---

## 3. 双引擎写法要点

- **Anima（锚点 + 标签 + 关系句）**：
  1. 质量、分级、画师与精确触发词沿用 profile 与角色数据，不在正文中重复注入。
  2. 标签描述人物、服装、道具、地点与景别（普通标签空格分隔，精确词保持下划线）。
  3. 用描述句说明位置、接触、光源与细节（兼容场景的 `animaCaption` 或蓝图 `promptProse`）。
  4. 负向仅针对具体冲突（特写不排斥裁切，多人不带单人排斥词）。
- **Krea 2（连贯英文散文）**：
  - 按「媒介与事件 → 人物动作 → 空间与光照」自然行文，属性紧邻所属人物，媒介修饰覆盖整幅画面。
  - 删除空洞赞美词（如 `masterpiece`/`8k`），当前本地工作流 `negative` 为空，排除项改写为明确正向状态（如独自一人、完整着装）。
  - 仅在画面确需文字时加引号写明内容。
- **多人互动（`compositionIntent: group`）**：先核对角色外貌、位置、衣装与手部归属分别绑定，禁用单人句式模板直接改数字。

---

## 4. 原创写作示例（未编译/未出图/仅作结构示范）

### 示例 A：雨夜候车（道具显露等待）

- **Anima**：
  ```text
  1girl, solo, black bob hair, amber eyes, navy coat, cream scarf, bus stop, bench, paper cup, rain, wet pavement, evening, medium shot, three-quarter view, anime illustration
  A woman stands at the right end of a sheltered bench, placing a paper cup beside a second cup already on the seat. She looks toward the empty seat with a restrained, expectant smile. The bench extends into the left side of the picture. Rain falls beyond the shelter, and the wet road leads toward a quiet row of shops. A warm lamp under the shelter lights her face, hands and the cups; cool evening light remains outside. Keep the empty seat and cup placement readable, with the distant storefronts less detailed than the foreground action.
  ```
- **Krea 2**：
  ```text
  A hand-drawn anime narrative illustration of a woman waiting at a rain-soaked bus stop in the evening. She has a black bob, amber eyes, a navy coat and a cream scarf. Standing at the right end of a sheltered bench, she places a paper cup beside another cup already on the seat, then looks toward the empty seat with a restrained, expectant smile. She is the only person visible. The bench extends to the left, leaving the empty place readable. Beyond the shelter, the wet road recedes toward quiet shops. A warm overhead lamp lights her face, hands and both cups, while cool evening light colors the road. Use clear character linework and restrained painted backgrounds, preserving the contact between the cup and the seat and the spatial connection between the shelter and street.
  ```
- *审校关注点*：双杯落地位置、单人约束、空位是否被杂物填满、暖光照射范围。

### 示例 B：修理风铃（动作与室内深度）

- **Anima**：
  ```text
  1girl, solo, chestnut hair, tied hair, green apron, long sleeves, workshop, wooden workbench, wind chime, window light, medium shot, side view, anime illustration
  A craftswoman stands to the left of a wooden workbench and holds a repaired wind chime by its top loop above the table. Her free hand rests on the table as she watches the hanging pieces settle. The workbench runs diagonally from the lower right toward her hands. A small pair of pliers and a short coil of cord lie near the repair area; shelves farther back are simplified. Daylight from the window on the right lights the chime and the same side of her face, with a soft shadow on the workbench. Keep the hanging parts separated and the hand-to-loop contact visible.
  ```
- **Krea 2**：
  ```text
  A quiet anime illustration set in a small repair workshop. A craftswoman with tied chestnut hair wears a green apron over a long-sleeved shirt. She stands to the left of a wooden workbench, holding a repaired wind chime by its top loop above the surface while her other hand rests on the table. Her gaze follows the hanging pieces as they settle. The workbench forms a diagonal from the lower right toward her hands, where a pair of pliers and a short coil of cord explain the work just completed. Daylight enters from a window on the right and reaches both the chime and her face; the table carries their soft shadows. Draw the figure and room in compatible hand-painted anime colors, with the repair area clearly articulated and the distant shelves quieter.
  ```
- *审校关注点*：窗光方向、双手分工、风铃悬挂结构与工作台透视（背景压过动作时弱化远景工具，勿全糊成色块）。

### 示例 C：海边归航（小人物强焦点）

- **Anima**：
  ```text
  1girl, solo, short dark hair, red raincoat, boots, harbor, pier, fishing boat, overcast sky, sea, wide shot, back view, anime landscape illustration
  A woman in a red raincoat stands on the left side of a wooden pier, seen from behind, watching a small fishing boat approach the harbor entrance in the distance. Both boots rest on the boards and one hand touches the railing. The pier narrows toward the approaching boat, leaving a broad area of quiet gray-green water between them. Wind pushes the edge of her coat in the same direction as the ripples. Soft overcast light belongs to the whole scene, and the red coat provides a clear accent against the restrained sea and sky. Keep the boat recognizable without making the distant rigging compete with the figure.
  ```
- **Krea 2**：
  ```text
  A wide hand-painted anime scene of a quiet harbor under an overcast sky. A woman with short dark hair stands on the left side of a wooden pier, seen from behind in a red raincoat and boots. Both feet are supported by the boards and one hand rests on the railing. She watches a small fishing boat returning through the distant harbor entrance. The pier narrows in the direction of the boat, connecting her position to it across an open stretch of gray-green water. Wind moves her coat edge in the direction suggested by the ripples. Use soft shared daylight and restrained background detail, with the red coat as a distinct color accent. The open water should preserve the distance and quiet anticipation between the figure and the arriving boat.
  ```
- *审校关注点*：红衣色块辨识、船只可辨度、码头引导线、风向一致性（背影不扣分）。

---

## 5. 落库与对照实验交付

1. **映射字段**：场景事件写入 `promptTokens` / `promptProse`（或场景 `prompt` / `animaCaption`），与镜头/光照/尺寸保持一致；身份与服装从角色源读取，不改 schema。
2. **最终核对**：检查完整编译后的正负向与实际 workflow，防止通用默认值覆盖构图意图；真实 tokenizer 计数与字符估算分开记录。
3. **对照实验方法（单因素控制）**：小样先用 3 个固定 seeds 检验单变量改动，扩大验证用 `A/B/C × 8 seeds × 2 写法`（共 48 张/模型），冻结模型、尺寸、LoRA 与参数，保留全部失败图与客观分项评价；交付流程见 [字段与交付](../../../.agents/skills/studio-prompt-craft/references/delivery.md)。
