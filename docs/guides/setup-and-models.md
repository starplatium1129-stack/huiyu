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
| **故事短片** | 原生运行环境、Wan 2.2 A14B 首尾帧模型或 MuseTalk 1.5 对白模型，以及导出用的 FFmpeg 和 ffprobe | 在「分镜视频」生成镜头并播放，桌面工作区可导出 MP4 |
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

<a id="windows-原生前置vc-x64-离线安装材料"></a>
## 2. Windows 原生前置：VC++ x64 离线安装材料

> 首次模型准备仅在下载或导入时校验一次完整性，后续启动沿用完成记录而不整库复核；导入已有目录使用单次复制。

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

### 原生关键帧工坊

从「更多 → 创作工具 → 创作项目」进入。在控制室选择本机原生绘图，在已有推理 Python 环境中准备好 Pillow。工坊默认选用 FLUX.1 Kontext dev Q4_K_M，也可选择 MiniMax H3-Image Q4_K_M。

在 Windows 源码目录运行下面的命令，将示例路径替换为控制室显示的模型目录。已安装的桌面版可在资源目录 `gateway` 下使用同一相对路径。

```powershell
python -I -B tools/inference/prepare_keyframes.py --models-root "D:\HuiyuAI\inference\models"
```

默认准备两种模型，共约 39.6 GiB 权重，另含 CUDA 执行器。只准备 Kontext 时追加 `--model flux-kontext-dev`，只准备 H3-Image 时追加 `--model minimax-h3-image-q4`。下载中断后可重跑同一命令。编码器与 VAE 位于 `_shared`，执行器位于 `_runners/sd-cpp`。准备完成后点击工坊的「重新检测」。

导入角色、场景原图并依次点击「用作参考」。填写共同的编辑指令，可在变化栏按行追加不同的表情或镜头描述。选择目标镜头后点击候选下的「用作首帧」或「用作尾帧」。镜头绑定的是选中素材的具体版本，追加新版后可单独替换其中一帧。

### 用分镜生成原生 Wan 视频

在首页「故事短片」下点击「开始创作」，或在「创作项目」打开「分镜视频」。默认模板使用首尾两张图，也可以只用首帧。选好镜头、运镜、动态幅度、分辨率和时长即可提交。锁定种子会将该数值和本次使用的素材版本一起保存。旧版工作区也会将这个模板直接送入原生推理。

要准备 Wan 2.2 A14B 的两个 LightX2V 蒸馏专家（Q4_K_M）、UMT5 和 VAE，在源码或桌面资源的 `gateway` 目录运行下面的命令。高噪、低噪专家都已包含对应的蒸馏权重。

```powershell
python -I -B tools/inference/prepare_keyframes.py --models-root "D:\HuiyuAI\inference\models" --model wan2.2-i2v-a14b-gguf
```

16 GB 显卡可先选 480p、2 秒和快速档。两个专家合计采样 4 步，画质档用 8 步。每段视频都分块解码。两个尺寸档按画幅输出，横屏 16:9 的 480p 为 832×480。分镜首尾帧会按视频画幅居中裁切。

在桌面工作区选中多个镜头后，可以为缺帧指定同一组角色、场景参考图和各帧指令。整批先补齐缺帧，再切换到 Wan。暂停队列会让当前镜头跑完，取消会中止指定镜头。可离开项目页面，完成的片段会写回镜头历史和素材库。遇到内存不足，队列会保留种子、时长和采样步数，缩小解码分块，自动重试一次。720p 会降到短边 480 像素，镜头记录显示实际尺寸。

自定义模板使用本地运行目录 `workflows/studio-video/*.json`，每个文件放一个模板。下例保留首尾帧，新任务选「标准」时使用 8 步。每次提交保存模板版本、摘要、种子和输入版本。

```json
{
  "id": "dialogue-cutaway",
  "version": 1,
  "label": "静候反应镜头",
  "mode": "first-last",
  "modelId": "wan2.2-i2v-a14b-gguf",
  "steps": { "fast": 4, "standard": 8, "quality": 8 },
  "tiledVae": true,
  "defaultPrompt": "人物停顿片刻，视线缓缓转向画外。"
}
```

