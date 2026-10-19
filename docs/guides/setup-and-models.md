# 换机离线体验与本地模型配置

新机器先安装桌面程序和完整素材包，随后按需要准备本地 AI 服务。**素材包提供角色、场景样张和浏览所需图片；生图、视频、对话、反推和 AI 配音需要各自的模型及运行环境。** 当前 Anima 生图从控制室的“原生生图”一键准备开始，支持设备、完整模型与许可见[独立推理指南](independent-inference.md)。文件存在或下载校验通过，不能代替真实功能验收。

> 整理日期：2026-10-14。公开 1.9.2 的能力以[发行说明](../releases/v1.9.2.md)为准；当前源码与实际安装身份分别核对。宁宁、夏目 Anima v21 绘图 LoRA 仍使用 [1.9.0 独立附件](https://github.com/starplatium1129-stack/huiyu/releases/tag/v1.9.0)；声线与参考库是独立资源。安装见[离线资源指南](offline-resources.md)，启动见[STARTUP](../../STARTUP.md)。

## 1. 一台新机器需要哪些交付物

| 使用范围 | 需要准备 | 断网后验证 |
| --- | --- | --- |
| 完整素材浏览 | 匹配版本的桌面安装包、完整资源 ZIP、发布处的 SHA-256、离线导入脚本；桌面运行前提按离线安装指南准备 | 首次打开角色、场景、热门蓝图、画师、LoRA 样张及原图；检查 Live2D 和深浅主题 |
| PixAI 图片反推 | 固定 PixAI v1.0 权重与配置、CUDA 可用的 Python/PyTorch 环境及独立 timm；按 [准备入口](../workflow.md#pixai-本机反推准备) 生成 runtime-config.json | `/api/interrogate/status` 的 pixai 就绪后对本机图片反推；连续使用复用模型，连续空闲 10 分钟后回收 |
| Anima 生图 | 原生引擎：受管独立运行库与完整 Diffusers 模型；ComfyUI 引擎：其环境、底模＋文本编码器＋VAE及工作流节点 | 控制室确认当前引擎与资源，`/api/anima/status`，再生成一张所选模型的图 |
| Krea 2 生图 | ComfyUI、下述 Krea 2 三件套；选择风格时另需相应 LoRA | `/api/creative/status`，再生成一张图 |
| 旧 SD/WAI 作品 | 新生成已在源码退役，保留旧作品、配方原值、原任务查询／取消 | 不跨引擎冒充恢复原生成参数；可选择沿用文本、画风与构图 |
| 本地视频 | ComfyUI、Wan 或 H3 的完整权重与节点、可用 FFmpeg | `/api/video/status`，生成并播放短片，H3 另验音频 |
| 本地对话 | 绘遇受管 llama.cpp 与所选 GGUF；显存较少优先 API；已有 Ollama 可保留连接 | 一次短对话、取消与绘图后的按需恢复；实际速度按设备记录 |
| 中日翻译＋角色 AI 配音 | 下述 M2M100 与 Python 依赖；按所选引擎准备 GPT-SoVITS 环境及角色双权重，或 VoxCPM2 环境、基座与角色 LoRA；两者都需参考音频及原文 | `/api/tts-status`，分别验翻译、配音和口型 |

控制室的“图片反推”区只显示简短状态；画室入口正常时只显示操作，检查中或异常时显示简短提示。安装命令、依赖与缓存诊断不作为产品文案展示，准备步骤见下文和工作流文档，请求失败详情保留在诊断日志。上传执行前仍会重新核对当前 PixAI 文件／依赖状态。文件被发现不等于 CUDA 或模型加载成功。桌面暂没有反推一键安装，源码维护准备必须使用当前运行时实际读取的目标目录，或通过启动进程继承的 `AICS_PIXAI_CONFIG` 指向真实 `runtime-config.json`；不能把源码默认输出目录当作已安装桌面的目录。反推只提取词条，不自动把所选图变为换装底图；局部换装需在换装窗口导入原图或使用当前成片。

远程 API、Ollama 云端模型、公网分享、在线下载和更新需要联网；选择这些能力不属于离线验收。默认图片和台词预览不证明 AI 生成可用。浏览器/系统语音也需本机已安装的对应语言声音。

**完全断网的新机**应在一台联网准备机上提前下载程序、驱动、模型和依赖，再经移动硬盘复制。除权重外还要保留 ComfyUI/WebUI/GPT-SoVITS 的版本、custom_nodes/扩展、Python/PyTorch 版本及离线安装材料；裸 `models/` 文件夹无法恢复运行环境。普通 Python venv 可能包含旧机器绝对路径，换路径后应由该上游的离线安装材料重建。授权不明确的私有资源单独保留，不混进公共 ZIP。

### Windows 原生前置：VC++ x64 离线安装材料

源码已退出 ORT 依赖与新包载荷，旧 DLL 不作为当前包前置条件；按实际原生程序及模型环境核对运行库。WebView2 与 VC++ 用途不同，安装它们不代表 PixAI 的 Python、CUDA/PyTorch 与权重就绪。在联网准备机可用以下入口准备微软原始安装器：

```powershell
# 默认只打印计划；不会下载、安装或写目录
./scripts/maintenance/prepare-offline-prerequisites.ps1 -Out 'D:\HuiyuRelease\prerequisites'
# 显式下载到一个新目录；不会运行下载的 EXE
./scripts/maintenance/prepare-offline-prerequisites.ps1 -Out 'D:\HuiyuRelease\prerequisites' -Apply
```

该入口只使用微软官方 `aka.ms/vc14/vc_redist.x64.exe`，验证有效的微软 Authenticode 签名，记录实际字节、SHA-256、文件版本和来源；全部完成才发布输出目录。签名证明这份微软材料的来源，不授予素材包或其他程序安装授权。准备机不执行安装，公开分发前仍需按微软条款核对分发资格。[微软下载与版本要求](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist)

把 `vc_redist.x64.exe`、对应 `.sha256` 和 `prerequisites.json` 与绘遇发行附件一起带到新机，校验值从受信发行说明取得。**新机用户先手动运行微软 x64 安装器，处理许可、UAC 与可能的重启，再安装绘遇、完全退出、导入素材包并重启。** 不从旧机复制系统 DLL。需要图片反推时，完成 PixAI 配置后另做一次断网反推，不能以安装器退出或图片包导入成功替代推理验收。

## 2. 目录与运行时的对应关系

建议在可写数据盘统一放置 AI 工作区，并在启动桌面程序/网关的环境中配置：

```powershell
$env:AI_WORKSPACE_ROOT = 'D:\HuiyuAI'
$env:AICS_PIXAI_CONFIG = 'D:\HuiyuAI\PixAI\runtime-config.json'
$env:AICS_TRANSLATION_MODEL = 'D:\HuiyuAI\Voice\models\translation\m2m100_418m'
$env:TRANSLATION_PYTHON = 'D:\HuiyuAI\GPT-SoVITS-env\python.exe'
```

桌面端还要在「AI 工作区」设置中用「选择文件夹」选择 `D:\HuiyuAI`（或手动输入路径）；保存后完全退出并重启绘遇生效，不会自动移动文件或中断当前生成。已保存目录与本次运行目录可能不同，不能只改变终端的扫描变量。上面的 PixAI 配置必须先由准备入口生成；PixAI/翻译的独立环境变量需由启动绘遇的进程继承。普通新机可以提前复制下述文件，不需要安装 Node 运行下载脚本。

```text
D:\HuiyuAI\
├─ inference\                  # 原生 Anima 运行库与完整模型
│  ├─ <runtimeId>\             # 独立 Python 与固定依赖
│  ├─ models\                  # 完整 Diffusers 模型目录
│  ├─ .downloads\              # 受管下载缓存
│  └─ .staging\                # 未发布候选
├─ ComfyUI\                    # ComfyUI 引擎环境、custom_nodes、input、output
│  └─ models\
│     ├─ diffusion_models\     # Anima / Krea 2 / Wan / H3 的所选底模
│     ├─ text_encoders\        # 各模型专用编码器
│     ├─ vae\                  # 图像、视频、音频 VAE
│     ├─ loras\                # 所选角色/风格/视频加速 LoRA
│     └─ upscale_models\       # 可选超分权重
├─ PixAI\                     # 本机准备入口生成；Python/Torch 另按配置提供
│  ├─ model\                  # 固定权重、代码与配置
│  ├─ deps\                   # 独立 timm 依赖
│  └─ runtime-config.json     # 指向本机解释器、模型与依赖的绝对路径
├─ GPT-SoVITS-env\             # 翻译和语音的已准备 Python 环境
└─ Voice\                     # GPT-SoVITS、声线、参考音频、翻译模型
```

原生 Anima 从 `AI_WORKSPACE_ROOT/inference/` 发现受管运行库，完整模型位于 `inference/models/`；已有资源和显式路径覆盖见[独立推理指南](independent-inference.md)。ComfyUI 引擎的图像/视频权重检查根是 `AI_WORKSPACE_ROOT/ComfyUI/models`，源码服务缺省为应用同级 `AI/ComfyUI/models`，桌面使用选定的 AI 工作区。PixAI 的配置查找顺序见下方准备说明；旧 `AICS_WD14_MODEL_DIR` 不配置现行反推。外部 ComfyUI 若放在其他目录，可通过受控目录链接/上游模型配置使双方引用同一批真实文件；仅修改 `COMFY_HOST` 不会改变本机权重检查目录。`COMFYUI_MODELS_ROOT` **只改变体检扫描**，体检会报告它是否与网关目录一致。

选择 ComfyUI 引擎时，新 Portable 的可执行环境放在 `AI_WORKSPACE_ROOT/.runtimes/comfy/ComfyUI`，模型仍使用上述 `ComfyUI/models`。绘遇受管启动显式指定 `ComfyUI/input`，图生图、蒙版与视频输入不随 Portable 安装位置漂移；外部服务需自行对齐模型及输入目录，仅改连接地址不会搬运这些文件。

只有在控制室明确启动且由绘遇持有的 ComfyUI 才保存托管意愿，并绑定当前地址与安装目录。重开应用只恢复地址和安装目录均匹配的意愿，不立即占用 GPU；旧配置只有布尔标志时，先用“启动现有环境并重新检查”确认一次。Anima/Krea 2 显示“生成时自动启动”后，提交会先检查本地资源，再复用现有管理器唤醒服务。手动停止会关闭这一意愿；已在线的外部服务不会因此被接管。取消一张图停止该提交的等待，不中断其他请求共用的服务启动；控制室可取消启动，退出绘遇会清理自有进程。

上游只支持本机 loopback：`SD_HOST` 默认 `http://127.0.0.1:7860`，`COMFY_HOST` 默认 `http://127.0.0.1:8188`，`TTS_HOST` 默认 `http://127.0.0.1:9880`。地址/角色声线可在控制室保存；更换机器后重配参考音频和权重的绝对路径，不复制旧 PID 当作新服务已启动。

### 首次配置与一键准备

初次打开本机会显示欢迎入口，进入控制室的“原生生图”区。先选择 AI 工作区；保存的新目录在重启后生效，桌面可点击“重启并继续”，先确认个人配置写入再重启。浏览器连接已准备的本机服务，目录选择仍由桌面宿主完成。

原生首次配置按“选择位置 → 自动准备 → 开始创作”显示进度。核对设备、空间与许可后点击“一键准备”，同一后台操作安装独立运行库、下载并校验完整模型、保存原生引擎设置；按页面提示重启后确认当前引擎与资源，再开始创作。当前受管模型为官方 Anima Base v1.0 的完整 Diffusers 目录，使用前须接受其非商业许可。运行库与模型固定清单分别见[受管运行库](../../tools/inference/managed-runtime.windows-x64.json)和[受管模型](../../tools/inference/managed-models.json)，设备支持与离线入口见[独立推理指南](independent-inference.md)。

已有完整原生资源可在“已有资源与高级设置”中“采用并启用”，手动绝对路径仅用于高级配置。目录发现、依赖检查和下载校验不等于真实出图。新目录尚未生效或当前目录未确认时，不沿用旧检查结果显示完成。模型未准备的机器仍可进入画室选择角色、场景并准备草稿，实际生成留到模型与设备就绪后。

#### ComfyUI 绘图与可选本地聊天

选择 ComfyUI 绘图或本地聊天时，在控制室展开“ComfyUI 与本地聊天”，按所选能力准备下述环境和模型。Portable、KJNodes、ComfyUI TeaCache 与单文件底模清单适用于 ComfyUI 引擎；原生 Anima 使用上面的独立运行库与完整模型流程。

绘图首选 **MiaoMiao Harem Anima 1.6**，其次 **Base v1.0**；选择不同底模后，检查与下载清单跟随该底模，不要求全部候选同时存在。共享 Qwen 编码器和 VAE 复用，宁宁／夏目角色 LoRA 可随组合下载。 不准备这两份 LoRA 时，请使用支持无专用 LoRA 的热门角色与底模组合；宁宁／夏目创作仍需对应权重，扩层 2.9B 的兼容限制见下方清单。模型卡展示用途、来源与使用条件；只有用户确认当前目录与组合并点击准备后才下载或运行环境代码。

未完成的底模、聊天、LoRA 与运行包选择按 AI 工作区保存，重开后须重新确认清单，不会自动续下载或启动；已有安装仍以已验证的运行包记录为准。离开控制室后返回，可重新核对并显示此前已确认的本工作区准备／受管启动操作，按原操作 ID 安全取消；操作结束后重新读取真实环境状态，不接管其他服务操作。

本地聊天放在可选分区，硬件推荐不会自动把聊天模型加入绘图下载组合；选择聊天模型后需重新确认准备清单。未选择任何能力时，准备按钮不可用；使用 API 聊天可直接在角色房间配置。

自动环境起步面向 Windows x64＋NVIDIA。受管 ComfyUI Portable、独立 Python、KJNodes 和 Anima TeaCache 先在工作区暂存完成，再整套发布到 `.runtimes/comfy/`；模型保持在 `ComfyUI/models/`，由自动生成的模型目录配置关联。已有 ComfyUI 环境和文件保留；`.venv` 或未识别布局只准备模型，不自动安装扩展或接管启动。已有外部管理环境沿原入口启动，缺项与冲突明确报告，不强行覆盖。设备尚未上报时仍可选择绘图组合，不把未知状态当作无显卡结论。

受管 Portable 首次准备会保留所选 CUDA 变体和固定运行包摘要。已有就绪环境始终沿用，选择框变化不会切换 CUDA。需要重新准备环境时，仅复用同一身份；所选 CUDA 13／12.6 变体或运行包版本不符会提示“本次未切换”，不会覆盖旧环境。旧版或外部 Portable 缺少该记录时，标为无法确认版本：仍可用下方“启动现有环境并重新检查”或原入口继续使用；确需更换运行包时选择新的 AI 工作区准备；不补写未经核实的身份，也不替用户删除环境。已有 `venv` 只准备节点，保留其 Python／CUDA。

已有 KJNodes／Anima TeaCache 不能仅凭目录存在算完成：准备过程会用已校验节点包对照 Python 源文件和依赖声明，缺失或不同会报告具体节点与文件，保留原目录。用户可用原环境的管理方式修复，或自行备份并移走该节点目录后重试；只有匹配固定源码的既有节点才补装声明依赖。此检查和安装成功仍不证明节点已加载，后续必须检查 ComfyUI 节点注册，真实出图仍属目标设备验收。

补装或修复节点前，必须先结束当前生成并停止 ComfyUI。绘遇会阻止向仍在运行的绘图环境安装依赖，不会凭一次空队列检查自动杀进程或重启。受管服务在控制室停止；外部服务从原入口停止。准备完成后重新启动并检查节点注册，不能只因安装脚本结束就视为节点已经加载。

工作区整体搬盘后，重新选择目录并重启绘遇；新的安装路径仍需显式启动确认受管身份。每次受管启动使用绘遇专用模型映射，将当前工作区的 `ComfyUI/models/` 放在旧路径之前，输入仍使用当前 `ComfyUI/input/`；不覆盖用户的 `extra_model_paths.yaml`，不借搬盘放宽自动唤醒授权。

已有 Portable 或受支持的 `venv` 可直接点击“启动现有环境并重新检查”：只启动已有解释器并重新读取模型、连接和节点，不重新准备运行包、不切换 CUDA。旧 Portable 缺少准备凭据或变体未知时可用此入口；`.venv` 和未识别布局仍沿原管理器启动。已验证的受管 Portable 变体用于首次默认选择，后续刷新不覆盖用户本次手选。取消或启动失败后保留原环境，缺少模型/节点时仍显示未完成。

llama.cpp 固定 b10516，提供 CUDA 和进阶 Vulkan 运行包。默认纯文字、短上下文、关闭深度思考；聊天前释放空闲受管绘图模型，绘图前释放受管聊天模型。加载有取消和期限，子进程由 Rust 持有并在退出时回收；空闲五分钟可睡眠。服务使用仅在后端内存中的访问密钥，新人不必额外填写本地模型 Key。已有 Ollama 作为连接选项保留。

CUDA / Vulkan 选择仅用于尚未安装聊天运行环境的首次准备。若 `Chat/runtime/llama-server.exe` 已存在，控制室明确显示沿用现有环境，本次只准备所选模型；不会把上次选择的运行包名称当作已安装类型，也不会静默替换程序。当前自动准备不支持切换已有聊天运行包，显卡兼容问题需先停止聊天服务并核对运行目录；模型位于独立的 `Chat/models/`，不要为切换运行环境删除模型或聊天记录。

| 标称显存 | 推荐候选 |
| --- | --- |
| 无独显／4 GB 及以下或尚未确认 | API 聊天；CPU 小模型留作进阶选择 |
| 6–8 GB | Qwen3.5 4B Q4_K_M，约 2.74 GB 权重 |
| 10–12 GB | Qwen3.5 9B Q4_K_M，约 5.68 GB 权重 |
| 16 GB | Qwen3.8 27B IQ3_S，约 12.04 GB；余量紧张选 9B |
| 24 GB 及以上 | Qwen3.8 27B Q4_K_M，约 16.46 GB |

这是待设备验证的产品分档，不是测出的最低运行要求。显示设备总量，启动按实际余量处理；上下文、投影、并发与系统内存都会影响峰值。ComfyUI 与本地聊天准备清单的来源、revision、字节与摘要统一在 `runtime-rs/src/control/setup-models.json`，不跟随上游“最新”自动替换。

每个下载只接受已登记 ID 与当前工作区，先检查磁盘；同名文件经过大小和 SHA-256 相符后复用，异内容保留并报冲突。取消／网络中断保留已接收部分；支持 Range 的来源按精确 Content-Range 续传，不支持时重新下载，最终完整摘要相符才原子发布。前端下载与校验使用同一清单，不接受任意 URL 或输出路径。

绘图准备结束后重新核对所选工作区、模型组合、服务连接和节点注册，检查未完成时不显示准备成功。 点击“生成第一张图片”会把刚准备的底模带入画室，包括之前已打开的画室；检查失败或正在生成时保留原选择。基础模式和重开不会仅因默认推荐改回未下载底模，宁宁／夏目切换仍同步各自 LoRA；用户随后明确改模型或载入作品配方时，以新选择为准。真实生成一张全龄图，或对所选聊天能力发送一条短消息，仍需在目标机器另行验收；文件／服务就绪不等于出图、语音或设备性能验收。驱动、UAC／系统重启、服务商密钥和网站登录由用户完成。高级视频、语音、反推与 Krea 不加入首次必下载组合。

## 3. 公共模型下载清单

原生 Anima 的完整模型清单与准备入口见[独立推理指南](independent-inference.md)。下述图像、视频单文件目录适用于 ComfyUI 引擎；反推、翻译与语音按各自服务配置。容量按 2026-09-30 发布者文件元数据计算，GB 为十进制，GiB/MiB 为二进制。下面列的是**当前绘遇工作流支持的指定版本**，发布页的最新版本不自动成为兼容版本。下载后按清单放置，不以改名替代不同架构/量化。

### PixAI 默认图片反推

默认模型为 PixAI Tagger v1.0，权重约 1.95 GB，支持最多 20 MiB 图片。运行环境要求 Python 3.11 或更新版本；准备入口在下载或安装依赖前检查解释器版本，并将实际版本写入回执。执行 [PixAI 本机准备](../workflow.md#pixai-本机反推准备) 后，Rust 优先使用 `AICS_PIXAI_CONFIG` 显式指定的回执；未指定时依次查找网关运行目录的 `pixai/runtime-config.json`、选定 AI 工作区的 `PixAI/runtime-config.json`。显式回执或已找到的回执无效时，不自动改用另一配置。准备入口复用已有 CUDA Torch 环境，仅在独立目录补齐 timm，不修改 ComfyUI。换机或移动目录后须按新机路径重新生成回执，不能直接沿用旧机的绝对路径。

首次反推需要加载模型，后续请求复用同一个 GPU 进程；最后一次请求完成后连续空闲 10 分钟才回收，新请求复用时取消旧计时，任务结束后重新计时，进行中的请求不会被空闲回收中断。独立生图模型沿用相同的 10 分钟期限。取消活跃请求、进程故障或显式退出软件会立即清理本应用持有的相应进程，不等待空闲期限；关闭窗口隐藏到托盘仍属于运行。开始生图不自动卸载 PixAI。显存不足明确报错，不自动变更模型或回退为演示标签。安装包只带 worker 和固定文件清单，Python 环境与权重仍需另行准备。

### WD14 旧维护工具（不用于现行桌面反推）

WD14 ONNX 已退出 Rust 产品链；现行 `/api/interrogate/status` 只登记 PixAI。以下下载入口仅供仍需旧工具的维护者使用，新机器无需为绘遇反推准备 WD14，也不能用 WD14 文件齐全证明 PixAI 可用。

[SmilingWolf 发布页](https://huggingface.co/SmilingWolf/wd-v1-4-moat-tagger-v2)提供 `model.onnx`（326,197,340 字节）和 `selected_tags.csv`（253,906 字节）。下载后分别命名为 `wd-v1-4-moat-tagger-v2.onnx`、`wd-v1-4-moat-tagger-v2.csv`；二者必须来自同一版本。支持 CPU，不承诺固定耗时。

源码维护环境中执行：

```powershell
# 先看精确 URL、revision、字节与哈希，零下载、零写入
node scripts/maintenance/download-wd14.js --target-dir 'D:\HuiyuAI\Interrogate' --plan
# 实际下载；默认固定的发布者 Hugging Face 源
npm run wf -- models:download-wd14 --target-dir 'D:\HuiyuAI\Interrogate'
```

显式 `--modelscope` 使用第三方 ModelScope 副本，`--mirror` 使用 HF-Mirror；速度和可达性依网络决定，各来源均须匹配固定 SHA-256。旧维护工具使用外部可写目录，并通过 `AICS_WD14_MODEL_DIR` 选择；该变量不改变现行桌面反推引擎。安装器本身不自动下载 WD14。

### Anima：ComfyUI 引擎的底模

[CircleStone Labs 发布页](https://huggingface.co/circlestone-labs/Anima)列出以下三类目录。公共起步首选 **MiaoMiao Harem Anima 1.6**，其次 **Anima Base v1.0**；两者底模均约 4.18 GB，共用编码器与 VAE。选一个底模加两份角色 LoRA 时，权重共约 **5.81 GB**，运行环境与聊天模型另计。Aesthetic v1.1 作为统一默认画风候选保留。

| 放置路径（相对 `ComfyUI/models/`） | 来源 |
| --- | --- |
| `diffusion_models/anima-aesthetic-v1.1.safetensors` | [固定版下载](https://huggingface.co/circlestone-labs/Anima/resolve/f973fc41ec7545364ac9776c2440285f43ff2a30/split_files/diffusion_models/anima-aesthetic-v1.1.safetensors)，4.18 GB |
| `text_encoders/qwen_3_06b_base.safetensors` | [固定版下载](https://huggingface.co/circlestone-labs/Anima/resolve/f973fc41ec7545364ac9776c2440285f43ff2a30/split_files/text_encoders/qwen_3_06b_base.safetensors)，1.19 GB |
| `vae/qwen_image_vae.safetensors` | [固定版下载](https://huggingface.co/circlestone-labs/Anima/resolve/f973fc41ec7545364ac9776c2440285f43ff2a30/split_files/vae/qwen_image_vae.safetensors)，0.254 GB |

其他已接入 Anima 底模共用此编码器/VAE：

| 模型 | 要求的文件名 | 发布者版本入口 |
| --- | --- | --- |
| MiaoMiao v1.2 | `miaomiaoHarem_anima12.safetensors` | [MIAOKA：Anima_1.2](https://civitai.com/models/934764?modelVersionId=3020110) |
| MiaoMiao v1.6（当前默认） | `miaomiaoHarem_anima16.safetensors` | [MIAOKA：Anima_1.6](https://civitai.com/models/934764?modelVersionId=3248362) |
| Anima Yume v1.0 | `AnimaYume_v10_final_base.safetensors` | [v1.0 base final](https://civitai.com/models/2385278?modelVersionId=3065644)；上游名 `animayume_v10BaseFinal.safetensors`，仅这一指定文件按体检哈希核对后改成本机目录名 |
| MiaoMiao Harem Anima 2.9B Beta 1.1 | `miaomiaoHarem_29BBETA11.safetensors` | [MIAOKA：2.9B_BETA1.1](https://civitai.com/models/934764?modelVersionId=3360028)，5.84 GB；替换原 Anima 2.9B Preview v1 选项 |
| Anima Base v1.0 | `anima-base-v1.0.safetensors` | [固定版下载](https://huggingface.co/circlestone-labs/Anima/resolve/f973fc41ec7545364ac9776c2440285f43ff2a30/split_files/diffusion_models/anima-base-v1.0.safetensors)，4.18 GB；源码已补齐无 LoRA 路径 |

MiaoMiao 发布附件中的 `*_txt.safetensors` 与此 Qwen 0.6B 文件 SHA-256 相同，本次核对可复用上述编码器。Civitai 下载可能需要登录；联机准备时记录版本、文件名和哈希。Anima 使用发布者的非商业模型许可，素材包中的生成图片与模型权重分开发行；是否可以分发权重以该模型当前许可及你的授权为准。

2.9B 使用独立的 `anima-miaomiao-2.9b-beta1.1` / `anima_miaomiao_29b_beta11` 身份，旧作品与旧底模文件保留原身份。作者的该版本设置为 Euler / sgm_uniform、28–50 步、CFG 3.5–5；项目起点为 30 步 / 4.5，质量评分词通过最终编译保留。1.6 继续作为公共首选；现有宁宁、夏目及终末地角色 LoRA 尚未在新扩层微调上验收，不声明兼容。下载固定 Civitai 版本 `3360028`、文件 `3247723`，5,843,203,272 字节，SHA-256 `0fb5286099cb6059c5be09c1eb50d222ac6eae9626d761166b7514f8e38ded12`；受限时可使用同大小、同哈希的公开镜像，文件校验与实际出图分别记录。

2026-10-07 本机下载与摘要核对通过，确认 925 个 tensor / 40 层 DiT；在 RTX 4070 Ti SUPER / ComfyUI 0.39.0 上，经 Rust 网关以新模型 ID 生成并目检一张 832×1216 全年龄咖啡馆读书样图（30 步、CFG 4.5、Euler / sgm_uniform、TeaCache 0.08）。最终请求保留评分词，回执确认新 profile、无 LoRA 和所选参数；证据在 `runtime/miaomiao29-integration/`。5 项既有图像契约通过。安装包与实际发行证据见 [当前发行说明](../releases/v1.9.2.md)及[项目状态](../project-status.md)。不以本机样图宣称全库画质或角色 LoRA 已验收。

### 终末地角色专用 Anima LoRA

项目使用 [wwyhahaha 的终末地角色合集 v1.0](https://civitai.com/models/2935110?modelVersionId=3322345)，文件为 `ComfyUI/models/loras/endfield_all_v3-000012.safetensors`（183,953,712 字节；SHA-256 `15fb96bb936df34147e629da91f3beb0af02332eb248b0d634b831497e625088`）。Civitai 下载需要登录，可手动放入当前 AI 工作区的这一目录；模型文件不进入 Git。

登记与训练触发词由 `runtime-rs/src/images/endfield-lora.json` 维护。MiaoMiao 1.6 下，管理员、莱万汀、洛茜和庄方宜在普通生成、批量生成、局部换装及配方恢复时默认使用合集；佩丽卡和伊冯先直接使用底模。其他标准 Anima 底模仍沿用六位角色的合集绑定，扩层 Anima 2.9B 不在该文件的兼容名单中。洛茜触发词为 `rossi (arknights)`，庄方宜为 `zhuang fangyi (arknights)`；编译器保留完整名称并转义标签括号。需要 LoRA 的角色缺文件时明确阻止生成。

2026-10-07 已核对权重摘要、训练词表和六位角色的最终编译文本，并在 MiaoMiao 1.6 + 合集上生成、目检六位角色各一张全年龄样图。随后管理员、莱万汀、佩丽卡、伊冯各增加一张同提示词、同种子及同采样参数的无 LoRA 对照；用户指出管理员面具和莱万汀角形不符，这两张判为不通过并恢复 LoRA 默认。佩丽卡、伊冯的无 LoRA 细节仍待用户最终确认，仅为单张样图判断。证据见 `runtime/endfield-lora-integration/no-lora-review.json`，本次没有追加重画。源码尚未同步到现有桌面安装版。

### Krea 2：当前使用特定第三方编码器

| 放置路径 | 来源 / 约容量 |
| --- | --- |
| `diffusion_models/krea2_turbo_fp8_scaled.safetensors` | [Comfy-Org Krea 2](https://huggingface.co/Comfy-Org/Krea-2)，13.14 GB |
| `text_encoders/qwen3-vl-4b-heretic_fp8_e4m3fn.safetensors` | [DreamFast 发布页](https://huggingface.co/DreamFast/Qwen3-VL-4b-Heretic-ComfyUI)，4.83 GB |
| `vae/qwen_image_vae.safetensors` | 与上面的 Anima 共用，0.254 GB |

三件套约 **18.23 GB**。DreamFast 是社区编码器发布者；它不是 Comfy-Org 原工作流中的 stock `qwen3vl_4b_fp8_scaled.safetensors`，不能下载 stock 文件后改名冒充。发布者标注该 FP8 变体适用于 Ada 及更新硬件，较旧 GPU 的兼容和回退必须实测。九种可选风格文件位于 [Comfy-Org 的 loras 目录](https://huggingface.co/Comfy-Org/Krea-2/tree/eb1eddd3983a54678545a9b2c178c5853b30f7be/loras)，每种约 469 MB，总计约 4.22 GB；不选风格时无需这些 LoRA。

### WAI、角色 LoRA 和超分

[WAI-illustrious-SDXL v17.0](https://civitai.com/models/827184?modelVersionId=2883731) 的 `waiIllustriousSDXL_v170.safetensors` 约 **6.94 GB**。ComfyUI 放 `models/checkpoints/`；WebUI 放其真正使用的 Stable-diffusion 模型目录。宁宁/夏目的 WAI 路径还需要 `ayachi_nene_v18_wd14.safetensors` / `shiki_natsume_v18_wd14.safetensors`；Anima 角色路径需要 v21 对应文件。**Anima v21 两份绘图 LoRA 已公开，均由绘遇作者亲自训练：** [宁宁](https://github.com/starplatium1129-stack/huiyu/releases/download/v1.9.0/ayachi_nene_v21_anima.safetensors)、[夏目](https://github.com/starplatium1129-stack/huiyu/releases/download/v1.9.0/shiki_natsume_v21_anima.safetensors)，各约 92 MB；[清单](https://github.com/starplatium1129-stack/huiyu/releases/download/v1.9.0/huiyu-anima-v21-loras.json)提供精确大小和摘要。下载时保留随附许可与来源通知。旧 WAI 角色权重不作为新用户准备项，AI 配音是独立资源。 未选择角色 LoRA 的公共 Anima 创作与素材浏览仍可单独验收。

超分、CLIPSeg 自动遮罩、ControlNet/ADetailer/Regional Prompter 属于按需扩展，需要对应权重、代码和预处理组件。对支持的基础生图先验一张；选择这些操作后再核对完整依赖，不把可选功能列为普通素材浏览的前置条件。

Anime6B 超分识别官方文件名 `RealESRGAN_x4plus_anime_6B.pth`，同时保留旧别名 `R-ESRGAN 4x+ Anime6B.pth`；显式模型选择只解析该模型的固定文件，Auto 按已有优先级选择。能力展示和新生成记录区分请求选项、实际超分名称与文件，不改写历史作品。高清局部换装继续二次采样，缩放后的有效蒙版同时约束采样与最终合成；未选区域来自对应高清尺寸的参考底图，锐化在最终合成之前。主力机同图的脸部、背景及蒙版边界效果待验，不承诺与原始尺寸图片像素绝对相同。

### 固定运行包的高清与蒙版边界

本轮受管组合固定为 [ComfyUI v0.39.0](https://github.com/Comfy-Org/ComfyUI/tree/v0.39.0)、[KJNodes d3cfe216](https://github.com/kijai/ComfyUI-KJNodes/tree/d3cfe21625e5170126ce06fbfcfe1d88108688c3) 和 [Anima TeaCache e7a73823](https://github.com/CocyNoric/ComfyUI-Anima-TeaCache/tree/e7a73823c057b4884ca6b70778da803c1f60d557)。已用固定源码逐项核对真实生成工作流的节点名、必需输入、枚举、连线类型和输出槽位；RCAS 的 `method.strength` 是该版本支持的动态输入，不需要改成另一套节点参数。此核对不等同于权重加载或目标显卡画质验收。

- 常用 Anima 底模、宁宁／夏目 LoRA、普通高清与手绘蒙版所需节点在这套固定源码中存在；六个底模、两份角色 LoRA、共享编码器和 VAE 的工作流文件名与下载清单一致。2.9B 的角色 LoRA 限制仍按上方说明，不因节点兼容而放宽。
- Comfy 高清可明确选 Auto 或 Latent。Auto 根据当前工作区已识别的超分文件决定路径；未确认时界面显示待确认。普通像素超分不做二次采样，二次重绘幅度不生效；Latent 和局部蒙版高清会二次采样。切换路径保留幅度值，提交时重新核对实际文件。首次基础下载不含超分权重，没有时 Auto 使用 Latent。
- 二次采样步数沿用现有规则：首轮步数的 60% 四舍五入，至少 12 步；MiaoMiao 1.6 使用 Euler / normal，其余当前 Anima 高清默认 res_multistep / sgm_uniform。此处没有新增自动调参或性能承诺。
- 无蒙版“整图重绘”现将原图 VAE latent 接入首轮采样，使用所选重绘强度；这是纠正旧 Comfy 路径忽略原图的既有行为。不能把旧文生图耗时与新真实图生图当作同一工作量比较。有蒙版仍通过噪声蒙版采样和最终合成保留未选区域。
- 文字自动蒙版另需 `AP_CLIPSeg_TextMask` 及其实际模型；Krea 另需 `ConditioningKrea2Rebalance`／`ComfyUI-Krea2T-Enhancer`。这三个节点不在上述固定基础包中，控制室基础准备成功不能视为它们已安装。手绘蒙版无需 CLIPSeg；未知来源扩展不会由一键准备擅自安装。画室会具体显示缺哪个节点，并提供控制面板的环境／准备范围入口；该入口不承诺安装清单外扩展。明确受管但离线、能力待确认时，可显式选择自动识别，启动后重新查节点，通过前不提交工作流。节点注册仍不代表自动蒙版模型已加载。

### Wan 2.2 TI2V 5B

[ComfyUI 官方教程](https://docs.comfy.org/tutorials/video/wan/wan2_2)与 [Comfy-Org 权重目录](https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged)提供三件套，约 **18.14 GB**：

```text
diffusion_models/wan2.2_ti2v_5B_fp16.safetensors
text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors
vae/wan2.2_vae.safetensors
```

上游支持图生视频，但绘遇当前 Wan 5B 适配仅声明文生视频。Wan 14B、HunyuanVideo 1.5、LTX-2.3 在当前目录中为未完成适配，下载它们不会启用绘遇对应功能。

### MiniMax H3：六文件与运行环境一起准备

[Comfy-Org 发布页](https://huggingface.co/Comfy-Org/MiniMax-H3)提供本机工作流的全部六文件，约 **43.99 GB / 40.97 GiB**。保留额外空间给 Python 环境、临时下载和输出；机器有 16 GB 显存并不保证该组合能够运行。

```text
diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors
text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
vae/minimax_h3_video_vae_int8_convrot.safetensors
vae/minimax_h3_audio_vae_fp32.safetensors
loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors
loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors
```

```powershell
node scripts/maintenance/download-minimax-h3.js --models-root 'D:\HuiyuAI\ComfyUI\models' --plan
npm run wf -- models:download-h3 --models-root 'D:\HuiyuAI\ComfyUI\models'
```

两种 Turbo LoRA 都是当前目录必需文件；T8 双时钟路径按选择的 4／8 步匹配对应 LoRA，其他路径使用 8-step。视频 VAE 使用官方 INT8 ConvRot 版（2,811,065,184 字节），原 FP16 文件可保留给历史工作流，不通过改名替换。该加速组合以 ComfyUI 0.39.0、T8 1.93.0 和匹配的 comfy-kitchen／comfy-aimdo 为升级目标；节点版本和权重齐备不替代真实短片验收。参考图、原生音频还需 `MiniMaxH3DualClockSamplerT8`、`MiniMaxH3AudioConditioningT8`、`MiniMaxH3AVDecodeT8` 的已验证本机实现，单有权重不能启用。发布者明确说明 `int8_convrot` 需要 PyTorch cu130；不能用安装了其他 CUDA build 的环境直接承诺运行。NVFP4 编码器不要求必须是 Blackwell GPU，但实际峰值内存/显存、视频长宽和时长仍逐设备测试。

两个下载脚本都用临时文件，完成字节/SHA-256 核对后才替换最终权重；中断不会让半文件被标记为成功。已验证文件复用，中断的那个文件从头重下；Ctrl+C 可取消。同目录的下载锁防止重复启动，强制终止留下锁时，先确认原进程已结束再清理该锁。镜像源不改变哈希要求。精确清单存于 `scripts/lib/model-download-manifest.ts`。

## 4. 翻译、语音和本地对话

翻译使用 [Meta M2M100 418M](https://huggingface.co/facebook/m2m100_418M)，CPU 推理，权重约 **1.94 GB**。完整目录保留 `config.json`、`generation_config.json`、`pytorch_model.bin`、`vocab.json`、`sentencepiece.bpe.model`、`tokenizer_config.json` 和模型说明。预先在指定 Python 环境准备 `torch`、`transformers`、`sentencepiece`，下载时另需 `huggingface_hub`；`pytorch_model.bin` 加载需与当前 Transformers 安全要求兼容的 PyTorch，不能通过降级绕过加载检查。

```powershell
# -Plan 只展示路径与固定版本；去掉后才联机下载
./tools/install-translation-model.ps1 -PythonPath 'D:\HuiyuAI\GPT-SoVITS-env\python.exe' -ModelPath 'D:\HuiyuAI\Voice\models\translation\m2m100_418m' -Plan
```

安装脚本遵守前面的环境变量、只拉取固定 revision 的推理文件，并校验两项大二进制文件。运行翻译时使用 `local_files_only=True`，不会靠 Hugging Face 缓存缺项临时联网补齐。导入后在目标机器逐项做翻译及配音，下载成功不表示 Python 包或实际效果通过。

[GPT-SoVITS 官方安装说明](https://github.com/RVC-Boss/GPT-SoVITS)中除角色权重外，还有模型版本对应的预训练/语言组件。恢复完整版本环境、启动 `api_v2.py`，在控制室为每个角色设置 GPT 权重、SoVITS 权重、参考音频与音频实际原文；只复制一对角色 `.ckpt/.pth` 不足以实现离线声音生成。

选用 VoxCPM2 时，控制室保存 `ttsEngine=voxcpm2`，角色配置使用 `loraWeightsPath`、参考音频与原文；无需为该引擎填写 GPT/SoVITS 双权重。基座与运行环境按[角色语音引擎](../workflow.md#角色语音引擎)准备。`models:check` 的每个声线报告标出所选引擎，并只检查对应角色文件；它不启动语音服务或证明实际发声通过。

Ollama 安装后，在联网准备阶段先取得选定**本地**模型。迁移时同时复制模型目录中的 `blobs` 与 `manifests`，可用 `OLLAMA_MODELS` 指向新目录；Windows 默认在当前账户 `.ollama/models`。在 Ollama 进程环境中设置 `OLLAMA_NO_CLOUD=1` 并重启，避免把云端选项误算本地能力。模型名称、量化、上下文及 `ollama list` 结果一起记录，断网后使用同一个名称。[Ollama 官方 FAQ](https://docs.ollama.com/faq)

## 5. 体检、硬件与新机验收

源码维护环境可执行（桌面普通用户用控制室及离线安装指南）：

```powershell
npm run wf -- models:check --json
# 显式逐字节校验已知权重；大文件会产生磁盘读取
npm run wf -- models:check --json --verify-hashes
```

此体检覆盖图像/视频目录要求、PixAI 配置与固定清单文件、Python/worker/timm/torch 路径、原生 DLL、角色/风格 LoRA、翻译文件/解释器、声线配置和 Ollama 缓存线索。PixAI 按网关相同的回执优先级与 `AICS_PIXAI_*` 路径覆盖选择目录；报告区分回执缺失、已读取和无效，不会从其他模型库拼凑缺失文件。旧 WAI 文件仍单列供保留链路诊断，WD14 不再作为现行反推扫描。

`missing` 是缺失/空文件；`file-present` 只证明有非空文件；`bytes-match` 只证明长度符合已知元数据；`sha256-match` 才证明已知权重字节一致。体检不会启动 Python 或加载模型，包的实际版本/可导入性、CUDA/BF16、上游节点与推理性能仍须另验。准备环境的只读核对用 `npm run wf -- models:prepare-pixai --target-dir 'D:\HuiyuAI\PixAI' --check`：默认复用目标回执保存的 Python/Torch 路径，显式参数和对应环境变量优先，回执损坏时明确失败；复查不会改写回执。应用运行状态用 `/api/interrogate/status` 查看。文件扫描不自动认证引擎就绪。

硬件和资源安排应按目标能力分别核对：浏览不需要绘图 GPU；当前 PixAI worker 需要 CUDA 可用的 PyTorch 环境，不能套用旧 WD14 的 CPU 能力；Anima/Krea/Wan/H3 的量化、分辨率、offloading 与显卡架构共同影响显存和内存。多 AI 服务共享资源，首次验收逐服务单独运行，从受支持的短任务开始，不承诺“大显存就能所有模型同时运行”。

每台新机的交付记录应包含：程序/素材版本与 SHA-256、实际模型文件清单和上游/依赖版本、GPU/内存、配置目录、**断网首次冷启动**及所选能力的一次真实产物。未授权私有资产或未执行能力标为未配置/未验；素材浏览完成与 AI 推理完成分开记录。

## 房间 API 连接

在角色房间打开「对话设置 → llama.cpp / API」，点击「配置 API」；已有配置时，点击当前模型名称（受管服务显示「绘遇本地聊天」）旁的齿轮。选择服务商会自动填入对应 Base URL；从页面的官方入口自行获取密钥，粘贴后点「测试连接」，选择或手填模型 ID，最后「保存并使用」。测试允许先不填模型，只请求该服务的 `GET /models`，**不发对话、不做付费生成探测**。目录可访问不证明密钥有效、余额充足、模型有生成权限或支持全部工具；部分目录公开或不完整，部分服务不提供目录。无目录时按服务商控制台的准确 ID 手填，之后实际聊天按服务商规则计费。

以下为 **2026-10-11 核对的官方来源**。模型目录变化不自动覆盖用户已保存的地址、模型或分服务商草稿；旧 ID 可保留并手动修改。参考列表不是账号授权列表，聚合商和本机代理不硬编码未经证实的模型。

免费入口于 **2026-10-18** 重新核对。新用户的 API 草稿默认使用 OpenRouter 的 `openrouter/free`，需自行注册领取密钥，无需充值；已有连接与分服务商草稿保持原值。服务商选择器优先列出「免费模型与额度」，其后为本机与其他云端服务。免费不等于匿名或无限使用，也不保证所在地可用。

| 服务 | 自动填入的 Base URL | 当前参考 / 获取入口 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` | `deepseek-flash`、`deepseek-v4-pro`；[官方接入与旧 Flash 名称迁移](https://api-docs.deepseek.com/)、[模型版本及价格](https://api-docs.deepseek.com/quick_start/pricing/)、[获取密钥](https://platform.deepseek.com/api_keys)。`deepseek-v4-flash` 已指向 V4.1 Flash，新配置用 `deepseek-flash`，不强改旧配置。 |
| OpenAI | `https://api.openai.com/v1` | 默认 `gpt-6-luna`；[Luna 模型卡](https://developers.openai.com/api/docs/models/gpt-6-luna)、[GPT-6 协议迁移](https://developers.openai.com/api/docs/guides/latest-model)、[获取密钥](https://platform.openai.com/api-keys)。API 单独计费，ChatGPT 订阅不是 API 额度。 |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-3.8-flash`、`gemini-3.5-flash-lite`、`gemini-3.1-flash-lite`；未开通计费的项目可使用对应[免费额度](https://ai.google.dev/gemini-api/docs/pricing)，已开通计费的项目按其方案收费。[官方 OpenAI 兼容接口与模型列表](https://ai.google.dev/gemini-api/docs/openai)、[AI Studio 密钥](https://aistudio.google.com/apikey)。 |
| OpenRouter | `https://openrouter.ai/api/v1` | 默认 `openrouter/free`；[免费模型路由](https://openrouter.ai/docs/guides/routing/routers/free-router)、[密钥](https://openrouter.ai/settings/keys)、[额度说明](https://openrouter.ai/docs/api/reference/limits)。新配置默认「只选免费模型」，获取目录后仅列自动选择与真实返回的 `:free` ID；已有付费模型保持可编辑。自动选择可能每轮换模型，固定同一免费模型更利于保持角色风格。 |
| Groq | `https://api.groq.com/openai/v1` | `openai/gpt-oss-20b`、`openai/gpt-oss-120b`；[Free 方案限额](https://console.groq.com/docs/rate-limits)、[官方兼容接口](https://console.groq.com/docs/openai)、[密钥](https://console.groq.com/keys)、[模型与能力](https://console.groq.com/docs/models)。Free 账户无需购买额度；已升级账户按其方案收费。上述 GPT-OSS 支持文字与工具，不支持图片，使用模型默认推理设置。 |
| 硅基流动 | `https://api.siliconflow.cn/v1` | 先取模型列表；[官方快速开始](https://docs.siliconflow.cn/docs/userguide/quickstart)、[密钥](https://cloud.siliconflow.cn/account/ak)。模型 ID 需包含组织前缀。 |
| 通义千问 / 百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3.8-flash`、`qwen3.7-plus`；[Chat Completions 与模型参数](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)、[获取地域对应的密钥](https://help.aliyun.com/zh/model-studio/get-api-key)。预设为北京地域，工作空间专属域名和其他地域按官方说明修改；不用 Coding / Token Plan 专用密钥替代按量密钥。 |
| Kimi | `https://api.moonshot.cn/v1` | 默认可非思考的 `kimi-k2.6`；[官方快速开始与模型说明](https://platform.kimi.com/docs/get-api-key)、[密钥](https://platform.kimi.com/console/api-keys)。[K3 官方限制](https://platform.kimi.com/docs/guide/kimi-k3-quickstart)要求跨轮完整 assistant 思考上下文，当前房间不推荐或冒充接入 K3。 |
| OpenCode Zen | `https://opencode.ai/zen/v1` | `deepseek-v4.1-flash`、`kimi-k2.6`、`minimax-m3`；[官方模型与各自协议](https://opencode.ai/docs/zen/)、[控制台入口](https://opencode.ai/auth)。只推荐标明 `/chat/completions` 的模型；不把原生 Messages、Gemini、Responses 模型直接套用。免费模型可能限时退出。 |
| OpenCode Go | `https://opencode.ai/zen/go/v1` | 仅保留旧配置入口，不提供新聊天推荐。[官方使用要求](https://opencode.ai/docs/go/)面向编码代理流量，不能称为角色聊天“高速通道”。 |

OpenRouter 的「只选免费模型」同时限制候选与保存；关闭后可自行选择其他模型。免费方案限流或不可用时沿现有聊天错误返回，不自动切换到付费模型。Gemini 与 Groq 的免费资格取决于服务商账户方案，绘遇不能通过模型名替账户判断是否收费；使用免费账户并查看官方额度。模型目录可读取仍不等于已完成真实对话。Cerebras 当前为需验证支付方式、30 天到期的试用积分（[官方说明](https://inference-docs.cerebras.ai/support/rate-limits)），不列为长期免费方案。

### 本机到底连接什么

- **绘遇受管 llama.cpp**：到控制室选择并准备聊天 GGUF 与受管运行环境，绘遇管理服务及后端内存密钥。房间使用准备过程写入的 `huiyu-local` 配置，新人无需手填端口或密钥。下载文件完成不等于模型已经加载并完成回复。
- **已有 Ollama**：在运行绘遇后端的同一台电脑启动 Ollama 并下载一个聊天模型。对话设置的「已有 Ollama」会发现模型并可「重新检测」，分别说明服务离线和已启动但无模型；也可选「Ollama API」，默认 `http://127.0.0.1:11434/v1`、未设认证时不填 Key。[官方兼容 API](https://docs.ollama.com/api/openai-compatibility)。`ollama pull 模型名` 会下载模型，云模型不算离线能力。
- **已有 LM Studio**：先下载并加载聊天模型，在 Developer 页面启动 API Server；默认 `http://127.0.0.1:1234/v1`，认证关闭时 Key 留空。[官方启动说明](https://lmstudio.ai/docs/developer/core/server)、[兼容端点](https://lmstudio.ai/docs/developer/openai-compat)。
- **已有 CLIProxyAPI / CPA**：先启动并完成自己已有代理的账号/模型配置，默认 `http://127.0.0.1:8317/v1`；Key 是代理访问密钥，模型以该代理 `/models` 为准。[项目官方说明](https://help.router-for.me/)。它转发账号服务，不代表本地离线 Gemini，不再内置猜测的模型别名。

`127.0.0.1` 指绘遇后端所在电脑，不是远程访客打开网页的电脑。远程自配地址必须为公网 HTTPS；本机服务需要站主在本机配置。测试和修改站主配置仅限本机直连。站主配置藏在进阶区：访客会消费站主额度，后端保留密钥，公开回读仅返回地址和模型且保留完整路径。普通个人配置不会自动变成站主共享配置。

### 协议与凭据边界

- 房间走 OpenAI-compatible **Chat Completions + SSE**，不增加 Responses / Anthropic Messages 原生协议。模型名输入始终可编辑，自定义兼容服务保留。图片沿用当前选定 API，不会偷偷切换到另一台代理；图片/工具能力需按该模型核对。
- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)及 GPT-6 Sol 在 Chat Completions 里只支持 `reasoning_effort=none` 的工具调用，工具启用时绘遇设为 `none`。GPT-6.1 Sol / Astra 工具调用需 Responses，因此不列为默认推荐；直接选择后若启用房间工具会在发请求前提示关闭工具或换 Luna。对话设置提供「房间工具」开关。
- [DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)的工具模式要求跨轮完整 `reasoning_content`。房间只保存对话台词，因此当前用工具请关闭思考；不支持的组合在发送前拒绝并给出可操作提示。普通角色聊天默认关闭思考。低/中/高映射至官方 low/high/max。Kimi K3 同样不在此简化历史协议里伪装为已支持。
- Gemini 工具调用的 [thought signature](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures#openai)按官方字段原样透传，仅保留当前工具循环的内存；不解码、不展示、不入持久聊天记录。签名与工具参数均有边界校验。默认生成参数不对未知兼容服务强行套用某一家的思考字段。
- 密钥默认隐藏，切服务商不会把前一家密钥带给新端点。桌面继续使用 Windows 凭据管理器，网页只保留当前页面会话密钥，普通备份与草稿元数据不写入新明文密钥。地址不能携带账号、查询参数或锚点；上游错误 body 不回显，避免把授权头/Key 带进页面或诊断信息。 桌面重开可恢复正式保存过的服务商密钥；安全凭据读取期间会提示稍候并暂缓切换服务商。未保存密钥仍仅留当前会话，明确清除或后续编辑不会被较早保存请求恢复；个人配置缺少密钥时需自行补齐，不悄悄改用站主额度。
- 错误区分别说明 401 密钥、403 权限/地域、402 计费、429 配额、404/405 目录不支持、超时、服务未启动及错误响应格式。目录测试不会替用户创建账号、密钥、订阅或购买额度。

Gemini 的低 / 中 / 高通过 `reasoning_effort` 原样传递；Gemini 3 和 2.5 Pro 不允许关闭思考，因此界面明确说明「关」按低档发送，其他 Gemini 2.5 使用 `none`。详见 [Google 官方 OpenAI 兼容层 Thinking](https://ai.google.dev/gemini-api/docs/openai#thinking)。未保存推理偏好的新房间默认关闭，已有明确偏好保持不变；DeepSeek 开房间工具时需关闭推理。

[Kimi 官方模型参数参考](https://platform.kimi.com/docs/api/models-overview)确认 K2.6 仅有思考开关、不支持 `reasoning_effort`，故低 / 中 / 高均仅开启思考；K2.7 Code / Highspeed 和 K3 要求保留完整思考上下文，当前房间会在上游请求前明确拒绝，建议选 K2.6。
