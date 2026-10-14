# 交互落地

创建或审查控件、表单、弹层、拖拽及反馈时读取。布局、字体、材质和品牌遵循 [DESIGN.md](../../../../DESIGN.md)。

## 先复用真实组件

查看 src/components/ui 的现有 Studio 组件、调用方与 package.json。选择、popover、tooltip 优先已有 Reka UI 封装；分段选择复用 AnimatedSelection。业务层提供值和内容，共享组件负责主题、键鼠、定位与焦点。

不将上游 Base UI、React hooks 或 Framer Motion JSX 复制进 Vue，不为偏好的外观替换现有依赖。已有模态与非模态行为分别维护，不重复添加 focus trap 或手工定位。

## 控件与文字

- 按下可提供轻微视觉反馈，常规按钮可接近 scale(0.97)，但不改变点击命中区、文本排版或提交时机；输入、画布和拖拽把手不机械套用缩放。
- 功能动作继续由 click、键盘和已有组件事件提交。pointerdown 仅用于必要的视觉或拖拽准备，不能提前执行删除或表单提交。
- 字号、字重、行高、留白和对比共同形成层级；中文不照搬拉丁标题的负字距。标签长短不改变对齐基线，也不能挤掉关键动作。
- loading、disabled、empty、error、selected 与 focus 是不同状态。禁用文字沿用 --text-disabled；状态不能仅靠颜色或整体透明度表达。
- 操作靠近受影响内容，优先明确动作名称；高级设置按现有方式渐进展开。成功、失败与进度描述真实请求状态，保留正在使用的结果与输入。

## 浮层与 tooltip

锚定浮层使用所属 primitive 的原点变量和碰撞结果。确认框在触发层之上可达；关闭后回到合理入口，内部 portal 沿用当前 dialog 接入机制。

tooltip 同时支持 hover 与键盘焦点。首个说明可有短延迟；同组已经打开后，邻近 tooltip 跳过重复延迟与演出。说明不承担唯一标签，不覆盖正在使用的按钮，也不能留在已消失入口上。

视觉退出不延迟 Escape 或返焦；可见内容与实际可操作范围一致。透明、离场或仅用于过渡的副本不能继续接收输入或进入阅读顺序。

## 指针与连续操作

有实际拖拽需求时保留按下位置相对对象的偏移，使用 pointer capture 防止越界丢失；识别所属 pointerId，处理 pointercancel、丢失捕获和额外指针，避免第二个触点改变当前目标。

拖动期间对象跟随输入，不加使功能滞后的弹簧。只有释放阶段才根据已有交互使用惯性或阻尼；不移植上游统一速度阈值，不把关闭手势扩展为删除或任务取消。拖拽保留现有键盘等价操作。

连续操作从当前画面值和最新业务目标衔接；新请求不会被旧动画完成回调覆盖。关闭、重开或路线切换不锁住控件等待演出。

## 画面验收

范围与记录遵循 [AGENTS.md · 审查与验收](../../../../AGENTS.md#审查与验收)。涉及浮层时重点查看真实触发器的返焦、dialog 内 portal 的层级，以及视觉退出期间是否仍接收点击；源码不能代替这些画面证据。

来源：[emil-design-eng](https://github.com/emilkowalski/skills/blob/2d228630ba1446365f614a108cb8252f1feda202/skills/emil-design-eng/SKILL.md)、[apple-design](https://github.com/emilkowalski/skills/blob/2d228630ba1446365f614a108cb8252f1feda202/skills/apple-design/SKILL.md)、[pick-ui-library](https://github.com/emilkowalski/skills/blob/2d228630ba1446365f614a108cb8252f1feda202/skills/pick-ui-library/SKILL.md)；保留绘遇现有组件和 Windows 桌面语义。
