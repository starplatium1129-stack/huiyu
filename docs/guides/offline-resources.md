# 新机器离线资源安装与发行

适用于 Windows x64 桌面版。当前公开 [1.9.1](../releases/v1.9.1.md) 已包含图形助手三件套、开始菜单入口、协作取消和跨会话恢复；本指南的新机步骤以该版本和完整素材包为准。源码中的增量 ZIP 导入尚未进入正式 1.9.1，使用边界见下方维护者说明。素材包安装完成后，角色高清图、现有场景、热门角色、画师和 LoRA 样张可在断网时浏览。程序与素材分开发布，模型权重及其运行环境按[模型开箱指南](setup-and-models.md)单独准备。

程序版本与素材发行版本分别记录。1.9.1 沿用 [1.9.0](../releases/v1.9.0.md)配套的完整素材 `huiyu-resources-20261006-r1.zip`：481 项基础资源、2,092 条样张，约 1.32 GiB，补齐五名角色立绘及 50 张场景样张。[完整素材下载页](https://github.com/starplatium1129-stack/huiyu/releases/tag/huiyu-resources-20261006-r1)提供 ZIP、两份校验文件及安装助手；随附助手与新版程序都登记这份 ZIP 的独立指纹。已有这份完整素材的用户无需因升级 1.9.1 重复导入。本次 ZIP 逐项校验及助手只读验证通过，没有安装到个人资料目录；真实空目录导入、重启及断网读取的旧证据不当作本版实机验收。

旧 `huiyu-resources-20260930-r1.zip` 的 `release.json.appVersion` 仍为 1.7.3，含 1,640 条样张；原字节和审批指纹保留于 [1.7.4 发行说明](../releases/v1.7.4.md)。不能只修改旧包版本字段后沿用旧指纹，也不能因程序升级就声称已更新用户导入的素材。

## 新机器安装

### 人物内容随包更新（源码修复，待配套发行）

新版 `offline:pack` 要求已导出的 `data/catalog`，完整包与增量包都会携带 `catalog.json`，其字节纳入独立审批指纹与逐项哈希校验。配套原生程序在素材切换前检查内容合并冲突，保留导入前快照，素材就绪后事务导入人物、服装、场景及蓝图，全部完成后才返回成功。重复导入与中断恢复沿用同一包；个人修改冲突时保留本地数据，不切换新素材。

普通用户仍只安装配套程序、通过图形助手选择 ZIP，无需源码、Node、开发部署命令或绘图模型。助手会检查原生 `offlineCatalog` 能力，并分别显示人物内容是否同步；旧的 20261006 包不含人物记录，只安装图片，不能将其成功提示作为新增人物验收。此修复尚未进入既有公开程序和素材包，须配套重新发行，不得修改旧包后沿用审批指纹。

内容备份与回执位于个人 `gateway/content-update-backups/<发行审批指纹>/`。冲突可在内容维护中比较合并后重试。首次导入先完整初始化个人数据目录，再创建人物库，支持“先装素材、再第一次启动”。新机验收使用空个人目录，核对人物检索及配套服装/蓝图、首次启动与参考索引，再检查已有图片；不要求或调用本机绘图。

从官方独立发布来源取得配套桌面安装包、完整资源 ZIP，以及微软 VC++ x64 离线安装器及校验材料。图形助手三件套（`Install-OfflineResources.cmd`、`offline-resource-assistant.ps1`、`install-offline-resources.ps1`）随程序安装在 `gateway\tools` 中，无需另找开发目录。若使用官方单独提供的助手，三个文件须放在同一目录。资源 ZIP 可放在带中文或空格的普通本地目录；资源 ZIP 内不携带安装脚本或模型程序。

图形助手在校验阶段检查原生程序是否支持 `offline-import --cancel-stdin`，不支持时先提示升级，不开始解压安装。旧程序不会因助手文件名相同而自动获得该能力；旧 1.8.1 包与当时修复的差异保留在 [2026-10-02 安装审计](../audits/2026-10-02/installer-user-audit.md)，该历史审计不代表当前 1.9.1 的安装验收。

使用本指南对应的公开 1.9.1 包时，先核对并运行微软 `vc_redist.x64.exe`，按提示完成 UAC、许可和可能的重启。该版本含带有 VC++ 导入项的 ORT DLL，WebView2 不替代 VC++；已经安装同版或更新版本的机器可由微软安装器检查。后续源码已退出 ORT 的新包载荷，但新构建仍须按实际原生程序与模型环境核对前置条件，不能把源码清理当作已更新旧安装包。此材料由维护者从微软官网下载并验签，程序安装及资源导入均不静默替用户批准此安装。

1. 保存工作并从托盘菜单完全退出绘遇，等待资源任务结束，再安装桌面程序。程序是面向所有用户的安装，普通账户需要由管理员完成 UAC 授权；没有管理员凭据时无法安装。WebView2 完整离线安装器嵌入 NSIS，安装机无需联网补下载 WebView2。程序安装与资源助手的权限不同。
2. 以自己的普通用户身份打开开始菜单 **“绘遇 · 资源安装助手”**，勿选择“以管理员身份运行”。未创建快捷方式时，右键绘遇快捷方式，选择“打开文件所在的位置”（若先进入快捷方式目录，再对其中绘遇快捷方式执行一次），进入安装目录的 **gateway → tools**，双击 **Install-OfflineResources.cmd**。
3. 点击“选择 ZIP”。随包助手优先使用自身安装目录；独立助手从卸载登记查找，找不到或存在多个安装时，在“安装位置与高级选项”浏览选择。运行目录默认是自己的 `%APPDATA%\com.aics.studio\gateway`；独立配置用户须选择实际使用的 gateway 目录。
4. 助手自动核对内置独立审批指纹、ZIP 的精确文件集合、路径、链接、重复项、尺寸和每项文件 SHA-256。界面显示校验进度，完成后列出发行版本、解压大小、安装/运行目录和批准来源。全包使用 64 KiB 缓冲流式读取，只有受限大小的清单进入内存；不会把约 1.32 GiB ZIP 全量加载。
5. 确认已从托盘完全退出绘遇，勾选退出确认，再点击“确认安装”。助手再次校验并解压，调用原生导入；若运行目录仍被使用会拒绝并提示退出后重试。不会强杀应用、停用锁或安装到别的配置以绕过占用。
6. 安装期间显示解压字节进度和原生安装阶段；原生阶段显示不定进度。点击“取消任务”或忙碌时关闭窗口会请求安全取消，等待原生回滚/收尾后才能关闭；不强杀导入进程。若已进入原生安装阶段，取消后可能留下待恢复事务并阻止桌面启动：**先用同一 ZIP 重试完成恢复，再启动绘遇**。仅校验/解压时取消不创建该事务。
7. 成功后重新启动绘遇，断网检查角色详情原图、场景卡片、样张画册和灯箱。已有自定义样张目录（包括 `sceneShowcaseDir` 或 `SCENE_SHOWCASE_DIR`）继续优先使用；导入成功不会擅自切换个人配置，如仍显示旧样张，应核对当前样张目录。助手不会替用户执行程序安装、UAC 或模型准备。

助手的受信清单固定在官方分发脚本源码中，1.9.1 随包助手批准以下完整素材；用户无需填写哈希：

| 素材发行 | `release.json` 原始字节审批指纹 |
| --- | --- |
| [huiyu-resources-20261006-r1](https://github.com/starplatium1129-stack/huiyu/releases/tag/huiyu-resources-20261006-r1)（当前） | `99391f8584c3cfeaf747977815f19b77b2c33aa73b7193f4da8befb87ea7e94d` |
| [huiyu-resources-20261002-r1](https://github.com/starplatium1129-stack/huiyu/releases/tag/huiyu-resources-20261002-r1)（旧版） | `fac5c408266d55721bf2888791f01d7d6cc70605227efdcd218e78d53548f2bf` |

未知包拒绝安装，需维护者依据独立发布来源审核并更新助手；不得把新包自带的哈希、旁边的校验文件或本地可编辑配置自动加入信任清单。必须独立取得官方助手，不能信任不明 ZIP 附赠的可执行脚本。`.zip.sha256` 仅用于下载完整性，与审批指纹不同。

发生错误会显示原因、可恢复的操作及保留的暂存目录。助手在完整解压和哈希校验后于暂存目录旁记录发行审批指纹及安装/运行目录，关闭重开会显示待恢复提示；仍须选择同一批准发行的 ZIP、使用相同程序安装目录和运行目录，完成校验和退出确认后点击“继续安装”。确认框选择“是”才复用已有暂存而不重新解压；选择“否”会重新解压 ZIP 后安装并保留旧暂存，暂存损坏时可选此项；“取消”不安装。同一会话仍可点击“重试安装”。恢复记录不代表授权或完整性通过，原生导入每次都重新核对全部暂存字节与文件集合；目录改变、记录或暂存丢失时不会复用，损坏暂存会被原生校验拒绝。部分解压仍会使用新暂存重试；遗留目录不自动删除，不能将它误认为已安装目录。不要删除尚待恢复的输入。对于损坏包、未知批准或路径问题，重新取得正确的官方材料后校验。

安装机不需要 E 盘、开发机目录、Node、npm、Python 或源码；助手只用 Windows PowerShell/WPF/.NET 和安装目录的 `gateway\huiyu-runtime.exe`。网页端没有此原生安装入口。本轮只处理用户选择的本地 ZIP，联网下载另行实现。

### 维护者命令行入口

已有手动入口继续支持独立审批指纹，供维护和诊断。默认预览只核对指纹、集合和尺寸；增加 `-Verify` 可逐项流式核对文件哈希且不写目标，`-Apply` 校验后原生安装。示例中的指纹必须来自独立受信发布页：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install-offline-resources.ps1 -Archive .\huiyu-resources-20261006-r1.zip -ExpectedReleaseSha256 <独立审批指纹> -Verify
```

命令行自选安装位置可用 `-InstallDir`、`-RuntimeRoot`。普通用户直接使用图形助手，不需要执行这些命令。实现入口为[图形助手](../../tools/offline-resource-assistant.ps1)和[离线导入脚本](../../tools/install-offline-resources.ps1)。

默认资源位于 `%APPDATA%\com.aics.studio\offline-resources`，样张位于同级 `showcase` 库，配置位于 `gateway\offline-resource-config.json`。程序升级不覆盖这些用户目录。旧版本保留；样张升级按上次发行种子的哈希识别并保留用户更换的图片与新增样张。

上述保留范围是用户资料和导入库。安装目录中的程序与随包资源会在升级时替换、卸载时移除；不要把自己的作品或唯一修改副本放在程序安装目录里。

安装失败或取消时不把残缺资源当作成功。脚本会显示保留的临时目录，供重新执行原生导入恢复；不要删除尚待恢复的输入。原生导入拒绝与正在运行的绘遇共用同一个运行目录，请完全退出后重试。

## 包里有什么

```text
release.json                    # 外部审批指纹绑定此文件的原始字节
catalog.json                    # 新包的人物/服装/场景/蓝图记录快照（旧包无此项）
pack/manifest.json              # 可服务资源的路径/字节/SHA-256
pack/assets/...                 # 当前公开基础资产的完整原始字节
showcase/manifest.json          # 画册展示清单，保留分级和来源字段
showcase/images/...             # 当前清单引用的原图
showcase/thumbs/...             # 当前清单引用的缩略图
```

只复制样张清单实际引用的原图/缩略图。历史未引用文件、个人首页上传、私有参考、本机候选模型和用户作品不随包发布。`release.json` 另外绑定 ZIP 的精确文件集合、资源身份和样张身份；导入前检查越界路径、链接、重复路径、大小与 SHA-256。

“完整”指本次已有素材的完整原始文件与当前样张清单，不把 pending 占位、缺图或未安装模型写成已交付。导出保留已有审核记录，不新增人工审核声明，不改图片或提示词。

## 维护者发行

### 已有资源机器的增量 ZIP

`offline:pack` 增加 `--base-release <旧包的 release.json>`。完整包继续用于新机器；增量包只包含基础资源和画册的新增/变化文件，以及完整目标清单，不重复携带未变化的图片。旧包只读取发行元数据，不需要再次解压或读取旧图片；也可以以上一增量包的 `release.json` 为基线继续制作下一批。

```powershell
npm run wf -- offline:pack --showcase-root "D:\HuiyuContent\SceneShowcase\已发布版本" --base-release "D:\HuiyuReleases\旧版\release.json" --release huiyu-resources-delta-r2 --out "D:\HuiyuReleases\delta-r2" --apply
```

增量导入需要包含此功能的配套桌面构建；正式 1.9.1 的原生导入器尚不支持。助手按 `offlineDelta` 能力识别，在解压前拒绝旧程序。助手显示“增量包”和要求的基础版本，原生导入核对本机资源身份与已安装样张种子的发行指纹；新机器、其他基线或缺损资源不能当作匹配基线。匹配后，未打包文件从本机旧版复制到新版本目录，用户自己修改、新增或删除的样张继续按现有合并规则保留，最后通过原有事务切换；旧版仍可回退。减少的是下载和解压的包体积，本机安装仍需要新版本目录及旧版保留的磁盘空间。

增量包与完整包使用同一外部审批、ZIP 字节校验、退出桌面要求、取消和恢复流程。制作候选不会自动加入受信清单，也不会上传、安装或发布；公开分发仍需独立批准新版助手与 ZIP。

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

资源单独建立 GitHub Release 时，不设为程序的 latest，避免影响现有 `/releases/latest/download/latest.json` 更新入口。面向用户的完整/增量 ZIP 统一使用 `offline:pack` 和配套原生导入器；`resource:pack` 仍是基础 assets 的独立候选入口，不含画册发行。

原生发行材料、签名、真实权重/设备与视觉验收仍按[工程契约](../engineering-contracts.md)和[桌面部署指南](../desktop-deployment.md)核对，导出字节通过不能代替这些条件。

WebView2 依据：[Tauri 离线安装器](https://v2.tauri.app/distribute/windows-installer/#offline-installer)、[微软离线分发说明](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)。VC++ 依据：[微软最新受支持运行库](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist)。GitHub 发行依据：[latest 配置](https://docs.github.com/en/rest/releases/releases#create-a-release)。

## 图形助手本次验收（2026-10-02）

本次仅在独立 worktree 验证源码，没有安装正式用户资源、下载大包、修改内容、发布或推送。工具 TypeScript 构建、10 项 Rust 离线导入定向测试、已有完整发行回归通过；新增助手适配用例验证未知审批/同尺寸坏字节拒绝、原生失败保留完整暂存、重试复用输入及关闭标准输入后的协作取消。原生用例继续覆盖运行目录互斥、用户修改保留和中断恢复。

WPF 实际离屏渲染检查了深浅主题的 780×710 DIP 正常窗口与 600×510 DIP 展开高级选项窗口，底部操作保持可达；后台控制器验证了防重入、未知包拒绝、重试可用和未确认时禁止安装。正文/弱化/禁用文字的最小核对对比度为 6.18:1。PNG 与原始辅助材料保留在忽略的 `runtime/offline-gui-qa/`，一次性脚本归档在 `scripts/archive/offline-gui-qa/`。这些是 96 DPI 位图渲染与隔离界面证据，不是物理 4K/QHD/1080p、系统缩放、浏览器或已安装桌面程序的实机验收；助手不使用 CSS 视口或浏览器缩放。

剩余验收：配套原生程序完整构建/安装、真实约 1.28 GiB 包的 GUI 导入与重启断网浏览、Windows 实际显示/DPI/键鼠及安全提示体验。上述真实操作需另行授权，本轮没有执行；联网一键下载不在本轮范围。
