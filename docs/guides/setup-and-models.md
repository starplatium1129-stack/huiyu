# 全功能开箱与硬件配置、模型资产部署指南

> 本指南帮助新同学从零开箱本项目的全部功能。阐明运行所需的硬件配置门槛、模型放置的精确目录树、亲测可用的公共开源底座直链，以及本站专属自训 LoRA 的定位与使用方式。

---

## 一、 硬件配置梯队表（什么样的电脑能玩什么？）

绘遇 HUIYU 在底层做了细致的模块化与优雅降级。无需盲目追求顶级显卡，对号入座即可知道您的设备能够开启的功能：

| 配置梯队 | 硬件门槛（显存/内存/磁盘） | 能完整使用的功能范围 |
| :--- | :--- | :--- |
| **0. 纯 CPU / 核显档**<br>（轻薄本 / 办公机 / Mac） | • **CPU**：4 核以上<br>• **显卡**：无独显 / 核显<br>• **内存**：8GB+<br>• **磁盘**：预留 5GB | • **完整体验**：全部 302 个 Galgame 场景与 1692 蓝图浏览、故事阅读、灵感骰子、Tauri 桌面悬浮伴侣；<br>• **WD14 本地反推**：**完全可用！** 内置 ONNX 引擎直接用 CPU 运行，0.3 秒即可完成反推；<br>• *注：无法本地绘图，但可通过控制面板填入局域网/朋友的 WebUI 或 ComfyUI 远程地址。* |
| **1. 轻量入门档**<br>（千元独显 / 入门游戏本） | • **显卡**：**6GB ~ 8GB 显存**（如 GTX 1660S / RTX 2060 / 3050 / 4050）<br>• **内存**：16GB<br>• **磁盘**：预留 30GB (SSD) | • **SD 1.5 绘图**：流畅出图（512×768 / 768×1024）；<br>• **Anima 绘图**：标准分辨率（832×1216）直出；<br>• **伴侣对话**：可运行 Ollama 7B / 8B 量化模型（如 Qwen2.5-7B-Instruct-Q4）。 |
| **2. 黄金推荐档**<br>（主流甜品卡 / 生产力） | • **显卡**：**10GB ~ 16GB 显存**（如 RTX 3060 12G / 4060Ti 16G / 4070 / 3080）<br>• **内存**：32GB<br>• **磁盘**：预留 60GB (SSD) | • **Anima 旗舰全功能**：832×1216 直出 + **1.5x~2x 高清修复（Hires Latent / 超分）**；<br>• **全角色 LoRA 自由换装**：宁宁、夏目及各类画师风格 LoRA 秒级融合加载；<br>• **Krea 2 Turbo**：3~5 步极速渲染（出图仅需 1~2 秒）；<br>• **角色声音**：GPT-SoVITS 角色原声生成与 Live2D 口型实时驱动。 |
| **3. 发烧叙事短片档**<br>（高端旗舰卡） | • **显卡**：**16GB ~ 24GB 显存**（如 RTX 3090 / 4090）<br>• **内存**：32GB ~ 64GB<br>• **磁盘**：预留 120GB+ (SSD) | • **视频工作台（Video Studio）**：完整运行 **Wan 2.2 TI2V** 图生视频与 **MiniMax H3** 角色锁脸视频生成；<br>• **大批量批次出图**：多并发连续渲染不爆显存。 |

---

## 二、 模型应该放在哪里？（文件目录树）

这是新手最常遇到的问题：**文件放错文件夹，系统就探测不到**。请严格参照以下树状结构放置：

```text
你的电脑工作区/
├── huiyu/                                      # 绘遇项目根目录
│   └── runtime/
│       └── models/
│           └── interrogate/                    # ★ 【反推模型放这里】
│               ├── wd-v1-4-moat-tagger-v2.onnx # ONNX 神经网络权重
│               └── wd-v1-4-moat-tagger-v2.csv  # 标签索引表
│
└── ComfyUI/                                    # ComfyUI 根目录（或秋叶整合包/Stability Matrix）
    └── models/
        ├── diffusion_models/                   # ★ 【绘图底模放这里】
        │   ├── miaomiaoHarem_anima12.safetensors（推荐款）
        │   └── anima-base-v1.0.safetensors（官方基座款）
        │
        ├── text_encoders/                      # ★ 【文本编码器放这里】
        │   └── qwen_3_06b_base.safetensors     # Qwen 文本理解核心
        │
        ├── vae/                                # ★ 【图像 VAE 放这里】
        │   └── qwen_image_vae.safetensors      # 潜空间编解码器
        │
        └── loras/                              # ★ 【LoRA 放这里】
            ├── ayachi_nene_v21_anima.safetensors   # 绫地宁宁专属（主力机专属）
            └── shiki_natsume_v21_anima.safetensors # 四季夏目专属（主力机专属）
```

> **提示：ComfyUI 目录自动识别**
> 本项目网关启动时会自动寻找常见路径（`../AI/ComfyUI/models`、`D:/ComfyUI/models`、`C:/ComfyUI/models` 等）。
> 如果您的 ComfyUI 安装在自定义路径，只需设置环境变量：`$env:COMFYUI_MODELS_ROOT = "你的ComfyUI路径/models"` 即可。

---

## 三、 公共开源模型清单（全部实测有效直链）

以下模型均为开源社区资产，任何人开箱均可免费下载：

