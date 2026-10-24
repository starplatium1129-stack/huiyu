# 桌面端部署与同步指南

统一入口：**`deploy-desktop.bat`**（位于项目根目录）。  
日常开发同步默认采用 `desktop-local` 快速档位生成无压缩升级包；正式发行保持原 release 配置与完整 LZMA 包。
日常直接双击或运行 `deploy-desktop.bat`，无需按改动类型添加参数。脚本显示所选方式及原因，默认静默安装、清理已登记的废弃资源并重新启动；需要提权时只需确认 Windows UAC。

---

## 1. 快速速查表（常用命令）

| 场景 | 命令 | 说明 |
|---|---|---|
| **日常同步（最常用）** | `.\deploy-desktop.bat` | 自动选择无需更新、仅资源同步、复用升级包、重新封装或快速重编；默认静默安装 |
| **首次安装 / 完整修复** | `.\deploy-desktop.bat` | 自动查找当前版本的 full 完整包及同名部署清单；缺少材料时提示放置位置 |
| **仅同步静态资源** | `.\deploy-desktop.bat -ResourcesOnly -SkipBuild` | EXE/DLL 无变化、仅静态资源或数据快照变更时使用，秒级完成 |
| **复用已有升级包** | `.\deploy-desktop.bat -UseInstaller` | 跳过构建与封装，直接安装当前版本已绑定的升级包 |
| **部署后不自动重启** | `.\deploy-desktop.bat -NoRestart` | 安装完成后保持客户端关闭状态 |
| **强制重新构建** | `.\deploy-desktop.bat -ForceBuild` | 排错时覆盖自动复用判断；日常无需添加 |

表中带参数的命令仅供人工覆盖自动选择。`-QuietInstall`、`-Cleanup` 仍兼容旧调用，自动模式已包含这两项行为。清理仅限脚本登记的废弃应用资源，不扫描删除个人文件。

> [!NOTE]
> 部署过程如弹出 Windows UAC（用户账户控制）提权弹窗，请点击“是”允许写入安装目录（默认为 `C:\Program Files\AI-CG-Studio`）。

---

## 2. 决策表：改了什么，用什么

桌面端已启用独立打包 UI（前端已编译进原生 EXE）。以下情况日常都使用同一个入口，由脚本选择部署方式：

| 改动内容 | 涉及路径 | 部署方式 | 说明 |
|---|---|---|---|
| **前端代码** | `src/**` (Vue / TS / CSS) | `.\deploy-desktop.bat` | 前端编译进 EXE，自动走 `desktop-local` 升级包快速构建与安装 |
| **角色 / 服装 / 场景** | `data/catalog/**` 快照 | `.\deploy-desktop.bat` | 自动增量合并至用户数据库，保留用户修改，不覆盖文件 |
| **后端与宿主 Rust** | `runtime-rs/**`、`desktop-tauri/**` | `.\deploy-desktop.bat` | 重新编译 Rust 载荷与桌面宿主 |
| **静态图片 / 本地素材** | `assets/**` | `.\deploy-desktop.bat` | 已有匹配构建且安装 EXE/DLL 一致时自动同步资源；源码或构建绑定过期则先自动准备当前构建 |
| **参考索引 / 标签等** | `data/references/**` 等按文件维护数据 | `npm run wf -- desktop:content-sync --apply` | 仅用于非 SQLite 的纯文件元数据同步 |
| **首次安装 / 换机器** | 目标机器无现有安装 | `.\deploy-desktop.bat` | 自动选择当前版本 full 完整包，保留其同名 `.deployment.json` |

自动判断顺序：先检查安装位置和源码、SDK、构建绑定；有有效构建时直接逐文件比较安装状态，无需先拥有升级包。安装文件一致则跳过部署，仅静态文件不同则同步资源；程序或 DLL 不同时才检查能否复用升级包，缺包则重新封装。源码、SDK 或构建产物不匹配时重新构建。无安装或宿主缺失时自动查找发行完整包，不将快速构建冒充发行完整包。

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
  A: 自动模式会清理 `$STALE_ASSETS` 已登记的废弃资源；其他目标端文件仍按增量合并保留，避免删除个人资产。维护时将确定废弃的应用路径登记到该列表，日常无需追加参数。
- **Q: 部署过程提示桌面端正在运行怎么办？**  
  A: `deploy-desktop.bat` 会自动请求新宿主安全排空写入并退出。若旧版本或异常卡住，请在系统右下角托盘右键退出“绘遇 HUIYU”后再执行部署。
- **Q: 部署后只有后台进程、没有窗口，日志提示 `WORKSPACE_LOCKED`？**
  A: 异常退出可能留下工作区占用记录。宿主启动时只恢复 Windows 已确认退出进程的记录，并持有该文件句柄防止替换；运行中、权限不足或身份不明的记录继续保留。部署预检允许已确认退出的记录留待新宿主恢复，不手动清锁或改写作品数据库。
- **Q: 部署日志在哪里查看？**  
  A: 部署过程的完整输出实时追加在 `runtime/desktop-deploy-last.log`。
