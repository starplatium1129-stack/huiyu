# 独立图像与视频推理接入指南

本项目原生推理基于独立 Python 运行库与官方 Diffusers 架构，不依赖 ComfyUI 节点即可完成文生图、图生图、局部重绘、适配器生图及漫画后处理。

---

## 1. 核心使用方式

### 快速一键准备（推荐）
在控制室打开 **“原生生图”**：
1. 选择 AI 工作区（如 `D:\HuiyuAI`）。
2. 核对硬件条件后点击 **“一键准备”**，系统将在后台自动下载并校验独立 Python 3.11 运行库与完整 Diffusers 模型（默认推荐 MiaoMiao Harem Anima 1.6）。
3. 安装完成后重启桌面端生效，即可在画室开始原生创作。

模型与运行库组件共用连接池，最多同时下载 4 个不同文件；公开大文件会用不超过 128 KiB 的前缀比较官方源与镜像，先用较快完成的来源。Qwen-Image 2.1 与 MOSS 的公开组件另有已逐项匹配大小和 SHA-256 的 ModelScope 固定版本来源，登记在 `tools/inference/managed-model-mirrors.json`；MIAOKA 作者主权重来源不变。带凭据的请求不参与镜像选择。下载中断保留可续传字节，每个文件仍须通过完整大小与 SHA-256 校验后发布；取消或任一文件失败会先停止并收妥同批在途下载。

### 在另一台绘遇上使用原生绘图

两台电脑需运行含此功能的绘遇版本。显卡所在电脑先准备本机原生模型与运行库，在「控制室 → 绘图与模型 → 原生绘图 → 绘图引擎与远程连接」选择本机原生引擎，开启允许连接、生成密钥并保存，重启后确认端口正在监听。本机端口默认 3211，只监听回环地址；使用 Tailscale 时运行 `tailscale serve --bg --tcp=3211 tcp://127.0.0.1:3211`，通过 tailnet 私网转发，不需要开放局域网防火墙端口。

使用端在同一位置选择远程绘遇原生引擎，填写 `http://远端Tailscale地址:3211` 和相同密钥，保存并重启。远端绘遇须保持运行；模型和 LoRA 以远端可用状态为准，素材会传到远端，结果和任务记录保存在使用端。远端生成沿用本机原生显存交接，可能停止该电脑上的语音、聊天模型及受管 ComfyUI。远程支持 Anima、Krea 2、Qwen 和 MOSS 图像任务；漫画处理需切回本机原生引擎，视频仍使用单独的引擎设置。连接中断时查询原任务，不自动重复提交。

密钥保存在两端本机设置中。端口使用 HTTP，传输依赖 Tailscale 私网加密，不应直接暴露到公网；撤销转发使用 `tailscale serve --tcp=3211 off`。状态中的模型就绪只表示远端文件可用，CUDA 与成图仍需在实际设备上确认。

**硬件要求**：
- Windows 10 22H2 / 11 x64
- NVIDIA Ampere 至 Blackwell 架构独显（支持 BF16，建议 12 GB 及以上显存）
- 显卡驱动 $\ge$ 572.61，系统内存建议 32 GiB

---

## 2. 应用内离线准备与完整目录导入

若网络受限或已有现成模型，可在控制室展开 **“已有资源与高级设置”** 进行离线接入：

### 离线运行库准备
使用已有 Python 环境与本地 wheelhouse 安装独立运行库：
```powershell
npm run wf -- models:prepare-inference --target-dir "D:\HuiyuAI\inference" --preflight --wheelhouse "D:\wheels"
npm run wf -- models:prepare-inference --target-dir "D:\HuiyuAI\inference" --apply --wheelhouse "D:\wheels"
```

### 完整模型目录导入
将已有的完整 Diffusers 模型目录复制并登记到模型根目录：
```powershell
npm run wf -- models:import-anima-directory --source-dir "D:\models\source-anima" --target-dir "D:\HuiyuAI\inference\models\anima-base-v1.0" --apply
```

---

