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

## 扩展入口

- **命令行操作桌面绘图**：桌面包附带 `cli-anything-huiyu`（`gateway\tools\cli-anything-huiyu\cli-anything-huiyu.exe`，源码入口 `node tools/cli-anything-huiyu/cli.mjs`），完整连接、多助手共享与绘图指令见 [CLI-Anything 智能体命令行说明](../tools/cli-anything-huiyu/SKILL.md)。
- **好友公网试玩**：公网邀请与固定域名隧道配置见 [远程出图与好友试玩指南](guides/remote-and-muse.md#6-好友公网试玩)。

---

## 数据同步机制

桌面端运行目录内容库位于 `%APPDATA%\com.aics.studio\gateway\content\catalog.sqlite`。部署通过 `--sync-bundle` 逐条比较安装包与本机已接收的上游修订，仅更新较新上游记录并保留本机个性化编辑（遇到过期记录列入 `keptNewer` 跳过，同修订冲突则报错中止）；备份和回执位于 `gateway/content-update-backups/`。通用维护与快照导出规则见 [项目内容维护手册](maintenance.md)。

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
