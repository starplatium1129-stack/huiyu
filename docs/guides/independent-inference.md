# 独立 Anima 图像推理接入

绘遇现有 Anima 主流程已接入独立后端并完成本机实测，可在控制室显式选择 native 使用。默认引擎仍为既有 ComfyUI；选择 native 后不自动回退。本机桌面安装已启用独立引擎。当前日常替代范围为六个已登记 Anima 模型；其他模型家族、视频及任意 Comfy 节点不在此范围。

本轮已完成六个登记 Anima 模型的真实 GPU 加载与 11 张出图：五个 28 层模型各验证宁宁、夏目，40 层 MiaoMiao 2.9B 验证无 LoRA。Latent 2×、手绘蒙版 Latent 2×、Remacri 2×、自动蒙版 Remacri 2× 均产出 1664×2432，已测遮罩黑区与最终尺寸的原图完全一致。Endfield 第三个 LoRA 另完成 Laevatain 一张完整 API 出图。证据范围、完整 API 对照及限制见[本轮 Anima 替代报告](../audits/2026-10-11/native-anima-replacement.html)。这不表示每个模型都已跑遍每种编辑组合或全部 Endfield 角色。

圆括号权重与高清 TeaCache 的独立校准契约已接入。普通提示词 PNG 与权重 helper 接入前的对照 SHA256 完全一致；加权提示词已真实 GPU 出图。普通单轮校准档不能用于高清或加权范围。宁宁/夏目 normal + RCAS 0.75、阈值 0.25、连续跳步上限 3 的角色档已接受：双方各 12 个完整 API 热任务中位数为 native 4.419 秒、ComfyUI + TeaCache 5.686 秒，耗时减少 22.3%，12 对均更快。范围限于 MiaoMiao 1.6、832×1216、24 步、CFG 4、LoRA 0.8 与本机配置。TeaCache 默认自动开启，精确匹配已接受档案才使用缓存，缺档或无匹配时完整计算；宁宁一例出现双雨伞而无缓存对照为单雨伞，不能承诺物件数量、姿态或逐像素一致。

[角色 LoRA + TeaCache 完整 API 报告](../audits/2026-10-11/native-backend-lora-tea.html)记录了宁宁/夏目 v21 强度 0.8、832×1216、24 步、CFG 4：双方各 12 个热任务，独立后端中位 4.819 秒，对照 Comfy + Tea 为 5.741 秒，该轮所有 native 热样本均更快。报告中的冷启动与换组暖机较慢，两引擎调度与锐化不同；这些历史数字不代表下述新调度、加载与精修实现的性能，也不推广至任意参数或数学等价。fused 模式的无 LoRA 与两角色档已共存，该历史轮次未更改默认开关；当前已改为自动匹配开启。

2026-10-11 主力机已用独立 Python/CUDA 运行 MiaoMiao 1.6 真实文生图、图生图、手绘蒙版和两个现有角色 LoRA，初轮结果见[本机 GPU 报告](../audits/2026-10-11/native-backend-gpu.html)。后续优化与完整 API 验证见[性能续报](../audits/2026-10-11/native-backend-performance.html)：显式启用 compiled-sage，结合受保护文件身份复用和本机多项式 TeaCache 校准，在本机两个已测尺寸的连续同提示词换 seed 任务中超过 ComfyUI + TeaCache。该结论限于报告中的配置与热任务，不代表全模型、全 LoRA 或冷启动领先。

可选模式通过 `HUIYU_INFERENCE_ACCELERATION=compiled-sage` 启用，默认为 `native`。仅支持已锁定的 Windows Torch 2.8.0+cu128、SageAttention 与 Triton 版本及 Ada SM89，安装来源与 SHA256 见 `tools/inference/runtime-manifest.json`。首次编译、尺寸或 LoRA 设置改变会增加耗时；组件权重与 PEFT 强度保持原调用，不融合适配器。按用户确认的“主体、清晰度和风格保持，允许局部细节变化”检查留出样张后，已安装本机 MiaoMiao 1.6、832×1216、24 步、CFG 4、无 LoRA 的校准档；其他尺寸/适配器组合需单独校准，当前 TeaCache 默认自动匹配已接受档案；执行模式也必须与档案一致。