### 1. 本地真实反推模型（WD14 Tagger，仅 ~150MB，免显存）
- **存放位置**：`huiyu/runtime/models/interrogate/`
- **下载方式 A（推荐一键下载）**：在项目终端直接执行内置脚本，自动从国内镜像极速下载：
  ```powershell
  npm run workflow -- models:download-wd14
  ```
- **下载方式 B（浏览器手动下载）**：
  - [ModelScope 国内千兆直链：model.onnx](https://www.modelscope.cn/models/fireicewolf/wd-v1-4-moat-tagger-v2/resolve/master/model.onnx)（下载后重命名为 `wd-v1-4-moat-tagger-v2.onnx`）
  - [ModelScope 国内千兆直链：selected_tags.csv](https://www.modelscope.cn/models/fireicewolf/wd-v1-4-moat-tagger-v2/resolve/master/selected_tags.csv)（下载后重命名为 `wd-v1-4-moat-tagger-v2.csv`）
  - [HuggingFace 官方源（国外）](https://huggingface.co/SmilingWolf/wd-v1-4-moat-tagger-v2)

### 2. Anima 文本编码器与 VAE（必备组件）
由于 Anima 属于 DiT 架构，必须配备独立的 Text Encoder 与 VAE：
- **Qwen 文本编码器**（~1.19 GB）：
  - **存放位置**：`ComfyUI/models/text_encoders/qwen_3_06b_base.safetensors`
  - [ModelScope 官方国内直链下载](https://www.modelscope.cn/models/circlestone-labs/Anima/resolve/master/split_files/text_encoders/qwen_3_06b_base.safetensors)
- **Qwen 图像 VAE**（~253 MB）：
  - **存放位置**：`ComfyUI/models/vae/qwen_image_vae.safetensors`
  - [ModelScope 官方国内直链下载](https://www.modelscope.cn/models/circlestone-labs/Anima/resolve/master/split_files/vae/qwen_image_vae.safetensors)

### 3. Anima 绘画底模（核心画风）
- **存放位置**：`ComfyUI/models/diffusion_models/`
- **推荐底模**：
  - **MiaoMiao Harem v1.2 / v1.6**（~4.2 GB，MIAOKA 出品，二次元半厚涂肌肤与唯美光影推荐款）：
    - [Civitai 官方模型主页](https://civitai.com/models/934764/miaomiao-harem)
  - **Anima Base v1.0**（~4.18 GB，官方纯净基座）：
    - [ModelScope 官方国内直链下载](https://www.modelscope.cn/models/circlestone-labs/Anima/resolve/master/split_files/diffusion_models/anima-base-v1.0.safetensors)
  - **Anima Aesthetic v1.1**（~4.18 GB，官方美学增强版）：
    - [ModelScope 官方国内直链下载](https://www.modelscope.cn/models/circlestone-labs/Anima/resolve/master/split_files/diffusion_models/anima-aesthetic-v1.1.safetensors)

---

## 四、 本站专属自训 LoRA 说明

- **文件清单**：
  - `ayachi_nene_v21_anima.safetensors`（绫地宁宁 v21 专属高精权重）
  - `shiki_natsume_v21_anima.safetensors`（四季夏目 v21 专属高精权重）
- **存放路径**：`ComfyUI/models/loras/`
- **使用场景与定位**：
  - **站长主力机环境**：这两款 LoRA 为站长在主力机上基于高质量官方私有数据集深度调优精炼的核心资产，目前仅保存在站长主力机上，未公开发布在外部平台；若在主力机使用，只需拷入上述目录即可获得 100% 像素级立绘还原；
  - **外部新用户开箱**：完全不影响任何使用！系统原生内置了 `noLora: true` 保护，且系统内收录的 **158 位热门动漫角色**（如芙宁娜、雷电将军、芙莉莲、玛奇玛、圣园未花等）与 **1692 个场景蓝图**，**本来就不需要任何外部 LoRA**，完全依托项目自研的角色 DNA 锚点与标签流矩阵，开箱即可高质量出图！

---

## 五、 一键环境体检工具

配置好或想要排查缺什么模型时，只需在项目根目录运行：

```powershell
npm run workflow -- models:check
```

控制台会自动检测您的显卡与显存、扫描 ComfyUI 和项目运行时目录，以清晰的绿勾红叉输出报告：
```text
==================================================================
            绘遇 HUIYU · 硬件环境与模型资产全景体检                
==================================================================

【1. 硬件配置与推荐档位】
  • 系统内存 (RAM): 32 GB
  • 独立显卡 (GPU): NVIDIA GeForce RTX 4070 (12282 MB VRAM)
  ⭐ 当前定位: 【黄金推荐档】 - 可完全驾驭 Anima 旗舰画质 + 高清修复 + GPT-SoVITS 原声

【2. 本地真实反推引擎 (WD14 Tagger)】
  [✔ 已就绪] WD14 真实反推模型 (153 MB) @ runtime/models/interrogate

【3. ComfyUI 核心绘图模型 (开源底座)】
  已找到 ComfyUI models 目录: D:\ComfyUI\models
  [✔ 已就绪] Anima 绘图底模: MiaoMiao v1.2 (4182 MB)
  [✔ 已就绪] Qwen 文本编码器 (1192 MB)
  [✔ 已就绪] 图像 VAE 编解码器 (253 MB)

【4. 本站独家自训 LoRA (绫地宁宁 / 四季夏目)】
  [ℹ 独家资产提示] 专属 LoRA 为站长主力机精炼资产。非主力机环境原生支持无 LoRA 创作。
```
