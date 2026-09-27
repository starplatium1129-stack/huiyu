# Live2D 原生运行时

> 更新：2026-09-27；下文历史原生验收记录保留各自适用范围。
> 范围：Tauri 2 Native overlay、Cubism Native renderer、前端双后端接入和当前发布限制。

## 当前结论

2026-09-27 内存优化调整了卸载契约：桌宠隐藏经前端统一销毁模型，原生 Destroy 保留窗口与命令线程，释放整个 GPU context，重开时重新创建设备并加载模型。模型加载成功或失败后均清理纹理上传 staging，模型释放补齐超采样目标。历史记录中的“长期复用 wgpu 上下文”已被本条替代；正常卸载仍不触发 stopped。原生单次同步纹理解码/上传不能中途打断，加载中隐藏会立即取消前端连接，原生在当前加载结束后处理排队的 Destroy。

2026-09-12 新增可选纹理画质与调度修复：房间和桌宠设置均可选原始、标准、节能，默认原始。标准/节能的纹理宽高分别除以 2/4，原始资源不改写；原生桥通过 `supportsTextureQuality` 声明支持，再接收 `textureScale`（1/2/4），旧桥继续原始画质。浏览器模型与渲染使用同一个应用时钟，显式桌宠可见性优先于非活动 WebView 的隐藏状态；原生隐藏等待可由命令唤醒。测试范围和测量见[本次移植复核与修复报告](../../archive/audits/live2d-port-fixes-2026-09-12.md)。本轮复用主工作区已有的 Cubism Native 5-r.5，以隔离输出完成 `cargo check --tests --locked --offline` 和 C++ 桥编译；6 项纯 Rust 测试、312 项关键浏览器回归和 2 项桥模拟测试通过。未完整链接或运行原生应用，以下历史原生 PASS 不适用于本轮新增原生逻辑。

Native 路径已完成产品链路和 renderer 收口，但仍是桌面发布门禁的一部分，不替代浏览器路径，也不能在 D-10 完成前称为正式发布版本。浏览器默认使用 `wl-live2d`；Companion 可见启动时才按桌面契约请求 Native，`--hidden`、隐藏窗口和用户显式关闭时不得下载或加载大模型。

宁宁与夏目 Native release snapshot 的角色完整性、动作、口型、情绪、hit-test、mask、透明度和颜色均通过人工检查。与 wl-live2d 对照时，同一动画帧的姿势、构图和部件完整性一致；剩余明度/饱和度差异属于校准级差异，不是结构缺陷。

## 架构与链路

