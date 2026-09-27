# 本地硬件与模型配置指南

本文说明本地模型的配置位置、下载入口与检测方法。硬件档位用于准备环境，能否生成仍由实际模型、上游服务、节点和设备测试确认。

> 2026-09-27 核对：当前数据规模与本机安装见 [项目状态](../project-status.md)，模型/设备待验项见 [未来规划](../roadmap.md)。本文不重复维护内容数量；模型文件存在、资料收录和体检通过分别记录，不能替代真实出图或设备验收。本轮未重新下载模型或核验外部链接。

---

## 一、 硬件配置梯队表（什么样的电脑能玩什么？）

以下容量是环境准备的参考档位；并行运行绘图、聊天、视频和语音会共享内存/显存，表格不保证固定耗时、并发数或无显存溢出：

| 配置梯队 | 参考容量（显存/内存/磁盘） | 配置与验收范围 |
| :--- | :--- | :--- |
| **0. 纯 CPU / 核显档**<br>（轻薄本 / 办公机） | • **CPU**：4 核以上<br>• **显卡**：无独显 / 核显<br>• **内存**：8GB+<br>• **磁盘**：预留 5GB | • 可浏览场景、蓝图和故事；Windows 桌面伴侣另需对应安装版；<br>• WD14 CPU 反推需 ONNX 模型与标签表就绪，耗时按设备实测；<br>• 本地网关可连接控制面板配置的 WebUI/ComfyUI 上游；模型推理能力由该上游提供。 |
| **1. 轻量入门档**<br>（千元独显 / 入门游戏本） | • **显卡**：**6GB ~ 8GB 显存**（如 GTX 1660S / RTX 2060 / 3050 / 4050）<br>• **内存**：16GB<br>• **磁盘**：预留 30GB (SSD) | • 从已安装的 SD/Anima 底模与受支持尺寸做单张测试；<br>• Ollama 模型需按量化、上下文和与绘图共存时的资源占用选择；<br>• 不以显存容量单独判断底模或分辨率可用。 |
| **2. 黄金推荐档**<br>（主流甜品卡 / 生产力） | • **显卡**：**10GB ~ 16GB 显存**（如 RTX 3060 12G / 4060Ti 16G / 4070 / 3080）<br>• **内存**：32GB<br>• **磁盘**：预留 60GB (SSD) | • Anima 放大、换装和 Krea 2 分别核对实际模型/节点能力；<br>• 宁宁/夏目 LoRA 与画师风格 LoRA 使用各自兼容组合；<br>• GPT-SoVITS、Live2D 与语音口型另需服务和设备验收，不由硬件档位自动开启。 |
| **3. 发烧叙事短片档**<br>（高端旗舰卡） | • **显卡**：**16GB ~ 24GB 显存**（如 RTX 3090 / 4090）<br>• **内存**：32GB ~ 64GB<br>• **磁盘**：预留 120GB+ (SSD) | • Wan 2.2 TI2V 与 MiniMax H3 需对应权重、ComfyUI 节点及状态检测；<br>• 视频长度、分辨率和多服务共存按真实负载验收；<br>• 批次出图与服务并发分开核对，不承诺并发时无显存溢出。 |

---

## 二、 模型应该放在哪里？（文件目录树）

以下列出 WD14 与 Anima 的文件位置；Krea 2、SD 和视频使用各自上游模型/节点，不由这棵目录树覆盖。放置后再检查实际服务状态：

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

> **提示：体检扫描与网关连接**
> `models:check` 体检脚本会扫描常见目录（`../AI/ComfyUI/models`、`D:/ComfyUI/models`、`C:/ComfyUI/models` 等）；自定义路径可用 `$env:COMFYUI_MODELS_ROOT = "你的ComfyUI路径/models"` 指定。
> 该变量控制体检扫描，不是网关的 ComfyUI 连接设置。网关通过 `COMFY_HOST` 或控制面板保存的 ComfyUI 地址连接上游；权重与节点由上游服务加载。

---

## 三、 公共模型资料与下载入口

以下保留既有模型资料与下载链接。版本、许可、访问条件及下载可用性以发布页面为准；配置完成后仍需核对所选模型与实际工作流匹配。

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
  - **站长主力机环境**：这两款 LoRA 为主力机专属资产，未公开发布；文件就绪后还需核对底模兼容性、触发词、参数和真实画面，不承诺像素级还原。
  - **无 LoRA 创作**：热门角色可使用服务端明确声明 `noLora` 的 Anima 底模；Krea 2 不接受角色 LoRA。宁宁/夏目的工作室 LoRA 路径有独立兼容校验，不因缺文件自动变成无 LoRA 模式。角色与蓝图数量统一见 [项目状态](../project-status.md)。

---

## 五、 一键环境体检工具

配置好或想要排查缺什么模型时，只需在项目根目录运行：

```powershell
npm run workflow -- models:check
```

控制台会读取硬件与文件信息，扫描 ComfyUI 和项目运行时目录。以下只展示报告格式；档位为脚本估算，“已就绪”表示相应文件检查通过，不表示节点、推理效果或设备组合已验收：
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
