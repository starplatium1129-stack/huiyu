# 绘遇 HUIYU 启动与排错

本页介绍换机安装、源码启动及常见问题排查。桌面安装与素材导入见[离线素材指南](docs/guides/offline-resources.md)，模型与硬件见[模型配置指南](docs/guides/setup-and-models.md)。

## 1. 桌面离线安装

1. **准备安装包**：在 [Release 发布页](https://github.com/starplatium1129-stack/huiyu/releases) 下载完整桌面安装包与配套素材包，程序与素材分开安装。
2. **系统前置（断网机）**：
   - **VC++ v14 x64**：提前从微软官方下载并安装。
   - **WebView2**：若系统尚未安装，需提前安装 WebView2 Evergreen Standalone x64。
3. **导入素材**：安装后打开开始菜单中的“资源安装助手”（或运行安装目录下 `gateway\tools\Install-OfflineResources.cmd`），选择素材包导入。无需 Node.js、Python 或项目源码。
4. **模型准备**：将需要的 ComfyUI 权重、LoRA 或语音权重拷贝到新机对应目录，在控制室配置对应路径。

## 2. 源码开发环境启动

1. **安装环境**：准备 Node.js (≥22.18) 与 Rust MSVC 工具链，在项目根目录执行：
   ```powershell
   npm ci
   ```
2. **构建与运行**：
   ```powershell
   npm run build
   npm start
   ```
   产品后端由 `runtime-rs` 驱动，默认访问 `http://127.0.0.1:3000`。
3. **前端热重载开发**：
   ```powershell
   npm run wf -- dev:web
   ```
   访问 `http://localhost:5173`，需保持网关进程在线以提供 API 与素材。
4. **桌面端开发**：
   ```powershell
   npm run dev:tauri
   ```
   修改 UI 或内容后可加 `-- --refresh-ui`。

## 3. 本机 AI 服务与模型接入

| 能力 | 默认地址 / 环境变量 | 说明 |
| --- | --- | --- |
| **绘图引擎 (Anima / Krea 2)** | `http://127.0.0.1:8188` / `COMFY_HOST` | 默认 ComfyUI 端口；启动已有服务可用 `npm run wf -- comfy:start` |
| **角色语音 (GPT-SoVITS)** | `http://127.0.0.1:9880` / `TTS_HOST` | 需启动 `api_v2.py`；在控制面板配置参考音频与原文 |
| **本地聊天 (Ollama)** | `http://127.0.0.1:11434` / `OLLAMA_HOST` | 启动 Ollama 后网页自动发现模型，或通过 `OLLAMA_MODEL` 指定 |
| **SD 兼容服务** | `http://127.0.0.1:7860` / `SD_HOST` | 仅用于旧任务查询与历史作品查看，WebUI 需携带 `--api` 参数 |

- **外部 AI 工作区**：源码默认使用同级 `AI/` 目录，可通过环境变量 `AI_WORKSPACE_ROOT` 覆盖；桌面版在 Companion「设置」中指定。
- **图片反推 (PixAI)**：控制室支持一键准备运行环境与模型；手动配置见[模型指南](docs/guides/setup-and-models.md#pixai-默认图片反推)。
- **只浏览无需 AI**：不启动 GPU 或语音服务也可正常浏览场景与角色，AI 服务离线仅影响实时生成。

## 4. 运行配置与数据目录

运行时文件集中在 `runtime/` 目录（已被 Git 忽略）：
- `runtime/config.json`：服务地址、语音与模型配置。
- `runtime/content/catalog.sqlite`：人物、场景、蓝图的开发工作权威库。
- `runtime/state/`：进程 PID、端口及自动生成的网关 Token（位于 `runtime/state/gateway_token`）。
- `runtime/logs/`：网关、控制面板及隧道日志。

排错或仅本机使用时，可禁用公网隧道：
```powershell
$env:DISABLE_TUNNEL = '1'
npm run start:run
```

## 5. 常见问题排查

### 本地网页能打开，但无法生成图片
- 确认从控制室的 **本机地址 → 打开** 进入。
- 确认前端已执行 `npm run build`，且 ComfyUI 已启动在对应端口并加载了匹配的模型。

### 控制面板显示 WebUI / ComfyUI 未连接
- 确认服务进程已完全启动（非加载中）。
- 检查控制面板中的地址/端口与实际服务日志是否一致。
- 检查本地防火墙或端口占用。

### 没有生成分享链接或提示缺少 Token
- 公网隧道（cloudflared）需要连网建立，稍候几秒刷新。
- 从控制面板复制完整分享链接（包含 `?token=...`），首次访问后会自动换为安全 Cookie。

### GPT-SoVITS 已启动但显示未连接或未就绪
- 确认启动的是 `api_v2.py`。
- 若状态为“待配参考音频”，需在控制室配置参考音频的本机绝对路径及对应日文原文。

### 历史记录或图片不见了
- **网页版**：保存在当前浏览器的 IndexedDB 中，清除浏览器缓存或使用无痕模式会导致无法读取。
- **桌面版**：保存在本机 SQLite 数据库中，媒体文件由 workspace 独立管理。
