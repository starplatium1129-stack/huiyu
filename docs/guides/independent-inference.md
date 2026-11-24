# 独立图像与视频推理接入指南

本项目原生推理基于独立 Python 运行库与官方 Diffusers 架构，不依赖 ComfyUI 节点即可完成文生图、图生图、局部重绘、视频生成及漫画后处理。

> [!NOTE]
> - 通过 Cloudflare / Tailscale 连接外部 AI 助手（Muse）出图与 QQ 收发，见 [远程连接与 Muse 指南](remote-and-muse.md)。
> - 本文档记录接入方式、命令入口与参数约束；实际出图画质与性能以本机设备实测为准。

---

## 1. 快速准备与多机原生互通

### 本机一键准备（推荐）

从欢迎页「配置绘图」或「控制室 → 绘图与模型」进入：
1. 核对存放位置与磁盘空间，首次出图可选推荐的 **MiaoMiao Harem Anima 1.6**。
2. 确认许可后点击 **下载并自动配置**；若提示「重启并继续」，重启后回到配置页完成收尾。
3. **下载与校验机制**：最多 4 路并发下载，公开大文件会通过 ≤ 128 KiB 前缀测速优选官方源或 `tools/inference/managed-model-mirrors.json` 中的 ModelScope 固定源（凭据请求与 MIAOKA 主权重除外）。中断支持断点续传，所有文件均须通过完整大小与 SHA-256 校验后发布。

### 在另一台绘遇上使用原生绘图

适用于「一台高配显卡出图机 + 一台轻薄笔记本使用端」，通过 Tailscale 私网互联（端口默认 `3211`，HTTP 传输，**切勿暴露公网**）：

1. **出图机设置**：先在本机准备好原生模型与运行库，在「控制室 → 绘图与模型 → 原生绘图 → 绘图引擎与远程连接」选择 **本机原生引擎**，开启「允许连接」、生成密钥并保存重启。使用 Tailscale 转发端口：
   ```powershell
   tailscale serve --bg --tcp=3211 tcp://127.0.0.1:3211
   # 撤销转发：tailscale serve --tcp=3211 off
   ```
2. **使用端连接**：选择 **连接另一台绘遇**，粘贴出图机的远程地址与密钥，保存后「重启并检查远端」，随后即可从远端就绪模型中选型作画。
3. **协同与缓存行为**：
   - 远端出图机须保持运行；参考图按内容摘要去重上传，原图下载断线自动续传并校验 `ETag` 与 `SHA-256`。
   - 远端任务沿用本机显存交接（可能停止出图机上的语音、聊天或受管 ComfyUI）；支持 Anima、Krea 2、Qwen、MOSS 图像任务，连接中断查询原任务而不重复提交。漫画处理与视频仍使用本地设置。

---

## 2. 显卡环境与离线准备

### 显卡与 PyTorch 后端（Anima）

| 设备类型 | 后端 | 配置方式 |
| --- | --- | --- |
| **NVIDIA 独显**（Ampere–Blackwell，建议 ≥ 12 GB 显存，驱动 ≥ 572.61，32 GiB 内存） | CUDA | 控制室一键准备，或使用兼容独立 Python |
| **AMD 独显 / Ryzen 核显**（如 Radeon 880M） | ROCm / HIP | 在控制室选「原生计算」+「自动」显存策略，安装对应 ROCm Torch 后指定解释器 |
| **Intel Arc GPU** | XPU | 同上，安装 Intel XPU PyTorch 后指定解释器 |

- **PyTorch 兼容版本**：`torch 2.8.0 / torchvision 0.23.0` 或 `torch 2.9.1 / torchvision 0.24.1`。
- **补齐独立依赖（保留既有 GPU Torch）**：
  ```powershell
  $animaPython = 'D:\HuiyuAI\inference\rocm\Scripts\python.exe'
  $animaPackages = Get-Content tools/inference/requirements.txt | Where-Object { $_ -match '^[a-zA-Z]' -and $_ -notmatch '^torch(vision)?==' }
  & $animaPython -m pip install @animaPackages
  & $animaPython -I -B tools/inference/worker.py --diagnose
  ```
