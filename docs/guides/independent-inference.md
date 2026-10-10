# 独立图像推理候选接入

这是迁移中的可评审切片，不是已完成的 ComfyUI 替代发行。默认引擎仍为既有 ComfyUI；显式选择 native 后不自动回退，以免参数或结果在用户不知情时改变。

## 第一里程碑与边界

- 使用官方 Apache-2.0 Diffusers Anima 组件，独立 Python 子进程运行，不导入或启动 ComfyUI。
- 已接入本地完整 Diffusers 目录的文生图、图生图、实验性手绘遮罩局部重绘及本地兼容 LoRA，沿用绘遇的任务身份、进度、取消与结果协议。
- 模型目录默认按现有 catalog 的 modelId 组织在 `AI_WORKSPACE_ROOT/inference/models/<modelId>/`；控制室中可配置模型根目录与独立 LoRA 根目录。目录必须包含该权重对应的配置、tokenizer、文本编码器、conditioner、transformer 与 VAE。
- 现有裸 MiaoMiao / Anima safetensors 文件不能简单重命名为完整目录；对应结构与配套资源必须先通过转换器的精确核验；实际出图仍需核验。不同 MiaoMiao 架构不能仅靠名字认定兼容。
- TeaCache 已有默认关闭、须本机校准并显式验收的实验性路径，详见下文；Remacri/RealESRGAN、RCAS、Krea 2、SDXL 尚未接入；请求未接入的能力应明确失败。已支持的 LoRA 格式为原生 Diffusers/PEFT A/B 及官方识别的 `diffusion_model.*` A/B（含 llm_adapter）；通用 Kohya down/up/alpha、DoRA 和未知格式明确拒绝。实际角色权重兼容性仍需加载验收。

## 独立运行库准备

准备器不会下载依赖或模型。需要一个已有受信 Python 和针对目标操作系统、Python 版本、CUDA/驱动选择准备好的本地 wheelhouse。运行库由绘遇的独立目录持有，不复用 ComfyUI 环境。

源码目录或安装包 gateway 目录中执行：

```text
python scripts/maintenance/prepare-inference.py --target-dir <AI工作区>/inference --plan
python scripts/maintenance/prepare-inference.py --target-dir <AI工作区>/inference --preflight --wheelhouse <可信离线wheel目录>
python scripts/maintenance/prepare-inference.py --target-dir <AI工作区>/inference --apply --wheelhouse <可信离线wheel目录>
python scripts/maintenance/prepare-inference.py --target-dir <AI工作区>/inference --check
```

源码维护也可通过 `npm run wf -- models:prepare-inference ...` 调用。默认仅预览；只有 `--apply` 安装到新的独立 venv，已有/部分安装拒绝覆盖。失败后先保留目录与错误，选择新的空目标或人工核对后清理，不自动删除已有环境。`--check` 和安装完成检查都调用已打包 worker 的 `--diagnose`，核对完整依赖导入、蒙版/CLIPSeg helper 和 CUDA 可见性，不加载模型、不出图。只有完整诊断成功才生成运行库回执。

