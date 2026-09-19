# 绘遇 HUIYU 启动与排错

本页是换机搭建和故障恢复入口。先启动网页与网关，再按需要连接生图、语音和聊天服务；缺少某个可选服务不影响浏览其他页面。硬件配置要求、公共开源底座直链与自训专属 LoRA 说明详见 [全功能开箱指南](docs/guides/setup-and-models.md)。可运行 `npm run wf -- models:check` 快速体检当前环境与模型就绪状态。以下端点与目录按 2026-09-10 源码核对，不代表这台机器上的模型已经安装或验收。

## 从干净工作区启动

1. 安装符合 `package.json` 的 Node.js（最低 22.18，CI 使用的具体版本见 `.github/workflows/quality.yml`），在项目根目录执行 `npm ci`。
2. 执行 `npm run build` 生成网页，再执行 `npm start` 编译服务端 TypeScript 并启动网关。默认访问 `http://127.0.0.1:3000`。
3. 开发网页时另外执行 `npm run wf -- dev:web`，访问 `http://localhost:5173`；保留网关进程，它提供 `/api`、`/data` 与素材。页面能打开但素材一直加载时，先检查网关是否在线。
4. 数据聚合产物由现有构建流程补齐，不把生成的 `services/*.js` 或聚合 JSON 手工复制回 Git。源码分片修改后的构建入口见 [统一工作流](docs/workflow.md)。
5. 在这台机器上执行 `npm run wf -- gate:full` 验证代码、数据契约和构建。参考媒体不入 Git：未配置素材根（`AI_WORKSPACE_ROOT` 或 `AICS_CHARACTER_REF_ROOT`）的机器上，`npm run check` 与 `gate:full` 的 `content-contracts`、`ref-urls` 两步会因参考图缺失而失败——这是预期防线，先按下文恢复素材再跑完整门禁，不要改写索引迁就缺图。只做索引结构核对的办公机可设 `AICS_REFERENCE_AUDIT_MODE=structure`；它只验证索引结构，不能算作图片交付。

## 本机 AI 服务与模型

| 能力 | 默认地址 / 环境变量 | 资源与验证入口 |
| --- | --- | --- |
| SD / WAI | `http://127.0.0.1:7860` / `SD_HOST` | WebUI 需 `--api`；控制面板检查连接 |
| Anima / Krea 2 / 视频 | `http://127.0.0.1:8188` / `COMFY_HOST` | 启动已有 ComfyUI 可用 `npm run wf -- comfy:start`；该入口不负责安装 ComfyUI 或下载模型 |
| 角色语音 | `http://127.0.0.1:9880` / `TTS_HOST` | GPT-SoVITS 权重与参考音频；控制面板配置角色声线 |
| 本地聊天 | `http://127.0.0.1:11434` / `OLLAMA_HOST` | Ollama 模型由 `OLLAMA_MODEL` 或页面选择 |

模型文件名以 `server/anima-model-catalog.js`、`server/video-model-catalog.js` 为准，节点接线以 `routes/anima/workflows.js` 为准。Anima 当前默认 MiaoMiao v1.2 使用 `diffusion_models/miaomiaoHarem_anima12.safetensors`、`text_encoders/qwen_3_06b_base.safetensors` 与 `vae/qwen_image_vae.safetensors`；宁宁、夏目另从 `loras/` 加载目录中对应的 v21 LoRA。Krea 2 的 checkpoint 与编码器不同，不能拿 Anima 文件改名顶替。网关 `/api/anima/status` 返回按当前模型目录核查的可用状态；文件存在仍不代表节点或实际出图通过。

AI 外部工作区默认是项目同级 `AI/`，迁移时设置 `AI_WORKSPACE_ROOT`。参考库可用 `AICS_CHARACTER_REF_ROOT` 明确指定，样张可用 `SCENE_SHOWCASE_DIR` 指定；这些大型资产不在 Git 中，需从自己的资产副本恢复。可选 H3 模型有 `npm run wf -- models:download-h3 --models-root <ComfyUI模型目录>` 入口，使用前检查磁盘与下载量，不随普通安装自动运行。

