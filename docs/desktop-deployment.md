# 桌面端部署与同步指南

桌面部署与同步的唯一入口：**`deploy-desktop.bat`**（位于项目根目录）。

- **日常开发**：已登记的同版本 Windows 安装默认使用 `desktop-local`。部署会按构建清单校验 SHA-256，等程序排水退出后原子替换变更文件，再核验安装目录并同步内容库。
- **正式发行**：采用 release 配置与完整 LZMA 压缩包，保证分发独立性。
- **用户数据保护**：部署按每条内容已接收的上游版本合并快照，并保留本机的自定义修改。

---

## 常用命令

| 场景 | 命令 | 说明 |
|---|---|---|
| **日常程序更新** | `.\deploy-desktop.bat` | 核对源码、构建和安装身份。同版本开发安装会复用候选或快速重建，再按清单直写差异 |
| **复用当前本机构建** | `.\deploy-desktop.bat -SkipBuild` | 核对构建回执与当前源码是否一致，然后同步差异 |
| **首次安装 / 完整修复** | `.\deploy-desktop.bat -UseInstaller -InstallerPath "<完整包路径>"` | 显式使用 full 完整包进行全新安装或覆盖修复 |
| **仅同步静态资源** | `.\deploy-desktop.bat -ResourcesOnly` | 仅同步 `assets/` 与数据快照（要求已安装 EXE/DLL 字节一致；可加 `-SkipBuild` 跳过重新构建） |
| **同步私有参考分片** | `.\deploy-desktop.bat -ResourcesOnly -ReferenceIds natsume,nene` | 同步指定角色的参考分片到个人目录，覆盖前自动备份 |
| **复用已有升级包** | `.\deploy-desktop.bat -UseInstaller` | 跳过构建与封装，直接安装当前已生成的升级包 |
| **部署后不自动重启** | `.\deploy-desktop.bat -NoRestart` | 安装完成后保持客户端关闭状态 |
| **修复启动资源与缓存** | `.\deploy-desktop.bat -StartupRepair` | 核对快捷方式与资源，清理 WebView 缓存 |
| **强制重新构建** | `.\deploy-desktop.bat -ForceBuild` | 排错时跳过构建复用判断，执行全量构建 |
| **重置为项目内容库** | `.\deploy-desktop.bat -AdoptProjectCatalog` | 仅在明确放弃本地个性化数据时使用；先备份原库，再切换为项目快照 |

> [!NOTE]
> 部署过程中若弹出 Windows UAC（用户账户控制）提权弹窗，请点击“是”允许写入安装目录（默认 `C:\Program Files\AI-CG-Studio`）。

首次安装、版本变更、修复和显式 `-UseInstaller` 继续使用绑定安装包。日常直写保留现有安装登记、WebView2 和用户内容库，发布前仍走正式安装包流程。执行一次 `.\deploy-desktop.bat` 后，可查看 `runtime/desktop-deploy-last.log` 中的 `[desktop:timing]` 行，详细构建输出在 `runtime/desktop-deploy-build.log`。

---

## 用命令行操作桌面绘图

桌面包附带 `cli-anything-huiyu`。在运行绘遇的电脑上，打开「控制室 → 原生绘图 → 绘图引擎与远程连接」，选择本机原生引擎，勾选「允许其他绘遇连接本机绘图」，设置连接密钥，保存后按界面提示重启。保持桌面端运行。命令行直接连接本机监听端口。

在控制室复制连接密钥，然后在 PowerShell 中运行以下命令。若使用自定义安装位置，请替换第一行的路径。

```powershell
$cli = "$env:ProgramFiles\AI-CG-Studio\gateway\tools\cli-anything-huiyu\cli-anything-huiyu.exe"
$env:HUIYU_CLI_TOKEN = (Get-Clipboard -Raw).Trim()
& $cli status
& $cli --json catalog --kind scene --character nene --page-size 5
```

从结果中选一个场景，把它的完整 ID 传给 `draw --id`。回执里的 `batchKey` 可用于查进度，原图就绪后可直接保存。

```powershell
$job = & $cli --json draw --id sc093 | ConvertFrom-Json
& $cli job $job.batchKey
& $cli save $job.batchKey ".\成图.png"
```

