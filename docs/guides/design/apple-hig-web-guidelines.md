# Web 与桌面 HIG / WCAG 2.2 评审速查

本页汇总从 **Apple HIG** 与 **W3C WCAG 2.2 / WAI-ARIA APG** 抽取的通用 Web 评审准绳、无障碍底线与状态文案规范。项目品牌、配色、圆角、布局与动效实施以根目录 [DESIGN.md](../../../DESIGN.md) 与 [studio-ui-design](../../../.agents/skills/studio-ui-design/SKILL.md) 为唯一真相源。

---

## 1. 核心评审原则（Apple HIG Web 转译）

- **层级、协调与一致性**：同一任务区域默认保留一个视觉主操作；导航（去哪里）与动作（做什么）分离；装饰必须解释关系或状态，不为“高级感”堆叠模糊或动画。
- **渐进披露与容错**：高频操作与搜索筛选靠近结果；高级参数默认折叠，但费用、破坏性后果、必填项、报错原因与恢复入口不可隐藏。
- **材质边界**：半透明材质仅用于导航与浮动工具层（非内容层、表单或嵌套卡片），且在 `prefers-reduced-transparency` 或高对比下必须回退为清晰实体表面。
- **同心与目标尺寸**：嵌套轮廓遵循外圆角减内缩距离的光学关系；桌面端 `32px` 紧凑控件须确保键盘可达与 WCAG 2.5.8（24×24 CSS px）基线，触屏/粗指针热区建议 ≥ `44×44` CSS px（不重叠）。

---

## 2. 无障碍量化底线（WCAG 2.2 AA）

| 检查项 | 规范要求 | 标准依据 |
| --- | --- | --- |
| 普通文字对比度 | ≥ **4.5:1**（大号字 ≥ 24px 或 18.67px 粗体 ≥ **3:1**） | [WCAG 1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) |
| 关键非文字对比度 | 控件边界与状态指示与相邻色 ≥ **3:1** | [WCAG 1.4.11](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) |
| 指针命中区 | 最小 24×24 CSS px（触屏建议 44×44） | [WCAG 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) |
| 文字放大与重排 | **200%** 文字缩放不丢内容功能；纵向阅读适配 **320 CSS px** | [WCAG 1.4.4](https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html) · [1.4.10](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html) |
| 键盘与焦点 | 主流程全键盘可达，焦点清晰可见且不被固定栏遮挡 | [WCAG 2.1.1](https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html) · [2.4.7](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html) · [2.4.11](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html) |
| 模态焦点与状态通知 | 模态内 Tab 循环、Escape 退出、关闭返焦；动态状态不抢焦点可感知 | [APG Dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) · [WCAG 4.1.3](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html) |

> 项目额外强化约束：禁用态直接使用 `--text-disabled`（禁用整控件 `opacity` 压字）。

---

## 3. 任务状态与错误文案格式

- **进度真实性**：可量化时展示真实百分比，否则展示实际阶段与耗时，禁止计时器假进度；无法确认服务端状态时标为 **未知**，不伪报失败或诱导重复提交。
- **错断恢复模板**：`发生了什么 + 哪些数据不受影响 + 下一步怎么做`（需用户处理的错误持续保留直至解决或关闭，不使用自动消失 Toast）。
  - *示例*：「连接中断，暂时无法确认生成状态。你的输入已保留，请先查询任务状态，避免重复提交。」

---

## 4. 发布前阻断性检查矩阵

| 阻断场景 | 验收要求 |
| --- | --- |
| 任务闭环 | 开始、排队、进行中、完成、失败、取消/退出状态真实可恢复 |
| 并发与断线 | 重复点击防重；未知态先查后提，不把超时当未执行 |
| 双主题与叠字 | 深浅两主题与真实图片背景下的文字/控件对比度达标 |
| 缩放与窗口 | 200% 缩放、短窗口、固定工具栏不遮挡焦点与主要操作 |
| 降级与减动效 | 启用减少动态/实体降级后状态语义与交互路径完整 |

> **参考来源**：[Apple Design](https://developer.apple.com/design/) · [Apple HIG](https://developer.apple.com/design/human-interface-guidelines/) · [WCAG 2.2](https://www.w3.org/WAI/WCAG22/Understanding/)
