# 绘遇 HUIYU 启动与排错

本页介绍换机安装、源码启动及常见问题排查。桌面安装与素材导入见[离线素材指南](docs/guides/offline-resources.md)，模型与硬件见[模型配置指南](docs/guides/setup-and-models.md)。

## 桌面离线安装

1. **准备安装包**：在 [Release 发布页](https://github.com/starplatium1129-stack/huiyu/releases) 下载完整桌面安装包与配套素材包，程序与素材分开安装。
2. **系统前置（断网机）**：
   - **VC++ v14 x64**：提前从微软官方下载并安装。
   - **WebView2**：若系统尚未安装，需提前安装 WebView2 Evergreen Standalone x64。
3. **导入素材**：安装后打开开始菜单中的“资源安装助手”（或运行安装目录下 `gateway\tools\Install-OfflineResources.cmd`），选择素材包导入。无需 Node.js、Python 或项目源码。
4. **模型准备**：在控制室选择 AI 工作区，准备所选引擎的运行环境和权重，或接入已有服务。已有权重可按[模型配置指南](docs/guides/setup-and-models.md)导入。

## 从源码启动

1. **安装环境**：准备 Node.js (≥22.18) 与 Rust MSVC 工具链，在项目根目录执行：
   ```powershell
   npm ci
   ```
2. **构建与运行**：
   ```powershell
   npm run build
   npm run start:run
   ```
   产品后端由 `runtime-rs` 驱动，默认访问 `http://127.0.0.1:3000`。
3. **前端热重载**：在一个终端运行 `npm run dev:server` 启动网关，另开终端运行：
   ```powershell
   npm run wf -- dev:web
   ```
   访问 `http://localhost:5173`。
4. **桌面端开发**：
   ```powershell
   npm run dev:tauri
   ```
   修改 UI 或内容后可加 `-- --refresh-ui`。

## AI 服务与模型接入

| 能力 | 默认地址 / 环境变量 | 说明 |
| --- | --- | --- |
| **原生绘图** | 控制室 → 绘图与模型 | 支持本机运行和远程绘遇。环境、模型与连接步骤见[原生推理指南](docs/guides/independent-inference.md) |
| **ComfyUI** | `http://127.0.0.1:8188` / `COMFY_HOST` | 选用 ComfyUI 引擎时使用。启动已有服务可用 `npm run wf -- comfy:start` |
| **角色语音 (GPT-SoVITS)** | `http://127.0.0.1:9880` / `TTS_HOST` | 需启动 `api_v2.py`；在控制面板配置参考音频与原文 |
| **本地聊天 (Ollama)** | `http://127.0.0.1:11434` / `OLLAMA_HOST` | 启动 Ollama 后网页自动发现模型，或通过 `OLLAMA_MODEL` 指定 |
| **SD 兼容服务** | `http://127.0.0.1:7860` / `SD_HOST` | 仅用于旧任务查询与历史作品查看，WebUI 需携带 `--api` 参数 |

- **外部 AI 工作区**：源码默认使用同级 `AI/` 目录，可通过环境变量 `AI_WORKSPACE_ROOT` 覆盖；桌面版在 Companion「设置」中指定。
- **图片反推 (PixAI)**：控制室支持一键准备运行环境与模型；手动配置见[模型指南](docs/guides/setup-and-models.md#pixai-默认图片反推)。
- **只浏览无需 AI**：不启动 GPU 或语音服务也可正常浏览场景与角色，AI 服务离线仅影响实时生成。

## 运行配置与凭据恢复

源码默认使用 `runtime/`，可用 `AICS_RUNTIME_ROOT` 指定。安装版从托盘打开实际运行目录。

| 路径 | 内容 |
| --- | --- |
| `config.json` | 服务地址、语音与模型配置 |
| `content/catalog.sqlite` | 人物、场景和蓝图的工作库 |
| `state/gateway_token` | 网关生成的分享令牌 |
| `logs/` | 网关和隧道日志 |

桌宠的通用命令需在网关启动环境设置 `AICS_DESKTOP_COMMANDS=trusted` 并重启，同时在桌宠设置的「本机工具权限」允许命令执行。关闭该权限，或移除环境变量并重启网关，即可撤销执行权限。命令以当前系统账户权限执行。

排错或仅本机使用时，可禁用公网隧道：
```powershell
$env:DISABLE_TUNNEL = '1'
npm run start:run
```

## 常见问题

### 本地网页能打开，但无法生成图片
- 确认从控制室的 **本机地址 → 打开** 进入。
- 源码发布模式需先执行 `npm run build`。在控制室核对当前引擎的连接和模型状态，按所选路径准备原生模型或启动 ComfyUI。

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
- **网页版**：回到原浏览器、原用户配置和原访问地址读取 IndexedDB。清除站点数据会移除本地记录，无痕窗口使用独立存储。
- **桌面版**：保存在本机 SQLite 数据库中，媒体文件由 workspace 独立管理。