## 运行配置与凭据恢复

桌面通用命令默认关闭，文件工具仍可在 AI 工作区内读写，并核对目录链接的实际目标。确需运行 Node、Python、npm 等命令时，由操作员在启动网关的环境中设置 `AICS_DESKTOP_COMMANDS=trusted` 后重启；这会授予命令当前系统账户的能力，工作目录不是文件系统沙箱。网页请求、模型参数及普通配置文件不能开启此权限。取消该环境变量并重启即可恢复默认限制；代码更新不会自动启用它。

Windows 的 npm/npx 通过已安装的 CLI JavaScript 入口执行，不启用通用 shell，也不自动安装依赖。提示 `TOOL_UNAVAILABLE` 时检查 Node/npm 安装；提示 `TRUSTED_EXECUTION_REQUIRED` 时先确认确实需要上述执行权限，不能靠修改模型参数解决。

- 服务地址和语音配置保存在 `runtime/config.json`；环境变量优先于保存配置，具体映射见 `server/config.js`。上游仅支持当前电脑的 HTTP loopback 地址。
- 分享令牌由网关自动生成并保存于 `runtime/state/gateway_token`，也可由 `TOKEN` 环境变量覆盖。记录所在位置即可，不把令牌正文写入文档、提交或截图。
- 网关、控制面板与隧道日志位于 `runtime/logs/`。迁移时保留配置和必要凭据，PID 文件属于旧进程，不用作新机服务已启动的依据。
- 本机使用不需要分享令牌。分享链接首次认证后会换为 HttpOnly cookie 并清除地址里的 token；停止分享后再进行配置迁移。排错时可用 `DISABLE_TUNNEL=1` 启动仅本机网关。
- 桌面安装版可能使用独立的运行目录；从托盘的运行目录入口确认实际位置，部署与完整安装按 [桌面部署指南](docs/desktop-deployment.md) 操作。

## 完整模式：连接 SD WebUI

远程访客的生成与取消使用应用任务接口。原生 SD 配置写入、直接生成、中断和 WebSocket 兼容通道只允许本机直连；持有分享 token 不会获得这些全局操作能力。模型、采样器和进度等必要只读查询继续保留。

### 准备条件

- Windows 与 Node.js
- 由 Stability Matrix 启动的 AUTOMATIC1111、Forge 或 ReForge
- WebUI 启动参数中包含 `--api`
- 如需生成公网分享链接，本机还要安装 `cloudflared`

建议在 Stability Matrix 中使用：

```text
--api --port 7860
```

`--api` 不会关闭 WebUI 自带页面，也不会妨碍本地正常使用。它让绘遇通过接口读取配置和提交出图任务。

### 启动步骤

1. 先在 Stability Matrix 中启动 WebUI。
2. 查看日志中的地址，通常是 `http://127.0.0.1:7860`。
3. 双击项目根目录的 `control.bat`。
4. 在控制面板填写 WebUI 地址，等待状态显示已连接。
5. 点击 **启动并生成分享链接**。
6. 自己点击 **打开本地网站（无需 Token）**；需要分享时，再复制带 Token 的链接给朋友。
7. 使用结束后在控制面板「本机服务」区按需停止各服务（网站网关始终在运行，只能停止公网分享）。ComfyUI 与 reForge 无论由面板启动还是手动启动，只要监听的是面板配置的端口、且命令行含 `main.py` / `launch.py`，「停止」都能关闭；占用同一端口的无关进程不会被误杀。

首次运行时，`control.bat` 会自动执行 `npm install`。控制面板默认打开在 `http://127.0.0.1:3001/`，创作网站通常打开在 `http://127.0.0.1:3000/`；如果 3000 已占用，控制面板会显示实际使用的端口。

