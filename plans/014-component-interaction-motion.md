# 014 组件交互动效专项计划

制定并实施于 2026-10-05（Asia/Shanghai）。状态：**M1–M4 源码与定向浏览器验收完成**。入册、素材切换、参数微调、配方内部展开和作品列表接续已落地；原生客户端、真实模型与 009 的设备／性能事项保留各自范围。

目标是让选择、操作反馈、展开收起和内容变化之间保持连续，让用户看懂“刚才发生了什么、内容从哪里来、接下来可以做什么”。本专项集中打磨日常使用的 UI 组件及其衔接。

实施顺序为 **M1 状态与选择 → M2 参数反馈 → M3 来源与展开 → M4 列表与撤销**。首批只做入册按钮和创作素材分类切换，形成可直接体验的样板，再推广有效做法。

## 范围与既有计划的关系

本专项承接用户对“组件之间的动画效果”的要求。背景着色器、粒子、光晕、成片显影和删除消散不纳入本轮设计任务；MetalForge 的 Grain、Wallpaper 保留为独立氛围候选。普通页面切换维持当前快速呈现策略。

[009 交互流畅度与运行性能](009-ui-fluidity-and-performance.md)继续承接高刷、真实并发负载、GPU、功耗及目标设备验收。014 负责新增的组件交互细节，不重新开启 009 已完成的基础建设，也不以本专项局部验证关闭 009 的剩余事项。

保留当前 Vue、Motion、Reka、PhotoSwipe 及设计令牌，不新增动画依赖或通用动效框架。生成任务、入册事务、取消规则、参数含义和权限边界继续由原有业务层负责。

## 已有基础与具体增量

以下为源码已存在的能力，不代表本次重新验收通过。

| 已有基础 | 本专项增量 |
| --- | --- |
| [入册工具栏](../src/components/director/DirectorResultTools.vue)已有保存状态、状态文字过渡及按钮变链接后的焦点接续 | 打磨操作区内部的状态衔接，避免按钮、状态提示与后续入口各自跳变 |
| [生成控制变形](../src/utils/generationControlMorph.ts)已有原位形变与取消收尾 | 作为已有范例；首批不改生成／停止按钮 |
| [AnimatedSelection](../src/components/visual/AnimatedSelection.vue)与[连续弹簧](../src/utils/fluidSpring.ts)已有可重定向选择底板 | 选择底板与对应内容一起表达切换关系，按真实差异调整；不新造分段组件 |
| [素材分类](../src/components/director/DirectorMaterialDrawer.vue)已有按需加载、状态保留与[内容过渡](../src/directives/contentMotion.ts) | 打磨角色／场景／描述切换时的局部交接，保留输入、搜索与选中状态 |
| [FluidTransition](../src/components/visual/FluidTransition.vue)、[useFluidSurface](../src/composables/useFluidSurface.ts)与[useFluidDialog](../src/composables/useFluidDialog.ts)已有浮层进退和来源定位 | 对一个真实弹窗及其内部展开形成一致体验，不全站替换浮层 |
| [图库来源过渡](../src/composables/gallery/useGalleryImageOrigin.ts)已有缩略图展开、返回来源和中断清理 | 作为卡片到详情的现成样板；无实际缺口时保留原实现 |
| [AppToast](../src/components/AppToast.vue)已有进退、拖走、撤销、悬停／焦点暂停 | 配合已有操作结果完成反馈，不重复增加通知层 |

## 统一的交互规则

1. **先响应操作，再呈现过渡。** 按下即有反馈，业务状态按真实事件更新；动画完成不是开始请求、允许下一次操作或宣告成功的条件。请求很快时不强制停留在“处理中”。
2. **保留空间关系。** 选中底板跟随目标；浮层从触发位置出现并沿对应路径收回；原位置已离屏或消失时使用短淡出，不制造错误的返回轨迹。
3. **连续操作从当前画面接续。** 快速切换、关闭后重开和反向操作可中断原过渡；不先跳回起点，也不把多次动画排队播放。业务本身要求的禁用和防重入继续生效。
4. **一次变化只突出一个主动作。** 选择项移动时，内容区轻量交接；避免父容器、全部子项、图标和文字同时各自入场。长中文按词组呈现，保持文字清晰。
5. **沿用既有节奏。** 现有按压 120ms、悬停 160ms、控件 200ms、表面 260ms 令牌作为调参起点；来源展开和连续选择优先复用弹簧。首批不全局改时长，不把固定时间当成所有组件的验收标准。
6. **动效可退出。** 高频更新使用 transform／opacity；完成、离屏、后台和卸载释放临时层与订阅。减少动态效果使用静态状态或短淡接，键盘焦点和有效操作不等待动画。保留双主题、AA 可读性及内容分级遮罩。

