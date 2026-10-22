# 本地模型配置与换机离线指南

新机部署先安装桌面程序和素材包（参阅 [离线素材指南](offline-resources.md)），随后按需配置本地 AI 模型。  
**素材包提供断网浏览；生图、视频、对话、反推和配音需各自的模型与运行环境。**

---

## 1. 交付物与硬件推荐

### 交付物清单
| 能力范围 | 所需准备 | 验证方式 |
|---|---|---|
| **素材浏览** | 桌面安装包 + 完整素材 ZIP | 启动后可断网浏览角色原图、场景卡片、Live2D 与画册 |
| **PixAI 图片反推** | PixAI v1.0 权重 + Python/Torch CUDA 环境 + timm | `/api/interrogate/status` 确认就绪，对图片执行反推 |
| **Anima 绘图** | 独立运行库（原生）或 ComfyUI + MiaoMiao 1.6 / Base v1.0 + 编码器与 VAE | 控制室确认状态，`/api/anima/status`，成功生成一张样张 |
| **Krea 2 绘图** | Krea 2 Turbo + Qwen3-VL 4B 编码器 + VAE | `/api/creative/status`，成功生成一张样张 |
| **本地视频** | ComfyUI + Wan 2.2 (5B) 或 MiniMax H3 权重与节点 | `/api/video/status`，生成并播放测试短片 |
| **本地对话** | llama.cpp 受管环境 + GGUF 权重（或连接已有 Ollama） | 角色房间发送消息并正常收到流式回复 |
| **中日翻译与配音** | M2M100 翻译模型 + GPT-SoVITS 或 VoxCPM2 环境与角色权重 | `/api/tts-status`，测试翻译与角色语音播放 |

### 硬件显存分档建议
| 标称显存 | 推荐配置 |
|---|---|
| **无独显 / $\le$ 4 GB** | 云端 API 聊天；生图建议使用轻量或远程服务 |
| **6 – 8 GB** | Anima MiaoMiao 1.6 生图；本地聊天推荐 Qwen3.5 4B Q4_K_M (~2.74 GB) |
| **10 – 12 GB** | Anima 绘图 + 高清修复；本地聊天推荐 Qwen3.5 9B Q4_K_M (~5.68 GB) |
| **16 GB** | 支持 Krea 2 Turbo、Wan 2.2 视频；本地聊天推荐 Qwen3.8 27B IQ3_S |
| **24 GB 及以上** | 全能力支持（MiniMax H3 联合音视频、Qwen3.8 27B Q4_K_M 等） |

---

## 2. Windows 原生前置：VC++ x64 离线安装材料

运行原生组件与模型环境需要 **Microsoft Visual C++ 2015-2022 Redistributable (x64)**。在联网准备机上可通过以下命令准备微软原始安装器：

```powershell
# 下载带有官方 Authenticode 签名的 vc_redist.x64.exe 并生成校验清单
./scripts/maintenance/prepare-offline-prerequisites.ps1 -Out 'D:\HuiyuRelease\prerequisites' -Apply
```
将下载的文件带到目标机器，手动运行安装器并根据提示完成安装（如需重启请重启）。

---

## 3. AI 工作区与目录规范

建议在容量充裕的磁盘（如 `D:\HuiyuAI`）统一放置模型与运行库：

```powershell
$env:AI_WORKSPACE_ROOT = 'D:\HuiyuAI'
$env:AICS_PIXAI_CONFIG = 'D:\HuiyuAI\PixAI\runtime-config.json'
```
在桌面端「设置」$\to$「AI 工作区」选择该文件夹并保存生效。

### 推荐目录结构
```text
D:\HuiyuAI\
├─ inference\                  # 原生 Diffusers 运行库与完整模型
│  ├─ models\                  # 完整模型目录（如 anima-base-v1.0）
│  └─ loras\                   # 原生角色与画风 LoRA
├─ ComfyUI\                    # ComfyUI 引擎运行环境
│  └─ models\
│     ├─ diffusion_models\     # MiaoMiao 1.6 / Base v1.0 / Krea 2 / Wan 2.2
│     ├─ text_encoders\        # Qwen 0.6B / Qwen3-VL 4B / UMT5 编码器
│     ├─ vae\                  # 图像与视频 VAE
│     └─ loras\                # 角色 LoRA（如终末地合集、宁宁/夏目）
├─ PixAI\                      # PixAI 反推模型与独立依赖
│  ├─ model\                   # 模型权重与代码
│  ├─ deps\                    # 独立 timm 依赖
│  └─ runtime-config.json      # 本机环境回执
├─ Chat\                       # 本地对话（llama.cpp 运行库与 GGUF 模型）
└─ Voice\                      # 角色语音权重与 M2M100 翻译模型
```

---

## 4. 常用模型清单与放置路径

### PixAI 默认图片反推

默认采用 **PixAI Tagger v1.0**（约 1.95 GB）。  
在源码或维护环境中执行自动准备命令，脚本会自动复用 PyTorch 环境并补充 timm 依赖生成回执：