角色 LoRA 的进一步加速模式为 `compiled-fused-sage`。控制室的独立推理设置可持久化执行模式，重启后由 Worker 使用；`HUIYU_INFERENCE_ACCELERATION` 仍可显式覆盖，但普通桌面启动不再需要临时终端环境。旧配置缺少执行模式时按 `native` 读取，尚未准备可选依赖的机器不会自动开启 Sage。普通、保持基座的线性 LoRA 在有效源文件租约下，从原始 safetensors 的已核对位置通过 `readinto` 恢复基座；可复用 CPU 读取及转换缓冲合计最多 32 MiB，恢复前后持续检查基座身份，替代此前两角色各约 3.28 GiB 的完整 CPU 快照。这个上限不含操作系统文件缓存、模型与其他进程内存；源保护不可用的调用仍保留 CPU 快照路径。改强度、换组和卸载前先恢复原值，不通过 BF16 相减恢复，不改写文件。融合仍改变浮点运算顺序，使用单独校准身份，不能沿用未融合档。

独立引擎下 MiaoMiao 1.6 使用已实测的 24 步、CFG 4 默认配方，宁宁/夏目默认 LoRA 强度 0.8；后续明确修改的参数与历史恢复值保留。原 ComfyUI 配方及 Endfield 强度不因此改变。TeaCache 自动模式仍核对完整范围，改变尺寸、参数或执行模式后未匹配时完整计算。

模型身份首次读取完整 SHA256；固定本地 NTFS 通过文件句柄禁止所选权重写入/删除，结合文件 ID、目录成员和属性通知复用身份。基座与 LoRA 独立持有保护：换组保留有效基座租约，仅为新适配器读取完整字节；基座成员或属性事件仍使复用失效，加载期间发生变化后又恢复原状也会拒绝。支持 Rust 传入的 Windows 扩展本地路径，网络、重解析或保护不可用的路径仍全量哈希。首次任务将依赖导入与完整身份读取并行，但目录通知留在驻留主线程，全部初始化成本仍计入冷请求。更换所选模型或 LoRA 文件前需先停止 Worker 或等待 120 秒空闲释放。后文的办公机记录只说明当时的验证范围。

四个组件完成严格加载核验后，新增按 dtype 打包的 GPU 上传：保留 Parameter/Buffer 对象、形状、dtype 与数值，只将底层存储切成目标 GPU 分配的视图，不额外拼接一份完整 CPU 权重。不适用的布局在修改前返回原上传路径，复制或发布失败则明确失败。普通同拓扑 LoRA 在完整键、shape、rank、配置与 dtype 核验后可原位 hotswap；不匹配则使用既有卸载/加载路径，发生部分修改后失败会丢弃驻留模型。四任务诊断对照中，4 张 PNG 字节完全一致，额外完整 CPU 原权重快照从约 3.28 GiB 降为 0，临时缓冲最多 32 MiB，进程工作集从约 5.63 GiB 降至 1.80 GiB。private bytes 含 GPU 驱动相关记账，不等于物理 RAM；这些诊断样本不代替最终 API 性能对照。原始记录在 `runtime/backend-cost-20261011/startup-comparison.json`。

## 连续出图与阶段驻留

GPU 上传按组件和 dtype 分组，不再让四个独立组件共享一个无法单独释放的大 storage。Qwen 只在实际编码时上载，正负编码完成后移到 CPU；文本缓存命中不重新上载。主模型在整个采样阶段保留 GPU 驻留，在 VAE 编码或解码前移到 CPU，下一轮采样再上载，不逐层或逐步搬运。编码也执行该切换，避免首次图生图、蒙版或换角色后，主模型与 VAE 编码激活叠加。任务完成后归还临时显存缓存。VAE 算法、精度、分块、采样参数和现有 TeaCache 匹配规则不因此改变。

CPU 驻留会增加主机内存及阶段搬运成本。切换 LoRA 或强度时先把主模型恢复到 GPU，再恢复基座和融合，保持原计算设备与参数对象。该管理适用于未命中 TeaCache 的正常出图，不要求用户为每个尺寸额外准备档案；TeaCache 仍只为已接受范围提供可选加速，不能把少数缓存热任务的成绩当作整体替代验收。

## 第一里程碑与边界