## M1 状态与选择的首批样板

**范围：入册工具栏、创作素材分类及必要的局部样式。**

- 入册操作在同一视觉位置经历“可保存 → 正在保存 → 查看作品册”；中文标签与图标轻量衔接，保持点击目标稳定。失败继续使用真实错误反馈并恢复重试入口，不能播放假成功。
- 角色／场景／描述切换时，底板指向新分类，内容在自己的区域交接；保留原有延迟加载、输入与滚动状态，不等待动画才开放新内容。
- 优先在具体消费者内完成；只有两个实际用例确实需要相同能力时才抽取。修改共享动效前明确直接受影响的消费者。

主要文件：[DirectorResultTools.vue](../src/components/director/DirectorResultTools.vue)、[DirectorMaterialDrawer.vue](../src/components/director/DirectorMaterialDrawer.vue)。[AnimatedSelection.vue](../src/components/visual/AnimatedSelection.vue)和[contentMotion.ts](../src/directives/contentMotion.ts)仅在具体缺口要求时调整。

**完成标准：**两处变化可明显感知来源与状态关系；连续切换无跳回或排队；入册的写入次数、失败重试、按钮转链接后的焦点与原行为一致。采用真实组件做同视口前后对照，保留操作过程的简短动效记录。

**必要验证：**优先复用 [DirectorResultTools.spec.ts](../src/components/director/DirectorResultTools.spec.ts)与[DirectorMaterialDrawer.spec.ts](../src/components/director/DirectorMaterialDrawer.spec.ts)。仅改样式时按样式范围选测；修改共享选择或过渡行为时，才补选对应已有用例。视觉确认覆盖受影响区域的双主题、鼠标连续操作、键盘与减少动态效果。

## M2 参数调整的即时反馈

**范围：绘制台 SD 参数中的 CFG 和采样步数。**

- 以现有数字输入和滑块为基础，补清晰的加减操作及轻量数字变化反馈；直接输入、大跨度滑动和精细加减都保留。
- CFG 沿用当前 0.5 步长及范围，采样步数沿用当前整数步长及范围。正在输入时不滚动或重建输入节点；连续加减合并到最新值。
- 批量生成的“1 张／3 张候选”保持当前业务选项。数字微调的设计不引入新的出图数量或自动提交。

主要文件：[GenerationParamsPanel.vue](../src/components/GenerationParamsPanel.vue)及其[现有样式](../src/assets/css/director/components/GenerationParamsPanel.css)。先完成这一处实际用例，再决定是否推广。

**完成标准：**每次操作的方向和值清楚，焦点稳定；直接输入与滑块仍可立即使用；参数值与既有 store 更新一致，动画不参与计算。

**必要验证：**复用相关参数行为覆盖和实际组件走查，仅确认本次改变的加减、边界、直接输入与减少动态效果。存在新增关键行为且已有覆盖缺口时，才在现有测试中补最小用例。

## M3 来源明确的浮层与内部展开

**范围：沿用作品配方弹窗，包含“完整配方／选择沿用”的内部切换。**

- 复用现有原生 dialog 和 useFluidDialog，让触发入口、弹窗与关闭返回保持空间联系。已有行为达到标准的部分直接保留。
- 选择沿用时，新增的选项区局部展开；周围内容稳定交接，避免整张弹窗再次入场。布局立即落定，必要的视觉位移使用 transform，不做逐帧高度动画。
- 保留原有忙碌状态、关闭约束、Esc、背景点击、焦点圈定与恢复。配方载入完成由现有逻辑决定，不能为动画延后提交或扩大恢复范围。

