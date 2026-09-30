# 全部前端与 Node 测试逐文件审查（2026-09-30）

原始库存为前端265文件、Node189文件，共454文件。每个原始文件只列一次；“合并”包括跨框架迁移，不能把独有断言的迁移算作删除。本文是决定摘要，逐声明索引、保留覆盖映射、源码哈希和实际输出留在忽略目录 `runtime/test-total-audit/`。结果与限制见 [实施报告](test-total-simplification.md)。

## 前端265文件

| 原始文件 | 决定 | 理由／保留边界 |
| --- | --- | --- |
| src/api/characterArtApi.spec.ts | 保留 | 保留资源地址校验、发布成功、广播禁用容错和读写竞态，均作用于真实 API/资源状态。 |
| src/api/client.refresh.spec.ts | 保留 | 保留四个不同刷新风险：旧 GET、重叠刷新、无 TTL 失效与失败时沿用缓存；作为 client.spec 重复段的唯一覆盖。 |
| src/api/client.spec.ts | 精简 | 删除两例与 client.refresh.spec 完全相同的刷新竞态；保留共享取消、TTL、逐消费者校验、对象隔离与写代际。 |
| src/api/generationApi.spec.ts | 保留 | 保留解码失败、未来任务态、有效零种子、队列字段、取消/超时与 URL 编码；Node 的创建/删除与错误恢复另有用途。 |
| src/api/maintenanceApi.spec.ts | 保留 | 保留维护增量请求、上传来源、安全 URL、结构与恢复错误边界；Node 的不可用/回滚和完整快照断言独有。 |
| src/api/resourceApi.spec.ts | 保留 | 保留资源面板 fail-closed 与导入/恢复只发送 release ID，防本地路径或来源外泄。 |
| src/api/runtimeTasks.spec.ts | 保留 | 保留空闲轮询复用、变化最小复制、分页原子发布、取消和跨工作区 epoch 隔离。 |
| src/api/videoApiResponse.spec.ts | 保留 | 保留完整投影与非法状态、进度、默认值、分镜类型防御，直接调用解码器。 |
| src/api/voiceApi.spec.ts | 保留 | 保留二进制载荷、排队时长、空音频、离线提示和三条取消/定时器生命周期路径。 |
| src/application/artwork/preferenceHistory.spec.ts | 保留 | 保留投影评分一致性、避免访问媒体/提示词 getter、百万字节记录的精简与输入隔离。 |
| src/application/artwork/saveGeneratedArtwork.spec.ts | 保留 | 保留保存依赖锁、提交事实捕获、输入隔离、精确补偿、未知提交及丢失 ACK 防误删。 |
| src/components/AppInteractionLayer.spec.ts | 保留 | 桌面 hash 路由与网页路径解析、焦点/按下意图及90ms悬停阈值具有独立交互风险。 |
| src/components/AppToast.spec.ts | 保留 | 失焦后到期与动态减少动效是不同生命周期回归，均操作实际组件状态。 |
| src/components/ChatMemoryPanel.spec.ts | 合并 | 在同一已挂载组件中先取消、再确认删除，保留破坏性提示参数与事件断言，省去重复挂载。 |
| src/components/CompanionOrbitMenu.spec.ts | 保留 | 扇区命中、二级Esc、不可用动作、穿透关闭与换角色时迟到回执分别覆盖真实失效路径。 |
| src/components/CompanionReplyBubble.spec.ts | 保留 | 回复收起/展开与聚焦暂停到期不同，计时器销毁覆盖实际资源所有权。 |
| src/components/ConfirmDialog.spec.ts | 保留 | 全部为破坏性确认的焦点、键盘、替换请求、嵌套弹层及卸载行为；不以浏览器覆盖替代。 |
| src/components/desktopImageResources.spec.ts | 保留 | SceneCard、画像和显影三种消费组件分别验证桌面runtime URL整合，不能仅用基础图片组件替代。 |
| src/components/DesktopTitleBar.spec.ts | 保留 | 浏览器隐藏桌面操作、初始状态查询竞态与订阅清理均有独立桌面壳风险。 |
| src/components/director/DirectorMaterialDrawer.spec.ts | 保留 | 不同素材切换保持DOM与输入值，以及专家模式撤销的回退是独立真实状态。 |
| src/components/director/DirectorResultShelf.spec.ts | 保留 | 用户显式存档与在途保存/切换预览生命周期不同，均保留。 |
| src/components/director/DirectorResultTools.spec.ts | 保留 | 主操作可达性、事件及生成锁定提示是有效组件集成契约；Tooltip组件测试不能代替正确按钮的提示接线。 |
| src/components/director/DirectorSceneReference.spec.ts | 保留 | 访问分级、manifest评级优先、角色/蓝图匹配、模糊保护及恢复/错误各自覆盖风险。 |
| src/components/director/DirectorStagePanel.reveal.spec.ts | 保留 | 同结果重播禁止、新结果/历史身份与在途保留上张成片覆盖真实父子协调。 |
| src/components/director/DirectorTagWorkbench.spec.ts | 合并 | 空词条无清空按钮并入取消/确认清空流程终态，保留同一条件的实际渲染断言且减少一次store/组件准备。 |
| src/components/gallery/CandidateCompare.spec.ts | 保留 | 关闭/重开/卸载时共享读信号与迟到图片拒绝是比较器独有所有权风险。 |
| src/components/gallery/GalleryProjectAlbums.spec.ts | 保留 | 空库、重复打开、解码失败替换与同地址/换地址/同tick重连是不同状态路径。 |
| src/components/gallery/PhotoSwipeStage.spec.ts | 保留 | 预取邻域、中途decode、A-B-A读取、decode异常、半初始化与外部URL所有权均不能相互替代。 |
| src/components/GlobalSearch.spec.ts | 保留 | ARIA、稳定选项ID、键鼠激活、全库索引/结果上限、取消竞态与失败重试互不重复。 |
| src/components/library/CharacterBookshelf.spec.ts | 保留 | 10条分别覆盖封面轮换、归组、分页、跨作品搜索、焦点/IME、图片失败与异步数据缩减，无空断言。 |
| src/components/library/CharacterDirectory.spec.ts | 保留 | IME两种标志、模态/普通Escape和正常方向键/Enter分别为必要键盘边界。 |
| src/components/maintenance/MaintenanceCatalog.spec.ts | 保留 | 只读状态仍可看提示词、复制JSON并禁止编辑，同时标题作为转义文本显示。 |
| src/components/maintenance/MaintenanceStyles.spec.ts | 精简 | 删除任意selector数量大于20的实现规模阈值；保留解析真实CSS后的跨页泄漏检查及作用域内正向匹配，空样式不能悄悄通过。 |
| src/components/maintenance/SceneImpactPreview.spec.ts | 保留 | 影响预览文字转义、列表键盘可达、失效与busy/重试/alert状态具有不同用户风险。 |
| src/components/ManagedDrawingRouteCard.spec.ts | 保留 | 数字0与带前导零字符串ID是两种真实类型边界，不合并成宽松匹配。 |
| src/components/showcase/ShowcaseAlbums.spec.ts | 保留 | 选中重复打开、安全封面限制和独立封面加载失败分别保留真实行为。 |
| src/components/showcase/ShowcaseSampleCard.spec.ts | 保留 | 全部保留：解码后的真实比例、旧load拒绝、R18敏感/模糊状态、来源尺寸、大图CTA及错误占位是有效独有回归。 |
| src/components/ui/StudioMediaPlayer.spec.ts | 合并 | 合并相同视频准备的原生控件与ARIA运输栏检查；修正原复位测试从未建立进度/错误的问题，现在先建立45秒进度和真实error，再断言换源归零。 |
| src/components/ui/StudioSearch.spec.ts | 合并 | 同一输入组件内依次验证IME、Escape清空，再模拟新关键词和按钮清空/焦点回归，省去重复挂载。 |
| src/components/ui/StudioSelect.spec.ts | 合并 | 删除纯布局class锁定，原生select缺席并入名称检查，空串显示/回写合并；把Tooltip内部props检查替换为实际键盘聚焦显示提示并显式清理挂载。 |
| src/components/ui/StudioTooltip.spec.ts | 精简 | 删两条仅以data-anchor和子元素存在性代替布局/悬停结论的重复烟雾检查；动态anchor状态和实际焦点/悬停已经直接覆盖。 |
| src/components/video/useReferenceCards.spec.ts | 保留 | 角色/服装异步所有权、失败/占位排除、手工上传槽位并发与cast重映射是独立逻辑风险。 |
| src/components/video/useShotAiTools.spec.ts | 保留 | 建议目标字段、撤销时保留新图、防重入及旧改写/排序后review保护均为必要逻辑单测。 |
| src/components/video/useShotBatchMachine.spec.ts | 保留 | 准备锁、部分重试成功恢复轮询、取消循环与503/410恢复信息不同风险，保持全部。 |
| src/components/video/useShotFirstFrames.spec.ts | 保留 | 桌面持久任务卸载观察/显式取消与旧web任务取消语义不同，错误下载拒绝不可替代。 |
| src/components/video/useVideoFrames.spec.ts | 保留 | 缺失原图、重复提交再上传、准备中改图/移除、旧上下文竞态与卸载取消是不同边界。 |
| src/components/video/useVideoStudioDraft.spec.ts | 保留 | restore有效/缺失响应都可能污染新选择；卸载取消与旧reconnect404不能丢新任务分别保留。 |
| src/components/video/VideoGenerationBar.spec.ts | 保留 | 下拉类型映射、未就绪阻止提交、允许提交与准备锁是生成栏实际行为，不能用StudioSelect低层测试替代。 |
| src/components/visual/aiVisualLifecycle.spec.ts | 保留 | 全部13条真实Canvas/帧队列/资源所有权测试保留；它们支撑删除相邻纯class/方法存在性检查。 |
| src/components/visual/AnimatedSelection.spec.ts | 合并 | 把两条只断言指示节点存在的假跟踪测试合并为真实几何跟踪：按钮及Tooltip嵌套链接的A→B选择变化都验证绘制宽度/位置；保留背景暂停行为。 |
| src/components/visual/BorderBeam.spec.ts | 合并 | 删除standalone/色彩class枚举，并把slot/active/glow三条同准备渲染测试合并为同一实例的状态切换；生命周期/低动效单测仍在。 |
| src/components/visual/CgImageReveal.spec.ts | 精简 | 删除triggerReveal仅为函数的重复存在性检查；生命周期测试实际调用重播两次并验证只保留一条frame loop。保留公开imgClass透传、alt、点击和错误事件。 |
| src/components/visual/ImageSplitCompare.spec.ts | 保留 | ARIA焦点和值、键盘范围及真实split style同步是实际比较滑块契约，保留。 |
| src/components/visual/interactionCompositor.spec.ts | 精简 | 删除题为拖拽但从未发送拖拽事件、只检查节点及is-panning缺席的烟雾测试；删除SVG形状检查，保留具名缩放与实际键盘平移。 |
| src/components/visual/RouteAtmosphere.spec.ts | 保留 | 装饰层无焦点/读屏且不拦输入的唯一局部契约保留，未因class断言一概删掉。 |
| src/components/visual/RuntimeImage.spec.ts | 保留 | 桌面runtime断开、恢复、native图片属性及本机源覆写是基础图组件的真实消费行为。 |
| src/components/visual/ThinkingOrb.spec.ts | 合并 | 删preset/paused纯class检查并合并状态ARIA两次挂载，改为同一实例切换状态和名称；实际冻结/恢复/释放仍由生命周期测试验证。 |
| src/components/visual/ToggleSwitch.spec.ts | 精简 | 删除icon-only class正反枚举，保留用户可见标签、slot文字、真实鼠标/Enter事件与disabled/external更新边界。 |
| src/components/visual/VoiceGlow.spec.ts | 精简 | 删processing/variant class枚举；保留装饰ARIA与manual meter行为，新增detach后level归零使清理断言覆盖实际状态变化。 |
| src/components/visual/ZoomableImageViewer.spec.ts | 保留 | 即时缩略图、decode换原图保持节点、旧decode拒绝与失败保留缩略图是不同图片体验边界。 |
| src/components/VoiceStudio.spec.ts | 合并 | 把字幕/日文稿可访问名称放进已有生成快照流程，减少同一复杂面板的重复挂载；保留全部异步场景。 |
| src/composables/chat/useCharacterPetControls.spec.ts | 保留 | 动作/表情白名单、旧角色拒绝、晚到motion所有权和说话/减弱动效限制均为独立行为。 |
| src/composables/chat/useChatArchiveStorage.spec.ts | 保留 | 跨窗口增删epoch、Web Locks拒绝、版本/原件保护、失败重试与未知角色迁移不重复。 |
| src/composables/chat/useChatConversation.spec.ts | 保留 | native与gateway工具取消是不同边界；流中断保留文本、工具错误、草稿防抖与轮数上限均有效。 |
| src/composables/chat/useChatStorage-credentials.spec.ts | 保留 | 安全凭据迁移写回、普通保存不泄漏、并发save/clear及默认宿主优先级各有独立风险。 |
| src/composables/chat/useChatStorage-persistence.spec.ts | 保留 | 偏好小写入与失败重试、跨窗口draft、零音量、现代/旧备份、IndexedDB归档错误各有独立断言。 |
| src/composables/chat/useChatStorage-sync.spec.ts | 保留 | reset epoch与流token更新分别覆盖；真实会话跨窗流转不替代数组/对象身份保留断言。 |
| src/composables/chat/useChatStorage-version.spec.ts | 保留 | 支持版本迁移、未来/非法版本拒绝、加载后版本变化以及归档/记忆备份分属持久化入口。 |
| src/composables/chat/useChatStorage-volume.spec.ts | 精简 | 删除独立静音往返用例；persistence 文件已覆盖 setVolume(0) 写入/重开、失败重试和导出，保留数值钳制。 |
| src/composables/chat/useCompanionChatWindow.spec.ts | 保留 | 录音隐藏/忙状态取消、TTS后恢复、manual重复草稿与wake/end会话分别走不同状态边界。 |
| src/composables/chat/useConversationReading.spec.ts | 合并 | 初次打开滚到末尾并入已有读者位置/返回最新生命周期，用一次挂载保留全部断言。 |
| src/composables/chat/usePetGestures.spec.ts | 保留 | 显式菜单、模型拖动阈值、控件不拖动及双击角色打开聊天具有可观察结果。 |
| src/composables/chat/useStageFraming.spec.ts | 保留 | 异常数值钳制、room/companion独立持久化和换角色不覆盖默认值不重复。 |
| src/composables/creationRecovery.spec.ts | 保留 | 跨store提交上下文、默认仓库软删撤销、分镜交接取消、立即离页draft和晚到临时图片释放为整合风险。 |
| src/composables/gallery/galleryHelpers.spec.ts | 保留 | 严格按实际ID定位，数字/持久化字符串与不存在ID不得退回列表位置。 |
| src/composables/gallery/galleryMutations.spec.ts | 保留 | 收藏写入串行/回滚、删除确认、200条批次部分失败和不确定结果重新读取覆盖不同失败时序。 |
| src/composables/gallery/galleryStorage.spec.ts | 保留 | 旧读取不能覆盖新结果、旧finally不能清新loading、失败保留视图并重试分别验证状态所有权。 |
| src/composables/gallery/useAlbumNavigation.spec.ts | 合并 | 初始视图与还原筛选断言并入现有画册往返流程，省去重复挂载，保留焦点和过期恢复取消。 |
| src/composables/gallery/useGalleryExports.spec.ts | 保留 | 原始字节/扩展名、PNG零参数、native失败与缺原图重试、读取中切图的冻结目标有效。 |
| src/composables/gallery/useGalleryFilters.spec.ts | 保留 | 明确tag、严格项目ID、URL重置、离屏分页和搜索索引只构建/释放一次是不同可观察边界。 |
| src/composables/gallery/useGalleryProjectAlbums.spec.ts | 合并 | 严格ID成员判断并入计数与空画册响应流程；缩略图优先、缓存驱逐及不安全URL仍独立保留。 |
| src/composables/gallery/useGalleryViewer.spec.ts | 保留 | 换图/关闭/卸载的AbortSignal及晚到结果不分配URL直接检验读取租约与资源释放。 |
| src/composables/gallery/useGalleryWorkspace.spec.ts | 保留 | 真实KeepAlive再激活、viewer关闭反转、40张原图上限、8并发缩略图、筛选后的队列淘汰均保留。 |
| src/composables/gallery/useMasonryWall.spec.ts | 合并 | 无准备的空输入边界并入正常列分配用例，保留平衡列和非法比例不丢条目断言。 |
| src/composables/generation/useAnimaInpaint.spec.ts | 保留 | 确认前不上传、模型LoRA提交快照、热门身份绑定、错误引擎与上传失败重试分属不同输入路径。 |
| src/composables/generation/useAnimaSession-races.spec.ts | 合并 | 吸收main重复的cancel终态/DELETE断言，以及Node dispose与引擎变更仍按原路径poll/cancel的独有覆盖；status pause补真实abort且不动running。poll验证使用fake clock驱动实际循环。 |
| src/composables/generation/useAnimaSession.spec.ts | 合并 | 主文件submission-cancel与races的failed ownership重复，合入后者；从Node16声明接收原来未覆盖的尺寸/绑定、payload授权、发现白名单及两引擎完整成功→失败stash恢复和提交快照。 |
| src/composables/generation/useSDGenerate-durable.spec.ts | 保留 | 桌面离页只释放观察与显式取消按原request key是两种必要生命周期语义。 |
| src/composables/generation/useSDGenerate-results.spec.ts | 保留 | 待提交/失败不改旧LoRA、成功刷新、clear/adopt、响应/图片body迟到和poll delay取消分别保留。 |
| src/composables/generation/useSDGenerate.spec.ts | 保留 | 惰性输入冻结、截止期删job、初始化前取消、晚接受删除以及provider未知进度不重复。 |
| src/composables/generation/useSDQueue-restore.spec.ts | 合并 | 接收主队列文件的基础恢复计数断言，去重/容量/在途/无容量不暂停/已完成批次进度均保留。 |
| src/composables/generation/useSDQueue.spec.ts | 合并 | 基础恢复的计数与暂停断言移入 restore 文件去重用例，避免两套相同恢复准备；入队进度、失败重试和中途追加仍保留。 |
| src/composables/indexedDbRecovery.spec.ts | 保留 | image/KV连接失败阶段与连接复用、versionchange释放、count只读计数存在独立断言。 |
| src/composables/live2d/motion.spec.ts | 保留 | 20轮动效偏好切换保持同一session、不重新装载，destroy后不再启动时钟，防资源重复占用。 |
| src/composables/live2d/parameterFrame.spec.ts | 保留 | 模型作者的非单位/反向参数端点与NaN/负值安全回退为真实参数写入契约。 |
| src/composables/live2d/pointerGaze.spec.ts | 保留 | 每帧合并100个事件、当前布局/桌面坐标转换、mouseleave与隐藏/替换session丢弃旧帧不重复。 |
| src/composables/prompt/applyInterrogateResult.spec.ts | 保留 | 不同反推写入模式均拒绝历史demo结果，不污染既有标签与描述。 |
| src/composables/prompt/batchAnimaJob.spec.ts | 保留 | 已接受未知任务重试复用稳定key与卸载只停止观察、不取消或重复提交是不同持久任务风险。 |
| src/composables/prompt/promptBlueprintActions.spec.ts | 保留 | 完整导演决策/数值钳制、热门服装与Krea恢复、未知schema/缺人物无修改均保留。 |
| src/composables/prompt/promptVideoActions.spec.ts | 保留 | 成片交接遵循展示结果的冻结人物/服装上下文，拒绝读取后来编辑的表单。 |
| src/composables/prompt/useGeneratedSceneCapture.spec.ts | 保留 | 图片异步读取前冻结recipe并只释放自己URL；缺完成上下文不能借实时表单。 |
| src/composables/prompt/usePromptBatchRunners.spec.ts | 保留 | 原任务重试、只重试入册、成人权限、tag幂等、queue满时取消与多引擎seed/自然语言编译各有效。 |
| src/composables/prompt/usePromptDeepLink.spec.ts | 保留 | 忙工作台可重试、原始string ID、异步dispose、场景/情绪链接变化和用户手改不回放有独立入口。 |
| src/composables/prompt/usePromptDraft.spec.ts | 保留 | 合并保存、防抖dispose、脱离快照、恢复touch参数与持久化失败不污染当前表单均有效。 |
| src/composables/prompt/usePromptHistoryApply.spec.ts | 保留 | 清旧字段、热门决策、后端发现完成后的fallback报告、未知引擎不改及旧记录不能宣称精确复现。 |
| src/composables/prompt/usePromptSdQueue-recovery.spec.ts | 合并 | 将同一无LoRA恢复准备的请求清理、不可变输入、实际种子写回和有效请求入册合成一条完整流程；异步快照隔离、失败种子和未知种子独立保留。 |
| src/composables/prompt/usePromptSdQueue.spec.ts | 保留 | 同时验证队列提交与manual保存两种上下文均保留原参数；recovery文件覆盖有效恢复请求等后续风险。 |
| src/composables/prompt/usePromptTagTools.spec.ts | 合并 | 四种分隔与空格归一合成同一混合粘贴，完整保留字符边界；输入已有词条的幂等性已由带重复反馈用例覆盖，IME、别名、权重语法与服装互斥保留。 |
| src/composables/prompt/usePromptWorkspace.spec.ts | 保留 | View绑定边界、单draft订阅、场景动作与链接重用、生成失败保留参数、dispose后不续初始化均有效。 |
| src/composables/prompt/useResultShelf.spec.ts | 保留 | 历史recipe不变、换项旧读丢弃、任务poll不重抓缩略图、卸载abort和remote私有缩略图门禁均保留。 |
| src/composables/prompt/useTempResult.spec.ts | 保留 | manual重入/重试、三个引擎auto入册乱序、失败旧任务、discard/dispose与临时blob指针竞态不重复。 |
| src/composables/scene/applyGeneratedSceneSettings.spec.ts | 保留 | 非法尺寸、身份决策清旧层、引擎先切再写、模型缺失报告、合法零值及切换守卫拒绝覆盖不同风险。 |
| src/composables/scene/sceneExplorerOrdering.spec.ts | 精简 | 删除复制生产curation评分和排序算法的expected计算；60条模糊fixture缩为6条业务样本，各模式写死期望顺序，保留重复curation ID、personal/used/favorite、numeric排序、relevance稳定tie及源数组不变。 |
| src/composables/scene/useCharacterArtManager.spec.ts | 保留 | 版本化图片替换/资源释放、builtin恢复、确认/冲突保留候选、解码拒绝与操作重入风险各有效。 |
| src/composables/scene/useDirectorPopularGenerated.spec.ts | 保留 | 生成场景不能自动覆写原Krea模型、推荐迟到丢弃与用户显式应用推荐分属不同意图。 |
| src/composables/scene/useGeneratedSceneSave.spec.ts | 保留 | 显式分级、唯一新场景、预览失效、确认丢失核对、只重试图上传与冲突后保留composition均保留。 |
| src/composables/scene/useMaintenanceCatalog.spec.ts | 保留 | 过滤/分页末页删除的选择有效性、源序不变、prompt字节与未知字段只读适配为独立行为。 |
| src/composables/scene/useSceneEditorModal.spec.ts | 保留 | 并发ID分配、未提交draft身份、sc1000+与安全整数耗尽、拒绝非canonical输入均保留。 |
| src/composables/scene/useSceneImportExport.spec.ts | 保留 | 长ID及未知字段、错误转义、完整快照确认与原子拒绝、空scene导出及只读门禁有效。 |
| src/composables/scene/useSceneMaintenance.spec.ts | 保留 | 增量save、pending本地编辑、并发写锁、409/恢复错误保留draft、预览abort与转义均有独立断言。 |
| src/composables/scene/useSceneManagerWorkspace.spec.ts | 保留 | 权威快照/版本配对、不可变baseline、normalized回执、reload/save期间编辑和ID分配为集成层风险。 |
| src/composables/showcase/useShowcaseAlbums.spec.ts | 保留 | 只计已装载项目、仅All封面、无安全封面保留入口和刷新不改源数据具有业务意义。 |
| src/composables/tasks/taskRecovery.spec.ts | 保留 | 已存backend查询、结果workspace路由、部分批次失败、网络错误不伪造终态与provider取消分支不同。 |
| src/composables/tasks/useBackendSelection.spec.ts | 保留 | 选项切换abort、离页迟到错误不发布与同任务失败重试去重各有独立风险。 |
| src/composables/tasks/useTaskMediaSource.spec.ts | 保留 | 旧任务不能借用新signal或取旧能力，卸载时abort及取消订阅为媒体租约边界。 |
| src/composables/tasks/useTaskRecovery.spec.ts | 保留 | 断网可重试、旧查询不覆写新终态、卸载abort、cancel必须fresh query确认不可互相替代。 |
| src/composables/useBackup.spec.ts | 保留 | 清理二次扫描/引用保护/锁失败、导出限制与取消、导入选择竞态和未知角色归档均为数据损失边界。 |
| src/composables/useCharacterArchiveNavigation.spec.ts | 保留 | 延后目录的deeplink、history返书架与focus、明确直达和未知/歧义人物拒绝各有结果。 |
| src/composables/useCharacterArtRefresh.spec.ts | 保留 | focus/cross-window刷新与channels/abort释放、runtime换身份清旧override及remote不访问均有效。 |
| src/composables/useCharacterAtmosphere.spec.ts | 保留 | 同步studio主题、热门下载迟到、keepalive恢复、销毁不改document与失败重试是不同所有权时序。 |
| src/composables/useCharacterPortraitTransition.spec.ts | 保留 | 真实画像飞行几何、裁切/blur拒绝、快速返回clone唯一性与减弱动效取消均保留。 |
| src/composables/useCompanionBehaviorRuntime.spec.ts | 保留 | DND不消费招呼、换角删除旧提醒、外部配置、安静时间、服务计数失败与affection无效值分属不同状态。 |
| src/composables/useCompanionClipboardImport.spec.ts | 保留 | 替换图片/文本释放URL、多个image输入在角色切换或卸载后不得发出、正常截图精确交接均有效。 |
| src/composables/useCompanionPerformance.spec.ts | 保留 | cue语音/情绪一次绑定、DND与用户音频优先、超时释放和声音所有权易发生独立回归。 |
| src/composables/useCompareSnapshots.spec.ts | 合并 | Node双快照轮转与token乱序已由Blob生命周期用例覆盖；唯一非blob URL直通合入现有spec，追加零fetch/create/revoke所有权断言。同步throw与延后reject是不同失败时序，保留。 |
| src/composables/useControlActions.spec.ts | 保留 | 配置提交防重入/失败可重试与等待重启不得使用旧共享配置为不同副作用边界。 |
| src/composables/useControlStatus.spec.ts | 保留 | 慢首次status不被poll饿死、Comfy readiness、编辑保留与已确认save、失败状态恢复均有效。 |
| src/composables/useDesktopInteraction.spec.ts | 保留 | F6焦点恢复、IME/表单不截快捷键、键鼠导航区分、显式外观及theme同步各有真实操作结果。 |
| src/composables/useDesktopUpdater.spec.ts | 保留 | 非桌面降级与检查只提示、必须显式install分属平台与安装意图边界。 |
| src/composables/useDesktopWorkspace.spec.ts | 保留 | 启动页恢复、成功导航记忆不带query、深链优先、不可相信目的地及router-ready前取消均保留。 |
| src/composables/useDesktopZoom.spec.ts | 保留 | native pending按键合并、网页不截shortcut和companion角色拒绝zoom为不同平台规则。 |
| src/composables/useFluidDialog.spec.ts | 合并 | 背景点击三种边界使用同一个真实dialog与矩形，省去重复dom准备；嵌套锁、native平滑滚动、route离开和focus释放均保留。 |
| src/composables/useFluidDialogU3.spec.ts | 精简 | 所谓曲线差异只断言默认原点且popover无断言；滚动锁重复 useFocusTrap 的嵌套与关闭测试。保留真实PromptComparePanel Escape接线并要求只发一次close。 |
| src/composables/useFluidSurface.spec.ts | 精简 | 删除选择器常量/默认props实现锁定和CSSStyleDeclaration字符串必然存在的空断言；保留真实帧进度、nested panel同步、自身panel原点、反转完成和清理。 |
| src/composables/useFocusTrap.spec.ts | 保留 | IME、嵌套/原生modal优先、动态Tab边界、背景focus纠正、缓存释放与opener恢复是各自风险。 |
| src/composables/useHomeHeroes.spec.ts | 保留 | 旧manifest不替代builtin、上传/恢复、确认换角、迟到响应与runtime身份改变分属不同数据所有权。 |
| src/composables/useHomeRecentWorks.spec.ts | 保留 | 优先缩略图不解码original、仅missing回退、换load/离页abort、只revoke自己Blob为资源边界。 |
| src/composables/useImageOriginTransition.spec.ts | 保留 | 请求policy、decode错误与总deadline、proxy迟到、关闭cache miss、裁切/blur与快速反转/卸载均为不同风险。 |
| src/composables/useInterrogate.spec.ts | 保留 | 防重入busy、拒绝demo清旧结果与超时abort可读错误分别检验生成入口。 |
| src/composables/useLive2D-api.spec.ts | 合并 | 删除Object.keys逐字公开API锁定；惰性初始状态并入真实口型调用，补齐原标题承诺的NaN断言，互动生命周期在其他Live2D文件保留。 |
| src/composables/useLive2D-browser.spec.ts | 保留 | expression异步保留、Cubism2参数、静帧/暂停delta、多session时钟不干扰和destroy迟到回调均保留。 |
| src/composables/useLive2D-interactions.spec.ts | 保留 | 作者eye/mouth端点、互动音量/禁言、短motion结束与entrance兼容、未解锁无动作/积分是有效断言。 |
| src/composables/useLive2D-lifecycle.spec.ts | 合并 | 所有目录/connect/session晚到、hidden/disable/timeout/destroy与恢复用例保留；在原destroy fixture补停用与resetWindowBounds真实调用，承接Node待删源码拼写护栏。 |
| src/composables/useLive2D-visibility.spec.ts | 保留 | hidden不能被resize复活、透明webview与native可见性、modelhost inset坐标分别验证原生overlay。 |
| src/composables/useLive2D.spec.ts | 保留 | 人物明确互动边界/未知拒绝、hitArea优先、目录输入转换以及作者口型/眨眼参数属数据契约。 |
| src/composables/useModelStudio.spec.ts | 保留 | 读取/preview/文件inspect迟到、参数测试复位、profile验证、revision rollback/deactivate与存储失败各有断言。 |
| src/composables/useNavigationFeedback.spec.ts | 保留 | 快慢路由、intent过期、旧取消/旧错误不清新pending、回当前页与真实失败恢复不能合并为同一风险。 |
| src/composables/useParticleLifecycle.spec.ts | 合并 | 首次挂载所有权断言并入20轮缓存开关压力流程；过期observer、调色帧取消与监听释放保留。 |
| src/composables/useParticlePerformanceLifecycle.spec.ts | 保留 | 应用覆盖OS偏好、deactivated不重建、可见性/效果模式不绕过reduced motion分别走不同输入。 |
| src/composables/usePolling.spec.ts | 保留 | 立即tick内部stop、sync恢复stop、queued stale callbacks、in-flight去重、false终止与暂停保持启动意图不重复。 |
| src/composables/usePortraitFallback.spec.ts | 保留 | 解码才成功、A-B-A晚事件拒绝、role/thumb变化重试和相同URL去重/空资源分别验证fallback生命周期。 |
| src/composables/useRandomInspiration.spec.ts | 保留 | 默认池、手动artist所有权、undo全字段、context/手改失效、候选deep copy与无数据不改均保留。 |
| src/composables/useResourceLibrary.spec.ts | 保留 | remote门禁、慢status去重、下载后import、task接受迟到/丢ack恢复、精确取消与离页只停止观察均有效。 |
| src/composables/useRouteRecovery.spec.ts | 保留 | 导航失败保留当前route并公开retry target，成功清恢复状态为业务错误边界。 |
| src/composables/useRouteTransition.spec.ts | 保留 | 真实hook/WAAPI时序、反转、peer层次、inert、失败可选能力和监听释放是独立风险；参数断言服务既定动效契约。 |
| src/composables/useRouteTransitionCache.spec.ts | 保留 | 20轮真实Vue缓存DOM复用与同URL新DOM仍进场，补充main hook mock的重复激活/节点身份风险。 |
| src/composables/useRuntimeImage.spec.ts | 保留 | 相同port的新epoch应重试、重复healthy无重试、A-B-A旧事件拒绝，避免以URL比较代替请求所有权。 |
| src/composables/useScrollReveal.spec.ts | 保留 | 仅观察当前page、缓存offscreen暂停和应用reduced motion接管迟装内容分别验证scope与偏好。 |
| src/composables/useTaskCenter.spec.ts | 保留 | 持久化hydrate/merge/tombstone、owner暂停与销毁、历史限额与水位确认、失败不伪造task终态覆盖数据与任务安全。 |
| src/composables/useTheme.spec.ts | 保留 | 实际DOM/色彩模式与持久化写入、非法存储回退及peer窗口storage事件是不同入口。 |
| src/composables/useToast.spec.ts | 保留 | 普通提示限额不丢undo、hover与keyboard延长有效期，计时边界与操作可达性独立。 |
| src/composables/useVisualActivity.spec.ts | 保留 | 应用动效、低玻璃/电池、隐藏tab、intersection与缓存route暂停均通过独立来源门控。 |
| src/composables/useVoice.spec.ts | 保留 | 音频回调/定时器释放、replay取消、翻译/合成旧请求拒绝、A-B-A warmup和播放错误不重播均有效。 |
| src/composables/useVoiceInput.spec.ts | 合并 | 已有ASR晚到响应拒绝与track/processor释放完整保留；Node token字符串检查移除前补cancel/release后迟到getUserMedia stream停止，明确麦克风授权与ASR不同竞态。 |
| src/composables/video/useVideoWorkspace.spec.ts | 保留 | offline draft、帧准备快照/防重入、任务记录失败、status迟到、新upload所有权和cached task观察恢复均保留。 |
| src/directives/contentMotion.spec.ts | 保留 | 同步布局读取陷阱与隐藏/卸载动画cancel是真正的渲染生命周期检查。 |
| src/live2d/adapterProfile.spec.ts | 保留 | 模型能力降级、backend隔离及参数校验是必须保留的底层编译契约。 |
| src/live2d/latestIntent.spec.ts | 保留 | 重复帧去重、忙桥只发最新终值、节流/即时情绪、拒绝后重试和迟到清理为必要并发逻辑。 |
| src/live2d/modelCalibration.spec.ts | 保留 | 翻转映射、normalized钳制、参数合法性与不可变输入有独立数值/边界风险。 |
| src/live2d/modelInspector.spec.ts | 保留 | 全部路径、资源、JSON/尺寸/数量/读取限制及指纹断言作用在真实生产函数，不能以浏览器happy path替代。 |
| src/live2d/modelParameters.spec.ts | 保留 | Core不同包装读取及损坏数据fail-closed是runtime参数快照底层边界。 |
| src/live2d/modelPreview.spec.ts | 保留 | 连接取消、session销毁、狭窄宿主适配、URL安全与分配限制具有资源/显存及导入安全风险。 |
| src/platform/characterArtState.spec.ts | 保留 | 保留响应式资源修订、桌面来源、pending 绕过和远程禁止本地覆盖。 |
| src/platform/desktop/artworkMedia.spec.ts | 精简 | 删除单独的并发原图读/无缓存用例，其成功行为已由首个共享传输中一方取消用例覆盖；保留最后取消、deadline、epoch、预览缓存与授权。 |
| src/platform/desktop/artworkRepository.spec.ts | 保留 | 保留桌面工作区身份、分页/离线快照、取消、精确批删、丢 ACK、预览容量与搜索索引失效。 |
| src/platform/desktop/bootstrap.spec.ts | 保留 | 保留协议、角色、来源和桌面双宿主能力解码，防非授权启动。 |
| src/platform/desktop/capabilities.spec.ts | 保留 | 保留导航角色授权、启动恢复后的接受以及监听器注销。 |
| src/platform/desktop/maintenance.spec.ts | 保留 | 保留落盘 ACK、编辑冻结、超时、取消、阻塞终态、写操作和 IME 防丢失。 |
| src/platform/desktop/maintenanceForms.spec.ts | 保留 | 保留真实 Vue API 表单编辑期间拒绝维护、无偷提交与关闭注销。 |
| src/platform/web/artworkBatchDelete.spec.ts | 保留 | 保留批删单事务/失败原子性/共享原图恢复；批量入口与单条存储回滚风险不同。 |
| src/platform/web/artworkReads.spec.ts | 保留 | 保留遗留迁移与取消前/取消后的不写入；迁移与引用隔离还由 artworkRepository.test 实际 KV 快照覆盖。 |
| src/platform/web/profileStorage.spec.ts | 保留 | 保留 Web/桌面资料权威切换、丢 ACK 同操作重试和离线启动写阻断。 |
| src/router/documentPolicy.spec.ts | 保留 | 跨CSP文档完整reload是安全路由边界，sessionStorage异常不能改变它。 |
| src/router/prefetch.spec.ts | 保留 | 路由数据所有权、并发query去重、失败重试与catch-all下载排除为不同逻辑风险。 |
| src/storage/artworkRepository.test.ts | 精简 | 删除被共享引用完整时序覆盖的删-恢复-再删计数用例；修正活图防误删夹具，让两个墓碑都真正过期；保留全部写失败回滚、恢复缺图与跨域图片引用保护。 |
| src/storage/artworkSession.spec.ts | 保留 | 保留跨窗口锁排斥、新窗口阻塞、暂存排斥、错误后重入与无锁拒绝；模拟锁管理器被生产调用，非夹具自证。 |
| src/storage/backupRestore.spec.ts | 保留 | 保留导入图片身份重映射、原子发表、并发设置不覆盖、校验前零写入和未知提交防误删。 |
| src/stores/promptBuilderCatalog.spec.ts | 保留 | 保留目录未就绪不能出图与失败后重试，不以空快照冒充就绪。 |
| src/stores/promptBuilderHistory.spec.ts | 保留 | 保留 Pinia 保存适配集成、发布时机、提交主体/默认值冻结、ID、错误与未知提交。 |
| src/stores/promptBuilderStore.spec.ts | 精简 | 保留参数、主体、词条开关契约；把恒可为真 typeof charPrompt 改成实际夏目身份 token，验证角色切换的派生文案。 |
| src/stores/promptHistoryStore.spec.ts | 保留 | 保留清空权威、删除/恢复持久化同步、陈旧读取不能复活作品及高并发 ID。 |
| src/stores/sceneBrowser.spec.ts | 保留 | 保留轻量浏览独立加载、共享请求、脱离快照和刷新代际，区别于工作室加载入口。 |
| src/stores/sceneStore.lora.spec.ts | 保留 | 保留独立 LoRA 目录需求加载、成功空缓存与 HTTP/结构失败重试。 |
| src/stores/sceneStore.spec.ts | 精简 | 删除单独 cache-version 检查；旧分片刷新竞态已断言新 DATA_VERSION URL，同时保留完整加载、轻载、状态恢复及快速切换。 |
| src/stores/videoStore.spec.ts | 保留 | 保留单图/分镜一次性消费、存储失败回滚、水合、换装 ID 与持久草稿/任务。 |
| src/types/artwork.spec.ts | 保留 | 保留公共类型编译契约、旧 ID/扩展字段/时间戳和结果身份映射隔离；expectTypeOf 由类型检查验证。 |
| src/utils/artworkSearch.spec.ts | 保留 | 保留完整万条索引、排除图像正文、稳定排序、无效 ID、日期兼容与编辑失效。 |
| src/utils/backupExport.spec.ts | 保留 | 保留真实导入往返、UTF-8 及 base64 容量、取消、严格失败、无效 ID 与 FileReader。 |
| src/utils/characterKnowledgeReliability.spec.ts | 保留 | 保留聊天记忆去重/版本、保存失败、角色隔离、长背景检索与请求刷新竞态。 |
| src/utils/characterPortraitAssets.spec.ts | 保留 | 保留真实资产字节 hash、不同身份不复用、pending 标识、派生血缘与 profile 地址，避免以占位充交付。 |
| src/utils/characterReferenceData.spec.ts | 保留 | 保留按人请求、并发去重、重试、刷新旧响应、404 删除与身份匹配。 |
| src/utils/characterSettingMemory.spec.ts | 保留 | 保留解析、真实资料兼容、结构条目、角色隔离、检索与条目上限；与 reliability 的长背景/旧字符串风险不同。 |
| src/utils/characterTheme.spec.ts | 合并 | 合并另一个 theme 文件独有的非法 hex 长度/颜色与四种 CSS hex 输入；移除重复 URL-invalid 子断言，保留162个校准输出、CSS 派生与清理。 |
| src/utils/characterTheme.test.ts | 合并 | 并入 characterTheme.spec，删除已由校准输出 hash 与普通角色 CSS 派生测试覆盖的 data/override 示例；只减少 worker 文件，不 skip 有效用例。 |
| src/utils/chatApiDrafts.spec.ts | 保留 | 保留凭据只驻内存、安全目标确认后再清除明文、失败保源与备份不含密钥。 |
| src/utils/chatInput.spec.ts | 保留 | 保留 IME、Shift+Enter 编辑和普通 Enter 提交/阻止换行。 |
| src/utils/chatRelayReceipt.spec.ts | 保留 | 保留真实 runtime 接受回执，IPC 成功不能冒充业务成功。 |
| src/utils/chatReset.spec.ts | 保留 | 保留全部内容域清理、设置保留、旧写不能复活、失败重试与 tombstone 发布前零删除。 |
| src/utils/chatTurnOwnership.spec.ts | 保留 | 保留共享锁竞争时拒绝发送及释放后重试。 |
| src/utils/clipboard.spec.ts | 保留 | 保留原生复制、模态框内降级、焦点恢复、双失败回报与作品副本 ID。 |
| src/utils/companionRegistry.spec.ts | 精简 | 去掉六个被随后的精确属性断言覆盖的 defined/non-null 断言；保留缺省角色、扩展角色、多外观与孤儿注册拒绝。 |
| src/utils/desktopImport.spec.ts | 保留 | 保留丢 ACK 读回确认、缺失/不可读/错误图片身份防误删以及批处理补偿失败。 |
| src/utils/downloadBlob.spec.ts | 保留 | 保留实际可连接下载锚点、立即移除与浏览器读取前 URL 保活/最终释放。 |
| src/utils/drawCapabilities.spec.ts | 保留 | 保留引擎产品能力、profile 覆盖与后台最高优先级，不把这些业务契约当无用常量删除。 |
| src/utils/fluidGlass-loading.spec.ts | 保留 | 保留动态导入在关闭/卸载后不可迟到复活，两种终止条件独立。 |
| src/utils/fluidGlass.spec.ts | 合并 | 把 selector 字符串自查并入已有真实 DOM 光学分配/回收测试，实际覆盖四种表面；去掉重复清空断言，保留透镜可读中心与极限位移。 |
| src/utils/fluidMotion.spec.ts | 保留 | 保留动效单 loop、反向保持位置、各偏好事件、隐藏/恢复、fallback、可重入完成及释放终态。 |
| src/utils/fluidSpring.spec.ts | 保留 | 保留物理动量、刷新率一致性、错帧与 reduced-motion；不是对实现公式的复刻。 |
| src/utils/franchiseLabel.spec.ts | 保留 | 保留真实目录中文系列、未知内容不编造、括号源同组以及同发行商不同作品不误合。 |
| src/utils/galleryThumbnailWarmup.spec.ts | 保留 | 保留桌面不整库预热、Web 可取消、不可见暂停、跨页锁去重及失败继续。 |
| src/utils/generatedSceneDraft.spec.ts | 保留 | 保留实际结果提示词/身份/参数快照、引擎字段一致、非法食谱拒绝以及重新编译后事件保真。 |
| src/utils/generationTask.spec.ts | 保留 | 保留 UI 任务态真实映射、异常进度与视频模型可执行/可用/模式边界。 |
| src/utils/highlightSearchText.test.ts | 保留 | 保留标记前后实体与正则元字符正确性，覆盖 HTML 注入风险。 |
| src/utils/historyRecipe.spec.ts | 保留 | 保留缺省来源说明、零值/旧数字、类型拒绝、扩展字段与非补造记录。 |
| src/utils/imageDecodeBudget.spec.ts | 保留 | 保留解码前巨大尺寸/动画/截断拒绝；有效 PNG 解码路径由 imageThumb.spec 同时覆盖。 |
| src/utils/imageThumb.spec.ts | 保留 | 保留真实 PNG 输入的 bitmap 成功/失败释放与 fallback URL 解码错误回收。 |
| src/utils/interrogateMerge.spec.ts | 精简 | 删除被更强多项结果断言覆盖的换装族及发色回归；把身份矩阵里重复执行的无身份姿势批次合入归一去重例；保留所有分类、服装、镜头、身份/动作边界。 |
| src/utils/localCompanions.spec.ts | 保留 | 保留目录失败重试、成功空缓存、并发去重和远程零请求。 |
| src/utils/localDiagnostics.spec.ts | 保留 | 保留凭据/用户内容/路径脱敏、身份关联、容量上限、独立快照、错误与取消。 |
| src/utils/particleDensity.spec.ts | 精简 | 删除 spacing 乘同一常量再比较的代数重复断言；保留四倍粒子实际点数/间距和宽限/低效/最大预算。 |
| src/utils/particleGpu.spec.ts | 保留 | 保留双主题 GPU pass、缓冲复用、容量尾部、主题切换、resize 与每种资源严格释放。 |
| src/utils/particlePortraitRevision.spec.ts | 保留 | 保留版本共用加载与头像替换后旧云不可回填。 |
| src/utils/particleQuality.spec.ts | 保留 | 保留慢帧触发、恢复滞回、下界、不振荡、隐藏时间与无效样本，循环是积累边界而非空等待。 |
| src/utils/particleReadability.spec.ts | 保留 | 保留实际表面上的描边、浅色填充亮度/色相与无效色安全输入。 |
| src/utils/particleScheduler.spec.ts | 保留 | 保留共享 RAF、频率、隐藏/恢复、同帧注册/取消与20轮监听 ownership，避免生命周期泄漏。 |
| src/utils/popularPortraitSource.spec.ts | 合并 | 把同一个 pending 角色的显示/未请求云合并；保留临时占位不能计交付和已发布头像版本缓存。 |
| src/utils/promptCatalog.spec.ts | 精简 | 每份真实目录只 parse 一次，继续核对字段/字节和引用保持，并保留嵌套非法字段拒绝。 |
| src/utils/promptCompiler.spec.ts | 精简 | 删除 Node test-prompt-compiler.ts 已以更强风格段落约束覆盖的 medium 防重复例；其余散文、媒介追加、无人物与配色路径保留。 |
| src/utils/promptPolicy.spec.ts | 精简 | 删除 Node test-prompt-policy.ts 中更完整 r15/r18 与 selectiveNegative 块已覆盖的两例；保留 ALL、triad、引擎负面、LoRA、镜头与冲突告警。 |
| src/utils/promptTagDictionary.spec.ts | 保留 | 保留中文/别名/权重语法、模糊匹配、别名碰撞与自定义语法保护。 |
| src/utils/randomPromptRecipe.spec.ts | 保留 | 保留序列化池快照重放、非法 count/version/seed 和 uint32 周界，不以无提示重采样冒充同作品。 |
| src/utils/resultContext.spec.ts | 保留 | 保留可提交身份、场景标题、故事、字段冻结及只读/Set 输入；与落册映射是不同边界。 |
| src/utils/retiredCompanionChat.spec.ts | 保留 | 保留退役角色旧会话/草稿原样保源且禁止 API 凭据进入归档。 |
| src/utils/runtimeEnvironment.spec.ts | 保留 | 保留 localhost 精确判定、远程桥不能授权、协议、无浏览器及 Electron 精确 origin，不能缩减分级 fail-closed。 |
| src/utils/sceneChanges.spec.ts | 保留 | 保留增量边界、深快照隔离、collection/property 顺序、完整导入及数量/规范 ID 约束。 |
| src/utils/sceneId.spec.ts | 保留 | 保留前端/后端共享 ID 规范、退休不回收、MAX_SAFE_INTEGER 与错误输入，跨运行时不是同函数重复。 |
| src/utils/sceneUX.spec.ts | 精简 | 保留隐藏去重、计数/封顶、衰减和迁移；把 scOld truthy 改为 uses:3,lastUsed:0 的实际归一结果。 |
| src/utils/scrollAnchor.spec.ts | 精简 | 删除通用短文档重试例，已有 defers pre-render 的延后变短/恢复例更强；保留首次同步定位、timeout、两路并行与键盘输入隔离。 |
| src/utils/showcaseDestination.spec.ts | 精简 | 去掉精确 URL equality 已包含的 generate= 缺失检查；保留所属蓝图、角色缺失回退与各入口路由。 |
| src/utils/springCompiler.spec.ts | 精简 | 去掉随后 easing/duration 检查已包含的 baked defined 断言；保留物理输出、过冲、CSS tokens 同步及非法配置。 |
| src/utils/stream.spec.ts | 保留 | 保留 done 不等连接关闭与坏 NDJSON 失败时 cancel/read lock 回收。 |
| src/utils/videoPromptProse.spec.ts | 精简 | 去掉精确输出 equality 已包含的质量词正则排除；保留权重、强调/下划线、计数、CJK、长提示词和自然语言直通。 |
| src/views/CharacterView.spec.ts | 合并 | 同一参考图弹窗中先验证修饰键不切换，再正常左右跳过pending与边界禁用，复用昂贵视图准备。 |
| src/views/GalleryStyles.spec.ts | 精简 | 删除任意selector数量大于50的规模阈值；保留真实CSS selector泄漏检查以及gallery内正向匹配。 |
| src/views/PopularSceneExplorerView.spec.ts | 保留 | 全部保留：本机/远程与成人资格fail-closed、历史SFW、R18模糊及正确绘制入口是有效内容与导航契约。 |