- 使用官方 Apache-2.0 Diffusers Anima 组件，独立 Python 子进程运行，不导入或启动 ComfyUI。
- 已接入本地完整 Diffusers 目录的文生图、图生图、实验性手绘遮罩局部重绘及本地兼容 LoRA，沿用绘遇的任务身份、进度、取消与结果协议。
- 模型目录默认按现有 catalog 的 modelId 组织在 `AI_WORKSPACE_ROOT/inference/models/<modelId>/`；控制室中可配置模型根目录与独立 LoRA 根目录。目录必须包含该权重对应的配置、tokenizer、文本编码器、conditioner、transformer 与 VAE。
- 现有裸 MiaoMiao / Anima safetensors 文件不能简单重命名为完整目录；对应结构与配套资源必须先通过转换器的精确核验；实际出图仍需核验。不同 MiaoMiao 架构不能仅靠名字认定兼容。
- TeaCache 默认自动匹配已接受的本机校准档；手动关闭仍保留，无匹配不会阻断生成。显式 API `teaCache: true` 仍严格要求匹配，`false` 明确关闭，省略为自动。RCAS、Latent / 固定 Remacri 高清与圆括号提示词权重已有真实 GPU 证据；hires + TeaCache 必须为完整操作单独校准及验收。任意 RealESRGAN 权重、非 Anima 家族与视频仍不支持，不能静默忽略或改采样器完成请求。Krea 2、SDXL 等属于后续范围。
- 已支持的 LoRA 格式为原生 Diffusers/PEFT A/B 及官方识别的 `diffusion_model.*` A/B（含 llm_adapter）；另支持经原始模块名及实际 Linear 形状严格核验的 Anima Kohya `lora_unet_*` down/up/alpha 三元组（含 llm_adapter），按 alpha/rank 缩放 B；通用 Kohya 家族、卷积适配器、DoRA、残缺/非有限权重及未知格式明确拒绝。已测角色与模型组合见本轮报告，未知权重仍须实际加载验收。

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

脚本只读取每个 safetensors 的有界 JSON 头，不加载张量，不联网，不写转换结果。输出实际层数/宽度/conditioning 结构与缺失配套。官方 Diffusers 0.41.0 `convert_anima_to_diffusers.py` 固定使用 Cosmos 2B 配置（28 层、宽度 2048）；本地转换器另有显式 40 层 profile，不把 2.9B 冒充 28 层。1.2/1.6 是仓库中的版本标签，不推断为参数规模；检查器的基座判断不能代替下面的精确 profile 核验。

即使结构匹配，只读检查报告的 `readyForInference` 仍为 false。现在提供下面这个架构严格限定的离线转换入口；未知形状不尝试推断，不执行官方脚本中的联网配套获取。

### 经架构核验的离线转换

用已准备的独立运行库 Python 执行（不要使用系统 Python 临时安装大包）：

```text
python -I scripts/maintenance/convert-anima-checkpoint.py --profile anima-cosmos2b-v041 --checkpoint <原始Anima.safetensors> --transformer-config <对应config.json> --text-encoder <原始Qwen3-0.6B.safetensors> --vae <原始QwenImageVAE.safetensors> --qwen-tokenizer <本地目录> --t5-tokenizer <本地目录> --output-dir <模型根目录/已选modelId>
```

默认仅读有界 safetensors 文件头和本地配置，不读张量载荷、不写输出；加 `--check` 会利用已安装库建立 meta 模型，逐个检查完整键名/形状与 tokenizer 配套。Yume 的检查还通过 `pread` 读取下述 598 字节派生缓冲，不读取学习权重；只有显式 `--apply` 才在 CPU 读取并转换完整权重。维护入口 `npm run wf -- models:convert-anima ...` 参数相同。输出必须不存在、父目录已存在且与输入资源分离。

本轮三个显式 profile 已覆盖本机登记的六个 Anima 模型，并完成真实 CPU 严格转换：

| Profile | 架构与已转换模型 |
| --- | --- |
| `anima-cosmos2b-v041` | 28 层、2048 宽：Anima Base 1.0、Aesthetic 1.1、MiaoMiao 1.2、MiaoMiao 1.6 |
| `anima-cosmos29b-v041` | 独立 40 层、2048 宽：MiaoMiao 2.9B Beta 1.1 |
| `anima-yume2b-rope-v041` | 28 层 Yume 1.0，额外核验三个已观测的静态 RoPE 派生缓冲 |

