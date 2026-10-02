# 新机器离线资源安装与发行

适用于包含 `offline-import` 的 Windows x64 桌面版（本次源码版本 1.8.0，程序与素材的公开发行状态分别以发布页为准）。素材包安装完成后，角色高清图、现有场景、热门角色、画师和 LoRA 样张可在断网时浏览。程序与素材分开发布，模型权重及其运行环境按[模型开箱指南](setup-and-models.md)单独准备。

程序版本与素材发行版本分别记录。本轮为 1.8.0 与 `huiyu-resources-20261002-r1.zip`：471 项基础资源、2,042 条样张，约 1.28 GiB，真实空目录导入、重启及临时来源不存在时的读取通过。[完整素材下载页](https://github.com/starplatium1129-stack/huiyu/releases/tag/huiyu-resources-20261002-r1)已公开 ZIP、两份校验文件、安装脚本和 README；独立审批指纹及程序发行状态见 [1.8.0 程序与素材说明](../releases/v1.8.0.md)。办公机首次断网启动与实际界面仍需实机验收。

旧 `huiyu-resources-20260930-r1.zip` 的 `release.json.appVersion` 仍为 1.7.3，含 1,640 条样张；原字节和审批指纹保留于 [1.7.4 发行说明](../releases/v1.7.4.md)。不能只修改旧包版本字段后沿用旧指纹，也不能因程序升级就声称已更新用户导入的素材。

## 新机器安装

从官方独立发布来源取得配套桌面安装包、完整资源 ZIP、图形助手三件套（`Install-OfflineResources.cmd`、`offline-resource-assistant.ps1`、`Install-OfflineResources.ps1`），以及微软 VC++ x64 离线安装器及校验材料。三个助手文件放在同一目录，资源 ZIP 可放在任意普通本地目录。资源 ZIP 内不携带安装脚本或模型程序。

**本次新增助手尚未公开发布或安装验收。** 图形助手需要本次支持 `offline-import --cancel-stdin` 的原生程序；原已安装的 1.8.0 不因同版本号就自动获得该能力。公开附件也不会由此次源码变更自动更新。

先核对并运行微软 `vc_redist.x64.exe`，按提示完成 UAC、许可和可能的重启。原生 ONNX DLL 依赖 VC++ 运行库，不能用已有 WebView2 代替此步骤；已经安装同版或更新版本的机器可由微软安装器检查。此材料由维护者从微软官网下载并验签，程序安装及资源导入均不静默替用户批准此安装。

1. 安装本次桌面程序。新版发行配置将 WebView2 完整离线安装器嵌入 NSIS，安装机无需联网补下载 WebView2；首次构建会由 Tauri 在构建机准备微软安装器。旧版安装包不具备本次原生导入命令，应一起升级。
2. 双击 **Install-OfflineResources.cmd** 打开图形助手，点击“选择 ZIP”。程序目录从卸载登记自动定位；找不到或存在多个安装时，在“安装位置与高级选项”浏览选择。独立配置用户应选择实际使用的 gateway 运行目录。
3. 助手自动核对内置独立审批指纹、ZIP 的精确文件集合、路径、链接、重复项、尺寸和每项文件 SHA-256。界面显示校验进度，完成后列出发行版本、解压大小、安装/运行目录和批准来源。全包使用 64 KiB 缓冲流式读取，只有受限大小的清单进入内存；不会把约 1.28 GiB ZIP 全量加载。
4. 保存工作，从托盘菜单完全退出绘遇，勾选退出确认，再点击“确认安装”。助手再次校验并解压，调用原生导入；保留运行目录互斥，若目录仍被使用会拒绝并提示退出后重试。不会强杀应用、停用锁或安装到别的配置以绕过占用。
5. 安装期间显示解压字节进度和原生安装阶段；原生阶段没有可证明的百分比，显示等待状态。点击“取消任务”或忙碌时关闭窗口会请求安全取消，等待原生回滚/收尾后才能关闭；不强杀导入进程。校验/解压与原生阶段有超时保护，失败不冒充完成。
6. 成功后重新启动绘遇，断网检查角色详情原图、场景卡片、样张画册和灯箱。助手不会替用户执行程序安装、UAC 或模型准备。

助手的受信清单固定在官方分发脚本源码中，当前只批准 `huiyu-resources-20261002-r1`，绑定[官方发布页](https://github.com/starplatium1129-stack/huiyu/releases/tag/huiyu-resources-20261002-r1)的 `release.json` 原始字节指纹 `fac5c408266d55721bf2888791f01d7d6cc70605227efdcd218e78d53548f2bf`。用户无需填写哈希。未知包拒绝安装，需维护者依据独立发布来源审核并更新助手；不得把新包自带的哈希、旁边的校验文件或本地可编辑配置自动加入信任清单。必须独立取得官方助手，不能信任不明 ZIP 附赠的可执行脚本。`.zip.sha256` 仅用于下载完整性，与审批指纹不同。

发生错误会显示原因、可恢复的操作及保留的暂存目录。完整暂存可在同一助手会话点击“重试安装”继续，原生导入会重新核对所有暂存字节。部分解压或重开助手后，重新选择同一 ZIP 再安装，会用新暂存恢复原生同一发行事务；旧暂存不自动删除，不能将它误认为已安装目录。不要删除尚待恢复的输入。对于损坏包、未知批准或路径问题，重新取得正确的官方材料后校验。

安装机不需要 E 盘、开发机目录、Node、npm、Python 或源码；助手只用 Windows PowerShell/WPF/.NET 和安装目录的 `gateway\huiyu-runtime.exe`。网页端没有此原生安装入口。本轮只处理用户选择的本地 ZIP，联网下载另行实现。

### 维护者命令行入口

已有手动入口继续支持独立审批指纹，供维护和诊断。默认预览只核对指纹、集合和尺寸；增加 `-Verify` 可逐项流式核对文件哈希且不写目标，`-Apply` 校验后原生安装。示例中的指纹必须来自独立受信发布页：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-OfflineResources.ps1 -Archive .\huiyu-resources-20261002-r1.zip -ExpectedReleaseSha256 <独立审批指纹> -Verify
```

命令行自选安装位置可用 `-InstallDir`、`-RuntimeRoot`。普通用户直接使用图形助手，不需要执行这些命令。实现入口为[图形助手](../../tools/offline-resource-assistant.ps1)和[离线导入脚本](../../tools/install-offline-resources.ps1)。

默认资源位于 `%APPDATA%\com.aics.studio\offline-resources`，样张位于同级 `showcase` 库，配置位于 `gateway\offline-resource-config.json`。程序升级不覆盖这些用户目录。旧版本保留；样张升级按上次发行种子的哈希识别并保留用户更换的图片与新增样张。

安装失败或取消时不把残缺资源当作成功。脚本会显示保留的临时目录，供重新执行原生导入恢复；不要删除尚待恢复的输入。原生导入拒绝与正在运行的绘遇共用同一个运行目录，请完全退出后重试。

## 包里有什么

```text
release.json                    # 外部审批指纹绑定此文件的原始字节
pack/manifest.json              # 可服务资源的路径/字节/SHA-256
pack/assets/...                 # 当前公开基础资产的完整原始字节
showcase/manifest.json          # 画册展示清单，保留分级和来源字段
showcase/images/...             # 当前清单引用的原图
showcase/thumbs/...             # 当前清单引用的缩略图
```

只复制样张清单实际引用的原图/缩略图。历史未引用文件、个人首页上传、私有参考、本机候选模型和用户作品不随包发布。`release.json` 另外绑定 ZIP 的精确文件集合、资源身份和样张身份；导入前检查越界路径、链接、重复路径、大小与 SHA-256。

“完整”指本次已有素材的完整原始文件与当前样张清单，不把 pending 占位、缺图或未安装模型写成已交付。导出保留已有审核记录，不新增人工审核声明，不改图片或提示词。

## 维护者发行

在源码维护机器准备当前 Node 开发工具，再显式指定已发布的样张目录与一个新的输出目录。这一阶段的 Node 打包命令不应带到安装机执行；`build:runtime` 生成维护脚本的运行文件，不构建产品 Rust 网关。预览会读取并哈希明确来源，`--help` / `--plan` 不读取目标；`--apply` 只在 Windows 实际复制和生成 ZIP，不覆盖既有发行：

```powershell
npm run build:runtime
npm run wf -- offline:pack --showcase-root "D:\HuiyuContent\SceneShowcase\已发布版本" --release huiyu-resources-1_7_4-r1 --out "D:\HuiyuReleases\1.7.4-r1"
npm run wf -- offline:pack --showcase-root "D:\HuiyuContent\SceneShowcase\已发布版本" --release huiyu-resources-1_7_4-r1 --out "D:\HuiyuReleases\1.7.4-r1" --apply
```

产物是已校验资源目录、ZIP、`.zip.sha256`、`.release.sha256` 和独立图形助手三件套。助手的内置信任表必须另行审核更新；打包命令不会自动批准其新输出。把桌面安装包与这些附件作为同批发行；发布说明写清程序兼容版本、素材版本、压缩及解压体积、实际包含的样张数量和模型另装边界。实际 ZIP 与新版安装包需要在空用户目录做一次导入、重启和断网检查后再公开。

示例输出目录包含 `huiyu-resources-1_7_4-r1/`、同名 ZIP、ZIP 校验文件、`huiyu-resources-1_7_4-r1.release.sha256` 及图形助手三件套。打包时 `release.json.appVersion` 读取源码 `package.json`，因此应先完成程序版本同步再生成新包；旧包的元数据和字节保持原样。源码目录和样张目录仅是准备机的输入位置，不是安装机需要复建的路径。

所有素材、ZIP、校验文件和脚本先写入独立发行暂存目录，全部完成后才发布 `--out` 目录。失败保留暂存且正式输出不存在，可使用同一命令重新构建；暂存不能当作已完成发行。

微软前置材料单独准备，不由普通打包命令自动下载或安装：

```powershell
npm run wf -- offline:prerequisites-plan -Out "D:\HuiyuReleases\prerequisites"
npm run wf -- offline:prerequisites-prepare -Out "D:\HuiyuReleases\prerequisites"
```

准备入口固定使用微软 HTTPS 来源，核对有效微软签名、实际字节、文件版本和 SHA-256，生成 `prerequisites.json`、离线 EXE、校验文件及安装说明。下载过的 EXE 不会被准备工具执行。公开发行时保留微软文件原样并附对应分发条件；目标机实际安装和原生加载需要另验。

资源单独建立 GitHub Release 时，不设为程序的 latest，避免影响现有 `/releases/latest/download/latest.json` 更新入口。当前完整包与现有 `resource:pack` 增量候选是不同入口；本次新机 ZIP 导入只接受完整发行，增量候选继续走已有资源生命周期审批流程。

原生发行材料、签名、真实权重/设备与视觉验收仍按[工程契约](../engineering-contracts.md)和[桌面部署指南](../desktop-deployment.md)核对，导出字节通过不能代替这些条件。

WebView2 依据：[Tauri 离线安装器](https://v2.tauri.app/distribute/windows-installer/#offline-installer)、[微软离线分发说明](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)。VC++ 依据：[微软最新受支持运行库](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist)。GitHub 发行依据：[latest 配置](https://docs.github.com/en/rest/releases/releases#create-a-release)。

## 图形助手本次验收（2026-10-02）

本次仅在独立 worktree 验证源码，没有安装正式用户资源、下载大包、修改内容、发布或推送。工具 TypeScript 构建、10 项 Rust 离线导入定向测试、已有完整发行回归通过；新增助手适配用例验证未知审批/同尺寸坏字节拒绝、原生失败保留完整暂存、重试复用输入及关闭标准输入后的协作取消。原生用例继续覆盖运行目录互斥、用户修改保留和中断恢复。

WPF 实际离屏渲染检查了深浅主题的 780×710 DIP 正常窗口与 600×510 DIP 展开高级选项窗口，底部操作保持可达；后台控制器验证了防重入、未知包拒绝、重试可用和未确认时禁止安装。正文/弱化/禁用文字的最小核对对比度为 6.18:1。PNG 与原始辅助材料保留在忽略的 `runtime/offline-gui-qa/`，一次性脚本归档在 `scripts/archive/offline-gui-qa/`。这些是 96 DPI 位图渲染与隔离界面证据，不是物理 4K/QHD/1080p、系统缩放、浏览器或已安装桌面程序的实机验收；助手不使用 CSS 视口或浏览器缩放。

剩余验收：配套原生程序完整构建/安装、真实约 1.28 GiB 包的 GUI 导入与重启断网浏览、Windows 实际显示/DPI/键鼠及安全提示体验。上述真实操作需另行授权，本轮没有执行；联网一键下载不在本轮范围。