固定版本模型下载中的 SHA-1 用于重建并核对 Git blob ID，包括绑定 SHA-256 与大小的 Git LFS 指针；实际 LFS 模型字节仍按 SHA-256 校验。它与文件完整性摘要承担不同职责，不因项目同时使用两种摘要就替换 Git 对象算法。

## 3. 架构核验与单文件离线转换

### 检查单文件 Checkpoint 结构
```powershell
python scripts/maintenance/inspect-anima-checkpoint.py --checkpoint "D:\models\miaomiaoHarem_anima16.safetensors"
```

### 经架构核验的离线转换
将单文件 safetensors 严格转换成原生 Diffusers 目录结构（仅在 CPU 执行，不加载张量至 GPU）：

```powershell
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

**支持的 Profile**：
- `anima-cosmos2b-v041`：28 层、2048 宽度（Anima Base 1.0、MiaoMiao 1.2 / 1.6、Aesthetic 1.1）
- `anima-cosmos29b-v041`：40 层、2048 宽度（MiaoMiao 2.9B Beta 1.1）
- `anima-yume2b-rope-v041`：28 层 Yume 1.0（额外核验静态 RoPE 派生缓冲）

---

## 4. 原生图像适配器与多模型支持

原生适配器通过统一的任务队列与内存调度器支持以下模型：

| modelId | 模型来源 | 原生任务入口 | 特性说明 |
|---|---|---|---|
| `krea2-raw` | krea/Krea-2-Raw | `/api/creative/jobs` | 文生图，可调节步数与 CFG |
| `krea2-turbo` | krea/Krea-2-Turbo | `/api/creative/jobs` | 8 步快速蒸馏调度 |
| `qwen-image-2.1` | Qwen/Qwen-Image-2.1 | `/api/qwen/jobs` | 文生图与最多四图参考指令编辑 |
| `qwen-image-2.1-turbo` | Qwen/Qwen-Image-2.1-Turbo | `/api/qwen/jobs` | 8 步文生图与参考图编辑 |
| `moss-miaomiao-base-v1.0` | MIAOKA / OpenMOSS | `/api/moss/jobs` | MiaoMiao MOSS 文生图 |
| `wan2.2-ti2v-5b` | Wan-AI/Wan2.2-TI2V-5B | `/api/video/jobs` | 3/5 秒文生视频，24 fps |
| `minimax-h3` | MiniMaxAI/MiniMax-H3 | `/api/video/jobs` | 联合音视频生成，支持 5/10 秒 |
| `ltx-2.3` | diffusers/LTX-2.3 | `/api/video/jobs` | 单阶段联合音视频生成 |

图像适配 Python 与 Anima Python 独立配置。除受管的 PyTorch 2.9 配方外，可复用已有的 PyTorch 2.13.0 / torchvision 0.28.0 / Transformers 5.14.1 / Pillow 12.2.0 / SageAttention 2.2.0 环境；补齐固定版本 Diffusers、Accelerate、PEFT、ftfy 与 huggingface-hub，版本见 `tools/inference/requirements-adapters.txt`。该共享环境的漫画处理使用 NumPy 2.4.4 与 OpenCV headless 5.0.0.93。原生 worker 只使用这些 Python 库，不启动或请求 ComfyUI 服务；切换解释器后重启绘遇，保留 Anima 原配置。

受管模型沿用下载时的完整校验记录，启动只在取得文件保护锁后核对版本、大小与修改状态；不匹配、非受管目录或无法取得保护锁时仍完整读取校验。任务记录的 `modelIdentityScope` 区分准备记录与完整字节摘要，不把二者混称为本次整库校验。

---

## 5. MangaScreen 漫画后处理与线稿提取

原生 `/api/manga` 接口提供纯 CPU 高性能漫画网点、色阶与分镜后处理：
- 工作台默认采用上游 QWEN-Manga 流程：Qwen-Image 2.1 Turbo 重绘、自动线稿、250 线网点和原始画幅；按原图比例选择接近 200 万像素的重绘尺寸，使用随机种子。重绘参考图编码与输出按同一像素面积配置，模型未准备时可在面板前往控制室安装。
- **操作类型**：
  - `lite`：色阶调整 + 网点平涂 + 原始画框合成
  - `comic`：线稿强化 + 网点平涂 + 画框裁切
  - `lineart`：仅提取黑线白底线稿（使用独立 MangaLineExtraction 网络）
- **Qwen 指令重绘**：可选在进入后处理前先使用 `qwen-image-2.1-turbo` 将原图重绘为黑白漫画风格。
- **连续调整**：同一原图的明暗、网点、纸张和边框调整沿用最近一次成功重绘的种子；随机模式下点击「换一版重绘」才换新种子。更换原图、重绘模型、指令或尺寸会重新重绘。worker 在文件保护租约有效时保存最近一份重绘 RGB（最多 6 MiB）和自动线稿（最多 8 MiB），输入像素与参数一致才复用；不支持文件保护、租约失效、取消及进程回收时不复用。调色阶改变线稿输入时会重新提取，调网点或纸张可复用线稿。任务记录 `rewrite.resultReused`、`lineart.resultReused` 与 CPU 墙钟分段，分段不可相加。
- **自动线稿**：显存预算足够时使用 CUDA，否则保留 CPU 路径；实际设备写入任务记录。连续重绘复用该 worker 拥有的模型与条件缓存，取消、切换引擎及进程退出时释放。
- 配方版本 5 绑定上述参考图编码规则；旧任务结果可继续查看，旧配方不可按新规则自动重试。新默认流程尚需当前版本的真实画质与设备验收。

---

## 6. 调度、高清精修与 TeaCache

### 调度器与两阶段精修
- **调度器**：支持 Euler 与二阶多步指数积分调度器 RES (`res_multistep`)。
- **两阶段高清**：支持 Latent 二次采样与固定 Remacri 超分辨率放大；支持 RCAS 锐化。

### TeaCache 本机校准与验收
- **日常内置策略**：默认启用基于 Apache-2.0 协议的自适应 TeaCache 策略（默认阈值 0.10，首尾采样步全算保持稳定性），无需针对每个模型/LoRA 单独校准。
- **离线校准命令（维护研究路径）**：
  ```powershell
  python -I scripts/maintenance/calibrate-anima-teacache.py `
    --calibration-job train.json `
    --validation-job heldout.json `
    --output-dir "D:\review" `
    --threshold 0.05 `
    --run
  ```
  在人工审查 review.html 画质与耗时后，通过 `--accept-run` 将校准档案写入模型目录。