### 本地使用和朋友分享的区别

- **本地网站**：只允许当前电脑访问，不需要 Token。
- **朋友链接**：通过临时公网通道访问，必须带 Token。
- **没有 cloudflared**：本地网站和 SD 连接照常使用，但不会出现公网域名。
- **重新启动网关**：Token 持久保存在 runtime/state/ 下，重启后保持不变；只有临时公网域名可能变化，需要重新发链接。

朋友不需要安装 SD WebUI，所有生成任务仍由你的电脑执行。请只把链接发给信任的人，并在不用时停止分享。

## 可选：桌面 Companion 应用

Tauri 2 是桌面壳。开发执行 `npm run dev:tauri`，构建 NSIS 执行 `npm run package:tauri`（安装版 `setup.exe` 静默安装 `setup.exe /S`）。桌面 Companion：无边框透明置顶的角色悬浮窗，内置角色聊天、托盘菜单（置顶 / 鼠标穿透 / 开机启动 / 打开运行时与日志）、全局快捷键（Ctrl+Shift+Space 显隐、Ctrl+Shift+A 打开 Atelier 工作台、Ctrl+Shift+P 切换鼠标穿透）、剪贴板感知与安静时段提醒；带 `--hidden` 参数启动时只驻留托盘不显示窗口（适合开机自启）。Electron 回退版已退役（存档见 `desktop-electron-legacy` tag）。

- Companion 会自动拉起（或接管已运行的）本地网关，Atelier 工作台是完整网站窗口。
- Tauri packaged 模式保留维护契约：场景维护相关接口返回 `501 DESKTOP_MAINTENANCE_UNAVAILABLE`；展示集与 home-hero 写入不受该限制。

出图方面，SD/WAI 与 Anima/Krea 2（ComfyUI）双主路径并行：SD/WAI 走 WebUI，Anima/Krea 2 走固定 Comfy 工作流；WAI 兼容请求优先 Comfy，仅超出白名单时回退 WebUI。Krea 无负面词（Turbo CFG≈0 负面失效）；热门角色默认无专属 LoRA，角色一致性靠「角色名+系列+identityProse 外貌散文」锚定（见 `docs/research/prompts/krea2-prompt-research-2026-08-30.md`）；detailer 与 ControlNet 仍依赖 WebUI，仅当 Comfy 可用时的 latent `nearest-exact` hires（1.5x/20 steps/denoise 0.4）与 Remacri 2x 像素超分可走 Comfy 直出。

## 可选：GPT-SoVITS 角色语音

导演工作台提供两层语音能力：

- **本机试听**：按当前选择调用浏览器的日文或中文系统声音，用来检查文本和语速，不需要额外安装。
- **AI 声线生成**：中文阅读文本与配音稿互不影响；画面保持中文，由本机 GPT-SoVITS 专用角色权重默认生成日文 WAV，也可切换中文。朋友通过分享链接使用时，计算仍在你的电脑上完成。

当前电脑已在相邻的 `AI/Voice/` 目录保存数据集、检查点、评测报告、最终权重与参考音频。双击 `control.bat` 时会自动检查并启动语音服务；网关会串行处理请求并按角色切换权重，也可单独运行：

```powershell
../AI/Voice/Start-Voice.ps1
```

语音 API 地址为 `http://127.0.0.1:9880`。若迁移到另一台电脑，可在启动控制面板中重新填写地址，并为宁宁、夏目分别配置：

1. GPT-SoVITS 能读取的参考音频本机绝对路径。
2. 参考音频中实际说出的原文，必须与音频一致。

参考音频及其原文使用日语 `ja`。导演台默认读取场景的日文 `storyJa` 并提取 `「角色台词」`，也可切换中文或朗读完整故事；目标语言会随每次生成请求传给 GPT-SoVITS，不再固定为中文。请只使用你有权使用的声音模型和参考音频。