- **多显卡指定**：启动网关前可设置 `HUIYU_ANIMA_DEVICE=cuda:1` 或 `xpu:1`（ROCm 沿用 `cuda:N`）。Radeon 880M 在 ROCm 7 BF16 下会自动启用 Q/K 融合优化。

### 离线运行库与完整目录导入

在控制室展开 **已有资源与高级设置**，或使用维护命令行导入本地资源：

```powershell
# 从本地 wheelhouse 准备独立运行库（先 --preflight 预览，再 --apply 执行）
npm run wf -- models:prepare-inference --target-dir "D:\HuiyuAI\inference" --preflight --wheelhouse "D:\wheels"
npm run wf -- models:prepare-inference --target-dir "D:\HuiyuAI\inference" --apply --wheelhouse "D:\wheels"

# 导入已有的完整 Anima Diffusers 目录
npm run wf -- models:import-anima-directory --source-dir "D:\models\source-anima" --target-dir "D:\HuiyuAI\inference\models\anima-base-v1.0" --apply
```

---

## 3. 架构核验与单文件离线转换

<a id="经架构核验的离线转换"></a>
### 检查与转换单文件 Checkpoint

仅在 CPU 执行架构、键名与形状校验后转换（不加载张量至 GPU）：

```powershell
# 检查 Checkpoint 结构
python scripts/maintenance/inspect-anima-checkpoint.py --checkpoint "D:\models\miaomiaoHarem_anima16.safetensors"

# 严格转换为原生 Diffusers 目录（去掉 --apply 仅预览计划）
python -I scripts/maintenance/convert-anima-checkpoint.py `
  --profile anima-cosmos2b-v041 `
  --checkpoint "D:\models\miaomiaoHarem_anima16.safetensors" `
  --transformer-config "D:\models\config.json" `
  --text-encoder "D:\models\qwen_3_06b_base.safetensors" `
  --vae "D:\models\qwen_image_vae.safetensors" `
  --qwen-tokenizer "D:\models\qwen-tokenizer" `
  --t5-tokenizer "D:\models\t5-tokenizer" `
  --output-dir "D:\HuiyuAI\inference\models\anima-miaomiao-v1.6" `
  --apply
