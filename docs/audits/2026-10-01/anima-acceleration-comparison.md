# Anima 加速实际对照与舍弃决定

2026-10-01 按用户要求在 RTX 4070 Ti SUPER 16 GB 上比较现有 TeaCache＋SageAttention 与 EasyCache、整模型编译和分块编译。**没有得到适合接入当前默认流程的稳定完整出图收益，舍弃全部新增候选，保持现有生产配置。** 此结论限于下列真实输入、模型与环境，不宣称 TeaCache 在所有模型上最优。

## 范围与方法

- Windows、i5-12600KF（10 核／16 线程）、RTX 4070 Ti SUPER，显卡驱动 596.97；ComfyUI 0.30.0、Python 3.11.9、Torch 2.13.0+cu130、SageAttention 2.2.0。生产 Triton Windows 仍为 3.6.0.post26。
- MiaoMiao Harem Anima v1.2，832×1216、30 steps、CFG 4.5、`res_multistep/simple`，无 LoRA、高清修复或换装。现有基线为 Anima TeaCache 0.08，起止比例 0–1，缓存放 CUDA。
- 复用 `runtime/sfw-render-20260930/drafts/` 两份既有安全级编译快照：爱蜜莉雅宫廷、玛奇玛电影院。提示词、负面词、编译 Token 和采样参数保持一致，只替换加速链；每场景两个种子，第二轮反向排列候选顺序。
- 正式对照共 24 张：缓存对照 8 张，编译及其内存控制对照 16 张。连同预热、探索和环境修复，共生成 37 张；另有 3 个未产出图片的已接受请求。没有网络生图费用，没有替换正式场景或样张。
- 每次提交前检查队列。缓存正式对照使用原 ComfyUI 的串行队列；编译使用 8189 隔离实例，并在检测到原服务的新任务时取消自身请求。早期跨进程争用和未完成请求不进入正式统计，没有停止原 ComfyUI。
- “完整出图”使用 ComfyUI WebSocket 的 `execution_start` 至 `execution_success`，包含节点准备、文本处理、采样、VAE 解码、锐化和保存，排除排队与 HTTP 轮询尾差。缓存采样时间来自节点切换事件，编译采样时间来自同步后的采样 wrapper；不同轮次的绝对时间不混为一个排行榜。
- 全部 24 张正式 PNG 的内嵌 workflow 与实际提交图逐字段匹配，并核对提示词 SHA、负面词 SHA、种子、画幅、步数、CFG、采样器和调度器。人工打开同种子的成片对照，核查角色可辨识、服装、姿势、背景与结构。

## EasyCache

测试内置 EasyCache 的默认组合：`reuse_threshold=0.2`、起止比例 0.15–0.95；直接替代 TeaCache，没有同时叠加两个缓存。

| 4 个匹配输入的中位耗时 | TeaCache 基线 | EasyCache | 变化 |
| --- | ---: | ---: | ---: |
| 采样 | 7.014 s | 6.655 s | 耗时降低 5.12% |
| 完整出图 | 7.553 s | 7.449 s | 耗时降低 1.37% |

完整出图逐条为：

| 场景／种子 | TeaCache | EasyCache |
| --- | ---: | ---: |
| 爱蜜莉雅／100100 | 7.344 s | 7.439 s |
| 爱蜜莉雅／100101 | 7.253 s | 7.459 s |
| 玛奇玛／100200 | 7.987 s | 6.799 s |
| 玛奇玛／100201 | 7.762 s | 7.502 s |

电影院场景较快，但宫廷场景两条均更慢；小样本不提供统计显著性或普遍加速承诺。没有观察到新增明显肢体断裂或角色错认，但相同种子下姿势、构图和细节有变化，不能称为像素无损。综合收益小且依赖输入，**不接入默认流程，也不新增候选开关**。

## 编译与内存控制

整模型编译复用原生 `TorchCompileModel` 的 helper 和参数；分块编译通过同一 helper 指定 `diffusion_model.blocks.<序号>`。都接在 TeaCache 后，使用真正的 Inductor backend，没有开启 `suppress_errors`。

TeaCache 在内部替换原 `_forward`，所以只添加编译节点不足以证明热点被编译。本轮用计数 backend 包装真正的 Inductor，记录成功编译的图、图内操作和返回 callable 的实际调用次数。分块首张生成 19 个图，每张调用 8,820–9,408 次；整模型首张生成 28 个图，后续每张仍新增 2 个图，调用 9,150–9,739 次。两者确实执行了编译计算。

编译 helper 会 `clone(disable_dynamic=True)`。因此另测相同克隆但不编译的内存控制，以免把加载机制的变化错算成编译收益。

