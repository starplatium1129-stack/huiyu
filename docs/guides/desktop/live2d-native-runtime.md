# Live2D 原生运行时

> 更新：2026-09-30；现行契约与目标设备待验范围分别维护，历史阶段原文从 Git 历史查询。
> 范围：Tauri 2 Native overlay、Cubism Native renderer、前端双后端接入和当前发布限制。

## 当前结论

2026-09-27 内存优化调整了卸载契约：桌宠隐藏经前端统一销毁模型，原生 Destroy 保留窗口与命令线程，释放整个 GPU context，重开时重新创建设备并加载模型。模型加载成功或失败后均清理纹理上传 staging，模型释放补齐超采样目标。历史记录中的“长期复用 wgpu 上下文”已被本条替代；正常卸载仍不触发 stopped。原生单次同步纹理解码/上传不能中途打断，加载中隐藏会立即取消前端连接，原生在当前加载结束后处理排队的 Destroy。

房间和桌宠可选原始、标准、节能纹理画质，默认原始。标准/节能宽高分别除以 2/4，源资源不改写；原生桥通过 supportsTextureQuality 声明支持，并接收 textureScale（1/2/4）。浏览器模型与渲染使用同一应用时钟，显式桌宠可见性优先于非活动 WebView 的隐藏状态；原生隐藏等待可由命令唤醒。当前安装身份及实际验证范围分别查项目状态和下方证据。

Native 路径已完成产品链路和 renderer 收口；当前安装身份以[项目状态](../../project-status.md)为准，2026-09-27 的实际画面、隐藏释放和重开范围见[当前状态与验证边界](../../project-status.md)。正式默认仍为线程 renderer，R12 独立进程与 R13 Electron 均为实验。本机安装不等于公开发布或 D-10 全部设备组合通过。浏览器默认使用 `wl-live2d`；Companion 可见启动时才按桌面契约请求 Native，`--hidden`、隐藏窗口和用户显式关闭时不得下载或加载大模型。

宁宁与夏目 Native release snapshot 的角色完整性、动作、口型、情绪、hit-test、mask、透明度和颜色均通过人工检查。与 wl-live2d 对照时，同一动画帧的姿势、构图和部件完整性一致；剩余明度/饱和度差异属于校准级差异，不是结构缺陷。

## 本机导入边界