默认端口为 3211。使用自定义端口时，先把 `$env:HUIYU_CLI_PORT` 设为控制室显示的值。输入 `& $cli --help` 查看命令，或输入 `& $cli` 逐条操作。在源码目录可直接运行 `node tools/cli-anything-huiyu/cli.mjs --help`。助手使用说明在命令入口旁的 `SKILL.md`。[CLI-Anything 项目](https://github.com/HKUDS/CLI-Anything)

### 多个助手共用一台出图机

本机助手可沿用上面的配置。其他机器上的助手可通过已配置的 Tailscale 绘图地址或 Muse HTTPS 中转连接同一台绘遇。运行命令行包的机器需要 Node.js 22.18 或以上，Windows 桌面包已自带运行时。[连接配置与助手说明](../tools/cli-anything-huiyu/SKILL.md)

给不同助手设置各自的 `HUIYU_CLI_AGENT`，例如 `muse` 和 `codex`。Muse 可以先用 `key` 取编号，再用 `draw --key` 提交。将回执的 `batchKey` 交给另一位助手，它就能在自己的进程中查询进度和报错。

```powershell
& $cli --json errors --agent muse --limit 50
& $cli --json errors $job.batchKey
```

第一条查询筛选一页近期记录，可用返回的 `nextBefore` 继续翻页。第二条定位到具体图片，区分模型生成错误与中转交付错误。连接或提交本身失败时，请保留命令标准错误里的 JSON，里面有错误码和重试信息。

## 好友公网试玩

在桌面端「控制室 → 好友试玩」点击 **开启好友试玩**，连通后复制邀请链接即可供好友写描述、选角色蓝图并使用本机已安装的 MiaoMiao Anima 1.6 出图（期间需保持房主电脑联网且不睡眠；内容改动后重新部署同步即可更新配方）。

- **临时隧道（默认）**：使用已安装的 `cloudflared.exe`（或通过 `CLOUDFLARED_PATH` 指定），连接器重启后需重新复制链接。
- **固定域名**：
  1. 在 Cloudflare 创建远程管理 Tunnel，为专属子域名（如 `play.example.com`）添加 Public Hostname 指向 `http://127.0.0.1:39331`（保留原始 Host）。
  2. 将 Tunnel 令牌单独存入文本文件，设置 Windows 用户环境变量 `HUIYU_SHARE_HOSTNAME` 为子域名、`HUIYU_SHARE_TUNNEL_TOKEN_FILE` 为令牌文件完整路径（需要 `cloudflared >= 2025.4.0`）。
  3. 重启绘遇托盘后再开启试玩；之后断网重连或重开绘遇会自动沿用原邀请（点击「停止好友试玩」撤销）。
- **排错提示**：若一直显示「正在连接公网」，检查本机对固定域名的访问及 Cloudflare 路由端口是否正确；开发改完网页重编后，停止再开启试玩即可生效。

---

## 数据同步机制

桌面端人物、服装、场景和蓝图的运行时权威位于用户个人目录：  
`%APPDATA%\com.aics.studio\gateway\content\catalog.sqlite`

- **Git 快照**：`data/catalog/` 是版本跟踪的项目快照。
- **自动增量合并**：部署使用 `--sync-bundle` 逐条比较安装包与本机已接收的上游修订。包内较新的内容会更新，本机个性化编辑会保留。包内较旧的记录列在回执的 `keptNewer`，其他记录继续同步。同一修订出现不同内容或修订与时间顺序矛盾时，部署会报错。备份和回执位于 `gateway/content-update-backups/`。

---

## 环境要求与体检

首次构建或环境异常时，运行体检命令：
```powershell
npm run wf -- desktop:doctor --json
```

**必备工具链**：
1. **Windows 10 / 11 64-bit**
2. **Node.js ≥22.18**
3. **Rust MSVC stable**（通过 [rustup](https://rust-lang.org/tools/install/) 安装）
4. **Visual Studio C++ Build Tools & Windows SDK**
5. **Live2D Cubism SDK for Native R5**（位于 `runtime/desktop-build-sdk/CubismSdkForNative-5-r.5` 或配置 `LIVE2D_CUBISM_SDK_DIR`）

---

## 正式发版流程

日常开发**不需要**执行此流程，仅供发布正式版本使用：

```powershell
# 1. 自动递增版本号并构建全量 LZMA 完整包与升级包
node scripts/maintenance/release-desktop-update.js --bump patch

# 2. 提交并推送到 main 分支后发布到 GitHub Release：
node scripts/maintenance/release-desktop-update.js --skip-build --publish
```

发版脚本会自动生成并上传 `full-setup.exe`、`upgrade-setup.exe`、签名文件、校验和及自动更新索引 `latest.json`。

---

## 常见问题排查

- **Q: 为什么部署时会弹出 Windows UAC 提权弹窗？**  
  A: 默认安装目录 `C:\Program Files\AI-CG-Studio` 属于系统保护目录，更新二进制与资源必须获取管理员权限。
- **Q: 部署过程提示桌面端正在运行？**  
  A: 脚本会自动尝试优雅退出宿主。若旧版本异常卡住，请在系统右下角托盘右键退出“绘遇 HUIYU”后再执行部署。
- **Q: 部署后没有窗口，日志提示 `WORKSPACE_LOCKED`？**  
  A: 异常退出可能遗留占用锁。重启宿主会自动恢复已结束进程的锁，正常无需手动清锁。
- **Q: 部署日志在哪里查看？**  
  A: 终端会打印主要阶段；详细日志保存在 `runtime/desktop-deploy-last.log` 与 `runtime/desktop-deploy-build.log`。