| 正式编译轮次 | 匹配基线完整出图中位数 | 候选中位数 | 结果 |
| --- | ---: | ---: | --- |
| 分块编译，排除首次编译的 3 对 | 8.597 s | 9.308 s | 慢 8.27%；其中 2 对更慢 |
| 整模型编译，排除首次编译的 3 对 | 8.597 s | 9.389 s | 慢 9.21%；其中 2 对更慢 |
| 仅禁用动态加载的 4 对 | 8.237 s | 9.590 s | 慢 16.42%；4 对均更慢 |

首次分块完整出图为 18.055 s，首次整模型为 29.856 s，同输入基线为 7.191 s。即使不计首次编译成本，热运行也没有稳定完整出图收益。探索阶段分块曾有一次 6.707 s 的较快结果；正式双场景与反向顺序对照没有复现普遍收益，未用单个最快结果作接入依据。

当次 KSampler 执行阶段的全卡显存采样峰值：基线 12,563 MiB，分块 14,632 MiB，整模型 14,462 MiB。采样约 300 ms，包含其他桌面应用，既不是完整出图阶段或连续绝对峰值，也不是单个模型的独占显存。编译还需额外环境准备，收益无法抵偿复杂度与冷启动，**全部舍弃，不接入生产**。

画面审查中角色、服装与场景保持可辨识；编译结果存在褶皱、朝向及构图变化，不声明完整精度或画质等价。这次不涉及所有底模、LoRA、其他画幅、批量或高清／Inpaint 的性能结论。

## 隔离环境与收口

- 根据 [Triton Windows 维护者的 Torch 配对表](https://github.com/triton-lang/triton-windows#3-pytorch)，为 Torch 2.13 在隔离 `compile-deps/` 安装 Triton Windows 3.7.1.post27。固定 CPython 3.11 wheel 为 49,679,173 字节，SHA-256 `b739bd7d39f919280294d8af172a90aa2f17a4377bfbca2ea30a8afae61d5eaa`；没有升级生产 venv。
- 修复的准备问题仅限隔离进程：显式独立 SQLite URL，避免原 ComfyUI 数据库锁；`PYTHONUTF8=1` 避免当前 Torch 模板按 GBK 读取失败；初始化已安装的 VS2022 BuildTools 环境，解决 `cl` 不在 PATH。没有安装编译器，没有修改 Torch、TeaCache 或 ComfyUI 源码。这些不是加速收益。
- 正式轮次启用 SageAttention，日志没有发现 `Error running sage attention ... using pytorch attention instead` 的回退记录。
- 隔离 ComfyUI 及其子进程均已退出，8189 无监听；原 8188/PID 796 服务保留。生产依赖再次只读核对为 Torch 2.13.0+cu130、SageAttention 2.2.0、Triton Windows 3.6.0.post26；三个缓存／编译源码 SHA 保持不变。
- 原服务上的 9 张自身测试 PNG 已按 SHA-256 备份到 `runtime/`。自动审批拦截了逐文件删除命令，工具仅返回 `blocked by policy`；因此**原 PNG 与 9 条对应测试历史均保留，未执行清理**。没有清空公共队列、修改其他历史或写入个人作品库。
- 结果仅增加本报告与索引，不新增产品代码、依赖、测试套件或维护入口；没有需要同步到桌面端的产品变更。

## 复核材料

全部原始图片、采样、日志、workflow、依赖候选和一次性节点均备份或留在被忽略的 `runtime/anima-acceleration-20261001/`：

- `cache-serial.json`：正式缓存轮次与逐条事件；`compile-valid.json`、`compile-summary.json`：正式编译与内存控制；早期 `cache.json`、`compile.json`、`compile-utf8.json` 仅为探索。
- `graphs/`、`*-history.json`、`sample-observations.jsonl`、`submissions.jsonl`、`identity.json`、`verification.json`：实际输入、调用、源码身份与 PNG 核对。
- `outputs/`、`*-cache-comparison.png`、`*-compile-comparison.png`：37 张原图和画面审查拼图；拼图缩放只用于检查，不回写原图。
- `*server.stderr.log`、`compile-cache/`、`triton-cache/`、`compile-deps/`：隔离准备、图切分／重编译日志与真实候选；保留用于复核，不被产品启动路径引用。
- `production-test-cleanup-plan.json`：自身产物的字节备份清单；删除操作未执行，不作为已清理回执。

一次性驱动位于 `scripts/archive/acceleration-bench-20261001.cjs` 与 `start-acceleration-bench-20261001.ps1`，没有注册为普通无副作用测试。源代码核对基于 `7266c9d141c2048748df77e9d2dee139b8336fc3` 工作区的生成图；关键源 SHA 记录于 `identity.json`。其他会话同时修改的 UI、人物资料与提示词不属于本次提交。
