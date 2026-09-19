# 全功能开箱与硬件配置、模型资产部署指南

> 本指南帮助新同学从零开箱本项目的全部功能。阐明运行所需的硬件配置门槛、公共开源底座直链，以及本站专属自训 LoRA 的定位与使用方式。

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

## 二、 模型资产架构：公共开源底座 vs 本站独家自训资产

本项目将模型资产分为两大部分：

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        绘遇 HUIYU 完整模型拼图                         │
├───────────────────────────────────┬────────────────────────────────────┤
│   【A. 公共开源底座（开箱人人可下）】   │  【B. 本站独家自训资产（主力机专属）】   │
│  • WD14 反推模型 (~150MB，免显存)    │  • 绫地宁宁 v21 Anima 专属高精 LoRA   │
│  • Anima 绘图底模 (MiaoMiao, ~4GB)│  • 四季夏目 v21 Anima 专属高精 LoRA   │
│  • Qwen 文本编码器 + VAE (~3.5GB) │                                    │
│  • 158 个热门角色 + 1692 蓝图提示词 │                                    │
├───────────────────────────────────┼────────────────────────────────────┤
│  效果：全站功能、反推换装、热门角色 │  效果：看板娘 100% 官方立绘级还原；    │
│        无 LoRA 模式全部点亮！      │        在主力机上拷入 loras/ 即可。  │
└───────────────────────────────────┴────────────────────────────────────┘
```

1. **公共开源底座**：任何人克隆代码后，下载这套模型，即可**完整使用绘图、反推、换装与 158 个热门动漫角色**；
2. **本站自训独家资产**：绫地宁宁与四季夏目的专属 v21 LoRA 是站长在主力机上针对特定画风与人设精细训练的独门特色。目前保存在站长主力机上，未公开发布在 HuggingFace 等外部平台。系统内置了 `noLora: true` 保护机制，即使没有这两个专属 LoRA，系统依然会通过自然语言与角色 DNA 标签进行高质量作画。

---

## 三、 公共开源模型清单（直链与放置路径）

### 1. 本地真实反推模型（WD14 Tagger，极力推荐！）
- **体积**：约 150 MB（不占显卡显存，CPU 毫秒级推理）。
- **存放路径**：`runtime/models/interrogate/`
- **文件清单与下载源**：
  - `wd-v1-4-moat-tagger-v2.onnx`（[HF-Mirror 镜像直链](https://hf-mirror.com/SmilingWolf/wd-v1-4-moat-tagger-v2/resolve/main/model.onnx) · [官方直链](https://huggingface.co/SmilingWolf/wd-v1-4-moat-tagger-v2/resolve/main/model.onnx)）
  - `wd-v1-4-moat-tagger-v2.csv`（[HF-Mirror 镜像直链](https://hf-mirror.com/SmilingWolf/wd-v1-4-moat-tagger-v2/resolve/main/selected_tags.csv) · [官方直链](https://huggingface.co/SmilingWolf/wd-v1-4-moat-tagger-v2/resolve/main/selected_tags.csv)）
- **一键下载命令**（项目内置）：
  ```powershell
  npm run workflow -- models:download-wd14
  ```

### 2. Anima 绘图底模（ComfyUI 绘画核心）
- **存放路径**：`ComfyUI/models/diffusion_models/`
- **推荐底模**：
  - `miaomiaoHarem_anima12.safetensors`（~4.2 GB，MIAOKA 出品，二次元半厚涂肌肤与唯美光影推荐款）
  - 或 `miaomiaoHarem_anima16.safetensors`
  - 下载源：[Civitai](https://civitai.com/models/xxx) 或 HuggingFace 检索 `miaomiaoHarem`。

### 3. Anima 文本编码器与 VAE
Anima 基于 DiT 架构，必须配备独立的文本编码器与 VAE：
- **文本编码器**（放 `ComfyUI/models/text_encoders/`）：
  - `qwen_3_06b_base.safetensors`（~3.1 GB）
  - [HF-Mirror 镜像直链](https://hf-mirror.com/Comfy-Org/Anima_repackaged/resolve/main/split_files/text_encoders/qwen_3_06b_base.safetensors)
- **图像 VAE**（放 `ComfyUI/models/vae/`）：
  - `qwen_image_vae.safetensors`（~0.3 GB）
  - [HF-Mirror 镜像直链](https://hf-mirror.com/Comfy-Org/Anima_repackaged/resolve/main/split_files/vae/qwen_image_vae.safetensors)

---

## 四、 本站专属自训 LoRA 说明

- **文件清单**：
  - `ayachi_nene_v21_anima.safetensors`（绫地宁宁 v21 专属权重）
  - `shiki_natsume_v21_anima.safetensors`（四季夏目 v21 专属权重）
- **存放路径**：`ComfyUI/models/loras/`
- **使用说明**：
  - **主力机用户**：若您正在站长的主力机或内网环境下，直接从本地备份目录拷入上述路径，即可点亮 100% 像素级立绘还原；
  - **开源/外部用户**：无需担心！绘遇支持的 **158 位热门动漫角色**（如《原神》芙宁娜/雷电将军、《葬送的芙莉莲》芙莉莲、《链锯人》玛奇玛、《碧蓝档案》未花等）**完全不需要自训 LoRA**，依托项目内置的数千条角色 DNA 锚点与 Danbooru 矩阵即可高还原度出图！

---

## 五、 模型与环境一键体检工具

为了方便检查当前机器是否已经配齐所需模型，本项目提供了自动化体检工具：

```powershell
npm run workflow -- models:check
```

运行后，终端会自动扫描您的硬件配置、ComfyUI 目录与项目运行时，输出状态清单：
```text
[✔] GPU 显存: RTX 4070 (12282 MB) - 达到黄金推荐档
[✔] WD14 反推模型: 已就绪 (wd-v1-4-moat-tagger-v2, 153 MB)
[✔] Anima 绘图底模: 已就绪 (miaomiaoHarem_anima12.safetensors)
[✔] 文本编码器: 已就绪 (qwen_3_06b_base.safetensors)
[✔] 图像 VAE: 已就绪 (qwen_image_vae.safetensors)
[ℹ] 看板娘专属 LoRA: 未检测到（主力机专属资产；当前已自动启用无 LoRA 兼容模式）
```
缺失任何公共开源模型时，体检工具会贴心打印对应的国内高速下载直链。