```text
ChatCharacterStage / useLive2D
  -> src/live2d/browserBackend.ts | nativeBackend.ts
  -> window.aicsLive2dNative
  -> Tauri shim / bridge
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
- `src/types/live2dNative.ts` 与 `docs/research/desktop/live2d-native-overlay-plan.md` 是 IPC 公共契约；新增命令沿用 typed command/reply，不暴露任意路径、参数或执行能力。
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

## 验证证据

- `cargo test --locked --manifest-path desktop-tauri/src-tauri/Cargo.toml`：13/13。
- `npm run test:live2d-native:release`：3/3 snapshot，exit 0；真实加载宁宁/夏目并覆盖动作、口型、情绪、hit-test 和 PNG。
- `node scripts/tests/test-live2d-backend.js`：24/24；`node scripts/tests/test-live2d-native-contract.js`：5/5。
- renderer release soak 命令使用 800x800、165 FPS、300 秒、每 60 秒切角；约 47,960 帧、4 次切换、`render_fps=164.3`。预热后无静态资源随帧创建，Working Set/private/GPU 首末差在阈值内，最终资源释放通过。
- 可见 Companion 人工回归覆盖 cold start、窗口 move/resize、透明区域穿透、Live2D 关闭/恢复、宁宁/夏目 hit-test、重复动作 busy 和隐藏；当前环境中窗口保持 ready。

## 外部参考与工作纪律

- `AyagamiDev/ayagami`：已通过 `api.github.com` 验证存在，用于 wgpu mask、premultiplied alpha 和混合语义对照；不是本项目的运行时依赖。
- `pixi-live2d-display` 与本地 `wl-live2d` Cubism renderer：用于官方 mask channel、layout matrix、shader 和 blend 语义对照。
- `Veykril/cubism-rs` 仅作旧版 4-r.5.1 绑定参考；`sena-nana/live2d-rs` 曾被验证为 404，不得再引用不存在的仓库。
- 遇到同一问题连续两次实验无效时，先用 `api.github.com` 验证来源真实性，再查官方文档、issue 或已验证实现；禁止继续盲猜 renderer 行为或自造 IPC 语义。

## 当前限制与接入点

1. D-10 真实安装产品验收仍 BLOCKED：当前会话缺少管理员权限，GPT-SoVITS 离线，只有 100% 单屏，125/150% DPI、多屏、真实安装/迁移/卸载和 self-hosted Windows workflow 尚无完整证据。
2. renderer selftest 和 renderer soak 不能替代安装包产品链路；D-10 还必须验证资源路径、窗口对齐、真实 TTS 口型、隐藏/恢复和 300 秒安装产品稳定性。
3. 夏目 `ParamMouthForm3` 的真实 TTS 桌面回归仍待环境恢复；离线映射 contract 已通过，不得据此宣称真实音频已验收。
4. 30 分钟 soak 是发布前可选强化；当前固定 Windows Native gate 是 300 秒，不应加入无 GPU 的默认 `validate`。
5. 后续接入只使用 `src/types/live2dNative.ts`、`live2d-native-overlay-plan.md` 和公开 backend API；不得把参数级 hack、源项目 WAV 或未验证 motion/expression 当作新能力。

## 2026-08-14 契约收尾：destroy 长期复用正式化 + IPC 命令清单锚点

- **destroy 契约统一**：`clear_model_state` 提取为 SetCharacter 前置与 Destroy 共用的"清模型状态"函数；Destroy 只清模型级状态（model_ready/character/model_bounds/口型诊断），**保留** window_ready/renderer_attached/cmd_tx——渲染线程与窗口长期复用，前端 destroy 后重新 `setCharacter` 直接复用 wgpu 上下文，不重建线程；线程退出路径（窗口销毁/通道断开/致命错误）才广播 `aics:live2d:stopped`，destroy 不触发。Rust 单测 `destroy_clears_model_state_but_keeps_thread_for_reuse` 锁定该契约。
- **Tauri command origin 校验**：契约测试新增「Native IPC command inventory」——11 个 `aics_live2d_*` 命令在 build.rs app_manifest / main.rs invoke_handler / capabilities 权限三处必须一一对应（防漂移），且 capabilities 只允许 Companion 窗口 + `http://127.0.0.1:*` 本机回环来源。
- 验证：`cargo test --locked` 16/16（新增 destroy 契约单测）、`test-live2d-native-contract.js` + `test-live2d-backend.js` 29/29、unit 全量 319/319、test-chat.js 通过、release selftest 3/3 快照。
- 多屏/高分屏验证项（monitor work area、多屏混合 DPI）：本项目为个人单屏本地使用，当前无多屏环境；代码层已做进程级 per-monitor v2 DPI awareness 与物理像素坐标跟随，理论正确。此两项不阻塞个人使用，仅在将来于多屏机器上运行时按"验证证据"清单复核即可（见文末）。

## 2026-08-13 壳侧：渲染线程 stopped 事件与进程级 DPI awareness

- `live2d_overlay.rs` 新增 `emit_stopped`：渲染线程任何异常退出路径（窗口创建失败、render context 初始化失败、render frame 错误、命令通道断开）都会广播 `aics:live2d:stopped`（payload `{reason}`）并清理 ready/attached/starting 状态，前端据此显示"渲染已停止"并可重试重新拉起线程；正常 `destroy` 命令不退出线程，不触发本事件。
- `main.rs` 在 `tauri::Builder::default()` 之前（进程最早期、任何窗口创建前）设置 per-monitor v2 DPI awareness，失败回退 system-aware——覆盖 Companion WebView 窗口创建时机，不再只依赖 overlay 线程内的设置。
- `shim.rs` 新增 `onStopped` 订阅；`src/types/live2dNative.ts` 契约新增 `onStopped(listener)`。
- `nativeBackend.ts` 新增 `NATIVE_RENDER_STOPPED` 错误名与 `errorListeners`：`onStopped` 事件转发为 `onModelError`（`error.name = NATIVE_RENDER_STOPPED`），`useLive2D` 识别该错误名后显示"Live2D 渲染已停止"（degraded + retryable），与"动作/换装失败但模型仍显示"的退化路径区分；destroy 时清理。
- 验证：`cargo test --locked --manifest-path desktop-tauri/src-tauri/Cargo.toml` 15/15（含本批 stopped 补丁的编译证据，08-13 竞态补丁此前缺编译验证，本次已补齐）；`test-live2d-backend.js` + `test-live2d-native-contract.js` 27/27；`test-chat.js` 通过。
- 环境备注：本机 Rust 工具链实际位于 `C:\Users\Administrator\.cargo\bin`（PATH 未含）；`cargo test` 需要 `src-tauri/binaries/node-x86_64-pc-windows-msvc.exe`（externalBin sidecar，gitignore）与 `src-tauri/resources/`（`node scripts/maintenance/desktop-stage-resources.js` 生成，gitignore）就位；`npm_execpath` 指向 pnpm 时会破坏暂存脚本的 npm ci，需 `Remove-Item Env:npm_execpath` 后用内置 npm-cli.js。
- 仍未处理的发布风险（需真机/多屏环境）：真实 monitor work area、多屏混合 DPI、Tauri command origin 校验（capabilities 已限 Companion 窗口 + 127.0.0.1）、`destroy` 长期复用 vs 完整退出线程的契约统一（当前实现为长期复用：释放模型、保留线程，前端 destroy 后可重新 setCharacter）。