通用键映射只接受完整的 `net.*` 或 `model.diffusion_model.*` 单一前缀，混用或碰撞拒绝；Yume profile 限定其已观测的 `net.*`。三个 Yume 缓冲必须同时满足精确名称、BF16 shape 与独立公式位级值，才允许按官方语义再生，并记录原摘要与读取字节数；未知键和学习参数不能借此忽略。三种架构共享已核对的 6 层 conditioner、Qwen3-0.6B、Qwen Image VAE 和 tokenizer 配套，仍逐键逐 shape 核验；可复用 MiaoMiao 1.6 转换时使用的同一套原始 encoder/VAE/tokenizer 输入。量化、自定义代码及未知形状拒绝，不猜配置。映射源为官方 Apache-2.0 转换器，模型和 tokenizer 许可另计。

转换先在独立临时目录保存 safetensors 分片与各组件，复核保存后的键/形状/dtype 和 tokenizer token ID，再校验 worker 所需布局。全新输出目录独占创建，最后发布 model_index.json；不覆盖旧模型或改写输入。失败的未完成发布目录保留供检查，不能当可用模型。真实 CPU 转换已执行；本文不新增其时间或内存结论，仍需为输入、临时文件和完整输出留足空间。

早期无 ML 夹具只证明协议、拒绝与发布行为；本轮真实六模型 CPU 转换及上述 11 张 GPU 出图补充了实际权重证据。转换器自身仍输出 `readyForInference: false`，不会将转换成功冒充设备验收；新资产及未测组合仍需完整加载和出图验证。

## 调度与两阶段精修

独立路径支持 Euler 与标准确定性 `res_multistep`，不把后者替换为 Euler。`normal` 与 `sgm_uniform` 使用固定 shift=3、训练表 1000 的数学网格，通过官方 Diffusers scheduler 施加一次移位并追加零终点；24、30 步 CPU 完整 sigma 已与隔离 Comfy 参考位级核对。`sgm_uniform` 将同一区间分为 N 段并排除末端，`normal` 保留两端。旧 Euler/simple 沿用 Diffusers 默认；RES/simple 明确使用 1000 点训练表抽样，不能只看名字认定两种 simple 相同。

RES 根据公开指数积分数学独立实现二阶多步更新，flow velocity 先转为 denoised，首步与零终点使用 Euler；每个任务及精修阶段新建状态，图生图 begin_index 清空历史。支持范围为 eta=0、无 CFG++；动态移位、其他 sigma 变换、随机变体和重复 sigma 拒绝。CPU 小 ODE、向量、BF16 输出转换及隔离 `python -I` 加载已验证，不等于真实 transformer、CFG、噪声或成图逐位一致。改变 sampler/scheduler 必须使用对应 TeaCache 校准范围。

RCAS 来自 AMD MIT 参考的 FP32 实现；Remacri 仅接受模型根下 `upscale_models/4x_foolhardy_Remacri.safetensors` 的严格 BasicSR RRDB 结构。Auto 按可用本地文件解析为 Remacri 或 Latent；显式选择缺失的 Remacri 会拒绝。Latent 总会二次采样；无蒙版 Remacri 仅像素超分，有蒙版时仍二次采样并最终合成原图。RCAS 遵循现有工作流条件，在最终遮罩合成前执行，不新增公开参数。

二次采样使用新调度器、seed+1 独立噪声及完整网格尾部，保留实际进度。1664×2432 验收暴露的 RoPE 容量 128 小于所需 152 已修复：按本次形状扩展，结束后恢复共享配置。上述四种高清路径已真实出图，已测暖任务 allocator 峰值约 9.33 GiB；冷首张观测为 null，不是零，也不是整卡显存证据。此结果不宣称与 Comfy 节点滑块、像素或性能等价。

高清 TeaCache 已按完整两阶段操作采集、拟合和留出对照，GPU 实际捕获 24+14 次采样更新；阶段切换清空残差。scope 额外绑定高清倍率、重绘幅度、实际放大方式、二轮采样器/调度器、精修版本与 Remacri 文件字节。普通单轮档不能复用。两角色 Latent 2×、重绘 0.35 的档已接受，阈值 0.25、最多连续跳 2 步；宁宁完整 API 两个热样本的中位数为 26.610 秒，对照 Comfy 为 23.671 秒，高清目前仍慢约 12.4%。后续更激进的跳 3 步候选没有启用；其中夏目阈值 0.30 曾出现非有限值，已拒绝，Worker 增加非有限结果发布拦截。

## 提示词权重