`--preflight` 使用当前受信 Python 自带的 pip 做离线 `--dry-run --ignore-installed`：解析全部依赖而不借用当前已装包，缺轮子/平台不兼容会在创建 venv 前报错。它需要支持 `--dry-run` 的已有 pip，不自动升级。`--apply` 总会先执行同样预检。工具仅读本地 wheel 元数据并拒绝 URL 依赖，只把已检查的 `.whl` 文件交给 `--no-index --only-binary=:all: --no-cache-dir`，不跟随目录内 HTML 或使用源码安装包。预检通过不证明真实包可导入或 GPU 可运行。pip 行为参见[官方 install 文档](https://pip.pypa.io/en/stable/cli/pip_install/)。

`runtime-config.json` 保存解释器、worker 路径及依赖回执。移动安装根后应重新准备新目录或显式设置 worker 路径；旧回执不被默默改写。构建/测试不会调用安装步骤。桌面包带 worker、依赖清单与准备器；控制室提供显式离线准备入口，但仍需已有可信 Python 与配套 wheelhouse，尚未提供完整的签名 Python/CUDA wheel 发行材料。不能称“新机安装后放一个权重即可生成”。

## 应用内离线准备与完整目录导入

控制室独立引擎区域提供两个明确操作：

- 离线准备：填写当前 AI 工作区、已有可信 Python 可执行文件和本地 wheelhouse，确认后调用固定随包准备器。目标固定为该工作区的 inference 目录；既有或部分 venv 拒绝覆盖。沿用操作状态、互斥与取消，不把请求超时当作后台任务已停止。完成不会切换引擎；通过“填入设置”后再保存并重启。
- 完整模型目录：选择既有 Anima catalog 的模型 ID，指定完整 Diffusers 来源目录，先只读检查并显示复制目标，再明确导入至已保存模型根目录/modelId。只复制，不移动源、不覆盖目标。布局证据不证明权重架构、实际加载或出图。原始 safetensors 单文件仍需下节严格转换。

维护入口 `python -I scripts/maintenance/import-anima-directory.py --source-dir <完整本地目录> --target-dir <全新模型根/modelId>` 默认只读计划，追加 `--apply` 明确复制。统一入口 `npm run wf -- models:import-anima-directory ...` 参数相同。拒绝符号链接、路径重叠和已有目标；失败/取消不把未完成目录发布成可用模型。没有隐式下载、安装或 GPU 生成。

## 现有单文件检查

无需安装 ML 包即可先检查本地文件：

```text
python scripts/maintenance/inspect-anima-checkpoint.py --checkpoint <现有Anima或MiaoMiao.safetensors>
```

可用 `--transformer-config`、`--text-encoder`、`--vae`、`--qwen-tokenizer`、`--t5-tokenizer`、`--diffusers-source`、`--output-dir` 指定已有配套材料。`npm run wf -- models:inspect-anima ...` 为同一入口。

脚本只读取每个 safetensors 的有界 JSON 头，不加载张量，不联网，不写转换结果。输出实际层数/宽度/conditioning 结构与缺失配套。官方 Diffusers 0.41.0 `convert_anima_to_diffusers.py` 固定使用 Cosmos 2B 配置（28 层、宽度 2048）；不匹配的 MiaoMiao 变体明确阻塞，不能只更名或盲用基座配置。1.2/1.6 是仓库中的版本标签，不推断为参数规模。

即使结构匹配，只读检查报告的 `readyForInference` 仍为 false。现在提供下面这个架构严格限定的离线转换入口；未知形状不尝试推断，不执行官方脚本中的联网配套获取。

### 经架构核验的离线转换

用已准备的独立运行库 Python 执行（不要使用系统 Python 临时安装大包）：

```text
python -I scripts/maintenance/convert-anima-checkpoint.py --profile anima-cosmos2b-v041 --checkpoint <原始Anima.safetensors> --transformer-config <对应config.json> --text-encoder <原始Qwen3-0.6B.safetensors> --vae <原始QwenImageVAE.safetensors> --qwen-tokenizer <本地目录> --t5-tokenizer <本地目录> --output-dir <模型根目录/已选modelId>
```

默认仅读有界 safetensors 文件头和本地配置，不读张量载荷、不写输出；加 `--check` 会利用已安装库建立 meta 模型，逐个检查完整键名/形状与 tokenizer 配套，不加载权重；只有显式 `--apply` 才在 CPU 读取并转换张量。维护入口 `npm run wf -- models:convert-anima ...` 参数相同。输出必须不存在、父目录已存在且与输入资源分离。

目前唯一 profile 固定为 Diffusers 0.41.0 官方 Anima/Cosmos2B 的 28 层、2048 宽 transformer、6 层 conditioner、Qwen3-0.6B 与 Qwen Image VAE 配套。每个张量键和形状必须匹配，未知/多余键、量化/自定义代码配置与其他 MiaoMiao 变体会被拒绝，不静默舍弃张量或猜配置。映射源为官方 Apache-2.0 转换器，随包提供适用许可证；模型和 tokenizer 许可仍需另计。

转换先在独立临时目录保存 safetensors 分片与各组件，复核保存后的键/形状/dtype和 tokenizer token ID，再校验 worker 所需布局。全新输出目录独占创建，最后发布 model_index.json；不覆盖旧模型或改写输入。失败的未完成发布目录保留供检查，不能当可用模型。大权重转换的 CPU 内存、磁盘与耗时尚未实测，请事先留足空间。

六项无 ML 环境测试只使用显式模拟库与合成文件头，证明对应协议/拒绝/发布行为；未对实际 Anima/MiaoMiao 权重执行转换或出图。即使转换完成，报告仍为 `readyForInference: false`，必须做完整加载和实际设备验收，不能把形状匹配当成权重语义/画质保证。

## 开启候选引擎

在本机控制室打开“绘图引擎设置”，选择独立引擎并填写模型根目录、LoRA 目录、Python 和 Worker 的绝对路径。保存到运行目录 config.json 的 inference 配置；界面区分当前运行与已保存设置，重启运行时后生效。在途任务使用冻结的旧设置，不会半途切换。

“检查配置与文件”只检查已保存路径；“检查当前运行时依赖与设备”显式调用 Worker 的 `--diagnose`，检查当前解释器内依赖与 CUDA 可见性，不加载模型、不生成图片、不安装软件。CUDA 可见不等于显存足够或实际出图成功。设置与诊断 API 继承既有本机控制面的 Host/Origin、直接 loopback 与代理头限制，不开放给远程控制请求。

生成界面遵循 native 的 TeaCache=false 默认；缺少已验收校准档时不能开启缓存；恢复出的旧 Comfy 阈值需明确清除，改用本地校准档阈值。图像编辑支持实验性手绘遮罩，或明确选择“整图重绘”（脸部和背景也会变化）；不会把既有遮罩换装请求静默转成整图重绘。手绘路径将同一有效遮罩用于逐步潜空间约束和最终原图合成，遮罩外使用与初始采样相同的噪声恢复到下一步 sigma，最后一步恢复干净原图潜变量。它不是只在整图生成后贴图，但未经 GPU 验收，也不宣称与 ComfyUI 采样器/膨胀边界等价。自动识别使用额外的本地 CLIPSeg 配套，缺失时只禁用自动模式。上传素材在独立 inference/input 中保留所有者与原始字节，排队后读取已接受的不可变副本；LoRA 只从 catalog 白名单和配置目录解析。

开发覆盖仍可使用 `HUIYU_IMAGE_ENGINE`、`HUIYU_INFERENCE_PYTHON`、`HUIYU_INFERENCE_WORKER`、`HUIYU_INFERENCE_MODELS_ROOT` 与 `HUIYU_INFERENCE_LORAS_ROOT`。界面显示覆盖来源并拒绝保存冲突值；不要指向未验证脚本。独立路径找不到运行库、模型或不支持请求时返回明确错误，不借用 ComfyUI。

## 实验性自动遮罩

在配置的模型根目录下放置 `clipseg-rd64-refined/`，需完整的 `config.json`、`preprocessor_config.json`、`tokenizer_config.json`、`special_tokens_map.json`、`vocab.json`、`merges.txt` 和 `model.safetensors`。不接受只有 pickle/bin 权重的目录，也不会代为下载或转换它。状态只检查文件存在、非空与目录边界；实际结构、完整加载与分割质量仍在执行时验证。

自动模式将 `|` 分隔的区域词分别送入 CPU float32 CLIPSeg，合并结果、调整尺寸并按阈值二值化，然后复用手绘模式的遮罩膨胀、逐步潜空间约束与像素合成。CPU 分割在 Anima 加载前结束，不额外占用 GPU。驻留 Worker 可保留一个完整 CPU CLIPSeg 模型／tokenizer／processor 和一个 352×352 float32 logits（495,616 字节）；模型 RAM 与 Anima 驻留重叠，不保证低内存。每任务完整哈希本地所有模型资产，包括可选 tokenizer 文件，加载后再次核验；相同像素／尺寸／词组才复用 logits，阈值和膨胀仍每次处理，失败及退出清空。真实 CPU 耗时、RAM 和遮罩画质仍待设备验收。这里的边缘处理不宣称与旧 ComfyUI 节点 smooth/blur 参数等价。手绘与自动请求互斥，不会静默替换；原有整图模式保留。

Transformers 实现许可证为 Apache-2.0；CLIPSeg 权重许可独立于代码许可，本次未下载或分发权重，尚未核实所选权重的发行许可。用户需使用有权使用且已准备的可信本地 safetensors 配套。

## 验收分层

1. 无 GPU 的 Python 参数/协议测试与 Rust 源码审查，只证明相应逻辑。
2. 云端已用与 CI 一致的 Rust 1.98.1 minimal 和 locked Cargo 完成 Linux 编译；native 定向测试 21 项通过，另有 1 项无关 libvips 设备测试按既有条件忽略，设置持久化定向测试 1 项通过。均为协议/隔离夹具，不是实际模型或 Windows 验收。
3. 主力设备：先退出 ComfyUI，确认端口关闭；只启用 native，选已准备的模型执行一张文生图；检查进度、取消后显存释放、重新提交、结果入册和重启恢复。
4. 每种 Anima/MiaoMiao 权重分别验收；记录模型哈希、配置来源、依赖版本、种子、耗时、显存和成图。不得用一种权重的成功替代所有家族兼容结论。

依赖代码许可证与权重/模型卡许可分别核对。未搬运 ComfyUI 的 GPL 实现；使用官方开放库仍需随运行包保留适用许可证和通知。


## TeaCache 本机校准与验收

独立 Anima/Cosmos 路径已实现首层 norm1 代理与整个 transformer block 栈残差复用，实际跳过 attention/MLP；模型外层预处理与输出层仍运行。按 CFG 分支独立缓存，每任务新建缓存控制器；受控 Worker 串行复用已加载权重，实际首尾采样步全算，连续跳步有上限，条件、形状、设备或时间序列变化清理缓存，异常恢复原调用。图生图及手绘/CLIPSeg 遮罩继续执行原逐步约束与最终合成，不把缓存当换装算法。

实现针对固定 Diffusers 0.41.0 的标准 Anima/Cosmos 结构；不能推及所有 MiaoMiao 版本。没有内置借用的拟合系数，也没有实机速度/画质结论。官方 TeaCache 的 Apache-2.0 许可随包保留；其 Cosmos 示例不是 Anima 校准证据，权重许可另计。

使用已经准备好的独立运行库 Python。准备至少一份校准任务 JSON 与一份验证任务 JSON，结构与 worker 任务相同（modelDir、outputPath、input 等见 tools/inference/README.md），均关闭 TeaCache。验证提示词与种子必须未用于校准；模型、LoRA、尺寸、步数、CFG、编辑模式/强度和遮罩参数必须一致。允许不同原图与手绘遮罩。工具会把输出重定位到全新的结果目录，不覆盖任务原输出。

```text
python -I scripts/maintenance/calibrate-anima-teacache.py --calibration-job train.json --validation-job heldout.json --output-dir <全新结果目录> --threshold 0.05 --repeats 2 --strategy phase-envelope
```

默认只读计划，不加载 ML、不出图、不写文件。可重复指定两类 job。阈值 0.05 仅是候选输入，不是已验证推荐值。确认任务和运行次数后，追加 `--run` 才在本机 CUDA 执行全计算轨迹采集、新拟合以及每个留出案例的无缓存/缓存对照；`--timeout` 限制每个进程等待。统一维护入口为 `npm run wf -- models:calibrate-anima-teacache ...`，需确保该入口的 Python 是已准备运行库。

打开结果目录 review.html，逐对查看人物一致性、构图、纹理、局部编辑区域和边界。像素误差不是语义画质评分，整图指标也可能掩盖小区域退化。报告分别记录完整进程耗时、模型加载、管线时间和显存分配峰值；管线时间包含编码/采样/解码，不称纯采样耗时。无缓存进程不执行缓存哈希或代理，缓存进程的完整模型指纹开销计入端到端耗时；维护身份核对在计时外，可能预热文件缓存。跳过 block 数不等于实际提速。

仅在亲自检查画质与耗时后执行：

```text
python -I scripts/maintenance/calibrate-anima-teacache.py --accept-run <结果目录> --accept-quality --accept-performance
```

验收入口再次核对资产、源图片/遮罩和报告输出，要求每个留出缓存任务确有有限数值跳步，重新计算端到端中位数比且确实快于基线，才写入所选模型目录 teacache-profile.json。已有档不会自动覆盖；明确替换需提供其 `--replace-profile-sha256`。验收后也不会自动开启 UI 开关。

校准档严格绑定模型各组件文件字节、LoRA 与强度、尺寸、步数、CFG、dtype/设备、图生图强度、手绘/自动遮罩及其参数与 CLIPSeg 资源。改变这些条件需重新校准；每个启用任务验证完整指纹，成本必须纳入实际收益判断。界面看到校准文件只表示文件存在，最终由 worker 验证身份与验收记录，不代表设备已经通过验收。当前云端仅完成模拟张量/协议及 UI 测试，未采集真实系数、未安装校准档、未运行 GPU 出图。

## 模型驻留与分阶段缓存候选

独立引擎以 `--serve` 串行执行任务，复用一份模型／LoRA 权重，连续任务无需重新启动 Python 或重新搬入同一份权重。每任务仍核对完整文件指纹；新加载后再核对一次，基座字节变化会重载；普通 LoRA 字节／顺序变化时先完整卸载 transformer 和 text_conditioner 的适配器，再加载新组，保留基座。可能改写基座的初始化或未核实变体仍整组重载；同组仅变强度直接更新权重。每次创建新的管线块、调度器、CFG 与 TeaCache 状态，不保留 seed 或中间潜变量；文本编码使用下述有界 CPU 缓存。成功任务的 `result` 后必须收到同身份 `ready`，才允许接收下一任务；取消、错误、超时和退出终止所属 Worker，确认停止前不放行 GPU 队列。空闲 120 秒释放进程与模型。

校准默认采用 `phase-envelope`：按实际采样进度分为三个阶段，保留各阶段观测到的变化峰值；超出观测范围或跨阶段时全算刷新。每阶段至少三个有效配对样本及两种代理变化；最多 32 个保守边界压缩数据，避免一个全局多项式平滑掉局部峰值。它仍是经验性误差估计，不能保证人物、纹理或换装边缘的画质。原 `--strategy polynomial` 可作算法对照，已有 v1 档仍按原策略执行。两种策略都默认关闭并要求人工验收。

校准与留出对照默认复用同一份已加载权重，双方须有 `modelReused=true` 证据；`--no-resident` 可另测冷任务。进程创建开销单列，Python 导入与首次模型加载计入首个训练任务；暖任务总耗时包含指纹、编码、采样、解码和写图；每任务重置 CUDA 分配峰值。两种模式不能混为同一速度结论。当前仅有隔离逻辑与协议验证，RTX 4070 Ti SUPER 的独立运行库、真实权重、速度、显存和成图仍待设备验收。

## 办公机完成的准备与文本缓存

驻留 Worker 仅在首次任务核对依赖并加载辅助模块，后续复用已验证的运行代码；单独诊断仍重新检查，更新运行库或脚本后需重启。模型文件每任务仍做完整 SHA-256 字节核验，读取改用标准流式缓冲以减少 Python 分配峰值，未改为按文件名／时间复用。

相同文本换 seed 的任务复用 Qwen 编码与 T5 token／mask，CPU 缓存最多 4 项、16 MiB；按文本、负面词、序列上限、CFG 分支、dtype 和设备区分，重载／释放模型时清空，任务获取独立张量副本。LoRA 仅作用于 transformer／text_conditioner，后者每任务仍运行，因此强度回切可复用基座和原始文本编码。基座字节改变仍重载；普通适配器换组完整卸载再加载，可能改写基座的变体退出时保守重载。

结果事件记录文本缓存命中、未命中与保留字节数。TeaCache 速度对照双方明确关闭文本缓存和 CLIPSeg 模型／结果缓存，运行与验收均要求明确的禁用证据，避免第一侧未命中造成比较偏差。旧测量报告缺新 mask 缓存证据时不能用于新的验收；已安装的已验收 profile 不改写。主力机保留真实权重加载、GPU 耗时／显存、画质和取消释放验收；办公机的模拟模型及小组件验证不替代这些结果。

办公机已用隔离 Python 3.11 与全部锁定版本（Torch 2.8.0+cpu、Diffusers 0.41.0、Transformers 5.10.1、PEFT 0.19.0 等）执行真实 CPU 小组件：随机 Qwen／Cosmos／text_conditioner／VAE、当地构造的 tokenizer，确认缓存编码与原始编码一致、两个 LoRA 组件强度回切恢复相同输出、新调度器与文本释放，以及两次完整 64×64 小管线文本复用。它只产出随机小组件噪声，未加载真实 Anima/MiaoMiao 权重，不作为画质或 GPU 速度证据。安装只在被忽略的 runtime/office-anima-cpu/ 中，不改系统 Python、ComfyUI 或产品 CUDA 准备契约；首次 CDN 下载不完整且哈希失败，改用经响应核对的官方主域名后保留原 SHA-256 核验并成功安装。

本机证据位于 runtime/office-inference-20261010/：cpu-smoke/report.json 与 hash-benchmark.json。32 MiB 合成文件、暖文件缓存、每方案两次交替读取中，SHA-256 相同；流式读取的 Python 分配峰值从约 16.0 MiB 降至 0.26 MiB，耗时中位数约 37.4 ms／30.0 ms。这是该读取样本，不能推广为模型加载或出图增益。源码、夹具输出与其范围分别记录；实际权重与 GPU 最终验收仍保留。
