# 绘遇 HUIYU · 现代安装与发行包指南

正式发行基于 [Tauri 自定义 NSIS 模板](https://v2.tauri.app/distribute/windows-installer/#installer-template)，外层采用独立 WPF 展示层（`.NET Framework 4.x`，无额外浏览器运行服务）。

---

## 1. 现代安装与卸载界面

- **窗口与视觉 (`desktop-tauri/src-tauri/installer/modern/`)**：
  - `Installer.xaml` 与 `controls.svg` 定义 `1120 × 700` 逻辑像素双主题圆角窗口、手绘线条图标与右侧悬浮操作面板，背景使用 `assets/characters/nene-home-cg.jpg`。
  - `InstallerWindow.cs` 与 `InstallEngine.cs` 负责安装阶段展示（资源准备按流式 SHA-256 字节更新，安装核心阶段显示耗时）、盘符空间检查、路径校验与安装后版本核对。
- **现代卸载 (`UninstallWindow.cs` & `game-modern-uninstall.nsh`)**：
  - 复用同一 WPF 外壳，默认保留用户作品、设置与已导入资源；清理数据二次确认会列出当前账户的实际数据目录，焦点默认落在返回按钮。
  - 解出私有临时目录后静默调用原 Tauri 卸载核心，运行中不可直接关闭（允许最小化），失败可重试。静默/被动/更新模式沿用底层 NSIS（`game-frame.nsh` / `game-uninstall.nsh`）。

---

## 2. 双包发行、升级与安全边界

- **双包形态**：
  - `AI-CG-Studio_<版本>_x64-full-setup.exe`：完整包（LZMA 压缩，含程序、基础素材与 WebView2 安装引导；`--full-only` 仅出完整包，不含 AI 生成模型）。
  - `AI-CG-Studio_<版本>_x64-upgrade-setup.exe`：升级包，复用既有基础素材与 WebView2。
- **升级校验**：替换程序前先核对安装登记、宿主版本、WebView2 与保留素材的字节大小和 SHA-256（拒绝链接路径）；损坏或版本不匹配时提示改用完整包。验证通过后执行 `/UPDATE` 原位覆盖并保留完整卸载清单。
- **安装 policy (`game-install-policy.nsh`)**：
  - 拒绝空路径、盘符根、Windows 系统目录及通用用户/程序根目录。
  - 通过 Restart Manager 检查安装目录内的宿主与 Rust 网关占用，占用时提示退出托盘后重试，不强杀进程。
  - 若勾选创建快捷方式，补充生成「绘遇 · 资源安装助手」（指向 `gateway/tools/Install-OfflineResources.cmd`；`/NS` 静默不创建，且不从提权安装器自动拉起以防跨账户 UAC 写错目录）。
- **静默与命令行参数**：支持 `/S`、`/P`、`/R`、`/NS`、`/D=<目标路径>`（`/D=` 必须放最后）。
- **静态素材压缩**：打包阶段对大型静态角色 PNG 做无损重编码（结果缓存在 `runtime/desktop-png-cache/`，跳过 Live2D 纹理与用户作品）。

---

## 3. 构建、预览与 GitHub 发布

### 常用维护与预览命令

```powershell
# 预览现代安装器（支持 dark/light、ready/installing/done/error、DPI 96-240，加 --upgrade 预览升级态）
npm run workflow -- installer:modern --preview --capture --theme=dark --state=ready --dpi=144

# 预览现代卸载器（支持 ready/confirm/installing/done/error）
npm run workflow -- installer:modern --uninstall --preview --capture --theme=dark --state=ready --dpi=144

# 底层 NSIS 模板安全预览（--page=welcome|uninstall|uninstall-progress|uninstall-finish）
npm run workflow -- installer:preview --capture --page=welcome --theme=dark

# 重打包已有程序（须通过源码/产物绑定回执与版本校验）
npm run workflow -- installer:bundle
```

> 所有 `--preview` / `--capture` 入口均严格隔离，绝不执行真实安装、卸载或写快捷方式。

### 正式发版流程

发行目标仓库为 `starplatium1129-stack/huiyu`（源码入 `main`，EXE/签名/`latest.json`/SHA-256 上传 GitHub Release；updater 完整性签名不等于 Windows Authenticode 证书）：

```powershell
# 构建应用、NSIS 核心、嵌入现代展示层、签名分发 EXE 并更新 latest.json
node scripts/maintenance/release-desktop-update.js --bump patch
```

日常开发与安装同步请统一使用根目录 `deploy-desktop.bat`，见 [桌面部署指南](../../desktop-deployment.md) 与 [项目状态](../../project-status.md)。