支持正向与负向圆括号权重：`(text)` 为继承权重乘 1.1，`(text:number)` 使用显式值，支持嵌套及转义括号。`[]` 和 `BREAK` 按当前 Anima 规则保留为字面文本，不赋予减权或分段语义。Qwen/T5 两路 token ID 与权重规则已有 14 项实际 tokenizer 对照，8 项定向测试通过；加权真实 GPU 出图成功，普通提示词对照 PNG SHA256 不变。不平衡括号、非法/非有限权重及超过 512 token 的输入明确拒绝。加权请求使用独立 TeaCache scope，不能借用普通提示词档；token 对齐不等于跨后端成图逐像素相同。

## 开启候选引擎

在本机控制室打开“绘图引擎设置”，选择独立引擎并填写模型根目录、LoRA 目录、Python 和 Worker 的绝对路径。保存到运行目录 config.json 的 inference 配置；界面区分当前运行与已保存设置，重启运行时后生效。在途任务使用冻结的旧设置，不会半途切换。

“检查配置与文件”只检查已保存路径；“检查当前运行时依赖与设备”显式调用 Worker 的 `--diagnose`，检查当前解释器内依赖与 CUDA 可见性，不加载模型、不生成图片、不安装软件。CUDA 可见不等于显存足够或实际出图成功。设置与诊断 API 继承既有本机控制面的 Host/Origin、直接 loopback 与代理头限制，不开放给远程控制请求。

生成界面遵循 native 的 TeaCache=false 默认；文件发现只代表校准档存在，加载时仍须精确匹配已接受 scope，缺失或不匹配明确失败。恢复出的旧 Comfy 阈值需明确清除，改用本地档阈值。高清与 TeaCache 可同时选择，界面提示组合需单独校准。图像编辑支持实验性手绘遮罩，或明确选择“整图重绘”（脸部和背景也会变化）；不会把既有遮罩换装请求静默转成整图重绘。手绘路径将同一有效遮罩用于逐步潜空间约束和最终原图合成，遮罩外使用与初始采样相同的噪声恢复到下一步 sigma，最后一步恢复干净原图潜变量。已测编辑组合不代表与 ComfyUI 采样器或膨胀边界等价。自动识别使用额外的本地 CLIPSeg 配套，缺失时只禁用自动模式。上传素材在独立 inference/input 中保留所有者与原始字节，排队后读取已接受的不可变副本；LoRA 只从完整 catalog 白名单和配置目录解析，包括 Rust 动态注入项。

开发覆盖仍可使用 `HUIYU_IMAGE_ENGINE`、`HUIYU_INFERENCE_PYTHON`、`HUIYU_INFERENCE_WORKER`、`HUIYU_INFERENCE_MODELS_ROOT` 与 `HUIYU_INFERENCE_LORAS_ROOT`。界面显示覆盖来源并拒绝保存冲突值；不要指向未验证脚本。独立路径找不到运行库、模型或不支持请求时返回明确错误，不借用 ComfyUI。

## 实验性自动遮罩

在配置的模型根目录下放置 `clipseg-rd64-refined/`，需完整的 `config.json`、`preprocessor_config.json`、`tokenizer_config.json`、`special_tokens_map.json`、`vocab.json`、`merges.txt` 和 `model.safetensors`。不接受只有 pickle/bin 权重的目录，也不会代为下载或转换它。状态只检查文件存在、非空与目录边界；实际结构、完整加载与分割质量仍在执行时验证。

自动模式将 `|` 分隔的区域词分别送入 CPU float32 CLIPSeg，合并结果、调整尺寸并按阈值二值化，然后复用手绘模式的遮罩膨胀、逐步潜空间约束与像素合成。CPU 分割在 Anima 加载前结束，不额外占用 GPU。驻留 Worker 可保留一个完整 CPU CLIPSeg 模型／tokenizer／processor 和一个 352×352 float32 logits（495,616 字节）；模型 RAM 与 Anima 驻留重叠，不保证低内存。每任务完整哈希本地所有模型资产，包括可选 tokenizer 文件，加载后再次核验；相同像素／尺寸／词组才复用 logits，阈值和膨胀仍每次处理，失败及退出清空。已完成真实 CPU 分割及自动蒙版 Remacri 2× 出图；这些样例不保证任意服装分割质量。边缘处理不宣称与旧 ComfyUI 节点 smooth/blur 参数等价。手绘与自动请求互斥，不会静默替换；原有整图模式保留。