```powershell
npm run wf -- models:prepare-pixai --target-dir 'D:\HuiyuAI\PixAI'
```
启动绘遇时将通过 `AICS_PIXAI_CONFIG` 或自动发现读取 `PixAI/runtime-config.json`。首次反推加载模型，连续空闲 10 分钟自动释放显存。

---

### Anima 图像底模与编码器

公共起步首选 **MiaoMiao Harem Anima 1.6**，其次为 **Anima Base v1.0**。两者底模约 4.18 GB，共用 Qwen 0.6B 编码器与 VAE：

| 放置路径（相对 `ComfyUI/models/`） | 说明 | 来源 |
|---|---|---|
| `diffusion_models/miaomiaoHarem_anima16.safetensors` | 当前默认底模 (4.18 GB) | [Civitai: Anima 1.6](https://civitai.com/models/934764) |
| `diffusion_models/anima-base-v1.0.safetensors` | 官方基础底模 (4.18 GB) | [HuggingFace: Anima](https://huggingface.co/circlestone-labs/Anima) |
| `text_encoders/qwen_3_06b_base.safetensors` | 专用文本编码器 (1.19 GB) | 共用编码器 |
| `vae/qwen_image_vae.safetensors` | 图像 VAE (0.254 GB) | 共用 VAE |

---

### 角色与风格 LoRA

| 角色 / 范围 | 文件名 | 放置路径 | 说明 |
|---|---|---|---|
| **宁宁 / 夏目** | `ayachi_nene_v21_anima.safetensors`<br>`shiki_natsume_v21_anima.safetensors` | `ComfyUI/models/loras/` | 官方训练 v21 LoRA (~92 MB 各自) |
| **终末地角色合集** | `endfield_all_v3-000012.safetensors` | `ComfyUI/models/loras/` | wwyhahaha 制作合集 (~184 MB)，支持管理员、莱万汀、洛茜等 |

---

### Krea 2 与视频模型（按需配置）

- **Krea 2 Turbo**（约 18.23 GB 三件套）：
  - `diffusion_models/krea2_turbo_fp8_scaled.safetensors` (13.14 GB)
  - `text_encoders/qwen3-vl-4b-heretic_fp8_e4m3fn.safetensors` (4.83 GB)
  - `vae/qwen_image_vae.safetensors` (0.254 GB，与 Anima 共用)
- **Wan 2.2 TI2V 5B 文生视频**（约 18.14 GB 三件套）：
  - `diffusion_models/wan2.2_ti2v_5B_fp16.safetensors`
  - `text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors`
  - `vae/wan2.2_vae.safetensors`
- **MiniMax H3 联合音视频**：六文件全套约 43.99 GB，可通过 `npm run wf -- models:download-h3 --models-root "D:\HuiyuAI\ComfyUI\models"` 校验下载。

---

### 翻译与角色语音

- **M2M100 418M 翻译模型**：CPU 推理，约 1.94 GB。放置于 `Voice/models/translation/m2m100_418m`。
- **角色配音**：支持 **GPT-SoVITS**（角色双权重 `.ckpt` / `.pth` + 参考音频）与 **VoxCPM2**（基座 + 角色 LoRA）。

---

## 5. 模型环境体检

在维护终端执行体检命令核对模型与依赖完整性：

```powershell
# 检查模型文件与路径状态
npm run wf -- models:check --json

# 逐字节核对已知模型哈希（会产生磁盘读取）
npm run wf -- models:check --json --verify-hashes
```

---

## 6. 房间 API 连接

在角色房间打开「对话设置」$\to$「配置 API」，可接入外部云端模型或本机兼容服务：

### 常见服务商预设
| 服务商 | 默认 Base URL | 推荐模型 | 说明 |
|---|---|---|---|
| **DeepSeek** | `https://api.deepseek.com` | `deepseek-flash`, `deepseek-v4-pro` | 性价比高，角色聊天请关闭深度思考 |
| **OpenAI** | `https://api.openai.com/v1` | `gpt-6-luna` | 支持原生工具调用 |
| **Google Gemini** | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-3.8-flash` | 未开通计费项目可享受免费额度 |
| **OpenRouter** | `https://openrouter.ai/api/v1` | `openrouter/free` | 新配置默认筛选可用免充值模型 |
| **Groq** | `https://api.groq.com/openai/v1` | `openai/gpt-oss-20b` | 极速推理，Free 账户免充值额度 |
| **通义千问 / 百炼** | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3.8-flash`, `qwen3.7-plus` | 阿里云官方兼容端点 |
| **Kimi** | `https://api.moonshot.cn/v1` | `kimi-k2.6` | 官方 OpenAI 兼容接口 |

### 本机连接选项
- **绘遇受管 llama.cpp**：在控制室直接一键准备，免手动配置端口或密钥。
- **已有 Ollama**：服务默认运行在 `http://127.0.0.1:11434/v1`，无需填 Key。
- **已有 LM Studio**：在 Developer 页面启动服务，默认 `http://127.0.0.1:1234/v1`。

> [!NOTE]
> - 协议统一采用标准 OpenAI-compatible **Chat Completions + SSE** 流式传输。
> - 桌面端密钥保存在系统 Windows 凭据管理器中，安全隔离，不会明文泄露或写入配置文件。
