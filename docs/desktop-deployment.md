# 桌面端部署：开发升级包与发行完整包

整理日期：2026-10-14。现行维护版本；历史验收不作为本次通过。

统一入口只有一个：**`deploy-desktop.bat`**（项目根）。实现脚本也只有一个：
`scripts/maintenance/deploy-desktop-quick.ps1`。不要再新建部署脚本。

本机已启用 bundled UI，当前安装身份以[项目状态](project-status.md)为准；不同机器与日期的安装记录不互相替代。**日常开发默认构建并安装无压缩升级包，只有发行流程构建完整 LZMA 包。** 前端、宿主、Rust 后端或 DLL 变化都可通过升级包更新，无需为了更新 EXE 先构建完整包。纯数据和动态资源同步显式使用 `-ResourcesOnly`；后续源码改动需另行核对安装身份。

2026-09-28 源码已将后端载荷改为 `gateway/huiyu-runtime.exe` 与锁定的原生 DLL，旧 Node 源码不随产品作为回退服务。本次 Rust 构建/安装与上述旧安装分开验收；目前原生发行材料未完成，`releaseReady=false`。按 2026-10-06 的发行规则，该标记与 pending 如实记录，不阻断经用户明确授权的发布；材料索引完整性及源码/产物字节核验仍须通过，发布不代表待项已验收。后端 EXE、DLL 或桌面 EXE 变化必须通过安装器更新，日常优先升级包；`-SkipBuild` 只能复用匹配源码的构建。只有可复制资源发生变化且安装程序字节匹配时才用 `-ResourcesOnly`。

## 打包前检查

桌面构建入口在捕获源码身份及构建 Web/desktop UI 前，从已显式导出的 `data/catalog/` 快照刷新人物、服装、场景、蓝图的数据聚合与预压副本，再解析 `DATA_VERSION`；不会把仅因文件存在而跳过重建的测试准备模式用于发行包。发行包同时携带记录快照。已安装程序以个人 `content/catalog.sqlite` 为工作权威；部署入口通过原生接口预览并合并快照，不覆盖库文件，不能仅核对 EXE/DLL 后宣称角色数据已更新。

当前 SQLite 桌面工作区使用排他 owner 锁。支持维护协议的新宿主可由部署入口正常退出：先做只读能力/进程身份核对并准备安装包或构建，写入安装目录前通知现有三个窗口冻结输入、确认延迟保存；全部确认后才通过宿主既有认证通道停止新请求，排空已准入写入、回收自有网关并确认锁释放。任一窗口仍忙、配置表单未提交或保存失败，部署就取消，不代替用户提交配置。只隐藏窗口不等于退出。

Windows 桌面自有网关及它新建的模型进程纳入宿主持有的 Job Object；启动时先完成 `--desktop-owned` 管道握手，再初始化网关服务。显式退出先关闭自动重启入口，沿用认证排空后回收整个进程组；启动脚本已退出的语音子进程也受约束，外部独立启动的服务不纳入。此握手要求桌面 EXE 与 runtime EXE 通过同一安装包配套更新。正常使用中 PixAI 与独立生图保留热缓存，最后一次任务完成后连续空闲 10 分钟回收；隐藏到托盘继续按空闲规则运行。

旧安装版没有维护能力描述时，仍须先从托盘“退出 Companion”再执行首次升级；脚本不会试探未知 CLI、强杀进程或按 PID 猜测删锁。维护在封闭写入前取消会恢复界面；进入排空后失败则保持冻结，用户可从托盘正常退出后检查，不能把该退出当作升级成功。active/candidate 的未知残留锁始终要求维修。提权父进程等待并返回真实退出码，UAC 取消或安装失败不会显示成功；UAC、缺包或构建失败也不会提前关掉用户应用。

`npm run wf -- check:desktop-deploy` 使用临时安装目录、独立 owner 记录及真实进程夹具，验证受控退出、旧版本拒绝、进程身份变化与未知残留锁保留；不操作当前安装或触发 UAC。安装后重启会核对新宿主实例及其认证网关就绪，页面/图片显示另做实际界面验收。`-NoRestart` 不执行启动确认，不能据此记录启动成功。

`package:tauri` 暂存实际 Rust EXE、原生 DLL、清单与资源，并按 `bundle.resources` 在仓库外隔离布局启动该 EXE；验证器拒绝旧 `server.js`、服务端 `node_modules` 等误入载荷。可用 `npm run wf -- desktop:verify-gateway` 或 `desktop:rust-bundle` 复验。开发机旧 Node 网关或 Live2D 自测不能代替实际包布局验证；最终结果见[统一规划](roadmap.md)。

