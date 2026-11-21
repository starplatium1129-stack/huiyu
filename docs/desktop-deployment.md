# 桌面端部署与同步指南

桌面部署与同步的唯一入口：**`deploy-desktop.bat`**（位于项目根目录）。

- **日常开发**：默认生成 `desktop-local` 快速无压缩升级包，按 SHA-256 复用未变化的资源与二进制，秒级更新。
- **正式发行**：采用 release 配置与完整 LZMA 压缩包，保证分发独立性。
- **用户数据保护**：部署按每条内容已接收的上游版本合并快照，并保留本机的自定义修改。

---

## 常用命令

| 场景 | 命令 | 说明 |
|---|---|---|
| **日常程序更新** | `.\deploy-desktop.bat` | 检查源码、构建与安装身份；自动选择复用升级包或快速重编；默认静默安装 |
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

---

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
