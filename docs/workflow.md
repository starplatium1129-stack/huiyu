# 统一工作流手册

> 命令注册和默认参数以 `scripts/workflow.ts` 为准。统一短入口：`npm run wf -- <命令>`。

## 1. 入口与常用命令

- **查看所有命令**：`npm run wf -- --help`
- **搜索命令**：`npm run wf -- search <关键词>`
- **命令预览**：`npm run wf -- <命令> --plan`（仅预览实际执行的子命令及参数，不产生真实副作用）

### 日常快捷操作

| 想做什么 | 命令 | 说明 |
| --- | --- | --- |
| 搜索命令 | `npm run wf -- search 样张` | 支持中英文关键词 |
| 查看命令运行条件 | `npm run wf -- <命令> --help` | 包含运行前置条件与参数说明 |
| 检查失效入口 | `npm run wf -- audit:workflows --json` | 核对工作流注册表 |
| 文档链接检查 | `npm run wf -- docs:check` | 检查死链接与重定向映射 |
| 生成品牌图标 | `npm run wf -- brand:build` | SVG 生成深浅字标、favicon 与桌面图标 |
| 开发前端 / 启动网关 | `npm run wf -- dev:web` / `npm run wf -- dev:server` | 分别在两个终端运行 |
| TypeScript 类型检查 | `npm run typecheck` | 检查 Vue 应用、Node 工具和独立浏览器脚本 |
| 桌面打包能力检查 | `npm run wf -- desktop:doctor --json` | 检测本机构建与打包环境 |
| 桌面部署与同步 | `deploy-desktop.bat` | 桌面端同步与安装（详见 [部署指南](desktop-deployment.md)） |
| 安装器界面预览 | `npm run wf -- installer:modern --preview --capture` | 预览现代安装器，加 `--uninstall` 预览卸载 |

### 桌面人工诊断

诊断命令由操作员显式调用，输出放置在被忽略的 `runtime/` 目录：
```powershell
npm run wf -- diagnostics:window-capture -Out runtime/<输出图片.png> [-Title <窗口标题>] [-ProcessId <PID>] [-Scale 2]
```
使用 PrintWindow 截取指定窗口（默认绘遇 Companion，倍率 2），可优先按 `-ProcessId` 查找。

---

## 2. 数据与内容维护

人物、服装、场景、蓝图与记录式文档通过 `content:catalog` 维护：
- **开发权威库**：`runtime/content/catalog.sqlite`（维护时固定传 `--runtime-root runtime`）。
- **项目快照**：`data/catalog/`（Git 跟踪，供构建读取与发行打包）。

| 操作 | 入口 | 说明 |
| --- | --- | --- |
| 内容记录读写与导出 | `npm run wf -- content:catalog` | `authoring`/`record` 查询；`patch`/`import` 修改（默认预览，`--apply` 写入）；`export` 导出快照 |
| 场景快照构建 | `npm run wf -- data:build` | `data/catalog` → `scenes.json` |
| 热门角色快照构建 | `npm run wf -- popular:build` | `data/catalog` → `popular-characters.json` |
| 蓝图快照构建 | `npm run wf -- blueprints:build` | `data/catalog` → `scene-blueprints.json` |
| 蓝图/场景自动纠错 | `npm run wf -- content:autofix --changed --apply` | 本地 D/G 来源词库与确定规则优先，按需单次模型纠正，合批写回及导出；`--online-tags` 批量补查、`--render` 补充出图，离线不阻断；未知项保留，定稿与优质参考跳过 |
| 单条定稿基线更新 | `npm run wf -- scenes:pin-capture -- --id=<场景ID>` | 单条更新定稿保护基线；批量任务跳过 |
| 词条构建与检查 | `npm run wf -- tags:build` / `tags:check` | 校验 manifest 与别名映射，生成词条聚合与字典 |
| 离线待补词统计 | `npm run wf -- tags:untranslated --input <文件>` | 分析本地未翻译词条与频次 |

---

## 3. 参考库与样张

### 参考库
参考图库为可选素材，`data/references/` 的人物分片与 manifest 为数据源，图片不入 Git。
- `npm run wf -- reference:register --dry-run`：预览待登记形态（去掉 `--dry-run` 写入 pending 占位）。
- `npm run wf -- reference:render --output <候选目录>`：调用模型生成隔离候选。