## Node189文件

| 原始文件 | 决定 | 理由／保留边界 |
| --- | --- | --- |
| scripts/tests/test-anima-routes.ts | 保留 | 保留真实旧网关HTTP对照：鉴权、模型家族/LoRA、输入白名单、排队/取消/TTL及上传清理均是用户会遇到的协议风险；plans/013明确网关消费者尚未退出。 |
| scripts/tests/test-anima-session.ts | 合并 | 16个Node声明的独有状态/请求/上下文/取消断言已并入既有Vitest session与races文件，删除双框架副本和alias loader |
| scripts/tests/test-api-client.ts | 精简 | 删除重构时的 fetch 拼写巡检，保留全部实际 API 取消、超时、错误协议和并发测试；再删只匹配fetch端点拼写的迁移哨兵；HTTP协议/取消/超时/监听清理全部保留 |
| scripts/tests/test-artwork-persistence-prototype.ts | 删除 | 旧 SQLite 候选原型不是产品持久化实现，原型重复验收退出常规测试；当前 workspace 的真实事务/崩溃恢复继续保留 |
| scripts/tests/test-batch-draw.ts | 保留 | 保留串行批量用户行为与反重入/取消/重试素材快照；其中候选seed、失败继续、迟到preview释放分别阻止重复花费与状态污染。 |
| scripts/tests/test-blink-scheduler.ts | 保留 | 保留完整闭合/保持/睁眼时间演进、reset与delta钳制，简单初值断言与后续时序同域但不能替代实际状态机。 |
| scripts/tests/test-blueprint-change-plan.ts | 保留 | 保留正在使用的Node维护工具的纯规划器；系列移动、字节保持、manifest冲突、proto扩展键和不可变输入不是旧后端运行时残留。 |
| scripts/tests/test-blueprint-shard-integrity.ts | 保留 | 保留生产蓝图源/聚合完整性三条检查，分别防manifest缺文件、重复ID/顺序变化与孤儿分片。 |
| scripts/tests/test-blueprint-write.ts | 保留 | 保留真实文件写适配器的TOCTOU、链接逃逸、基线篡改、故障传播及精确快照回滚，属于仍受工作流支持的内容维护工具。 |
| scripts/tests/test-bridge-acl.ts | 保留 | 保留跨TS invoke、build manifest与Tauri capability的权限闭包；mock桥不会触发真实ACL拒绝，不能当普通源码拼写哨兵删除。 |
| scripts/tests/test-bundle-budget.ts | 保留 | 保留构建体积工具的真实fixture产物行为；缺失/歧义lazy路由应报告unknown而非把未发现的JS当0预算。 |
| scripts/tests/test-character-profiles.ts | 保留 | 保留生产TS边界解析有效断言；旧档案identity/speech、LoRA展示、重复记录及推荐场景过滤直接影响人物档案可读性。 |
| scripts/tests/test-character-reference-contract.ts | 保留 | 保留权威标准→runtime参考view的双向镜像与资源路由本机限制；JSON schema成功不能代替真实素材存在性。 |
| scripts/tests/test-character-reference-profile.ts | 保留 | 保留懒加载单人物HTTP、数据变更reload与远程拒绝，不能仅用JSON镜像测试替代服务边界。 |
| scripts/tests/test-chat-host-config.ts | 保留 | 保留正在被工具和旧HTTP对照使用的托管配置原子持久化；同size/mtime缓存混用及删除权限失败是配置丢失风险。 |
| scripts/tests/test-chat-storage.ts | 保留 | 保留前端本地聊天档案/配置的迁移、损坏恢复与导入导出；Node只是执行TS测试，与退役产品后端不同。 |
| scripts/tests/test-chat.ts | 保留 | 保留plans/013点名不能由编译fixture代替的旧HTTP聊天对照；流完整性、有界读取、DNS pinning与工具协议各有用户/SSRF风险。 |
| scripts/tests/test-comfy-client.ts | 保留 | 保留原生队列孤儿扫描排除本进程新任务及非JSON取消HTTP状态；错误误删当前job或丢fallback状态会导致用户任务丢失。 |
| scripts/tests/test-comfy-progress.ts | 保留 | 保留WebSocket按prompt过滤、订阅驱动重连/idle关闭及非法值解码，避免别人的进度污染和空闲连接常驻。 |
| scripts/tests/test-companion-affection.ts | 保留 | 保留人物好感持久化与话题分类数值边界，属于仍运行的前端TS。 |
| scripts/tests/test-companion-behavior.ts | 保留 | 保留主动提醒状态机：安静时段/勿扰、idle与event各自冷却、队列上限及disabled行为均不同于组件展示。 |
| scripts/tests/test-companion-events.ts | 保留 | 保留服务/作品计数差额事件与首次基线/reset，防首次进入或恢复会重复播历史事件。 |
| scripts/tests/test-companion-vision.ts | 保留 | 保留角色看屏提示词的实际生成文本断言，检查角色身份/语气，不是读取生产源码的函数名哨兵。 |
| scripts/tests/test-compare-snapshots.ts | 合并 | 3个声明由同一生产对象的Vitest承担，非blob直通独有断言已并入 |
| scripts/tests/test-content-consistency.ts | 保留 | 保留独立于builder的真实source/product一致性证明；排序、关系与读取中漂移不能用重建自写自验。 |
| scripts/tests/test-content-contract-root.ts | 保留 | 保留内容门禁的数据根选择和只读隔离，防办公机错读生产data或环境root失效后隐式回退。 |
| scripts/tests/test-content-evidence-audit.ts | 保留 | 保留图像证据与人审发布的多重绑定及fail-closed，不把结构PASS或声明hash冒认为真实审核交付。 |
| scripts/tests/test-content-gate-repairs.ts | 保留 | 保留真实内容的精确服装/蓝图/两引擎编译回归，避免本次删测试误改变角色接入和既有人审约束。 |
| scripts/tests/test-content-history.ts | 保留 | 保留安全Git快照比较工具：rename/deleted旧关系、忽略标记与NUL解析不能导致错误增量PASS。 |
| scripts/tests/test-content-impact-check.ts | 保留 | 保留增量门禁执行证明，防选择集不完整或公共契约变更时只检查少数记录假通过。 |
| scripts/tests/test-content-impact.ts | 保留 | 保留面向日常维护的作用域分析；角色/服装默认歧义、分片多批次、样张review关联以及unknown表达各自有不同决策风险。 |
| scripts/tests/test-content-ownership.ts | 保留 | 保留权威源/派生产物与待审核状态报告，防错误数据域在维护中被重建、误认review完成或越界读取。 |
| scripts/tests/test-content-sync.ts | 保留 | 保留桌面内容同步CLI真实隔离副本；新角色引用仍pending、失败零写及第二次幂等直接影响安装后目录一致性。 |
| scripts/tests/test-control-failure-contract.ts | 保留 | 保留旧control HTTP与PowerShell管理脚本高价值对照；共享probe、防重复完成与拒绝杀无关进程不可由Rust目录存在代替。 |
| scripts/tests/test-control-operation.ts | 保留 | 保留仍被服务操作消费的真实串行状态机，防GPU启停重入和旧operation结果污染。 |
| scripts/tests/test-coverage-report.ts | 保留 | 保留覆盖率维护工具的实际分类/CLI，不是代码覆盖率套壳；缺登记/pending/缺图/素材root未知必须区分。 |
| scripts/tests/test-data-backup.ts | 保留 | 保留生产TS备份核心与storage-key allowlist，避免新用户设置漏导出或死key导入污染。 |
| scripts/tests/test-delivery-audit.ts | 保留 | 保留交付证据compare/hash/Git/文字状态工具的独立风险；同commit或prose PASS不能代替当前build/source/device证明。 |
| scripts/tests/test-delivery-evidence.ts | 保留 | 保留源码/构建/日志内容新鲜度与证据保存边界，防同HEAD变更或硬链接绕过证明。 |
| scripts/tests/test-delivery-finalize.ts | 保留 | 保留实际临时Git提交后的验证身份关联；索引不同版本和assume-unchanged是独有回归，不能用audit report小单测替代。 |
| scripts/tests/test-delivery-handoff.ts | 保留 | 保留跨办公机/主力机的真实双仓交接，防另一环境或旧快照通过状态被嫁接为当前设备验收。 |
| scripts/tests/test-desktop-deploy-guard.ts | 保留 | 保留deploy-desktop实际quiesce/owner与二进制身份检查；只等待而不杀程序和reuse PID识别是用户库保护。 |
| scripts/tests/test-desktop-import.ts | 保留 | 保留前端文件导入类型/尺寸/数量和记录身份字段，是TS前端逻辑单测不是旧网关残余。 |
| scripts/tests/test-desktop-library-browser.mts | 保留 | 保留真实私有浏览器与旧workspace HTTP整合消费者，plans/013明确workspace仍有对照与旧库兼容用途。 |
| scripts/tests/test-desktop-native-evidence.ts | 保留 | 保留安装周期证据清理，防新安装包继承旧图/音频/workflow与PASS记录。 |
| scripts/tests/test-desktop-staging.ts | 保留 | 保留当前Rust桌面构建/暂存/安装工具行为，工具链属于013明确保留范围。 |
| scripts/tests/test-desktop-tools-route.ts | 保留 | 保留本机工具真实HTTP、子进程与授权边界对照；模型不能自授trusted command或R18权限，取消必须回收自身树。 |
| scripts/tests/test-desktop-update-path.ts | 保留 | 保留实际内容更新/缓存/个人字节冲突边界与PowerShell5.1解析，防升级覆盖用户数据或误删目录。 |
| scripts/tests/test-desktop-updates.ts | 保留 | 保留生产发行的绑定、draft upload核验、sign/latest控制和版本安装身份，不能用静态npm版本比较代替完整发布行为。 |
| scripts/tests/test-desktop-workspace-host.ts | 保留 | 保留桌面owner drain与权威import/backup/activate/reopen整合；写入排空失败不能释放私库owner。 |
| scripts/tests/test-doc-redirects.ts | 保留 | 保留文档工具实际链接扫描与GET限定redirect，防文档入口坏链或POST被重定向造成误行为。 |
| scripts/tests/test-domain-type-boundaries-fixtures.ts | 保留 | 保留AST依赖门禁的故障夹具验证；别名/reexport/Vue双script/未知计算路径都可能穿透架构。 |
| scripts/tests/test-domain-type-boundaries.ts | 保留 | 保留真实全库领域依赖债只减不增的工程约束；它检验当前图，不是要求旧文件永久存在。 |
| scripts/tests/test-drawing-route.ts | 保留 | 保留用户可见引擎推荐与锁定能力，防普通/双人物/热门路径错误带studio LoRA或旧Krea管线。 |
| scripts/tests/test-e2e-ci-split.ts | 保留 | 保留测试选择器与CI lane条件的实际配置工具断言，防漏起隔离栈或hidden截图丢失；不是产品UI类名锁定。 |
| scripts/tests/test-electron-shell.mts | 保留 | 保留显式Windows真实Electron/多窗/私库/renderer/GPU验收runner，未默认执行也不能当无断言脚本删除。 |
| scripts/tests/test-emotion-runtime.ts | 保留 | 保留真正情绪时钟/参数范围与native动作白名单；mouth/blink不被情绪覆盖是用户模型表现与资源安全风险。 |
| scripts/tests/test-environment-context.ts | 保留 | 保留全天时段/周末及人物台词轮转/回退，属于前端行为，不是后端待删源码。 |
| scripts/tests/test-gateway-contract.ts | 保留 | 保留plans/013明确仍由gateway-test-stack消费的旧HTTP/WebSocket安全对照，编译fixture无法替代。 |
| scripts/tests/test-gateway-token.ts | 保留 | 保留持久token产生/环境覆写/损坏修复，防远程保护token每次重启意外重建或坏文件被接受。 |
| scripts/tests/test-generation-routes.ts | 保留 | 保留真实checkpoint/资源所有权/provider路由及WebUI/Comfy协议对照；013列明高价值HTTP移到Rust前不得误退出。 |
| scripts/tests/test-generation-workflow-safety.ts | 保留 | 保留仍被CLI生成维护工具实际消费的账本/可恢复job及反虚报审核，不是旧产品后端目录哨兵。 |
| scripts/tests/test-http-client.ts | 保留 | 保留实际HTTP代理、TLS、DNS与持续滴流取消/截止边界；Rust迁移不能让Node开发工具请求永久挂起。 |
| scripts/tests/test-icon-button-labels.ts | 保留 | 保留全库新增图标按钮可访问名称工程门禁；单个Vue组件交互覆盖不能替代新增按钮普查。 |
| scripts/tests/test-inpaint-canvas.ts | 精简 | 删除 helper 导入位置、节点编号和源码切片检查；画幅安全及真实工作流结构断言保留 |
| scripts/tests/test-inpaint-scene-candidates.ts | 保留 | 保留仍支持的候选修图工具逐key坐标、审批来源/attempt、工作流与不可写public目录，防碰错图或虚报修复。 |
| scripts/tests/test-inpaint-showcase-candidates.ts | 保留 | 保留样张候选修图工具的来源身份和图协议；side-agnostic mask、上传重名与区域差额决定安全的重试。 |
| scripts/tests/test-interrogate-client.ts | 保留 | 保留WD14真实worker关闭/取消admission与网关drain，避免调用取消后并发重用显存或shutdown启动fallback。 |
| scripts/tests/test-interrogate-engine.ts | 保留 | 保留实际WD14 engine/tag CSV解码与素材条件的分级概率断言；缺权重部分不可把skip当真实推理PASS。 |
| scripts/tests/test-interrogate-routes.ts | 保留 | 保留本机反推HTTP校验、上游输入落盘与fallback，防错误图片/阈值或远程请求访问用户模型。 |
| scripts/tests/test-job-snapshots.ts | 保留 | 保留持久job loss登记私密字段/TTL/限额/原子失败边界；恢复不能暴露prompt/token或借坏path删除其他文件。 |
| scripts/tests/test-live2d-backend.ts | 精简 | 同一现有FPS行为例承接删掉的165上限字符串护栏，直接核对桥收到的值 |
| scripts/tests/test-live2d-imports.ts | 保留 | 保留本机模型导入工具/HTTP的路径、core与multipart byte/revision/hash安全，属于013保留工具与local内容边界。 |
| scripts/tests/test-live2d-native-contract.ts | 精简 | 删除跨文件方法名/变量名/数值/CSS props 拼写检查；真实口型复位、bounds、FPS、晚到释放覆盖在现有行为测试；原生destroy的函数名、注释及代码片段检查由真实Rust状态单测承担；跨文件命令/ACL清单保留 |
| scripts/tests/test-live2d-renderer-process.mts | 保留 | 保留显式本机真实GPU子进程隔离验收；reply限额、杀renderer及父进程存活/重连不等于mock bridge成功。 |
| scripts/tests/test-live2d-route.ts | 保留 | 保留旧HTTP模型资源本机消费、缺目录degrade与remote拒绝，换Rust后仍有对照消费者。 |
| scripts/tests/test-live2d-service.ts | 保留 | 保留模型manifest/asset完整性与root逃逸安全，不是函数名枚举。 |
| scripts/tests/test-live2d-textures.ts | 保留 | 保留真实派生WebP/alpha/dimensions/hash-cache与resource HTTP条件读取；缓存不能改原件或错atlas index。 |
| scripts/tests/test-logger-retention.ts | 保留 | 保留完整同一磁盘retention行为，可承担test-logger删去的过期本/旁路日志场景，另有8MiB归档和非log保护。 |
| scripts/tests/test-logger-safety.ts | 保留 | 保留脱敏/注入/容量与rotate失败保数据，实际文件与console风险不能靠格式正则快照代替。 |
| scripts/tests/test-logger.ts | 精简 | 日志回收与 test-logger-retention 的更完整同一磁盘场景重复 |
| scripts/tests/test-lora-catalog.ts | 保留 | 保留生产LoRA目录字段、触发词/权重与typed cards实际映射，防表单取错模型或参数。 |
| scripts/tests/test-maintenance-blueprint-transaction.ts | 精简 | 测试响应结束后回收自有服务器 keep-alive 连接，省去无意义退出等待；不改HTTP/事务断言 |
| scripts/tests/test-maintenance-read-barrier.ts | 保留 | 保留真实跨进程SIGKILL与静态/预压stream fencing，防维护中HTTP读出半成品。 |
| scripts/tests/test-maintenance-recovery-boundaries.ts | 保留 | 保留recover限定backup/源/explicit external showcase root，恢复入口本身仍是Node维护工具。 |
| scripts/tests/test-maintenance-recovery.ts | 保留 | 保留lease/nonce/子进程和多阶段真SIGKILL恢复，错误只写失败而不能报告成功/解开barrier。 |
| scripts/tests/test-maintenance-transaction-routes.ts | 保留 | 保留旧内容事务HTTP oracle及精确文件断言，plans/013明确路线退出前要固定事务产物语义。 |
| scripts/tests/test-maintenance.ts | 保留 | 保留生产维护pure helper的curation继承/显式清空、tag唯一性、jpegmagic与snapshot备份边界，实际数据语义不能以React/Vue测试代替。 |
| scripts/tests/test-manual-review.ts | 保留 | 保留成功生成≠审核通过且approval绑定已看图的retry身份，直接防未审核图片上线。 |
| scripts/tests/test-model-downloads.ts | 保留 | 保留当前可执行模型下载/检查工具的hash/partial/lock/取消与真实manifest，不随旧后端迁移退出。 |
| scripts/tests/test-module-boundaries.mts | 保留 | 保留真实ESLint夹具以验证工程架构门禁能够抓实际静态/动态/require/alias越界，不是要求实现采用某行import拼写。 |
| scripts/tests/test-monolith-budget.ts | 保留 | 保留AGENTS明确500行红线与存量债只降不升门禁；其作用是受控规模约束而非用户行为单测。 |
| scripts/tests/test-mood-tag.ts | 保留 | 保留流式文本清理的闭合/悬挂/合法最后标签/非独立token等实际逻辑边界，防读屏露控制标记或情绪误驱动。 |
| scripts/tests/test-native-controls.ts | 保留 | 保留Vue模板AST执行的原生控件/浏览器dialog/原生title0基线门禁，覆盖新增页面而非仅某组件class。 |
| scripts/tests/test-offline-release.ts | 保留 | 保留受支持离线release exporter/Windows importer的真实ZIP和hash/越界/发布原子边界，013明确工具与importer继续支持。 |
| scripts/tests/test-page-architecture.ts | 保留 | 入口懒加载、页面样式所有权、无内联处理器/远程字体属于代码架构契约；parser 正反夹具验证门禁本身。精确 CSS 文本和 UI 选择器片段应与已有浏览器/组件行为去重，不能整份移除架构扫描。 |
| scripts/tests/test-particle-portrait.ts | 保留 | 真实调用 particlePortrait 的采样/背景识别和亮色 underlay；全图边缘保留、透明抠图及多色外圈三种输入不同于 Vitest 的密度/调度/描边测试。 |
| scripts/tests/test-pinned-scene-prompts.ts | 保留 | 真实 CLI 在浅历史、capture/apply、缺失/重复及空基线夹具中核对零写入与原字节；真实 pin 基线完整性直接对应仓库红线。 |
| scripts/tests/test-popular-content.ts | 精简 | 删掉同一blueprint数目相等关系的镜像断言，完整集合与成人可用性仍逐条核对 |
| scripts/tests/test-popular-shard-integrity.ts | 保留 | 核对真实分片注册、union/唯一性/顺序和版本；聚合数据防丢失与分片字节一致不是运行时解析测试的副本。 |
| scripts/tests/test-precompress-runner.ts | 保留 | 异步维护执行器在隔离目录精确复核 Brotli11/gzip9 产物和坏/陈旧 sibling；与 HTTP 压缩协商是不同边界。 |
| scripts/tests/test-precompressed.ts | 保留 | 真实 HTTP 内容协商、q/exclusions/Vary、缓存及 ETag 与文件更新/回退；不同状态码/压缩类型确实触发独立路径。 |
| scripts/tests/test-prompt-builder-modules.ts | 精简 | 删除旧目录、函数名、CSS/动画名和 import 拼写锁定，保留全部实际持久化解码断言 |
| scripts/tests/test-prompt-compiler.ts | 保留 | 生产前端编译器、配置及维护生成使用的路由图形成实际契约；真实 artist catalog、图结构、字幕控制关系和引擎差异均有独有覆盖。Krea medium 防重作为已删 Vitest 副本的唯一断言必须保留。 |
| scripts/tests/test-prompt-corpus.ts | 保留 | 全302条真实场景逐引擎编译，不允许 LoRA 权重/训练精确 token/具体动作/配色/分级丢失；与单例编译器测试不等价。 |
| scripts/tests/test-prompt-policy.ts | 保留 | BREAK 作用域、多来源 framing、评级负面、真实 profile/LoRA 训练绑定和单人模板均调用生产代码；r15/r18 与 selectiveNegative 现替代删除的 Vitest重复。 |
| scripts/tests/test-prompt-rewrite-integrity.ts | 精简 | 无约束上界/非零烟雾改成独立已知5/7保留率、5/8相似度及空集合，模板正反例保留 |
| scripts/tests/test-quality-gates.ts | 保留 | 验证真实注册表每份测试只归属一套、遗漏/重复阻断，常规/设备/真实模型分离及 CI 先构建；配置与执行治理的静态断言有实际用途。 |
| scripts/tests/test-quality-prompt-contract.ts | 保留 | 维护脚本真实默认值/白名单、固定三seed与明确参数、评级健康检查及人工review总分门禁；避免未经完整复核的样张被选入库。 |
| scripts/tests/test-quality-report.ts | 保留 | 实际质量执行器和进程池保留失败分类、未执行、时限机器报告；不是只断言手写日志夹具自身。 |
| scripts/tests/test-quick-create.ts | 保留 | 直接生产 quickCreate 写/读、数字/尺寸归一、禁止保存seed和URL编码；前端 store草稿例未覆盖这个工具。 |
| scripts/tests/test-random-prompt.ts | 保留 | 生产随机组装器在全真实tags字典和确定seed上测试互斥、身份排除、成熟池联动、三引擎语法与镜头服装；500轮是确定性输入空间，不是固定等待。 |
| scripts/tests/test-refactor-boundaries-fixtures.ts | 保留 | 以真实扫描器处理隔离代码、barrel/声明/动态引用/Rust import/allowlist Git历史；扫描器有效性直接影响 fail-closed 架构门禁，勿以“源代码测试”统删。 |
| scripts/tests/test-reference-audit-root.ts | 保留 | CLI/函数实际探针证明根优先级、帮助零访问、缺失/坏JSON定位、素材根与双参/三参签名；保护不能偷偷读取生产素材。 |
| scripts/tests/test-reference-candidate-workflow.ts | 保留 | 真实候选检查/人工review/发布工具在完整源身份、图哈希、路径和跨进程锁中验证不伪审批、原子发布/死亡恢复；字节不能冒充视觉质量已明确。 |
| scripts/tests/test-reference-library-merge.ts | 保留 | 顶层直接14个断言调用生产 merge：保留人工文本/已审核URL与待审状态，补发现资产而不降格已有资产，输入不变且重跑幂等；无test声明不代表无测试。 |
| scripts/tests/test-reference-shards.ts | 保留 | 顶层真实读写临时分片和聚合、失败回滚、无关人物零改写、压缩失效与unsafe/duplicate/orphan拒绝；16断言有实际维护消费者。 |
| scripts/tests/test-remote-content.ts | 保留 | 旧网关真实HTTP检查授权统一先于静态/压缩/HEAD/Range/缓存，以及桌面启动实例证明不泄密；按013尚需Rust HTTP承接后才能退旧栈。 |
| scripts/tests/test-repo-hygiene-contract.ts | 保留 | 真实临时Git index/worktree/untracked/合并冲突与baseline哈希夹具，验证卫生扫描器和原始许可库存的fail-closed；不是只查项目当前文本。 |
| scripts/tests/test-repo-hygiene.ts | 保留 | 使用同一生产扫描器对当前工作区做全域卫生入口；contract证明扫描规则、此文件证明当前仓库，所以用途不同。 |
| scripts/tests/test-resource-download.ts | 保留 | 隔离HTTP与进程中测试校验、分块续传、ETag、忽略Range、断连/SIGKILL、ENOSPC、审批与锁释放；防下载成功冒充安装/损坏现有资源。 |
| scripts/tests/test-resource-gateway.ts | 保留 | 真实旧网关/资源安装管理接线覆盖配置选择、授权撤销、离线资源、任务重启与Live2D整组fallback；013未替换所有HTTP场景前保留。 |
| scripts/tests/test-resource-install-edge.ts | 保留 | 零delta/删除-only、源变化、metadata失败、读回损坏和真进程死亡rollback，分别位于安装边界稀有路径，不能用普通安装成功替代。 |
| scripts/tests/test-resource-install-recovery.ts | 保留 | 实际SIGKILL各阶段、并发recoverer、日志和链接篡改、分片重hash、上版本损坏；全部属于状态恢复/写所有权保护。 |
| scripts/tests/test-resource-install-resolver.ts | 保留 | 真实readonly解析器在授权/配置/锁/待处理日志/损坏与并发变更下拒绝挂载，不读网络/不初始化/不修复；与允许写的安装器测试分工不同。 |
| scripts/tests/test-resource-install.ts | 保留 | 完整包/增量安装、双重审批、实际字节、取消、disk不足/ENOSPC、指针失败和不写应用/作品根；维护工具仍实际使用，保持精确失败与回滚断言。 |
| scripts/tests/test-resource-manifest.ts | 保留 | 生成/校验/比较实际清单与磁盘，保护排除域、Windows路径/链接、坏schema/unverified及CLI根；G7差异算法和IO安全是两个独立用途。 |
| scripts/tests/test-resource-pack-delta.ts | 保留 | 真实delta预览/导出，保持旧清单只结构读取、新磁盘完整核验、只增改复制、删除/无差异语义、元数据失败不发布及Windows平台边界。 |
| scripts/tests/test-resource-pack-verify.ts | 保留 | 独立候选包验证：重建身份/removed集合/真实字节、多余项、Windows大小写/链接/元数据根；它不能由被测导出器自己的成功状态替代。 |
| scripts/tests/test-resource-pack.ts | 保留 | 真实完整包预览/复制/读回/rename及原文件零写入，拒绝覆盖/越界/链接和TOCTOU；与delta及安装阶段的安全责任不同。 |
| scripts/tests/test-resource-packaging.ts | 保留 | sharp/文件实字节证明base版保留原URL与缩略图/品牌/Live2D、full版字节不改，坏图/缺图拒绝；产品包预算与可离线展示的真实消费者。 |
| scripts/tests/test-resource-reference-gateway.ts | 保留 | 审核后的索引与图片同版挂载、损坏共拒、旧压缩索引不拼新图、远程禁止；旧网关真正HTTP接线仍是维护发布端承接对象。 |
| scripts/tests/test-resource-scheduling.ts | 删除 | 整文件仅以源码字符串确认旧Node端点/控件/翻译实现，不能证明调度；实际调度与释放由行为测试验证 |
| scripts/tests/test-resource-ui-visual.mts | 保留 | 独立Vite真实面板+双主题Playwright点击import/cancel/recover/键盘refresh，5类断言检查overflow、AA、禁用与请求序列；无需依赖共享dist或真实资源安装。 |
| scripts/tests/test-runtime-errors.ts | 保留 | 生产caught-value工具保留标准Error/进程错误细节，非法status/code不被信任；类型测试与真实错误映射有实际运行差异。 |
| scripts/tests/test-runtime-generated.ts | 保留 | 当前生成入口保持tracked源码对应、产物未入Git且可重复编译无漂移；旧产品后端退出不代表维护生成器退出。 |
| scripts/tests/test-rust-bundle.ts | 保留 | 实际暂存Rust EXE在隔离bundle通过verify-desktop-gateway请求，属发布布局验证，不是旧Node副本；环境前提不能误记为普通无设备单测。 |
| scripts/tests/test-scene-change-set.ts | 精简 | 同一后端 scene-id 函数及有效/非法/安全整数边界已由Vitest直接覆盖，有限区间 missing-ID 回归保留 |
| scripts/tests/test-scene-maintenance-save.ts | 精简 | 测试响应结束后回收自有服务器 keep-alive 连接，省去无意义退出等待；不改HTTP/事务断言 |
| scripts/tests/test-scene-patch.ts | 保留 | 真实维护CLI/提交工具保护pin六字段、增量报告零写入、失败时源/聚合/version/压缩字节回滚；真实门禁不能按内部Node语言退出。 |
| scripts/tests/test-scene-prose-contract.ts | 保留 | 测试正式全语料门禁共用的气氛散文分类，完整单句/雨雾/多句与质量词填充/泛用光影/截断分别正反；这里是在测试门禁规则，不是夸夹具出图。 |
| scripts/tests/test-scene-rating-diagnostics.ts | 保留 | 实际诊断/人工R15修复CLI，信息解释与零写入、独立manual table安全、严格参数及真实写入幂等；分级规则不因前端已有badge测试而重复。 |
| scripts/tests/test-scene-render-contract.ts | 保留 | 真实门禁renderedScene调用生产负面/镜头装配，禁止检索标签进入正向，缺省镜头仍报冲突；独立于前端基础applyFraming夹具。 |
| scripts/tests/test-scene-shard-integrity.ts | 保留 | 真实浏览器分片互斥/union/core策展subset/首屏策略/index产物一致；风险是部署数据丢片，不是sceneStore mock加载。 |
| scripts/tests/test-scene-story-alignment.ts | 保留 | 没有assert/test声明但会对实际全语料做条件门禁并exit1；pin疑点降为待人工核对保持字节红线。关键词不能证明真实出图，且躺卧regex写了转义管道有潜在失效，应单记。 |
| scripts/tests/test-scene-ux.ts | 精简 | 局部使用次数/新旧时间计分已经由 Vitest 全分支行为覆盖；Node保留真实语料搜索和旧格式迁移 |
| scripts/tests/test-scene-write.ts | 保留 | 生产维护分片规划/修改/迁移/退役、无变更零写入、孤片截断拒绝与锁串行；ID纯分配例可与既有frontend直接backend用例去重，但含readRetired损坏清单须保留。 |
| scripts/tests/test-sd-error.ts | 保留 | 前端生产错误分类OOM、LoRA/checkpoint/sampler/超时/取消/网络及空值，每个错误决定不同恢复动作；不是旧网关实现约束。 |
| scripts/tests/test-sd-runtime.ts | 保留 | 生产sdRequest/sdStatus/useSDQueue调用覆盖负面切换、双角色载荷、profile/LoRA framing与队列保留；文件单个大声明内仍有44个不同有效断言。 |
| scripts/tests/test-security.ts | 保留 | 旧安全协议与实际工具仍用的token、local/forwarded/Origin、DNS rebinding、archive链接防护、诊断脱敏/CSP和adult双门；按013需要独立Rust承接证据后退，不按旧目录统删。 |
| scripts/tests/test-serial-queue.ts | 保留 | 真实生产FIFO/准入、失败隔离、等待context、abort出队以及被阻塞头任务下快速settle/no backlog；第二例延迟状态不是第一例简单取消副本。 |
| scripts/tests/test-service-watchdog.ts | 保留 | 实际服务生命周期重启/退避、未上线不能自动启动、stop及晚probe/restart完成防复活；伪计时器驱动真模块，不是fixture自证。 |
| scripts/tests/test-showcase-candidate-contract.ts | 保留 | 真实维护生成器各人工attempt参数/seed/ID链、两引擎、LoRA绑定、resume/原子manifest与发布目录禁止；纯storeSource constants includes只能弱检查字符串，不能证明按角色绑定。 |
| scripts/tests/test-showcase.ts | 精简 | 移除 Vue/CSS/旧Node网关字符串巡检及无移动端范围的写法约束；真实解析、分级、发布和HTTP断言保留 |
| scripts/tests/test-speech-session.ts | 保留 | 生产speechSession状态机覆盖唤醒、手动会话、reply忙态、endSession/endWords与重配；监听状态/提交动作分别可回归，无对应完整Vitest覆盖。 |
| scripts/tests/test-storage-health.ts | 保留 | 实际故障解析、诊断取样与数据大小统计/未知状态，不读真实设备；用户存储失效提示路径需要保留。 |
| scripts/tests/test-storage-key-hygiene.ts | 保留 | 真实代码存储键集中出处门禁，有历史双key库分叉风险；它与localStorage写必须登记门禁分别检查“已登记键不能再复制”和“新写必须登记”。 |
| scripts/tests/test-storage-reliability.ts | 保留 | 生产useKVStore/useImageStore在fake-indexeddb事件事务中验证commit发布次序、失败缓存不污染及缺IndexedDB；高层内存Map仓库测试替代不了事务语义。 |
| scripts/tests/test-storage-repositories.ts | 精简 | parse(null)已在同一表驱动例覆盖，删重复末尾断言；空串与1的独有解析保留 |
| scripts/tests/test-style-debt.ts | 保留 | 真实AST/style/contrast/Tailwind/color/compositor扫描器正反夹具和当前全局令牌检查；AA与transform-only红线不能拿UI截图局部覆盖替代。 |
| scripts/tests/test-tag-shards.ts | 保留 | 当前字典与全分片数据、别名碰撞、schema/path/related-ID、发布双产物失败回滚、compressed失效和reverse split安全，维护工作流真实使用。 |
| scripts/tests/test-task-center-browser.mts | 保留 | 独立真实Vue任务中心/HTTP/SQLite双主题操作，验证AA、result持久入册幂等、故事/seed0冻结及移除收件箱保留作品；不是只改mock状态。 |
| scripts/tests/test-task-recovery-prototype.ts | 删除 | 未被产品或当前工具消费的旧模拟 journal 原型，真实持久任务恢复已有独立断言 |
| scripts/tests/test-task-runtime.ts | 保留 | 真实workspace SQLite与生产任务runtime处理accepted/unknown、持久cancel、身份/指纹、结果inbox、重新取回/显式resume、shutdown与批次序；013中任务fingerprint oracle还有消费。 |
| scripts/tests/test-test-process-pool.ts | 保留 | 真实子进程与自有后代检查bounded并行、fail-fast/all、timeout/abort/overflow/spawn错误；不能通过缩小runner或fixture结果替代。 |
| scripts/tests/test-translation-service.ts | 保留 | 实际子进程stub驱动生产翻译服务，close取消active/queued不fallback、旧exit不能清新child，正是生命周期复活风险。 |
| scripts/tests/test-tunnel-restart.ts | 保留 | 生产tunnel在cloudflared异常exit/connected/stop序列下测试重启退避清理；旧HTTP参考仍有实际消费者，不能把3个行为断言当固定source检查。 |
| scripts/tests/test-typescript-build.ts | 保留 | 真实临时项目/编译器/产物缓存的失败原子性、源/lock/declaration/config变更失效、删除权限边界和链接拒绝；仍是前端维护工具链。 |
| scripts/tests/test-typescript-development.ts | 保留 | 实际dev watcher/source build/Rust编辑/失败drain和签名host shutdown，避免第二writer或启动旧产物；不同于静态构建产物测试。 |
| scripts/tests/test-upstream-health.ts | 保留 | 实际loopback HTTP处理JSON/raw/POST/limits/partial响应/总deadline，具体SD/TTS/Comfy/Ollama健康口径与false JSON体；协议行为仍被旧栈使用。 |
| scripts/tests/test-ux-regressions.ts | 保留 | 原大例主要通过check源码模式及两次首断言检查门禁结果；root正在去掉按钮/输入选择器和目录断言，仍需区分真实架构/安全redline扫描与实现拼写。 |
| scripts/tests/test-vad-segmenter.ts | 精简 | 取消麦克风授权改由真实晚到流行为断言，不锁 startToken/track.stop 代码写法 |
| scripts/tests/test-video-ai.ts | 保留 | 虽无test声明但run真实API/Ollama mock HTTP的来源优先、auth/请求结构/JSON清洗/rewrite/polish/参数/成人拒绝与AI分镜；013明确举它为旧网关保留理由。 |
| scripts/tests/test-video-routes.ts | 保留 | run中336个断言遍历真实旧HTTP创建/查询/取消/结果/Range、模型/工作流、参考upload/T8、adult授权、批次重试/拼接幂等；纯Rust编译固定夹具不能代替协议生命周期。 |
| scripts/tests/test-voice-baseline.ts | 保留 | 真实声线profile/manifest/语料与基线文件结构离线检查，VOICE_BASELINE_LIVE仅提示显式捕获，不应把未进行真实音质验收记PASS。 |
| scripts/tests/test-voice-cache.ts | 保留 | 实际语音router随保存profile/backend变更失效，共享生成单听者离开继续、router关闭全取消；与前端voiceApi传输层不同。 |
| scripts/tests/test-voice-profile-contract.ts | 保留 | 生产VoiceProfile/input validation与locked emotion参考绑定、固定声线参数；结构字段失配会直接影响实际TTS载荷。 |
| scripts/tests/test-wav-quality.ts | 保留 | 独立合成WAV样本验证真实质量分析器format/duration/响度/裁边/削波/DC及baseline差值；独立数值oracle不是生产媒体自证。 |
| scripts/tests/test-webui-lifecycle.ts | 保留 | 真HTTP边界+生产service任务生命周期包括Basic auth、body错误/limits/drippingdeadline、input snapshot、terminal/cancel/idempotence/close/retention和Comfy晚接受；业务功能未被transport单测替代。 |
| scripts/tests/test-workflow-conditions.ts | 保留 | 调用真实registry/runner的读前元数据诊断与help/plan zero sideeffects，复合effect/错误呈现/过滤参数；需要保留因当前维护命令授权边界仍依赖。 |
| scripts/tests/test-workflow-runner.ts | 保留 | 真实registry执行/隔离脚本、metacharacters、Git/typed paths/selected tests、防stale generated/device升级和失败阻断；当前变更选择机制的实际回归保护。 |
| scripts/tests/test-workspace-backup.ts | 保留 | 真SQLite API快照/WAL与leased媒体、坏hash/未知schema拒绝/cancel，旧库兼容与013 parity数据安全共同需要。 |
| scripts/tests/test-workspace-client.ts | 保留 | 真实单worker/进程writer ownership与关闭顺序、取消后身份仍可reconcile及foreign process不能抢锁；不是API缓存取消副本。 |
| scripts/tests/test-workspace-library-http.ts | 保留 | 真实桌面HTTP media/record save丢ACK去重、projects/restore和v1库upgrade回执；需要保留旧协议到新库的可读兼容。 |
| scripts/tests/test-workspace-migration-browser.mts | 保留 | 独立两真实浏览器窗口+Vue资料adapter/SQLite，检查迁移域/凭据排除/设置草稿隔离/CAS重base/message merge/offline outbox/reset恢复；纯storage测试替代不了跨窗。 |
| scripts/tests/test-workspace-migration.ts | 保留 | 顶层20断言运行真实旧engine在临时库对records/media/trash/drafts全迁移、resume/checkpoint/identity冲突与reset防复活；013 importer退出前必要。 |
| scripts/tests/test-workspace-routes.ts | 保留 | 真实旧网关worker鉴权/私会话、原图与保存/revision回执、一旦断身份不能fallback写库；尚无固定SQL独立检查完全承接则保留。 |
| scripts/tests/test-workspace-storage.ts | 保留 | 顶层真实SQLite与四次子进程崩溃、prepared/committed回执、媒体分块hash、身份/CAS、项目/回收lease/任务暂存保护；013旧库/回执兼容不可删。 |
| scripts/tests/test-workspace-thumbnails.ts | 保留 | 真实库重启/派生cache重建/原图hash/GC，证明缩略图可删可重算而原图保护；不同于前端LRU只驻内存预览。 |