Transformers 实现许可证为 Apache-2.0；CLIPSeg 权重许可独立于代码许可，本次未下载或分发权重，尚未核实所选权重的发行许可。用户需使用有权使用且已准备的可信本地 safetensors 配套。

## 验收分层

1. 无 GPU 的 Python 参数/协议测试与 Rust 源码审查，只证明相应逻辑。
2. 云端已用与 CI 一致的 Rust 1.98.1 minimal 和 locked Cargo 完成 Linux 编译；native 定向测试 21 项通过，另有 1 项无关 libvips 设备测试按既有条件忽略，设置持久化定向测试 1 项通过。均为协议/隔离夹具，不是实际模型或 Windows 验收。
3. 主力设备：先退出 ComfyUI，确认端口关闭；只启用 native，选已准备的模型执行一张文生图；检查进度、取消后显存释放、重新提交、结果入册和重启恢复。
4. 每种 Anima/MiaoMiao 权重分别验收；记录模型哈希、配置来源、依赖版本、种子、耗时、显存和成图。不得用一种权重的成功替代所有家族兼容结论。

依赖代码许可证与权重/模型卡许可分别核对。未搬运 ComfyUI 的 GPL 实现；使用官方开放库仍需随运行包保留适用许可证和通知。


## TeaCache 本机校准与验收

独立 Anima/Cosmos 路径已实现首层 norm1 代理与整个 transformer block 栈残差复用，实际跳过 attention/MLP；模型外层预处理与输出层仍运行。按 CFG 分支独立缓存，每任务新建缓存控制器；受控 Worker 串行复用已加载权重，实际首尾采样步全算，连续跳步有上限，条件、形状、设备或时间序列变化清理缓存，异常恢复原调用。图生图及手绘/CLIPSeg 遮罩继续执行原逐步约束与最终合成，不把缓存当换装算法。

实现针对固定 Diffusers 0.41.0 的标准 Anima/Cosmos 结构；不能推及所有 MiaoMiao 版本。没有内置借用的拟合系数，本机系数与留出速度/画质证据见续报。官方 TeaCache 的 Apache-2.0 许可随包保留；其 Cosmos 示例不是 Anima 校准证据，权重许可另计。

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

验收入口再次核对资产、源图片/遮罩和报告输出，要求每个留出缓存任务确有有限数值跳步，重新计算端到端中位数比且确实快于基线，才写入所选模型目录 teacache-profile.json。已有档不会自动覆盖；明确替换需提供其 `--replace-profile-sha256`。默认自动模式会在下一次兼容请求中使用已接受档；显式关闭不会被验收或模型切换覆盖。

同一固定文件现在可存最多 16 份、合计不超过 64 KiB 的校准集合。不同 runtime、角色 LoRA、强度、尺寸等范围分别保存；worker 只选择精确匹配的一份，无匹配或重复范围明确拒绝。接受新范围会保留旧范围；追加或替换均需提供旧整文件 SHA256，并通过独占接受锁和原子写入发布。异常中断留下的 `.teacache-profile.lock` 需先人工核对，不自动抢锁。

校准器可显式传 `--max-consecutive-skips 2`（支持 1–3，默认仍为 1）。该值只是候选的连续跳过上限，首尾步和累积误差阈值仍生效，必须重新执行留出对照及画质验收；不减少请求的调度步数，也不全局改变现有档。

校准档严格绑定模型各组件文件字节、LoRA 与强度、尺寸、步数、CFG、dtype/设备、执行模式及版本、图生图强度、手绘/自动遮罩及其参数与 CLIPSeg 资源；新范围还绑定正值 RCAS、提示词加权模式及完整高清操作/超分权重。改变这些条件需重新校准；每个启用任务通过完整哈希或仍受保护的租约核验身份，成本必须纳入实际收益判断。界面看到校准文件只表示文件存在，最终由 worker 验证身份与验收记录，不代表任意配置都已通过验收。当前已安装的本机校准范围见上文。

## 模型驻留与分阶段缓存候选

