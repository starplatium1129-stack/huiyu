# 新模型原生接入工作流

规范图像与视频新模型接入绘遇原生推理引擎的分流决策、合规边界、代码接入点与验收清单。日常用户配置见 [独立推理指南](../independent-inference.md)，任务与资源契约见 [工程契约](../../engineering-contracts.md) 与 [持久任务规范](../../architecture/TASK-RUNTIME-DESIGN.md)。

---

## 1. 阶段 0：准入评估与通道分流

接到新模型需求后，按下面 4 条通道**自上而下匹配**，优先走最轻量且能落地的路径：

| 优先级 | 适用情况 | 采用通道 | 典型工作量 | 现有参考实现 |
| --- | --- | --- | --- | --- |
| **通道 1：同架构单文件换皮** | 属于已有架构的新微调/衍生权重（如 Anima 28L / 40L / RoPE） | 复用既有 CPU 转换 Profile 与 `worker.py` | 补目录配置 + SHA-256 校验 | [anima_conversion_profile.py](../../../tools/inference/anima_conversion_profile.py) |
| **通道 2：`sd-cpp` / GGUF 轻量通道** | `stable-diffusion.cpp` 已支持，定位为低显存快速出图或编辑 | `runner: "sd-cpp"` 直接跑 GGUF | 登记资产哈希 + 接入 `keyframe_sd.py` | [adapter-models.json](../../../tools/inference/adapter-models.json)、[keyframe_sd.py](../../../tools/inference/keyframe_sd.py) |
| **通道 3：Diffusers / 官方独立管线** | 官方已合入 Diffusers，或提供 Apache-2.0 / MIT 独立 `pipeline_*.py` | 接入 `adapter_worker.py` 托管流水线 | 编写薄适配器 + 按需补 CPU 导入脚本 | [krea_adapter.py](../../../tools/inference/krea_adapter.py)、[moss_pipeline.py](../../../tools/inference/moss_pipeline.py)、[moss_adapter.py](../../../tools/inference/moss_adapter.py) |
| **通道 4：ComfyUI 先行验证** | 刚发布、上游生态未稳，或仅需评估画质与产品价值 | 先走已有 ComfyUI 引擎入口试跑 | 零原生推理代码；确认长期主推再升通道 2/3 | [workflow.rs](../../../runtime-rs/src/images/workflow.rs) |

### 生态借用与许可红线

- **严禁拷贝 ComfyUI（GPL-3.0）本体源码**：原生层只引入 **Apache-2.0 / MIT / BSD** 代码（官方仓库、Diffusers、InvokeAI 等），并保留对应许可文件与头部来源声明（参考 [moss_pipeline.py](../../../tools/inference/moss_pipeline.py)、[anima_regions.py](../../../tools/inference/anima_regions.py)、[anima_lllite.py](../../../tools/inference/anima_lllite.py)）。
- **允许并鼓励借用的生态资产**：
  1. **权重文件直接复用**：通过纯 CPU 导入/硬链接脚本直接读取 Comfy-Org 发布的拆分或量化权重，不重复下载（参考 [import_wan.py](../../../tools/inference/import_wan.py)、[krea_transport.py](../../../tools/inference/krea_transport.py)）。
  2. **独立算子包按需调用**：如量化内核需要独立发布的 `comfy-kitchen`，可在支持设备上按需调用，同时保留标准 PyTorch 回退路径（参考 [moss_int8.py](../../../tools/inference/moss_int8.py)）。
  3. **数学规格与排坑参数对照**：可对照上游官方仓库、Diffusers PR 与 ComfyUI PR 核对采样 `shift`、CFG、VAE 缩放、文本隐藏层与键名映射，再在原生层干净实现。

---

## 2. 阶段 1：规格卡冻结

写代码前，必须先从官方一手来源核齐以下 5 项规格（严禁拍脑袋套用其他模型参数）：

1. **来源与许可**：上游仓库 commit SHA、模型权重许可证、是否需要 HuggingFace 门控或登录手动下载。
2. **组件拓扑与复用**：Text Encoder / Tokenizer / Transformer / VAE / Vocoder 列表，明确哪些组件可与现有模型共享或同卷硬链接。
3. **权重与量化策略**：官方 Diffusers 分片、单文件 checkpoint 或量化文件（FP8 / INT8 / GGUF）；明确哪些敏感层必须保持 FP32/BF16。
4. **数学与采样默认配方**：
   - 采样器、Scheduler、`shift` 值、默认步数、CFG 范围（是否支持负向提示词）；
   - 画幅推荐列表、宽高对齐倍数（16 / 32 / 64）与分辨率上下限；
   - 文本编码规则（最大 token、提示词方言、参考图数量或音视频驱动上限）。
5. **运行库与显存边界**：现有 `requirements-adapters.txt` / `requirements.txt` 锁定版本是否满足；是否需要升级 Diffusers 锁定 commit 或拆分独立环境；默认 `resident` 还是 `offload`。

---

## 3. 阶段 2：权重导入与纯 CPU 校验（单文件 / 量化模型）

若权重不是开箱即用的标准 Diffusers 目录，先落地独立导入/转换脚本（参考 [anima_conversion.py](../../../tools/inference/anima_conversion.py)、[import_wan.py](../../../tools/inference/import_wan.py)、[import_h3.py](../../../tools/inference/import_h3.py)）：