---

## 7. 显存策略与进程生命周期

- **显存模式**：
  - Anima 普通生成按需导入可选遮罩模型类，显式诊断仍检查完整依赖；提示词编码关闭未使用的 KV 状态。同一任务按画幅复用最多 16 MiB RoPE，结束或取消即释放。编译模式保留 PyTorch 守卫，首次成功后遇到需要重编译的块在本任务改用普通执行，后续任务仍可尝试已有图；叶级卸载不编译，设备与显存错误继续报错。`nativeRuntime.execution` 记录编码、采样、解码的 CPU 墙钟分段及缓存/编译调用，实际提速与设备效果需另行确认。
  - Anima 的 Sage 系列模式使用已固定的 Triton 3.4.0.post21 接入 Q/K RMSNorm 与 split-half RoPE、LayerNorm 与 scale/shift 融合；参考本机 ComfyUI `b0b7435` 的融合边界，数学和低精度中间舍入按 Diffusers 0.41 实现，不导入 ComfyUI/Kitchen。使用 PyTorch 2.8 的 `triton_op` 接入块编译；不支持的布局保留原计算，`native` 模式不要求 Triton。`execution.kernelBackend` 只说明配置路径，首次 Triton JIT、设备效果和提速尚未验收。Sage 执行修订已更新，旧的显式 TeaCache 校准不能沿用。
  - Anima 使用 `inference.memoryPolicy`，默认 `resident`；Krea、Qwen、MOSS、漫画重绘及原生视频使用 `inference.adapterMemoryPolicy`，默认 `offload`。在控制室分别保存，启用模型保留已有选择；Anima 的 Sage/编译加速不传给其他模型。
  - `resident`（模型常驻）：权重常驻显存，需要显卡能容纳完整模型及运行时激活。
  - `offload`（分阶段卸载）：文本编码器与去噪网络按需搬运，节省显存占用。
  - Qwen/MOSS 的 `offload` 直接映射原权重文件，按当前画幅和空闲显存保留常用层，不生成磁盘权重副本。常驻权重先于临时激活分配；参考图前缀 K/V 可无损保存在 CPU，相同输入的条件编码在模型保护期内复用。条件缓存按最近使用保留最多 8 项、合计不超过 64 MiB，命中的常用负向编码会更新保留顺序。
  - Qwen 2.1 的 `offload` 前缀缓存按分支数、缓存大小及激活余量选择 GPU/CPU，可混合放置。CPU 路径参考 ComfyUI 的同分支逐层预取，最多两个各 256 MiB 的锁页与 GPU 暂存槽；余量不足、层过大或锁页分配不足时使用原同步搬运，不量化 K/V。预取不跨正负分支；最后一步采样后、VAE 解码前释放缓存，取消与失败收妥所属复制流再释放。`nativeRuntime.qwenPrefixCache` 记录位置、容量与实际搬运/预取次数，计数不证明已提速。
  - MOSS 首次编码使用原有阶段预算；已有扩散权重驻留时，后续任务优先保留扩散模型，让文本层共用剩余显存并按需流式搬运。进入采样前将文本权重还原到原 CPU/文件视图，避免两套模型连同采样激活挤满显存后被 Windows 换页；完成后只保留扩散权重，条件编码缓存仍有效。这也适用于原始 BF16 文本编码器；为最大文本组、激活、精度转换及解码预留空间，不能保证任意画幅或外部显存占用下全部常驻。
