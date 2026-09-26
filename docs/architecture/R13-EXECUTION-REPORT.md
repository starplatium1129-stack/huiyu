# R13 Electron 宿主对照实验

日期：2026-09-27。基线 `0e6cabce`，接续 [R12](R12-EXECUTION-REPORT.md)。复用同一 Vue desktop bundle、固定 Node 24.18.0 sidecar、SQLite workspace 和原生 Live2D 内核；实验资料均为独立临时夹具。正式 Tauri 安装与生产资料不参与写入。

## 结论范围

Electron 可以接入当前 UI、runtime 与原生模型，但这仍是宿主对照 PoC。原型尚缺完整系统集成和发行链；原生模式还使用 R12 probe supervisor 与 renderer 两个额外进程，不能把这一配置的全部成本归因于 Chromium 或 Electron 本身。正式产品继续保留 Tauri，实验不自动启用或安装。

## 已实现与验证

- 三个宿主登记窗口提供固定 preload 能力；前端通过正式平台 adapter 接入，不伪造 `__TAURI__`。窗口角色来自宿主，网页没有 Node、`require` 或通用 `ipcRenderer`。
- 本地页面使用 `https://huiyu.localhost` 的 session 内协议处理，路径限制在同一 UI 构建；保留 sandbox、context isolation、CSP、主 frame/精确来源及角色检查。私人 HTTP 会话仍由既有 HMAC/SQLite authority 发放，不引入第二份持久化实现。这些边界对应 [Electron 安全指导](https://www.electronjs.org/docs/latest/tutorial/security)和[协议 API](https://www.electronjs.org/docs/latest/api/protocol)。
- 页面先于延迟 runtime 显示；三窗共享同一夹具 workspace，真实项目写入、页面重开和完整壳重开后仍可读。runtime 停启不重载文档，新 epoch 拒绝旧会话；一个 renderer 崩溃后可独立重开。
- 宁宁、夏目均通过实际前端角色选择/启用进入 native ready，而非直接调用加载命令冒充消费链。已取得原生窗口、GPU readback 和真实画面证据；原始纹理与目标 60 FPS 单列。
- Node runtime 在父宿主意外结束后经 IPC disconnect 调用原有 shutdown/drain，退出、释放 owner 与端口。应用关闭时先关 native 准入，再回收子进程；测试退出不遗留实验进程。

## 本轮发现并修复

1. Windows GUI Electron 启动时 stdin 已结束，原测试控制把 EOF 当作结束实验，造成页面 `ERR_FAILED`。仅显式 probe 改用随机本地命名管道；没有放宽页面协议、安全策略或权限。
2. 本机父进程终止测试中，未 detach 的 sidecar 没有完成 drain。改用隐藏的 detached 进程并保留父 IPC 后，实测断开会由既有 runtime authority 完成退出和锁/端口回收。
3. 原生模型路径不能误用浏览器的 `live2d-current` 资源地址做文件白名单。与 Tauri 一致，浏览器 URL 只作有界字符串接收后丢弃；实际文件由宿主资产根、内置角色和 profile 身份决定。
4. 可恢复的 native `stop()` 不适用于整个应用退出：前端退避恢复可能在 runtime drain 期间重新创建 renderer。新增不可重开的 `close()`，保留窗口故障场景的可恢复 stop。
5. Tauri 现有导航广播可能被桌宠/聊天同时接收。平台 adapter 现在只允许 Atelier 响应；定向行为测试及真实三窗导航检查确认其它窗口保留角色页。此修复进入源码与候选，本次未重新部署正式安装版。
6. Windows 的历史 ParentPID 可因 PID 复用指向无关服务。进程树现在同时核对父子创建时间，异常清理只使用保留的根 ChildProcess；受污染的成本样本明确剔除，未终止无关服务。

## 对照方法

两个工作量为三个可见窗口的 dark 首页空闲，以及同三窗加夏目原始纹理、确认目标 60 FPS 的原生显示。两边使用相同 UI 构建、同一 gateway 产物和 Node sidecar，顺序运行；记录每窗 DPR、屏幕与实际像素尺寸。测量共享同一 Windows helper，进程树依据创建时间而非只看 ParentPID。

工作集是进程树合计，可能重复计入共享页；private bytes 是私有提交量，均不是整机独占物理 RAM。CPU 100% 表示一个逻辑核；短时样本只统计前后均存在的进程，不是长时功耗或峰值。不能拿 Electron 人为注入的 15 秒 runtime 延迟比较真实启动速度。

最终 UI index SHA-256 为 `4a384bca60d258797367f0be7017d181754a8b774e3c558a22e9d1788f8fcfe9`。双方 DPR 1、屏幕 2622×1206；Atelier/Companion/chat 视口分别为 1280×820、540×760、480×820，均为可见深色窗口。首页角色图已实际加载；原生视口均为 540×656，夏目原始纹理，目标 60 FPS。Tauri 的空闲和原生样本来自同一候选的两次独立启动。

| 工作量与宿主 | 进程数 | 私有提交 MiB | 工作集合计 MiB | CPU（单逻辑核 %） | 原生实测 FPS |
| --- | ---: | ---: | ---: | ---: | ---: |
| 三窗空闲 · Tauri | 11 | 872.7 | 1200.1 | 1.40 | — |
| 三窗空闲 · Electron | 7 | 803.1 | 1093.2 | 3.50 | — |
| 三窗＋原生 · Tauri | 11 | 1830.0 | 2184.2 | 12.46 | 58.92 |
| 三窗＋原生 · Electron | 9 | 1873.3 | 2203.3 | 11.06 | 58.72 |

CPU 采样约 2.2 秒，帧数窗口约 7.8 秒。Electron 空闲私有提交低约 69.6 MiB，原生显示时高约 43.3 MiB；短样本没有显示足以支撑迁移的整体收益。帧率接近本次设置的 60 FPS，不代表渲染上限。Tauri 使用既有线程 renderer；Electron 保留 R12 probe＋renderer 两个进程。窗口装饰、托盘和全局系统集成也不同，因此这是当前可运行产品配置的对照，不是纯框架基准。

两壳启动顺序和 profile 冷暖条件不同，不排名启动速度。首次故障恢复可能留下首页图片占位，本次稳态采样在 runtime 就绪后重开 Atelier 并确认两张图均已加载；它不冒充“无重载图片恢复”验收。旧 DPI、旧 UI、历史 ParentPID 污染及缺图成本样本均排除；原始失败记录仍保留。功能/故障检查及两角色早期图片复用各自标注的 UI 哈希，当前 UI 另验三窗成本、真实桌面合成、双主题和正常退出，未把汇总条目数当作全新测试数。

## 交付与维护成本

官方 Electron 44.4.5 的 win32-x64 ZIP 为 158,184,819 bytes，SHA-256 `11c395820a5aaa8ebcc0686b476d0ac98a730274ebfbdc8cf5538a7c2815cb5d`，通过[官方校验清单](https://github.com/electron/electron/releases/download/v44.4.5/SHASUMS256.txt)核对。解压 runtime 约 367.4 MiB；本 PoC 另外需要原生 helper 43.3 MiB、Node 88.2 MiB、UI 20.4 MiB，共用 gateway/资产另计。这是选定文件的未压缩体积，不是已生成的 Electron 安装包。Tauri 依赖系统共享的 WebView2，该系统 runtime 未计入应用目录，不能把省略的共享依赖当作零成本。

13 个 Electron CJS 模块承担窗口、安全协议、preload、偏好/安全存储、runtime 与 native 监督。尚未实现托盘、全局快捷键、系统深链、剪贴板/全局鼠标生产者、文件选择/导出、自启动、通知、安装器、签名和自动更新；语音/摄像等权限默认拒绝。拖动仅支持 CSS 区域；带查询参数的宿主导航仍需与现有消费者对齐。未实现能力明确返回 `UNSUPPORTED`，不算产品已交付。

## 复现与证据

固定 Electron runtime 准备用 `npm run wf -- desktop:electron-prepare --out <新目录>`；已有已验证 runtime 可直接复用，无需重复下载或修改根 npm 依赖。先构建 Node 测试入口及同一 desktop UI，再用 `npm run wf -- desktop:electron-check --electron <electron.exe> --node <node.exe> --gateway-root <staged gateway> --ui-root <desktop UI> --native-exe <R12候选EXE> --out <新证据目录>`。它会创建独立临时 profile/config/AI 目录、运行可见实验窗口与本机 GPU；不进入默认 unit/validate。

定向 adapter/来源/导航行为测试、Node 来源边界测试、类型/架构/单体门禁及实际 Web/desktop UI 构建通过；Web 预算未放宽，Tauri 候选构建与 staged gateway 校验通过。没有扩大全量回归，也未调用真实生成模型。

脱敏数值、来源哈希和验收范围见 [R13 证据](../evidence/architecture-r13-2026-09-27.json)。原始 JSON、日志、图片与旧失败证据保存在本机 `runtime/refactor-r13/`，截图可能含桌面背景，不入 Git。多屏、长期驻留、休眠/驱动重置、其它平台及完整发行升级不由本轮短样本代替。R13 实验完成与是否正式迁移宿主是不同决定。
