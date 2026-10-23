# 独立图像与视频推理接入指南

本项目原生推理基于独立 Python 运行库与官方 Diffusers 架构，不依赖 ComfyUI 节点即可完成文生图、图生图、局部重绘、适配器生图及漫画后处理。

---

## 1. 核心使用方式

### 快速一键准备（推荐）
在控制室打开 **“原生生图”**：
1. 选择 AI 工作区（如 `D:\HuiyuAI`）。
2. 核对硬件条件后点击 **“一键准备”**，系统将在后台自动下载并校验独立 Python 3.11 运行库与完整 Diffusers 模型（默认推荐 MiaoMiao Harem Anima 1.6）。
3. 安装完成后重启桌面端生效，即可在画室开始原生创作。

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
| `wan2.2-ti2v-5b` | Wan-AI/Wan2.2-TI2V-5B | `/api/video/jobs` | 3/5 秒文生视频，24 fps |
| `minimax-h3` | MiniMaxAI/MiniMax-H3 | `/api/video/jobs` | 联合音视频生成，支持 5/10 秒 |
| `ltx-2.3` | diffusers/LTX-2.3 | `/api/video/jobs` | 单阶段联合音视频生成 |

---

## 5. MangaScreen 漫画后处理与线稿提取

原生 `/api/manga` 接口提供纯 CPU 高性能漫画网点、色阶与分镜后处理：
- **操作类型**：
  - `lite`：色阶调整 + 网点平涂 + 原始画框合成
  - `comic`：线稿强化 + 网点平涂 + 画框裁切
  - `lineart`：仅提取黑线白底线稿（使用独立 MangaLineExtraction 网络）
- **Qwen 指令重绘**：可选在进入后处理前先使用 `qwen-image-2.1-turbo` 将原图重绘为黑白漫画风格。

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
  - `resident`（模型常驻）：权重常驻显存，吞吐速度最快（适合 12 GB+ 显卡）。
  - `offload`（分阶段卸载）：文本编码器与去噪网络按需搬运，节省显存占用。
- **显存释放机制**：
  - 最后一次任务完成后，连续空闲 10 分钟自动释放模型与显存。
  - 启动本地对话或语音时，自动交接显存资源；退出桌面端立即终止子进程。

## 8. MiaoMiao Harem MOSS BASE v1.0

模型 ID 为 `moss-miaomiao-base-v1.0`。从「我的作品 → MiaoMiao MOSS 创作」进入，或在控制室选择该模型准备。先登录[作者版本页](https://civitai.com/models/3015023?modelVersionId=3422319)，下载 `miaomiaoHaremMOSS_baseV10_fp16.safetensors`，在准备面板填写完整本机路径。准备先核对作者 SHA-256 并复制权重，再下载固定版本的 Qwen3.5-9B 编码器、tokenizer 与 FLUX.2 VAE；原文件保留。完整组件约 27.2 GB，另需运行库、缓存及暂存空间，按面板预算准备磁盘。当前不接入作者 INT8/ConvRot 文件。

按[作者 BASE v1.0 说明](https://civitai.com/models/3015023?modelVersionId=3422319)，默认使用 Euler、50 步、CFG 3.5、768×1280；其推荐范围为 30–50 步，宽高为 16 的倍数。[OpenMOSS 管线](https://github.com/OpenMOSS/MOSS-Image)的 Shift 固定为 5、负分支跳过第 22 层。模型与 Anima 分别登记，不使用 Anima 编码器、VAE、角色 LoRA 或 TeaCache。

提示词支持中文、自然语言、标签和布局 JSON。普通描述补作者质量词；布局 JSON 原文提交，不在外面拼接标签，不改坐标。明确带文字的布局项使用原始默认负面时，去掉默认 `text`、`english text`；用户自定义负面保持原样。尺寸须与布局坐标一致。任务支持取消、恢复、结果导出和入册；当前只开放文生图。

MOSS 官方管线代码固定到 `OpenMOSS-Team/MOSS-Image-Base@85975793d8b3d432f1b6e27f352abaa4c2a4c0d3`，随产品附 Apache-2.0 许可，不执行模型目录提供的 Python。独立图像适配运行库更新为 PyTorch 2.9.0 / torchvision 0.24.0；现有旧版适配运行库需在控制室重新准备。此版本尚未取得作者权重做加载、出图或设备验收，文件就绪不代表已验证画质、耗时或显存。
