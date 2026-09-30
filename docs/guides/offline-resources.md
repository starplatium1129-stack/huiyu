# 新机器离线资源安装与发行

适用于包含 `offline-import` 的 Windows x64 桌面版（本次源码版本 1.7.3，公开发行状态以发布页为准）。素材包安装完成后，角色高清图、现有场景、热门角色、画师和 LoRA 样张可在断网时浏览。程序与素材分开发布，模型权重及其运行环境按[模型开箱指南](setup-and-models.md)单独准备。

## 新机器安装

从同一个受信发布来源取得本次新版桌面安装包、完整资源 ZIP、`Install-OfflineResources.ps1`、微软 VC++ x64 离线安装器及校验材料，以及发布说明里的 **release.json SHA-256 审批指纹**。资源 ZIP 内不携带安装脚本或模型程序。

先核对并运行微软 `vc_redist.x64.exe`，按提示完成 UAC、许可和可能的重启。原生 ONNX DLL 依赖 VC++ 运行库，不能用已有 WebView2 代替此步骤；已经安装同版或更新版本的机器可由微软安装器检查。此材料由维护者从微软官网下载并验签，程序安装及资源导入均不静默替用户批准此安装。

1. 安装本次桌面程序。新版发行配置将 WebView2 完整离线安装器嵌入 NSIS，安装机无需联网补下载 WebView2；首次构建会由 Tauri 在构建机准备微软安装器。旧版安装包不具备本次原生导入命令，应一起升级。
2. 在托盘完全退出绘遇，把资源 ZIP 和独立安装脚本放在同一个目录。
3. 在该目录打开 Windows PowerShell，用发布页提供的真实 64 位指纹替换下面占位值。先预览，再用相同参数加 `-Apply` 安装：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-OfflineResources.ps1 -Archive .\huiyu-resources-r1.zip -ExpectedReleaseSha256 <发布页的64位指纹>
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-OfflineResources.ps1 -Archive .\huiyu-resources-r1.zip -ExpectedReleaseSha256 <发布页的64位指纹> -Apply
```

指纹必须来自独立受信发布页，不能把 ZIP 自带的哈希当来源批准。ZIP 旁边的 `.zip.sha256` 用于下载完整性检查；它与 `release.json` 审批指纹是两个不同值。

脚本从系统卸载登记定位安装位置。存在多个安装或使用独立配置目录时，增加 `-InstallDir "实际安装目录"`、`-RuntimeRoot "实际配置根\gateway"`，无需 Node、npm、Python 或源码。安装程序自身可能需要 UAC，由用户操作；资源导入只写用户目录。

4. 导入成功后重新启动绘遇。断开网络，检查角色详情原图、场景卡片、效果样张画册和样张灯箱。控制室可显示已经挂载的资源版本；原有本机管理授权与远程分级规则继续生效。

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

先准备当前 Node 开发工具，再显式指定已发布的样张目录与一个新的输出目录。预览会读取并哈希明确来源，`--help` / `--plan` 不读取目标；`--apply` 只在 Windows 实际复制和生成 ZIP，不覆盖既有发行：

```powershell
npm run build:runtime
npm run wf -- offline:pack --showcase-root "D:\HuiyuContent\SceneShowcase\已发布版本" --release huiyu-resources-r1 --out "D:\HuiyuReleases\r1"
npm run wf -- offline:pack --showcase-root "D:\HuiyuContent\SceneShowcase\已发布版本" --release huiyu-resources-r1 --out "D:\HuiyuReleases\r1" --apply
```

产物是已校验资源目录、ZIP、`.zip.sha256`、`.release.sha256` 和独立安装脚本。把桌面安装包与这些附件作为同批发行；发布说明写清程序兼容版本、素材版本、压缩及解压体积、实际包含的样张数量和模型另装边界。实际 ZIP 与新版安装包需要在空用户目录做一次导入、重启和断网检查后再公开。

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
