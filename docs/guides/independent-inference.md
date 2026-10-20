# 独立图像与视频推理接入

维护入口：共享文件识别在 `runtime-rs/src/generation/native/resources.rs`，Anima 与 adapter 目录结构在 `model_layout.rs`；状态与提交使用同一规则。运行配置经 `Settings.worker_command` 构造解释器命令，准备环境仍沿现有控制室和离线准备器。模型扩展、调度与释放的审查要求见[工程契约](../engineering-contracts.md#模块边界)，不复制环境准备、队列或取消循环。

诊断、受管启用和模型目录校验同样沿用该解释器策略；受管启用按 native/offload 目标检查，不写随包 Python 缓存。adapter 状态与提交共同核对主 worker、立即加载的四个 helper 和模型声明；漫画共同核对自己的文件集，可选 Qwen 重绘再核对 adapter。文件缺失或为空会显示尚未就绪，不代表依赖导入、真实权重或设备已经验证。

## 原生图像与视频适配入口（待主力机验证）

这些适配复用固定 Diffusers 源码，不使用 ComfyUI 节点、Python 或量化分片。
Krea/Qwen 可在控制室「原生绘图」选择模型，一键下载独立 Python 3.11、CUDA 12.8 运行库和完整模型，校验后保存原生配置。四种图像模型可逐个添加，共用 adapters 运行库；保留 Anima 的独立环境。下载清单为 `managed-adapter-runtime.windows-x64.json` 与 `managed-adapter-models.json`，固定版本、文件大小与 SHA-256；Diffusers 从固定源码归档复制纯 Python 包，不执行源码安装钩子。取消保留已下载文件，重试沿用续传和校验，已有冲突文件不会被覆盖。
Krea 先在官方仓库接受许可，再在准备界面填写只读 Hugging Face 令牌。令牌只用于本次下载，不存入设置或操作记录；下载运行库前先核对访问权。受限仓库的原始配置和 LFS 指针通过固定 Git blob ID 核对，再取得完整权重 SHA-256。完成文件可离线复核与启用。
「辅助模型与 LoRA」可单独准备 CLIPSeg 自动蒙版、FP32 Remacri 放大、Anima Sketch LLLite v2、MangaLine 线稿，以及已登记的 Anima 角色 LoRA 与九种 Krea 风格，沿用下载、完整 SHA-256 校验、取消和续传流程。辅助模型写入当前已配置的 `modelsRoot`，不切换底模目录；LoRA 存入 AI 工作区的 `inference/loras`，可填入设置草稿后保存并重启。已有不同文件不会覆盖；需要来源账户登录的文件可自行下载到所示目录再校验。此入口不接收账户令牌，不在生成过程中隐式下载。
辅助清单为 `managed-auxiliary-models.json`。CLIPSeg 固定 CIDAS 的完整配置、分词器与 safetensors；Remacri 固定 LyliaEngine 的 FP32 转换文件，不能用同名 FP16 文件代替；Sketch 固定现有加载器支持的 28 层 Anima 版本。MangaLine 使用 `lllyasviel/Annotators` 的固定 erika.pth 镜像，来源和原项目许可分别展示。准备包含许可或模型卡文件，界面明确显示用途与来源；文件齐备只按大小判定，准备完成才表示逐项完整摘要通过，均不代表实际生成已验收。原生设置保存后如尚未重启，辅助资源写入已保存目录，当前运行仍使用原配置。
新配置默认使用原生 LoRA 目录，不再自动借用 `ComfyUI/models/loras`；用户显式保存的旧路径仍可复用文件。仅准备 Krea/Qwen 也可进入绘图模式，模型发现按图像适配器汇总；各模型在提交时分别核对环境与权重。PixAI 准备工具默认寻找已准备的原生 Python，也可用 `--python` 指定独立环境。
手动配置时，在独立环境中安装 `tools/inference/requirements-adapters.txt`，CUDA PyTorch 使用对应 cu128 发行。
其中 Diffusers 固定为 `b800f828f3951c4d206e154411bcbfa693cd322e`、Transformers 5.17.0；
不要向已有 Anima 环境安装这份依赖。安装、下载权重与 GPU 推理均须在具备条件的机器显式执行。

将完整 Diffusers 快照放在所选 `modelsRoot/<modelId>/`，保留模型许可文件；
官方实现、指定转换仓库、参考 revision 与组件白名单见 `tools/inference/adapter-models.json`。
目录检查只证明配置和文件存在，不证明本地权重来自参考 revision 或能够推理。

| modelId | 指定权重仓库 | 原生入口与功能 |
| --- | --- | --- |
| krea2-raw | krea/Krea-2-Raw | `/api/creative/jobs`；文生图，默认 52 步、Krea guidance 3.5 |
| krea2-turbo | krea/Krea-2-Turbo | 同上；8 步、Krea guidance 0，固定 distilled 调度 |
| qwen-image-2.1 | Qwen/Qwen-Image-2.1 | `/api/qwen/jobs`；文生图、单图及最多四图指令编辑，默认 40 步、CFG 1 |
| qwen-image-2.1-turbo | Qwen/Qwen-Image-2.1-Turbo | 同上；8 步、CFG 1，使用权重声明的 sample_sigmas |
| wan2.2-ti2v-5b | Wan-AI/Wan2.2-TI2V-5B-Diffusers | `/api/video/jobs`；3/5 秒文生视频，默认 50 步、CFG 5、24 fps |
| wan2.2-14b | Wan-AI/Wan2.2-T2V-A14B-Diffusers | 同上；T2V 双模型，40 步，高/低噪声 CFG 4/3，16 fps |
| hunyuan-video-1.5 | hunyuanvideo-community/HunyuanVideo-1.5-Diffusers-480p_t2v | 同上；480p T2V，50 步、guider CFG 6，24 fps；仅 standard 画布 |
| minimax-h3 | MiniMaxAI/MiniMax-H3 | 同上；t2va 联合音视频，默认 50 个 sigma 点，24 fps；5/10 秒档位 |
| ltx-2.3 | diffusers/LTX-2.3-Diffusers | 同上；基础单阶段联合音视频，30 步，24 fps；独立视频/音频 CFG 3/7 |

Hunyuan 使用其官方项目链接的 Diffusers 转换版本；LTX 使用 Diffusers 文档指定的 2.3 转换版本。
H3 需要根目录 `modular_model_index.json` 和 text_encoder、tokenizer、processor、transformer、vae、audio_vae、
scheduler、audio_scheduler；t2va 无需 transformer_ref 或原始 FL2VA/Ref2VA 树。加载器只读已校验的本地组件，
不跟随索引中的远程加载地址。既有 Comfy INT8/NVFP4、Turbo LoRA 和分片不能直接用于这些 BF16 入口。

时长档位映射到可解码的帧数：Wan 5B/Hunyuan/LTX 为 73/121 帧，Wan A14B 为 49/81 帧，
H3 为 124/243 帧。`encodedDuration` 给出实际帧数除以帧率的时长，不承诺精确整秒。
H3 的步数包含终点零，实际采样更新数少一次；进度取调度器的实际更新数，不伪造为请求步数。
Hunyuan 画布为横向 832×480、纵向 480×832、正方形 640×640，其他画质档位明确拒绝。

Krea 仓库需先接受官方许可并获得访问权；选择 transformer、text_encoder、tokenizer、vae、scheduler
及 model_index 的完整快照，无需额外下载重复的根目录 raw/turbo.safetensors。
官方文件清单可读，但受限配置及真实加载仍待主力机核验。Krea 权重适用 Krea 2 Community License，
Qwen 2.1 权重适用 Qwen Research License（非商业研究/评估；商业用途须另获许可），
Wan 权重及 Diffusers 实现为 Apache-2.0；H3、Hunyuan、LTX 分别遵循其模型许可，LTX 文本编码器另受 Gemma 许可约束。
实现许可证不替代权重许可证；许可链接随适配声明返回。

在控制室「原生绘图 → 已有资源与高级设置 → 高级路径设置」填写 Krea / Qwen 独立 Python，保存并重启；也可在启动前设置 `HUIYU_NATIVE_ADAPTER_PYTHON=<独立venv的python.exe>`。选择 native 绘图引擎、
native 加速；`HUIYU_INFERENCE_MEMORY=offload` 使用共享 `native_memory`，按设备可用显存扣除 `max(1 GiB, 显存总量/4)` 的激活预留，对超预算文本编码器和去噪器选择 block/leaf 分层卸载，每任务重估预算；resident 保留原整管线 GPU 模式。VAE 和 vocoder 保留组件卸载及已有 tiling，避免绕过根 forward 的 encode/decode 与直接权重访问破坏 hooks。分层搬运不启用预取流、不改变精度；预算不保证任意画幅、模型或并行 GPU 占用下不会 OOM。
新增适配由同一 worker 保留一组受 Windows 文件保护租约约束的权重；同目录、modelId、显存策略及同一持续有效的保护 token 才复用，每任务重建管线、scheduler、guider 和请求状态。租约内部重新获取保护后，即使摘要相同也重新加载旧权重；推理前再次核对保护期。切换、文件保护失效、取消或失败释放驻留；不支持持续保护时保留逐任务完整字节校验和释放，不以文件名、大小或 mtime 替代身份。漫画内嵌 Qwen 不驻留。分层 hooks 安装/移除时清除子注册表缓存，再允许 LoRA 拓扑变更。
`nativeRuntime.weightReuse` 与 `memoryScheduling` 返回实际复用、组件模式及预算；缺少或无效观察不视为通过。分层路径、保护复用、取消恢复和新视频模型均待主力机验证。H3 的 BF16 组件仍可能超出主力机显存/内存，量化尚未接入。
Hunyuan/LTX 启用上游 VAE tiling。视频需本地带 libx264 的 ffmpeg，H3/LTX 另需 AAC 编码器；
可用 `HUIYU_NATIVE_FFMPEG` 指定绝对路径。音轨缺失、采样率或时长不匹配会报错，不静默导出无声视频。

最短人工核验：用该 Python 执行 `-I tools/inference/adapter_worker.py --diagnose`，再执行
`--validate <完整目录> --model-id <ID>`；两者都不加载权重。重启后读取对应 `/status`，
确认 provider=native，再通过上述 jobs API 提交单张 1024×1024、固定 seed 的文生图；
图像请求仅需 modelId、prompt、width、height，可加 seed/steps/cfg/negative。
Qwen 原图先经 `/api/qwen/images/raw` 上传，再将返回名称放入 initImage；编辑不接受 denoisingStrength。
视频沿用现有 prompt、modelId、aspectRatio、duration、camera、motion 请求字段；省略 steps 使用对应版本默认值。
H3 从 5 秒开始，其余从 3 秒开始；H3 不接受负向提示词。检查音视频同步时使用实际 `encodedDuration`。
通过 GET jobs/id 查看实际采样步、DELETE jobs/id 取消，并核对下一任务、原 Anima 链路与显存释放。
真实结果文件、画面、取消恢复及资源占用须分别人工验收；不得将诊断、构建或目录就绪当成出图证明。

Krea RAW/Turbo 已接入画室与桌宠共用的模型发现和提交链路；RAW 可调步数/CFG，Turbo 固定 8 步/CFG 0。新配置默认原生绘图，视频保留 ComfyUI；已有配置切换绘图时会保留此前的视频引擎，分别持久化为 `engine` 与 `videoEngine`。
Krea 可选现有九种官方风格 LoRA，文件名沿用 `runtime-rs/src/images/catalog.json`，放在所选 `lorasRoot`。独立环境的 `peft==0.19.0` 用于风格加载；只接入强度 1 的完整 A/B safetensors。执行时追加对应触发描述，校验转换目标、矩阵尺寸与实际加载键；相同风格在连续有效的文件保护期内驻留，切换风格或移除风格重新加载模型，失败/取消释放。目录就绪不证明 LoRA 兼容或实际效果，仍需设备验收。
Qwen 在「我的作品 → Qwen 生图与编辑」或准备完成后的「打开 Qwen 创作」进入独立创作页，支持文生图、单图及最多四图指令编辑、PNG 导出与入册。原图为图 1，最多三张参考图按显示顺序接入；API 使用 `initImage` 加 `referenceImages` 上传名数组，每张最多 16 MiB，总量最多 64 MiB。桌面使用 `kind:qwen` 持久任务，全部输入均受保护，排队恢复使用原始字节与顺序；取消、结果收集沿用现有任务运行时。页面离开不重发任务，接收状态未知时只按原请求键查询或取消。作品预览内可直接「用 Qwen 编辑」副本；Qwen 作品不再跳入 Anima 配方重跑入口。恢复的编辑任务不会静默变成文生图，再次编辑须重新导入输入或明确切换模式。已开始的推理无法断点续算，实际运行仍待主力机验收。
当前未接入：Krea 角色 LoRA/遮罩/高清、Qwen 通用 LoRA、全部新视频入口的图生/关键帧/参考媒体与分镜批量，
H3 对白专用参数、量化和 Turbo LoRA，Hunyuan 720p/I2V/蒸馏，LTX 多阶段超分/蒸馏及自动提示词增强。
选择未实现能力会明确报错，不回退 ComfyUI；LTX-2.3 不会被自动替换为 2.5。
原 Anima 受管安装和采样实现保持原入口；下文历史设备证据只适用于原有 Anima 范围。

## MangaScreen 漫画后处理基础（待主力机验证）

原生 `/api/manga` 复用 [ComfyUI-MangaScreen](https://github.com/ashukae/ComfyUI-MangaScreen)
的 MIT 算法，固定 revision `d0eb8dcc6c45274e3eee118ff0dabe05b56039b9`；版权与完整许可随
`tools/inference/MANGASCREEN_LICENSE.txt` 打包。核心去除 Comfy/Torch 节点包装，添加阶段取消，
修正上游 border=0 的整幅涂黑切片问题；不宣称与上游输出逐像素一致。

基础后处理在 CPU 执行，无模型权重。`HUIYU_NATIVE_ADAPTER_PYTHON` 指向单独 Python 3.11 环境，
Krea/Qwen 受管环境已包含 `requirements-manga.txt` 对应的 NumPy、OpenCV headless、Pillow；手动配置时也可与前述 adapters 环境共用兼容依赖，
不要改动受管 Anima 环境，也不要混装多个 OpenCV wheel。`--catalog` 仅读声明，`--diagnose` 仅检查依赖导入。
CPU 路径不会申请 CUDA 或为自身停止聊天模型；它仍复用原生串行队列，切换 worker 会释放旧推理 worker。

启用 native 后，先向 `POST /api/manga/images/raw` 上传单帧 PNG/JPEG/WebP（二进制请求体，
`Content-Type: application/octet-stream`），再向 `POST /api/manga/jobs` 提交：

```json
{"operation":"lite","initImage":"<上传返回的 name>","panel":{"frame":"original","border":0,"margin":0,"ink":0}}
```

`levels` 仅灰度/色阶；`finish` 仅线条、平涂和网点；`panel` 仅裁框/纸张；默认 `lite` 依次执行三者，`comic` 执行 finish → panel。
`lineart` 为仅提取线稿的独立操作，直接从输入原图提取，复用相同任务队列、进度、取消、超时及本地权重检查。
请求为 `{"operation":"lineart","initImage":"<上传返回的 name>","autoLines":true}`；`autoLines` 可省略并按 true 处理，
明确传 false、重绘、外部线稿或色阶/网点/纸张参数均拒绝。只加载同一官方 MangaLineExtraction CPU 实现，
不加载 Qwen 或执行 MangaScreen 网点/纸张步骤；仍需上述独立环境与 `manga-line-extraction/erika.pth`，**待主力机验证**。
嵌套参数沿用上游名称和默认值，完整范围见 `manga-screen.json` 及 `GET /api/manga/status`；
不属于所选操作的参数组、未知参数和倒置黑白点会明确拒绝。`penLines` 可传另一次上传返回的线稿名称，
仅包含 finish 的操作接受，不能与重绘或自动线稿混用。`penLinesPolarity` 为 `white-on-black`（API 默认）
或 `black-on-white`；`penLinesFit` 为 `stretch`（API 默认，沿用原有缩放行为）或 `exact`（尺寸不同即拒绝）。
界面导入默认黑线白底、严格同尺寸；尺寸不同时须显式勾选「允许缩放对齐处理图」，不会暗中拉伸。

可选模型步骤仍为**待主力机验证**：

- `rewrite` 接收 `modelId`、`prompt`、`width`、`height`、`seed`，仅与 `comic` / `finish` 配合。
  模型为 `qwen-image-2.1-turbo`（8 步）或 `qwen-image-2.1`（40 步），固定 CFG=1、无负向；
  直接复用前述固定 revision 的官方 Diffusers `QwenImage21Pipeline`、目录检查和本地加载器。
  使用完整 Diffusers 目录 `<modelsRoot>/<modelId>/`，不接受 Comfy 拆件或量化权重。
  两个 Qwen 权重版本及研究许可见 `adapter-models.json`；该许可不因本项目代码接入而改变。
  编辑尺寸每边 512–2816、32 对齐，合计不超过 2,097,152 像素；传入原图而非纯文生图。
  界面初始指令是依据上游漫画流程编写的可编辑草稿，尚未编译 Token 或真实出图验收。
- `autoLines:true` 在当前处理图（Qwen 重绘后或 lite 色阶后）上提取线稿，随后交给 MangaFinish。
  直接保留 [论文作者的网络](https://github.com/ljsabc/MangaLineExtraction_PyTorch/tree/6ec136d5332180b65476e62c2558f2873d5d936a)
  与 state_dict 名称，固定 revision `6ec136d5332180b65476e62c2558f2873d5d936a`；
  MIT 许可随 `MANGALINE_LICENSE.txt` 打包，仅去掉 CLI、数据集和不可达调试代码。
  可在「辅助模型与 LoRA」准备固定镜像，或自行放入 [官方 v1 erika.pth](https://github.com/ljsabc/MangaLineExtraction_PyTorch/releases/tag/v1)（约 165 MB）
  到 `<modelsRoot>/manga-line-extraction/erika.pth`。按作者预处理保留原尺寸、灰度 0–255、补齐 16 倍数，
  输出反相为 MangaFinish 所需的白线黑底；CPU FP32 执行，不做隐式缩图或算法替代。
  仅 `weights_only=True` 严格加载；记录实际文件 SHA-256，但不把文件存在/哈希记录称为官方权重或效果验证。
- 模型步骤需在独立环境准备 `requirements-manga-models.txt`（合并现有 adapters 与 CPU 图像依赖），
  未开启时不导入 Torch。Qwen 继承控制室的 resident/offload 策略及聊天显存交接，结束后释放模型再提线稿。
  两步骤属于同一个漫画任务，发布漫画 PNG 和可选的独立线稿 PNG；重绘中间图在任务私有目录内清理。
  状态接口分别列出 Qwen 和线稿文件缺失原因，依赖在提交后的 worker 初始化检查；无自动下载、跳步或 Comfy 回退。

组合请求示例（仅接口格式，不代表运行通过）：

```json
{"operation":"comic","initImage":"<上传返回的 name>","rewrite":{"modelId":"qwen-image-2.1-turbo","prompt":"Redraw this image as a black-and-white manga panel, preserving its subjects and composition.","width":1024,"height":1024,"seed":0},"autoLines":true,"panel":{"frame":"original","border":0,"margin":0}}
```

输入每边 128–4096、最多 2,097,152 像素，按 EXIF 校正并将透明区域合成白纸，不暗中缩放。
裁框后最多 8192 边长、16,777,216 像素，结果为 PNG，元数据宽高取真实输出。
通过 GET `/api/manga/jobs/{id}` 查询阶段、DELETE 同路径取消，`/result` 获取成品。
自动提取或外部线稿任务还可通过 `/api/manga/jobs/{id}/lineart` 获取黑线白底 PNG；
`metadata.lineartResult` 返回实际宽高、`polarity:black-on-white`、`stage:before-panel` 和「待主力机验证」。
独立 `lineart` 操作的 stage 为 `extracted`，`/result` 与 `/lineart` 返回同一主结果，不额外发布重复的附属文件。
线稿是用于 MangaFinish 的线条强度图的 8 位副本，保留阈值化、裁框前尺寸；外部线稿按所选极性、对齐方式处理后保存。
临时 jobs 的两份结果共用任务所属者、成功状态和结果目录检查，取消、过期及关闭时一同清理。
桌面漫画入口使用 `/api/tasks/v1`，`kind:manga` / `kind:lineart` 分别提交漫画和独立线稿；`input` 沿用上述参数。
原图及外部线稿复用任务输入保护；主结果为 `results/0`，漫画的可选线稿为 `results/1`，独立线稿只有 `results/0`。
结果按现有工作区媒体链路持久化，全部必需输出提交后才标为可用；不依赖临时 jobs URL 或页面存活。
单独预览、保存、导出或重新读取已完成任务的线稿不会重新运行模型。
Qwen 在采样步回调取消，线稿在网络层边界取消，单次 OpenCV/卷积调用只能完成后响应；
沿用宿主 10 秒取消宽限和 10 分钟任务超时，必要时回收子进程。
漫画网点的 3 倍超采样会消耗 CPU 内存，独立线稿不执行该步骤；两种操作的资源峰值均尚未实测。

主力机最短核验：用指定 Python 运行 `-I tools/inference/manga_worker.py --diagnose`，确认状态为 native，
上传一张已获授权的小图，提交上述任务，核对网点、零边框、实际尺寸，再检查取消后重提和既有生图链路。
前端入口为「我的作品 → 大图操作 → 漫画化」，画集顶部可导入本地图片，绘制工作台「成片再创作」可带入当前原图。
右侧依次提供 Qwen 重绘、线稿来源（不使用／自动提取／导入外部线稿）和后处理参数。
选择「自动提取线稿」后，可点「仅提取线稿」，仅从原图提取并自动打开线稿预览；保留现有漫画预览和参数。
独立任务沿用原图的显式缩小设置，Qwen 开关及漫画参数不影响该任务；处理漫画仍使用底部「处理为漫画」。
画布顶部为「原图／线稿／漫画／对比」；在线稿页区分导入预览、独立提取结果与漫画附带线稿，旁边可导出黑线白底 PNG 或存入我的作品，
复用缩放查看器、下拉框、勾选框与现有桌面/浏览器保存入口。导入预览保留原尺寸，透明区域按所选底色合成。
导入线稿保存复用 `artworkRepository` 的 staging、图片上传、作品追加与缩略图缓存。
任务成片和线稿则复用任务中心 `saveTaskResult`，直接引用已持久化媒体，以 `task-{taskId}-{index}` 去重，不重复上传图片。
使用独立于漫画的作品编号、`artifactKind:lineart` 和「线稿」标签，记录实际尺寸、源作品关系、原始配方/任务编号及待验证状态。
导入线稿记录 `provider:local`、原文件名称和极性，标明是本地导入；任务线稿记录 native，不混淆来源。
保存失败保留当前结果的身份供重试；漫画与线稿分别入册，全部收到的结果入册后才标记整条任务已保存。
关闭面板只停止读取，不取消已接收任务；入口底部可直接进入任务中心。导入预览保存未确认时仍提示保留或导出。
线稿读取失败可重试，不阻止漫画另存；无附带线稿的新漫画任务保留上一次线稿并明确显示其为旧结果。
界面默认完整构图、零边框/留白；超限图片须显式勾选缩小处理副本。处理只在点击按钮后提交，参数调整不自动运行。
结果保存实际后端配方与源作品关系，不覆盖原图；服务未就绪会显示原因，取消以服务端终态为准，断线后重新连接原任务。
模型步骤最短核验：主力机准备上述环境和本地权重后，从「漫画化」用一张小图分别启用线稿、Qwen，再组合启用，
核对角色/构图、线条极性、网点与实际尺寸；运行中取消并确认终态、显存释放和再次提交，最后检查已有生图入口。
线稿功能最短核验：同尺寸黑线白底 PNG 导入 → 预览并导出 → 处理为漫画 → 分别导出漫画与任务线稿；
再核对白线黑底/透明线稿、尺寸不符时的显式对齐、自动提取后的线稿、裁框前尺寸和取消后的清理。
独立任务与作品库最短核验：原图 → 自动提取线稿 → 仅提取线稿 → 存入我的作品 → 关闭面板后重开作品，核对尺寸、来源与「线稿」标签；
再分别保存导入线稿与漫画附带线稿，核对保存重试不新增同一结果的重复记录、漫画/线稿分开保存、任务过期不影响已入库图片。
重启恢复沿用任务中心的核对机制：完整落盘的结果保留预览、导出与入册；仅保存部分结果时明确提示缺失，保留已落盘图片。
从未提交且未取消的排队任务可显式「继续处理」，须能恢复受保护输入且引擎身份、已冻结配方仍有效；缺少输入时拒绝恢复。
已开始的原生推理没有采样断点，重启后标为中断，不自动重跑；工作区/提供方不匹配时保留待核对状态。
已确认结束的失败或重启中断漫画/独立线稿任务，可在任务中心点「重试此任务」。`POST /api/tasks/v1/{id}/retry` 从原任务恢复受保护原图、外部线稿和已冻结参数（包括重绘种子），从头处理，不接收浏览器替换配方。
每条原记录只创建一个重试任务，固定请求编号与双向关联随任务持久化；重复操作或回执丢失只找回同一条记录。重试任务再次失败时，在那条记录上重试；「查看原任务／查看重试任务」可跨历史分页定位。
接收重试时，在同一存储事务中建立新任务、输入媒体引用和关联，不重复上传素材；原记录、已保存的部分结果与入册身份保留。重试任务仍沿用原有取消、重启核对、预览、导出和入册链路。
未知状态须先核对；主动取消不自动改为重试。原图/外部线稿未持久化、输入不可读取、引擎配置或冻结配方版本不匹配时拒绝重试，需修复原条件或回漫画入口新建任务。
任务中心最短核验：分别提交漫画（带线稿）与独立线稿 → 关闭漫画窗口 → 在任务中心查看 → 结果落盘后重启 → 分别预览、导出和入册；
确认先保存漫画不会隐藏未保存线稿，同一结果重试保存不重复；另核对排队重启、处理中重启、取消及工作区切换。
一键重试最短核验：在主力机对已确认失败/中断的两类任务分别重试，核对参数、种子与原图/外部线稿不变；连续点击、重启或回执丢失后仍只对应一个重试任务，再核对原结果保留、新任务取消及结果入册。
此处仅保留以后操作步骤，本轮未下载权重、执行推理或测试。
本阶段不含线稿 GPU/分块推理、多格排版/气泡、批处理或已开始推理的断点续算。
任务中心、跨重启恢复与一键重试代码、视觉结果、取消延迟与性能均为**待主力机验证**。

## 当前使用方式（2026-10-14）

首次使用在控制室打开“原生生图”：选择 AI 工作区，检查设备、空间与许可后点击“一键准备”。同一后台操作连续完成运行库、完整模型、校验与原生配置保存；离开页面仍继续，回到页面可查看进度或取消。来源、版本和路径明细收在“设备与下载详情”，分项准备和离线导入保留在折叠入口。受管流程支持 Windows 10 22H2 / Windows 11 x64、单张支持 BF16 的 NVIDIA Ampere 至 Blackwell 显卡、12 GB 或更多显存、驱动至少 572.61、系统内存至少 24 GiB（建议 32 GiB）；具体设备兼容性会在安装后由固定 PyTorch 运行库再次诊断。AMD、Intel 与 CPU 推理尚未接入，设备不满足条件时禁用受管下载，不要求用户下载无法使用的 CUDA 包。

主列表默认推荐 MiaoMiao Harem Anima 1.6，复用起步模型清单中的固定 Civitai 文件与 SHA-256，并准备原始 Qwen 编码器、VAE 及固定版本的分词器和配置。下载完成后，用既有 `anima-cosmos2b-v041` 转换器在 CPU 严格转换，再校验原始文件、转换结果和目录后发布到 `inference/models/anima-miaomiao-v1.6`。空间预算同时包含原始缓存和转换后的模型；取消保留已下载文件，已有目标目录不会覆盖。此一键转换接线仍待主力机完整下载、转换与真实出图验收，既有本地手动转换记录不代替本流程验收。

运行库从 Python.org、PyTorch、PyPI 和 Microsoft 固定源获取，包含独立 Python 3.11.9、PyTorch 2.8.0 CUDA 12.8、固定依赖及所需 VC++ 共享组件；下载约 3.32 GiB，首次准备预算约 14.32 GiB。Python 与依赖在所选工作区的 `inference/<runtimeId>`，不修改系统 Python，不需要完整 CUDA Toolkit 或 ComfyUI。缺少 VC++ 时打开微软安装器，由用户处理 UAC；此系统安装阶段只能在微软窗口取消或等待结束。下载缓存位于 `inference/.downloads`，候选暂存在 `inference/.staging`；续传和重试复用匹配文件，只有完成依赖与设备检查的版本才登记。

同时保留官方 [Anima Base v1.0 Diffusers](https://huggingface.co/circlestone-labs/Anima-Base-v1.0-Diffusers)，固定 revision `073c3a9db359c31ad0e8aa268d15775473c2176c`，完整 17 文件约 5.25 GiB，含 transformer、编码器、VAE、tokenizer、配置、索引和许可；逐项核对大小与 SHA-256 后发布到 `inference/models/anima-base-v1.0`，无需转换。下载前须阅读并接受该版本非商业许可。自动转换仅接入上述固定 MiaoMiao 1.6 配方，不将任意 `.safetensors` 标为原生兼容。已有完整模型可以在高级路径设置直接复用，已有 LoRA 继续使用原目录，软件不搬移用户模型。

一键流程明确保存原生引擎，按页面提示重启绘遇；只有当前引擎确认为原生、设备与资源就绪才显示“开始创作”。工作区变更会撤销旧目录的就绪显示，保存新目录后须重启；应用不静默回退 ComfyUI。源码、构建和组件检查不等于干净 Windows 安装或真实出图验收；断网续传、磁盘不足、不可写目录、缺组件、重启发现及最终原生成图仍须在对应设备人工验收。

在控制室展开“已有资源与高级设置”，选择“采用并启用”，保存后重启运行时。程序从当前 AI 工作区的 inference 根及一层子目录发现兼容运行库安装记录，复用 inference/models 内完整原生模型；LoRA 默认使用 inference/loras，不自动借用 ComfyUI 目录。显式保存的旧模型路径仍可复用，无需重复复制权重。显式保存的配置与环境覆盖仍优先，手动路径集中在高级设置。发现只检查本地文件，不代表依赖或设备出图验收。

日常 TeaCache 已内置 CocyNoric 的 Apache-2.0 Anima 策略，默认阈值 0.10，允许沿用保存的数值阈值；关闭或阈值 0 使用完整计算。切换模型、LoRA、尺寸和高清倍率不再要求校准，也不读取旧 teacache-profile.json。主采样与高清二次采样使用独立残差，首末步完整计算。内置缓存会改变部分采样结果，不承诺跨后端像素一致。显式本地校准仅保留为维护研究路径。

加载阶段显示环境、模型核验、各组件加载与上传、编码、解码及保存进度。取消在安全阶段或采样步边界生效，清理后确认 ready 才保留模型；10 秒内没有确认或发生故障时仍结束进程，避免后续任务与未退出工作重叠。已完成任务的取消竞争不再无条件销毁模型。

未显式配置绘图引擎时默认原生；已有显式配置保持用户选择，视频配置独立。Anima 支持图生图、手绘/CLIPSeg 局部重绘、Latent/固定 Remacri 高清和 RCAS；辅助权重可在同一准备页按需添加。首次准备使用受管下载，已有 Python 与本地 wheelhouse 的离线准备、完整 Diffusers 目录导入保留为高级入口。应用不盲用 ComfyUI Python；Krea/Qwen 的独立运行库与模型一键准备见本文首节，真实生成仍待主力机验收。SDXL 和任意 Comfy 节点不属于原生支持范围。

用户授权后完成 36 张产品 API 成片、5 次取消，并完成安装版取消/恢复；2026-10-13 已完整安装到 `C:/Program Files/AI-CG-Studio`，用户确认实际体验良好。本机 RTX 4070 Ti SUPER 的 MiaoMiao 1.6、宁宁 LoRA 0.8、832×1216、24 步、CFG 4 三张热任务中位数为原生 5.05 秒、ComfyUI 5.54 秒；Latent 高清速度接近，局部手部细节仍有差异。分阶段模式较慢但显存峰值更低。本轮不推广为全模型、自动换装语义或全部硬件验收。

首次依赖初始化在取消读取线程继续等待下一行之前完成，修复 Windows NumPy 原生扩展的初始化阻塞。完整 API 计时包括这段初始化及结果后的资源清理；首次 CUDA 设备准备先于分配器峰值重置。每张完成后归还闲置显存，保留模型权重；高清结束常驻模式整卡约 6557 MiB，分阶段模式约 1421 MiB。

2026-10-13 冷启动研究发现，上述初始化保护让产品入口先导入依赖、再完整核验权重，原有并行分支没有实际生效。源码现改为主线程持有文件保护并初始化依赖，后台只计算完整字节摘要；首任务直接接收核验结果，加载后仍复核。依赖初始化结束即恢复取消读取，不等待慢盘摘要结束；异常先等后台退出再释放文件保护。依赖与指纹分别计时且有重叠，不能相加。

随后按用户授权在本机 RTX 4070 Ti SUPER 进行真实前后对照。各三个新进程样本的“进程启动至首图”中位数从 17.24 秒降到 16.35 秒，约缩短 0.89 秒（5.2%）；保留 OS 文件与编译磁盘缓存，不代表冷盘或首次安装。普通热图中位数旧版 5.37 秒、最终版 5.46 秒，本轮未证明连续出图提速。普通、关闭 TeaCache、2× Latent 高清及取消恢复的七张对应 PNG 字节完全一致，取消约 0.52 秒，下一张 baseReused=true。

128 MiB 文本 K/V 缓存候选同条件仅改善约 0.01 秒，且普通图输出字节变化，已完整撤回实现、指标和执行版本后缀。大图解码前额外 empty_cache 候选也未显示稳定优势，未纳入最终版本；注意力、采样、VAE 和高清数值路径均恢复为本轮旧版基线。实验曾出现一次 241 秒高清解码并观察到共享 GPU 内存；最终同图约 24 秒且与旧版字节相同，但不能据此宣称任意显存压力下均无 WDDM 分页停顿。桌面部署身份以实际构建及安装回执为准。

## 既有参数对齐与显存策略（2026-10-12 记录）

当前采样身份为 `anima-workflow-effects-v3`，并绑定 `memoryPolicy`。延续 Euler/simple、尾部 N 步、CPU 噪声及 CFG 0.5 对齐，本轮补齐蒙版、KJ RCAS 功能参数、Remacri 羽化/量化及单帧 VAE 路径；该版本曾因旧 Tea 档失配而回退完整计算；本页开头的内置策略已取代日常档案匹配。10 月 11 日的样张/耗时/档案只属于原版本。

本机控制室可选“模型常驻显卡”或“分阶段加载”，持久字段为 `inference.memoryPolicy`，环境覆盖为 `HUIYU_INFERENCE_MEMORY=resident|offload`，保存后重启。默认 resident 保留热吞吐；offload 沿用 Diffusers ComponentsManager 阶段交接，超过权重预算的文本编码/去噪组件经固定 group offload 按 block/leaf 搬运，VAE 保留组件卸载和既有分块。能放入预算的 transformer 仍在去噪循环内驻留，Remacri 前卸载 Anima。TeaCache 的首层 norm 在分层 onload 后读取，无异步预取；临时包装退出时恢复。LoRA 融合仍逐组件在 CUDA 完成后回 CPU，不改变算术路径，融合阶段仍须容纳该组件。分层调度是当前新增源码范围，不能套用本节历史显存/成图记录，不保证任意 4/8 GB 设备。

GPU packed storage 按组件与 dtype 分开；切底模仅复用字节摘要、精确类型及 dtype 都一致的 Qwen、VAE 和两个 tokenizer。Qwen＋两个 tokenizer 真正复用才保留原始文本缓存；已适配 transformer/conditioner 不跨底模复用。身份摘要使用已有全字节读取，不靠文件名/mtime。完全冷首张仍有哈希和加载成本，当前没有测得冷加载提速。

Resident 加载现在每组件检查完即上传，避免四组件一起持有 CPU 权重；上传按连续目标窗口合并张量，用最多两块32 MiB锁页缓冲与专用CUDA stream交错填充/传输。Event确认传输完成后才复用缓冲，全部传输完成后才发布GPU视图；锁页分配失败使用原直接拷贝，真实CUDA错误仍失败。64 MiB仅是活跃staging上限，PyTorch锁页缓存和进程RSS另计。Offload加载方式不变。`nativeRuntime.loading`记录本次实际组件加载/上传耗时、策略、字节和copy次数，热复用不带旧冷加载耗时。本轮只改变搬运，配方、精度和Tea身份保持；无当前GPU提速/画质证据。

高清保留过期张量清理与解码前释放 Tea 残差。VAE 普通整图先行，单帧禁用跨帧 feature clone；严格 CausalConv 单帧/无 cache 条件截取最后时间核并用隐式空间 padding，RMS 按原 dtype 归一化，latent 统计、raw-latent bicubic 与显示边界用 FP32。仅实际 CUDA OOM 回退：encode256/overlap64；decode 从32 latent 按当前可用显存预算倍增，overlap为tile/4。CPU FP32双侧羽化、累加/权重和归一；不回退精度或 CPU 推理。

Remacri 从512/32网格开始，不再使用192 core＋halo硬裁；只有真实 CUDA OOM 才整次256/128重算。RRDB按CUDA模型设备逐块上传，完整4×结果与Lanczos留CPU；VAE回退CPU像素不会使RRDB误走CPU。Lanczos与PNG均RGB uint8截断。`nativeRuntime.refinement`记录实际VAE整图/分块、tile/overlap/count、输出设备和Remacri块信息。该记录的AMD 880M环境无可用NVIDIA CUDA，当轮无真实模型/测试/部署；数学路径已接入，但kernel/浮点舍入、画面与性能仍须设备验收。

## 控制室切换与结果保护

Native 完成图仍先检查 PNG 格式、32 MiB 上限并完整解码，再将 Worker 已写出的 PNG 原子发布到运行目录 `outputs/anima/native-<任务ID>.png`，复用文件结果、流式读取与作品入库。完成任务不再保留整张压缩图片的内存副本；解码时的短时内存峰值不因此消失。临时结果占用磁盘至任务清理或约 30 分钟到期，晚取消和正常关闭仍清理；启动及现有每分钟维护会回收已过期、无活跃任务的 native 专属文件，切回 ComfyUI 也执行。文件不得由外部程序修改；崩溃落盘不等于新增恢复能力，原生重启中断语义保持，失败清理在后续维护重试。此改动未改变采样、画质或参数，真实连续生成的 RSS、结果读取与取消恢复仍需 CUDA 设备验收。

2026-10-12 源码补齐了独立引擎的显存交接：控制室“绘图优先”按活跃引擎选择入口，native 只检查独立 Python/worker 文件，不启动 ComfyUI，也不丢弃已有空闲 native 驻留。普通 API 与持久任务实际进入 native GPU 槽后，先停止应用持有的 llama.cpp。控制室概览分别说明所选引擎与入口文件状态，不将文件存在认作依赖、CUDA 或出图通过。

“聊天与语音优先”及 llama.cpp 加载先独占全部 native 任务准入，检查 GPU 槽并停止空闲 Worker；权限保持到服务启动/健康检查结束。已有 prepared、排队、运行或尚在结算的生图返回忙碌，不自动取消。进程退出未确认时阻止新任务与本地聊天继续占用 GPU，排队项保留失败原因，须完全退出并重启应用。应用不停止外部管理的聊天进程。

结果保护继续在原始decoder/tile输出的显示clamp前观察非有限值，并检查VAE输入、Latent放大前状态与Remacri raw tile。v3统一pt输出及最终truncate量化，移除了原PIL分支；采样、蒙版和VAE数值路径按本轮工作流对齐更新，不能沿用初次guard接入时的“数值保持”结论。设备开销/有限样本成图仍待验。

## 第一里程碑与边界

- 使用官方 Apache-2.0 Diffusers Anima 组件，独立 Python 子进程运行，不导入或启动 ComfyUI。
- 已接入本地完整 Diffusers 目录的文生图、图生图、实验性手绘遮罩局部重绘及本地兼容 LoRA，沿用绘遇的任务身份、进度、取消与结果协议。
- 模型目录默认按现有 catalog 的 modelId 组织在 `AI_WORKSPACE_ROOT/inference/models/<modelId>/`；控制室中可配置模型根目录与独立 LoRA 根目录。目录必须包含该权重对应的配置、tokenizer、文本编码器、conditioner、transformer 与 VAE。
- 现有裸 MiaoMiao / Anima safetensors 文件不能简单重命名为完整目录；对应结构与配套资源必须先通过转换器的精确核验；实际出图仍需核验。不同 MiaoMiao 架构不能仅靠名字认定兼容。
- TeaCache 日常使用内置 Anima 策略，默认开启，`teaCache: false` 明确关闭；普通图、LoRA、提示词权重与高清无需逐组合校准，不读取旧校准档。RCAS、Latent / 固定 Remacri 高清与圆括号提示词权重已有指定组合的真实 GPU 证据，其他组合与设备效果仍须实际验收。显式校准档仅供维护研究路径，不构成产品启用条件。任意 RealESRGAN 权重仍不支持；这些 Anima 专用加速和后处理不适用于新增 Krea/Qwen/Wan 入口，不能静默忽略或改采样器完成请求。
- 已支持的 LoRA 格式为原生 Diffusers/PEFT A/B 及官方识别的 `diffusion_model.*` A/B（含 llm_adapter）；另支持经原始模块名及实际 Linear 形状严格核验的 Anima Kohya `lora_unet_*` down/up/alpha 三元组（含 llm_adapter），按 alpha/rank 缩放 B；通用 Kohya 家族、卷积适配器、DoRA、残缺/非有限权重及未知格式明确拒绝。已测角色与模型组合见本轮报告，未知权重仍须实际加载验收。

## 高级：离线运行库准备

以下是高级离线准备器 `prepare-inference.py` 的用法。它不会下载依赖或模型，需要已有受信 Python 和针对目标操作系统、Python 版本、CUDA/驱动准备好的本地 wheelhouse。新电脑优先使用本页开头的应用内受管下载流程。两种流程均由绘遇的独立目录持有运行库，不复用 ComfyUI 环境。

源码目录或安装包 gateway 目录中执行：

```text
python scripts/maintenance/prepare-inference.py --target-dir <AI工作区>/inference --plan
python scripts/maintenance/prepare-inference.py --target-dir <AI工作区>/inference --preflight --wheelhouse <可信离线wheel目录>
python scripts/maintenance/prepare-inference.py --target-dir <AI工作区>/inference --apply --wheelhouse <可信离线wheel目录>
python scripts/maintenance/prepare-inference.py --target-dir <AI工作区>/inference --check
```

源码维护也可通过 `npm run wf -- models:prepare-inference ...` 调用。默认仅预览；只有 `--apply` 安装到新的独立 venv，已有/部分安装拒绝覆盖。失败后先保留目录与错误，选择新的空目标或人工核对后清理，不自动删除已有环境。`--check` 和安装完成检查都调用已打包 worker 的 `--diagnose`，核对完整依赖导入、蒙版/CLIPSeg helper 和 CUDA 可见性，不加载模型、不出图。只有完整诊断成功才生成运行库回执。

`--preflight` 使用当前受信 Python 自带的 pip 做离线 `--dry-run --ignore-installed`：解析全部依赖而不借用当前已装包，缺轮子/平台不兼容会在创建 venv 前报错。它需要支持 `--dry-run` 的已有 pip，不自动升级。`--apply` 总会先执行同样预检。工具仅读本地 wheel 元数据并拒绝 URL 依赖，只把已检查的 `.whl` 文件交给 `--no-index --only-binary=:all: --no-cache-dir`，不跟随目录内 HTML 或使用源码安装包。预检通过不证明真实包可导入或 GPU 可运行。pip 行为参见[官方 install 文档](https://pip.pypa.io/en/stable/cli/pip_install/)。

`runtime-config.json` 保存解释器及依赖回执。发现兼容记录时仅复用 Python，默认 Worker 取当前应用；不采用记录中的历史源码路径，也不改写旧记录。显式已存 Worker 和环境覆盖仍优先。构建不会调用安装步骤。桌面包带 worker、固定下载清单、受管准备器与离线准备器；正常首次配置通过应用从官方源下载并核对大小与 SHA-256，VC++ 安装器另核对微软签名。只有上述高级离线入口需要已有 Python 与 wheelhouse；运行库和完整模型就绪之前不视为可生成。

## 应用内离线准备与完整目录导入

已有资源优先使用“复用并启用独立引擎”；仅缺资源时使用以下准备入口：

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

独立路径支持 Euler 与标准确定性 `res_multistep`，不把后者替换为 Euler。`normal` 与 `sgm_uniform` 使用固定 shift=3、训练表 1000 的数学网格，由官方 Diffusers scheduler 施加一次移位并追加零终点；旧版 24、30 步 CPU sigma 有隔离参考核对记录。`sgm_uniform` 排除末端，`normal` 保留两端。本次 Euler/simple 与 RES/simple 统一抽取 1000 点训练表；图生图与精修都从 `int(N/denoise)` 完整网格取尾部 N 步，并传 strength=1，避免上游再次截短。两阶段改用 CPU FP32 generator；同种子不承诺跨后端逐像素一致。

RES 根据公开指数积分数学独立实现二阶多步更新，flow velocity 先转为 denoised，首步与零终点使用 Euler；每个任务及精修阶段新建状态，图生图 begin_index 清空历史。支持范围为 eta=0、无 CFG++；动态移位、其他 sigma 变换、随机变体和重复 sigma 拒绝。CPU 小 ODE、向量、BF16 输出转换及隔离 `python -I` 加载已验证，不等于真实 transformer、CFG、噪声或成图逐位一致。显式本地校准路径改变 sampler/scheduler 后仍须使用对应范围；日常内置缓存无需重校准。

RCAS 为独立实现的工作流变体：reflect边界、中心＋四邻极值、RGB最负lobe、epsilon1e-6，先乘strength再限幅、reciprocal归一化；沿用KJ固定版本d3cfe216的0.75功能参数。Remacri仍仅接受严格BasicSR RRDB固定权重；Auto解析、Latent二轮/Remacri蒙版二轮条件保持现有工作流。浮点/kernel不同仍不能按源码声称像素完全相等。

二次采样使用新调度器、seed+1 独立噪声及完整网格尾部，保留实际进度。1664×2432 验收暴露的 RoPE 容量 128 小于所需 152 已修复：按本次形状扩展，结束后恢复共享配置。上述四种高清路径已真实出图，已测暖任务 allocator 峰值约 9.33 GiB；冷首张观测为 null，不是零，也不是整卡显存证据。此结果不宣称与 Comfy 节点滑块、像素或性能等价。

历史高清 TeaCache 校准曾按完整两阶段操作采集、拟合和留出对照，GPU 捕获 24+14 次采样更新；阶段切换清空残差。显式维护档的 scope 绑定高清倍率、重绘幅度、实际放大方式、二轮采样器/调度器、精修版本与 Remacri 文件字节，普通单轮档不能复用；日常内置策略不读取这些档案。两角色 Latent 2×、重绘 0.35 的历史档阈值为 0.25、最多连续跳 2 步；宁宁当时两个完整 API 热样本的中位数为 26.610 秒，对照 Comfy 为 23.671 秒，慢约 12.4%，不代表当前策略性能。跳 3 步候选未启用；夏目阈值 0.30 曾出现非有限值并被拒绝，Worker 保留非有限结果发布拦截。

## 提示词权重

支持正向与负向圆括号权重：`(text)` 为继承权重乘 1.1，`(text:number)` 使用显式值，支持嵌套及转义括号。`[]` 和 `BREAK` 按当前 Anima 规则保留为字面文本，不赋予减权或分段语义。Qwen/T5 两路 token ID 与权重规则已有 14 项实际 tokenizer 对照，8 项历史定向测试通过；加权真实 GPU 出图成功，普通提示词对照 PNG SHA256 不变。这些是既有记录，本次不重新运行测试或出图。不平衡括号、非法/非有限权重及超过 512 token 的输入明确拒绝。仅显式维护校准路径按加权 scope 区分档案；日常内置 TeaCache 无需匹配提示词档。token 对齐不等于跨后端成图逐像素相同。

## 高级：手动指定运行库与模型路径

标准首次配置使用上文的“一键准备”，已有完整资源使用“采用并启用”。需要显式指定自有运行库或目录时，在本机控制室“原生生图”展开“已有资源与高级设置”，选择原生引擎并在“高级路径设置”填写模型根目录、LoRA 目录、Python 和 Worker 的绝对路径。保存到运行目录 config.json 的 inference 配置；界面区分当前运行与已保存设置，重启运行时后生效。在途任务使用冻结的旧设置，不会半途切换。

“检查配置与文件”只检查已保存路径；“检查当前运行时依赖与设备”显式调用 Worker 的 `--diagnose`，检查当前解释器内依赖与 CUDA 可见性，不加载模型、不生成图片、不安装软件。CUDA 可见不等于显存足够或实际出图成功。设置与诊断 API 继承既有本机控制面的 Host/Origin、直接 loopback 与代理头限制，不开放给远程控制请求。

生成界面默认使用内置 TeaCache，不按旧档案精确匹配；关闭后完整计算。显式维护候选仍按各自 scope 和验收约束执行，不能据文件存在启用。蒙版与原图等比缩放并居中黑边，手绘读取RGB红通道，用反复五点最大值形成tapered增长。有效float蒙版先trilinear缩到潜空间，高清nearest-exact放大；模型输入在当前sigma混合原噪声参考，denoised再混合干净参考，RES历史保持该约束；最终合成仍使用同一软蒙版。上传素材与catalog LoRA授权、原图/遮罩不可变副本协议保持。

开发覆盖仍可使用 `HUIYU_IMAGE_ENGINE`、`HUIYU_INFERENCE_PYTHON`、`HUIYU_INFERENCE_WORKER`、`HUIYU_INFERENCE_MODELS_ROOT` 与 `HUIYU_INFERENCE_LORAS_ROOT`。界面显示覆盖来源并拒绝保存冲突值；不要指向未验证脚本。独立路径找不到运行库、模型或不支持请求时返回明确错误，不借用 ComfyUI。

## 实验性自动遮罩

在配置的模型根目录下放置 `clipseg-rd64-refined/`，需完整的 `config.json`、`preprocessor_config.json`、`tokenizer_config.json`、`special_tokens_map.json`、`vocab.json`、`merges.txt` 和 `model.safetensors`。不接受只有 pickle/bin 权重的目录，也不会代为下载或转换它。状态只检查文件存在、非空与目录边界；实际结构、完整加载与分割质量仍在执行时验证。

自动模式保留重复的 `|` 区域词，将CPU float32 CLIPSeg logits按所有词求均值，经Torch bilinear、3次5×5 reflect平滑、sigmoid阈值、正方形膨胀及3次25×25 reflect羽化。有效蒙版保持float，不再量化L图或二次手绘扩张。驻留模型/小logits/conditioning缓存仍有边界和完整字节身份；缓存均值logits，阈值/增长/模糊每请求处理。AP MIT后处理许可随包保留；当前v3的分割质量与CPU开销未实测，旧样例不验证新边界。

自动遮罩在模型指纹、加载、图像预处理、短语编码批次和蒙版后处理之间检查协作取消，缓存命中路径同样检查。取消异常沿既有路径清理遮罩缓存，再由 Worker 确认 `cancelled`／`ready`；单次哈希、加载或 forward 不可中断，不保证在宿主 10 秒宽限内完成取消。本次仅完成源码复核与 Python 语法编译检查，未实测取消耗时或模型效果。

Transformers 实现许可证为 Apache-2.0；CLIPSeg 权重许可独立于代码许可，本次未下载或分发权重，尚未核实所选权重的发行许可。用户需使用有权使用且已准备的可信本地 safetensors 配套。

## 历史接入证据与当前验收边界

以下 1、2 项为初次接入原版本的历史验证记录，仅对应当时源码、产物和环境，不是当前受管版本的门禁或设备验收。当前工作遵循 [AGENTS.md](../../AGENTS.md) 的禁测约束，通过源码、差异与必要构建核对改动；模型与设备效果仍按实际授权人工验收。

1. 原版本曾完成无 GPU 的 Python 参数/协议测试与 Rust 源码审查，只证明当时相应逻辑。
2. 原版本云端曾用与当时 CI 一致的 Rust 1.98.1 minimal 和 locked Cargo 完成 Linux 编译；native 定向测试 21 项通过，另有 1 项无关 libvips 设备测试按既有条件忽略，设置持久化定向测试 1 项通过。均为当时协议/隔离夹具，不是当前受管运行库、实际模型或 Windows 验收。
3. 主力设备：先退出 ComfyUI，确认端口关闭；只启用 native，选已准备的模型执行一张文生图；检查进度、取消后显存释放、重新提交、结果入册和重启恢复。
4. 每种 Anima/MiaoMiao 权重分别验收；记录模型哈希、配置来源、依赖版本、种子、耗时、显存和成图。不得用一种权重的成功替代所有家族兼容结论。

依赖代码许可证与权重/模型卡许可分别核对。未搬运 ComfyUI 的 GPL 实现；使用官方开放库仍需随运行包保留适用许可证和通知。


## TeaCache 本机校准与验收

本节仅为显式维护研究路径，日常出图使用内置策略，不需要执行这些步骤；禁止测试期间不得运行采集、比较或验收命令。

本轮另实现维护候选 `local-guard`（schema3 / `huiyu-anima-local-guard-v1`）：按每批最多16个连续raster token组的相对L1峰值，与全局均值分别校准三阶段关系；两套累计预算都允许才复用。它是粗粒度特征风险筛选，不识别脸/手部，不构成画质误差界。生成两指标合并一次读回，局部残差指标仅全算校准时采集。原phase/poly路径不执行此额外计算。

后续在授权CUDA设备用同一维护入口的 `--strategy local-guard` 生成新候选目录，`--local-threshold` 可单独给局部门槛，不提供时使用本次 `--threshold`；都需在0.01–1范围内。默认strategy仍phase-envelope，不加 `--run` 只有计划。本轮没有实际采集、拟合、接受或安装任何档案。schema3独立成族，产品选择明确排除它，即使将来存入集合也不会覆盖或自动取代原算法；后续实际使用时再选择与接入。

独立 Anima/Cosmos 路径已实现首层 norm1 代理与整个 transformer block 栈残差复用，实际跳过 attention/MLP；模型外层预处理与输出层仍运行。按 CFG 分支独立缓存，每任务新建缓存控制器；受控 Worker 串行复用已加载权重，实际首尾采样步全算，连续跳步有上限，条件、形状、设备或时间序列变化清理缓存，异常恢复原调用。图生图及手绘/CLIPSeg 遮罩继续执行原逐步约束与最终合成，不把缓存当换装算法。

实现针对固定 Diffusers 0.41.0 的标准 Anima/Cosmos 结构；不能推及所有 MiaoMiao 版本。本节维护路径使用本机拟合系数，日常引擎使用上文的内置 Anima 策略。官方 TeaCache 的 Apache-2.0 许可随包保留；其 Cosmos 示例不是 Anima 校准证据，权重许可另计。

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

验收入口再次核对资产、源图片/遮罩和报告输出，要求每个留出缓存任务确有有限数值跳步，重新计算端到端中位数比且确实快于基线，才写入所选模型目录 teacache-profile.json。已有档不会自动覆盖；明确替换需提供其 `--replace-profile-sha256`。仅显式指定校准档的维护请求使用已接受档；显式关闭不会被验收或模型切换覆盖。

同一固定文件现在可存最多 16 份、合计不超过 64 KiB 的校准集合。不同 runtime、角色 LoRA、强度、尺寸等范围分别保存；worker 只选择精确匹配的一份，无匹配或重复范围明确拒绝。接受新范围会保留旧范围；追加或替换均需提供旧整文件 SHA256，并通过独占接受锁和原子写入发布。异常中断留下的 `.teacache-profile.lock` 需先人工核对，不自动抢锁。

校准器可显式传 `--max-consecutive-skips 2`（支持 1–3，默认仍为 1）。该值只是候选的连续跳过上限，首尾步和累积误差阈值仍生效，必须重新执行留出对照及画质验收；不减少请求的调度步数，也不全局改变现有档。

校准档严格绑定模型各组件文件字节、LoRA 与强度、尺寸、步数、CFG、dtype/设备、执行模式及版本、图生图强度、手绘/自动遮罩及其参数与 CLIPSeg 资源；新范围还绑定正值 RCAS、提示词加权模式及完整高清操作/超分权重。改变这些条件需重新校准；每个启用任务通过完整哈希或仍受保护的租约核验身份，成本必须纳入实际收益判断。界面看到校准文件只表示文件存在，最终由 worker 验证身份与验收记录，不代表任意配置都已通过验收。当前已安装的本机校准范围见上文。

## 模型驻留与分阶段缓存候选

独立引擎以 `--serve` 串行执行任务，复用一份模型／LoRA 权重，连续任务无需重新启动 Python 或重新搬入同一份权重。每任务核对完整字节身份或仍有效的受保护租约，新加载后继续核验；基座变化会重载。普通 LoRA 换组先恢复融合基座，再尝试严格同拓扑 hotswap；不适用时完整卸载 transformer 和 text_conditioner 的适配器再加载，空组恢复无适配器基座。可能改写基座的初始化或未核实变体仍整组重载；同组仅变强度更新权重，融合模式同样先恢复。每次创建新的管线块、调度器、CFG 与 TeaCache 状态，不保留 seed 或中间潜变量；文本编码使用下述有界 CPU 缓存。成功任务的 `result` 后必须收到同身份 `ready`，才允许接收下一任务；取消若收到同身份 `cancelled` 后的 `ready`，或任务已产出 `result` 后收到 `ready`，可保留清理完成的常驻 Worker。未确认的取消、故障、超时和退出才终止所属 Worker；GPU 槽持续持有至清理或进程停止确认及任务结算，之前不放行后续任务。最后一次任务完成后连续空闲 10 分钟才释放进程与模型；复用会取消旧计时，任务结束后重新计时，进行中的任务不会被空闲回收打断。显式退出桌面软件立即清理自有进程，不等待空闲期限。

校准默认采用 `phase-envelope`：按实际采样进度分为三个阶段，保留各阶段观测到的变化峰值；超出观测范围或跨阶段时全算刷新。每阶段至少三个有效配对样本及两种代理变化；最多 32 个保守边界压缩数据，避免一个全局多项式平滑掉局部峰值。它仍是经验性误差估计，不能保证人物、纹理或换装边缘的画质。原 `--strategy polynomial` 可作算法对照，已有 v1 档仍按原策略执行。两种策略均要求人工验收；显式维护路径只选择已接受的精确匹配档。

校准与留出对照默认复用同一份已加载权重，双方须有 `modelReused=true` 证据；`--no-resident` 可另测冷任务。进程创建开销单列，Python 导入与首次模型加载计入首个训练任务；暖任务总耗时包含指纹、编码、采样、解码和写图；每任务重置 CUDA 分配峰值。两种模式不能混为同一速度结论。RTX 4070 Ti SUPER 的实际配置和原始证据见性能续报。

## 办公机完成的准备与文本缓存

驻留 Worker 仅在首次任务核对依赖并加载辅助模块，后续复用已验证的运行代码；单独诊断仍重新检查，更新运行库或脚本后需重启。办公机阶段逐任务全量哈希；当前主力机路径使用上文的受保护租约，完整哈希走 Windows CNG 或其他平台的 hashlib，未改为按文件名／时间复用。

相同文本换 seed 的任务复用 Qwen 编码与 T5 token／mask，CPU 缓存最多 4 项、16 MiB；按文本、负面词、序列上限、CFG 分支、dtype 和设备区分，重载／释放模型时清空，任务获取独立张量副本。LoRA 仅作用于 transformer／text_conditioner，后者每任务仍运行，因此强度回切可复用基座和原始文本编码。基座字节改变仍重载；普通适配器换组现在按上文的 hotswap／卸载加载规则执行，可能改写基座的变体退出时保守重载。

结果事件记录文本缓存命中、未命中与保留字节数。TeaCache 速度对照双方明确关闭文本缓存和 CLIPSeg 模型／结果缓存，运行与验收均要求明确的禁用证据，避免第一侧未命中造成比较偏差。旧测量报告缺新 mask 缓存证据时不能用于新的验收；已安装的已验收 profile 不改写。主力机保留真实权重加载、GPU 耗时／显存、画质和取消释放验收；办公机的模拟模型及小组件验证不替代这些结果。

办公机已用隔离 Python 3.11 与全部锁定版本（Torch 2.8.0+cpu、Diffusers 0.41.0、Transformers 5.10.1、PEFT 0.19.0 等）执行真实 CPU 小组件：随机 Qwen／Cosmos／text_conditioner／VAE、当地构造的 tokenizer，确认缓存编码与原始编码一致、两个 LoRA 组件强度回切恢复相同输出、新调度器与文本释放，以及两次完整 64×64 小管线文本复用。它只产出随机小组件噪声，未加载真实 Anima/MiaoMiao 权重，不作为画质或 GPU 速度证据。安装只在被忽略的 runtime/office-anima-cpu/ 中，不改系统 Python、ComfyUI 或产品 CUDA 准备契约；首次 CDN 下载不完整且哈希失败，改用经响应核对的官方主域名后保留原 SHA-256 核验并成功安装。

本机证据位于 runtime/office-inference-20261010/：cpu-smoke/report.json 与 hash-benchmark.json。32 MiB 合成文件、暖文件缓存、每方案两次交替读取中，SHA-256 相同；流式读取的 Python 分配峰值从约 16.0 MiB 降至 0.26 MiB，耗时中位数约 37.4 ms／30.0 ms。这是该读取样本，不能推广为模型加载或出图增益。源码、夹具输出与其范围分别记录；实际权重与 GPU 最终验收仍保留。