## 2026-08-13 接手收尾：工作区遗留改动盘点与修复

- **窗口 bounds 注入收尾**：`desktopWindowBounds` 提升为模块级窗口状态（Companion 单窗口），`windowBoundsFromScreen` 优先返回注入 bounds、未注入时回退 `screenX × dpr`；删除 useLive2D 函数内的重复声明，`layout()` 在 bounds 注入前暂停原生 overlay（不猜首帧）。`test-live2d-native-contract.js` 的 `setDesktopWindowBounds`/`desktopWindowBounds = null` 断言保持成立。
- **setOutfit 夏目分支还原**：恢复"夏目只有咖啡店制服、无 Expressions、不得调用 expression"的既有契约（工作区残留版本错误调用 `model.expression(target.expression)`，类型不通过且违反角色契约）。
- **AICS_DESKTOP_PACKAGED 注入口径**：`AICS_DESKTOP_PACKAGED` 仅由 Tauri 壳打包模式注入（`main_shared.rs` gateway_env；dev 模式不注入），维护路由 501 契约与 test-gateway-contract 锚点不变。
- **训练脚本修正**：`prepare_nene_anima_v20.py` 保留 08-13"统一训练、不分区隔离 r18"决策（train/validation 两分区），但恢复 `safety_tag` 按真实内容分级（safe/sensitive/nsfw/explicit，遵守 `anima-training-record.md` 的长期协议节，原 `anima-reproduction-protocol.md` 于 2026-08-14 并入）与 R18 样张的 `nene_r18` 评级词。
- **视觉基线还原**：`design-system.css` 圆角/阴影 token 与 `companion.css` 身份卡样式还原到 DESIGN.md §Shapes（8–24px 阶梯）基线——工作区残留版本把圆角收到 4–16px、阴影减半，与 08-01 已提交的"博客式二次元圆润感"决策和 DESIGN.md 冲突且注释未同步。
- **实验残留清理**：删除 `test-grok-46.js`（含明文 API key），移除仅为该脚本添加的 `@ai-sdk/openai`、`ai`、`jsonc-parser` 依赖（package.json / package-lock.json 还原）。
- **E2E 漂移修复（6be3a95「受控路线」遗留）**：已提交的绘图页"系统自动选择引擎路线"（basic 模式默认 Anima + V20B，engine-switch/baseModel/SD 参数 pro-only）使 studio/flows/anima-quick 十余个用例红：
  - `mock-stack.js` 补 V20B LoRA fixture（`ayachi_nene_v20_anima_scientific_b_e16.safetensors`），否则 Anima 引擎在测试环境 offline、badge 恒 offline；
  - flows.spec.ts：`openGenerationSettings`/新增 `switchToSdEngine` helper 先切专家模式 + SD 引擎；flow-1/1b/1c/4/6d 前置切引擎；flow Anima 先切专家模式；flow-6/6f 断言适配受控路线（Anima exact-token、comfy latent 832×1216 + V20B LoRA、SD quick key 不被 Anima 污染）；
  - studio.spec.ts：basic 断言 `#baseModel` 隐藏 + `.managed-route-card` 可见，专家模式切 SD 后再断言 `<lora:`/`[NEG]`；
  - anima-quick.spec.ts：全部用例在点 engine-switch 前切专家模式；请求角色断言 `nene` → `nene_b`（V20B 变体，6be3a95 预期行为）。
- **多根组件修复（route-view class 丢失）**：GalleryView/SceneExplorerView 的根级 `<Teleport>` 使组件多根，Vue 不向多根组件继承 fallthrough attrs，`AppLayout` 注入的 `route-view` class 丢失 → `#main .route-view` 不可见、repeated-navigation 用例失败。把 Teleport 移入根 `<article>` 内（仍渲染到 body，行为不变），恢复单根；ShowcaseView 原本就是单根，不受影响。验证：interaction-polish.spec.ts 7/7。
- **导航动效测试逻辑修复**：interaction-polish「archive icon」用例在 `goto('/scene-explorer')` 后 dispatch click 到同路径链接——vue-router 判定 duplicated 导航不执行 beforeEach，`data-route-motion` 永不更新。改为从首页直接 SPA 导航（探测证实：首页导航 seen=["","standard",""]，同页重复导航 seen=[""]）。验证：interaction-polish.spec.ts 7/7。
- 验证：`typecheck:app`、`typecheck`、`npm run build`（bundle 预算绿）全通过；live2d/chat/prompt-compiler/showcase-candidate/control-failure 等 72 单测全绿；E2E studio + flows 16/16、anima-quick 15/15、interaction-polish 7/7、**全量 226/226 通过**。