```

**支持的转换 Profile：**
- `anima-cosmos2b-v041`：28 层、2048 宽度（Anima Base 1.0、MiaoMiao 1.2 / 1.6、Aesthetic 1.1）
- `anima-cosmos29b-v041`：40 层、2048 宽度（MiaoMiao 2.9B Beta 1.1、RealSkin 2.9B）
- `anima-yume2b-rope-v041`：28 层 Yume 1.0（额外校验静态 RoPE 缓冲）

> [!TIP]
> 新增同架构模型维护入口：Anima 单文件配置见 [绘图目录](../../runtime-rs/src/images/catalog.json) 与 [下载来源](../../runtime-rs/src/control/setup-models.json)（`nativeConversionProfile` / `requiresLocalCheckpoint`）；Diffusers 变体配置见 [适配清单](../../tools/inference/adapter-models.json) 与 [受管下载清单](../../tools/inference/managed-adapter-models.json)。完整分流决策与接入流程见 [新模型原生接入工作流](engineering/model-onboarding-workflow.md)。

---

## 4. 原生图像与视频适配器模型

原生适配器（独立于 Anima Python，依赖清单见 `tools/inference/requirements-adapters.txt`）支持以下模型：

| `modelId` | 来源 | 接口路径 | 说明 |
| --- | --- | --- | --- |
| `krea2-raw` / `krea2-turbo` | `krea/Krea-2-*` | `/api/creative/jobs` | 文生图；Turbo 为 8 步蒸馏，连续换种复用提示词编码 |
| `qwen-image-2.1` / `qwen-image-2.1-turbo` | `Qwen/Qwen-Image-2.1*` | `/api/qwen/jobs` | 文生图与最多 4 图参考指令编辑（Turbo 为 8 步） |
| `moss-miaomiao-base-v1.0` / `v1.1` | MIAOKA / OpenMOSS | `/api/moss/jobs` | MiaoMiao MOSS 文生图（详见第 8 节） |
| `wan2.2-ti2v-5b` | `Wan-AI/Wan2.2-TI2V-5B-Diffusers` | `/api/video/jobs` | 文字/首帧，3/5 秒，24 fps |
| `wan2.2-14b` | `Wan-AI/Wan2.2-T2V-A14B-Diffusers` | `/api/video/jobs` | 文字生视频，双噪声阶段，3/5 秒，16 fps |
| `hunyuan-video-1.5` | `HunyuanVideo-1.5-Diffusers-480p_t2v` | `/api/video/jobs` | 文字生视频，480p，3/5 秒，24 fps |
| `minimax-h3` | `MiniMaxAI/MiniMax-H3` | `/api/video/jobs` | 文字/首帧/首尾帧，带音轨，5/10 秒（支持 BF16 与 4/8 步量化 Turbo） |
| `ltx-2.3` / `ltx-2.5-distilled` | `LTX-2.*-Diffusers` | `/api/video/jobs` | 文字/首帧，带音轨，3/5 秒（2.5 用 Gemma 4 编码 + 8 步；需在 HF 接受许可） |
| `kandinsky-6-lite-distill` | `Kandinsky-6.0-Lite-distill-5s` | `/api/video/jobs` | 文字/首帧，10 步生成 5 秒带 44.1 kHz 单声道音轨视频 |
| `wan-animate-2` | `Wan2.2-Animate-2-14B-Distilled` | `/api/video/jobs` | 角色图 + H.264 MP4 动作参考，10 步，3/5 秒无声 |
| `longcat-avatar-1.6` | `LongCat-Video-Avatar-1.6` | `/api/video/jobs` | 角色图 + PCM WAV 配音，8 步，25 fps，3/5 秒对白 |

已用本地 FP8 权重转好 Krea 2 Turbo 的 Windows 机器，可以复用原始文件加快显卡传输。使用下列命令核对原文件与已有 BF16 分片，并在模型目录建立同卷硬链接。随后原生引擎在显卡上逐块还原 BF16，再沿用原有采样和风格 LoRA。实际使用时，任务记录会显示 `kreaExecution.weightTransport=fp8-to-bf16`。 [Krea 2 Turbo 原始权重与校验值](https://huggingface.co/Comfy-Org/Krea-2/blob/eb1eddd3983a54678545a9b2c178c5853b30f7be/diffusion_models/krea2_turbo_fp8_scaled.safetensors)

```powershell
python -I -B tools/inference/krea_transport.py --apply `
  --model-dir "D:\HuiyuAI\inference\models\krea2-turbo" `
  --source "D:\HuiyuAI\ComfyUI\models\diffusion_models\krea2_turbo_fp8_scaled.safetensors"
