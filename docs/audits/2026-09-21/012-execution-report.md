# 012 全站页面与功能体验执行报告

本任务由单主会话独立实施，没有调用子代理或另建任务。起点为审计包 `73055d5847c8f5b22c25d32373344a8662285f65`，受审源码为 `2966392`，隔离分支为 `codex/012-page-experience-polish`。011保护继续保留。

已完成办公机审计、必要修复与证据登记。217个稳定功能ID全部保留并有处置，38项涉及直接修复/优化，85项仍含主力机条件。**不声称217项所有状态排列或真实模型/设备均通过。** 同步筛选、只读内容和导航不制造不存在的取消/保存状态；共享原语按实际依赖复用证据。

最终structure模式全量门禁通过：21步质量检查、1145项前端测试、1078项Node测试通过（另2项条件跳过）、35个契约文件和构建预算。浏览器按文件/项目/标题去重，608项中604通过、4项私有模型条件跳过，无未解决失败；最终构建另重跑42项受影响用例全通过。工作台139.8/140 KiB，未放宽预算。最终112个页面组合无加载探针错误、页面级横向溢出或main数量异常。

配套：[逐项矩阵](012-page-function-matrix.md)、[执行证据](012-execution-evidence.json)、[计划](../../../plans/012-page-experience-polish.md)。本轮没有真实生成、下载模型、启停真实服务/隧道、操作生产库、安装或公开发布。D项不因模拟通过而消失。

## E0 环境

按锁文件安装依赖，无版本升级。独立临时网关、模拟上游、非持久 Edge 浏览器复采18应用与10文档×两主题×两宽度，共112默认组合；无加载探针错误，构建身份在运行中不变。原始证据位于本工作区 `runtime/audit-012/`，执行日志位于其 `execution/` 子目录。没有操作生产数据、真实模型、安装器或真实服务。

## E1 剧本交接

F01：`ScenarioView.vue` 的绘制链接同时传递当前合法角色及故事 ID。保留历史 scenario-only 默认宁宁；不改剧本、参数或编译。

- `usePromptDeepLink.spec.ts`：8项通过，覆盖两角色/旧链接、三故事、正文/词条/画幅及相同链接不重放。
- `page-experience-flows.spec.ts`：4项通过，双主题×两角色，每项走三故事→工作台→模拟请求→结果→返回；实际请求核对 character/LoRA，不只核对URL。已纳入 critical lane。
- 本批构建预算、应用类型检查通过。两主题夏目结果截图已查看；纯色图为模拟结果，不证明真实模型画质。
- 工作台固定署名后续已改为中性引导并保留当前角色摘要；它与请求身份分别核验。

## E2 共享阅读与文档

9个缺失浅色的正式文档与内部模板接入 `light-theme.css`；10正式文档、模板及独立聊天窗均有唯一main和键盘跳转。主题按钮使用ArchiveIcon同源手绘路径，支持跨窗storage同步；文档更多菜单Escape返回焦点。浏览器标题与搜索沿用导航称呼，旧搜索别名保留。历史规范正文不重写。

11页×两主题×1440/390/320共66阅读组合及主题同步/聊天地标，8个浏览器用例通过。正文对比度对真实背景像素取最差值；双主题联系表已人工查看。像素采样的前两次脚本问题（渐变不能由纯色函数测量、后代强调字未隐藏）及模板注释误匹配均保留失败日志，修正后重跑通过。质量示例浅色评分条读数另发现对比度问题，增加主题底色，后续专项复验。

## E3/E4 已实施部分

模型资料页只请求LoRA目录，沿用store逐文件缓存与失败恢复；资料收录不再声称本机已就绪。仅两条明确的V21角色映射提供“用此角色绘制”，不会注入任意LoRA或强制切换版本；复制触发词沿用成功/失败反馈。目录加载24项定向测试通过；浏览器失败→重试→搜索→清空→夏目落地双主题通过。首次浏览器失败为测试假定末项是夏目，改为稳定目标链接后通过。

画风缺参考的占位紧凑化，明确文件加载失败与目录未连接；既有图片仍保持原布局。390px首个选用动作从基线y984提前至首屏，双主题已看图。工作台单画布DOM先于素材，窄屏画布起点从约y854提前到y311（增加角色摘要前测量）；宽屏继续网格三栏，当前角色摘要常显，移除固定错误署名。390/768/900/901/1280/1440双主题单实例、重排和专家模式检查通过，新增摘要及短窗口已定向复验通过。

