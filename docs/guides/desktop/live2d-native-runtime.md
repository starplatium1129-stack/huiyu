# Live2D 原生运行时

范围覆盖 Tauri 2 Native Overlay、Cubism Native Renderer、前端双后端接入及当前模型约束。

---

## 1. 架构与后端路由

```text
ChatCharacterStage / useLive2D
  -> src/live2d/browserBackend.ts | nativeBackend.ts
  -> src/platform/desktop/nativeLive2d.ts
  -> hostApi.ts typed IPC / Rust bridge
  -> desktop-tauri/src-tauri/src/live2d_overlay.rs
  -> desktop-tauri/native-live2d (Rust FFI + C++ glue)
  -> Cubism SDK for Native 5-r.5 + wgpu (DX12)
```

- **双后端回退**：浏览器默认使用 `wl-live2d`；桌面 Companion 窗口可见启动时请求 Native Bridge（桥缺失或连接失败自动回退浏览器并标记 `data-backend="browser-fallback"`）。`--hidden`、隐藏窗口或关闭桌宠时不触发模型下载或加载。
- **纹理画质与释放契约**：房间与桌宠支持原始 / 标准（宽高 `÷2`）/ 节能（宽高 `÷4`）纹理缩放（`textureScale: 1|2|4`），不改写源文件。桌宠隐藏时由前端统一销毁模型并释放整个原生 GPU Context（清理 staging 与超采样目标，保留窗口与命令线程），重开时按需重建；若加载中触发隐藏，原生会在当前同步纹理上传完成后处理排队的 `Destroy`。
- **本机导入**：私有导入需核对 manifest、Moc 及目录边界并保留原作者许可，禁止进入发行包；Cubism 2 模型保留浏览器回退。导入工具见 [工作流](../../workflow.md#本机-live2d-候选导入)。

---

## 2. IPC 与窗口坐标契约

- **公开契约（`src/types/live2dNative.ts`）**：
  - 意图命令：`character`、`frame/bounds`、`motion`、`expression`、`mouth level`、`emotion`、`gaze`、`hit-test`、`visibility`、`max FPS`、`snapshot`、`destroy`。
  - 上行事件：`ready`、`motion started/failed`、`hit-test`、`entrance finished`、`visibility`。
  - 只读状态查询不得隐式建窗或启线程；重复 `connect/destroy` 必须清理监听与动作订阅。
- **透明窗口与坐标换算**：
  - Overlay 为独立 Win32 透明窗口（`WS_EX_TRANSPARENT`），`src/utils/live2dOverlayLayout.ts` 负责 CSS rect 与物理像素换算；`setFrame` 只传 Companion-local 物理矩形，Rust 每帧实时跟随 HWND，并将 WebView 点击归一化坐标转发至 Cubism HitArea。
  - **严禁恢复 `SetWindowRgn` 挖洞方案**，否则 DirectComposition 画面会在头发、手脚边缘留下矩形缺口。

---

## 3. 模型专属参数与叠层约束

- **参数时序**：口型、情绪与凝视必须在 `model.update(dt)`、motion/physics/pose 和 Core drawable 更新之后写入，防止被动作曲线覆盖。
- **动作选择**：互动动作必须交由 Cubism 选择可用原生变体，严禁固定变体 index `0`；同动作播放中返回 `busy` 而非强行打断重启。
- **宁宁（Ayachi Nene）**：口型 `0..1` 映射 `ParamMouthOpenY`；`expression1–5` 为校服、常服、睡衣、COS 服、魔女服，仅由显式衣装控件切换，不作情绪使用。
- **夏目（Shiki Natsume）**：
  - 单一咖啡店制服导出态，无独立表情或衣橱开关。口型 `0..1` 映射 `ParamMouthForm3`（`0..-0.5`）。
  - `Param36-61`、`Param62-64`、`Param65-75` 为 moc 内部动画/叠层通道（41 个原生 motion 的 `PartOpacity` 恒为 `1`）。**严禁按连续编号猜衣装、强写零或覆盖 Drawable opacity**（会导致灰眼、重影或重复制服）。
  - 目前通过前端隐藏态表与 Native C++ 表同步，仅在非互动/非登场时守卫叠层并在互动结束平滑回落；仅当新导出模型实测消除残留后方可移除此规避。

---

## 4. Renderer 不可回退的技术约束

- **DX12 Surface**：HWND 必须先 `ShowWindow(SW_SHOWNA)` 再枚举 DXGI format，`SetCharacter` 前先建 surface 并对齐 pipeline format；`Lost`/`Outdated` 立即 reconfigure，`Timeout` 跳帧，`OutOfMemory` 终止循环。
- **Uniform 与 Alpha/Mask**：每个 drawable 必须拥有独立 uniform slot 与按 wgpu 对齐的 dynamic offset；纹理统一 `uv.y = 1 - uv.y`，采用 premultiplied alpha 上传与 `premultiplied over` 混合（sRGB 目标）；同时充当 mask source 的 drawable 不可在主循环过滤，mask 采样使用 clip 空间坐标。
- **资源缓存与清理**：geometry、UV/index、bind group、uniform、upload buffer 与 CPU scratch 仅在首帧预热并缓存，运行帧禁止动态建静态 GPU 资源；换角或 `destroy` 须全部释放，零长度/null FFI 数据须前置检查。

---

## 5. 参考边界与待验说明

- **外部参考**：`AyagamiDev/ayagami`（仅对照 wgpu mask/alpha 语义，非依赖）、`pixi-live2d-display` / 内置 `wl-live2d`、`Veykril/cubism-rs`（旧 4-r.5.1 绑定参考）。**`sena-nana/live2d-rs` 已核实为 404，严禁再引用**。遇连续两次实验无效先核对官方源码或 `api.github.com`，严禁盲猜。
- **验收与限制**：300 秒 Windows Native soak 为当前默认压测时长（不加入无 GPU 的 `validate`）。多屏混合 DPI、真实 TTS 驱动夏目 `ParamMouthForm3` 口型与长时休眠恢复仍按 [项目状态](../../project-status.md) 与 [未来规划](../../roadmap.md) 分别登记。
