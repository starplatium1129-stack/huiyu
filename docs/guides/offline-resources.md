# 离线素材安装与发行指南

本指南适用于 Windows x64 桌面端离线素材包的安装与维护制作。  
素材包提供角色详情、场景卡片、服装及画册样张；模型权重与运行环境请参阅 [本地模型配置指南](setup-and-models.md)。

---

## 1. 新机器素材安装（普通用户）

### 前置准备
1. 安装桌面程序（`AI-CG-Studio_*_x64-full-setup.exe`）并安装微软 VC++ x64 运行库（见 [VC++ 离线前置说明](setup-and-models.md#windows-原生前置vc-x64-离线安装材料)）。
2. 从官方发布页取得对应版本的完整素材包（如 `huiyu-resources-*.zip`）。

### 图形助手安装步骤（推荐）
1. **完全退出桌面端**：右键系统托盘图标，彻底退出“绘遇 HUIYU”。
2. **启动资源安装助手**：从开始菜单打开 **“绘遇 · 资源安装助手”**（或进入安装目录 `gateway/tools` 双击运行 `Install-OfflineResources.cmd`，**切勿使用管理员身份运行**）。
3. **选择素材 ZIP**：点击“选择 ZIP”，助手会自动校验包内指纹、文件完整性与 SHA-256。
4. **确认安装**：勾选退出确认框后点击“确认安装”，助手将自动解压并调用原生接口将人物/服装/场景/蓝图数据安全合并至个人工作库。
5. **启动验证**：重新启动桌面端，断网检查角色详情原图、场景卡片与样张画册。

> [!NOTE]
> - 用户自定义修改与本地数据在导入时受严格保护（使用 `--preserve-local`），不会被覆盖。
> - 若安装中途取消或异常中断，请重新打开助手并选择同一 ZIP 恢复安装。

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
# 1. 编译维护运行时
npm run build:runtime

# 2. 预览打包规划（只读）
npm run wf -- offline:pack --showcase-root "D:\HuiyuContent\SceneShowcase\已发布版本" --release huiyu-resources-<版本号> --out "D:\HuiyuReleases\<输出目录>"

# 3. 实际生成 ZIP 与校验清单
npm run wf -- offline:pack --showcase-root "D:\HuiyuContent\SceneShowcase\已发布版本" --release huiyu-resources-<版本号> --out "D:\HuiyuReleases\<输出目录>" --apply
```

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
