# 桌面端部署：增量 还是 完整安装

统一入口只有一个：**`deploy-desktop.bat`**（项目根）。实现脚本也只有一个：
`scripts/maintenance/deploy-desktop-quick.ps1`。不要再新建部署脚本。

## 打包前检查

`package:tauri` 在资源暂存后自动按 `bundle.resources` 复制到仓库外隔离目录，用内置 Node 真正启动网关，验证健康检查、画室、桌宠、聊天及文档重定向。也可运行 `npm run wf -- desktop:verify-gateway`。不能用仓库根网关或 Live2D 自测替代此项，否则会漏掉安装包资源缺失。

1.6.0 若出现只有托盘/任务栏图标、窗口不打开，诊断日志可能包含 `Cannot find module '../docs/redirects.json'`。运行 `deploy-desktop.bat -StartupRepair` 可补齐文档并刷新本安装的快捷方式图标，保留样张和用户数据；完整修复请安装 1.6.1。部署入口从卸载登记读取实际安装位置，多个安装需用 `-InstallDir` 明确选择。

先运行 `npm run wf -- desktop:doctor --json`，确认 Windows x64、Node.js、Rust MSVC、Visual C++、Windows SDK 和 Cubism Native SDK 全部就绪。`npm run package:tauri` 会在构建前自动执行同一检查，缺失时立即给出具体安装指引。