## 可选：Ollama 角色对话

如果本机安装了 Ollama，启动 Ollama 后打开网站“更多 → 角色对话”即可。页面会自动发现本机模型，默认使用第一个可用模型；也可以通过运行时配置或环境变量指定：

```powershell
$env:OLLAMA_HOST = 'http://127.0.0.1:11434'
$env:OLLAMA_MODEL = '你的模型名'
node server.js
```

聊天记录只保存在当前浏览器。关闭 Ollama 不会影响场景浏览、Prompt 或 SD 出图；角色房间会显示离线状态。开启“回复后自动配音”时，中文回复会先经过现有本地翻译链路，再调用 GPT-SoVITS 生成日语声音。

## 双人构图增强

当前电脑的 reForge 已配置 Regional Prompter、内置 ControlNet 与 ADetailer。导演台选择“宁宁 × 夏目”的双人场景时会自动按当前能力启用：

- **角色分区**：把共同环境、左侧宁宁和右侧夏目的提示词分开，减少脸、发色、瞳色与服装互相污染。
- **姿势约束**：读取 `assets/dual-poses/场景ID.png`，使用 Xinsir SDXL OpenPose 模型稳定两人的位置、朝向与互动关系。
- **双脸精修**：只对 `wide_shot` 或 `full_body` 双人场景启用低重绘幅度 ADetailer，避免近景中已经稳定的官方脸被二次改坏。

这些能力只对双人角色生效。宁宁或夏目的单人生成仍使用已逐场景审核的原模型、Prompt、LoRA 权重和采样参数，不会附带 Regional Prompter、ControlNet 或 ADetailer。

控制面板启动 reForge 时会自动添加共享模型目录：

```text
--controlnet-dir E:\code\2\lora\AI\Data\Models\ControlNet
```

当前姿势模型为 `xinsir_openpose_sdxl_1.0.safetensors`。逐场景姿势图如需重建，请先启动 WebUI，再执行：

```powershell
python scripts/maintenance/generate-dual-pose-assets.py
```

若扩展或模型暂时不可用，网站会按实际检测到的能力自动降级，普通出图仍可继续。

## WebUI 地址不是 7860

Stability Matrix 可能自动分配其他端口。不要猜端口，直接复制日志中显示的本机地址，例如：

```text
http://127.0.0.1:7861
```

在控制面板停止分享后修改地址，再重新启动。地址只接受当前电脑的 `http://127.0.0.1:端口` 或 `http://localhost:端口`。

## WebUI 使用 API 认证

如果 WebUI 的启动参数包含：

```text
--api-auth user:password
```

请在启动 `control.bat` 前打开 PowerShell，并在当前窗口设置：

```powershell
$env:SD_API_AUTH = 'user:password'
./control.bat
```

关闭该 PowerShell 窗口后，环境变量不会继续保留。

## 只浏览页面

不需要启动 GPU 或语音服务，完成网页构建后执行 `npm start` 即可浏览场景与角色。网关负责分片数据、素材目录与页面路由；可选 AI 服务离线只影响对应生成能力。

项目根目录的 `index.html` 是 Vite 源入口，不能直接交给 Python 静态服务器、Live Server 或 `file://`。即使单独托管 `dist/`，仍需配置数据与素材服务及 SPA 路由回退；日常浏览优先使用本机网关。

## 常见问题

### 控制面板显示 WebUI 未连接

依次检查：

1. WebUI 是否已经完成启动，而不是仍在加载模型。
2. Stability Matrix 的启动参数是否包含 `--api`。
3. 控制面板中的地址和日志地址是否完全一致。
4. WebUI 是否使用了 `--api-auth`，以及 `SD_API_AUTH` 是否正确。
5. 端口是否被防火墙或其他程序拦截。

### 本地网站能打开，但不能出图

