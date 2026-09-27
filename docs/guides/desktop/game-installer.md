# 绘遇 HUIYU · 现代安装界面

正式发行采用 WPF 无边框展示层：全幅自有角色主视觉、统一矢量控件、底部路径与磁盘信息、单一安装主按钮。深浅主题覆盖安装区，画面叠字使用固定深色遮罩。保留 NSIS 作为安装核心，不改变文件清单、卸载与 WebView2 处理。

## 构建与预览

- `npm run workflow -- installer:modern --preview --capture --theme=dark --state=ready --dpi=144`：编译原生预览；主题支持 dark/light，状态支持 ready/installing/done/error，DPI 支持 96–240。预览版本以及任何 --capture 调用都禁止安装。
- `desktop-tauri/src-tauri/installer/modern/` 下的 `Installer.xaml` 管布局与主题，`controls.svg` 为手绘线条源；`InstallerWindow.cs` 管展示状态，`InstallEngine.cs` 管路径、校验、提权和安装结果。
- `node scripts/maintenance/release-desktop-update.js --bump patch`：构建应用与 NSIS 核心，再嵌入现代展示层，**签名最终分发的 exe**，更新 latest.json。不能拿内层 NSIS 签名验证外层安装器。
- `npm run workflow -- installer:bundle`：仅重打包已有程序的安装器，必须通过源码/产物绑定回执与版本校验；版本相同不能复用陈旧程序。应用变更仍需完整构建。
- `installer:build` 和 `installer:preview --capture --page=welcome` 维护底层 NSIS 模板及诊断预览；`package:tauri` 单独运行只产生该核心，发行使用上面的 release 入口。

Windows 10/11 x64 使用系统 .NET Framework 4.x/WPF，不增加浏览器运行服务。编译器和资源输出均在被忽略的 installer/generated/ 中。每次构建执行原生自测，验证路径、静默参数、预览隔离、嵌入资源哈希及深浅主题对比度。截图由实际 WPF 控件渲染，仍需目视检查各状态和缩放。

资源准备按实际复制字节显示进度；安装阶段显示不定进度，不假报百分比。开始安装前检查目标与临时磁盘空间，对提取的 NSIS 做 SHA-256 校验，完成后核对安装目录中 exe 的版本。管理员授权取消允许重试；安装核心运行时关闭窗口会提示等待或最小化。支持 /S、/P、/R、/NS、/D=（路径必须最后），更新模式交给内层 NSIS。显示界面本身不要求管理员权限。

## 安装逻辑边界

基于 [Tauri 官方自定义 NSIS 模板接口](https://v2.tauri.app/distribute/windows-installer/#installer-template)。原始安装文件清单、卸载、旧版本维护选择、WebView2 检测、管理员权限和静默参数保留。测试比较这些代码段，模板哈希或锚点漂移时构建直接失败。

自定义目录页拒绝空路径、盘符根、Windows 系统目录与通用用户/程序根目录；选择独立应用文件夹。安装包不包含生成模型。预览脚本不调用真实安装、启动或快捷方式函数。

## GitHub Release 发布

发行目标统一为公开主项目 `starplatium1129-stack/huiyu`。源码进入 `main`，安装包、
updater 签名、`latest.json` 与 SHA-256 作为同版本 GitHub Release 附件；大型 exe 不入 Git。
客户端只自动检测版本，用户点击后才下载安装。完整门禁中的失败必须在发布说明中列明，
不伪称全绿；安装后的系统目录替换与 UAC 仍按 desktop-deployment.md 处理。

## 1.5.6 发行验证

- 原生欢迎、目录、安装进度、完成及旧版本维护页预览已编译并截图检查（本机 175% DPI）。维护页的单选项关闭 Windows 默认主题绘制，以保证深色底上的文字对比度。预览不会执行真实安装。
- 7 项桌面打包测试通过，其中新增安装/卸载/WebView2/维护代码段与上游一致性检查。
- 前后端类型检查、ESLint、主题/动效、内容结构和生产打包通过。
- 全量 check 仍有既有的三个场景策略步骤及 Windows 临时目录清理失败，发行说明明确保留这些限制。
- 完整应用构建与最终 NSIS 重打包、updater 签名成功；未在本机执行覆盖安装。

首个桌面个性化提交为 2309331a；完整源码和 v1.5.6 标签仅推送到私密发行仓库的 codex/desktop-game-installer 分支。


## 1.5.8 本次验收（2026-09-08）

- WPF 自测通过：中文/空格路径、系统目录拒绝、静默及更新参数、真实预览安装拦截、嵌入 NSIS 哈希、深浅主题文本与进度条对比度、禁用按钮文字。
- 已目视检查原生准备、安装中、完成和失败状态，覆盖 100%、125%、150% 输出；不是网页效果图。未执行全部控件的人工点击回归。
- 8 项桌面打包测试通过，含分发包签名校验与篡改拒绝；前后端类型检查、ESLint、生产构建及包预算通过；前端 278 项、单元 399 项、接口契约 25 组通过。
- 仓库文本扫描通过。全量门禁仍有 scenes:optimize、scenes:ratings、scenes:validate 三个既有场景策略失败，以及 test:check 的 Windows 临时目录 ENOTEMPTY；不声明全量门禁通过。
- 已通过 deploy-desktop.bat -UseInstaller -QuietInstall 完整升级本机，ProductVersion=1.5.8，部署日志成功，网关健康检查 HTTP 200。安装 exe 与构建 exe 仅有 Tauri 的 UNK→NSS 三字节安装类型标记差异，符合打包行为。
- 最终发行 exe 由应用公钥验证 updater 签名。自 1.5.9 起源码与附件统一发布到主项目；签名是 updater 完整性签名，不是 Windows Authenticode 证书。

## 1.5.9 主项目统一发行（2026-09-08）

- 所有已完成分支统一进入 `main`，主项目远端仅保留 `main`。
- 自动更新端点切换为主项目公开 GitHub Releases；启动只检测，用户点击后才下载安装。
- 全量门禁通过；最终现代安装包 318,439,424 字节，SHA-256 为 `5ED43E381A81C714544F5678E63ABA49DA2AD91B2D9F112ABEEFB43676768A7E`。
- `v1.5.9` Release 包含 `latest.json`、安装包、updater 签名与 SHA-256 文件，标签指向对应应用源码提交。