### 参考库候选审核与版本发布
1. **生成候选**：`npm run wf -- reference:full --output <候选目录> --source <现有目录> --target <新目录>`
2. **人工审核**：将审核结果写入 `decisions.json` 后调用：
   ```powershell
   npm run wf -- reference:review --from <清单> --decisions <决定JSON> --out <候选目录/manual-review.json>
   ```
3. **版本发布**：
   ```powershell
   npm run wf -- reference:publish --from <清单> --review <审核JSON> --source <现有目录> --target <新目录> --apply
   ```

### 样张
样张（Showcase）批量生成、审核与定级入口：

| 操作 | 入口 | 说明 |
| --- | --- | --- |
| 热门/场景批量调度 | `showcase:batch --source popular` 或 `--source scenes` | 批量调度候选任务 |
| MiaoMiao 默认批次 | `showcase:batch-miaomiao` | 采用 MiaoMiao v1.6，Euler/normal，30 步，CFG 4.5，TeaCache 0.10 |
| 指定场景候选生成 | `showcase:scene-candidates --ids sc001,sc002 --output <新候选目录>` | 生成指定独立场景候选 |
| 缺口补齐 | `showcase:fill-gaps --keys popular:<角色ID>:<蓝图ID>` | 精确生成指定条目的独立候选 |
| 人工审核联系表 | `showcase:review-sheets --audit <候选审核目录>` | 基于 Pillow 生成缩略图联系表供肉眼查验 |
| 汇总人工决定 | `showcase:manual-review --manifest <生成清单> --decisions <决定文件>` | 汇总决定并生成审核记录 |
| 刷新分级清单 | `showcase:rating-refresh --source <旧版本> --target <新版本> --apply` | 刷新样张分级（支持 `--decisions`） |

---

<a id="门禁与构建"></a>
## 4. 门禁与构建

**严禁编写和运行任何测试**。仓库不包含且不运行单测、组件测试、E2E 测试与覆盖率统计。代码通过源码审查、类型检查与真实构建进行验证：

| 入口 | 用途 |
| --- | --- |
| `npm run typecheck` | 前端、Node 维护工具与独立脚本类型检查 |
| `npm run build:runtime` | 从 TypeScript 构建运行时维护工具；仅在工具源变化时执行，不手改生成的 `.js` |
| `npm run build` | 前端网页构建、包体预算核对与预压缩 |
| `npm run wf -- rust:build` | 构建 Rust release 网关及绑定回执 |
| `npm run wf -- rust:build:dev` | 快速构建开发后端（不生成发行回执） |
| `npm run build:tauri` | 构建原生桌面端程序 |

---

## 5. 桌面开发与部署

<a id="rust-运行时"></a>
### Rust 运行时与开发

<a id="rust-快速开发"></a>
- **日常后端修改**：`npm run dev:server`（构建成功后自动热重启网关进程）。
- **单次构建与启动**：
  ```powershell
  npm run rust:build:dev
  npm run start:dev -- <服务参数>
  ```
- **桌面宿主开发**：
  ```powershell
  npm run dev:tauri
  # 若修改了 UI 或内容数据，带上刷新参数：
  npm run dev:tauri -- --refresh-ui
  ```

### 本机 Live2D 候选导入

- 解包 LPK：夏目等 LPK 文件使用 `tools/LpkUnpacker.py <包.lpk> <输出目录> -c <同包config.json>`。
- 候选核对：`npm run wf -- live2d:import-candidates --apply`。
- 本机同步：`npm run wf -- live2d:sync-local --source <导入根> --target <用户模型根> --apply`。日常桌面开发推荐直接使用 `deploy-desktop.bat -SyncLocalModels`。

### PixAI 本机反推准备

控制室支持“一键准备”；手动高级维护入口：
```powershell
npm run wf -- models:prepare-pixai --python <已有Python路径> --torch-site-packages <torch包目录>
```
核验固定 PixAI v1.0 权重与依赖，环境就绪后写入 `pixai/runtime-config.json`。

### 桌面同步与发布

统一使用根目录 **`deploy-desktop.bat`**：
- 日常更新：直接运行 `.\deploy-desktop.bat`（默认快速增量更新）。
- 纯资源同步：`.\deploy-desktop.bat -ResourcesOnly`。
- 首次安装/全量修复：`.\deploy-desktop.bat -UseInstaller -InstallerPath "<完整包路径>"`。
- 详细说明参见 [桌面部署指南](desktop-deployment.md)。
