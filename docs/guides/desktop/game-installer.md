# 绘遇 HUIYU · 现代安装界面

正式发行采用 WPF 展示层：左侧自有角色与品牌，右侧按“安装位置 → 安装 → 完成”组织目录、磁盘信息与操作。深浅主题覆盖操作区，主操作固定在底部，内容区在较矮窗口可滚动。保留 NSIS 安装核心及 WebView2 处理。

原生 NSIS 安装与卸载页共用 `game-frame.nsh`，跟随 Windows 应用主题；保留系统按钮、焦点反馈和真实操作明细。卸载确认、进度和结果使用 `game-uninstall.nsh`，默认保留作品、个人设置和已导入资源。既有应用数据清理选项默认不选，勾选后列出运行卸载器账户的两个实际应用数据路径并再次确认，默认按钮为“否”。使用其他管理员账户通过 UAC 时，这些路径属于该管理员；不代表所有用户的资料。实际清理仍由原 Tauri 卸载段执行，没有扩展删除范围。


## 构建与预览

发行入口一次完整构建后生成两份独立签名安装器：`AI-CG-Studio_<版本>_x64-full-setup.exe` 面向新用户、基础素材变化或修复，包含程序、基础素材和 WebView2 离线安装器；`AI-CG-Studio_<版本>_x64-upgrade-setup.exe` 面向已有完整安装，复用已安装的基础素材和 WebView2。约 1 GiB 的样张图片仍通过独立素材 ZIP 提供，两种程序包都不额外塞入样张合集。

升级包在外层安装器和内层 NSIS 替换程序文件前核对安装登记、宿主版本、WebView2 与每个保留素材的大小/SHA-256，并拒绝链接路径。缺失、损坏或素材版本不匹配时明确要求使用本版本完整包；不把残缺安装升级成不可用状态。验证通过后使用既有 `/UPDATE` 原位覆盖程序，不调用旧卸载器。升级包保留完整的资源卸载清单，后续正常卸载仍清理程序自带素材，个人资料保持原有规则。

两份安装器分别绑定源码、构建和分发字节，分别签名；`latest.json` 指向升级包，发布页同时提供完整包作为新装/修复入口。从同一构建派生升级包，不重复编译应用。新版绑定还覆盖渲染后的 NSIS 输入，旧回执缺少这项输入时需先完成一次正常桌面构建。

- `npm run workflow -- installer:modern --preview --capture --theme=dark --state=ready --dpi=144`：编译原生预览；主题支持 dark/light，状态支持 ready/installing/done/error，DPI 支持 96–240。预览版本以及任何 --capture 调用都禁止安装。
- 上述预览加 `--upgrade` 展示老用户升级界面；截图文件名区分 `full`/`upgrade`。真实升级验证器由双包发行流程生成，预览不检查或修改已安装程序。
- `desktop-tauri/src-tauri/installer/modern/` 下的 `Installer.xaml` 管布局与主题，`controls.svg` 为手绘线条源；`InstallerWindow.cs` 管展示状态，`InstallEngine.cs` 管路径、校验、提权和安装结果。
- `node scripts/maintenance/release-desktop-update.js --bump patch`：构建应用与 NSIS 核心，再嵌入现代展示层，**签名最终分发的 exe**，更新 latest.json。不能拿内层 NSIS 签名验证外层安装器。
- `npm run workflow -- installer:bundle`：仅重打包已有程序的安装器，必须通过源码/产物绑定回执与版本校验；版本相同不能复用陈旧程序。应用变更仍需完整构建。
- `installer:build` 和 `installer:preview --capture --page=welcome` 维护底层 NSIS 模板及诊断预览；`package:tauri` 单独运行只产生该核心，发行使用上面的 release 入口。

NSIS 安全预览还支持 `--page=uninstall|uninstall-progress|uninstall-finish`、`--theme=system|dark|light`。页面复用正式展示函数，预览操作段仅打印说明，不安装、卸载、写快捷方式或启动应用。

Windows 10/11 x64 使用系统 .NET Framework 4.x/WPF，不增加浏览器运行服务。编译器和资源输出均在被忽略的 installer/generated/ 中。每次构建执行原生自测，验证路径、静默参数、预览隔离、嵌入资源哈希及深浅主题对比度。截图由实际 WPF 控件渲染，仍需目视检查各状态和缩放。

资源准备按实际复制字节显示进度；安装阶段显示不定进度，不假报百分比。开始安装前检查目标与临时磁盘空间，对提取的 NSIS 做 SHA-256 校验，完成后核对安装目录中 exe 的版本。管理员授权取消允许重试；安装核心运行时关闭窗口会提示等待或最小化。支持 /S、/P、/R、/NS、/D=（路径必须最后），更新模式交给内层 NSIS。显示界面本身不要求管理员权限。

## 安装逻辑边界

基于 [Tauri 官方自定义 NSIS 模板接口](https://v2.tauri.app/distribute/windows-installer/#installer-template)。原始安装文件清单、实际卸载删除段、旧版本维护选择、WebView2 检测、管理员权限和静默参数保留。测试比较这些代码段，模板哈希或锚点漂移时构建直接失败。

`game-install-policy.nsh` 为本次审计的最小产品策略：对安装目录内宿主与 Rust 网关用 Restart Manager 检查占用；运行中或无法核实退出时拒绝继续，提示保存工作、从托盘退出后重试，不调用强制关闭。另为选择快捷方式的安装补充“绘遇 · 资源安装助手”，指向随包 `gateway/tools/Install-OfflineResources.cmd`；`/NS` 不创建，升级保留已有链接，卸载仅移除目标属于本安装的助手链接。助手不从提升权限的安装器自动启动，以免跨账户 UAC 把资源写入管理员资料。

现成 1.8.1 包已包含助手文件，但没有这个开始菜单入口，并保留旧的强制关闭行为；本次修复须重新构建后才进入安装产物。普通用户现有入口、取消恢复及当次验收边界见[安装产物用户审计](../../audits/2026-10-02/installer-user-audit.md)与[离线资源安装](../offline-resources.md)。

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

## 2026-10-02 双包流程验证

在独立 `codex/installer-tiers-oct2` 分支复用既有安装／发行用例，补充一项实际 Windows NSIS 隔离夹具：新装误用升级包、未登记安装、缺少 WebView2、同尺寸坏素材均拒绝；有效升级不调用旧卸载器，素材字节保持；随后卸载清理保留的程序素材而不删除无关文件。夹具另覆盖带空格和 `$` 的路径。多产物绑定、派生载荷篡改、两个安装包各自的签名附件与远端摘要检查通过。

完整／升级界面的深浅主题在 1040×650、96 DPI 原生安全预览中复核，四次原生自测通过；不等同于多显示器或物理 DPI 验收。实际已安装的 1.8.1 只读检查通过安装登记、WebView2、宿主版本及 636 个可复用文件哈希，共约 337.3 MiB。用真实 Tauri NSIS 输入核对省略资源及完整卸载清单，派生宿主的 NSS 字节变换与已安装宿主 SHA-256 一致。

Node 工具编译、应用／工具类型检查、21 步静态检查范围、已有部署守卫和工作流用例通过；首轮新 PowerShell 夹具换行格式被卫生检查拦截，规范化后仅复跑失败项。原始日志与预览位于该 worktree 的忽略目录 `runtime/installer-tiers/`、`runtime/installer-modern-*.png`。本轮没有新程序全量构建、正式双包签名／发布、真实升级／卸载或用户数据写入；完整发行仍须正常构建和既有材料门禁。
