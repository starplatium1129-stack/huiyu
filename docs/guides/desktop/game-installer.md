# 绘遇 HUIYU · 现代安装界面

正式发行采用 WPF 展示层：左侧自有角色与品牌，右侧按“安装位置 → 安装 → 完成”组织目录、磁盘信息与操作。深浅主题覆盖操作区，主操作固定在底部，内容区在较矮窗口可滚动。保留 NSIS 安装核心及 WebView2 处理。

原生 NSIS 安装与卸载页共用 `game-frame.nsh`，跟随 Windows 应用主题；保留系统按钮、焦点反馈和真实操作明细。卸载确认、进度和结果使用 `game-uninstall.nsh`，默认保留作品、个人设置和已导入资源。既有应用数据清理选项默认不选，勾选后会列出 `%APPDATA%/com.aics.studio` 与 `%LOCALAPPDATA%/com.aics.studio` 并再次确认，默认按钮为“否”。实际清理仍由原 Tauri 卸载段执行，没有扩展删除范围。


## 构建与预览

- `npm run workflow -- installer:modern --preview --capture --theme=dark --state=ready --dpi=144`：编译原生预览；主题支持 dark/light，状态支持 ready/installing/done/error，DPI 支持 96–240。预览版本以及任何 --capture 调用都禁止安装。
- `desktop-tauri/src-tauri/installer/modern/` 下的 `Installer.xaml` 管布局与主题，`controls.svg` 为手绘线条源；`InstallerWindow.cs` 管展示状态，`InstallEngine.cs` 管路径、校验、提权和安装结果。
- `node scripts/maintenance/release-desktop-update.js --bump patch`：构建应用与 NSIS 核心，再嵌入现代展示层，**签名最终分发的 exe**，更新 latest.json。不能拿内层 NSIS 签名验证外层安装器。
- `npm run workflow -- installer:bundle`：仅重打包已有程序的安装器，必须通过源码/产物绑定回执与版本校验；版本相同不能复用陈旧程序。应用变更仍需完整构建。
- `installer:build` 和 `installer:preview --capture --page=welcome` 维护底层 NSIS 模板及诊断预览；`package:tauri` 单独运行只产生该核心，发行使用上面的 release 入口。

NSIS 安全预览还支持 `--page=uninstall|uninstall-progress|uninstall-finish`、`--theme=system|dark|light`。页面复用正式展示函数，预览操作段仅打印说明，不安装、卸载、写快捷方式或启动应用。

Windows 10/11 x64 使用系统 .NET Framework 4.x/WPF，不增加浏览器运行服务。编译器和资源输出均在被忽略的 installer/generated/ 中。每次构建执行原生自测，验证路径、静默参数、预览隔离、嵌入资源哈希及深浅主题对比度。截图由实际 WPF 控件渲染，仍需目视检查各状态和缩放。

资源准备按实际复制字节显示进度；安装阶段显示不定进度，不假报百分比。开始安装前检查目标与临时磁盘空间，对提取的 NSIS 做 SHA-256 校验，完成后核对安装目录中 exe 的版本。管理员授权取消允许重试；安装核心运行时关闭窗口会提示等待或最小化。支持 /S、/P、/R、/NS、/D=（路径必须最后），更新模式交给内层 NSIS。显示界面本身不要求管理员权限。

## 安装逻辑边界

基于 [Tauri 官方自定义 NSIS 模板接口](https://v2.tauri.app/distribute/windows-installer/#installer-template)。原始安装文件清单、实际卸载删除段、旧版本维护选择、WebView2 检测、管理员权限和静默参数保留。测试比较这些代码段，模板哈希或锚点漂移时构建直接失败。

自定义目录页拒绝空路径、盘符根、Windows 系统目录与通用用户/程序根目录；选择独立应用文件夹。安装包不包含生成模型。预览脚本不调用真实安装、启动或快捷方式函数。

## GitHub Release 发布

发行目标统一为公开主项目 `starplatium1129-stack/huiyu`。源码进入 `main`，安装包、
updater 签名、`latest.json` 与 SHA-256 作为同版本 GitHub Release 附件；大型 exe 不入 Git。
客户端只自动检测版本，用户点击后才下载安装。完整门禁中的失败必须在发布说明中列明，
不伪称全绿；安装后的系统目录替换与 UAC 仍按 desktop-deployment.md 处理。


当前发行、签名与本机安装范围见 [1.7.4 说明](../../releases/v1.7.4.md)和[项目状态](../../project-status.md)。updater 完整性签名不代表 Windows Authenticode 证书；具体设备/DPI 状态按当次实际验收记录。


## 2026-10-02 展示改造验收范围

在 `feat/installer-ui-oct2` 独立 worktree 完成安全预览。WPF 原生自测通过（路径、参数、预览隔离、双主题对比度及控件尺寸）；现有 `test-desktop-staging.js` 中 `game installer preserves upstream install and maintenance behavior` 定向用例通过。NSIS 无载荷夹具编译通过，覆盖正式 `un.*` 确认、进度及完成页接线；夹具未运行。

已目视复核 WPF 深浅主题及准备、安装、成功、错误状态，NSIS 安装目录、双主题卸载确认、卸载进度和结果。原始截图保存在该 worktree 的 `runtime/installer-*.png`，汇总为 `runtime/installer-ui-evidence.json`，不入 Git。WPF 截图按 1040×650 DIP 渲染，输出 DPI 为 96/144；NSIS 原生截图为约 960×660 像素。系统显示环境查询被 CIM 访问权限阻止，系统 DPI 未独立确认；这些截图不等同于 1080p/QHD/4K 实机缩放验收，浏览器缩放及 CSS 视口不适用于本原生界面。

未执行真实安装、卸载、应用数据清理、当前程序停止、UAC、真实签名或发布，也未重打完整载荷。清理二次确认逻辑已代码复核，交互点击分支与真实错误恢复仍需后续设备验收。NSIS 预览中“未写出卸载器”和“未引用页面函数”的编译警告源于无副作用预览结构。