## 工程验证与失败历史

默认门禁因缺私有参考素材和新增测试变量遮蔽document失败。类型错误已修复；按工作流使用 `AICS_REFERENCE_AUDIT_MODE=structure`，不修改pending/索引，不据此证明真实参考URL。最终门禁又暴露资源并发锁释放的ENOENT窗口，新增确定性故障注入后修复；15项恢复测试及5轮并发复验通过，随后完整门禁重跑通过。

首轮大集合570通过/29失败/4跳过。缺样张前提改用中性All级夹具；旧原画、room-signal、工作区条选择器对齐现有粒子展台、参考说明和真实列角色。维护取消文案修正为“未保存的修改”。保留原断言目的，不提高阈值或删掉失败项。

随后125项中116通过；余下定位到清空期间重读旧草稿、缺参考大框、过渡期对比度采样和远程控件定位。54项中53通过后，最后一项定位修正并定向通过；桌面三栏独立复验通过。最终42项锁定最终构建全通过。初始与后续结果均保留，不把重试历史抹掉。

## 主要修复

最终图片复查另发现本轮新增空画布类名与既有状态徽标冲突，造成窄屏文字竖列；已改为独立类名，补正文宽度/高度断言并重新看图，28项定向复验通过。“无横向溢出”本身不足以证明好读。

核对请求体又发现剧本横向推荐只写入SD字段，Anima仍发竖幅；现在推荐值进入现有跨引擎同步及白名单收敛流程，并清除旧场景绑定。两角色三故事以及存量热门/原场景的6个用例通过宽高、身份词与LoRA断言。当前托管模型不支持1344×768时，沿用既有规则收敛为1216×832；没有扩大尺寸白名单、改变剧本推荐值或重写提示词。按[studio-prompt-craft](../../../.agents/skills/studio-prompt-craft/SKILL.md)复核最终请求边界，实际模型Token计数和真实画面仍D；不把字符数当Token数。

| 问题 | 最终处理及实际边界 |
| --- | --- |
| F01 剧本选角丢失 | 链接携带角色；进一步修复存量popular主体残留，复用既有切回studio流程。两角色三故事、旧链接、热门上下文、故事草稿与mock最终请求均核对；真实画面D |
| F02/F09 假浅色与地标缺失 | 当前文档/模板引入真实浅色样式，文档与聊天窗唯一main和跳转。实测颜色、背景像素对比度、键盘、320px与200%文本 |
| F03 画布顺序 | 单一画布DOM先于素材，桌面仍三栏，角色摘要常显。短窗口保留生成操作，成图不裁切 |
| F04 大块空参考 | 画风、光色手帖、剧本、工作台缺参考紧凑化；注册过的图片失败保持框体，避免误点。已选场景去掉重复初始引导，不隐藏失败/取消提示 |
| F05 资料与安装混淆 | 只加载LoRA目录、拒绝坏结构、复制触发词、两条明确角色入口；其他条目仅供参考，不注入任意模型或安装资源 |
| F06 名称漂移 | 路由标题与搜索对齐导航对象，旧别名/URL保留 |
| 跨窗删除后草稿复活 | 清空时取消延迟保存；接收标记只清内存，不在删除过程重读旧记录。两房间及独立窗清空/重载/再输入实测 |
| 色彩重新选择丢焦点 | 关闭结果后返回当前色板按钮，双主题键盘验证 |
| 远程状态不一致 | 场景成人可见性使用isLocalStudioHost，显示“仅限本机”；非本机域名夹具与既有服务端拒绝契约分别验证 |
| 资源恢复偶发ENOENT | 允许缺失路径时处理lstat→realpath间正常释放，链接/越界/活锁保护不放宽；故障注入、并发与完整门禁通过 |

## 视觉证据

对比图左为本轮修改前，右为最终默认状态；不是实际模型画质验收。112项默认采样包含加载/未连接状态，功能结果另由测试证明。原图哈希与构建身份登记于执行证据。人物粒子采用减少动态效果，不从截图推断真实GPU质量。