独立引擎以 `--serve` 串行执行任务，复用一份模型／LoRA 权重，连续任务无需重新启动 Python 或重新搬入同一份权重。每任务核对完整字节身份或仍有效的受保护租约，新加载后继续核验；基座变化会重载。普通 LoRA 换组先恢复融合基座，再尝试严格同拓扑 hotswap；不适用时完整卸载 transformer 和 text_conditioner 的适配器再加载，空组恢复无适配器基座。可能改写基座的初始化或未核实变体仍整组重载；同组仅变强度更新权重，融合模式同样先恢复。每次创建新的管线块、调度器、CFG 与 TeaCache 状态，不保留 seed 或中间潜变量；文本编码使用下述有界 CPU 缓存。成功任务的 `result` 后必须收到同身份 `ready`，才允许接收下一任务；取消、错误、超时和退出终止所属 Worker，确认停止前不放行 GPU 队列。空闲 120 秒释放进程与模型。

校准默认采用 `phase-envelope`：按实际采样进度分为三个阶段，保留各阶段观测到的变化峰值；超出观测范围或跨阶段时全算刷新。每阶段至少三个有效配对样本及两种代理变化；最多 32 个保守边界压缩数据，避免一个全局多项式平滑掉局部峰值。它仍是经验性误差估计，不能保证人物、纹理或换装边缘的画质。原 `--strategy polynomial` 可作算法对照，已有 v1 档仍按原策略执行。两种策略均要求人工验收；默认自动模式只选择已接受的精确匹配档。

校准与留出对照默认复用同一份已加载权重，双方须有 `modelReused=true` 证据；`--no-resident` 可另测冷任务。进程创建开销单列，Python 导入与首次模型加载计入首个训练任务；暖任务总耗时包含指纹、编码、采样、解码和写图；每任务重置 CUDA 分配峰值。两种模式不能混为同一速度结论。RTX 4070 Ti SUPER 的实际配置和原始证据见性能续报。

## 办公机完成的准备与文本缓存

驻留 Worker 仅在首次任务核对依赖并加载辅助模块，后续复用已验证的运行代码；单独诊断仍重新检查，更新运行库或脚本后需重启。办公机阶段逐任务全量哈希；当前主力机路径使用上文的受保护租约，完整哈希走 Windows CNG 或其他平台的 hashlib，未改为按文件名／时间复用。

相同文本换 seed 的任务复用 Qwen 编码与 T5 token／mask，CPU 缓存最多 4 项、16 MiB；按文本、负面词、序列上限、CFG 分支、dtype 和设备区分，重载／释放模型时清空，任务获取独立张量副本。LoRA 仅作用于 transformer／text_conditioner，后者每任务仍运行，因此强度回切可复用基座和原始文本编码。基座字节改变仍重载；普通适配器换组现在按上文的 hotswap／卸载加载规则执行，可能改写基座的变体退出时保守重载。

结果事件记录文本缓存命中、未命中与保留字节数。TeaCache 速度对照双方明确关闭文本缓存和 CLIPSeg 模型／结果缓存，运行与验收均要求明确的禁用证据，避免第一侧未命中造成比较偏差。旧测量报告缺新 mask 缓存证据时不能用于新的验收；已安装的已验收 profile 不改写。主力机保留真实权重加载、GPU 耗时／显存、画质和取消释放验收；办公机的模拟模型及小组件验证不替代这些结果。

办公机已用隔离 Python 3.11 与全部锁定版本（Torch 2.8.0+cpu、Diffusers 0.41.0、Transformers 5.10.1、PEFT 0.19.0 等）执行真实 CPU 小组件：随机 Qwen／Cosmos／text_conditioner／VAE、当地构造的 tokenizer，确认缓存编码与原始编码一致、两个 LoRA 组件强度回切恢复相同输出、新调度器与文本释放，以及两次完整 64×64 小管线文本复用。它只产出随机小组件噪声，未加载真实 Anima/MiaoMiao 权重，不作为画质或 GPU 速度证据。安装只在被忽略的 runtime/office-anima-cpu/ 中，不改系统 Python、ComfyUI 或产品 CUDA 准备契约；首次 CDN 下载不完整且哈希失败，改用经响应核对的官方主域名后保留原 SHA-256 核验并成功安装。

本机证据位于 runtime/office-inference-20261010/：cpu-smoke/report.json 与 hash-benchmark.json。32 MiB 合成文件、暖文件缓存、每方案两次交替读取中，SHA-256 相同；流式读取的 Python 分配峰值从约 16.0 MiB 降至 0.26 MiB，耗时中位数约 37.4 ms／30.0 ms。这是该读取样本，不能推广为模型加载或出图增益。源码、夹具输出与其范围分别记录；实际权重与 GPU 最终验收仍保留。