## 2026-08-13 启动竞态修复

- `live2d_overlay.rs` 新增 `starting` 原子门控；并发 `ensure_overlay()` 只允许一个 Win32 overlay/render thread 进入启动流程。
- `window_ready` 延迟到 `RenderContext` 成功建立后设置；窗口创建、renderer 初始化、命令通道断开、致命 render error 与消息循环退出统一销毁 HWND 并清理 ready/attached/starting/channel/model 状态，后续调用可重新启动。
- JS/源码契约验证：`test-live2d-native-contract.js` 3/3、`test-live2d-backend.js` 21/21。当前机器没有 `cargo`/`rustfmt`，因此本次 Rust 增量尚未重新执行 `cargo fmt` 与 `cargo test --locked`；上方历史 13/13 不能冒充本次补丁的 Rust 编译证据。
- 仍未处理的发布风险：真实 monitor work area、多屏混合 DPI、进程最早期 DPI awareness、renderer stopped/error 前端事件、Tauri command origin 校验，以及 `destroy` 是长期复用还是完整退出线程的契约统一。

## 2026-08-13 Companion 陪伴表现与凝视平滑

- 前端新增纯 TS `companionPresence.ts`，把可见性、勿扰/安静时段、聆听、思考、说话、输入中与主动提醒归一为确定性 presence；只驱动舞台光和状态提示，不新增 LLM/TTS 调用，也不触发未验证 motion/expression。
- `CompanionView` 将 presence 下发到 `ChatCharacterStage`，输入聚焦显示“在听你说”，回复中/工具调用显示思考，TTS 播放显示说话，主动提醒显示 reaching-out；reduced-motion 只保留短淡变。
- `useLive2D` 的窗口内与全局鼠标不再逐事件直写 focus/bridge，而是只更新凝视 target，由单一 RAF 以指数响应平滑追随；窗口外凝视钳制为 `0.82`，DOM 离开且无全局接管或窗口隐藏时自然回中。
- `nativeBackend.ts` 对 `setGaze` 增加 latest-wins 背压：桥调用未完成时只保留最新目标，避免高刷新鼠标输入积压 Tauri command。Rust overlay 无需新增参数、动作或 IPC，只继续接收现有 `setGaze(x, y)` 意图。
- 验证：Companion/Live2D/Native contract 定向单测 42/42，`npm run typecheck:app`、`npm run build` 通过；浏览器实测 1280×720 与 768×900 均无横向滚动，状态提示与左侧角色切换、右侧 Live2D 状态不重叠。

## 2026-08-16 桌宠"透明框"、模型偏置、点击闪烁与清晰度全链路修复（用户照片反馈）

> 现象 → 根因 → 修复 → 验证 完整记录。涉及前端 CSS、native renderer、overlay shell 三处，均已真机验证。

### 现象

1. 夏目 Live2D 整体外围有可见的"透明框"（浅色矩形底板），宁宁没有。
2. 点击 Live2D "有机率闪烁"。
3. 模型渲染"像没有抗锯齿"，放大后衣服纹理不如以前清晰。
4. （顺带发现）桌宠点击角色任何分区都触发同一个"外框"反应。

### 根因（逐条，均经像素/视觉/代码三重取证）

1. **透明框 = 两层叠加**：
   - CSS 层（WebView）：`html.companion-desktop .portrait-stage::before` 冷白径向光晕（`rgba(225,231,255,.34)`，0816 二轮加的"角色背光"）+ `.portrait-stage::after` 的 `--companion-wash` 亮色 1px 网格框线（14%/86%、25%/72% 四边）在桌面超透明窗上显成可见浅色框。
   - 模型层（overlay）：夏目源模型自带三块可见的 4 顶点矩形 drawable——**d101 / d102（外框命中网格）/ d104（全画布底板）**，面积 3.545/0.652，合围成角色背后的浅色板。宁宁模型没有 → 宁宁正常。用户猜"是 live2d 本身自带的"——正确，就是模型自带的。
   - 取证方法（重要，可复用）：overlay 窗口"可见 vs 隐藏"两帧像素差分（overlay 清屏 `Clear(TRANSPARENT)` 为真透明）；主窗口/overlay 矩形必须用 **DPI-aware 进程**测量（`SetProcessDPIAware` + `GetWindowRect`，本机 dpr=1.75，非 DPI-aware 的 GetWindowRect 全是虚拟化逻辑像素，曾导致大量错误截图结论——用户明确指出"窗口级截图"后改用 CDP `Page.captureScreenshot` + DPI-aware 物理矩形捕获）。