```

### 原生视频准备与加速

- **切换引擎**：在「故事短片 → 视频引擎设置」选 **本机原生引擎** 并准备模型；可复用本地指定 ComfyUI Wan 5B / H3 量化权重。
- **手动依赖安装**（`torch 2.9.0/0.24.0` 或 `2.9.1/0.24.1`，本地需配 `ffmpeg` H.264/AAC）：
  ```powershell
  $videoPython = 'D:\HuiyuAI\inference\video\Scripts\python.exe'
  $videoPackages = Get-Content tools/inference/requirements-adapters.txt | Where-Object { $_ -match '^[a-zA-Z]' -and $_ -notmatch '^torch(vision)?==' }
  & $videoPython -m pip install @videoPackages
  & $videoPython -I -B tools/inference/adapter_worker.py --diagnose --model-id wan2.2-ti2v-5b
  ```
- **注意力与硬件编码**：自动按 FlashAttention 2 → SageAttention → PyTorch SDPA 降级；MP4 导出优先 NVENC / AMF / QSV，回退 `libx264`。
- **动作/配音驱动接口**：通过 `POST /api/video/drivers/video` 或 `audio` 上传（上限 20 MiB，WAV 接受 8–192 kHz PCM），返回 `name` 传入 `drivingVideo`/`drivingAudio`。

#### LongCat 专用环境（约 63.1 GB 权重）

需支持 BF16 的 NVIDIA 显卡 + `PyTorch 2.6.0 (CUDA 12.4)`、`torchvision 0.21.0`、`Triton 3.2`、`FlashAttention 2.7.4.post1`，默认放置于模型根目录旁的 `environments/longcat-avatar`（可通过 `HUIYU_LONGCAT_PYTHON` 与 `HUIYU_LONGCAT_SOURCE` 指定路径）：

```powershell
$avatarEnv = 'D:\HuiyuAI\inference\environments\longcat-avatar'
$avatarPython = Join-Path $avatarEnv 'Scripts\python.exe'
$avatarSource = Join-Path $avatarEnv 'upstream\LongCat-Video'
& $avatarPython -m pip install -r tools/inference/requirements-longcat-avatar.txt
git clone https://github.com/meituan-longcat/LongCat-Video $avatarSource
git -C $avatarSource switch --detach 58eb336edc5c8c63389838727e40b8c18434e54e
& $avatarPython -I -B tools/inference/adapter_worker.py --diagnose --model-id longcat-avatar-1.6
```

---

## 5. MangaScreen 漫画后处理

漫画化默认使用原生 `qwen-image-2.1-manga-int8`。在控制室可准备该模型及 Manga Line Extraction 线稿权重。重绘沿用 QWEN-Manga 的 Turbo INT8 权重、Heretic 8B INT8 编码器、BF16 VAE、初始噪声和 8 步 Euler 配方，再叠加自动线稿与 250 线网点。重绘与后处理由原生 `/api/manga` 任务完成，不需要启动 ComfyUI。已有 BF16 配方可继续按原模型运行。

控制室自带的 CUDA 12.8 运行时使用 PyTorch 做 INT8 矩阵乘法和缩放点积注意力（SDPA）。要复用上游环境，在推理设置的“图像与视频适配器 Python”中选择对应的解释器。CUDA 13 配合 `comfy-kitchen==0.2.37` 会使用 ConvRot 内核，显卡支持时还会为权重标记的注意力层使用上游 INT8 内核。两种运行时使用相同权重和种子，内核的数值差异可能改变重绘细节。

- `lite`：色阶调整 + 网点平涂 + 原画框合成
- `comic`：线稿强化 + 网点平涂 + 画框裁切
- `lineart`：独立 `MangaLineExtraction` 黑线白底线稿提取（显存充足走 CUDA，否则回退 CPU）
- **连续微调复用**：调整明暗、网点或纸张时沿用最近重绘种子与缓存（重绘 RGB ≤ 6 MiB、线稿 ≤ 8 MiB），点击「换一版重绘」刷新种子。

---

## 6. 调度、高清精修与 TeaCache

- **采样与高清**：支持 `Euler` 与二阶指数积分 `RES (res_multistep)`；高清阶段支持 Latent 二次采样、固定 Remacri / UltraSharp 放大与 FP32 KJ RCAS 锐化。
- **TeaCache 默认策略**：默认内置 Apache-2.0 Anima 自适应策略（阈值 `0.10`，首尾步全算），无需为常规模型/LoRA 单独校准。
- **维护校准入口**：
  ```powershell
  python -I scripts/maintenance/calibrate-anima-teacache.py `
    --calibration-job train.json --validation-job heldout.json `
    --output-dir "D:\review" --threshold 0.05 --run
  ```
  人工审阅 `review.html` 后追加 `--accept-run` 写入模型目录。

---

## 7. 显存策略与进程生命周期

- **策略区分**：Anima 使用 `inference.memoryPolicy`（默认 `resident`常驻显存）；Krea、Qwen、MOSS、漫画重绘与视频使用 `inference.adapterMemoryPolicy`（默认 `offload` 按层/阶段动态卸载，Sage/编译加速仅作用于 Anima）。
- **前缀与编码缓存**：Qwen/MOSS 在 offload 模式下直接映射原权重文件并按预算分层驻留，条件/文本编码复用受限 CPU LRU 缓存（≤ 64 MiB）；采样前自动整理显存防止换页。
- **自动释放**：最后一次任务完成后空闲 **10 分钟** 自动卸载模型并释放显存；启动本地对话或语音时自动让出显存，退出桌面端即终止子进程。

---

## 8. MiaoMiao Harem MOSS BASE v1.0 / v1.1

新创作默认使用 `moss-miaomiao-base-v1.1`（保留 1.0 历史兼容）。完整组件约 **27.2 GB**，采用 `Euler`、50 步、CFG 3.5、768×1280（宽高为 16 倍数），Shift 固定 5，不使用 Anima LoRA 或 TeaCache。

### 模型准备与 INT8 量化导入

- **1.0 原生权重**：从 [Civitai 版本页](https://civitai.com/models/3015023?modelVersionId=3422319) 下载 `miaomiaoHaremMOSS_baseV10_fp16.safetensors` 后在控制室填入本地路径，程序自动校验并拉取 Qwen3.5-9B 编码器、tokenizer 与 FLUX.2 VAE。
- **导入 INT8 主模型**（v1.1 SHA-256 `234e8fa8106bf2ac7f83586feb97054cf6e11a23e7cb2c5adfc808031d27b50b`，v1.0 SHA-256 `8aa2d469b28ea72beb35730b3a00bf0bffbaca03f0419d6f05d390614fe689d9`，需要 `comfy-kitchen==0.2.37` / CUDA 13 算子；停止推理后运行，去掉 `--apply` 先预览）：
  ```powershell
  # 已有 1.0 目录时导入 1.1 INT8 并复用共享组件
  npm run wf -- models:import-moss-int8 --source <1.1_INT8路径> --model-dir <models根/moss-miaomiao-base-v1.1> --model-id moss-miaomiao-base-v1.1 --reuse-from <models根/moss-miaomiao-base-v1.0> --apply

  # 仅导入 INT8 文本编码器 (Qwen3.5-9B W8A8 ConvRot, SHA-256 96064ede0b4caa9b6dd60a9fa868707e7b8ff3ae5347c0bab6bc868b5932f317)
  npm run wf -- models:import-moss-int8 --component text_encoder --source <文本编码INT8路径> --model-dir <现有MOSS目录> --apply
  ```
- **精度与加速选项**：
  - 高级参数「主模型权重」支持 `auto | fp16 | int8`，「文本编码精度」支持 `auto | bf16 | fp8 | int8`（优先复用已安装的 `fla-core==0.6.0` / `flash-linear-attention==0.6.0` Triton 内核）。
  - **Spectrum 预测加速**：默认启用「Spectrum · 快速预测」（窗口增长 `0.5`，前 6 步与末 3 步全算）；可选「ER-SDE · 预览」（25 步、CFG 2.5、完整计算）或「Spectrum · 自适应预测」；可单独对已成图执行 Remacri `1.5× / 2×` 纯像素超分（原图每边 512–1536 px）。
  - **编译加速（`mossCompile`）**：默认关闭，仅编译 DiT 块（配合 `fail_on_recompile` 守卫，offload 模式下不启用）。
  - **布局提示词**：三联画或指定构图使用中心原点 `abs_centralized / yxyx` 或左上原点 `abs / xyxy` 坐标框，出现文字时编译器自动剔除负面默认 `text`/`english text`。

---

## 9. MiaoMiao RealSkin Anima 2.9B 1.0

- **模型 ID**：`anima-miaomiao-realskin-2.9b-v1.0`（需先从 [Civitai 发布页](https://civitai.com/models/2026594?modelVersionId=3415563) 登录下载 `miaomiaoRealskin_anima29B10.safetensors`，SHA-256 `1e0ad19711045540570dffd5ecc4a39aeeb5810ac2e4641c1d060d47167f4c46`）。
- **准备与转换**：在「控制室 → 原生引擎」填入文件绝对路径，按 `anima-cosmos29b-v041`（40 层）转换并与 Qwen3-0.6B / VAE 组装（原文件与转换目录合计约 14.6 GB）。
- **默认配方**：`Euler / SGM Uniform`，30 步，CFG `4.0`，画幅 `928×1536`（显式有色皮肤会自动移除默认 `fair skin`）。暂不保证与 28 层角色 LoRA 兼容。
