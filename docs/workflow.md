# 统一工作流手册

> 命令注册和默认参数以 `scripts/workflow.ts` 为准。统一短入口：`npm run wf -- <命令>`。

## 给协作者派任务

写清从哪个入口操作、希望看到什么结果，以及哪些决定需要你确认。能定位问题的文件、截图或原始日志可以直接附上。通用约定见 [AGENTS.md](../AGENTS.md)。这一写法参考了 [OpenAI 的 GPT‑6.2 Astra 提示指南](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6.2-astra#prompting-best-practices)。

例如，想改角色房间的帮助文档，可以这样提：「请在模型配置指南里说明，使用 OpenAI 的房间工具时该选哪个预设。对照当前预设和网关实际发送的请求，改完检查文档链接。只改文档。」

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
| 按改动快速体检 | `npm run wf -- check` | 按改动域并发执行静态检查（加 `--all` 全量检查，不自动拦截提交） |
| 源码体积审计 | `npm run wf -- audit:file-size` | 只读巡检超过 500 行的核心源码文件 |
| 运行时卫生清理 | `npm run wf -- runtime:clean` | 默认干跑 14 天前实验产物与零散日志；加 `--prune` 真实删除，加 `--include-archive` 涵盖历史归档脚本 |
| 文档链接检查 | `npm run wf -- docs:check` | 检查死链接与重定向映射 |
| 生成品牌图标 | `npm run wf -- brand:build` | SVG 生成深浅字标、favicon 与桌面图标 |
| 开发前端 / 启动网关 | `npm run wf -- dev:web` / `npm run wf -- dev:server` | 分别在两个终端运行 |
| TypeScript 类型检查 | `npm run typecheck` | 检查 Vue 应用、Node 工具和独立浏览器脚本 |
| 桌面打包能力检查 | `npm run wf -- desktop:doctor --json` | 检测本机构建、版本对齐与运行时卫生 |
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

人物、服装、场景与蓝图的数据权威、Patch 校验及导出规范见 [维护手册](maintenance.md)：

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
| MiaoMiao 默认批次 | `showcase:batch-miaomiao` | 采用无画师配方，MiaoMiao v1.6，Euler/normal，45 步，CFG 4.5，TeaCache 0.10 |
| 指定场景候选生成 | `showcase:scene-candidates --ids sc001,sc002 --output <新候选目录>` | 生成指定独立场景候选 |
| 缺口补齐 | `showcase:fill-gaps --keys popular:<角色ID>:<蓝图ID>` | 精确生成指定条目的独立候选 |
| 人工审核联系表 | `showcase:review-sheets --audit <候选审核目录>` | 基于 Pillow 生成缩略图联系表供肉眼查验 |
| 汇总人工决定 | `showcase:manual-review --manifest <生成清单> --decisions <决定文件>` | 汇总决定并生成审核记录 |
| 刷新分级清单 | `showcase:rating-refresh --source <旧版本> --target <新版本> --apply` | 刷新样张分级（支持 `--decisions`） |

MiaoMiao 默认批次按推荐尺寸的实际宽高、横构图标签和主线场景的镜头说明判断画幅。有明确横构图标记或推荐宽度大于高度时使用 1216×832，其余使用 832×1216。

---

<a id="门禁与构建"></a>
## 4. 门禁与构建

项目严禁编写和运行任何自动化测试（详见 [AGENTS.md](../AGENTS.md#实现验证与部署)），改动通过源码审查、类型检查与真实构建核验：

| 入口 | 用途 |
| --- | --- |
| `npm run typecheck` | 前端、Node 维护工具与独立脚本类型检查 |
| `npm run wf -- check` | 手动按改动域快速体检；传 `--all` 跑应用、Node 与浏览器脚本类型检查，`lint:js`、`lint:contrast`、`lint:animations`、`lint:colors`，文档链接与工作流清单，以及网关和桌面 Rust 检查 |
| `npm run wf -- audit:file-size` | 非阻断统计超过 500 行的前端与 Rust 核心源码（支持 `--limit N`、`--json`） |
| `npm run wf -- runtime:clean` | 逐项预览过期实验、历史安装包和中断导出。默认门槛 14 天，核对后可以相同 `--days` 参数加 `--prune` 执行。当前安装包版本、最新两个版本、发布清单指向的版本、内容库、模型和工作区受到保护 |
| `npm run build:runtime` | 从 TypeScript 构建运行时维护工具；仅在工具源变化时执行，不手改生成的 `.js` |
| `npm run build` | 前端网页构建、包体预算核对与预压缩 |
| `npm run wf -- models:check` | 离线核对模型 ID、文件字节数、SHA-256、镜像与脚本引用，识别固定 Git 对象和 Git LFS 指针 |
| `npm run wf -- models:check-environment` | 检查本机硬件清单、模型文件及 PixAI 配置路径，可加 `--verify-hashes` 核对本机权重 |
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

- 准备已解包的 Live2D 模型，保留 `.model3.json` 与它引用的贴图和动作文件。
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
