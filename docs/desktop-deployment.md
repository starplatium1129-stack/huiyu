# 桌面端部署与同步指南

统一入口：**`deploy-desktop.bat`**（位于项目根目录）。  
日常开发同步默认采用 `desktop-local` 快速档位生成无压缩升级包；正式发行保持原 release 配置与完整 LZMA 包。
日常运行 `deploy-desktop.bat`；纯资源同步显式选择 `-ResourcesOnly`，首次安装或修复显式选择发行完整包。脚本显示所选方式及原因；需要提权时由用户确认 Windows UAC。

---

## 常用命令

| 场景 | 命令 | 说明 |
|---|---|---|
| **日常程序更新** | `.\deploy-desktop.bat` | 检查源码、构建及安装身份，选择复用升级包、重新封装或快速重编；默认静默安装 |
| **首次安装 / 完整修复** | `.\deploy-desktop.bat -UseInstaller -InstallerPath "<发行完整包路径>"` | 显式选择 full 完整包，保留同名 `.deployment.json` |
| **仅同步静态资源** | `.\deploy-desktop.bat -ResourcesOnly` | 要求已安装 EXE/DLL 与构建字节一致；已有匹配构建时可加 `-SkipBuild` |
| **复用已有升级包** | `.\deploy-desktop.bat -UseInstaller` | 跳过构建与封装，直接安装当前版本已绑定的升级包 |
| **部署后不自动重启** | `.\deploy-desktop.bat -NoRestart` | 安装完成后保持客户端关闭状态 |
| **强制重新构建** | `.\deploy-desktop.bat -ForceBuild` | 排错时覆盖自动复用判断；日常无需添加 |

`-QuietInstall`、`-Cleanup` 仍兼容旧调用，自动模式已包含这两项行为。清理仅限脚本登记的废弃应用资源，不扫描删除个人文件。

> [!NOTE]
> 部署过程如弹出 Windows UAC（用户账户控制）提权弹窗，请点击“是”允许写入安装目录（默认为 `C:\Program Files\AI-CG-Studio`）。

---

## 按改动选择

前端已编译进桌面 EXE；前端、后端或宿主程序变化时使用升级包。`assets/` 与 `data/catalog/` 快照等纯资源变化使用 `-ResourcesOnly`，只有安装的 EXE/DLL 与构建字节一致才能同步。构建与源码匹配时可加 `-SkipBuild`，否则先准备匹配构建。

脚本也有自动判断模式，会检查安装位置、源码、SDK 和构建绑定，并可能自行选择资源同步或发行完整包。本项目操作时仍按上表显式选择纯资源同步和首次安装／修复；不将快速构建冒充发行完整包。

---

## 数据改动如何到达桌面端

人物、服装、场景和蓝图的运行时工作权威是用户个人运行目录中的 SQLite 数据库：  
**`%APPDATA%\com.aics.studio\gateway\content\catalog.sqlite`**。

- **`data/catalog/`** 是 Git 跟踪的项目快照，用于生成发行基线与升级同步源。
- **自动合并机制**：运行 `deploy-desktop.bat` 时，会在安装后、客户端启动前，读取安装目录中的快照，调用原生接口以 `--preserve-local` 模式增量合并到用户的 `catalog.sqlite` 中，并在 `gateway/content-update-backups/` 保留安全备份。**既有数据库不会被覆盖，用户自定义数据与修改完整保留**。
- 参考索引、标签等仍是文件维护域，不属于 SQLite 记录。它们的来源和目标与工作库不同，部署后应按实际目录核对；旧的 `desktop:content-sync` 工具不会更新 `catalog.sqlite`，也不是本项目的桌面部署入口。

---

## 打包前环境检查

在首次构建或环境异常时，先运行环境体检命令：
```powershell
npm run wf -- desktop:doctor --json
```

**必备工具链要求**：
1. **Windows 10 / 11 64-bit**
2. **Node.js 22.18 或更高版本**（项目开发版本见 `.nvmrc`）
3. **Rust MSVC stable**：通过 [rustup](https://rust-lang.org/tools/install/) 安装，脚本自动识别 `%USERPROFILE%\.cargo\bin`。
4. **Visual Studio C++ Build Tools & Windows SDK**
5. **Live2D Cubism SDK for Native R5**：放置在 `runtime/desktop-build-sdk/CubismSdkForNative-5-r.5` 或配置环境变量 `LIVE2D_CUBISM_SDK_DIR`。

---

## 正式发版与自动更新

日常开发**不需要**执行此流程，仅供发布正式版本使用：

需要只提供一个完整安装包时，构建使用 `npm run release:desktop -- --full-only --bump major`，提交并推送后用 `npm run release:desktop -- --full-only --skip-build --publish` 发布。该模式保持 release/LZMA、部署清单和原更新签名，自动更新也下载完整包，不生成另一份升级包。

```powershell
# 1. 自动递增版本号并构建全量 LZMA 完整包与升级包
node scripts/maintenance/release-desktop-update.js --bump patch

# 2. 提交并推送到 main 分支后发布到 GitHub Release：
node scripts/maintenance/release-desktop-update.js --skip-build --publish
```

- 发版脚本会自动生成并上传 `full-setup.exe`、`upgrade-setup.exe`、对应的 `.sig` 签名、`.sha256` 校验和以及用于自动更新的 `latest.json`。
- 客户端启动时通过 `tauri-plugin-updater` 检测版本。发现新版本时在控制面板顶部展示更新横幅，必须由用户主动点击确认后才会下载升级。

---

## 常见问题排查

- **Q: 为什么部署时会弹出 Windows 提权 (UAC) 弹窗？**  
  A: 桌面端默认安装在 `C:\Program Files\AI-CG-Studio`，向系统目录更新二进制与资源必须拥有管理员权限。请在弹窗中选择“是”。
- **Q: 为什么源端 `assets/` 删除了某个文件，安装目录里仍然残留？**  
  A: 自动模式会清理 `$STALE_ASSETS` 已登记的废弃资源；其他目标端文件仍按增量合并保留，避免删除个人资产。维护时将确定废弃的应用路径登记到该列表，日常无需追加参数。
- **Q: 部署过程提示桌面端正在运行怎么办？**  
  A: `deploy-desktop.bat` 会自动请求新宿主安全排空写入并退出。若旧版本或异常卡住，请在系统右下角托盘右键退出“绘遇 HUIYU”后再执行部署。
- **Q: 部署后只有后台进程、没有窗口，日志提示 `WORKSPACE_LOCKED`？**
  A: 异常退出可能留下工作区占用记录。宿主启动时只恢复 Windows 已确认退出进程的记录，并持有该文件句柄防止替换；运行中、权限不足或身份不明的记录继续保留。部署预检允许已确认退出的记录留待新宿主恢复，不手动清锁或改写作品数据库。
- **Q: 部署日志在哪里查看？**  
  A: 部署过程的完整输出实时追加在 `runtime/desktop-deploy-last.log`。