2. **点击闪烁**：
   - 主要来源 = 互动动作驱动的叠层显隐（Tap* 动作曲线改 PartOpacity/参数）叠加 `content_bounds` 只统计**当前可见** drawable——动作隐藏部件时拟合包围盒变化 → 角色整体跳位一帧 = 闪烁。另叠加"外框"大矩形命中区让每次点击都播 TapFrame 动作（叠层闪动最频繁的一组）。
   - 修复后连拍 26 帧验证：动作平滑起止、无闪帧。

3. **不清晰/像没抗锯齿**：
   - native overlay 一直无 MSAA（`sample_count:1`，历史从未有过）；浏览器 wl-live2d 路径是 `resolution:2`（2× 超采样）→ 用户记忆中的"原先清晰"= 浏览器路径。native 1× 直渲在 1.75 dpr 下边缘阶梯 + 纹理细节不足。
   - 修复 = **2× 超采样**（与 wl-live2d 对齐）：模型渲染进 2× 离屏目标（SSAA + 纹理细节翻倍），线性降采样 blit 回 swapchain。

4. **点击分区失效**：model3.json HitAreas 顺序"外框"第一，且外框网格是覆盖角色躯干的大矩形 → Core 命中测试返回列表首个恒为外框 → 所有点击都播 TapFrame（"夏目抬眼看了你一下"）。

### 修复

- `src/assets/css/companion.css`：桌面模式 `.portrait-stage::before` / `::after` 一律 `display:none`（不再绘制任何背景层；保留脚部暗色地面投影与立绘深影）。
- `desktop-tauri/native-live2d/src/model.rs`：
  - `Model` 新增 `hidden_drawables`（`set_hidden_drawables`），`drawables_into` 对隐藏 id 置 `visible=false, opacity=0`（仅影响渲染快照，Core 状态/命中/动作不受影响——外框命中区 d102 仍可点）。
  - `content_bounds()` 改为全量 drawable 静态包围盒（不再随动作可见性变化）→ 拟合永不跳动。
  - `ViewTransform` 增加 `center_x/center_y`（fit_content 以内容包围盒中心对齐屏幕中心，兼容画布内偏置模型）。
- `desktop-tauri/native-live2d/src/renderer.rs` + `shader.wgsl`：`draw_frame` 新增 `supersample` 参数——渲染进 2× 离屏目标（`ensure_ss_texture`），`vs_blit/fs_blit` 全屏三角线性降采样回 surface；mask 通道同样 2×（`ensure_mask_resource` 按尺寸自动重建）。环境变量 `L2D_SUPERSAMPLE=0` 可关闭。
- `desktop-tauri/src-tauri/src/live2d_overlay.rs`：`hidden_drawables_for("natsume") → [101,102,104]`（`load_model` 挂载）；`render_frame`/`hit_test` 超采样时统一用 2× 渲染空间（fit_content、screen_to_canvas 同步），诊断 model_bounds 换算回显示空间。
- `src/composables/useLive2D.ts`：`interactionFromHitAreas` 对夏目把非"外框"分区前置，外框仅作兜底（点击角色外框空白处仍触发"抬眼"）。
- `desktop-tauri/native-live2d/examples/render_frame.rs`：新增 `--hide 101,102,104` 用于离线 A/B 验证。

### 验证（真机）

