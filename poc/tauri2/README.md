# Tauri 2 PoC — AI-CG-Studio 桌面壳可行性验证

> 整理日期：2026-10-09。此目录是历史源码样例，依赖已退役的 Node 网关，下面旧步骤不适用于当前主线，不作为受支持启动入口。当前架构见[项目状态](../../docs/project-status.md)与[Live2D 指南](../../docs/guides/desktop/live2d-native-runtime.md)；重新评估需基于当前 Rust 协议另定范围。

## 目标

验证两个致命假设，不迁移任何代码：

1. **Live2D 生死线**：现有 `/companion` 页面（wl-live2d = pixi + cubism4 wasm）在 WebView2 下能否正常渲染、互动、换装、眨眼。
2. **透明窗组合**：透明无边框 + 置顶 + 鼠标穿透 + 全局鼠标事件（`GetCursorPos`）在 125%/150% DPI、双屏下是否稳定。

附带验证：壳 spawn 系统 `node server.js` 网关、`window.companionDesktop` shim 桥模式（前端零改动）。

## 原实验运行方式（不可作为当前入口）

```powershell
# 前置：项目根已有构建产物 dist/；node 在 PATH
cd poc/tauri2/src-tauri
cargo run
```

- 网关在 `127.0.0.1:3000`（本机已被占用时改 `main.rs` 的 `GATEWAY_PORT`）
- Companion 窗口加载 `http://127.0.0.1:3000/companion`

## 热键

| 热键 | 作用 |
|---|---|
| `Ctrl+Shift+Space` | 显示/隐藏 Companion |
| `Ctrl+Shift+P` | 切换鼠标穿透（穿透时恢复交互的唯一入口） |

## 裁剪范围（不做）

- 不迁 windowState/日志/托盘/深链/剪贴板/开机启动/电源事件
- 不改任何前端代码、不动主项目测试链
- 不验证 sidecar 打包 node（开发期用系统 node）

## 验证结果（2026-08-07 实测）

| # | 项 | 状态 | 证据 |
|---|---|---|---|
| 1 | Live2D 渲染/互动/换装/眨眼 | ✅ 通过 | PrintWindow 独立截窗口：夏目制服/发饰/姿势完整，宁宁/夏目切换 Tab 工作；像素 diff 10686/18000 点变化 → 动画播放；"Live2D 已连接" |
| 2 | 透明+置顶+穿透+全局鼠标 | ✅ 通过 | WS_EX_TRANSPARENT 热键切换实测；穿透 ON 点击落到底层 Edge，OFF 点击被窗口接收；GetCursorPos 轮询日志 in_window 正确 |
| 3 | 壳 spawn node 网关 + 页面加载 | ✅ 通过 | 网关 health 200；页面/API 同源正常 |
| 4 | companionDesktop shim 最小子集 | ✅ 通过 | 页面 UI（勿扰/导图/沉浸/角色切换）正常工作 |

**性能记录（本机）**：aics-poc 主进程 28MB；WebView2 12 进程合计 ~1001MB（含 Live2D 常驻）；node 网关 66MB。DPI 100%（125/150% 缩放与双屏未实测，正式迁移前需复测）。

**发现的坑（正式迁移时处理）**：
- `global-hotkey` 的 `to_string()` 输出 `shift+control+KeyP`（修饰顺序+键名与输入字面量不同），需宽松匹配
- tauri 2.11 无 `capture_image`（v1 才有）；窗口截图用 `PrintWindow(PW_RENDERFULLCONTENT)` 实测可行
- WebView2 进程内存 ~1GB（Live2D 场景），与 Electron 同为 Chromium 多进程，换壳不解决内存
- 页面加载前窗口是透明的（无 loading 态），正式版需 ready 后再 show

## 决策门槛

- 假设 1 挂 → 终止，维持 Electron，本目录归档
- 全过 → 立正式迁移方案（另立文档）