| 范围 | 深色390px | 浅色390px |
| --- | --- | --- |
| 绘制工作台 | [前后](012-visuals/director-dark-390.webp) | [前后](012-visuals/director-light-390.webp) |
| 画风 | [前后](012-visuals/style-dark-390.webp) | [前后](012-visuals/style-light-390.webp) |
| 模型资料 | [前后](012-visuals/lora-dark-390.webp) | [前后](012-visuals/lora-light-390.webp) |
| 色彩情绪 | [前后](012-visuals/color-dark-390.webp) | [前后](012-visuals/color-light-390.webp) |
| 剧本 | [前后](012-visuals/scenario-dark-390.webp) | [前后](012-visuals/scenario-light-390.webp) |
| 创作手册 | [前后](012-visuals/manual-dark-390.webp) | [前后](012-visuals/manual-light-390.webp) |

全站桌面最终联系表：[深色](012-visuals/app-final-dark.webp)、[浅色](012-visuals/app-final-light.webp)。以下各页同时记录美术、阅读、交互、正确性、恢复和效率；达标现状保留。

## G

**全局 G01–G18。** 保留品牌、肖像和导航层级；修复文档主题/图标/命名。更多菜单、搜索IME、快捷键、确认取消、焦点返回、玻璃辅助显示与缓存路由复用既有机制。任务中心额外种入六状态，旧running正确转待检查且不自动重发；筛选与结果路由实测。备份导出/损坏拒绝/原子恢复、全库搜索和图片边界有隔离断言。

证据：navigation-popover/navigation-fluidity、detail-polish、studio-tabs-tools、data-boundaries、flows、a11y-device、glass-material-modes及额外任务记录。3000作品首屏60项，10000作品最旧记录可检索；自动化操作耗时不是INP。设备与真实任务D。

## P01

**首页 P01-01–07。** 保留封面、首次创作/最近作品优先级、无历史回退。角色按钮标注“视觉”，不覆盖已有草稿身份；缺图有文字回退，作品/场景按稳定ID恢复。未增加重复卡片或静态肖像假动画。

源码：HomeView.vue。证据：studio、experience-polish、home-image-recovery、illustration-recovery及默认双主题图；原页面/肖像保留。

## P02

**灵感场景 P02-01–10。** 保留搜索、组合筛选、收藏/隐藏恢复、分页与故事抽屉。修复非本机成人提示/过滤一致性，服务端授权独立保留；零结果重置、失败重读、返回位置与焦点有证据。

源码：SceneExplorerView.vue/useSceneExplorerWorkspace.ts。证据：scene-browse-artbook、flows、resource-recovery、navigation-fluidity和新增非本机域名夹具。本页没有独立复制按钮，原登记复制部分归P04-10，不新增重复入口。

## P03

**角色场景 P03-01–07。** 保留桌面目录、窄屏同状态弹窗、人物审美与蓝图关系。核对筛选、跨断点、选择/返回焦点、失败重读、popular↔studio交接。pending仍为占位。

源码：PopularSceneExplorerView.vue及目录/选择composable。证据：scene-browse-artbook、anima-quick、flows、library-concurrency、resource-recovery。真实服装/镜头/构图D。

## P04

**绘制 P04-01–23。** 画布与角色摘要优先，短窗口和缺参考更紧凑；基础/专家同草稿与按需加载保留。角色/热门/双人、三引擎、场景/随机/撤销/历史/深链、请求、失败恢复、保存/比较/换装UI和视频交接分别核验。

源码：PromptBuilderView.vue、director布局/参考组件、usePromptDeepLink.ts。证据：page-experience-workspaces/flows、flows、anima-quick、workbench-loading、random-inspiration、expert-workspace、office-code、compare-snapshot-lifecycle、studio/experience-polish。不改模型参数规则、提示词/负向、服装、蓝图、评级或定稿源；真实Token与画面效果仍D。

## P05

**故事短片 P05-01–13。** 保留四模式、单成片区和不可用说明。首尾帧、草稿、画幅时长、查询恢复、队列取消、分镜顺序/总时长、首帧总览与按钮调序有证据，没有改变能力矩阵。

源码：VideoStudioView.vue/ShotListEditor及视频状态逻辑。证据：video-artbook、storyboard-artbook、interaction-polish、detail-polish与视频路由契约。真实H3/Wan、过渡/拼接与GPU取消D。