- **显存释放机制**：
  - 最后一次任务完成后，连续空闲 10 分钟自动释放模型与显存。
  - 启动本地对话或语音时，自动交接显存资源；退出桌面端立即终止子进程。

## 8. MiaoMiao Harem MOSS BASE v1.0 / v1.1

新创作默认选择 `moss-miaomiao-base-v1.1`；1.0 继续保留在模型选择、草稿、任务与作品中，不自动改写历史配方。1.1 INT8 对应作者版本 `3434952`、文件 `3332286`，文件大小 5,413,697,704 字节，SHA-256 `234e8fa8106bf2ac7f83586feb97054cf6e11a23e7cb2c5adfc808031d27b50b`。与 1.0 复用同一固定上游架构、Qwen3.5-9B 编码器、tokenizer、FLUX.2 VAE 与 INT8 算子；1.1 的 168 个投影明确带 `per_row: true`，不含 1.0 的逐层 Kitchen INT8 attention 配置，按版本分别校验元数据并选择既有 Sage/PyTorch 注意力路径。不将 1.1 权重覆盖到 1.0 目录。

已有完整 1.0 时，可运行 `npm run wf -- models:import-moss-int8 --source <作者1.1INT8文件> --model-dir <models根/moss-miaomiao-base-v1.1> --model-id moss-miaomiao-base-v1.1 --reuse-from <models根/moss-miaomiao-base-v1.0>` 预览，追加 `--apply` 写入。路径均用绝对路径，目标模型须未在推理。共享组件核对固定 SHA-256 后优先硬链接，无法链接时复制；主模型校验复制并原子发布导入记录。已有配套 INT8 文本编码器也复用并生成属于 1.1 的记录。保留下载原件与 1.0；文件就绪不代表真实出图与性能验收。