### 角色对白与整片导出

在「创作项目」导入角色图和 PCM WAV，在分镜中绑定首帧和配音，选择「角色对白」。一个镜头使用一段最长 15 秒的配音。MuseTalk 按语音生成嘴型和口周小动作，输出为 25 帧/秒。对于唇线与口腔颜色清楚的插画，绘遇会使用原画的线条颜色绘制嘴型。正面、单人且嘴部清晰的参考图更容易定位人脸。角色走动、转身或需要运镜的镜头可以继续选 Wan。

在源码或桌面资源的 `gateway` 目录按需准备模型。把路径换成控制室显示的原生模型目录。

```powershell
python -I -B tools/inference/prepare_keyframes.py --models-root "D:\HuiyuAI\inference\models" --model musetalk-1.5
python -I -B tools/inference/studio_export_assets.py --models-root "D:\HuiyuAI\inference\models"
```

第一条准备对白模型及共用的 Whisper 和 VAE，第二条准备 Real-ESRGAN AnimeVideo 和 RIFE 增强组件。普通拼接需要在桌面进程的环境中可以找到 `ffmpeg` 和 `ffprobe`。两项增强都在 CPU 上运行。超分将宽高各放大两倍，插帧将帧率加倍，按镜头分别处理以保留切镜点。缺少 RIFE 时，插帧采用 FFmpeg 的运动补偿。

修改某个镜头的首帧、配音或设置后，可以只返工这一镜。新片生成成功且镜头仍是提交时的版本时自动替换。历史里仍可选用旧片段。桌面导出会锁定所选各镜头的当前片段、顺序和配音版本，导出期间可继续编辑。视频参数相同且关闭增强时直接复制视频流，参数混合时按首镜的画幅和帧率对齐，保留原比例。选用分镜配音时会补齐静音或裁到镜头末尾。没有另配语音的镜头保留片内原声。

### 翻译与角色语音

- **M2M100 418M 翻译模型**：CPU 推理，约 1.94 GB。放置于 `Voice/models/translation/m2m100_418m`。
- **角色配音**：支持 **GPT-SoVITS**（角色双权重 `.ckpt` / `.pth` + 参考音频）与 **VoxCPM2**（基座 + 角色 LoRA）。

---

## 5. 模型环境体检

在维护终端执行体检命令核对模型与依赖完整性：

```powershell
# 检查模型文件与路径状态
npm run wf -- models:check-environment --json

# 逐字节核对已知模型哈希（会产生磁盘读取）
npm run wf -- models:check-environment --json --verify-hashes
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

使用 OpenAI 的房间工具或联网检索时，选表中的 `gpt-6-luna` 预设。绘遇房间目前通过 Chat Completions 发送请求，而 GPT‑6.2 Astra 的工具调用需要 Responses API。手动填写 `gpt-6.2-astra` 时，请关闭「房间工具」和「联网检索」。[OpenAI 官方接入说明](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6.2-astra#migration-quickstart)

### 本机连接选项
- **ChatGPT 订阅额度（Sign in with ChatGPT）**：在角色房间的聊天设置中选择「ChatGPT」，点击 **Continue with ChatGPT**，在系统浏览器完成授权。绘遇会列出该账号可用的模型，使用订阅额度处理聊天，并支持切换账号、房间工具与联网检索。额度到顶时会暂停发送，可打开「管理用量」，确认后点「恢复发送」。凭据由本机网关保存，Windows 上使用 DPAPI 加密。使用条款和预览限制见 [OpenAI 接入说明](https://developers.openai.com/siwc/token-sharing-open-source)。
- **绘遇受管 llama.cpp**：在控制室直接一键准备，免手动配置端口或密钥。
- **已有 Ollama**：服务默认运行在 `http://127.0.0.1:11434/v1`，无需填 Key。
- **已有 LM Studio**：在 Developer 页面启动服务，默认 `http://127.0.0.1:1234/v1`。

> [!NOTE]
> - 协议统一采用标准 OpenAI-compatible **Chat Completions + SSE** 流式传输。
> - 桌面端密钥保存在系统 Windows 凭据管理器中，安全隔离，不会明文泄露或写入配置文件。
