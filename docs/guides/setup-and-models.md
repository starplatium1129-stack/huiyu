# 换机离线体验与本地模型配置

新机器先安装桌面程序和完整素材包，随后按需要准备本地 AI 服务。**素材包提供角色、场景样张和浏览所需图片；生图、视频、对话、反推和 AI 配音需要各自的模型及运行环境。** 文件存在或下载校验通过，不能代替真实功能验收。

> 2026-09-30 核对：以下文件名以产品 Rust 工作流为准；公共来源读取了发布者页面和文件元数据，未下载大权重、安装环境或调用模型。当前私有角色 LoRA、声线、参考库不随公共素材包发行。素材安装步骤见 [离线资源发布与换机](offline-resources.md)，启动入口见 [STARTUP](../../STARTUP.md)。

## 1. 一台新机器需要哪些交付物

| 使用范围 | 需要准备 | 断网后验证 |
| --- | --- | --- |
| 完整素材浏览 | 匹配版本的桌面安装包、完整资源 ZIP、发布处的 SHA-256、离线导入脚本；桌面运行前提按离线安装指南准备 | 首次打开角色、场景、热门蓝图、画师、LoRA 样张及原图；检查 Live2D 和深浅主题 |
| PixAI 图片反推 | 固定 PixAI v1.0 权重与配置、CUDA 可用的 Python/PyTorch 环境及独立 timm；按 [准备入口](../workflow.md#pixai-本机反推准备) 生成 runtime-config.json | `/api/interrogate/status` 的 pixai 就绪后对本机图片反推；加载后模型按用户设置常驻显存 |
| Anima 生图 | ComfyUI、匹配的 Python/PyTorch 环境、底模＋文本编码器＋VAE；工作流需要的节点/采样器 | 控制室检查服务，`/api/anima/status`，再生成一张所选模型的图 |
| Krea 2 生图 | ComfyUI、下述 Krea 2 三件套；选择风格时另需相应 LoRA | `/api/creative/status`，再生成一张图 |
| WAI 生图 | WebUI/ReForge 的可用环境与 `--api`，或受支持的 ComfyUI 路径；WAI v17 checkpoint，所选角色 LoRA | 控制室连接和一张真实图；双人增强另需扩展与姿势模型 |
| 本地视频 | ComfyUI、Wan 或 H3 的完整权重与节点、可用 FFmpeg | `/api/video/status`，生成并播放短片，H3 另验音频 |
| 本地对话 | Ollama 程序及已经下载的**本地**模型缓存 | `ollama list`，在房间切换本地模型并完成一次断网对话 |
| 中日翻译＋角色 AI 配音 | 下述 M2M100 模型与 Python 依赖；GPT-SoVITS 环境、基础预训练组件、已授权的角色 GPT/SoVITS 权重、参考音频及对应原文 | `/api/tts/status`，分别验翻译、日文/中文配音和口型 |

远程 API、Ollama 云端模型、公网分享、在线下载和更新需要联网；选择这些能力不属于离线验收。默认图片和台词预览不证明 AI 生成可用。浏览器/系统语音也需本机已安装的对应语言声音。

**完全断网的新机**应在一台联网准备机上提前下载程序、驱动、模型和依赖，再经移动硬盘复制。除权重外还要保留 ComfyUI/WebUI/GPT-SoVITS 的版本、custom_nodes/扩展、Python/PyTorch 版本及离线安装材料；裸 `models/` 文件夹无法恢复运行环境。普通 Python venv 可能包含旧机器绝对路径，换路径后应由该上游的离线安装材料重建。授权不明确的私有资源单独保留，不混进公共 ZIP。

### Windows 原生前置：VC++ x64 离线安装材料

当前 ONNX Runtime DLL 需要 `MSVCP140*` 与 `VCRUNTIME140*`。WebView2 离线材料和这些 VC++ 运行库是不同的前置；能够浏览素材不代表 WD14 已可推理。在联网准备机用以下入口准备微软原始安装器：

```powershell
# 默认只打印计划；不会下载、安装或写目录
./scripts/maintenance/prepare-offline-prerequisites.ps1 -Out 'D:\HuiyuRelease\prerequisites'
# 显式下载到一个新目录；不会运行下载的 EXE
./scripts/maintenance/prepare-offline-prerequisites.ps1 -Out 'D:\HuiyuRelease\prerequisites' -Apply
```

该入口只使用微软官方 `aka.ms/vc14/vc_redist.x64.exe`，验证有效的微软 Authenticode 签名，记录实际字节、SHA-256、文件版本和来源；全部完成才发布输出目录。签名证明这份微软材料的来源，不授予素材包或其他程序安装授权。准备机不执行安装，公开分发前仍需按微软条款核对分发资格。[微软下载与版本要求](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist)

把 `vc_redist.x64.exe`、对应 `.sha256` 和 `prerequisites.json` 与绘遇发行附件一起带到新机，校验值从受信发行说明取得。**新机用户先手动运行微软 x64 安装器，处理许可、UAC 与可能的重启，再安装绘遇、完全退出、导入素材包并重启。** 不从旧机复制系统 DLL。完成模型配置后另做一次断网 WD14 反推，不能以安装器退出或图片包导入成功替代推理验收。

## 2. 目录与运行时的对应关系

建议在可写数据盘统一放置 AI 工作区，并在启动桌面程序/网关的环境中配置：

```powershell
$env:AI_WORKSPACE_ROOT = 'D:\HuiyuAI'
$env:AICS_WD14_MODEL_DIR = 'D:\HuiyuAI\Interrogate'
$env:AICS_TRANSLATION_MODEL = 'D:\HuiyuAI\Voice\models\translation\m2m100_418m'
$env:TRANSLATION_PYTHON = 'D:\HuiyuAI\GPT-SoVITS-env\python.exe'
```

桌面端还要在「AI 工作区」设置中用「选择文件夹」选择 `D:\HuiyuAI`（或手动输入路径）；保存后完全退出并重启绘遇生效，不会自动移动文件或中断当前生成。已保存目录与本次运行目录可能不同，不能只改变终端的扫描变量。WD14/翻译的独立环境变量需由启动绘遇的进程继承。普通新机可以提前复制下述文件，不需要安装 Node 运行下载脚本。

```text
D:\HuiyuAI\
├─ ComfyUI\                    # 可运行环境、custom_nodes、input、output
│  └─ models\
│     ├─ diffusion_models\     # Anima / Krea 2 / Wan / H3 的所选底模
│     ├─ text_encoders\        # 各模型专用编码器
│     ├─ vae\                  # 图像、视频、音频 VAE
│     ├─ checkpoints\          # WAI（使用 ComfyUI 路径时）
│     ├─ loras\                # 所选角色/风格/视频加速 LoRA
│     └─ upscale_models\       # 可选超分权重
├─ Interrogate\
│  ├─ wd-v1-4-moat-tagger-v2.onnx
│  └─ wd-v1-4-moat-tagger-v2.csv
├─ GPT-SoVITS-env\             # 翻译和语音的已准备 Python 环境
└─ Voice\                     # GPT-SoVITS、声线、参考音频、翻译模型
```

Rust 网关检查图像/视频权重的固定根是 `AI_WORKSPACE_ROOT/ComfyUI/models`，源码服务缺省为应用同级 `AI/ComfyUI/models`，桌面使用选定的 AI 工作区。WD14 若未指定独立目录，还扫描 AI 工作区的 Tagger 目录与 `appRoot/runtime/models/interrogate`，不会自动从 `AICS_RUNTIME_ROOT/models/interrogate` 读取。独立 ComfyUI 若放在其他目录，可通过受控目录链接/上游模型配置使双方引用同一批真实文件；仅修改 `COMFY_HOST` 不会改变本机权重检查目录。`COMFYUI_MODELS_ROOT` **只改变体检扫描**，体检会报告它是否与网关目录一致。

上游只支持本机 loopback：`SD_HOST` 默认 `http://127.0.0.1:7860`，`COMFY_HOST` 默认 `http://127.0.0.1:8188`，`TTS_HOST` 默认 `http://127.0.0.1:9880`。地址/角色声线可在控制室保存；更换机器后重配参考音频和权重的绝对路径，不复制旧 PID 当作新服务已启动。

## 3. 公共模型下载清单

容量按 2026-09-30 发布者文件元数据计算，GB 为十进制，GiB/MiB 为二进制。下面列的是**当前绘遇工作流支持的指定版本**，发布页的最新版本不自动成为兼容版本。下载后按清单放置，不以改名替代不同架构/量化。

### PixAI 默认图片反推

默认模型为 PixAI Tagger v1.0，权重约 1.95 GB，支持最多 20 MiB 图片。运行环境要求 Python 3.11 或更新版本；准备入口在下载或安装依赖前检查解释器版本，并将实际版本写入回执。执行 [PixAI 本机准备](../workflow.md#pixai-本机反推准备) 后，Rust 从选定 AI 工作区的 `PixAI/runtime-config.json` 或网关运行目录的 `pixai/runtime-config.json` 读取本机配置；`AICS_PIXAI_CONFIG` 可显式指定其他回执。准备入口复用已有 CUDA Torch 环境，仅在独立目录补齐 timm，不修改 ComfyUI。

首次反推需要加载模型，后续请求复用同一个 GPU 进程；不会在每张图结束或开始生图时自动卸载。取消活跃请求、进程故障或网关关闭会回收对应进程。显存不足明确报错，不自动变更模型或回退为演示标签。安装包只带 worker 和固定文件清单，Python 环境与权重仍需另行准备。

### WD14 可选旧工具

[SmilingWolf 发布页](https://huggingface.co/SmilingWolf/wd-v1-4-moat-tagger-v2)提供 `model.onnx`（326,197,340 字节）和 `selected_tags.csv`（253,906 字节）。下载后分别命名为 `wd-v1-4-moat-tagger-v2.onnx`、`wd-v1-4-moat-tagger-v2.csv`；二者必须来自同一版本。支持 CPU，不承诺固定耗时。

源码维护环境中执行：

```powershell
# 先看精确 URL、revision、字节与哈希，零下载、零写入
node scripts/maintenance/download-wd14.js --target-dir 'D:\HuiyuAI\Interrogate' --plan
# 实际下载；默认固定的发布者 Hugging Face 源
npm run wf -- models:download-wd14 --target-dir 'D:\HuiyuAI\Interrogate'
```

显式 `--modelscope` 使用第三方 ModelScope 副本，`--mirror` 使用 HF-Mirror；速度和可达性依网络决定，各来源均须匹配固定 SHA-256。桌面安装目录通常不可写，优先使用上面的外部目录，并让应用继承同一个 `AICS_WD14_MODEL_DIR`。安装器本身不自动下载 WD14。

### Anima：新机先选能无角色 LoRA 使用的底模

[CircleStone Labs 发布页](https://huggingface.co/circlestone-labs/Anima)列出以下三类目录。公共起步组合可选择 **Anima Aesthetic v1.1**，三件套共约 **5.63 GB**；在绘遇中明确选此模型并使用无角色 LoRA 的创作路径。程序默认的 MiaoMiao v1.6 仍需单独取得对应文件。

| 放置路径（相对 `ComfyUI/models/`） | 来源 |
| --- | --- |
| `diffusion_models/anima-aesthetic-v1.1.safetensors` | [固定版下载](https://huggingface.co/circlestone-labs/Anima/resolve/f973fc41ec7545364ac9776c2440285f43ff2a30/split_files/diffusion_models/anima-aesthetic-v1.1.safetensors)，4.18 GB |
| `text_encoders/qwen_3_06b_base.safetensors` | [固定版下载](https://huggingface.co/circlestone-labs/Anima/resolve/f973fc41ec7545364ac9776c2440285f43ff2a30/split_files/text_encoders/qwen_3_06b_base.safetensors)，1.19 GB |
| `vae/qwen_image_vae.safetensors` | [固定版下载](https://huggingface.co/circlestone-labs/Anima/resolve/f973fc41ec7545364ac9776c2440285f43ff2a30/split_files/vae/qwen_image_vae.safetensors)，0.254 GB |

其他已接入 Anima 底模共用此编码器/VAE：

| 模型 | 要求的文件名 | 发布者版本入口 |
| --- | --- | --- |
| MiaoMiao v1.2 | `miaomiaoHarem_anima12.safetensors` | [MIAOKA：Anima_1.2](https://civitai.com/models/934764?modelVersionId=3020110) |
| MiaoMiao v1.6（当前默认） | `miaomiaoHarem_anima16.safetensors` | [MIAOKA：Anima_1.6](https://civitai.com/models/934764?modelVersionId=3248362) |
| Anima Yume v1.0 | `AnimaYume_v10_final_base.safetensors` | [v1.0 base final](https://civitai.com/models/2385278?modelVersionId=3065644)；上游名 `animayume_v10BaseFinal.safetensors`，仅这一指定文件按体检哈希核对后改成本机目录名 |
| Anima 2.9B Preview v1 | `Anima-2.9B-preview-v1.safetensors` | [Gazingstars123 发布页](https://huggingface.co/Gazingstars123/Anima-2.9B)，5.84 GB；旧 ComfyUI 可能需作者扩展，须检查实际支持 |
| Anima Base v1.0 | `anima-base-v1.0.safetensors` | [固定版下载](https://huggingface.co/circlestone-labs/Anima/resolve/f973fc41ec7545364ac9776c2440285f43ff2a30/split_files/diffusion_models/anima-base-v1.0.safetensors)，4.18 GB；当前绘遇未声明无 LoRA 路径 |

MiaoMiao 发布附件中的 `*_txt.safetensors` 与此 Qwen 0.6B 文件 SHA-256 相同，本次核对可复用上述编码器。Civitai 下载可能需要登录；联机准备时记录版本、文件名和哈希。Anima 使用发布者的非商业模型许可，素材包中的生成图片与模型权重分开发行；是否可以分发权重以该模型当前许可及你的授权为准。

### Krea 2：当前使用特定第三方编码器

| 放置路径 | 来源 / 约容量 |
| --- | --- |
| `diffusion_models/krea2_turbo_fp8_scaled.safetensors` | [Comfy-Org Krea 2](https://huggingface.co/Comfy-Org/Krea-2)，13.14 GB |
| `text_encoders/qwen3-vl-4b-heretic_fp8_e4m3fn.safetensors` | [DreamFast 发布页](https://huggingface.co/DreamFast/Qwen3-VL-4b-Heretic-ComfyUI)，4.83 GB |
| `vae/qwen_image_vae.safetensors` | 与上面的 Anima 共用，0.254 GB |

三件套约 **18.23 GB**。DreamFast 是社区编码器发布者；它不是 Comfy-Org 原工作流中的 stock `qwen3vl_4b_fp8_scaled.safetensors`，不能下载 stock 文件后改名冒充。发布者标注该 FP8 变体适用于 Ada 及更新硬件，较旧 GPU 的兼容和回退必须实测。九种可选风格文件位于 [Comfy-Org 的 loras 目录](https://huggingface.co/Comfy-Org/Krea-2/tree/eb1eddd3983a54678545a9b2c178c5853b30f7be/loras)，每种约 469 MB，总计约 4.22 GB；不选风格时无需这些 LoRA。

### WAI、角色 LoRA 和超分

[WAI-illustrious-SDXL v17.0](https://civitai.com/models/827184?modelVersionId=2883731) 的 `waiIllustriousSDXL_v170.safetensors` 约 **6.94 GB**。ComfyUI 放 `models/checkpoints/`；WebUI 放其真正使用的 Stable-diffusion 模型目录。宁宁/夏目的 WAI 路径还需要 `ayachi_nene_v18_wd14.safetensors` / `shiki_natsume_v18_wd14.safetensors`；Anima 角色路径需要 v21 对应文件。**这些自训角色权重没有公共下载入口，缺文件的机器不能宣称这些角色专属生成可用。** 未选择角色 LoRA 的公共 Anima 创作与素材浏览仍可单独验收。

超分、CLIPSeg 自动遮罩、ControlNet/ADetailer/Regional Prompter 属于按需扩展，需要对应权重、代码和预处理组件。对支持的基础生图先验一张；选择这些操作后再核对完整依赖，不把可选功能列为普通素材浏览的前置条件。

### Wan 2.2 TI2V 5B

[ComfyUI 官方教程](https://docs.comfy.org/tutorials/video/wan/wan2_2)与 [Comfy-Org 权重目录](https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged)提供三件套，约 **18.14 GB**：

```text
diffusion_models/wan2.2_ti2v_5B_fp16.safetensors
text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors
vae/wan2.2_vae.safetensors
```

上游支持图生视频，但绘遇当前 Wan 5B 适配仅声明文生视频。Wan 14B、HunyuanVideo 1.5、LTX-2.3 在当前目录中为未完成适配，下载它们不会启用绘遇对应功能。

### MiniMax H3：六文件与运行环境一起准备

[Comfy-Org 发布页](https://huggingface.co/Comfy-Org/MiniMax-H3)提供本机工作流的全部六文件，约 **46.38 GB / 43.20 GiB**。保留额外空间给 Python 环境、临时下载和输出；机器有 16 GB 显存并不保证该组合能够运行。

```text
diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors
text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
vae/minimax_h3_video_vae_fp16.safetensors
vae/minimax_h3_audio_vae_fp32.safetensors
loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors
loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors
```

```powershell
node scripts/maintenance/download-minimax-h3.js --models-root 'D:\HuiyuAI\ComfyUI\models' --plan
npm run wf -- models:download-h3 --models-root 'D:\HuiyuAI\ComfyUI\models'
```

两种 Turbo LoRA 都是当前目录必需文件；T8 双时钟路径使用 4-step，其他路径使用 8-step。参考图、原生音频还需 `MiniMaxH3DualClockSamplerT8`、`MiniMaxH3AudioConditioningT8`、`MiniMaxH3AVDecodeT8` 的已验证本机实现，单有权重不能启用。发布者明确说明 `int8_convrot` 需要 PyTorch cu130；不能用安装了其他 CUDA build 的环境直接承诺运行。NVFP4 编码器不要求必须是 Blackwell GPU，但实际峰值内存/显存、视频长宽和时长仍逐设备测试。

两个下载脚本都用临时文件，完成字节/SHA-256 核对后才替换最终权重；中断不会让半文件被标记为成功。已验证文件复用，中断的那个文件从头重下；Ctrl+C 可取消。同目录的下载锁防止重复启动，强制终止留下锁时，先确认原进程已结束再清理该锁。镜像源不改变哈希要求。精确清单存于 `scripts/lib/model-download-manifest.ts`。

## 4. 翻译、语音和本地对话

翻译使用 [Meta M2M100 418M](https://huggingface.co/facebook/m2m100_418M)，CPU 推理，权重约 **1.94 GB**。完整目录保留 `config.json`、`generation_config.json`、`pytorch_model.bin`、`vocab.json`、`sentencepiece.bpe.model`、`tokenizer_config.json` 和模型说明。预先在指定 Python 环境准备 `torch`、`transformers`、`sentencepiece`，下载时另需 `huggingface_hub`；`pytorch_model.bin` 加载需与当前 Transformers 安全要求兼容的 PyTorch，不能通过降级绕过加载检查。

```powershell
# -Plan 只展示路径与固定版本；去掉后才联机下载
./tools/install-translation-model.ps1 -PythonPath 'D:\HuiyuAI\GPT-SoVITS-env\python.exe' -ModelPath 'D:\HuiyuAI\Voice\models\translation\m2m100_418m' -Plan
```

安装脚本遵守前面的环境变量、只拉取固定 revision 的推理文件，并校验两项大二进制文件。运行翻译时使用 `local_files_only=True`，不会靠 Hugging Face 缓存缺项临时联网补齐。导入后在目标机器逐项做翻译及配音，下载成功不表示 Python 包或实际效果通过。

[GPT-SoVITS 官方安装说明](https://github.com/RVC-Boss/GPT-SoVITS)中除角色权重外，还有模型版本对应的预训练/语言组件。恢复完整版本环境、启动 `api_v2.py`，在控制室为每个角色设置 GPT 权重、SoVITS 权重、参考音频与音频实际原文；只复制一对角色 `.ckpt/.pth` 不足以实现离线声音生成。

Ollama 安装后，在联网准备阶段先取得选定**本地**模型。迁移时同时复制模型目录中的 `blobs` 与 `manifests`，可用 `OLLAMA_MODELS` 指向新目录；Windows 默认在当前账户 `.ollama/models`。在 Ollama 进程环境中设置 `OLLAMA_NO_CLOUD=1` 并重启，避免把云端选项误算本地能力。模型名称、量化、上下文及 `ollama list` 结果一起记录，断网后使用同一个名称。[Ollama 官方 FAQ](https://docs.ollama.com/faq)

## 5. 体检、硬件与新机验收

源码维护环境可执行（桌面普通用户用控制室及离线安装指南）：

```powershell
npm run wf -- models:check --json
# 显式逐字节校验已知权重；大文件会产生磁盘读取
npm run wf -- models:check --json --verify-hashes
```

体检覆盖 Rust 图像/视频目录要求、WD14 与原生 DLL、WAI、角色/风格 LoRA、翻译文件/解释器、声线配置、Ollama 缓存线索。`missing` 是缺失/空文件；`file-present` 只证明有非空文件；`bytes-match` 只证明长度符合已知元数据；`sha256-match` 才证明已知权重字节一致。上游节点、Python 包、模型推理和设备性能均显示未验，不由扫描自动认证。

硬件采购和资源安排应按目标能力分别估算：浏览不需要绘图 GPU；CPU 可承担 WD14/翻译但耗时须测；Anima/Krea/Wan/H3 的量化、分辨率、offloading 与显卡架构共同影响显存和内存。多 AI 服务共享资源，首次验收逐服务单独运行，从受支持的短任务开始，不承诺“大显存就能所有模型同时运行”。

每台新机的交付记录应包含：程序/素材版本与 SHA-256、实际模型文件清单和上游/依赖版本、GPU/内存、配置目录、**断网首次冷启动**及所选能力的一次真实产物。未授权私有资产或未执行能力标为未配置/未验；素材浏览完成与 AI 推理完成分开记录。
