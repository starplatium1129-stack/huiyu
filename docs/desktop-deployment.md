# 桌面端部署：增量 还是 完整安装

统一入口只有一个：**`deploy-desktop.bat`**（项目根）。实现脚本也只有一个：
`scripts/maintenance/deploy-desktop-quick.ps1`。不要再新建部署脚本。

本机已启用 bundled UI，当前安装身份以[项目状态](project-status.md)为准；2026-09-27 的完整安装见[当次证据](evidence/memory-optimization-2026-09-27.json)。前端变化需要重新打包并完整安装；脚本默认的增量模式适用于下面决策表中的网关、数据和动态资源变化。后续源码改动需另行核对安装身份。

2026-09-28 源码已将后端载荷改为 `gateway/huiyu-runtime.exe` 与锁定的原生 DLL，旧 Node 源码不随产品作为回退服务。本次 Rust 构建/安装与上述旧安装分开验收；目前原生发行材料未完成，`releaseReady=false`。后端 EXE、DLL或桌面 EXE变化必须完整安装，不能靠 `-SkipBuild` 把旧程序变成新版本。只有当前构建绑定已通过、可复制资源发生变化时才使用既有增量入口。

## 打包前检查

当前 SQLite 桌面工作区使用排他 owner 锁。支持维护协议的新宿主可由部署入口正常退出：先做只读能力/进程身份核对并准备安装包或构建，写入安装目录前通知现有三个窗口冻结输入、确认延迟保存；全部确认后才通过宿主既有认证通道停止新请求，排空已准入写入、回收自有网关并确认锁释放。任一窗口仍忙、配置表单未提交或保存失败，部署就取消，不代替用户提交配置。只隐藏窗口不等于退出。

旧安装版没有维护能力描述时，仍须先从托盘“退出 Companion”再执行首次升级；脚本不会试探未知 CLI、强杀进程或按 PID 猜测删锁。维护在封闭写入前取消会恢复界面；进入排空后失败则保持冻结，用户可从托盘正常退出后检查，不能把该退出当作升级成功。active/candidate 的未知残留锁始终要求维修。提权父进程等待并返回真实退出码，UAC 取消或安装失败不会显示成功；UAC、缺包或构建失败也不会提前关掉用户应用。

`npm run wf -- check:desktop-deploy` 使用临时安装目录、独立 owner 记录及真实进程夹具，验证受控退出、旧版本拒绝、进程身份变化与未知残留锁保留；不操作当前安装或触发 UAC。安装后重启会核对新宿主实例及其认证网关就绪，页面/图片显示另做实际界面验收。`-NoRestart` 不执行启动确认，不能据此记录启动成功。

`package:tauri` 暂存实际 Rust EXE、原生 DLL、清单与资源，并按 `bundle.resources` 在仓库外隔离布局启动该 EXE；验证器拒绝旧 `server.js`、服务端 `node_modules` 等误入载荷。可用 `npm run wf -- desktop:verify-gateway` 或 `desktop:rust-bundle` 复验。开发机旧 Node 网关或 Live2D 自测不能代替实际包布局验证；最终结果见[迁移记录](architecture/NODE-RUST-MIGRATION-REPORT.md)。

旧 1.6.0 的缺失 `docs/redirects.json` 修复属于历史 Node 版本，应使用对应版本的发行流程。当前 `-StartupRepair` 仅为已匹配 Rust 构建的安装同步文档、图标和快捷方式，不能升级旧 Node 安装。部署入口从卸载登记读取实际安装位置，多个安装需用 `-InstallDir` 明确选择。

先运行 `npm run wf -- desktop:doctor --json`，确认 Windows x64、Node.js、Rust MSVC、Visual C++、Windows SDK 和 Cubism Native SDK 全部就绪。`npm run package:tauri` 会在构建前自动执行同一检查，缺失时立即给出具体安装指引。

