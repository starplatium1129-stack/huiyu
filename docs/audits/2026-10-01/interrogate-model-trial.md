# 动漫图片反推模型试跑结果

2026-10-01 在本机完成 MOAT v2、SwinV2 v3、EVA02-Large v3 的真实 CPU 反推，以及 PixAI v1.0 的受控 GPU 试跑。用户要求优先保留 CPU，并允许 PixAI 临时额外显存约 4 GB。结果支持把 SwinV2 v3 作为下一步 CPU 默认候选；PixAI 本次显存增量低于预算，可以作为空闲时按需运行的候选。生产默认模型仍是 MOAT v2，本次没有切换配置或安装到桌面客户端。

## 方法与范围

- 硬件：Intel Core i5-12600KF、RTX 4070 Ti SUPER 16 GB。
- 输入：本机参考画册的 5 张 All 级真实 CG 原图，覆盖校服与窗边、浴衣烟花、偶像舞台、咖啡馆、火锅。三项 CPU 测试各执行两轮；PixAI 执行一轮。没有新增生图请求。
- CPU：真实 Rust 网关、ONNX Runtime CPU EP、448×448 输入、阈值 0.35。独立进程限制到逻辑处理器 0–3，并设置 BelowNormal 优先级；这不是将 ONNX 线程池设置为 4 线程。计时是已启动网关的 HTTP 请求；每项首张包含模型冷加载，温热耗时取其余 9 次的中位数，不含进程启动。
- PixAI：官方 1008×1008、单图、BF16 权重和输入、FP32 sigmoid。首次图片包含 GPU 首次使用开销；温热耗时取其余 4 张中位数，包含进程内读图、预处理、推理、CPU 回传与标签整理，不含 HTTP 或 UI，也不含 Python 导入和模型加载。
- PixAI 开始前要求 Comfy 队列空闲、足够可用显存及稳定基线；运行中监视队列和显存。Torch 分配预算为 3 GiB，设备显存增量守卫为 4 GiB；新生图入队时停止自有探针。没有卸载或停止生产 Comfy。

## 当次测量

CPU 数值反映上述资源限制下的运行结果，不能作为使用全部 CPU 核心时的速度承诺；GPU 与 CPU 行也不是同种计算资源的效率比较。

| 模型 | 权重文件 | 首张耗时 | 温热中位耗时 | 当次内存观察 |
| --- | ---: | ---: | ---: | --- |
| MOAT v2 | 326.20 MB | 8.38 s | 5.43 s | 整个隔离网关峰值工作集 1.16 GiB |
| SwinV2 v3 | 467.46 MB | 8.54 s | 4.66 s | 整个隔离网关峰值工作集 0.71 GiB |
| EVA02-Large v3 | 1.26 GB | 23.17 s | 18.13 s | 整个隔离网关峰值工作集 1.38 GiB |
| PixAI v1.0 | 1.95 GB | 0.353 s | 0.163 s | GPU 设备显存增量采样峰值 1.53 GiB；Torch reserved 峰值 1.30 GiB |

PixAI 设备显存基线最小值为 8408 MiB，采样峰值为 9972 MiB，差值 1564 MiB（约 1.64 GB）。采样循环 sleep 0.25 秒，实际间隔平均约 0.30 秒（0.285–0.326 秒）；这是观察到的峰值，不是连续硬件采样的绝对峰值。独立进程从启动到完成 5 图并退出共 6.866 秒，其中 CPU 权重加载 1.163 秒、移入 GPU 0.214 秒。退出后连续 5 次观察均为 8409 MiB，自有 Python PID 已退出，生产 Comfy 进程保留。

PixAI 复用已有 Torch 2.13.0+cu130、torchvision 0.28.0+cu130、Transformers 5.14.1，只把缺失的 timm 1.0.30 安装到独立候选目录；没有改写生产环境。模型加载无缺失、意外或不匹配参数。本次没有触发探针中的非持久 RoPE 缓存重建分支。

## 标签观察与选择建议

人工打开原图，核查 30 个明确可见要素：校服、窗户、浴衣、烟花、麦克风、手套、杯子、辫子、角、筷子、食物等。在统一 0.35 的输出中，三项 CPU 模型均命中 30 项，PixAI 命中 29 项。舞台图的 `standing` 分数约 0.348，统一 0.35 下未输出，但官方推荐 general 0.17 下已输出。这仅统计少量已知要素的覆盖，不计算多报标签，也不是准确率、precision 或 F1；相同数值阈值不代表不同模型的分数已经校准等价。