主要文件：[HistoryReuseDialog.vue](../src/components/director/HistoryReuseDialog.vue)及必要的局部样式；[useFluidDialog.ts](../src/composables/useFluidDialog.ts)仅按实际差异修改。图库既有卡片展开是复用参考，不列为重做任务。

**完成标准：**能看出弹窗来自哪个操作；内部切换没有整窗闪动；允许关闭时可立即响应，关闭后的焦点返回正确。只有视觉形变，没有配方语义变化。

**必要验证：**复用现有弹窗／配方覆盖，只走本次改变的展开、反向切换、键盘关闭与焦点恢复；不重新验收未改的全部弹窗。

## M4 列表变化与操作反馈的接续

**范围：作品册筛选、删除后的相邻卡片归位，以及现有撤销提示。**

- 对同一列表中仍保留、已经挂载且可见的卡片，尝试有限的位置衔接；新进入结果轻量出现，退出项及时让位。
- 同一帧合并几何读取与写入，复用已显示的缩略图。分页、虚拟滚动和大量筛选替换不逐项播放入场，也不为动效加载原图、扩大 DOM 或重算全库。
- 保留已有删除消散；本批只处理相邻卡片与列表状态的接续。快速连续筛选立即跟随最新条件；缩略图加载完成不触发整列重新入场。
- 复用现有删除／撤销业务和 Toast，在真实操作结果到达时给出清楚反馈；保留撤销期限、悬停／焦点暂停与失败信息。

主要落点：[GalleryView.vue](../src/views/GalleryView.vue)、[GalleryArtworkCard.vue](../src/components/gallery/GalleryArtworkCard.vue)、[useGalleryFilters.ts](../src/composables/gallery/useGalleryFilters.ts)、[useGalleryDeleteMotion.ts](../src/composables/gallery/useGalleryDeleteMotion.ts)。AppToast 仅在实际反馈衔接需要时调整。

**完成标准：**用户能跟住仍保留的作品；视线落点、滚动位置、键盘选择及撤销能力稳定。观察到高密度列表成本上升时收缩到单个内容区域交接，不增加全量动画来掩盖等待。

**必要验证：**复用筛选、卡片与删除相关已有覆盖；只为本次位置变化选择一组有代表性的可见卡片数据。若实际出现掉帧或额外布局成本，再做该操作的前后定向测量；不启动 009 的完整设备或长期负载矩阵。

## 交付与停止条件

每批先看一遍本批真实路径，记录需要改变的具体瞬间，然后合批实现和定向验证；不另建全站盘点、演示框架或专项测试工程。已有实现满足目标时，在状态中记录“已具备，保留”，不为完成清单而改代码。

每批交付包括可体验的真实组件、必要的前后动效记录、受控文件与简短 HTML 结果。按受影响布局选择一组桌面 CSS 视口；侧栏有独有风险时再补窄侧栏。记录实际视口、系统 DPI／缩放和浏览器缩放，未知项明示，不用 devicePixelRatio 代替设备验收。

只针对实际变化选已有检查；同一源码的有效证据复用，达到本批标准即交付。M1–M4 最后一次串联走查优先合入末批，不另跑一次全站回归。安装、真实模型、完整 GPU／功耗和其他设备验收保留各自范围，本计划不自动触发这些操作。

| 批次 | 当前状态 | 下次完成出口 |
| --- | --- | --- |
| M1 | 已完成 | 入册操作标签／图标在稳定目标内衔接，素材内容按分类方向交接；保留请求与焦点语义 |
| M2 | 已完成，并按反馈简化外观 | CFG ±0.5、Steps ±1；整体微调控件保留一条边界，加减键与数值不再各套方框；焦点、原输入与滑块保留 |
| M3 | 已完成；来源展开已具备，保留 | 配方标题位置稳定，选项区局部展开；反向切换、Esc 与焦点恢复通过 |
| M4 | 已完成；删除／撤销业务已具备，保留 | 保留节点有限归位，重挂卡片不叠加入场；分页追加和缩略图更新不触发列表重播 |