- 隐藏 101/102/104 后 overlay 可见/隐藏差分无低幅条带；角色两侧采样为纯壁纸色（103,158,206，不再是提亮色 130,165,210）；离线渲染差分证实三块板就是居中全高淡色条带。
- 2× 超采样后角色区最强边缘过渡 27px → 14px（近 2 倍锐度）；颜色/合成正常；`L2D_SUPERSAMPLE=0` 可回退。
- CDP 分区点击：裙区→"触发了裙摆互动"、腿区→"夏目别开了视线"（头/手区仅命中作者外框网格→抬眼，作者几何如此）。
- 宁宁切换正常（隐藏列表仅夏目）。
- 点击连拍 26 帧：无闪帧、动作平滑。
- 打包链路：`npm run build:tauri` → `npm run package:tauri` → `setup.exe /S` 静默安装 → 清理 3123 → 带 CDP 重启验证（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`；注意：应用被提权启动时该环境变量无法从普通会话传入，且非提权 SendInput 无法点击提权窗口——验证需让应用以非提权运行）。

### 遗留/后续

- 浏览器 wl-live2d 路径未隐藏三块板（/chat 中启用夏目 Live2D 仍会看到淡色底板）——需 pixi `internalModel.drawables` 的 per-frame 覆盖钩子研究后再做；桌面 native 已修复（用户实际环境）。
- 渲染器仍无 MSAA（2× 超采样已等效 SSAA，无需再加）。
- 桌面端 CDP 辅助脚本：`scripts/maintenance/cdp-shot.js`（WebView 窗口级截图 + DOM 状态）、`cdp-verify.js`（部署后验证）、`cdp-interact.js`/`cdp-taps.js`（分区点击回归）。

## 夏目 idle 眼睛发灰（2026-08-16 疑难留档）

**现象**：桌面 Companion 常态（Live2D idle）夏目眼睛灰暗无神（整个眼球泛灰白、虹彩极淡、无高光）；点击互动动作时正常；动作结束回 idle 又灰（循环）。

**根因**（数据实证链）：
1. **图片/CSS/浏览器路径全部正常**：静态立绘 `natsume-official.webp` 眼睛琥珀色+高光；CSS 仅 drop-shadow；浏览器 wl-live2d 复现脚本 idle/tap 截图眼睛均正常（vision 对比确认）。
2. **动作曲线实锤**：解析全部 Idle/Tap motion3——夏目作者 Idle 眼曲线大量把 `ParamEyeLOpen/Open2` 压到 0~0.5（min=-0.1 全闭、左右眼不同步），而多数 Tap 动作（Chest_1/Frame_1/Hand_0 等）恒 1 全开 → idle 闭/半闭、互动全开、回 idle 又闭（循环吻合）。
3. **native 缺覆写**：浏览器端 `blinkScheduler` 每帧 weight 1 覆写双眼参数（并随机眨眼），native 端 `live2d_overlay.rs` 此前**零眼睛参数逻辑**；C++ 侧 `CubismEyeBlink` 非眨眼期不写参数，救不了作者闭眼曲线。
4. **排除项**：hidden_drawables 101/102/104 = ArtMesh60/61/63（背景板，浏览器 coreModel `getDrawableIds` 实证），眼睛是 Yanjing_L2(5)/Yanjing_R2(13) 带 mask，无误伤；模型无 pose 文件；motion PartOpacity 曲线全 1。

**修复**：`desktop-tauri/src-tauri/src/live2d_overlay.rs` 实现 Rust 版覆盖式眨眼 `BlinkState`（与前端 `blinkScheduler.ts` 同参：2.5-5s 随机间隔、closing 0.09s / closed 0.06s / opening 0.16s，xorshift 随机源复用 motion_seed 同款），`step()` 在 `model.update` 后以 weight 1 覆写双眼参数（对齐前端"覆写必须在 UpdateMotion 之后"时序）；登场（Start 组）期间暂停覆写（作者登场眼曲线左右同步含开场闭眼，原样呈现，对齐前端 entranceUntil）。参数组 `blink_params_for` 对齐前端 `BLINK_PARAMS`：夏目 ParamEyeLOpen/Open2、宁宁 ParamEyeLOpen/ParamEyeROpen。

**验证**：cargo test 22/22 通过（新增 `blink_state_cycles_open_closed_and_returns_to_open`、`blink_params_follow_frontend_mapping`）；cargo check 通过；需重新打包桌面端生效（`npm run build:tauri` → `package:tauri` → `setup.exe /S`）。

**追加修复（8da53b8，同日晚）——"触发动作后眼睛又灰"**：眨眼修复后常态正常，但互动动作后眼睛复灰。根因（浏览器参数快照 + 动作曲线差集实证）：
1. **前端复位统一写 0 错误**：Param37-43/52-55/58-61/63 的隐藏态是 **-1**（moc3 默认值，idle 采样实证）——写 0 落在显示区间 → 叠层半透明残留成重影（"衣服重复显示"）；Param18/44-51/56/57/62 隐藏态才是 0。**复位必须按参数分组写隐藏态**（前端 `NATSUME_RESET_PARAMS` 带 value 映射；native C++ 写 `GetParameterDefaultValue` 天然正确）。
2. **Param37、Param64 被 Tap 驱动但不在任何复位清单**（双端遗漏，TapFoot_1 驱动 Param64）→ 补入。
3. **浏览器端 Start 登场变体（Start_1 等）也驱动叠层参数，结束后无复位**（native 有）→ 前端 Start 成功后 5.6s 定时复位。
4. 浏览器端 Start 后偶见"局部叠层残影"（颈部/胸口另一套姿态半透明轮廓）——已知浏览器后端画布残影问题的轻量表现（`companion-ui-research.md` 已记录），native 整帧重绘不受影响；用户实际环境走 native。

**教训**：
- **"动作后灰"的残留源不只是参数值，还有"复位值是否正确"**——复位到错误的值（0 vs -1）等于没复位，甚至更糟（中间态半显示）。
- **复位清单要与动作曲线差集对齐并定期复查**（新动作/变体可能驱动清单外参数，如 Param64 是 TapFoot_1 独有）。
- **隐藏态通过"模型加载后 idle 参数快照"实证**（无动作驱动时的值 = moc3 默认），不要猜。

**教训**：
- **"点击后正常"的循环现象 = 状态相关（动作 vs idle 参数差异），不是静态渲染 bug**——先按状态切分复现（idle/tap/结束后三段），再查参数曲线，比直接怀疑渲染器快得多。
- **浏览器端正常不代表 native 正常**：浏览器有参数级 hack（blinkScheduler 覆写），native 只传意图——"双端行为差异"先查两端各自的前置覆写逻辑，再查渲染器。
- **drawable 索引映射用浏览器 coreModel 实证**（`getDrawableIds`/`getDrawableBlendMode`/`getDrawableMaskCounts`），别猜。

### 追加修复（6809c9f）——C++ 显式隐藏态 + 切换角色点击失效

1. **C++ 复位不再依赖 `GetParameterDefaultValue`**（其值未经验证），改与前端 `NATSUME_RESET_PARAMS` 一致的显式隐藏态分组（0/-1），native 与浏览器复位行为完全一致。
2. **切换角色后互动点击无反馈**：`bindInteractionEvents` 守卫 `if (pointerClickHandler) return`——角色切换重建 session 后订阅重建被跳过，新 session 的 `onNativeHitTest` 无人接收 → 点击无任何反馈。改为**幂等重建**（先解绑旧 click 监听与 native 订阅再完整重建）。
3. **C++ 注释必须纯 ASCII**：中文注释在 GBK 代码页（cl.exe 936）下编译失败（C4819/语法错），新注释一律英文。

### 追加修复（172e2fa）——静止几秒后眼睛发灰

**根因**：**Idle_6 待机动作驱动 Param36/37 离开隐藏态**（拉到 5+）→ 静止时 Idle 轮换到 Idle_6 → 叠层显示 → 灰；互动拉回隐藏态恢复，回 Idle 又灰。
**修复**：**叠层参数每帧守卫**——非互动/非登场期间强制写回隐藏态（`force_overlay_hidden`，C++ 与 reset 共用隐藏态表；前端 `applyParameters` 同步，`activeInteraction` 为空且非登场时每帧写回）。**叠层只允许在互动/登场动作播放时显示**。
**教训**：**Idle 组也要查曲线**——不只是 Tap/Start 驱动叠层，待机动作同样可能（Idle_6 是 5.13s 的变体，轮换到它就灰）。

### 追加修复（7865a51）——互动后长时间发灰（最终闭环）

**根因**：TapSkirt 等互动后 **Param36 残留 -0.49**（moc3 默认 0）驱动"上半脸阴影层"（眼睛发白灰影）；Param36 不在此前任何守卫清单（只覆盖 18/37-64）。
**定位方法（可复用的完整链路）**：
1. **离线渲染复现**：`cargo run --example render_frame -- --dir assets/live2d/natsume --motion-group TapSkirt --motion-index 2 --frames 480` 复现灰影（native 渲染器离线渲染与运行时同源）；
2. **--no-mask 排除 mask**；drawable opacity/visible dump 对比排除层状态；
3. **L2D_RESET_ALL=1 全参数重置 + 刷新一帧 → 灰影消失**（参数驱动实锤）；
4. **C++ 打印"当前值≠默认值"参数 diff**（`GetParameterId(i)->GetString().GetRawString()`，注意 API 返回类型）→ 残留清单：Param36=-0.49（默认 0）、Param59/60=-0.51（默认 -1，已在守卫）、其余为姿态/物理参数（Idle 覆盖）；
5. **physics3.json 输出清单核对**：Param36 非物理输出（物理输出仅 Qunzi/HairSide/Guodongyan/Param21-30 等）→ 纯动作残留。
**修复**：Param36（隐藏态 0）补入前端 `NATSUME_RESET_PARAMS` 与 C++ `apply_overlay_hidden`。

### 追加修复（2026-08-23）——换装互动结束时"闪一下"回切（overlay settle 平滑回落）

**现象**：夏目触发含换装叠层的互动（Tap\*），动作结束服装变回原样时过渡不自然、像闪烁。
**根因（真实 moc3 + TapSkirt_0 模型级实测）**：作者尾部收回曲线其实存在（TapSkirt_0 在 t=1.517-1.9 把 Param59/60 从 0 收回 -1），但 Cubism 5-r.5 对 Loop 动作的 V2 fade 机制（`CubismMotion::DoUpdateParameters`：`v = sourceValue + (curve - sourceValue) × fadeWeight` 逐帧反馈追赶，自然结束前 fadeWeight 归零）让收回只应用到半途——动作 `is_finished` 时 Param59 停在 ≈-0.34（半显示区间）。旧实现随后的复位是**单帧硬写隐藏态**（native `reset_overlay_params` / 前端定时器一次性写 + 每帧 `force_overlay_hidden` 守卫），换装部件一帧内消失、原服装一帧回穿 = 肉眼"闪一下"。另有个别动作曲线本身就停在显示态（Start_4 结束时 Param50=27.4、TapFoot_1 结束时 Param62/64 与隐藏态互换），同样被硬写闪回。
**修复（双端同款语义）**：复位改为 **smoothstep 平滑回落**——
- native：C++ 新增 `l2d_model_begin_overlay_settle`（捕获 36 参数现值）+ `l2d_model_step_overlay_settle`（0.5s 缓动，`OVERLAY_SETTLE_SECONDS`）；`advance_motion` 在 Interaction/Entrance 结束时 begin；`step()` 回落期间跳过硬性守卫、结束后恢复（Idle→Idle 轮换不回落）。
- 浏览器：`useLive2D` 以"所有权交接"检测（`overlayByMotion` 边沿）在 `applyParameters` 内启动同款回落（`OVERLAY_SETTLE_MS=450`，补偿定时器 +600ms 的晚起步）；互动定时器/登场超时的一次性硬写移除（会破坏回落对现值的捕获）；句柄新增可选 `getParameterValueById`（wl-live2d coreModel 支持），缺接口时退回硬写。
**验证**：`native-live2d/tests/overlay_settle.rs` 模型级闭环（真 moc3 + 真 TapSkirt_0）：动作结束残值 ≈-0.34 → 30 帧单调平滑落到 -1（无单帧跳变、精确落点、幂等零位移）；typecheck/前端 68 测试/cargo 22 测试/打包预算全过。注意：Cubism 框架全局状态非线程安全，测试中模型创建需互斥串行；`run-live2d-selftest.js` 在桌面应用实例运行时会被 single-instance 静默劝退（exit 0 无输出），需先关闭桌宠。
**教训**：**"复位值正确"≠"复位过渡正确"**——参数级复位清单调对了仍可能在视觉上闪（单帧硬切）；作者曲线 + SDK fade 的半途残值要靠运行时把"最后一公里"平滑走完，而不是假设动作结束即隐藏态。

## 新模型接入检查清单（2026-08-16 经验沉淀）

> 目标：新模型一次接入成功，避免逐轮踩坑。全部步骤离线/浏览器可做，不需要反复打包。

**0. 模型初筛（10 分钟，决定适配工作量）**
- 解包 `model3.json` + `motions/*.motion3.json`：
  - **Idle 组干净度**：Idle 动作是否带 ParamEyeLOpen/Open2 闭眼曲线（解析曲线 min/max 与时间占比）——带闭眼曲线 → 必须眨眼覆写；
  - **Idle 组是否驱动叠层参数**（Param36-64 等非姿态参数）→ 必须叠层守卫；
  - 叠层参数数量与隐藏态分布 → 决定复位清单工作量。

**1. 参数隐藏态实证（30 分钟）**
- 浏览器加载模型（/chat 启用），dump 全部参数当前值（live2dcubismcore `_parameterIds`/`_parameterValues`，或 C++ `GetParameterValue` + `GetParameterDefaultValue`）；
- **记录"无动作时的参数值"= 各参数隐藏态**（moc3 默认值），按 -1/0 分组；
- 确认眨眼参数组（`model3.json` Groups.EyeBlink）与前端 `BLINK_PARAMS`/`blink_params_for` 对齐。

**2. 动作曲线差集（30 分钟）**
- 解析全部 motion3：**Tap/Start 驱动、Idle 不覆盖、且末尾值 ≠ 隐藏态**的参数 = 复位/守卫清单；
- 特别注意：**Param36 类"漏网"参数**（驱动了但不在直觉清单里）、各 Tap 变体独有参数（如 TapFoot_1 驱动 Param64）；
- PartOpacity 曲线检查：是否有"恒非 1"或"从 0 拉高"的层。

**3. 双端接线（1 小时）**
- 眨眼覆写（native `BlinkState` + 前端 `blinkScheduler`，参数组按角色）；
- 叠层守卫（native `force_overlay_hidden` + 前端 `applyParameters`，非互动/非登场每帧写回）；
- 复位清单（前端 `NATSUME_RESET_PARAMS` + C++ `apply_overlay_hidden` 同一隐藏态表）；
- 互动事件幂等重建（切换角色不丢订阅）。

**4. 验证（30 分钟，离线优先）**
- 离线：`render_frame.rs` 渲染 Idle 帧 + 各 Tap 结束帧 + `L2D_AFTER_IDLE`（动作后接 Idle）→ 检查眼睛/叠层；
- 浏览器：静止 60s 参数采样（叠层恒隐藏、眼睛恒 1.0）+ 各互动后采样；
- native：打包后按"静止 → 互动 → 结束 → 静止"循环人工检查。

**5. 留档**
- 现象→根因→修复→验证写入本文档；隐藏态表/守卫清单如有变化同步前端与 C++ 两处。