模型 ID 为 `moss-miaomiao-base-v1.0`。从「我的作品 → MiaoMiao MOSS 创作」进入，或在控制室选择该模型准备。先登录[作者版本页](https://civitai.com/models/3015023?modelVersionId=3422319)，下载 `miaomiaoHaremMOSS_baseV10_fp16.safetensors`，在准备面板填写完整本机路径。准备先核对作者 SHA-256 并复制权重，再下载固定版本的 Qwen3.5-9B 编码器、tokenizer 与 FLUX.2 VAE；原文件保留。完整组件约 27.2 GB，另需运行库、缓存及暂存空间，按面板预算准备磁盘。已有完整目录可额外导入同一作者版本的 INT8 文件，复用编码器、tokenizer 与 VAE。

作者 BASE v1.0 INT8（Civitai file `3316568`，5,413,700,574 bytes，SHA-256 `8aa2d469b28ea72beb35730b3a00bf0bffbaca03f0419d6f05d390614fe689d9`）为 Comfy 的逐通道 INT8 ConvRot，分组 256。关闭桌面/原生推理后运行 `npm run wf -- models:import-moss-int8 --source <作者INT8文件> --model-dir <已准备的moss-miaomiao-base-v1.0目录>` 预览，追加 `--apply` 才边复制边核对完整 SHA-256，再发布 `huiyu-moss-int8.json` 导入记录；原下载与 FP16 不覆盖，不复制配套组件。工作文件位于该目录 `transformer/miaomiaoHaremMOSS_baseV10_int8.safetensors`，异常中断留下的未登记文件可在下次导入校验后接续登记。

高级参数「主模型权重」保存 `mossWeightPrecision: auto | fp16 | int8`；默认自动优先使用有效导入的 INT8，未导入时使用 FP16，可显式切回 FP16。INT8 使用已有 `comfy-kitchen==0.2.37` / CUDA 13 Python 运行库的真实 INT8 线性算子，权重和 FP32 scale 以普通参数/缓冲区交给同一显存调度器，不还原整套 BF16 权重；注意力在可用时使用作者标记的 Kitchen INT8 内核，否则沿原有 Sage/PyTorch 路径。当前本机复用 ComfyUI Python；受管 PyTorch 2.9 环境不会被自动升级，缺少可用算子时请使用兼容独立 Python 或选择 FP16。导入、文件就绪与编译均不代表当前真实出图/画质/耗时已验收。

按[作者 BASE v1.0 说明](https://civitai.com/models/3015023?modelVersionId=3422319)，默认使用 Euler、50 步、CFG 3.5、768×1280；其推荐范围为 30–50 步，宽高为 16 的倍数。[OpenMOSS 管线](https://github.com/OpenMOSS/MOSS-Image)的 Shift 固定为 5、负分支跳过第 22 层。模型与 Anima 分别登记，不使用 Anima 编码器、VAE、角色 LoRA 或 TeaCache。

提示词支持中文、自然语言、标签和布局 JSON。普通描述补作者质量词；布局 JSON 原文提交，不在外面拼接标签，不改坐标。明确带文字的布局项使用原始默认负面时，去掉默认 `text`、`english text`；用户自定义负面保持原样。尺寸须与布局坐标一致。任务支持取消、恢复、结果导出和入册；当前只开放文生图。

MOSS 官方管线代码固定到 `OpenMOSS-Team/MOSS-Image-Base@85975793d8b3d432f1b6e27f352abaa4c2a4c0d3`，随产品附 Apache-2.0 许可，不执行模型目录提供的 Python。支持受管 PyTorch 2.9.0 / torchvision 0.24.0 及上面的共享图像运行库；作者 FP16 权重在上传 GPU 时转换为 BF16，不在主机内存复制完整权重。文件就绪和依赖可导入不代表本机画质、耗时或显存验收通过。

高级参数的「文本编码精度」可选 `mossTextPrecision: bf16 | fp8 | int8`，默认及旧任务均为 `bf16`。`fp8` 使用现有 Diffusers 的 [layerwise casting](https://huggingface.co/docs/diffusers/optimization/memory#layerwise-casting)，只将文本编码器的部分 Linear 权重存为 FP8、计算时恢复 BF16；保留词嵌入、归一化、DeltaNet 门控/卷积、最后一层及视觉模块的原精度。原始文件不修改，草稿、任务与作品保存所选精度，切换精度重新加载权重组。量化可能改变画面细节，实际画质和提速仍需设备验收。

`int8` 使用配套的 [Qwen3.5-9B W8A8 ConvRot 编码器](https://huggingface.co/sorryhyun/MOSS-Image-Qwen3.5-9B-int8)，不是主模型 INT8 开关。固定修订 `2e65ae37feace6d47d8fda7c8969da84a9199386` 的 `qwen35_9b_int8_convrot.safetensors` 为 9,873,285,104 bytes，SHA-256 `96064ede0b4caa9b6dd60a9fa868707e7b8ff3ae5347c0bab6bc868b5932f317`。关闭桌面推理后，用 `npm run wf -- models:import-moss-int8 --component text_encoder --source <文件绝对路径> --model-dir <现有MOSS目录> --apply` 校验导入；保留原 BF16 与 tokenizer。248 个校准投影使用同一 Kitchen W8A8 算子，保留文件中的校准归一化及 FP32 scale，不解量化整套权重、不执行模型目录代码。算子要求与主模型 INT8 相同；文件就绪不等于设备验收。

文本编码优先使用已经安装的 FLA DeltaNet 内核。可在已有适配 Python 中安装 `fla-core==0.6.0`、`flash-linear-attention==0.6.0` 与 `einops==0.8.2`，保留现有 PyTorch 及匹配的 Triton（Windows 使用 triton-windows），不让安装器替换运行环境。MOSS 无 KV 状态、无 packed sequence 的提示词编码可复用 FLA 的 Triton causal convolution，无需另编译 Windows `causal-conv1d` 扩展；缺少 FLA 时保留 Transformers 参考路径。FLA/Triton 的首次内核 JIT 仍可能耗时，与下方可选 DiT 编译分开。

MiaoMiao 单文件里的融合 QKV 直接作为一个投影加载，不拆成三个矩阵乘法；原始分离 Q/K/V 目录仍按其结构加载。每个任务单独复用文本细化、RoPE 与同一步正负分支的时间调制，文本/RoPE 缓存合计不超过 64 MiB，结束、取消或失败均释放。Spectrum 预测步跳过文本细化。以上不需要更换作者权重。

「编译推理内核」对应 `mossCompile`：新创作默认关闭并保存在草稿和作品中，已有明确选择保留。只用现有 PyTorch 编译 DiT 块，不编译含 token/chunk Python 循环的 Transformers DeltaNet 参考函数，避免换词长度引发大型图编译。分层调度钩子在编译边界外，只有图像/文本序列轴以 `maybe_mark_dynamic` 提示动态，允许 INT8 算子或图中断后的片段按需要特化，不以强制动态约束拒绝有效图；不启用 CUDA Graph，注意力分发在任务间复用。开启后首次仍可能明显变慢；每块首次成功后使用 PyTorch 的 `fail_on_recompile` 守卫，遇到未命中的输入在本任务改用普通执行并记录 `RecompileSkipped`，后续任务仍可复用原图。叶级卸载不编译 DiT，已知编译器失败退回普通执行，显存不足与设备错误仍正常报错并清理。做法参考 [ComfyUI 的 MOSS 分块编译入口](https://github.com/sorryhyun/ComfyUI-Spectrum-KSampler#ksampler-spectrum-for-moss)与 [PyTorch 编译控制](https://docs.pytorch.org/tutorials/recipes/torch_compiler_set_stance_tutorial.html)，不引入或复制该插件。实际可用性、画质与耗时仍需设备验收。

MOSS 创作的高级参数可选择「Spectrum · 实验」缓存加速，新创作默认开启，已有明确关闭的草稿与旧任务保留原选择，可随时关闭使用完整计算。实现基于 [Spectrum 原始 MIT 代码](https://github.com/hanjq17/Spectrum/tree/4e41f91c93ff66b045332530dd7bcb4c60eafbab)的 Chebyshev 与一阶 Taylor 混合预测，随包保留 `SPECTRUM-LICENSE`；不引入 ComfyUI 插件。v3 采用[社区 MOSS 节点的增长窗口调度](https://github.com/sorryhyun/ComfyUI-Spectrum-KSampler/blob/main/moss.py)：初始窗口为 2，前 6 步与末 3 步完整计算，每次非预热完整计算后窗口增加 `mossSpectrumFlexWindow`，每 `floor(窗口)` 步完整刷新一次。高级参数「Spectrum 加速强度」范围 0–2、默认 0.5、步进 0.05；0.25 更保守、1 更激进，0 仍保留初始窗口预测，关闭需选择 `off`。请求、草稿、任务与作品保存窗口增长值；旧记录缺少该值时使用 0.5，再次生成会采用当前调度。

原生实现保留最多 6 份图像隐藏状态、4 阶拟合与 0.5 混合权重，避免直接采用社区大历史缓冲的显存开销；因此窗口参数对齐不代表整个预测器与插件逐像素相同。正负分支及跳层组合各自隔离，相同时间点的 CPU 拟合系数在任务内复用，短采样减少或不进行预测。每个任务独立清理，保留取消及进度。显存余量不足、拟合失败或预测出现非有限值时使用完整计算，并在任务 `nativeRuntime.mossAcceleration` 记录窗口配置、实际计算/预测次数、实际最长连续预测及回退原因。不使用 Anima TeaCache 阈值。预测可能改变局部纹理、道具细节与手部关系；收益及画质须依据本机相同参数的逐图记录判断，不能据社区其他模型数据宣称本机提速倍数。

任务 `nativeRuntime.mossExecution` 保留编译入口调用数/退回原因、任务内缓存命中及编码、采样、解码的 CPU 墙钟分段，不额外同步 CUDA；入口调用数不代表整段均已融合或已证明提速。这些分段不是可相加的 GPU 计时，首次编译计入对应分段，`performanceVerified` 始终保持未验证。

MOSS 结果提供独立的 Remacri 1.5×／2× 放大操作，使用现有 `upscale_models/4x_foolhardy_Remacri.safetensors`。只处理已生成的像素副本，不加载 MOSS 权重、不编码提示词、不进行第二轮采样；保留原任务，并可返回原图选择另一倍率。原图每边限 512–1536 像素且为 16 的倍数，输出最大每边 3072 像素。任务保存 `mossUpscaleScale`、`mossUpscaleSourceTaskId` 与实际输出尺寸；运行记录注明 `operation: moss-upscale`、超分权重摘要、分块数及耗时，采样步数为 0。复用 Anima 已有的 FP32 RRDB 4× 网络和重叠拼接，最后 Lanczos 缩至指定倍率；1.5× 并不意味着只执行 1.5× 网络。512 像素块仅在真实 CUDA 显存不足时退到 256／128，保留逐块进度、取消和有限像素检查，不增加额外锐化。放大副本仍可导出或保存到作品册；MOSS 的 Latent 高清重绘尚未接入，Anima 的高清及 TeaCache 设置不变。

## 9. MiaoMiao RealSkin Anima 2.9B 1.0

模型 ID 为 `anima-miaomiao-realskin-2.9b-v1.0`，对应[作者 Anima2.9B 1.0 版本](https://civitai.com/models/2026594?modelVersionId=3415563)。同一发布页还保留旧版 Anima、Illustrious 和 NoobAI，准备时须下载 `miaomiaoRealskin_anima29B10.safetensors`（5,843,203,272 字节，SHA-256 `1e0ad19711045540570dffd5ecc4a39aeeb5810ac2e4641c1d060d47167f4c46`）。该版本需要 Civitai 登录，绘遇不保存该站凭据。

在「控制室 → 原生引擎」选择 RealSkin 并填写权重完整路径。准备先核对作者摘要并复制到工作区，再下载固定版本的 Qwen3-0.6B 编码器、Qwen-Image VAE 和 tokenizer，使用现有 `anima-cosmos29b-v041` 严格转换。转换配置仅将已固定的 Base 配置深度改为 40，全部张量名称、形状和类型仍逐项校验，不将 40 层权重载入 28 层模型；输入和转换后的权重共约 14.6 GB，另需运行库和临时空间。作者原文件保留。

绘制工作台的模型选择与提示词配方独立登记。按该作者版本默认 Euler / SGM Uniform、30 步、CFG 4.0；作者 920×1536 按引擎 16 像素网格调整为 928×1536。质量词使用该版本配方，负面保留作者含义、去重并统一普通标签空格；显式深色或有色皮肤会移除默认 `fair skin`。不声明现有角色 LoRA 兼容，不套用 Harem 1.6、MOSS 或旧版 RealSkin 的参数。当前尚无作者权重的真实加载、编译 Token 与出图证据，保留实验标记，需权重及设备验收。