旧 1.6.0 的缺失 `docs/redirects.json` 修复属于历史 Node 版本，应使用对应版本的发行流程。当前 `-StartupRepair` 仅为已匹配 Rust 构建的安装同步文档、图标和快捷方式，不能升级旧 Node 安装。部署入口从卸载登记读取实际安装位置，多个安装需用 `-InstallDir` 明确选择。

先运行 `npm run wf -- desktop:doctor --json`，确认 Windows x64、Node.js、Rust MSVC、Visual C++、Windows SDK 和 Cubism Native SDK 全部就绪。`npm run package:tauri` 会在构建前自动执行同一检查，缺失时立即给出具体安装指引。

Rust 使用[官方 rustup 安装器](https://rust-lang.org/tools/install/)的 x64 MSVC stable 工具链。入口会自动发现 `%USERPROFILE%\.cargo\bin`，无需重启终端或手动修改全局 PATH。C++/Windows SDK 要求见 [Tauri 官方前置条件](https://v2.tauri.app/start/prerequisites/)。

项目使用 [Cubism SDK for Native R5](https://www.live2d.com/en/sdk/download/native/)。将完整 SDK 放到 `runtime/desktop-build-sdk/CubismSdkForNative-5-r.5`，或设置 `LIVE2D_CUBISM_SDK_DIR` 指向包含 Core/Framework 的根目录。显式配置失效时不会静默换库。SDK 仅保存在被忽略的本机目录，不提交其源码、压缩包或工具链到 Git；保留 SDK 随附许可证，发布仍沿用既有发布流程。

日常只构建升级包：`npm run wf -- desktop:package-local --install-dir "C:\Program Files\AI-CG-Studio"`。它不安装、不发布。`npm run package:tauri` 是发行完整包的底层入口，使用 LZMA 压缩，日常开发不调用它。

`build:tauri` 与 `package:tauri` 在启动打包进程前先生成当前工具脚本。不能依赖进程内部的 Web 构建再更新脚本：打包进程已经载入的旧资源清单不会被子进程刷新，会遗漏新目录。2026-10-11 本机部署暴露并修复了该启动顺序问题；重建后须确认 `data/catalog` 和 `tools/inference` 均在实际暂存与安装载荷中。

**公开发行与源码构建分别核对**：2026-10-07 已发布的 [1.9.2](releases/v1.9.2.md)绑定 `f221bd4c`，包含 `AI-CG-Studio_1.9.2_x64-full-setup.exe`（662,912,512 字节）与 `AI-CG-Studio_1.9.2_x64-upgrade-setup.exe`（391,980,544 字节），公开自动更新指向升级包。发行身份及核验范围见[项目状态](project-status.md)；本次公开发行不代表已安装到本机，后续源码能力不能据此算入既有安装包。

发行入口 `npm run release:desktop` 生成 **full 完整包**与 **upgrade 轻量升级包**，使用 LZMA 并分别绑定/签名；已有发行构建可用 `--skip-build`，无签名发行显式加 `--manual`。发行入口拒绝把本机升级包或无压缩包当作完整包。完整包带基础素材和 WebView2；升级包在写入前核对已有安装及保留资源字节。样张 ZIP 继续独立提供。`deploy-desktop.bat -UseInstaller` 仅自动选择当前版本的升级包；首次安装/修复必须显式传入 `-InstallerPath <发行完整包>`。

正式构建会在 Tauri CLI 完成后将 Cargo 创建的固定 release EXE 硬链接核对字节并原子替换为独立文件，再执行原来的源码/产物绑定检查；其它位置的硬链接仍拒绝。CLI 成功不等于可发行：绑定失败返回非零并指出具体产物，回执原子更新失败保留旧回执，不再依赖一次性打包脚本修补。

源码清理后的正常构建无需先暂存删除文件。构建选择只跳过 Git 确认删除且安全路径检查确认为不存在的项，捕获的身份与暂存相同删除后一致；源码删除/恢复仍会让旧构建失配。路径不安全、无法读取和显式缺失输入不会被当作普通删除忽略。

Tauri 2.12 在 NSIS 内把宿主唯一的 `__TAURI_BUNDLE_TYPE_VAR_UNK` 标记改成 `NSS`，打包后恢复构建目录的原 EXE。因此安装校验从已绑定源字节计算这一精确变换后的完整 SHA-256；其它字节变化、重复/缺失标记仍拒绝，Rust 后端和 DLL 仍须原字节相等。这不用于接受签名或任意安装器修改；上游打包行为改变时需重新核验。

2026-09-21 网关身份加固后，发行版只启动并验证自有实例，不再凭公开的 `app/desktopProtocol` 字段附着任意回环服务。每次启动使用随机凭据和逐次随机挑战/HMAC；凭据不在 HTTP 请求或日志中传输。首次启动允许寻找可用端口，认证后本次桌面进程固定该端口；若恢复时被其他服务占用，应退出并重新启动桌面选择端口，不继续扩大旧 IPC 授权。健康失败立即撤销自定义 IPC 的信任，窗口导航另做即时挑战校验。

仅调试构建支持显式开发附着：桌面 `AICS_DESKTOP_ATTACH_TOKEN` 与开发网关 `AICS_DESKTOP_GATEWAY_TOKEN` 设置为同一随机 32 字节的小写十六进制值（恰好 64 字符）。非法格式拒绝启动；发行版忽略开发附着模式。这不提供对同账户恶意程序读取进程内存/环境的隔离保证。身份与个人凭据功能均涉及 Rust/exe 变化，必须通过安装包更新，不能只同步前端。

本机开发使用 `desktop:package-local --install-dir <已有安装目录>`：先构建前端、暂存资源和原生程序（`--no-bundle`），再用独立打包目录直接生成升级包。`desktop-tauri/tauri.local.json` 关闭压缩和自动更新签名产物，并跳过 WebView2；安装模板只省略可复用素材的写入，保留完整卸载清单。不会先生成完整 NSIS 包，也不会覆盖已有发行包。输出 `runtime/desktop-updates/AI-CG-Studio_<版本>_x64-local-upgrade-setup.exe`，不用于公开发布。

已有匹配当前源码的原生构建时，只封装升级包可运行（不需要已有 NSIS 包）：

```powershell
npm run wf -- desktop:upgrade-local --install-dir "C:\Program Files\AI-CG-Studio"
```

它等价于 `desktop:package-local --skip-build`，先用安装器内同一个只读检查器核对安装登记、宿主版本、WebView2 与保留素材，再封装无压缩升级包；不修改自动更新清单、不安装或发布。前置不匹配直接停止，保持应用运行，不自动回退完整打包。安装使用 `deploy-desktop.bat -UseInstaller -InstallerPath "<本次绑定的升级包>" -QuietInstall`；新装或修复显式选用发行完整包。

构建绑定现在只选择当前产品/版本的 x64 安装包、存在的签名及 NSIS 输入，历史版本包可以保留在输出目录，不参与本次校验。部署的三个检查点均保留，每个检查点只扫描一次完整构建。旧回执不会被自动改写，工具源码变化后须正常重建一次才能复用新规则。构建日志新增 `[desktop:timing]`，分别记录前端/预压、Rust 后端、桌面 UI、资源暂存、隔离网关验证、Tauri 原生/打包及绑定；部署日志记录校验、维护退出、安装/同步和启动耗时，实际收益以同机下一次更新为准。

2026-10-06 本机 b19574dc 升级部署日志共 204.35 秒，三个校验检查点共 193.58 秒，安装器实际执行 7.14 秒。当前源码将逐个路径前缀的重复 realpath 改为逐段链接检查后的一次 Windows 原生 realpath；保留真实路径边界、硬链接、并发修改及完整字节摘要校验，没有跳过检查点或复用未经检查的摘要。对同一批 13,719 个已安装静态文件（576,039,345 字节），扫描从 22.11 秒降到 7.39 秒，前后完整 SHA-256 相同，17 项现有定向用例通过。该收益不等同于整轮部署的新耗时；下一次部署以日志为准。

同日 21:16 已实际安装优化后的玻璃体验构建：三个完整性检查点为 20.35/20.60/21.41 秒，总部署 69.34 秒，安装器实际 3.08 秒。使用本机无压缩包直接安装，源码/产物绑定及启动确认通过；源码仍基于 b19574dc 加本轮改动，没有公开发布。成功构建自身耗时 8 分 54 秒，未完全命中的 Rust 编译缓存使原生重编占用约 7 分半，不能据安装耗时推断整轮构建只需 5 分钟。测试构建目录保留以复用新缓存，材料见 `runtime/local-glass-upgrade-20261006/`。

```bat
deploy-desktop.bat                  :: 构建并安装本机无压缩升级包
deploy-desktop.bat -UseInstaller    :: 复用当前版本的已绑定升级包
deploy-desktop.bat -UseInstaller -InstallerPath "D:\path\verified-setup.exe" :: 指定本次已验收安装包
deploy-desktop.bat -SkipBuild       :: 复用匹配原生构建，仅封装并安装升级包
deploy-desktop.bat -ResourcesOnly -SkipBuild :: EXE/DLL 相同，仅同步绑定静态资源
deploy-desktop.bat -NoRestart       :: 部署后不自动启动
deploy-desktop.bat -UseInstaller -QuietInstall :: UAC 确认后自动安装并启动
deploy-desktop.bat -UseInstaller -QuietInstall -SyncLocalModels :: 同步本机导入模型至用户目录
```

包部署和资源同步都会：确认应用/网关已退出且锁已释放 → 部署 → 校验 → 清 WebView2 缓存 → 重启桌面端。

`-SyncLocalModels` 仅用于个人部署：核验并复制 `runtime/live2d-imports` 已登记文件至用户数据目录，保留旧模型版本；不会把候选 LPK/ZIP 或模型塞进可分发安装包。增量复制也排除 `assets/live2d-candidates`。
`-QuietInstall` 用于默认升级或 `-UseInstaller` 包部署，仍需要用户确认 UAC；不适用于 `-ResourcesOnly` / `-StartupRepair`。部署日志追加到 `runtime/desktop-deploy-last.log`。
`-InstallerPath` 随 `-UseInstaller` 显式选择包；未指定时仅在当前版本升级包中选最新一份。既有包的路径会固定并透传 UAC；默认构建模式在构建成功后固定本次产物。三个构建绑定检查点仍保留，避免同版本旧包或并发替换被误安装。
`-Cleanup` 默认已带（清理源端已删除的历史残留）。

---

## 数据改动如何到达桌面端

人物、服装、场景和蓝图的工作权威是个人运行目录中的
**`%APPDATA%\com.aics.studio\gateway\content\catalog.sqlite`**。
`data/catalog/` 是显式导出的项目快照，构建用它生成发行数据；旧 `content/data` 分片仅用于升级导入等保留用途。
完整安装与增量部署都不会覆盖已有个人库。首次启用按快照或旧个人分片初始化；已启用后数据库缺失或损坏会拒绝服务，不静默重建。

`deploy-desktop.bat` 在安装后、重启前读取安装目录的 `data/catalog`，通过原生接口预览、备份并导入个人库，导入后再次核对差异。备份与回执保存在个人 `gateway/content-update-backups/<ID>/`；缺少快照、合并冲突或核对失败会中止部署，不能仅凭素材或 EXE 更新成功宣布内容已更新。`-StartupRepair` 不导入内容。

直接运行安装器不会合并已有个人库。配套新版程序与包含 `catalog.json` 的新素材包由资源助手一并导入人物内容，无需开发部署命令；旧素材包仍只含图片。新旧包的区别及发行状态见[新机器离线资源安装](guides/offline-resources.md#人物内容随包更新源码修复待配套发行)，素材版本不单独代表人物内容版本。
部署导入比较原始种子、本地修改和新快照，并显式使用 `--preserve-local`：保留已修改的个人记录，更新原始随包基线，回执列出保留清单；缺失记录不隐式删除。导出备份先于预览，应用后保存再次核对的回执。关联变更若会触碰保留记录仍拒绝写入。页面和普通 CLI 导入保持默认冲突拒绝，不自动选择内容版本。
维护入口为 `npm run wf -- content:catalog --help`，操作见[维护手册](maintenance.md#批量修改与快照)。
不要通过复制分片或替换 SQLite 文件来绕过个人修改与修订校验。

### 仍按文件维护的数据

`desktop:content-sync` 保留给参考索引等仍按文件维护的数据；它不导入快照、不更新 `catalog.sqlite`，
不能用于交付已进入记录库的人物、服装、场景或蓝图修改。源和目标中的 `catalog/`、`popular/`、`scenes/`、`blueprints/` 及对应人物/场景/蓝图聚合会直接跳过，不读取、复制、删除或计入目标多余文件；参考、标签、LoRA 与定稿保护清单等仍按文件维护的元数据保留原同步行为。它同步的 `content/data` 可能有 `.br/.gz`
预压缩副本，写入前会解压核对与源 JSON 的字节，不一致时拒绝，需重新生成对应预压缩产物。
文件同步入口：

```powershell
npm run wf -- desktop:content-sync                                  # 只读预览差异
npm run wf -- desktop:content-sync --apply                          # 先备份覆盖项，再复制差异文件
npm run wf -- desktop:content-sync --apply --clear-webview-cache     # 再清 WebView2 缓存
# 写入/清缓存前先从托盘退出桌面端；同步完成后再启动
```

约定与边界：

- 源默认使用仓库 `data/`，复用桌面打包的数据白名单，只增改；目标目录里多出来的文件只**列出**供人工判断，
  不自动删除。安装目录曾残留仓库已删除的旧场景单文件（`nene-core.json`、`nene-after-story.json`、
  `natsume-core.json`，2026-08-27），它们回流后会与数字分片并存，使场景维护接口以
  「单文件与批次文件并存」拒绝服务；因此部署入口的 `$STALE_ASSETS` 已登记这九个路径
  （`.json` 与 `.br/.gz`），`deploy-desktop.bat` 默认带 `-Cleanup` 时会把它们从安装目录清掉。
- 不动记录式内容库及用户作品数据（`content/catalog.sqlite`、SQLite 工作区、history/projects/prompts、`pipeline-run-state.json` 等）。
- 覆盖前将当前目标的原始字节及新增/更新文件清单保存到 `content/data` 旁的
  `content-sync-backups/<ID>/`，并输出路径。逐文件原子写入；链接路径、陈旧压缩体和已检测到的
  并发修改会拒绝。失败可能留下已同步文件与备份，不提供整批事务回滚。
- 写入或清缓存要求桌面端已退出、维护事务与工作区 owner 锁已释放；脚本只检查并拒绝，
  不停止进程、不删除锁。尊重 `AICS_DESKTOP_CONFIG_ROOT` 与 `AICS_DESKTOP_WEBVIEW_DATA_DIR`
  指定的隔离配置/浏览器资料根，可用帮助中的路径参数选择隔离夹具。
- **不重启应用**，也不证明应用内画面；装机后仍要自行核对安装目录与内容目录哈希、以及
  实际界面（深浅主题、卡片裁切）。
- 需要出图/真实素材的验收不走本入口。

---

## 一、决策表：改了什么，就用什么

2026-09-26 当前桌面已启用独立打包 UI（`http://tauri.localhost`）。它的前端编译进原生 EXE；修改 Vue / TS / CSS 后必须重新构建并通过升级包安装，仅复制网关 `dist/` 不会更新桌面界面。构建时保留已验收的 `AICS_BUNDLED_UI_VERIFIED=1` 标记；来源切换和真实资料迁移仍经宿主维护流程，不能用标记跳过资料门槛。此次安装与迁移证据见 [当前实现与安装边界](project-status.md#源码与本机安装)。

| 改动内容 | 用哪个 | 原因 |
|---|---|---|
| `src/**` 前端代码（Vue / TS / CSS），已启用独立 UI | **默认升级包** | 前端编译进 EXE，必须重新构建 |
| `src/**` 前端代码，仍使用旧 HTTP UI 来源 | **增量** | 只需换网关 `dist/` |
| `data/catalog/` 人物、服装、场景、蓝图快照 | **安装资源可增量；部署入口合并导入** | 不覆盖 SQLite 文件；部署入口备份并导入，独立安装器与素材包按上节另行导入 |
| 参考索引等仍按文件维护的 `data/` 资源 | **增量** | 更新安装资源；已有个人内容目录另按文件同步入口处理 |
| `runtime-rs/src/`、Cargo 锁文件或后端 EXE | **默认升级包** | 产品运行 Rust EXE，不能复制旧网关 JS 代替构建 |
| `assets/` 新增/修改静态资源 | **增量** | 直接复制 |
| `assets/` **删除**了资源 | **增量** | 必须带 `-Cleanup`，否则安装目录里那份会永久残留 |
| 原生 DLL、依赖清单、载荷规则变化 | **默认升级包** | 更新字节/哈希、许可清单和构建绑定，再验证实际 bundle |
| `package.json` / 构建工具变化 | 重建受影响产物后判断 | bundled UI、EXE 或 DLL 变化通过升级包安装 |
| Rust 代码（`desktop-tauri/src-tauri/src/`） | **默认升级包** | 纯资源同步不替换 exe |
| `tauri.conf.json`（版本号、CSP、资源清单等） | **默认升级包** | 同上，保留素材仍须匹配 |
| 首次安装 / 换机器 / 保留素材缺失或改变 | **显式选择发行完整包** | 升级前置不满足，不能自动回退完整构建 |

判断依据：**开发默认升级包；纯资源变化可显式 `-ResourcesOnly`；首次安装/修复使用发行完整包。**

---

## 二、两种模式做了什么

### 纯资源同步（显式 `-ResourcesOnly`）
1. 准备当前构建并核验绑定及安装 EXE/DLL 一致性；已有相同构建可用 `-SkipBuild`
2. 请求已核验宿主维护退出，排空写入并确认自有网关退出、owner 锁释放
3. 清理 `-Cleanup` 登记的残留目录
4. 按已验证暂存白名单复制数据与静态资源，`data` 先于 `dist`；不复制旧服务端 JS 来更新 Rust 逻辑
5. 校验安装字节，通过原生接口合并内容快照
6. 清 WebView2 缓存并确认新宿主与网关启动；EXE/DLL 不匹配应改走默认升级包

> 复制顺序有讲究：**data 必须先于 dist**。客户端用 `?v=DATA_VERSION` 请求 data，
> 若新 dist（新版本号）曾对着旧 data 提供过一次，WebView2 会把旧内容以 immutable
> 一年缓存写进新 URL，之后再也不刷新。

### 安装包部署（默认构建升级包，`-UseInstaller` 复用已有包）
默认直接生成并固定本次升级包；`-UseInstaller` 使用 `-InstallerPath` 指定的已绑定安装包，未指定时仅选择当前版本的升级包。完整包用于首次安装或修复，必须明确指定。NSIS 是安装核心，由现代安装展示层封装。
它替换当前 `gateway/` 载荷、后端/桌面 EXE与原生库；旧布局残留按部署清单核验，不手工删除用户资料。

---

## 三、三个必须知道的坑

### 1. 原生依赖需要绑定真实载荷
`runtime-rs/native-dependencies.windows-x64.json` 固定 libvips DLL 字节/哈希及发行材料状态，`desktop-rust-inputs.ts` 核验后暂存。PixAI 接替 WD14 后，源码已退役 ORT 的 Rust/npm 依赖与新包载荷；`sharp` 继续用于图像维护工具。依赖变化需重建后端和桌面载荷；开发机能加载不证明安装包完整。此次退役不修改已发布 1.9.1 的字节，也不清除旧安装目录中的 ORT 文件。

### 2. 依赖变了，顺序必须是「先打包，再安装」
先经受控构建产出并核验当前包，再使用 `-UseInstaller`；不向已安装目录手工补 DLL或 Node 依赖。构建成功和隔离 bundle 通过仍不等于完成许可材料、UAC与实际安装验收。

### 3. 源端删除的资源不会自动消失
`Copy-Item -Recurse -Force` **只合并不删除**。源里删掉的目录，安装目录里那份会永久堆积。
遇到「源端删除型」迁移，把路径加进脚本的 `$STALE_ASSETS` 数组。

> 2026-08-29 实例：`assets/character-references`（1.2 GB）迁出项目后，
> 安装目录那份靠增量部署永远清不掉，最后靠 `-Cleanup` 才删掉。

---

## 三·五、应用内自动更新（tauri-plugin-updater）

桌面端已接入 **Tauri updater**：客户端启动时从主项目公开 GitHub Release 的
`releases/latest/download/latest.json` 检查版本，
发现新版本 → 系统通知 + 控制面板顶部「一键升级」横幅（下载安装后自动重启）。
Rust 侧（`updater_cmd.rs`）、前端横幅（`useDesktopUpdater.ts` + `ControlView.vue`）均已落地；
**只检查不自动下载；必须由用户点击“一键升级”后才下载安装**。

1.9.1 发行源码已启用 HTTP/2，并实现失败、取消或超时后校验缓存再尝试续传；服务器不支持安全续传或资源身份变化时重新下载，完整签名校验通过后才安装。旧客户端执行的是自身版本的下载逻辑；公开 `latest.json` 指向升级包，不会给尚未升级的 1.8.1 自动补上续传能力。

### 发版工作流（一次命令）

仓库现为 `starplatium1129-stack/huiyu`，发布标题使用“绘遇 HUIYU”。应用 identifier、公钥及内部安装兼容标识保留；不要为了仓库改名更换签名密钥或本地数据键。

```powershell
node scripts/maintenance/release-desktop-update.js --bump patch
# 提交并推送 main 后：
node scripts/maintenance/release-desktop-update.js --skip-build --publish
```

1. `--bump patch|minor|major`：发布前**自动递增版本号**（`package.json` 与 `tauri.conf.json` 同步）。
   客户端 updater 只在「远端版本 > 当前安装版本」时提示——**不 bump 就永远检不到更新**
   （2026-08-31 破案：发布与安装同为 1.5.0，功能从未触发）。
2. 提交并推送 `main` 后用 `--skip-build --publish`，脚本会确认目标是公开主项目、
   本地 `main` 与 `origin/main` 一致，再上传 full 与 upgrade 两份安装包、各自的 `.sig` / `.sha256`，以及指向 upgrade 的 `latest.json`。1.9.1 已按此流程交付；后续版本仍须核对自己的构建与公开附件。
3. 已装客户端下次启动自动检测；GitHub 暂时不可达时静默跳过，不影响本地使用。

### 原签名私钥暂不可用时

用户明确选择公开手动安装版时，可运行 `node scripts/maintenance/release-desktop-update.js --manual --bump minor` 构建，再提交并推送源码，最后运行 `node scripts/maintenance/release-desktop-update.js --manual --skip-build --publish`。

当前源码的该模式上传 full 与 upgrade 两种安装包及各自的 SHA-256，不生成或覆盖 `latest.json`，不把新 Release 设为自动更新使用的 latest。发布先创建草稿，确认资产上传完整后才公开；Release 顶部会明确提示未签名、需手动安装。

原签名主机后续先获取标签并检出该版本的原始源码（`git fetch --tags`，然后 `git switch --detach v1.6.0`），按原密钥进行签名构建，再运行 `node scripts/maintenance/release-desktop-update.js --skip-build --publish --complete-manual` 补齐自动更新。补签必须匹配原版本标签，不能用后来修改过的同版本源码覆盖。密钥可位于默认 `runtime/keys/aics-updater.key`，或由 `TAURI_SIGNING_PRIVATE_KEY_PATH` 指定；不要将私钥粘贴到聊天、提交到 Git 或生成替代钥匙。

发布脚本可发现本机 `runtime/github-cli/bin/gh.exe`，也支持系统 GitHub CLI。认证使用已登录的 GitHub CLI 或当前进程的 `GH_TOKEN`；不得把令牌写入仓库。

---

## 四、常见问题

**Q：同版本号重装（1.5.0 → 1.5.0）会清掉旧文件吗？**
不会。NSIS 走「已安装同版本」分支，默认「添加或重装」= 纯覆盖。想清残留用部署脚本的 `-Cleanup`；
只有选「卸载应用」才会删旧文件（但那样不会装新的）。

**Q：装完怎么确认真实反推能用？**
先核对已安装 Rust EXE和原生 DLL的哈希，再按[模型配置指南](guides/setup-and-models.md#pixai-默认图片反推)准备 PixAI，检查 `/api/interrogate/status` 并按明确授权使用真实权重核验输出。中性图片或小模型夹具只证明对应消费链；旧 WD14 或 Node `require` 成功不能认证现行 PixAI 反推。

**Q：为什么必须我点 UAC？**
写入 `C:\Program Files` 需要管理员。部署入口会请求 Windows 提权，由用户确认 UAC；取消授权时返回失败，不记录安装成功。

**Q：安装包多大算正常？**
应与上一版采用相同压缩方式的安装包比较，以实际产物为准。当前载荷包括桌面/Rust后端程序、原生 DLL和资源，不包含生产 Node。测试包与正式 LZMA包不能直接比大小；还需检查是否误带模型权重、私有参考素材或旧依赖目录。

## 发行构建身份（011）

发行前必须保留当前构建的 `runtime/delivery-evidence/desktop-build-binding.json`；详见[工作流](workflow.md#011-发行输入绑定2026-09-21)。仅部署/安装不会补建发行回执。缺失、陈旧或篡改产物必须回到受控构建流程，不使用同版本号绕过校验。桌面安装及 UAC 仍走本指南既有入口；本机安装不等于公开发布。
