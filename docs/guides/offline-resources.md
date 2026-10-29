# 离线素材安装与发行指南

本指南适用于 Windows x64 桌面端离线素材包的安装与维护制作。  
素材包提供角色详情、场景卡片、服装及画册样张；模型权重与运行环境请参阅 [本地模型配置指南](setup-and-models.md)。

---

## 1. 新机器素材安装（普通用户）

### 前置准备
1. 安装桌面程序（`AI-CG-Studio_*_x64-full-setup.exe`）并安装微软 VC++ x64 运行库（见 [VC++ 离线前置说明](setup-and-models.md#windows-原生前置vc-x64-离线安装材料)）。
2. 从官方发布页取得对应版本的完整素材包（如 `huiyu-resources-*.zip`）。

### 图形助手安装步骤（推荐）
1. **打开内置助手**：桌面端控制室进入 **“资源与素材”**，点击 **“打开安装助手”**。也可从开始菜单打开 **“绘遇 · 资源安装助手”**；请以普通用户身份运行。
2. **选择素材位置**：可以选择 ZIP 自动解压，也可点击“使用已解压的文件夹”，选择包含 `release.json`、`pack/` 和 `showcase/` 的完整素材目录。识别时只读取发行清单和人物快照，不扫描整库图片。
3. **一键接入**：完整 ZIP 解压到个人运行目录旁的 `resource-packages/`，不再复制到第二套资源库。文件夹直接从原位置读取，无需再次解压或复制。助手保存当前编辑、暂停服务后登记位置并同步人物内容；图片和 Live2D 文件按需流式读取，启动和 HTTP 请求不再散列整库或整组依赖。增量 ZIP 仍使用原有基线合并流程。
4. **返回画室**：安装完成后点击“返回画室”，自动重启绘遇使素材生效。可检查角色详情原图、场景卡片与样张画册。

旧桌面版本使用独立 PowerShell 助手时，仍须先从托盘完全退出绘遇，再按退出确认与安装提示操作。内置助手所需页面随桌面程序打包，暂停网关期间仍可查看进度、取消或继续恢复。

> [!NOTE]
> - 用户作品不会被覆盖；人物内容冲突会保留原内容并提示处理。
> - 若已接收的人物内容比 ZIP 内快照更新，助手完整保留当前人物库与关联内容，只安装图片素材，并在完成后说明。
> - 若安装中途取消或异常中断，请重新打开助手并选择同一 ZIP 恢复安装。
> - 直接接入的素材文件夹必须保留在原位置。移动或删除后，请在助手中重新选择；原有用户作品和人物库独立保存。

### 命令行导入（维护者）
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\install-offline-resources.ps1 -Archive .\huiyu-resources-20261006-r1.zip -ExpectedReleaseSha256 <审批指纹> -Apply
```

---

## 2. 素材包结构

素材包 ZIP 包含以下核心文件：
```text
release.json          # 发行指纹与文件清单校验元数据
catalog.json          # 人物/服装/场景/蓝图数据快照（用于增量合并个人库）
pack/manifest.json    # 基础可服务资源清单与哈希
pack/assets/...       # 基础静态资产原始文件
showcase/manifest.json# 画册展示清单
showcase/images/...   # 画册原图
showcase/thumbs/...   # 画册缩略图
```

---

## 3. 维护者发行与打包

### 制作完整素材包（面向新装用户）
```powershell
# 1. 预览打包规划（只读）
npm run wf -- offline:pack --showcase-root "D:\HuiyuContent\SceneShowcase\已发布版本" --release huiyu-resources-<版本号> --out "D:\HuiyuReleases\<输出目录>"

# 2. 实际生成 ZIP 与校验清单
npm run wf -- offline:pack --showcase-root "D:\HuiyuContent\SceneShowcase\已发布版本" --release huiyu-resources-<版本号> --out "D:\HuiyuReleases\<输出目录>" --apply
```

仅维护工具源码或配置变化，或所需运行入口缺失时，先执行 `npm run build:runtime`。

### 制作增量素材包（已有素材的机器）
增量包仅包含基础资源与画册新增/变化的文件，显著减小包体积：
```powershell
npm run wf -- offline:pack --showcase-root "D:\HuiyuContent\SceneShowcase\已发布版本" --base-release "D:\HuiyuReleases\旧版\release.json" --release huiyu-resources-delta-<版本号> --out "D:\HuiyuReleases\<输出目录>" --apply
```

### 准备微软 VC++ x64 离线安装材料
```powershell
# 自动从微软官方下载带有数字签名的 vc_redist.x64.exe 并生成校验清单
npm run wf -- offline:prerequisites-prepare -Out "D:\HuiyuReleases\prerequisites"
```
下载的安装器及 `prerequisites.json` 作为同批附件发布，供断网新机在安装前使用。