## P06

**角色房间 P06-01–16。** 保留舞台/对话比例和沉浸模式。修复跨窗清空草稿复活；连接、凭据、音量与外观不清除。长回复/返回最新、IME、配置、未来版拒写、流式/工具/停止、记忆/归档/档案及合成语音权限有证据。

源码：useChatConversation.ts/useCharacterRoomSession.ts。证据：data-boundaries、flows、companion-focus、room-experience、office-code与聊天单测/契约。真实麦克风、私有模型及音画同步D。

## P07

**参考画册 P07-01–08。** 保留与个人作品区分、完整比例、单筛选条与灯箱。未连接/空目录/筛选空集区分；随机限定合法集；故障图可关闭/恢复，返回位置不抢滚动。

源码：ShowcaseView.vue及manifest/灯箱逻辑。证据：studio、detail-polish、resource-recovery、navigation-fluidity与远程内容契约。中性夹具不是交付素材，真实审核目录/评级D。

## P08

**我的作品 P08-01–12。** 保留自然比例、作品信息与存储身份。空集、6张中性横竖方图、3000/10000记录覆盖渐进渲染与全库检索；收藏、项目、多选、对比、软删恢复、查看器、下载/配方与无图旧记录走既有保护。较大集合覆盖300/1k规模风险，不等于硬件峰值测量。

源码：GalleryView.vue、galleryStorage和查看器。证据：gallery-layout、data-boundaries、interaction-polish、studio、github-reference、compare-snapshot-lifecycle、flows。生产库未触碰，真实手势/原生内存D。

## P09

**角色档案 P09-01–09。** 保留粒子参数、动态切人和原画模式；不为测试恢复永久原画。目录、断点、参考拒绝/故障、原图/缩略图回退和角色入口有证据。

源码：CharacterView.vue/CharacterParticleStage及目录/参考组件。证据：character-particle-stage、particle-gpu、particle-render-cache、scene-browse-artbook、resource-recovery、illustration-recovery。七视角实物、私有参考和GPU质量D。

## P10

**画风 P10-01–05。** 缺目录参考压缩为空态说明，配色与选用前移；已登记图片失败保留框体。有图/无图分别验证，mood与配色数据不变。

源码：StyleView.vue。证据：page-experience-workspaces、artbook-completion及前后图。真实参考和生成调色效果D。

## P11

**模型资料 P11-01–05。** 资料、历史评测、本机可用性分开。只读LoRA目录并拒绝坏结构；失败重试、搜索清空、触发词复制有证据。两条明确角色映射可从popular切回studio并保留故事；其他条目只供参考，不安装或注入任意模型。

源码：LoraView.vue/sceneStore.loadLoraCatalog/usePromptDeepLink.ts。证据：sceneStore.lora/sceneStore单测、page-experience-workspaces/flows。真实安装由主力机工作台检测，资料页不冒认。

## P12

**场景维护 P12-01–18。** 保留七区、列表详情和草稿/项目分层。编辑/复制/取消、完整/增量导入、预览、冲突、迟到回执、新编辑保留、桌面只读与拒绝写入有证据。浏览器只发送中性模拟载荷，服务端写盘/备份/回滚使用完整临时源。

源码：SceneManagerView.vue及maintenance组件/服务。证据：scene-maintenance-workspace、scene-change-set、studio、flows与maintenance recovery/save/transaction/blueprint/read-barrier契约。未声明API在夹具中拒绝，生产data没有保存。主机项目/真实参考D。

## P13

**色彩情绪 P13-01–06。** 缺参考更紧凑，观察文字与有图完整展示保留。实际复制、TXT下载和复制拒绝已记录；重新选择返回色板焦点。色号只读，不虚构逐色复制入口。

源码：ColorScriptView.vue/ColorLightNotebook.vue。证据：artbook-completion、page-experience-workspaces和额外双主题下载/复制记录。提示词/色板原文未改，真实光色画面D。

## P14

**剧本 P14-01–06。** 缺封面紧凑化，三故事各幕原文保留。两角色每幕复制、参数展开、选择与整本分镜顺序有证据；绘制链接和热门主体残留修复，视频路径原样保留。