导入核对 manifest、Moc 与全部运行引用及目录边界，作者原件和许可保留。私有本机模型不进入发行包；Cubism 2 保留浏览器回退；没有专属音色时只做文字聊天，不借用其他角色音色。现成导入与同步入口见 [工作流](../../workflow.md#本机-live2d-候选导入)。

## 架构与链路

```text
ChatCharacterStage / useLive2D
  -> src/live2d/browserBackend.ts | nativeBackend.ts
  -> src/platform/desktop/nativeLive2d.ts
  -> hostApi.ts typed IPC / Rust bridge
  -> desktop-tauri/src-tauri/src/live2d_overlay.rs
  -> desktop-tauri/native-live2d
  -> Cubism Core + official Framework + wgpu
```

- `types.ts` 定义 stage/session/model/capability 契约；`createBackend.ts` 在 Native bridge 缺失时回退 browser，并标记 `data-backend="browser-fallback"`。
- Browser 路径保留 wl-live2d 的参数级眨眼、口型和情绪运行时；Native 路径只发送意图，不复制浏览器参数 hack。
- Native renderer 由官方 Cubism SDK for Native 5-r.5、C++ glue、Rust FFI、`model.rs`、`renderer.rs` 和 WGSL shader 组成，负责动作、物理、pose、眨眼、hit-test、mask、混合和透明目标。
- overlay 为独立线程的透明 Win32 窗口；壳负责窗口生命周期、命令队列、事件和布局，renderer 负责模型和 GPU 资源。

## IPC 与坐标契约

- 公开意图包括 character、frame/bounds、motion、expression、mouth level、emotion、gaze、hit-test、visibility、max FPS、snapshot 和 destroy；事件包括 ready、motion started/failed、hit-test、entrance finished 和 visibility。
- `src/types/live2dNative.ts` 与本页 IPC 约束是公共契约；新增命令沿用 typed command/reply，不暴露任意路径、参数或执行能力。
- overlay 矩形一律使用屏幕物理像素。CSS rect、窗口原点和 DPR/视口实测比例的换算集中在 `src/utils/live2dOverlayLayout.ts`。
- Native overlay 固定在透明 Companion WebView 下方并使用 `WS_EX_TRANSPARENT`；`setFrame` 只传 Companion-local 物理矩形，Rust 每帧用实时 HWND 位置跟随，避免首次旧 bounds 和拖动事件延迟。WebView 舞台将归一化点击坐标经 IPC 送到 Cubism HitArea。禁止恢复 `SetWindowRgn` 控件挖洞方案：Win32 region 会同时裁剪 DirectComposition 可见画面，在角色头发、手部和脚部留下矩形缺口。
- Native 状态查询是只读的；未初始化查询不得创建窗口、加载模型或启动渲染线程。重复 connect/destroy 必须清理 listener 和 motion 订阅。
- 动作组不固定使用变体索引 0；同一动作正在播放时返回 busy，前端显示“动作进行中”而不强制重启。

## 模型特殊契约

- 宁宁：Native 口型 level `0..1` 映射 `ParamMouthOpenY`；author motions、表达式、物理和衣装由模型工程控制。`expression1` 至 `expression5` 是校服、常服、睡衣、COS 服和魔女服，只能由显式衣装控件切换，不当作情绪。
- 夏目：单一作者导出态，只有咖啡店制服，没有可公开选择的 Expressions 或独立衣装模型。不得按连续参数编号猜衣服、手动驱动 `Param36-75`、强制 Drawable opacity 或把 motion 内部叠层当作衣橱。
- 夏目没有 `ParamMouthOpenY`；口型 level `0..1` 映射 `ParamMouthForm3` 的 `0..-0.5`，真实音频桌面回归仍需 GPT-SoVITS 可用环境。
- 夏目源 LPK 的 `fileId`/`metaData` 与仓库 moc3、物理和 41 个原生 motion 已完成一致性复核；41 个 motion 共含约 750 条 `PartOpacity` 曲线，曲线值恒为 `1`，因此曲线存在性不能推断衣装开关。
- 夏目 `Param36-61`、`Param62-64`、`Param65-75` 是 moc 内部图层/动画通道；不得按连续 Part 分组或手写 opacity。临时制服/叠层效果必须由完整 authored motion 驱动，否则会产生重复制服、白色遮罩或鞋腿串层。
- 互动组必须交给 Cubism 选择已导入的原生 motion 变体，不得固定 index `0`；衣装/叠层效果也随完整 motion 保持其参数曲线。
- 参数写入时序必须在 `model.update(dt)`、motion/physics/pose 和 Core drawable 更新之后，避免动作曲线覆盖口型、情绪和凝视意图。

## Renderer 不可回退的约束

- HWND surface 强制使用 DX12；窗口先 `ShowWindow(SW_SHOWNA)` 才能稳定枚举 DXGI formats，renderer pipeline format 必须与 surface format 一致。`SetCharacter` 前先建立 surface。
- 每个 drawable 使用独立 uniform slot 和 dynamic offset；layout 必须声明 dynamic offset，stride/offset 按 wgpu 对齐要求计算，不能让所有 draw 共享最后一次写入的 uniform。
- Live2D 导出纹理的 V 坐标必须统一 `uv.y = 1 - uv.y`，主 pass 和 mask pass 相同；纹理上传使用 premultiplied alpha，blend 采用 premultiplied over，颜色目标使用 sRGB 语义。
- mask source 即使不作为独立可见部件仍按 Cubism 语义渲染；主循环不能错误过滤同时充当 mask source 的普通 drawable。mask 采样使用 clip 空间坐标，不能误用 drawable texture UV。
- 模型级 geometry、UV/index buffer、texture/mask bind group、uniform、动态 upload buffer 和 CPU snapshot 必须缓存；首帧预热全部 drawable/mask，运行帧不创建静态 GPU 资源。
- 换角色和 destroy 必须释放 geometry、mask、uniform、upload、纹理和 CPU scratch。零长度/null FFI 数据必须 checked，不能构造未定义的 slice。
- Surface `Lost`/`Outdated` 立即 reconfigure 且不计为成功帧；Timeout 跳帧，OutOfMemory 终止渲染循环。Soak 固定 DX12、剥离 `L2D_*` 调试环境并验证角色切换、最小工作量和最终释放。

## 验证与设备边界

本机实际画面、隐藏释放和重开见 [当前状态与验证边界](../../project-status.md)，后续 mask 内存与按钮交互见 [当前状态与验证边界](../../project-status.md)，DPI/窗口恢复见 [当前状态与验证边界](../../project-status.md)。每份证据只覆盖自己的源码、构建和操作；真实音频、多屏混合 DPI、休眠及长时功耗仍按 [未来规划](../../roadmap.md)验证。

## 外部参考与工作纪律

- `AyagamiDev/ayagami`：已通过 `api.github.com` 验证存在，用于 wgpu mask、premultiplied alpha 和混合语义对照；不是本项目的运行时依赖。
- `pixi-live2d-display` 与本地 `wl-live2d` Cubism renderer：用于官方 mask channel、layout matrix、shader 和 blend 语义对照。
- `Veykril/cubism-rs` 仅作旧版 4-r.5.1 绑定参考；`sena-nana/live2d-rs` 曾被验证为 404，不得再引用不存在的仓库。
- 遇到同一问题连续两次实验无效时，先用 `api.github.com` 验证来源真实性，再查官方文档、issue 或已验证实现；禁止继续盲猜 renderer 行为或自造 IPC 语义。

## 当前限制与接入点

1. 本机完整安装、当前 `3002` 来源迁移及独立 UI 已取得证据，不能继续列为整体未执行。D-10 未覆盖的真实 TTS、125/150% DPI、多屏、卸载、self-hosted Windows workflow 及其他设备组合仍需分别验收，不沿用旧会话的权限/服务状态作为当前阻塞原因。
2. renderer selftest 和 renderer soak 不能替代安装包产品链路；已有安装画面、隐藏/重开检查只覆盖记录中的操作，真实 TTS 口型和安装产品的长时稳定性仍需对应证据。
3. 夏目 `ParamMouthForm3` 的真实 TTS 桌面回归仍待环境恢复；离线映射 contract 已通过，不得据此宣称真实音频已验收。
4. 30 分钟 soak 是发布前可选强化；当前固定 Windows Native gate 是 300 秒，不应加入无 GPU 的默认 `validate`。
5. 后续接入只使用 `src/types/live2dNative.ts`、本页 IPC 约束和公开 backend API；不得把参数级 hack、源项目 WAV 或未验证 motion/expression 当作新能力。

## 模型叠层规避的原因与退出条件

夏目作者动作和 Idle 变体会驱动额外叠层，动作结束并不保证参数回到 Moc 默认值；写零或按连续参数猜衣装曾导致灰眼、重影和重复制服。当前前端隐藏态表与 Native C++ 表同步，只在非互动、非登场时守卫叠层；互动结束以捕获当时值的平滑回落避免单帧闪回。物理、正常眨眼和作者动作不纳入全参数重置。作者模型重新导出或替换后，只有逐动作实测证明残留已消除，才能删除该模型专用规避。

定位残留时先用同源离线 renderer 重现 Idle、Tap 结束及后续 Idle，比较参数当前值与 Moc 默认值，并排除物理输出、mask 和 drawable 状态；不能仅凭参数编号推断衣装。

## 新模型接入检查

1. 核对 model3 manifest、Moc、表情、动作、物理与所有文件引用；保留作者来源和许可。
2. 从实际 Core 参数/默认值确认 EyeBlink、口型和叠层隐藏态，不复用其他角色的编号表。
3. 比较全部 Idle/Tap/Start 变体和结束状态，仅为已复现的模型缺陷接入专用守卫/平滑回落。
4. 双端检查静止、互动、结束、切角、隐藏和重开；前端订阅与 Native 资源各自严格释放。
5. 打包后查看实际画面，记录源码、构建、DPI/视口与未覆盖设备条件；模型文件存在或 UI 连接状态不计为验收。