- **预览优先**：默认仅输出校验与转换计划，显式传入 `--apply` 才写入磁盘。
- **零 GPU 严格核验**：仅在 CPU 读取 safetensors header，核对所有 key、shape、dtype、文件字节数与完整 SHA-256；出现缺失键、多余键或形状不匹配立即报错中止。
- **同卷复用与凭据**：支持复用的原文件优先同卷硬链接并写入 JSON receipt（记录路径、字节数与 SHA-256），不依赖 `mtime`/文件大小捷径。

---

## 4. 阶段 3：原生推理层接入（`tools/inference/`）

复用已有 Worker 协议和显存底座。接入前先核对[公共推理底座](../../../tools/inference/README.md#shared-primitives)和[模型家族目录与桌面打包约定](../../../tools/inference/README.md#model-family-directories-and-desktop-packaging)。

1. **登记白名单与能力清单**：
   - 在 [adapter-models.json](../../../tools/inference/adapter-models.json) 登记 `pipelines` 组件白名单（精确到 `[包名, 类名]`，拒绝 `trust_remote_code` 和隐式联网下载）以及 `models.<modelId>` 参数边界。
2. **实现薄适配器模块**：
   - 只负责组件加载、offload 策略挂载、前向输入组装与结果原子写出；
   - 复用 [resident_adapters.py](../../../tools/inference/resident_adapters.py) / [locked_identity.py](../../../tools/inference/locked_identity.py)（资产租约与常驻复用）、[native_memory.py](../../../tools/inference/native_memory.py) / [mapped_residency.py](../../../tools/inference/mapped_residency.py)（显存预算与分层驻留）；
   - 每步采样回调发 `progress` 并轮询取消标记，取消后确保清理临时张量并依次吐出 `cancelled` → `ready`；输出前执行有限值检查（防 NaN/Inf）。
3. **补齐离线诊断**：确保 `python -I -B tools/inference/adapter_worker.py --diagnose --model-id <modelId>`（Anima 系为 `worker.py --diagnose`）能准确回报依赖版本、算子后端与设备支持状态。

---

## 5. 阶段 4：Rust 网关、下载清单与前端闭环

1. **受管下载与镜像清单**（每个受管文件必须附精确 `bytes` 与 `sha256`）：
   - Anima 系：[runtime-rs/src/images/catalog.json](../../../runtime-rs/src/images/catalog.json) 与 [setup-models.json](../../../runtime-rs/src/control/setup-models.json)；
   - Adapter 图像/视频系：[managed-adapter-models.json](../../../tools/inference/managed-adapter-models.json) 与 [managed-model-mirrors.json](../../../tools/inference/managed-model-mirrors.json)；
   - 视频目录：[runtime-rs/src/video/catalog.json](../../../runtime-rs/src/video/catalog.json)。
2. **Rust 后端与持久任务接入**：
   - 在 `runtime-rs/src/images/`、`runtime-rs/src/video/` 与 `runtime-rs/src/control/native_setup/` 补齐参数边界校验、准备流程与状态探测；
   - 接入统一显存准入锁与交接（出图前停本地 `llama.cpp`/语音，空载自动释放），以及远端绘遇互联的模型发现与转发白名单（如适用）。
3. **提示词编译与 UI**：
   - 核对所属提示词方言并同步编译规则（图像见 [studio-prompt-craft](../../../.agents/skills/studio-prompt-craft/SKILL.md)，视频见 [video-prompt-craft](../../../.agents/skills/video-prompt-craft/SKILL.md)）；坚持全分级自由创作，不加多余内容过滤；
   - 前端仅暴露该模型真实支持的参数控件，不支持的选项显式隐藏或禁用，避免静默忽略。

---

## 6. 阶段 5：验证门禁与文档收尾

按项目规范**不编写、不运行自动化测试**（门禁规则见 [工作流手册](../../workflow.md#门禁与构建)），通过静态核验 + 真机最小闭环完成交付，并如实区分“代码/构建已过”与“待设备实测”：

### 静态与构建核验
- 模型清单与跨层引用校验：`npm run wf -- models:check`
- 类型检查：`npm run typecheck`
- Rust 编译检查：`cargo check`（在 `runtime-rs/` 执行）
- Python 离线诊断：`python -I -B tools/inference/adapter_worker.py --diagnose --model-id <modelId>`
- 文档链接检查：`npm run wf -- docs:check`

### 真机最小闭环验收（临时产物放 `runtime/`）
- **冷启动出图**：记录首次加载耗时、峰值显存，核验无 NaN、黑图、裁切或比例畸变。
- **连续二次出图**：验证常驻权重或编码缓存命中，显存无持续泄漏。
- **中途取消恢复**：采样中途取消，确认 Worker 干净回到 `ready` 且后续任务正常完成。
- **跨模块显存交接**：出图完成后切换本地对话或语音，确认显存自动让出不 OOM。
- **画质基准对标**：同种子、同提示词对比官方参考实现或 ComfyUI 基准图，核对构图、色彩与细节一致性。

### 文档同步
- 更新 [独立推理指南](../independent-inference.md) 中的模型支持表、导入命令与硬件注意事项；
- 在 [项目状态](../../project-status.md) 如实登记已验硬件或“待主力机/目标设备验证”状态。