源码：ScenarioView.vue/scenario-artbook.css/usePromptDeepLink.ts。证据：storyboard-artbook、page-experience-flows和深链单测。实生成分镜与连贯性D。

## P15

**404 P15-01–03。** 保留独立标题、缺图说明、三个返回入口与旧地址兼容。没有保存、取消、生成状态，不制造相应测试。

源码：NotFoundView.vue与路由/重定向。证据：a11y-device、studio、illustration-recovery及HTTP/文档契约。两主题画面保留。

## P16

**桌面陪伴 P16全项。** 保留默认纯角色、显式控制区、右键/键盘、角色设置、勿扰与提醒。窗口命令、聊天/房间交接、输入/停止、导入和权限用桥替身与临时数据；随仓Live2D浏览器测试不等同原生设备。

源码：CompanionView.vue及行为/语音/桥接composable。证据：studio、companion-focus、desktop-personalization、room-experience及单测。透明/穿透、多屏DPI、睡眠、真实音画D。

## P17

**独立聊天窗 P17-01–09。** 补唯一main与跳转，保留log、输入名称、拖动区域。清空同步取消旧保存，不重读删除中的内容；角色/历史、发送回执、IME、主窗状态及完整房间交接有证据。

源码：CompanionChatView.vue/useCompanionChatWindow.ts。证据：page-experience-docs、data-boundaries、studio、companion-focus、room-experience与relay单测。真实停靠/原生连接D。

## P18

**控制面板 P18-01–15。** 保留服务/分享/资源/诊断/桌面偏好分区，错误不冒认在线；配置失败可重试，停止仍需确认，诊断脱敏。资源恢复修复正常锁释放窗口，继续拒绝链接、越界、不确定所有者和未知版本。

源码：ControlView.vue、资源组件、resource-install-fs.ts。证据：control-layout、resource-library、interaction-polish、desktop-personalization、office-code和资源安装/恢复/网关契约。真实启停、GPU释放、隧道、下载/安装/更新D。

## D

**文档与附属 D01–D15。** 10正式文档和模板完成主题/地标/阅读验证，标签搜索/空结果额外操作；320px、200%文本及质量评分读数核验。七份历史HTML和一份研究逐个检查原URL、响应、标题与阅读，不改历史结论；模板示例按钮不是业务入口。

源码：当前HTML、css/docs.css、tools/nav.ts/theme.ts。证据：page-experience-docs、studio及额外标签检索。托盘/快捷键只读查看tray.rs/main.rs，安装器只读查看Installer.xaml；实际托盘/UAC/DPI/读屏仍D。

## 旅程、复用与主力机步骤

J01/J02/J05/J06/J08由office-code、anima-quick、flows、图库/任务与额外任务记录支撑；J03补两角色三故事和存量popular；J04补色彩/模型及故事保留；J07补三窗清空；J09由中性载荷和完整临时源事务支撑；J10由远程内容、主机判定、只读和未知版本保护支撑。精确断言以测试与执行JSON为准，不只验URL。

复用范围：首轮未改模块保留通过证据；同名失败由后续实际结果覆盖，新用例另计。最终42项锁定最终构建，不表示在最终构建又运行了608项。未改行为/依赖的通过结果可复用，真实设备结果不可由模拟继承。原C/I/F/D列保留为历史，右列与执行JSON记录本轮边界。

主力机先核对真实资源路径、审核目录和引擎；再以中性场景检查两角色/热门/服装的实际Token与成图、换装/超分、四视频方式及音画。原生部分检查透明/穿透恢复、托盘快捷键、多屏150%/200%DPI、麦克风拒绝恢复、休眠/重连。安装器路径、空间、错误、取消及双主题只读源审不等于安装通过。各ID具体D步骤见执行证据。

没有依赖升级或exe变化，没有执行桌面同步；后续仅使用deploy-desktop.bat，UAC由用户操作。提示词/负向/蓝图/服装/评级/定稿data和参考素材目录没有修改，保护基线无需重捕获。提交按共享层、业务与报告分批，可按批次回退代码，不回滚用户数据。实现提交与检查的Git源码证明已绑定到9825862，audit:delivery无错误；主力机安装/设备/模型仍pending。提交链见执行证据，发布后的远端main SHA另存任务回执并在任务最终回复给出。