PixAI 能识别宁宁、有马加奈和雷电将军，并识别手持纸张、咖啡及拉花等细节；角色识别仍有错误。莱万汀图同时预测史尔特尔约 0.916 和莱万汀约 0.458；SwinV2 v3 也把宁宁图识别为伊蕾娜。CPU 人物阈值固定 0.85，PixAI 同时记录官方人物 0.27 与统一 0.35，不能按人物输出数量排名。角色名与外貌仍需独立隔离，不能用推断角色自动覆盖当前创作对象。

建议先选择 SwinV2 v3 进行 CPU 产品接入，EVA02-Large v3 保留为对比候选。PixAI 可以考虑仅在未生图时单张按需加载、完成后退出释放；本次没有证明它与生图并发时不会影响性能，也没有验证 BF16 与 FP32 的完整精度等价。小样本不足以声明任何模型全面优于现有模型。

## 权重身份与复核材料

所有候选权重下载到独立目录，固定官方 revision，并核对精确字节数和 SHA-256。CPU 两个 v3 模型使用同一份官方 CSV，308468 字节，SHA-256 为 `298633d94d0031d2081c0893f29c82eab7f0df00b08483ba8f29d1e979441217`。

| 模型 | 官方 revision | 权重 SHA-256 |
| --- | --- | --- |
| [SwinV2 v3](https://huggingface.co/SmilingWolf/wd-swinv2-tagger-v3) | `627aef95638667ddcaa3ac8ae625e88ea5b02f51` | `e6774bff34d43bd49f75a47db4ef217dce701c9847b546523eb85ff6dbba1db1` |
| [EVA02-Large v3](https://huggingface.co/SmilingWolf/wd-eva02-large-tagger-v3) | `b25b82a03f7282e41aa2f257a52c7583b710bd1c` | `9e768793060c7939b277ccb382783e8670e8a042d29d77aa736be0c8cc898bfc` |
| [PixAI v1.0](https://huggingface.co/pixai-labs/pixai-tagger-v1.0) | `9fe10addf9326e292da8a85a98ea74cd91b41771` | `f29e475205cbcbc25b52a075840c7809d6215be15f45375113ba09c49bf90292` |

CPU 测试使用现有 Rust EXE，SHA-256 为 `5e39c6c622c354f7dff3ba783052fa62e729f05db954a4eb3e31a6d0ce829a9c`。该 EXE 仍有此前的 12 MiB HTTP 上限，样本均低于此值；本次推理模块与当前源码一致，不把模型试跑当作 20 MB 新安装版验收。

原始采样、标签、图片和日志留在被忽略的 `runtime/`，不入 Git：

- CPU：`runtime/interrogate-model-trial-20261001/cpu-results.json`、`manual-spot-check.json`、`runs/*/process-samples.json`。
- PixAI：`runtime/interrogate-candidates/pixai-v1-20261001/summary.json`、`artifacts-manifest.json`、`trial-manifest.json`、`attempt-03/inference.json`、`guard.json`、`gpu-samples.jsonl`、`process-exit-audit.json`。
- 5 张样本的路径与 SHA-256 记录在 CPU 目录的 `samples.json`。原始脚本仅用于本轮试跑，位于被忽略的 `scripts/archive/` 或候选运行目录，不注册为普通无副作用测试。

## 主线接入与常驻验证

用户随后明确选择 PixAI 替代默认反推，并要求加载后保持 GPU 常驻，不在反推结束或开始生图时自动卸载。主线现通过 Rust 管理独立 Python JSONL worker，默认 general 阈值 0.17、人物阈值 0.27，保留 20 MiB 输入与本机边界；没有旧 WD、Comfy 或演示标签的隐式回退。取消活跃推理、协议故障、超时或网关关闭会终止并等待自有进程退出；正常成功复用同一模型。

本机 `AI/PixAI/runtime-config.json` 已准备。新构建 Rust HTTP 主链对宁宁、雷电将军与莱万汀样张调用成功：首个请求 6.533 秒，后续 0.168、0.184 秒；每次完成后 status 的 `cached` 与 `gpuResident` 都为 true。这是包含 HTTP 的请求时间，与前面的进程内 PixAI 试跑区分。子网关退出后没有自有 worker 进程残留；不把桌面全卡显存波动解释为该模型的泄漏或绝对峰值。

原始结果位于 `runtime/pixai-integration-20261001/report.json`。常驻进程生命周期定向 5 项、HTTP 本机/默认引擎/20 MiB 边界 3 项、Python worker 9 项及前端适配、原画册逻辑的定向检查通过；桌面暂存检查确认打包 worker 与固定 manifest，不打包测试、模型权重或原 Python 环境。此处记录源码和真实网关接入，不声明已安装桌面客户端同步完成。