Rust 使用[官方 rustup 安装器](https://rust-lang.org/tools/install/)的 x64 MSVC stable 工具链。入口会自动发现 `%USERPROFILE%\.cargo\bin`，无需重启终端或手动修改全局 PATH。C++/Windows SDK 要求见 [Tauri 官方前置条件](https://v2.tauri.app/start/prerequisites/)。

项目使用 [Cubism SDK for Native R5](https://www.live2d.com/en/sdk/download/native/)。将完整 SDK 放到 `runtime/desktop-build-sdk/CubismSdkForNative-5-r.5`，或设置 `LIVE2D_CUBISM_SDK_DIR` 指向包含 Core/Framework 的根目录。显式配置失效时不会静默换库。SDK 仅保存在被忽略的本机目录，不提交其源码、压缩包或工具链到 Git；保留 SDK 随附许可证，发布仍沿用既有发布流程。

生成安装包：`npm run package:tauri`。它只构建，不安装、不公开发布；完成后再按下面的部署入口选择增量同步或完整安装。

2026-09-21 网关身份加固后，发行版只启动并验证自有实例，不再凭公开的 `app/desktopProtocol` 字段附着任意回环服务。每次启动使用随机凭据和逐次随机挑战/HMAC；凭据不在 HTTP 请求或日志中传输。首次启动允许寻找可用端口，认证后本次桌面进程固定该端口；若恢复时被其他服务占用，应退出并重新启动桌面选择端口，不继续扩大旧 IPC 授权。健康失败立即撤销自定义 IPC 的信任，窗口导航另做即时挑战校验。

仅调试构建支持显式开发附着：桌面 `AICS_DESKTOP_ATTACH_TOKEN` 与开发网关 `AICS_DESKTOP_GATEWAY_TOKEN` 设置为同一随机 32 字节的小写十六进制值（恰好 64 字符）。非法格式拒绝启动；发行版忽略开发附着模式。这不提供对同账户恶意程序读取进程内存/环境的隔离保证。身份与个人凭据功能均涉及 Rust/exe 变化，必须完整安装，不能只同步前端。

本机反复验证可使用 `npm run wf -- desktop:package-local`：仍经过完整前端构建、资源暂存和原生编译，使用 `desktop-tauri/tauri.local.json` 跳过压缩，生成更大的本地安装包，避免反复等待压缩。普通打包入口使用默认 LZMA 压缩。本地无签名密钥时生成未签名安装包，不用于自动更新发布。

```bat
deploy-desktop.bat                  :: 增量部署（默认）
deploy-desktop.bat -UseInstaller    :: 完整安装（跑安装包）
deploy-desktop.bat -SkipBuild       :: 已手动 build 过，跳过前端构建
deploy-desktop.bat -NoRestart       :: 部署后不自动启动
deploy-desktop.bat -UseInstaller -QuietInstall :: UAC 确认后自动安装并启动
deploy-desktop.bat -UseInstaller -QuietInstall -SyncLocalModels :: 同步本机导入模型至用户目录
```

两者都会：停应用 → 清 WebView2 缓存 → 验证反推依赖 → 重启桌面端。

`-SyncLocalModels` 仅用于个人部署：核验并复制 `runtime/live2d-imports` 已登记文件至用户数据目录，保留旧模型版本；不会把候选 LPK/ZIP 或模型塞进可分发安装包。增量复制也排除 `assets/live2d-candidates`。
`-QuietInstall` 仅用于完整安装，仍需要用户确认 UAC；安装器非零退出会明确报错。部署日志追加到 `runtime/desktop-deploy-last.log`，便于核对实际安装结果。
`-Cleanup` 默认已带（清理源端已删除的历史残留）。

---

## 一、决策表：改了什么，就用什么

2026-09-26 当前桌面已启用独立打包 UI（`http://tauri.localhost`）。它的前端编译进原生 EXE；修改 Vue / TS / CSS 后必须重新打包并完整安装，仅复制网关 `dist/` 不会更新桌面界面。构建时保留已验收的 `AICS_BUNDLED_UI_VERIFIED=1` 标记；来源切换和真实资料迁移仍经宿主维护流程，不能用标记跳过资料门槛。此次安装与迁移证据见 [主线实施记录](architecture/R3-R11-EXECUTION-REPORT.md)。

| 改动内容 | 用哪个 | 原因 |
|---|---|---|
| `src/**` 前端代码（Vue / TS / CSS），已启用独立 UI | **完整安装** | 前端编译进 EXE，必须重新打包 |
| `src/**` 前端代码，仍使用旧 HTTP UI 来源 | **增量** | 只需换网关 `dist/` |
| `data/` 场景、热门角色数据 | **增量** | 只需换 `data/` 产物 |
| `routes/` `server/` `services/` `scripts/lib/` | **增量** | 网关 JS 直接复制即可 |
| `assets/` 新增/修改静态资源 | **增量** | 直接复制 |
| `assets/` **删除**了资源 | **增量** | 必须带 `-Cleanup`，否则安装目录里那份会永久残留 |
| `package.json` 新增运行时依赖 | **完整安装** | 依赖在 `node_modules`，增量不碰它 |
| `desktop-stage-resources.js` 的 `RUNTIME_DEPENDENCIES` | **完整安装** | 改了白名单要重新打包才生效 |
| Rust 代码（`desktop-tauri/src-tauri/src/`） | **完整安装** | 增量不替换 exe |
| `tauri.conf.json`（版本号、CSP、资源清单等） | **完整安装** | 同上 |
| 首次安装 / 换机器 / 桌面端起不来 | **完整安装** | 需要 exe 和完整目录结构 |

判断口诀：**只动了「会被复制进去的文件」→ 增量；动了 `node_modules` 或 exe 本身 → 完整安装。**

---

## 二、两种模式做了什么

### 增量部署（默认，秒级）
1. `npm run build`（除非 `-SkipBuild`）
2. 停应用 + 停 3123 网关端口
3. 清理 `-Cleanup` 登记的残留目录
4. 刷新 `build-scenes` / `build-popular` 数据产物
5. 依次复制 `data` → `dist` → `assets` → `routes` → `server` → `services` → `scripts/lib` → `server.js`
6. 剪枝 `dist/_app` 里失效的内容哈希 chunk
7. 清 WebView2 缓存，验证反推依赖，重启

> 复制顺序有讲究：**data 必须先于 dist**。客户端用 `?v=DATA_VERSION` 请求 data，
> 若新 dist（新版本号）曾对着旧 data 提供过一次，WebView2 会把旧内容以 immutable
> 一年缓存写进新 URL，之后再也不刷新。

### 完整安装（`-UseInstaller`，约 1 分钟 + 向导）
跑 `runtime/desktop-updates/` 下最新的 `*-setup.exe`（NSIS）。
它会覆盖整个 `gateway/`（**包括 `node_modules`**）并替换 exe。

---

## 三、三个必须知道的坑

### 1. 新增运行时依赖，光 `npm install` 没用
`desktop-stage-resources.js:35` 的 `RUNTIME_DEPENDENCIES` 白名单决定了 gateway 的
`package.json` 里有什么、npm 会装什么。新依赖**必须登记进白名单再重新打包**，
否则网页版正常、桌面端静默降级——不报错，只是功能退化。

> 2026-08-29 实例：`onnxruntime-node` + `sharp` 漏登记，真实反推在桌面端一直走启发式兜底。

### 2. 依赖变了，顺序必须是「先打包，再安装」
NSIS 安装会**覆盖整个 `gateway/node_modules`**。所以：
- ✅ 先 `npm run package:tauri` 产出新包 → 再 `-UseInstaller` 安装
- ❌ 先手动给已安装网关补依赖 → 再装新包 = 白装，会被覆盖掉

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
脚本最后一步会 `require('onnxruntime-node')` + `require('sharp')`。
要更彻底可以模拟网关环境跑一次推理（需设置 `AI_WORKSPACE_ROOT` 指向 AI 工作区）。

**Q：为什么必须我点 UAC？**
写入 `C:\Program Files` 需要管理员。agent 侧发起提权（`Start-Process -Verb RunAs`、
Bash 调 powershell）被安全策略拦截——这是命令校验规则，不是权限问题，只能由用户确认。

**Q：安装包多大算正常？**
应与上一版采用相同压缩方式的安装包比较，以实际产物为准。打包内容主要来自 `desktop-tauri/src-tauri/resources`，还包含程序与 Node 运行时。本地测试包跳过压缩，通常明显更大；正式 LZMA 包突然变大时，检查是否误带入模型权重、参考素材或其他大媒体。

## 发行构建身份（011）

发行前必须保留当前构建的 `runtime/delivery-evidence/desktop-build-binding.json`；详见[工作流](workflow.md#011-发行输入绑定2026-09-21)。仅部署/安装不会补建发行回执。缺失、陈旧或篡改产物必须回到受控构建流程，不使用同版本号绕过校验。桌面安装及 UAC 仍走本指南既有入口；本机安装不等于公开发布。