确认你是从控制面板的 **打开本地网站（无需 Token）** 进入，而不是从 Python、Live Server 或其他静态服务器进入。只有项目网关会代理 `/sdapi`。

### 没有生成分享链接

先确认本地网站可以正常出图，再检查 `cloudflared` 是否安装在：

```text
C:\Program Files (x86)\cloudflared\cloudflared.exe
```

公网通道建立需要网络，通常会比本地网关晚几秒出现。

### 朋友打开链接提示缺少 Token

请从控制面板复制完整链接，不要手动删除 `?token=...`。首次验证后，网站会把 Token 写入安全 Cookie，并跳转到不含 Token 的干净地址。

### 多人同时生成或停止任务

SD WebUI 会按自身能力排队。“停止生成”调用的是 WebUI 全局中断，可能会停止其他人当前正在运行的任务。分享时最好约定不要同时点击停止。

### GPT-SoVITS 已启动但仍显示未连接

确认启动的是 `api_v2.py`，地址和端口与控制面板一致。角色状态显示“待配参考音频”时，说明 API 已连接，但当前角色还缺参考音频路径或对应原文。

### 历史或图片不见了

历史、收藏和图片主要保存在当前浏览器的 IndexedDB 中。更换浏览器、使用隐私模式或清理网站数据，都可能让这些内容不可见。重要图片请及时下载或另行备份。

## 手动启动（排错用）

通常不需要手动运行。需要查看完整日志时，可以在项目目录执行：

```powershell
npm install
npm run build:runtime
$env:SD_HOST = 'http://127.0.0.1:7860'
node server.js
```

`build:runtime` 会把 `services/*.ts` 编译成网关运行所需的 `.js`（产物不入库，fresh clone 后必须先执行一次；`npm start` 与 `start.ps1`/`control.bat` 会自动补这一步）。

默认情况下会尝试建立临时公网通道。如果只想测试本地网关：

```powershell
$env:DISABLE_TUNNEL = '1'
node server.js
```

在当前终端按 `Ctrl+C` 即可停止手动启动的进程。

## 数据与维护

运行时文件会自动集中到 `runtime/`，避免挤在项目根目录：

- `runtime/config.json`：SD、TTS 与角色声线配置
- `runtime/state/`：网关与隧道的 PID、端口和网关 Token（首次启动生成后持久化复用，重启不换；`TOKEN` 环境变量可显式覆盖；长度 64 hex）
- `runtime/logs/`：控制面板、网关和隧道日志（日志中不打印完整 Token）
- `runtime/outputs/`：旧版 `friend_outputs` 的迁移目录（当前无写入端点）
- 控制面板「导出诊断包」：汇总服务状态、网关健康与脱敏日志，便于排错

旧版根目录中的 `.gateway_*`、`tunnel.log` 和 `friend_outputs/` 会在首次启动时自动迁移。`runtime/` 已被 Git 忽略，不应提交。

- `data/scenes.json`：303 个场景（+441 蓝图）
- `data/characters.json`：角色设定
- `data/tags.json`：统一标签
- `data/loras.json`：LoRA 配置
- `scripts/maintenance/validate-scenes.js`：场景一致性校验
- `scripts/maintenance/optimize-scenes.js`：规范标签、镜头、负面词与未解析占位符
- `scripts/maintenance/clean-scenes.js`：批量清洗脚本，运行前会创建备份

日常增删场景或替换样张，请进入网站的“更多 → 场景管理”。点击“保存到项目”时会自动创建备份并执行完整检查，不需要手动运行命令。

只有直接批量编辑场景源文件时，才需要手动执行：

```powershell
npm run validate
```

批量导入或修改 `data/scenes/*.json` 后，可先运行 `npm run optimize-scenes`，再运行校验。不要直接编辑自动生成的 `data/scenes.json`。

批量清洗会直接改写场景数据，不应作为普通启动步骤；只有明确需要整理数据时再使用。
