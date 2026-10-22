# 桌面端部署与同步指南

统一入口：**`deploy-desktop.bat`**（位于项目根目录）。  
日常开发同步默认采用 `desktop-local` 快速档位生成无压缩升级包；正式发行保持原 release 配置与完整 LZMA 包。

---

## 1. 快速速查表（常用命令）

| 场景 | 命令 | 说明 |
|---|---|---|
| **日常同步（最常用）** | `.\deploy-desktop.bat` | 自动检测改动状态，智能选择最快路径（仅资源同步 / 复用升级包 / 快速重编） |
| **静默快速升级** | `.\deploy-desktop.bat -QuietInstall` | UAC 弹窗点“是”后，自动在后台静默安装、合流数据并重启客户端 |
| **仅同步静态资源** | `.\deploy-desktop.bat -ResourcesOnly -SkipBuild` | EXE/DLL 无变化、仅静态资源或数据快照变更时使用，秒级完成 |
| **复用已有升级包** | `.\deploy-desktop.bat -UseInstaller` | 跳过构建与封装，直接安装当前版本已绑定的升级包 |
| **首次安装 / 完整修复** | `.\deploy-desktop.bat -UseInstaller -InstallerPath "<完整包路径.exe>"` | 首次装机或重大损坏时，显式指定当前版本的 full 完整安装包 |
| **部署后不自动重启** | `.\deploy-desktop.bat -NoRestart` | 安装完成后保持客户端关闭状态 |
| **清理废弃残留资源** | `.\deploy-desktop.bat -Cleanup` | 同步时清理已被源端删除的旧资源文件（如历史废弃目录） |

> [!NOTE]
> 部署过程如弹出 Windows UAC（用户账户控制）提权弹窗，请点击“是”允许写入安装目录（默认为 `C:\Program Files\AI-CG-Studio`）。

---

## 2. 决策表：改了什么，用什么

桌面端已启用独立打包 UI（前端已编译进原生 EXE），请按改动内容选择部署方式：

| 改动内容 | 涉及路径 | 部署方式 | 说明 |
|---|---|---|---|
| **前端代码** | `src/**` (Vue / TS / CSS) | `.\deploy-desktop.bat` | 前端编译进 EXE，自动走 `desktop-local` 升级包快速构建与安装 |
| **角色 / 服装 / 场景** | `data/catalog/**` 快照 | `.\deploy-desktop.bat` | 自动增量合并至用户数据库，保留用户修改，不覆盖文件 |
| **后端与宿主 Rust** | `runtime-rs/**`、`desktop-tauri/**` | `.\deploy-desktop.bat` | 重新编译 Rust 载荷与桌面宿主 |
| **静态图片 / 本地素材** | `assets/**` | `.\deploy-desktop.bat -ResourcesOnly -SkipBuild` | 纯资源同步，无需编译 EXE；如有文件删除请追加 `-Cleanup` |
| **参考索引 / 标签等** | `data/references/**` 等按文件维护数据 | `npm run wf -- desktop:content-sync --apply` | 仅用于非 SQLite 的纯文件元数据同步 |
| **首次安装 / 换机器** | 目标机器无现有安装 | 运行发行完整包 `*_x64-full-setup.exe` | 首次安装必须使用包含基础素材与运行时的 full 完整包 |

---

## 3. 数据改动如何到达桌面端

人物、服装、场景和蓝图的运行时工作权威是用户个人运行目录中的 SQLite 数据库：  
**`%APPDATA%\com.aics.studio\gateway\content\catalog.sqlite`**。

- **`data/catalog/`** 是 Git 跟踪的项目快照，用于生成发行基线与升级同步源。
- **自动合并机制**：运行 `deploy-desktop.bat` 时，会在安装后、客户端启动前，读取安装目录中的快照，调用原生接口以 `--preserve-local` 模式增量合并到用户的 `catalog.sqlite` 中，并在 `gateway/content-update-backups/` 保留安全备份。**既有数据库不会被覆盖，用户自定义数据与修改完整保留**。
- **纯文件同步**（`desktop:content-sync`）：仅适用于未归入 SQLite 的参考索引、标签、LoRA 保护清单等纯文件。它会自动跳过 `catalog/`、`popular/`、`scenes/`、`blueprints/` 及其聚合。
  ```powershell
  # 纯文件元数据同步并清除 WebView2 缓存
  npm run wf -- desktop:content-sync --apply --clear-webview-cache
  ```

---

## 4. 打包前环境检查

在首次构建或环境异常时，先运行环境体检命令：
```powershell
npm run wf -- desktop:doctor --json
```

**必备工具链要求**：
1. **Windows 10 / 11 64-bit**
2. **Node.js 22+ / 24+**
3. **Rust MSVC stable**：通过 [rustup](https://rust-lang.org/tools/install/) 安装，脚本自动识别 `%USERPROFILE%\.cargo\bin`。
4. **Visual Studio C++ Build Tools & Windows SDK**
5. **Live2D Cubism SDK for Native R5**：放置在 `runtime/desktop-build-sdk/CubismSdkForNative-5-r.5` 或配置环境变量 `LIVE2D_CUBISM_SDK_DIR`。

---

## 5. 正式发版（Release）与自动更新

日常开发**不需要**执行此流程，仅供发布正式版本使用：

```powershell
# 1. 自动递增版本号并构建全量 LZMA 完整包与升级包
node scripts/maintenance/release-desktop-update.js --bump patch

# 2. 提交并推送到 main 分支后发布到 GitHub Release：
node scripts/maintenance/release-desktop-update.js --skip-build --publish
```

- 发版脚本会自动生成并上传 `full-setup.exe`、`upgrade-setup.exe`、对应的 `.sig` 签名、`.sha256` 校验和以及用于自动更新的 `latest.json`。
- 客户端启动时通过 `tauri-plugin-updater` 检测版本。发现新版本时在控制面板顶部展示更新横幅，必须由用户主动点击确认后才会下载升级。

---

## 6. 常见问题排查 (FAQ)

- **Q: 为什么部署时会弹出 Windows 提权 (UAC) 弹窗？**  
  A: 桌面端默认安装在 `C:\Program Files\AI-CG-Studio`，向系统目录更新二进制与资源必须拥有管理员权限。请在弹窗中选择“是”。
- **Q: 为什么源端 `assets/` 删除了某个文件，安装目录里仍然残留？**  
  A: 默认文件同步为增量合并（不主动删除目标端文件）。若有文件删除，请追加 `-Cleanup` 参数执行清理。
- **Q: 部署过程提示桌面端正在运行怎么办？**  
  A: `deploy-desktop.bat` 会自动请求新宿主安全排空写入并退出。若旧版本或异常卡住，请在系统右下角托盘右键退出“绘遇 HUIYU”后再执行部署。
- **Q: 部署日志在哪里查看？**  
  A: 部署过程的完整输出实时追加在 `runtime/desktop-deploy-last.log`。