## 本次实施记录

受控产品文件为 `DirectorResultTools.vue`、`DirectorMaterialDrawer.vue`、`GenerationParamsPanel.vue` 及其 CSS、`HistoryReuseDialog.vue`、`icons/tool.ts`、`contentMotion.ts`、`useGalleryDeleteMotion.ts`、`gallery-artwork-card.css`，以及 `useGalleryWorkspace.ts` 的分页列表接线一行。仅为新增参数加减及定向过渡补最小覆盖；既有入册、分类、筛选与删除／撤销用例复用。

七个定向测试文件共 56 项通过；列表视觉修复后只复验其 14 项，其他相同源码证据复用。应用类型、定向 ESLint 与动效规则检查通过。真实页面在隔离 Rust 运行目录、模拟上游及私有浏览器中完成双主题、鼠标快切、键盘、减少动态效果和窄窗口走查；没有连接个人作品库或真实模型。

CSS 视口为 1440×960、1000×900，浏览器缩放为新上下文默认 100%；宿主 `AppliedDPI=168`（175%）只记录系统设置，不冒充物理显示器或 WebView2 验收。列表快切另采样 16 个真实浏览器帧，修复重挂卡片的 CSS 入场叠加后，每卡最多一条位置动画、没有短暂归零；这不是 GPU／功耗或长期负载结论。

HTML 报告、同视口前后录屏、双主题截图、帧数据与源码哈希位于忽略目录 `runtime/component-motion-20261005/`，入口为 `report.html`。源码与安装身份分别核对；本次未安装或发布，没有重建生产产物，现有安装身份保持原记录。

### 追加：全屏 Cover Flow 浏览与参数去框

用户确认升级现有全屏“立体观画”，沿用原图缩放和当前筛选。参照 [Planes Cover Flow 公开文档](https://useplanes.com/components/cover-flow)，在原 `GalleryOrbitStage.vue` 内完成中央作品／四张侧翼的层次、拖拽释放、滚轮连续切换与作品定位滑块；`useGalleryCoverFlow.ts` 使用既有 `FluidSpring` 承接速度和反向操作。图片读取继续由 `useGalleryViewer` 管理，邻近预览限制在左右各两张，只复用现有媒体或读取缩略图。直接操作会结束尚未完成的来源飞行；3D 容器不参与命中，避免挡住可见侧翼。

按截图反馈，CFG／Steps 去掉外层参数卡和加减键独立边框，数值与加减整合为一条控件；仅改变样式，保留原输入、范围、步长和键盘焦点标记。

两项新增手势用例与七项既有图片读取用例通过；应用类型、定向 ESLint（既有测试文件保留五条组件数量警告）、动效规则通过。隔离真实页面完成拖拽、滚轮、点击侧翼、精确定位、反向切换、缩放／平移、来源焦点和当前筛选走查。双主题覆盖 1440×960、1000×900 CSS 视口；新增说明与数值文字的最低实测对比度分别为深色 11.00、浅色 6.33。浏览器录屏为过程记录，不替代原生、GPU 或功耗结论。

本批 HTML 与录屏入口在 `runtime/cover-flow-20261005/report.html`。原站交互浏览器访问受权限限制，依据公开文档独立实现，验收的是项目组件；没有下载或安装 React 组件、调用真实模型、安装客户端或发布。

## 设计依据

[MetalForge Action Button](https://metalforge.xyz/interactions#component=action)、[Segmented Control](https://metalforge.xyz/interactions#component=segmented)、[Quantity Stepper](https://metalforge.xyz/interactions#component=stepper)与[Toast](https://metalforge.xyz/interactions#component=toast)用于理解局部变形和状态衔接，页面演示不等于项目实现或性能证据。2026-10-05 登录后实际查看了交互；代码导出显示需要 Pro，本计划不依赖购买或复制未取得的源码。

具体外观遵循 [DESIGN.md](../DESIGN.md)，交互细节参考已有 [apple-design](../.agents/skills/apple-design/SKILL.md)。执行规则沿用 [AGENTS.md](../AGENTS.md)与[工作流](../docs/workflow.md)，不在本专项另建一套门禁。