Rust 使用[官方 rustup 安装器](https://rust-lang.org/tools/install/)的 x64 MSVC stable 工具链。入口会自动发现 `%USERPROFILE%\.cargo\bin`，无需重启终端或手动修改全局 PATH。C++/Windows SDK 要求见 [Tauri 官方前置条件](https://v2.tauri.app/start/prerequisites/)。

项目使用 [Cubism SDK for Native R5](https://www.live2d.com/en/sdk/download/native/)。将完整 SDK 放到 `runtime/desktop-build-sdk/CubismSdkForNative-5-r.5`，或设置 `LIVE2D_CUBISM_SDK_DIR` 指向包含 Core/Framework 的根目录。显式配置失效时不会静默换库。SDK 仅保存在被忽略的本机目录，不提交其源码、压缩包或工具链到 Git；保留 SDK 随附许可证，发布仍沿用既有发布流程。

生成安装包：`npm run package:tauri`。它只构建，不安装、不公开发布；完成后再按下面的部署入口选择增量同步或完整安装。

正式构建会在 Tauri CLI 完成后将 Cargo 创建的固定 release EXE 硬链接核对字节并原子替换为独立文件，再执行原来的源码/产物绑定检查；其它位置的硬链接仍拒绝。CLI 成功不等于可发行：绑定失败返回非零并指出具体产物，回执原子更新失败保留旧回执，不再依赖一次性打包脚本修补。

2026-09-21 网关身份加固后，发行版只启动并验证自有实例，不再凭公开的 `app/desktopProtocol` 字段附着任意回环服务。每次启动使用随机凭据和逐次随机挑战/HMAC；凭据不在 HTTP 请求或日志中传输。首次启动允许寻找可用端口，认证后本次桌面进程固定该端口；若恢复时被其他服务占用，应退出并重新启动桌面选择端口，不继续扩大旧 IPC 授权。健康失败立即撤销自定义 IPC 的信任，窗口导航另做即时挑战校验。

仅调试构建支持显式开发附着：桌面 `AICS_DESKTOP_ATTACH_TOKEN` 与开发网关 `AICS_DESKTOP_GATEWAY_TOKEN` 设置为同一随机 32 字节的小写十六进制值（恰好 64 字符）。非法格式拒绝启动；发行版忽略开发附着模式。这不提供对同账户恶意程序读取进程内存/环境的隔离保证。身份与个人凭据功能均涉及 Rust/exe 变化，必须完整安装，不能只同步前端。

本机反复验证可使用 `npm run wf -- desktop:package-local`：仍经过完整前端构建、资源暂存和原生编译，使用 `desktop-tauri/tauri.local.json` 跳过压缩，生成更大的本地安装包，避免反复等待压缩。普通打包入口使用默认 LZMA 压缩。本地无签名密钥时生成未签名安装包，不用于自动更新发布。

```bat
deploy-desktop.bat                  :: 网关/数据增量部署（脚本默认；bundled UI 前端变化用完整安装）
deploy-desktop.bat -UseInstaller    :: 完整安装（跑安装包）
deploy-desktop.bat -UseInstaller -InstallerPath "D:\path\verified-setup.exe" :: 指定本次已验收安装包
deploy-desktop.bat -SkipBuild       :: 已手动 build 过，跳过前端构建
deploy-desktop.bat -NoRestart       :: 部署后不自动启动
deploy-desktop.bat -UseInstaller -QuietInstall :: UAC 确认后自动安装并启动
deploy-desktop.bat -UseInstaller -QuietInstall -SyncLocalModels :: 同步本机导入模型至用户目录
```

两者都会：确认应用/网关已退出且锁已释放 → 部署 → 清 WebView2 缓存 → 验证反推依赖 → 重启桌面端。

`-SyncLocalModels` 仅用于个人部署：核验并复制 `runtime/live2d-imports` 已登记文件至用户数据目录，保留旧模型版本；不会把候选 LPK/ZIP 或模型塞进可分发安装包。增量复制也排除 `assets/live2d-candidates`。
`-QuietInstall` 仅用于完整安装，仍需要用户确认 UAC；安装器非零退出会明确报错。部署日志追加到 `runtime/desktop-deploy-last.log`，便于核对实际安装结果。
`-InstallerPath` 显式选择包；未指定时仍从 `runtime/desktop-updates` 选最新包，但选定路径会固定并传过 UAC，不因另一构建随后完成而换包。并行开发或同版本多候选时使用显式路径。
`-Cleanup` 默认已带（清理源端已删除的历史残留）。

---

## 一、决策表：改了什么，就用什么

2026-09-26 当前桌面已启用独立打包 UI（`http://tauri.localhost`）。它的前端编译进原生 EXE；修改 Vue / TS / CSS 后必须重新打包并完整安装，仅复制网关 `dist/` 不会更新桌面界面。构建时保留已验收的 `AICS_BUNDLED_UI_VERIFIED=1` 标记；来源切换和真实资料迁移仍经宿主维护流程，不能用标记跳过资料门槛。此次安装与迁移证据见 [主线实施记录](architecture/R3-R11-EXECUTION-REPORT.md)。

| 改动内容 | 用哪个 | 原因 |
|---|---|---|
| `src/**` 前端代码（Vue / TS / CSS），已启用独立 UI | **完整安装** | 前端编译进 EXE，必须重新打包 |
| `src/**` 前端代码，仍使用旧 HTTP UI 来源 | **增量** | 只需换网关 `dist/` |
| `data/` 场景、热门角色数据 | **增量** | 只需换 `data/` 产物 |
| `runtime-rs/src/`、Cargo 锁文件或后端 EXE | **完整安装** | 产品运行 Rust EXE，不能复制旧网关 JS 代替构建 |
| 旧 `routes/` `server/` `services/` 对照代码 | 先核对实际用途 | 旧实现不随产品启动；改它们不等于修改 Rust 后端 |
| `assets/` 新增/修改静态资源 | **增量** | 直接复制 |
| `assets/` **删除**了资源 | **增量** | 必须带 `-Cleanup`，否则安装目录里那份会永久残留 |
| 原生 DLL、依赖清单、载荷规则变化 | **完整安装** | 更新字节/哈希、许可清单和构建绑定，再验证实际 bundle |
| `package.json` / 构建工具变化 | 重建受影响产物后判断 | Node 只用于开发构建；若改变 bundled UI、EXE或DLL，仍须完整安装 |
| Rust 代码（`desktop-tauri/src-tauri/src/`） | **完整安装** | 增量不替换 exe |
| `tauri.conf.json`（版本号、CSP、资源清单等） | **完整安装** | 同上 |
| 首次安装 / 换机器 / 桌面端起不来 | **完整安装** | 需要 exe 和完整目录结构 |

判断依据：**已绑定构建中的数据/静态资源变化可增量；bundled UI、EXE或DLL变化必须完整安装。**

---

## 二、两种模式做了什么

### 增量部署（默认）
1. 准备当前构建并核验绑定；已有相同构建可用 `-SkipBuild`
2. 请求已核验宿主维护退出，排空写入并确认自有网关退出、owner 锁释放
3. 清理 `-Cleanup` 登记的残留目录
4. 刷新 `build-scenes` / `build-popular` / `build-blueprints` 数据产物
5. 按已验证暂存白名单复制数据与静态资源，`data` 先于 `dist`；不复制旧服务端 JS 来更新 Rust 逻辑
6. 剪枝 `dist/_app` 里失效的内容哈希 chunk
7. 清 WebView2 缓存，核验原生载荷与新宿主身份后重启；EXE/DLL不匹配应改走完整安装

> 复制顺序有讲究：**data 必须先于 dist**。客户端用 `?v=DATA_VERSION` 请求 data，
> 若新 dist（新版本号）曾对着旧 data 提供过一次，WebView2 会把旧内容以 immutable
> 一年缓存写进新 URL，之后再也不刷新。

### 完整安装（`-UseInstaller`，约 1 分钟 + 向导）
使用 `-InstallerPath` 指定的已验收安装包；未指定时选定并固定 `runtime/desktop-updates/` 下最新的 `*-setup.exe`。NSIS 是安装核心，正式发行可由现代安装展示层封装。
它替换当前 `gateway/` 载荷、后端/桌面 EXE与原生库；旧布局残留按部署清单核验，不手工删除用户资料。

---

## 三、三个必须知道的坑

### 1. 原生依赖需要绑定真实载荷
`runtime-rs/native-dependencies.windows-x64.json` 固定 DLL字节/哈希及发行材料状态，`desktop-rust-inputs.ts` 核验后暂存。新增或替换依赖要重建后端和桌面载荷；开发机能加载不证明安装包完整。`onnxruntime-node` / `sharp` 留在开发对照依赖中，不是新的产品运行依赖。

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
   本地 `main` 与 `origin/main` 一致，再上传 `latest.json + setup.exe + .sig + .sha256`。
3. 已装客户端下次启动自动检测；GitHub 暂时不可达时静默跳过，不影响本地使用。

### 原签名私钥暂不可用时

用户明确选择公开手动安装版时，可运行 `node scripts/maintenance/release-desktop-update.js --manual --bump minor` 构建，再提交并推送源码，最后运行 `node scripts/maintenance/release-desktop-update.js --manual --skip-build --publish`。

该模式只上传安装包与 SHA-256，不生成或覆盖 `latest.json`，不把新 Release 设为自动更新使用的 latest。发布先创建草稿，确认资产上传完整后才公开；Release 顶部会明确提示未签名、需手动安装。

原签名主机后续先获取标签并检出该版本的原始源码（`git fetch --tags`，然后 `git switch --detach v1.6.0`），按原密钥进行签名构建，再运行 `node scripts/maintenance/release-desktop-update.js --skip-build --publish --complete-manual` 补齐自动更新。补签必须匹配原版本标签，不能用后来修改过的同版本源码覆盖。密钥可位于默认 `runtime/keys/aics-updater.key`，或由 `TAURI_SIGNING_PRIVATE_KEY_PATH` 指定；不要将私钥粘贴到聊天、提交到 Git 或生成替代钥匙。

发布脚本可发现本机 `runtime/github-cli/bin/gh.exe`，也支持系统 GitHub CLI。认证使用已登录的 GitHub CLI 或当前进程的 `GH_TOKEN`；不得把令牌写入仓库。

---

## 四、常见问题

**Q：同版本号重装（1.5.0 → 1.5.0）会清掉旧文件吗？**
不会。NSIS 走「已安装同版本」分支，默认「添加或重装」= 纯覆盖。想清残留用部署脚本的 `-Cleanup`；
只有选「卸载应用」才会删旧文件（但那样不会装新的）。

**Q：装完怎么确认真实反推能用？**
先核对已安装 Rust EXE和原生 DLL的哈希、健康/反推状态，再按明确授权使用真实权重核验输出。中性图片或小模型夹具只证明对应消费链；既有 Node `require` 成功不能认证 Rust 安装或真实 WD14效果。

**Q：为什么必须我点 UAC？**
写入 `C:\Program Files` 需要管理员。部署入口会请求 Windows 提权，由用户确认 UAC；取消授权时返回失败，不记录安装成功。

**Q：安装包多大算正常？**
应与上一版采用相同压缩方式的安装包比较，以实际产物为准。当前载荷包括桌面/Rust后端程序、原生 DLL和资源，不包含生产 Node。测试包与正式 LZMA包不能直接比大小；还需检查是否误带模型权重、私有参考素材或旧依赖目录。

## 发行构建身份（011）

发行前必须保留当前构建的 `runtime/delivery-evidence/desktop-build-binding.json`；详见[工作流](workflow.md#011-发行输入绑定2026-09-21)。仅部署/安装不会补建发行回执。缺失、陈旧或篡改产物必须回到受控构建流程，不使用同版本号绕过校验。桌面安装及 UAC 仍走本指南既有入口；本机安装不等于公开发布。
