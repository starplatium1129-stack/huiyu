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
  - Anima 使用 `inference.memoryPolicy`，默认 `resident`；Krea、Qwen、MOSS、漫画重绘及原生视频使用 `inference.adapterMemoryPolicy`，默认 `offload`。在控制室分别保存，启用模型保留已有选择；Anima 的 Sage/编译加速不传给其他模型。
  - `resident`（模型常驻）：权重常驻显存，需要显卡能容纳完整模型及运行时激活。
  - `offload`（分阶段卸载）：文本编码器与去噪网络按需搬运，节省显存占用。
  - Qwen/MOSS 的 `offload` 直接映射原权重文件，按当前画幅和空闲显存保留常用层，不生成磁盘权重副本。常驻权重先于临时激活分配；参考图前缀 K/V 可无损保存在 CPU，相同输入的条件编码在模型保护期内复用。
- **显存释放机制**：
  - 最后一次任务完成后，连续空闲 10 分钟自动释放模型与显存。
  - 启动本地对话或语音时，自动交接显存资源；退出桌面端立即终止子进程。

## 8. MiaoMiao Harem MOSS BASE v1.0

模型 ID 为 `moss-miaomiao-base-v1.0`。从「我的作品 → MiaoMiao MOSS 创作」进入，或在控制室选择该模型准备。先登录[作者版本页](https://civitai.com/models/3015023?modelVersionId=3422319)，下载 `miaomiaoHaremMOSS_baseV10_fp16.safetensors`，在准备面板填写完整本机路径。准备先核对作者 SHA-256 并复制权重，再下载固定版本的 Qwen3.5-9B 编码器、tokenizer 与 FLUX.2 VAE；原文件保留。完整组件约 27.2 GB，另需运行库、缓存及暂存空间，按面板预算准备磁盘。当前不接入作者 INT8/ConvRot 文件。

按[作者 BASE v1.0 说明](https://civitai.com/models/3015023?modelVersionId=3422319)，默认使用 Euler、50 步、CFG 3.5、768×1280；其推荐范围为 30–50 步，宽高为 16 的倍数。[OpenMOSS 管线](https://github.com/OpenMOSS/MOSS-Image)的 Shift 固定为 5、负分支跳过第 22 层。模型与 Anima 分别登记，不使用 Anima 编码器、VAE、角色 LoRA 或 TeaCache。

提示词支持中文、自然语言、标签和布局 JSON。普通描述补作者质量词；布局 JSON 原文提交，不在外面拼接标签，不改坐标。明确带文字的布局项使用原始默认负面时，去掉默认 `text`、`english text`；用户自定义负面保持原样。尺寸须与布局坐标一致。任务支持取消、恢复、结果导出和入册；当前只开放文生图。

MOSS 官方管线代码固定到 `OpenMOSS-Team/MOSS-Image-Base@85975793d8b3d432f1b6e27f352abaa4c2a4c0d3`，随产品附 Apache-2.0 许可，不执行模型目录提供的 Python。支持受管 PyTorch 2.9.0 / torchvision 0.24.0 及上面的共享图像运行库；作者 FP16 权重在上传 GPU 时转换为 BF16，不在主机内存复制完整权重。文件就绪和依赖可导入不代表本机画质、耗时或显存验收通过。

MOSS 创作的高级参数可选择「Spectrum · 实验」缓存加速，默认关闭。实现基于 [Spectrum 原始 MIT 代码](https://github.com/hanjq17/Spectrum/tree/4e41f91c93ff66b045332530dd7bcb4c60eafbab)的 Chebyshev 与一阶 Taylor 混合预测，随包保留 `SPECTRUM-LICENSE`；不引入 ComfyUI 插件。当前只缓存图像隐藏状态，正负分支及跳层组合各自隔离，固定前 6 步、末 3 步与每次预测后的刷新步完整计算；短采样会减少或不进行预测。每个任务独立清理，保留取消及进度。显存余量不足、拟合失败或预测出现非有限值时使用完整计算，并在任务 `nativeRuntime.mossAcceleration` 记录实际计算/预测次数及原因。请求、草稿和作品保留 `mossAcceleration: off | spectrum`，不使用 Anima TeaCache 阈值。该 MIAOKA 微调尚未完成真实权重和画质/性能验收，不能据社区其他模型数据宣称本机提速倍数。

## 9. MiaoMiao RealSkin Anima 2.9B 1.0

模型 ID 为 `anima-miaomiao-realskin-2.9b-v1.0`，对应[作者 Anima2.9B 1.0 版本](https://civitai.com/models/2026594?modelVersionId=3415563)。同一发布页还保留旧版 Anima、Illustrious 和 NoobAI，准备时须下载 `miaomiaoRealskin_anima29B10.safetensors`（5,843,203,272 字节，SHA-256 `1e0ad19711045540570dffd5ecc4a39aeeb5810ac2e4641c1d060d47167f4c46`）。该版本需要 Civitai 登录，绘遇不保存该站凭据。

在「控制室 → 原生引擎」选择 RealSkin 并填写权重完整路径。准备先核对作者摘要并复制到工作区，再下载固定版本的 Qwen3-0.6B 编码器、Qwen-Image VAE 和 tokenizer，使用现有 `anima-cosmos29b-v041` 严格转换。转换配置仅将已固定的 Base 配置深度改为 40，全部张量名称、形状和类型仍逐项校验，不将 40 层权重载入 28 层模型；输入和转换后的权重共约 14.6 GB，另需运行库和临时空间。作者原文件保留。

绘制工作台的模型选择与提示词配方独立登记。按该作者版本默认 Euler / SGM Uniform、30 步、CFG 4.0；作者 920×1536 按引擎 16 像素网格调整为 928×1536。质量词使用该版本配方，负面保留作者含义、去重并统一普通标签空格；显式深色或有色皮肤会移除默认 `fair skin`。不声明现有角色 LoRA 兼容，不套用 Harem 1.6、MOSS 或旧版 RealSkin 的参数。当前尚无作者权重的真实加载、编译 Token 与出图证据，保留实验标记，需权重及设备验收。
